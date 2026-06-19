/**
 * Proxy Manager — auto-rotate, blacklist, seamless switch
 *
 * Mendukung: HTTP, HTTPS, SOCKS4, SOCKS5 (dengan/tanpa auth)
 * Format file: protocol://[user:pass@]host:port  (satu baris per proxy)
 *              host:port                          (default http)
 *
 * File:
 *   live.txt / proxies.txt  — daftar proxy aktif
 *   blacklist.txt           — proxy yang gagal (auto-append)
 */

import fs from "fs";
import path from "path";
import net from "net";
import tls from "tls";
import http from "http";
import https from "https";
import dns from "dns";
import { PassThrough } from "stream";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── State ──────────────────────────────────────────────────────────────────

let allProxies = [];       // [{protocol, host, port, user, pass, raw}]
let currentIndex = 0;
let blacklist = new Set();

const PROXY_FILES = ["live.txt", "proxies.txt"];
const BLACKLIST_FILE = "blacklist.txt";

// ─── Parse ──────────────────────────────────────────────────────────────────

function parseProxyLine(line) {
  let s = line.trim().replace(/\r$/, "");
  if (!s || s.startsWith("#") || s.startsWith("//")) return null;

  // Format: protocol://[user:pass@]host:port
  let protocol = "http";
  let auth = null;
  let rest = s;

  const protoMatch = s.match(/^(https?|socks[45]):\/\//i);
  if (protoMatch) {
    protocol = protoMatch[1].toLowerCase();
    rest = s.slice(protoMatch[0].length);
  }

  // auth check: user:pass@host:port
  const atIdx = rest.lastIndexOf("@");
  if (atIdx > 0) {
    auth = rest.slice(0, atIdx);
    rest = rest.slice(atIdx + 1);
  }

  const colonIdx = rest.lastIndexOf(":");
  if (colonIdx < 0) return null;

  const host = rest.slice(0, colonIdx);
  const port = parseInt(rest.slice(colonIdx + 1), 10);
  if (!host || isNaN(port) || port < 1 || port > 65535) return null;

  let user = null, pass = null;
  if (auth) {
    const parts = auth.split(":");
    user = decodeURIComponent(parts[0] || "");
    pass = decodeURIComponent(parts.slice(1).join(":") || "");
  }

  return { protocol, host, port, user, pass, raw: s };
}

function loadProxies(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf-8");
    return text.split("\n").map(parseProxyLine).filter(Boolean);
  } catch {
    return [];
  }
}

function loadBlacklist() {
  try {
    const text = fs.readFileSync(path.join(__dirname, BLACKLIST_FILE), "utf-8");
    text.split("\n").forEach((l) => {
      const s = l.trim().replace(/\r$/, "");
      if (s) blacklist.add(s);
    });
  } catch { /* no file yet */ }
}

function saveBlacklist(proxy) {
  blacklist.add(proxy.raw);
  try {
    const existing = fs.existsSync(path.join(__dirname, BLACKLIST_FILE))
      ? fs.readFileSync(path.join(__dirname, BLACKLIST_FILE), "utf-8") : "";
    if (!existing.includes(proxy.raw)) {
      fs.appendFileSync(path.join(__dirname, BLACKLIST_FILE), proxy.raw + "\n");
    }
  } catch { /* ignore */ }
}

// ─── Init ───────────────────────────────────────────────────────────────────

export function initProxyManager(proxyFile) {
  loadBlacklist();

  // Cari file proxy
  let found = [];
  if (proxyFile) {
    found = loadProxies(proxyFile);
  }
  if (found.length === 0) {
    for (const f of PROXY_FILES) {
      const full = path.isAbsolute(f) ? f : path.join(__dirname, f);
      found = loadProxies(full);
      if (found.length > 0) break;
    }
  }

  // Filter blacklist
  allProxies = found.filter((p) => !blacklist.has(p.raw));
  currentIndex = 0;

  console.log(`[proxy] Loaded ${found.length} proxies (${allProxies.length} active, ${blacklist.size} blacklisted)`);
  return allProxies.length;
}

// ─── Get current proxy ─────────────────────────────────────────────────────

export function getCurrentProxy() {
  if (allProxies.length === 0) return null;
  return allProxies[currentIndex % allProxies.length];
}

export function getProxyCount() {
  return allProxies.length;
}

// ─── Rotate to next proxy (tanpa putus koneksi) ────────────────────────────

export function rotateProxy(reason) {
  if (allProxies.length === 0) return null;

  const current = allProxies[currentIndex % allProxies.length];
  console.log(`[proxy] Rotating: ${current.raw} — reason: ${reason}`);

  // Blacklist proxy yang gagal
  saveBlacklist(current);

  // Skip ke proxy berikutnya (yang belum di-blacklist)
  const startIndex = currentIndex;
  do {
    currentIndex = (currentIndex + 1) % allProxies.length;
    if (currentIndex === startIndex) break; // sudah semua
  } while (blacklist.has(allProxies[currentIndex]?.raw));

  // Bersihkan blacklist dari array aktif
  allProxies = allProxies.filter((p) => !blacklist.has(p.raw));

  if (allProxies.length === 0) {
    console.log("[proxy] All proxies blacklisted! Reload needed.");
    return null;
  }

  const next = allProxies[currentIndex % allProxies.length];
  console.log(`[proxy] Now using: ${next.raw} (${allProxies.length} remaining)`);
  return next;
}

// ─── Reload proxies dari file ───────────────────────────────────────────────

export function reloadProxies(proxyFile) {
  const oldCount = allProxies.length;
  allProxies = [];
  currentIndex = 0;
  blacklist.clear();

  loadBlacklist();
  let found = [];
  if (proxyFile) {
    found = loadProxies(proxyFile);
  }
  if (found.length === 0) {
    for (const f of PROXY_FILES) {
      const full = path.isAbsolute(f) ? f : path.join(__dirname, f);
      found = loadProxies(full);
      if (found.length > 0) break;
    }
  }
  allProxies = found.filter((p) => !blacklist.has(p.raw));
  console.log(`[proxy] Reloaded: ${oldCount} → ${allProxies.length} active`);
  return allProxies.length;
}

// ─── SOCKS5 connect ────────────────────────────────────────────────────────

function socks5Connect(proxy, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, proxy.host, () => {
      // SOCKS5 greeting: version=5, nMethods=1, method=0(no auth) or 2(user/pass)
      const hasAuth = proxy.user && proxy.pass;
      const nMethods = hasAuth ? 2 : 1;
      const methods = hasAuth ? Buffer.from([0x00, 0x02]) : Buffer.from([0x00]);
      const greeting = Buffer.concat([Buffer.from([0x05, nMethods]), methods]);
      socket.write(greeting);
    });

    let step = "greeting";
    let buf = Buffer.alloc(0);

    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      if (step === "greeting") {
        if (buf.length < 2) return;
        const version = buf[0];
        const method = buf[1];
        buf = buf.slice(2);

        if (version !== 5) { socket.destroy(); return reject(new Error("SOCKS5: bad version")); }

        if (method === 0x00) {
          step = "connect";
          sendConnect(socket, targetHost, targetPort);
        } else if (method === 0x02) {
          step = "auth";
          const auth = Buffer.concat([
            Buffer.from([0x01]),
            Buffer.from([proxy.user.length]),
            Buffer.from(proxy.user),
            Buffer.from([proxy.pass.length]),
            Buffer.from(proxy.pass),
          ]);
          buf = Buffer.alloc(0);
          socket.write(auth);
        } else {
          socket.destroy();
          reject(new Error(`SOCKS5: unsupported auth method ${method}`));
        }
      } else if (step === "auth") {
        if (buf.length < 2) return;
        if (buf[1] !== 0x00) {
          socket.destroy();
          return reject(new Error("SOCKS5: auth failed"));
        }
        buf = buf.slice(2);
        step = "connect";
        sendConnect(socket, targetHost, targetPort);
      } else if (step === "connect") {
        if (buf.length < 4) return;
        if (buf[1] !== 0x00) {
          socket.destroy();
          return reject(new Error(`SOCKS5: connect failed rep=${buf[1]}`));
        }
        // Connected! Put leftover bytes back into socket, then wrap with TLS
        buf = buf.slice(4);
        if (buf.length > 0) {
          socket.unshift(buf);
        }
        socket.removeAllListeners("data");
        const tlsSocket = tls.connect({ host: targetHost, socket, servername: targetHost, rejectUnauthorized: true }, () => {
          resolve(tlsSocket);
        });
        tlsSocket.on("error", (err) => reject(err));
      }
    });

    socket.on("error", (err) => reject(err));
    socket.on("timeout", () => { socket.destroy(); reject(new Error("SOCKS5 connect timeout")); });
    socket.setTimeout(30000);
  });
}

function sendConnect(socket, host, port) {
  // SOCKS5 connect request
  // addrType: 3 = domain
  const hostBuf = Buffer.from(host);
  const req = Buffer.alloc(7 + hostBuf.length);
  req[0] = 0x05; // version
  req[1] = 0x01; // cmd: connect
  req[2] = 0x00; // rsv
  req[3] = 0x03; // atyp: domain
  req[4] = hostBuf.length;
  hostBuf.copy(req, 5);
  req.writeUInt16BE(port, 5 + hostBuf.length);
  socket.write(req);
}

// ─── SOCKS4 connect ────────────────────────────────────────────────────────

function socks4Connect(proxy, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    // Resolve hostname to IP for SOCKS4
    dns.lookup(targetHost, (err, address) => {
      if (err) return reject(err);

      const socket = net.connect(proxy.port, proxy.host, () => {
        // SOCKS4 connect request
        const ipBuf = Buffer.from(address.split(".").map(Number));
        const userBuf = Buffer.from(proxy.user || "");
        const req = Buffer.alloc(9 + userBuf.length);
        req[0] = 0x04; // version
        req[1] = 0x01; // cmd: connect
        req.writeUInt16BE(targetPort, 2);
        ipBuf.copy(req, 4);
        userBuf.copy(req, 8);
        req[req.length - 1] = 0x00; // null terminator
        socket.write(req);
      });

      socket.once("data", (data) => {
        if (data[1] !== 0x5A) {
          socket.destroy();
          return reject(new Error(`SOCKS4: connect failed rep=${data[1]}`));
        }
        // Connected! Wrap with TLS
        const tlsSocket = tls.connect({ host: targetHost, socket, servername: targetHost }, () => {
          resolve(tlsSocket);
        });
        tlsSocket.on("error", (err) => reject(err));
      });

      socket.on("error", (err) => reject(err));
      socket.on("timeout", () => { socket.destroy(); reject(new Error("SOCKS4 connect timeout")); });
      socket.setTimeout(30000);
    });
  });
}

// ─── HTTP CONNECT tunnel ───────────────────────────────────────────────────

function httpConnect(proxy, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const proxyReq = http.request({
      host: proxy.host,
      port: proxy.port,
      method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
      timeout: 30000,
    });

    proxyReq.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`HTTP CONNECT failed: ${res.statusCode}`));
      }
      const tlsSocket = tls.connect({ host: targetHost, socket, servername: targetHost }, () => {
        resolve(tlsSocket);
      });
      tlsSocket.on("error", (err) => reject(err));
    });

    proxyReq.on("error", reject);
    proxyReq.on("timeout", () => { proxyReq.destroy(); reject(new Error("HTTP CONNECT timeout")); });
    proxyReq.end();
  });
}

// ─── Main: get TLS socket through proxy ────────────────────────────────────

export function getProxySocket(targetHost, targetPort) {
  const proxy = getCurrentProxy();
  if (!proxy) return Promise.reject(new Error("No proxy available"));

  switch (proxy.protocol) {
    case "socks5": return socks5Connect(proxy, targetHost, targetPort);
    case "socks4": return socks4Connect(proxy, targetHost, targetPort);
    case "http":
    case "https": return httpConnect(proxy, targetHost, targetPort);
    default: return Promise.reject(new Error(`Unsupported proxy protocol: ${proxy.protocol}`));
  }
}

// ─── HTTPS fetch via any proxy (SOCKS4/5 + HTTP/S) ────────────────────────

export function proxyFetch(urlStr, options = {}) {
  const url = new URL(urlStr);
  if (url.protocol !== "https:") {
    // HTTP langsung tanpa tunnel
    return directFetch(urlStr, options);
  }

  const proxy = getCurrentProxy();
  if (!proxy) return directFetch(urlStr, options);

  return getProxySocket(url.hostname, parseInt(url.port) || 443)
    .then((tlsSocket) => {
      return new Promise((resolve, reject) => {
        const reqOpts = {
          host: url.hostname,
          socket: tlsSocket,
          servername: url.hostname,
          path: url.pathname + url.search,
          method: options.method || "GET",
          headers: { ...options.headers },
          timeout: 60000,
        };
        const req = https.request(reqOpts, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({
            status: res.statusCode,
            headers: res.headers,
            data: Buffer.concat(chunks).toString(),
          }));
        });
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
        if (options.body) req.write(options.body);
        req.end();
      });
    });
}

// ─── HTTPS stream via any proxy ────────────────────────────────────────────

export function proxyFetchStream(urlStr, options = {}) {
  const url = new URL(urlStr);
  if (url.protocol !== "https:") return directFetchStream(urlStr, options);

  const proxy = getCurrentProxy();
  if (!proxy) return directFetchStream(urlStr, options);

  return getProxySocket(url.hostname, parseInt(url.port) || 443)
    .then((tlsSocket) => {
      return new Promise((resolve, reject) => {
        const reqOpts = {
          host: url.hostname,
          socket: tlsSocket,
          servername: url.hostname,
          path: url.pathname + url.search,
          method: options.method || "GET",
          headers: { ...options.headers },
          timeout: 120000,
        };
        const req = https.request(reqOpts, (res) => {
          const pass = new PassThrough();
          res.pipe(pass);
          resolve({ status: res.statusCode, headers: res.headers, stream: pass });
        });
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("Stream timeout")); });
        if (options.body) req.write(options.body);
        req.end();
      });
    });
}

// ─── Direct fetch (no proxy, fallback) ─────────────────────────────────────

function directFetch(urlStr, options = {}) {
  const url = new URL(urlStr);
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: options.method || "GET",
      headers: { ...options.headers },
      timeout: 60000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, data: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

function directFetchStream(urlStr, options = {}) {
  const url = new URL(urlStr);
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: options.method || "GET",
      headers: { ...options.headers },
      timeout: 120000,
    }, (res) => {
      const pass = new PassThrough();
      res.pipe(pass);
      resolve({ status: res.statusCode, headers: res.headers, stream: pass });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Stream timeout")); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ─── Utility ────────────────────────────────────────────────────────────────

export function getProxyInfo() {
  const p = getCurrentProxy();
  return p ? { protocol: p.protocol, host: p.host, port: p.port, raw: p.raw } : null;
}

export default {
  initProxyManager,
  getCurrentProxy,
  getProxyCount,
  rotateProxy,
  reloadProxies,
  proxyFetch,
  proxyFetchStream,
  getProxyInfo,
};
