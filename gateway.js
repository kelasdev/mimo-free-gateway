/**
 * MiMo Free Gateway Server
 *
 * Proxy gateway untuk MiMo Free API.
 * Agent CLI cukup arahkan `baseUrl` ke sini.
 * Gateway handle: JWT bootstrap, system marker injection, session affinity, retry.
 *
 * Cara pakai:
 *   node gateway.js --port 3000
 *
 * Environment:
 *   CHAT_URL — upstream MiMo chat endpoint (default: https://api.xiaomimimo.com/api/free-ai/chat)
 *   PORT     — port listen (default: 3000)
 *
 * Agent CLI config:
 *   providers.mimo-free.baseUrl = http://<IP>:<PORT>/v1/chat/completions
 */

import http from "http";
import https from "https";
import { createHash } from "crypto";
import os from "os";
import { PassThrough } from "stream";

// ─── Konfigurasi ────────────────────────────────────────────────────────────

const BOOTSTRAP_URL = "https://api.xiaomimimo.com/api/free-ai/bootstrap";
const MIMO_SYSTEM_MARKER =
  "You are MiMoCode, an interactive CLI tool that helps users with software engineering tasks.";
const JWT_FALLBACK_TTL_SEC = 3000;
const JWT_EXPIRY_BUFFER_MS = 300000;
const SESSION_AFFINITY_PREFIX = "ses_";
const SESSION_ID_LENGTH = 24;
const SESSION_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
const portIndex = process.argv.indexOf("--port");
const PORT = parseInt(
  process.env.PORT || (portIndex !== -1 ? process.argv[portIndex + 1] : "3000"), 10
);
const CHAT_URL = process.env.CHAT_URL || "https://api.xiaomimimo.com/api/free-ai/openai/chat";

// Model yang didukung gateway — semua request akan di-override ke model ini
const SUPPORTED_MODELS = ["mimo-auto"];
const DEFAULT_MODEL = SUPPORTED_MODELS[0];

// ─── State ──────────────────────────────────────────────────────────────────

let cachedJwt = null;
let jwtExpiresAt = 0;

// ─── Helpers ────────────────────────────────────────────────────────────────

function generateFingerprint() {
  let username = "unknown-user";
  try { username = os.userInfo().username; } catch { /* ignore */ }
  const cpu = (os.cpus()[0]?.model || "unknown-cpu").trim();
  const seed = `${os.hostname()}|${os.platform()}|${os.arch()}|${cpu}|${username}`;
  return createHash("sha256").update(seed).digest("hex");
}

function generateSessionId() {
  let id = SESSION_AFFINITY_PREFIX;
  for (let i = 0; i < SESSION_ID_LENGTH; i++) {
    id += SESSION_CHARS[Math.floor(Math.random() * SESSION_CHARS.length)];
  }
  return id;
}

function parseJwtExp(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
    if (payload.exp) return payload.exp * 1000;
  } catch { /* ignore */ }
  return Date.now() + JWT_FALLBACK_TTL_SEC * 1000;
}

function resetJwtCache() { cachedJwt = null; jwtExpiresAt = 0; }

function injectSystemMarker(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return body;
  const hasMarker = messages.some(
    (m) => m?.role === "system" && typeof m.content === "string"
      && m.content.includes(MIMO_SYSTEM_MARKER)
  );
  if (hasMarker) return body;
  return { ...body, messages: [{ role: "system", content: MIMO_SYSTEM_MARKER }, ...messages] };
}

// ─── Bootstrap JWT ──────────────────────────────────────────────────────────

async function bootstrapJwt() {
  if (cachedJwt && Date.now() < jwtExpiresAt - JWT_EXPIRY_BUFFER_MS) {
    return cachedJwt;
  }
  const body = JSON.stringify({ client: generateFingerprint() });
  const { status, data } = await httpsFetch(BOOTSTRAP_URL, {
    method: "POST", headers: { "Content-Type": "application/json" }, body,
  });
  if (status !== 200) throw new Error(`Bootstrap failed: ${status}`);
  const parsed = JSON.parse(data);
  if (!parsed.jwt) throw new Error("Bootstrap returned no JWT");
  cachedJwt = parsed.jwt;
  jwtExpiresAt = parseJwtExp(parsed.jwt);
  return cachedJwt;
}

// ─── HTTP Clients ───────────────────────────────────────────────────────────

function httpsFetch(urlStr, options = {}) {
  const url = new URL(urlStr);
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: options.method || "GET",
      headers: { ...options.headers },
      timeout: 60000,
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, data: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

function httpsFetchStream(urlStr, options) {
  const url = new URL(urlStr);
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: options.method || "GET",
      headers: { ...options.headers },
      timeout: 120000,
    };
    const req = lib.request(opts, (res) => {
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

// ─── Build upstream headers ─────────────────────────────────────────────────

function buildUpstreamHeaders(incomingHeaders, jwt, stream, sessionId) {
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${jwt}`,
    "X-Mimo-Source": "mimocode-cli-free",
    "x-session-affinity": sessionId,
    "Accept": stream ? "text/event-stream" : "application/json",
  };

  // Forward header2 penting dari client asli
  const fwdHeaders = ["user-agent", "origin", "referer", "cookie", "x-forwarded-for"];
  for (const h of fwdHeaders) {
    if (incomingHeaders[h]) headers[h] = incomingHeaders[h];
  }
  // Forward X-Mimo-* headers kalo ada
  for (const [k, v] of Object.entries(incomingHeaders)) {
    if (k.startsWith("x-mimo-") && !headers[k.toLowerCase()]) {
      headers[k] = v;
    }
  }

  return headers;
}

// ─── Proxy Logic ────────────────────────────────────────────────────────────

async function handleChat(req, res) {
  if (req.method !== "POST") {
    return sendJSON(res, 405, { error: "Method not allowed. Use POST." });
  }

  // Baca body
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return sendJSON(res, 400, { error: "Invalid JSON body" });
  }

  const stream = body.stream !== false;
  const sessionId = generateSessionId();

  // Override model — client boleh kirim model apapun, gateway paksa ke default
  const originalModel = body.model;
  body.model = DEFAULT_MODEL;

  // Inject system marker
  const transformedBody = injectSystemMarker(body);
  const bodyStr = JSON.stringify(transformedBody);

  console.log(`[${new Date().toISOString()}] → ${CHAT_URL} | stream=${stream} | model="${originalModel}"→"${DEFAULT_MODEL}" | body=${(bodyStr.length / 1024).toFixed(1)}KB | session=${sessionId}`);

  // Upstream forward — retry 1x kalo 401/403
  const { status, data, stream: upStream } = await upstreamCall(
    CHAT_URL, req.headers, bodyStr, stream, sessionId
  );

  if (stream) {
    if (upStream) {
      res.writeHead(status, {
        "Content-Type": status === 200 ? "text/event-stream" : "application/json",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      upStream.pipe(res);
    } else {
      sendJSON(res, status, { error: "Upstream returned no stream", detail: data });
    }
  } else {
    sendJSON(res, status, data);
  }
}

/**
 * Call upstream dengan retry 1x untuk 401/403.
 * Return { status, data?, stream? } — salah satu dari data atau stream.
 */
async function upstreamCall(url, incomingHeaders, bodyStr, stream, sessionId) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let jwt;
    try { jwt = await bootstrapJwt(); } catch (e) {
      return { status: 502, data: JSON.stringify({ error: `Bootstrap failed: ${e.message}` }) };
    }

    const headers = buildUpstreamHeaders(incomingHeaders, jwt, stream, sessionId);

    try {
      if (stream) {
        const result = await httpsFetchStream(url, {
          method: "POST", headers, body: bodyStr,
        });
        if ((result.status === 401 || result.status === 403) && attempt === 1) {
          // Buang stream, reset cache, retry
          result.stream?.resume();
          console.log(`[${new Date().toISOString()}] Auth fail (${result.status}), retry #${attempt}`);
          resetJwtCache();
          continue;
        }
        return { status: result.status, data: "", stream: result.stream };
      } else {
        const result = await httpsFetch(url, {
          method: "POST", headers, body: bodyStr,
        });
        if ((result.status === 401 || result.status === 403) && attempt === 1) {
          console.log(`[${new Date().toISOString()}] Auth fail (${result.status}), retry #${attempt}`);
          resetJwtCache();
          continue;
        }
        return { status: result.status, data: result.data };
      }
    } catch (e) {
      if (attempt === 2) return { status: 502, data: JSON.stringify({ error: e.message }) };
      console.log(`[${new Date().toISOString()}] Error, retry #${attempt}: ${e.message}`);
    }
  }
  return { status: 502, data: JSON.stringify({ error: "Upstream call failed after retries" }) };
}

// ─── Anthropic API Conversion ──────────────────────────────────────────────

/**
 * Convert Anthropic request body → OpenAI request body.
 *
 * Anthropic: { model, system?, messages, max_tokens, stream? }
 * OpenAI:    { model, messages: [{role,content}...], max_tokens?, stream? }
 *
 * Key diffs:
 *  - Anthropic system is a top-level field (string or [{type,text}])
 *  - Anthropic messages don't contain system role
 *  - Anthropic max_tokens is required
 */
function convertAnthropicToOpenAI(body) {
  const { model, system, messages, max_tokens, stream, tools, tool_choice, ...rest } = body;

  // Build OpenAI messages array
  const openaiMessages = [];

  // System prompt → first message with role: "system"
  if (system) {
    let systemText;
    if (typeof system === "string") {
      systemText = system;
    } else if (Array.isArray(system)) {
      // Anthropic system can be [{type: "text", text: "..."}, ...]
      systemText = system
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
    } else {
      systemText = String(system);
    }
    openaiMessages.push({ role: "system", content: systemText });
  }

  // Convert messages
  for (const msg of messages || []) {
    const converted = { role: msg.role };

    if (typeof msg.content === "string") {
      converted.content = msg.content;
    } else if (Array.isArray(msg.content)) {
      // Anthropic content blocks → flatten to string
      // [{type: "text", text: "..."}, {type: "tool_use", id, name, input}]
      const textParts = [];
      const toolUseParts = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_result") {
          // Anthropic tool_result → OpenAI tool message
          // Handled separately below
          textParts.push(typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content));
        } else if (block.type === "tool_use") {
          toolUseParts.push(block);
        } else if (block.type === "image") {
          // Pass through as-is for vision models
          textParts.push("[image]");
        }
      }

      if (msg.role === "assistant" && toolUseParts.length > 0) {
        // OpenAI tool_calls format
        converted.content = textParts.join("\n") || null;
        converted.tool_calls = toolUseParts.map((tu) => ({
          id: tu.id,
          type: "function",
          function: {
            name: tu.name,
            arguments: typeof tu.input === "string"
              ? tu.input
              : JSON.stringify(tu.input),
          },
        }));
      } else if (msg.role === "tool") {
        // OpenAI tool result format — pass through
        converted.content = textParts.join("\n");
      } else {
        converted.content = textParts.join("\n");
      }
    }

    openaiMessages.push(converted);
  }

  return {
    model: DEFAULT_MODEL,
    messages: openaiMessages,
    max_tokens: max_tokens || 4096,
    stream: stream !== false,
  };
}

/**
 * Convert OpenAI chat completion response → Anthropic message response.
 *
 * OpenAI:    { id, choices: [{message: {content}, finish_reason}], usage, model }
 * Anthropic: { id, type, role, content: [{type,text}], stop_reason, usage, model }
 */
function convertOpenAIToAnthropicResponse(openaiStr) {
  let openai;
  try {
    openai = typeof openaiStr === "string" ? JSON.parse(openaiStr) : openaiStr;
  } catch {
    return { type: "error", error: { type: "api_error", message: "Failed to parse upstream response" } };
  }

  const choice = openai.choices?.[0];
  const message = choice?.message || {};

  // Convert finish_reason
  const finishMap = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use" };
  const stopReason = finishMap[choice?.finish_reason] || "end_turn";

  // Build content blocks
  const content = [];
  if (message.content) {
    content.push({ type: "text", text: message.content });
  }
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      let input;
      try { input = JSON.parse(tc.function.arguments); } catch { input = tc.function.arguments; }
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
    }
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  return {
    id: openai.id?.replace("chatcmpl-", "msg_") || "msg_" + Date.now().toString(36),
    type: "message",
    role: "assistant",
    content,
    model: DEFAULT_MODEL,
    stop_reason: stopReason,
    usage: {
      input_tokens: openai.usage?.prompt_tokens || 0,
      output_tokens: openai.usage?.completion_tokens || 0,
    },
  };
}

/**
 * Write an SSE event in Anthropic format.
 */
function writeAnthropicSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Convert OpenAI SSE stream → Anthropic SSE stream.
 *
 * Anthropic streaming events:
 *  1. message_start     { type, message: { id, type, role, model, usage } }
 *  2. content_block_start { type, index, content_block: { type: "text", text: "" } }
 *  3. content_block_delta  { type, index, delta: { type: "text_delta", text: "..." } }
 *  4. content_block_stop   { type, index }
 *  5. message_delta      { type, delta: { stop_reason }, usage: { output_tokens } }
 *  6. message_stop       { type }
 */
function convertOpenAIToAnthropicStream(upstreamStream, res, requestId) {
  let started = false;
  let contentStarted = false;
  let buffer = "";
  let outputTokens = 0;
  let inputTokens = 0;
  let modelName = DEFAULT_MODEL;
  let finished = false;

  function finish() {
    if (finished) return;
    finished = true;
    try {
      if (contentStarted) {
        writeAnthropicSSE(res, "content_block_stop", {
          type: "content_block_stop",
          index: 0,
        });
      }
      writeAnthropicSSE(res, "message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: outputTokens },
      });
      writeAnthropicSSE(res, "message_stop", { type: "message_stop" });
      res.end();
    } catch { /* client disconnected */ }
  }

  function processLine(line) {
    if (!line.startsWith("data: ")) return;
    const data = line.slice(6).trim();

    if (data === "[DONE]") {
      finish();
      return;
    }

    let parsed;
    try { parsed = JSON.parse(data); } catch { return; }

    // Extract usage from final chunk if available
    if (parsed.usage) {
      inputTokens = parsed.usage.prompt_tokens || inputTokens;
      outputTokens = parsed.usage.completion_tokens || outputTokens;
    }
    if (parsed.model) modelName = parsed.model;

    const choice = parsed.choices?.[0];
    if (!choice) return;

    // Emit message_start on first chunk
    if (!started) {
      started = true;
      writeAnthropicSSE(res, "message_start", {
        type: "message_start",
        message: {
          id: requestId,
          type: "message",
          role: "assistant",
          content: [],
          model: DEFAULT_MODEL,
          stop_reason: null,
          usage: { input_tokens: inputTokens, output_tokens: 0 },
        },
      });
    }

    const delta = choice.delta || {};

    // Handle reasoning/thinking content (MiMo reasoning_content)
    if (delta.reasoning_content) {
      // MiMo sends reasoning_content — we can emit it as thinking blocks
      // but Anthropic streaming doesn't have a standard thinking block in SSE
      // So we skip reasoning_content for now (or include it as text)
    }

    // Handle text content
    if (delta.content) {
      if (!contentStarted) {
        contentStarted = true;
        writeAnthropicSSE(res, "content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        });
      }
      outputTokens++;
      writeAnthropicSSE(res, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: delta.content },
      });
    }

    // Handle tool calls
    if (delta.tool_calls) {
      // Tool calls in streaming are complex — for now, accumulate and finish
      // This is a simplified handling
    }

    // Check finish_reason
    if (choice.finish_reason) {
      finish();
    }
  }

  upstreamStream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      processLine(line);
    }
  });

  upstreamStream.on("end", () => {
    // Process remaining buffer
    if (buffer.trim()) processLine(buffer.trim());
    finish();
  });

  upstreamStream.on("error", (err) => {
    console.error(`[${new Date().toISOString()}] Upstream stream error:`, err.message);
    finish();
  });
}

/**
 * Handler for Anthropic Messages API: POST /v1/messages
 */
async function handleAnthropicMessages(req, res) {
  if (req.method !== "POST") {
    return sendJSON(res, 405, { error: "Method not allowed. Use POST." });
  }

  // Read body
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return sendJSON(res, 400, { type: "error", error: { type: "invalid_request_error", message: "Invalid JSON body" } });
  }

  const stream = body.stream !== false;
  const sessionId = generateSessionId();
  const requestId = "msg_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // Convert Anthropic → OpenAI
  const openaiBody = convertAnthropicToOpenAI(body);

  // Inject MiMo anti-abuse system marker (required by upstream)
  const transformedBody = injectSystemMarker(openaiBody);
  const bodyStr = JSON.stringify(transformedBody);

  console.log(`[${new Date().toISOString()}] →[Anthropic] ${CHAT_URL} | stream=${stream} | model="${body.model}"→"${DEFAULT_MODEL}" | body=${(bodyStr.length / 1024).toFixed(1)}KB | session=${sessionId}`);

  // Upstream forward — retry 1x for 401/403
  const { status, data, stream: upStream } = await upstreamCall(
    CHAT_URL, req.headers, bodyStr, stream, sessionId
  );

  if (stream) {
    if (upStream) {
      // Write SSE headers
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      // If upstream returned error, send Anthropic error event
      if (status !== 200) {
        let errorBody = "";
        upStream.on("data", (c) => (errorBody += c.toString()));
        upStream.on("end", () => {
          writeAnthropicSSE(res, "message_start", {
            type: "message_start",
            message: {
              id: requestId, type: "message", role: "assistant",
              content: [], model: DEFAULT_MODEL, stop_reason: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          });
          writeAnthropicSSE(res, "content_block_start", {
            type: "content_block_start", index: 0,
            content_block: { type: "text", text: "" },
          });
          writeAnthropicSSE(res, "content_block_delta", {
            type: "content_block_delta", index: 0,
            delta: { type: "text_delta", text: `[Error ${status}] ${errorBody}` },
          });
          writeAnthropicSSE(res, "content_block_stop", {
            type: "content_block_stop", index: 0,
          });
          writeAnthropicSSE(res, "message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 0 },
          });
          writeAnthropicSSE(res, "message_stop", { type: "message_stop" });
          res.end();
        });
        return;
      }

      // Convert upstream OpenAI SSE → Anthropic SSE
      convertOpenAIToAnthropicStream(upStream, res, requestId);
    } else {
      res.writeHead(status || 502, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      writeAnthropicSSE(res, "message_start", {
        type: "message_start",
        message: {
          id: requestId, type: "message", role: "assistant",
          content: [], model: DEFAULT_MODEL, stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      writeAnthropicSSE(res, "content_block_start", {
        type: "content_block_start", index: 0,
        content_block: { type: "text", text: "" },
      });
      writeAnthropicSSE(res, "content_block_delta", {
        type: "content_block_delta", index: 0,
        delta: { type: "text_delta", text: "[Error] Upstream returned no stream" },
      });
      writeAnthropicSSE(res, "content_block_stop", {
        type: "content_block_stop", index: 0,
      });
      writeAnthropicSSE(res, "message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 0 },
      });
      writeAnthropicSSE(res, "message_stop", { type: "message_stop" });
      res.end();
    }
  } else {
    // Non-streaming: convert full response
    if (status !== 200) {
      return sendJSON(res, status, {
        type: "error",
        error: { type: "api_error", message: `Upstream error ${status}: ${data}` },
      });
    }
    const anthropicResp = convertOpenAIToAnthropicResponse(data);
    sendJSON(res, 200, anthropicResp);
  }
}

// ─── Models Listing ────────────────────────────────────────────────────────

function handleModels(req, res) {
  const models = SUPPORTED_MODELS.map((id) => ({
    id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "mimo-gateway",
  }));

  sendJSON(res, 200, {
    object: "list",
    data: models,
  });
}

// ─── Helpers Response ───────────────────────────────────────────────────────

function sendJSON(res, status, data) {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

// ─── HTTP Server ────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Mimo-Source, x-session-affinity",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/health") {
    return sendJSON(res, 200, { status: "ok", jwt_cached: !!cachedJwt });
  }

  if (url.pathname === "/v1/chat/completions" || url.pathname === "/chat") {
    return handleChat(req, res);
  }

  // Model listing — hanya kembalikan model yang didukung gateway
  if (url.pathname === "/v1/models" || url.pathname === "/models") {
    return handleModels(req, res);
  }

// ─── Routing: /v1/messages (Anthropic) ───────────────────────────────────

  if (url.pathname === "/v1/messages" || url.pathname === "/messages") {
    return handleAnthropicMessages(req, res);
  }

  sendJSON(res, 404, { error: "Not found. Use POST /v1/chat/completions or /v1/messages" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║           MiMo Free Gateway — running               ║
╠══════════════════════════════════════════════════════╣
║  Listen  : 0.0.0.0:${String(PORT).padEnd(5)}                         ║
║  Chat    : POST /v1/chat/completions   (OpenAI)     ║
║  Chat    : POST /v1/messages           (Anthropic)  ║
║  Health  : GET  /health                             ║
║                                                     ║
║  Upstream: ${CHAT_URL}  ║
║                                                     ║
║  Agent CLI config:                                  ║
║    providers.mimo-free.baseUrl =                    ║
║      http://<IP_KAMU>:${String(PORT).padEnd(5)}/v1/chat/completions     ║
╚══════════════════════════════════════════════════════╝
`);
});

process.on("SIGINT", () => { resetJwtCache(); server.close(() => process.exit(0)); });
process.on("SIGTERM", () => server.close(() => process.exit(0)));
