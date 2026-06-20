/**
 * Proxy Checker — validate proxies & return public IP
 *
 * Usage:
 *   node proxy-checker.js [options]
 *
 * Options:
 *   --file <path>       Proxy list file (default: live.txt)
 *   --timeout <ms>      Timeout per proxy in ms (default: 10000)
 *   --concurrent <n>    Max concurrent checks (default: 20)
 *   --ip-service <url>  IP check endpoint (default: https://api.ipify.org?format=json)
 *   --output <path>     Write valid proxies to file (default: live-validated.txt)
 *   --no-output         Don't write output file, just print results
 *   --json              Output results as JSON
 *   --verbose           Show all attempts including failures
 *   --secure            Require valid SSL certs (default: skip SSL verify)
 *   --no-detect         Skip auto-detect, default bare ip:port to http
 *
 * Bare ip:port entries (no protocol prefix) are auto-detected:
 *   tries http → socks5 → socks4, keeps whichever works.
 *
 * Output format:
 *   Each valid proxy prints: proxy_url | public_ip | detected_protocol | latency_ms
 *
 * Dependencies: socks-proxy-agent, https-proxy-agent (already in project)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import https from "https";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// ─── Config ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

function getArg(name, fallback) {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return fallback;
}

const CONFIG = {
  file: getArg("--file", "live.txt"),
  timeout: parseInt(getArg("--timeout", "10000"), 10),
  concurrent: parseInt(getArg("--concurrent", "20"), 10),
  ipService: getArg("--ip-service", "https://api.ipify.org?format=json"),
  output: getArg("--output", "live-validated.txt"),
  noOutput: args.includes("--no-output"),
  json: args.includes("--json"),
  verbose: args.includes("--verbose"),
  insecure: !args.includes("--secure"),
  noDetect: args.includes("--no-detect"),
};

// Protocols to probe for bare ip:port (in order of likelihood)
const PROBE_PROTOCOLS = ["http", "socks5", "socks4"];

// ─── Parse proxy lines ──────────────────────────────────────────────────────
function parseProxyLine(line) {
  let s = line.trim().replace(/\r$/, "");
  if (!s || s.startsWith("#")) return null;

  // Detect bare ip:port (no protocol prefix)
  const hasProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  const isBare = !hasProtocol;

  if (isBare) {
    // Quick validation: must look like ip:port
    const bareMatch = s.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{1,5})$/);
    if (!bareMatch) return null;

    const port = parseInt(bareMatch[2], 10);
    if (port < 1 || port > 65535) return null;

    if (CONFIG.noDetect) {
      // Default to http
      s = "http://" + s;
    } else {
      // Mark as bare — will be probed later
      return {
        protocol: null,
        host: bareMatch[1],
        port,
        user: null,
        pass: null,
        raw: line.trim(),
        url: null,
        bare: true,
        bareHost: bareMatch[1],
        barePort: bareMatch[2],
      };
    }
  }

  if (!hasProtocol) {
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

    return { protocol, host, port, user, pass, raw: line.trim(), url: s, bare: false };
  } catch {
    return null;
  }
}

function loadProxies(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf-8");
    return text.split("\n").map(parseProxyLine).filter(Boolean);
  } catch (e) {
    console.error(`${C.red}Cannot read ${filePath}: ${e.message}${C.reset}`);
    return [];
  }
}

// ─── Load blacklist ─────────────────────────────────────────────────────────
function loadBlacklist() {
  const blacklist = new Set();
  const file = path.join(__dirname, "blacklist.txt");
  try {
    const text = fs.readFileSync(file, "utf-8");
    text.split("\n").forEach((l) => {
      const s = l.trim().replace(/\r$/, "");
      if (s) blacklist.add(s);
    });
  } catch { /* no file */ }
  return blacklist;
}

// ─── Build agent ────────────────────────────────────────────────────────────
function buildAgent(proxy) {
  if (proxy.protocol === "socks4" || proxy.protocol === "socks5") {
    return new SocksProxyAgent(proxy.url);
  }
  return new HttpsProxyAgent(proxy.url);
}

// ─── Raw check (single protocol) ────────────────────────────────────────────
function rawCheck(proxy, timeout) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const agent = buildAgent(proxy);
    const url = new URL(CONFIG.ipService);

    const reqOpts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
      },
      timeout,
      agent,
      ...(CONFIG.insecure ? { rejectUnauthorized: false } : {}),
    };

    const req = https.request(reqOpts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const latency = Date.now() - startTime;
        const body = Buffer.concat(chunks).toString();

        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(body);
            const ip = parsed.ip || parsed.query || parsed.origin;
            if (ip && isValidIP(ip)) {
              resolve({ success: true, publicIP: ip, latency });
              return;
            }
          } catch {
            const ipMatch = body.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
            if (ipMatch && isValidIP(ipMatch[0])) {
              resolve({ success: true, publicIP: ipMatch[0], latency });
              return;
            }
          }
        }
        resolve({ success: false, error: `HTTP ${res.statusCode}`, latency });
      });
    });

    req.on("error", (e) => {
      resolve({ success: false, error: e.message, latency: Date.now() - startTime });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({ success: false, error: "timeout", latency: Date.now() - startTime });
    });

    req.end();
  });
}

// ─── Check single proxy (with auto-detect for bare entries) ─────────────────
async function checkProxy(proxy) {
  if (proxy.bare && !CONFIG.noDetect) {
    return probeBareProxy(proxy);
  }

  const result = await rawCheck(proxy, CONFIG.timeout);
  return {
    success: result.success,
    proxy: proxy.raw,
    publicIP: result.publicIP || null,
    latency: result.latency,
    protocol: proxy.protocol,
    error: result.error || null,
  };
}

// ─── Probe bare proxy with multiple protocols ───────────────────────────────
async function probeBareProxy(proxy) {
  const probeTimeout = Math.min(CONFIG.timeout, 5000);

  for (const proto of PROBE_PROTOCOLS) {
    const url = `${proto}://${proxy.bareHost}:${proxy.barePort}`;
    const probeProxy = {
      protocol: proto,
      host: proxy.bareHost,
      port: proxy.barePort,
      user: null,
      pass: null,
      raw: proxy.raw,
      url,
      bare: false,
    };

    const result = await rawCheck(probeProxy, probeTimeout);

    if (result.success) {
      return {
        success: true,
        proxy: proxy.raw,
        publicIP: result.publicIP,
        latency: result.latency,
        protocol: proto,
        detected: true,
        error: null,
      };
    }
  }

  return {
    success: false,
    proxy: proxy.raw,
    publicIP: null,
    latency: 0,
    protocol: null,
    detected: false,
    error: "all protocols failed",
  };
}

// ─── Validate IP format ─────────────────────────────────────────────────────
function isValidIP(ip) {
  if (typeof ip !== "string") return false;
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    const n = parseInt(p, 10);
    return !isNaN(n) && n >= 0 && n <= 255 && String(n) === p;
  });
}

// ─── Concurrency limiter ────────────────────────────────────────────────────
async function runConcurrent(tasks, limit) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const filePath = path.isAbsolute(CONFIG.file) ? CONFIG.file : path.join(__dirname, CONFIG.file);
  const proxies = loadProxies(filePath);
  const blacklist = loadBlacklist();

  const bareCount = proxies.filter((p) => p.bare).length;
  const activeProxies = proxies.filter((p) => {
    if (p.bare) return true; // bare entries are always checked (not in blacklist by raw format)
    return !blacklist.has(p.raw);
  });

  console.log(`${C.bold}Proxy Checker${C.reset}`);
  console.log(`${C.gray}─${C.reset}`.repeat(50));
  console.log(`  File:        ${C.cyan}${filePath}${C.reset}`);
  console.log(`  Total:       ${proxies.length} proxies`);
  console.log(`  Bare (ip:port): ${C.magenta}${bareCount}${C.reset} (auto-detect ${CONFIG.noDetect ? "OFF" : "ON"})`);
  console.log(`  Active:      ${C.green}${activeProxies.length}${C.reset} (after blacklist)`);
  console.log(`  Blacklisted: ${C.red}${blacklist.size}${C.reset}`);
  console.log(`  Timeout:     ${CONFIG.timeout}ms`);
  console.log(`  Concurrent:  ${CONFIG.concurrent}`);
  console.log(`  IP Service:  ${CONFIG.ipService}`);
  console.log(`${C.gray}─${C.reset}`.repeat(50));
  console.log("");

  if (activeProxies.length === 0) {
    console.log(`${C.yellow}No active proxies to check.${C.reset}`);
    process.exit(0);
  }

  const bareActive = activeProxies.filter((p) => p.bare).length;
  const prefixedActive = activeProxies.filter((p) => !p.bare).length;

  const parts = [];
  if (prefixedActive > 0) parts.push(`${C.cyan}${prefixedActive}${C.reset} prefixed`);
  if (bareActive > 0) parts.push(`${C.magenta}${bareActive}${C.reset} bare (probing ${PROBE_PROTOCOLS.join("→")})`);
  console.log(`${C.yellow}Checking ${activeProxies.length} proxies...${C.reset} (${parts.join(" + ")})\n`);

  const startTime = Date.now();

  const tasks = activeProxies.map((proxy) => () => checkProxy(proxy));
  const results = await runConcurrent(tasks, CONFIG.concurrent);

  const valid = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);
  const detected = valid.filter((r) => r.detected);

  const elapsed = Date.now() - startTime;

  // Sort valid by latency
  valid.sort((a, b) => a.latency - b.latency);

  // Print results
  if (!CONFIG.json) {
    if (CONFIG.verbose || failed.length > 0) {
      console.log(`${C.red}Failed (${failed.length}):${C.reset}`);
      for (const r of failed) {
        console.log(`  ${C.red}x${C.reset} ${r.proxy} ${C.gray}| ${r.error} | ${r.latency}ms${C.reset}`);
      }
      console.log("");
    }

    console.log(`${C.green}Valid (${valid.length}):${C.reset}`);
    for (const r of valid) {
      const protoTag = r.detected
        ? `${C.magenta}[${r.protocol}]${C.reset}`
        : `${C.gray}${r.protocol}${C.reset}`;
      console.log(
        `  ${C.green}+${C.reset} ${r.proxy} ${C.cyan}| ${r.publicIP.padEnd(15)}${C.reset} | ${protoTag} | ${r.latency}ms`
      );
    }

    console.log("");
    console.log(`${C.gray}─${C.reset}`.repeat(50));
    console.log(`  ${C.green}Valid: ${valid.length}/${activeProxies.length}${C.reset} │ ${C.red}Failed: ${failed.length}${C.reset} │ ${C.magenta}Detected: ${detected.length}${C.reset} │ ${C.gray}${elapsed}ms total${C.reset}`);
  }

  // Write output file — save with detected protocol prefix
  if (!CONFIG.noOutput && valid.length > 0) {
    const outputPath = path.isAbsolute(CONFIG.output) ? CONFIG.output : path.join(__dirname, CONFIG.output);
    const content = valid.map((r) => {
      if (r.detected) {
        // Save with detected protocol prefix
        return `${r.protocol}://${r.proxy}`;
      }
      return r.proxy; // already has protocol prefix
    }).join("\n") + "\n";
    fs.writeFileSync(outputPath, content, "utf-8");
    console.log(`\n  ${C.green}Saved${C.reset} ${valid.length} valid proxies to ${C.cyan}${outputPath}${C.reset}`);
  }

  // JSON output
  if (CONFIG.json) {
    const output = {
      timestamp: new Date().toISOString(),
      config: {
        file: CONFIG.file,
        timeout: CONFIG.timeout,
        concurrent: CONFIG.concurrent,
        ipService: CONFIG.ipService,
        noDetect: CONFIG.noDetect,
      },
      summary: {
        total: proxies.length,
        bare: bareCount,
        active: activeProxies.length,
        valid: valid.length,
        failed: failed.length,
        detected: detected.length,
        elapsedMs: elapsed,
      },
      valid: valid.map((r) => ({
        proxy: r.detected ? `${r.protocol}://${r.proxy}` : r.proxy,
        publicIP: r.publicIP,
        latency: r.latency,
        protocol: r.protocol,
        detected: r.detected || false,
      })),
      failed: CONFIG.verbose
        ? failed.map((r) => ({
            proxy: r.proxy,
            error: r.error,
            latency: r.latency,
          }))
        : undefined,
    };
    console.log(JSON.stringify(output, null, 2));
  }

  process.exit(valid.length > 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`${C.red}Fatal: ${e.message}${C.reset}`);
  process.exit(1);
});
