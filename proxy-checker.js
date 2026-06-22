#!/usr/bin/env node
/**
 * proxy-checker.js — Fast Proxy Checker (Node.js)
 *
 * Alur pengecekan setiap proxy:
 *   GET endpoint IP via proxy, verifikasi IP valid.
 *   Jika proxy bisa mengembalikan IP publik yang valid = WORKING.
 *
 * Working proxy LANGSUNG di-append ke output file (incremental save).
 * Tidak perlu menunggu semua selesai.
 *
 * Usage:
 *   node proxy-checker.js -f proxies.txt
 *   node proxy-checker.js -f proxies.txt -c 100
 *   node proxy-checker.js -f proxies.txt --max-working 20
 *   node proxy-checker.js -u https://example.com/proxies.txt -o live.txt
 *   node proxy-checker.js -s proxy_sources.txt
 */

import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import { fileURLToPath } from "url";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getArg, getIntArg, hasFlag, printUsage } from "./args.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Konstanta ──────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT = 5;
const DEFAULT_CONCURRENT = 100;

const IP_CHECK_SERVICES = [
  "https://api.ipify.org?format=json",
  "http://httpbin.org/ip",
  "https://ifconfig.me/ip",
];

const IP_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const SUPPORTED_SCHEMES = new Set(["http", "https", "socks4", "socks4h", "socks5", "socks5h"]);
const SCHEME_ALIAS = { socks: "socks5", socks4h: "socks4", socks5h: "socks5" };

// ─── ANSI Colors ────────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
  white: "\x1b[37m",
};

// ─── CLI Args ────────────────────────────────────────────────────────────────

if (hasFlag("--help")) {
  printUsage(
    "Proxy Checker — HTTP/HTTPS/SOCKS4/SOCKS5",
    [
      { name: "--file", alias: "-f", type: "string", default: "proxies.txt", description: "File berisi daftar proxy" },
      { name: "--url", alias: "-u", type: "string", description: "URL berisi daftar proxy" },
      { name: "--sources", alias: "-s", type: "string", default: "proxy_sources.txt", description: "File berisi daftar URL/file sumber proxy" },
      { name: "--output", alias: "-o", type: "string", default: "live.txt", description: "Output file untuk proxy working" },
      { name: "--timeout", alias: "-t", type: "int", default: 5, description: "Timeout per proxy dalam detik" },
      { name: "--concurrent", alias: "-c", type: "int", default: 100, description: "Max concurrent checks" },
      { name: "--max-working", type: "int", default: 0, description: "Berhenti setelah mendapat N proxy working (0 = semua)" },
      { name: "--verbose", type: "bool", description: "Tampilkan semua attempt termasuk failure" },
    ],
    "node proxy-checker.js -f proxies.txt"
  );
  process.exit(0);
}

// ─── Config ─────────────────────────────────────────────────────────────────

const CONFIG = {
  file: getArg("-f") || getArg("--file"),
  url: getArg("-u") || getArg("--url"),
  sources: getArg("-s") || getArg("--sources") || "proxy_sources.txt",
  output: getArg("-o") || getArg("--output") || "live.txt",
  timeout: getIntArg("-t") || getIntArg("--timeout") || DEFAULT_TIMEOUT,
  concurrent: getIntArg("-c") || getIntArg("--concurrent") || DEFAULT_CONCURRENT,
  maxWorking: getIntArg("--max-working") || 0,
  verbose: hasFlag("--verbose"),
};

// ─── IP Helpers ─────────────────────────────────────────────────────────────

function isValidIP(s) {
  if (typeof s !== "string") return false;
  s = s.trim();
  const m = IP_RE.exec(s);
  if (!m) return false;
  return m.slice(1).every((g) => {
    const n = parseInt(g, 10);
    return n >= 0 && n <= 255 && String(n) === g;
  });
}

function extractIP(text) {
  if (!text) return null;
  text = text.trim();
  if (isValidIP(text)) return text;
  try {
    const data = JSON.parse(text);
    if (data && typeof data === "object") {
      for (const key of ["ip", "origin", "query"]) {
        const v = data[key];
        if (v && isValidIP(String(v))) return String(v);
      }
    }
  } catch {}
  const m = IP_RE.exec(text);
  if (m && isValidIP(m[0])) return m[0];
  return null;
}

// ─── Proxy class ────────────────────────────────────────────────────────────

class Proxy {
  constructor({ host, port, protocol, username, password, source }) {
    this.host = host;
    this.port = port;
    this.protocol = protocol;
    this.username = username || null;
    this.password = password || null;
    this.source = source || "";
    this.ipDetected = null;
    this.latency = null;
  }

  get url() {
    const scheme = this.protocol;
    if (this.username) {
      const u = encodeURIComponent(this.username);
      const p = encodeURIComponent(this.password || "");
      return `${scheme}://${u}:${p}@${this.host}:${this.port}`;
    }
    return `${scheme}://${this.host}:${this.port}`;
  }

  get display() {
    if (this.username) {
      return `${this.protocol}://${this.username}:***@${this.host}:${this.port}`;
    }
    return `${this.protocol}://${this.host}:${this.port}`;
  }

  get key() {
    return `${this.protocol}:${this.host}:${this.port}`;
  }
}

// ─── HTTP Request Helper ────────────────────────────────────────────────────

function buildAgent(proxy) {
  if (proxy.protocol === "socks4" || proxy.protocol === "socks5") {
    return new SocksProxyAgent(proxy.url);
  }
  return new HttpsProxyAgent(proxy.url);
}

function requestViaProxy(proxy, urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const agent = buildAgent(proxy);
    const url = new URL(urlStr);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;

    const reqOpts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: options.method || "GET",
      headers: options.headers || {},
      timeout: options.timeout || 30000,
      agent,
      ...(options.insecure ? { rejectUnauthorized: false } : {}),
    };

    const req = lib.request(reqOpts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve({ statusCode: res.statusCode, headers: res.headers, body });
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });

    if (options.body) req.write(options.body);
    req.end();
  });
}

// ─── IP Check (core validation) ─────────────────────────────────────────────

async function checkProxy(proxy, timeoutSec) {
  const timeoutMs = timeoutSec * 1000;
  const t0 = Date.now();

  for (const serviceURL of IP_CHECK_SERVICES) {
    try {
      const res = await requestViaProxy(proxy, serviceURL, {
        timeout: timeoutMs,
        insecure: true,
        headers: { Accept: "*/*" },
      });
      if (res.statusCode === 200) {
        const ip = extractIP(res.body);
        if (ip) {
          return {
            ok: true,
            ip,
            latency: Date.now() - t0,
            error: null,
          };
        }
      }
    } catch {}
  }

  return {
    ok: false,
    ip: null,
    latency: Date.now() - t0,
    error: "ip_check_failed",
  };
}

// ─── Incremental Saver ──────────────────────────────────────────────────────

class IncrementalSaver {
  constructor(outputPath) {
    this.path = path.isAbsolute(outputPath) ? outputPath : path.join(__dirname, outputPath);
    fs.writeFileSync(this.path, "", "utf-8");
    this.count = 0;
  }

  append(proxy) {
    fs.appendFileSync(this.path, proxy.url + "\n", "utf-8");
    this.count++;
  }
}

// ─── Concurrency limiter ────────────────────────────────────────────────────

async function runConcurrent(items, limit, fn) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.allSettled(workers);
  return results;
}

// ─── Check session ──────────────────────────────────────────────────────────

async function runChecks(proxies, timeoutSec, maxConcurrent, maxWorking, output) {
  if (proxies.length === 0) {
    console.log(`\n${C.red}[!] Tidak ada proxy untuk dicek${C.reset}`);
    return { working: [], checked: 0 };
  }

  const total = proxies.length;
  const saver = new IncrementalSaver(output);
  const working = [];
  let checked = 0;
  const startTime = Date.now();

  // Hard timeout: batas mutlak agar satu proxy tidak bisa memblokir selamanya
  const hardTimeoutMs = timeoutSec * 3 * 1000;

  console.log(`\n${C.cyan}[*] Mengecek ${total} proxy (timeout: ${timeoutSec}s, concurrent: ${maxConcurrent})${C.reset}`);
  console.log(`${C.gray}[*] Test: GET IP service via proxy -> verifikasi IP valid${C.reset}`);
  if (maxWorking) {
    console.log(`${C.yellow}[*] Akan berhenti setelah mendapat ${maxWorking} working proxy${C.reset}`);
  }
  console.log("");

  let stopped = false;

  const results = await runConcurrent(proxies, maxConcurrent, async (proxy) => {
    if (stopped) return null;

    let result;
    try {
      result = await Promise.race([
        checkProxy(proxy, timeoutSec),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("hard_timeout")), hardTimeoutMs)
        ),
      ]);
    } catch (e) {
      result = {
        ok: false,
        ip: null,
        latency: hardTimeoutMs,
        error: e.message === "hard_timeout" ? "hard_timeout" : "error",
      };
    }

    checked++;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const idxStr = `[${checked}/${total}]`;

    if (result.ok) {
      // Guard: skip jika sudah mencapai limit (race condition antar concurrent worker)
      if (maxWorking && working.length >= maxWorking) return result;

      proxy.ipDetected = result.ip;
      proxy.latency = result.latency;
      saver.append(proxy);
      working.push(proxy);
      const currentWorking = working.length;
      console.log(
        `  ${idxStr} ${C.green}[+] WORKING${C.reset} ${proxy.display}` +
        ` (${result.latency}ms) IP: ${result.ip} -> saved (${currentWorking} total)` +
        ` ${C.gray}[${elapsed}s]${C.reset}`
      );
      if (maxWorking && currentWorking >= maxWorking) {
        stopped = true;
      }
    } else if (checked <= 50 || checked % 200 === 0 || CONFIG.verbose) {
      console.log(
        `  ${idxStr} ${C.red}[-] FAIL${C.reset}     ${proxy.display}` +
        ` (${result.error}) ${C.gray}[${elapsed}s]${C.reset}`
      );
    }

    return result;
  });

  return { working, checked };
}

// ─── Proxy parser ───────────────────────────────────────────────────────────

function inferScheme(name) {
  const n = name.toLowerCase();
  if (n.includes("socks5")) return "socks5";
  if (n.includes("socks4")) return "socks4";
  if (n.includes("socks")) return "socks5";
  if (n.includes("https")) return "https";
  return "http";
}

function parseProxyLine(line, source, defaultScheme) {
  line = line.trim();
  if (!line || line.startsWith("#")) return null;
  line = line.replace(/\s*#.*$/, "").trim();
  if (!line) return null;

  const scheme = defaultScheme || "http";

  // Format with explicit scheme
  if (/^(https?|socks[45]h?):\/\//i.test(line)) {
    return parseURL(line, source);
  }

  // Format user:pass@host:port (no scheme)
  if (line.includes("@")) {
    return parseURL(`${scheme}://${line}`, source);
  }

  // Format columns
  return parseColumns(line, source, scheme);
}

function parseURL(raw, source) {
  try {
    const u = new URL(raw);
    let protocol = u.protocol.replace(":", "").toLowerCase();
    protocol = SCHEME_ALIAS[protocol] || protocol;
    if (!SUPPORTED_SCHEMES.has(protocol)) return null;

    const host = u.hostname;
    const port = parseInt(u.port, 10);
    if (!host || isNaN(port) || port < 1 || port > 65535) return null;

    return new Proxy({
      host,
      port,
      protocol,
      username: u.username ? decodeURIComponent(u.username) : null,
      password: u.password ? decodeURIComponent(u.password) : null,
      source,
    });
  } catch {
    return null;
  }
}

function parseColumns(line, source, defaultScheme) {
  let parts = line.split(/[\t ,]+/).filter(Boolean);
  if (parts.length === 1) {
    parts = line.split(":").filter(Boolean);
  }

  let protocol = defaultScheme;

  if (parts.length === 2) {
    return makeProxy(protocol, parts[0], parts[1], null, null, source);
  }
  if (parts.length === 3) {
    if (SUPPORTED_SCHEMES.has(parts[0].toLowerCase())) {
      return makeProxy(parts[0].toLowerCase(), parts[1], parts[2], null, null, source);
    }
    return makeProxy(protocol, parts[0], parts[1], null, null, source);
  }
  if (parts.length === 4) {
    if (SUPPORTED_SCHEMES.has(parts[0].toLowerCase())) {
      return makeProxy(parts[0].toLowerCase(), parts[1], parts[2], parts[3], null, source);
    }
    return makeProxy(protocol, parts[0], parts[1], parts[2], parts[3], source);
  }
  if (parts.length === 5 && SUPPORTED_SCHEMES.has(parts[0].toLowerCase())) {
    return makeProxy(parts[0].toLowerCase(), parts[1], parts[2], parts[3], parts[4], source);
  }

  return null;
}

function makeProxy(protocol, host, portStr, user, passwd, source) {
  protocol = SCHEME_ALIAS[protocol] || protocol;
  try {
    const port = parseInt(portStr, 10);
    if (isNaN(port) || port < 1 || port > 65535 || !host) return null;
    return new Proxy({
      host,
      port,
      protocol,
      username: user || null,
      password: passwd || null,
      source,
    });
  } catch {
    return null;
  }
}

// ─── Source loaders ─────────────────────────────────────────────────────────

function loadFromFile(filePath, defaultScheme) {
  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(__dirname, filePath);
  const scheme = defaultScheme || inferScheme(filePath);
  const proxies = [];
  try {
    const text = fs.readFileSync(resolvedPath, "utf-8");
    for (const line of text.split("\n")) {
      const p = parseProxyLine(line, filePath, scheme);
      if (p) proxies.push(p);
    }
    console.log(`  ${C.green}[+] Loaded ${proxies.length} proxy dari ${filePath} (default scheme: ${scheme})${C.reset}`);
  } catch (e) {
    if (e.code === "ENOENT") {
      console.log(`  ${C.red}[-] File tidak ditemukan: ${filePath}${C.reset}`);
    } else {
      console.log(`  ${C.red}[-] Error loading ${filePath}: ${e.message}${C.reset}`);
    }
  }
  return proxies;
}

async function loadFromURL(url, defaultScheme) {
  const scheme = defaultScheme || inferScheme(url);
  const proxies = [];
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "proxy-checker/1.0" },
      signal: AbortSignal.timeout(15000),
      redirect: "follow",
    });
    if (!res.ok) {
      console.log(`  ${C.red}[-] Gagal load ${url}: HTTP ${res.status}${C.reset}`);
      return proxies;
    }
    const text = await res.text();
    for (const line of text.split("\n")) {
      const p = parseProxyLine(line, url, scheme);
      if (p) proxies.push(p);
    }
    console.log(`  ${C.green}[+] Loaded ${proxies.length} proxy dari ${url} (default scheme: ${scheme})${C.reset}`);
  } catch (e) {
    console.log(`  ${C.red}[-] Error loading ${url}: ${e.message}${C.reset}`);
  }
  return proxies;
}

async function loadFromSourcesFile(filePath) {
  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(__dirname, filePath);
  const allProxies = [];
  if (!fs.existsSync(resolvedPath)) return allProxies;

  const text = fs.readFileSync(resolvedPath, "utf-8");
  for (const raw of text.split("\n")) {
    const entry = raw.trim();
    if (!entry || entry.startsWith("#")) continue;

    let explicitScheme = null;
    if (entry.includes("::")) {
      const idx = entry.indexOf("::");
      const prefix = entry.substring(0, idx).trim().toLowerCase();
      if (SUPPORTED_SCHEMES.has(prefix)) {
        explicitScheme = prefix;
      }
    }

    const target = explicitScheme ? entry.substring(entry.indexOf("::") + 2).trim() : entry;

    let batch;
    if (target.startsWith("http://") || target.startsWith("https://")) {
      batch = await loadFromURL(target, explicitScheme);
    } else if (fs.existsSync(target)) {
      batch = loadFromFile(target, explicitScheme);
    } else {
      console.log(`  ${C.red}[-] Sumber tidak ditemukan: ${target}${C.reset}`);
      continue;
    }
    allProxies.push(...batch);
  }
  return allProxies;
}

function deduplicate(proxies) {
  const seen = new Set();
  const result = [];
  for (const p of proxies) {
    if (!seen.has(p.key)) {
      seen.add(p.key);
      result.push(p);
    }
  }
  return result;
}

// ─── Entry point ────────────────────────────────────────────────────────────

async function main() {
  console.log(`${C.bold}${"=".repeat(60)}${C.reset}`);
  console.log(`${C.bold}PROXY CHECKER — HTTP/HTTPS/SOCKS4/SOCKS5${C.reset}`);
  console.log(`${C.bold}${"=".repeat(60)}${C.reset}`);
  console.log("");
  console.log(`${C.cyan}[*] Sumber proxy:${C.reset}`);

  let allProxies = [];
  const hasExplicit = !!(CONFIG.file || CONFIG.url);

  if (CONFIG.file) {
    console.log(`  - File: ${CONFIG.file}`);
    allProxies.push(...loadFromFile(CONFIG.file));
  }

  if (CONFIG.url) {
    console.log(`  - URL: ${CONFIG.url}`);
    allProxies.push(...(await loadFromURL(CONFIG.url)));
  }

  if (!hasExplicit && fs.existsSync(CONFIG.sources)) {
    console.log(`  - Sources: ${CONFIG.sources}`);
    allProxies.push(...(await loadFromSourcesFile(CONFIG.sources)));
  }

  if (allProxies.length === 0) {
    console.log("");
    console.log(`${C.red}[!] Tidak ada proxy yang dimuat!${C.reset}`);
    console.log(`    Contoh: node proxy-checker.js -f proxies.txt`);
    console.log(`    Contoh: node proxy-checker.js -u https://example.com/proxies.txt`);
    console.log(`    Contoh: node proxy-checker.js -s proxy_sources.txt --max-working 20`);
    process.exit(1);
  }

  const unique = deduplicate(allProxies);
  console.log("");
  console.log(`${C.cyan}[*] Total: ${allProxies.length} | Unique: ${unique.length}${C.reset}`);
  console.log(`${C.cyan}[*] Output: ${CONFIG.output} (incremental save)${C.reset}`);

  const t0 = Date.now();
  const { working, checked } = await runChecks(
    unique,
    CONFIG.timeout,
    CONFIG.concurrent,
    CONFIG.maxWorking,
    CONFIG.output
  );
  const elapsed = (Date.now() - t0) / 1000;

  console.log("");
  console.log(`${C.bold}${"=".repeat(60)}${C.reset}`);
  console.log(`${C.bold}RINGKASAN${C.reset}`);
  console.log(`${C.bold}${"=".repeat(60)}${C.reset}`);
  console.log(`Total dicek  : ${checked}`);
  console.log(`Working      : ${working.length}`);
  console.log(`Output       : ${CONFIG.output}`);
  console.log(`Waktu        : ${elapsed.toFixed(2)}s`);
  console.log(`Throughput   : ${(checked / elapsed).toFixed(1)} proxy/detik`);
  console.log(`${C.bold}${"=".repeat(60)}${C.reset}`);

  process.exit(working.length > 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`${C.red}Fatal: ${e.message}${C.reset}`);
  process.exit(1);
});
