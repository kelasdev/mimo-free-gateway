/**
 * Proxy Manager — auto-rotate, blacklist, seamless switch
 *
 * Uses socks-proxy-agent + https-proxy-agent (battle-tested).
 * Supports: SOCKS4, SOCKS5, HTTP, HTTPS (with or without auth).
 *
 * File format: protocol://[user:pass@]host:port (one per line)
 * Sources: live.txt, proxies.txt
 * Blacklist: blacklist.txt (auto-append on failure)
 */

import fs from "fs";
import path from "path";
import http from "http";
import https from "https";
import { PassThrough } from "stream";
import { fileURLToPath } from "url";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── State ──────────────────────────────────────────────────────────────────

let allProxies = [];       // [{protocol, host, port, user, pass, raw, url}]
let currentIndex = 0;
let blacklist = new Set();

const PROXY_FILES = ["live.txt", "proxies.txt"];
const BLACKLIST_FILE = "blacklist.txt";

// ─── Parse ──────────────────────────────────────────────────────────────────

function parseProxyLine(line) {
  let s = line.trim().replace(/\r$/, "");
  if (!s || s.startsWith("#")) return null;

  // Normalize: host:port → http://host:port
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    s = "http://" + s;
  }

  try {
    const u = new URL(s);
    const protocol = u.protocol.replace(":", "").toLowerCase();
    if (!["http", "https", "socks4", "socks5"].includes(protocol)) return null;

    const host = u.hostname;
    const port = parseInt(u.port, 10);
    if (!host || isNaN(port) || port < 1 || port > 65535) return null;

    const user = u.username ? decodeURIComponent(u.username) : null;
    const pass = u.password ? decodeURIComponent(u.password) : null;

    return { protocol, host, port, user, pass, raw: line.trim(), url: s };
  } catch {
    return null;
  }
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
    const file = path.join(__dirname, BLACKLIST_FILE);
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
    if (!existing.includes(proxy.raw)) {
      fs.appendFileSync(file, proxy.raw + "\n");
    }
  } catch { /* ignore */ }
}

// ─── Init ───────────────────────────────────────────────────────────────────

export function initProxyManager(proxyFile) {
  loadBlacklist();

  let found = [];
  if (proxyFile) found = loadProxies(proxyFile);
  if (found.length === 0) {
    for (const f of PROXY_FILES) {
      const full = path.isAbsolute(f) ? f : path.join(__dirname, f);
      found = loadProxies(full);
      if (found.length > 0) break;
    }
  }

  allProxies = found.filter((p) => !blacklist.has(p.raw));
  currentIndex = 0;
  console.log(`[proxy] Loaded ${found.length} proxies (${allProxies.length} active, ${blacklist.size} blacklisted)`);
  return allProxies.length;
}

export function getCurrentProxy() {
  if (allProxies.length === 0) return null;
  return allProxies[currentIndex % allProxies.length];
}

export function getProxyCount() { return allProxies.length; }

export function rotateProxy(reason) {
  if (allProxies.length === 0) return null;
  const current = allProxies[currentIndex % allProxies.length];
  console.log(`[proxy] Rotating: ${current.raw} — reason: ${reason}`);
  saveBlacklist(current);

  const start = currentIndex;
  do {
    currentIndex = (currentIndex + 1) % allProxies.length;
    if (currentIndex === start) break;
  } while (blacklist.has(allProxies[currentIndex]?.raw));

  allProxies = allProxies.filter((p) => !blacklist.has(p.raw));
  if (allProxies.length === 0) { console.log("[proxy] All proxies blacklisted!"); return null; }

  const next = allProxies[currentIndex % allProxies.length];
  console.log(`[proxy] Now using: ${next.raw} (${allProxies.length} remaining)`);
  return next;
}

export function reloadProxies(proxyFile) {
  allProxies = []; currentIndex = 0; blacklist.clear();
  loadBlacklist();
  let found = [];
  if (proxyFile) found = loadProxies(proxyFile);
  if (found.length === 0) {
    for (const f of PROXY_FILES) {
      const full = path.isAbsolute(f) ? f : path.join(__dirname, f);
      found = loadProxies(full);
      if (found.length > 0) break;
    }
  }
  allProxies = found.filter((p) => !blacklist.has(p.raw));
  console.log(`[proxy] Reloaded: ${allProxies.length} active`);
  return allProxies.length;
}

// ─── Agent builder ──────────────────────────────────────────────────────────

function buildAgent(proxy) {
  if (!proxy) return undefined;
  if (proxy.protocol === "socks4" || proxy.protocol === "socks5") {
    return new SocksProxyAgent(proxy.url);
  }
  // http/https → use https-proxy-agent for tunnel
  return new HttpsProxyAgent(proxy.url);
}

// ─── Fetch via proxy agent ─────────────────────────────────────────────────

export function proxyFetch(urlStr, options = {}) {
  const proxy = getCurrentProxy();
  const agent = buildAgent(proxy);
  const url = new URL(urlStr);

  return new Promise((resolve, reject) => {
    const reqOpts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: options.method || "GET",
      headers: { ...options.headers },
      timeout: 60000,
      ...(agent ? { agent } : {}),
    };
    const req = https.request(reqOpts, (res) => {
      const chunks = [];
      let totalBytes = 0;
      res.on("data", (c) => {
        totalBytes += c.length;
        if (totalBytes > 10 * 1024 * 1024) { req.destroy(); return reject(new Error("Response too large")); }
        chunks.push(c);
      });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, data: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

export function proxyFetchStream(urlStr, options = {}) {
  const proxy = getCurrentProxy();
  const agent = buildAgent(proxy);
  const url = new URL(urlStr);

  return new Promise((resolve, reject) => {
    const reqOpts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: options.method || "GET",
      headers: { ...options.headers },
      timeout: 120000,
      ...(agent ? { agent } : {}),
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
}

export function getProxyInfo() {
  const p = getCurrentProxy();
  return p ? { protocol: p.protocol, host: p.host, port: p.port, raw: p.raw } : null;
}

export default {
  initProxyManager, getCurrentProxy, getProxyCount, rotateProxy,
  reloadProxies, proxyFetch, proxyFetchStream, getProxyInfo,
};
