/**
 * args.js — Shared CLI Argument Parser
 *
 * Parses --flag value / --boolean-style flags dari process.argv.
 * Support env variable fallback, type coercion, dan help generation.
 *
 * Usage:
 *   import { getArg, getIntArg, hasFlag, getArgEnv } from "./args.js";
 *   const port = getArgEnv("--port", "PORT", 3000);
 *   const verbose = hasFlag("--verbose");
 */

const raw = process.argv.slice(2);

// ─── String Arguments ────────────────────────────────────────────────────────

/**
 * Get string argument: --name value
 * @param {string} name  Flag name (e.g. "--port", "--file")
 * @param {string} [fallback]  Default if not found
 * @returns {string|undefined}
 */
export function getArg(name, fallback) {
  const idx = raw.indexOf(name);
  if (idx !== -1 && idx + 1 < raw.length && !raw[idx + 1].startsWith("--")) {
    return raw[idx + 1];
  }
  return fallback;
}

/**
 * Get argument with env fallback: --name value || ENV_VAR || default
 * Priority: CLI flag > env variable > default
 * @param {string} name  Flag name (e.g. "--port")
 * @param {string} envName  Env variable name (e.g. "PORT")
 * @param {*} [fallback]  Default if both CLI and env missing
 * @returns {string|undefined}
 */
export function getArgEnv(name, envName, fallback) {
  return getArg(name) || process.env[envName] || fallback;
}

// ─── Boolean Flags ───────────────────────────────────────────────────────────

/**
 * Check if boolean flag is present: --verbose, --json, --no-output
 * @param {string} name  Flag name (e.g. "--verbose")
 * @returns {boolean}
 */
export function hasFlag(name) {
  return raw.includes(name);
}

/**
 * Check negated flag: returns true if --no-X is present, false if --X is present
 * @param {string} name  Base name without --no- prefix (e.g. "output" checks --no-output vs --output)
 * @param {boolean} [defaultTrue=true]  Default when neither flag present
 * @returns {boolean}
 */
export function hasNegatableFlag(name, defaultTrue = true) {
  const noFlag = `--no-${name}`;
  const yesFlag = `--${name}`;
  if (raw.includes(noFlag)) return false;
  if (raw.includes(yesFlag)) return true;
  return defaultTrue;
}

// ─── Typed Arguments ─────────────────────────────────────────────────────────

/**
 * Get integer argument with env fallback
 * @param {string} name  Flag name
 * @param {string} envName  Env variable name
 * @param {number} [fallback=0]  Default value
 * @returns {number}
 */
export function getIntArgEnv(name, envName, fallback = 0) {
  const val = getArg(name) || process.env[envName];
  if (val === undefined || val === null || val === "") return fallback;
  const n = parseInt(val, 10);
  return isNaN(n) ? fallback : n;
}

/**
 * Get integer argument (no env fallback)
 * @param {string} name  Flag name
 * @param {number} [fallback=0]  Default value
 * @returns {number}
 */
export function getIntArg(name, fallback = 0) {
  const val = getArg(name);
  if (val === undefined) return fallback;
  const n = parseInt(val, 10);
  return isNaN(n) ? fallback : n;
}

/**
 * Get boolean-like argument (true/false/1/0)
 * @param {string} name  Flag name
 * @param {boolean} [fallback=false]
 * @returns {boolean}
 */
export function getBoolArg(name, fallback = false) {
  const val = getArg(name);
  if (val === undefined) return fallback;
  return ["true", "1", "yes"].includes(val.toLowerCase());
}

// ─── Help / Usage Generator ──────────────────────────────────────────────────

/**
 * Print usage/help text from option definitions
 * @param {string} title  Script title
 * @param {Array<{name:string, alias?:string, description:string, type?:string, default?:*}>} options
 * @param {string} [usageExample]  Example usage line
 */
export function printUsage(title, options, usageExample) {
  const lines = [];
  lines.push(`${title}`);
  lines.push(``);
  if (usageExample) {
    lines.push(`Usage: ${usageExample}`);
    lines.push(``);
  }
  lines.push(`Options:`);

  let maxNameLen = 0;
  for (const opt of options) {
    const label = opt.alias ? `${opt.name}, ${opt.alias}` : opt.name;
    if (label.length > maxNameLen) maxNameLen = label.length;
  }

  for (const opt of options) {
    const label = opt.alias ? `${opt.name}, ${opt.alias}` : opt.name;
    const padded = label.padEnd(maxNameLen + 2);
    const type = opt.type ? ` <${opt.type}>` : "";
    const def = opt.default !== undefined ? ` (default: ${opt.default})` : "";
    lines.push(`  ${padded}${type}  ${opt.description}${def}`);
  }

  console.log(lines.join("\n"));
}

// ─── Summary Object ──────────────────────────────────────────────────────────

/**
 * Build a config object from multiple arg definitions
 * @param {Array<{name:string, env?:string, type?:string, default:*}>} defs
 * @returns {Object}
 */
export function buildConfig(defs) {
  const config = {};
  for (const def of defs) {
    let val;
    if (def.type === "int") {
      val = getIntArgEnv(def.name, def.env, def.default);
    } else if (def.type === "bool") {
      val = hasFlag(def.name);
    } else {
      val = getArgEnv(def.name, def.env, def.default);
    }
    config[def.key || def.name.replace(/^--/, "").replace(/-/g, "_")] = val;
  }
  return config;
}

export default {
  raw,
  getArg,
  getArgEnv,
  hasFlag,
  hasNegatableFlag,
  getIntArg,
  getIntArgEnv,
  getBoolArg,
  printUsage,
  buildConfig,
};
