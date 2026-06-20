# MiMo Free Gateway

**Proxy gateway** untuk **MiMo Free API** — memungkinkan agent CLI (seperti [pi](https://github.com/earendil-works/pi-coding-agent)) menggunakan endpoint gratis MiMo tanpa repot urusan JWT, fingerprint, atau anti-abuse marker.

Cukup arahkan `baseUrl` agent CLI ke gateway ini, dan gateway akan menangani:

- **Model override** — model apapun dari client di-override otomatis ke `mimo-auto`
- **Dual API format** — dukung OpenAI (`/v1/chat/completions`) **dan** Anthropic (`/v1/messages`)
- **Request/response conversion** — Anthropic <-> OpenAI otomatis, termasuk streaming SSE
- **Model listing** — endpoint `/v1/models` hanya mengembalikan model yang didukung gateway
- **Bootstrap JWT** — otomatis dari API MiMo
- **Device fingerprint** — dari hardware signature mesin gateway
- **Anti-abuse system marker** — auto-inject ke setiap request
- **Session affinity** — generate `x-session-affinity` per request
- **Forward header client** — `User-Agent`, `Origin`, `Cookie`, `X-Mimo-*`, dll
- **Streaming SSE** — proxy langsung (OpenAI) atau konversi ke format Anthropic
- **Auth retry** — jika 401/403, reset cache + retry 1x
- **CORS** — support preflight, origin bebas
- **Proxy rotation** — auto-rotate SOCKS4/5, HTTP/S via proxy list (baca dari file)
- **Auto-blacklist** — proxy yang gagal otomatis masuk `blacklist.txt`
- **Stats & monitoring** — login/logout log, token usage, totals

**Zero dependencies** — hanya pakai built-in Node.js (`http`, `https`, `crypto`, `os`, `net`, `tls`, `dns`).

---

## Cara Pakai

### 1. Jalankan Gateway

```bash
cd mimo
node gateway.js
```

Output:

```
MiMo Free Gateway — running
──────────────────────────────────────────────────
  Listen   : 0.0.0.0:3000
  Chat     : POST /v1/chat/completions  (OpenAI)
  Messages : POST /v1/messages          (Anthropic)
  Health   : GET  /health
  Stats    : GET  /stats
──────────────────────────────────────────────────
  Upstream : https://api.xiaomimimo.com/api/free-ai/openai/chat
  Proxies  : 53 active
  Config   : providers.mimo-free.baseUrl = http://<IP_KAMU>:3000/v1/chat/completions
```

### 2. Arahkan Agent CLI

#### OpenAI-compatible (`/v1/chat/completions`)

```json
{
  "providers": {
    "mimo-free": {
      "baseUrl": "http://<IP_GATEWAY>:3000/v1/chat/completions"
    }
  }
}
```

#### Anthropic-compatible (`/v1/messages`)

```json
{
  "providers": {
    "mimo-free": {
      "baseUrl": "http://<IP_GATEWAY>:3000/v1/messages"
    }
  }
}
```

Selesai. Agent CLI tinggal kirim chat seperti biasa, gateway yang urus auth & konversi format.

---

### 3. Setting Custom Provider di Claude Code

Gateway ini kompatibel penuh dengan **Claude Code** (CLI resmi Anthropic) melalui fitur custom provider.

#### Langkah-langkah

**a. Buka file konfigurasi Claude Code**

```bash
# Linux / macOS
~/.claude/settings.json

# Windows
%APPDATA%\Claude\settings.json
# atau
C:\Users\<username>\.claude\settings.json
```

**b. Tambahkan custom provider**

```json
{
  "customProviders": [
    {
      "name": "mimo-free",
      "apiBase": "http://localhost:3000",
      "apiKeyVariable": "MIMO_API_KEY"
    }
  ]
}
```

> `MIMO_API_KEY` bisa diisi nilai apapun (gateway tidak memvalidasinya), misalnya `"dummy"`.

**c. Set environment variable API key**

```bash
# Linux / macOS
export MIMO_API_KEY=dummy

# Windows (Command Prompt)
set MIMO_API_KEY=dummy

# Windows (PowerShell)
$env:MIMO_API_KEY = "dummy"
```

**d. Jalankan Claude Code dengan provider tersebut**

```bash
claude --provider mimo-free
```

Atau set sebagai default di `settings.json`:

```json
{
  "defaultProvider": "mimo-free",
  "customProviders": [
    {
      "name": "mimo-free",
      "apiBase": "http://localhost:3000",
      "apiKeyVariable": "MIMO_API_KEY"
    }
  ]
}
```

#### Catatan

- `apiBase` menunjuk ke root gateway (`http://localhost:3000`) — Claude Code akan append `/v1/messages` otomatis sesuai format Anthropic.
- Ganti `localhost` dengan IP mesin gateway jika dijalankan di server/komputer lain.
- Gateway akan override model apapun ke `mimo-auto`, termasuk model yang dipilih Claude Code.

---

## Proxy Rotation

Gateway mendukung **auto-rotation proxy** untuk bypass rate limit / geo-blocking dari MiMo API.

### Format File Proxy

Buat file `live.txt` atau `proxies.txt` di root project. Satu baris per proxy:

```
# SOCKS5
socks5://host:port
socks5://user:pass@host:port

# SOCKS4
socks4://host:port

# HTTP/HTTPS proxy (CONNECT tunnel)
http://host:port
https://user:pass@host:port

# Tanpa prefix (default HTTP)
host:port
```

### Cara Kerja

1. **Startup** — baca semua proxy dari `live.txt` / `proxies.txt`
2. **Bootstrap JWT** — coba proxy pertama, jika 403/error → auto-rotate ke proxy berikutnya
3. **Chat/Stream** — semua request lewat proxy aktif
4. **Blacklist** — proxy yang gagal otomatis ditulis ke `blacklist.txt`, tidak dipakai lagi
5. **Reload** — `GET /proxy/reload` untuk reload proxy tanpa restart gateway

### Contoh

```bash
# Jalankan gateway (proxy otomatis dibaca dari live.txt)
node gateway.js

# Atau custom port
node gateway.js --port 9090
```

---

## Endpoint

| Method | Path | Format | Deskripsi |
|--------|------|--------|-----------|
| `POST` | `/v1/chat/completions` | OpenAI | Chat completion (request & response) |
| `POST` | `/chat` | OpenAI | Alternatif path yang sama |
| `POST` | `/v1/messages` | Anthropic | Messages API (request & response) |
| `POST` | `/messages` | Anthropic | Alternatif path yang sama |
| `GET`  | `/v1/models` | OpenAI | Daftar model yang didukung |
| `GET`  | `/models` | OpenAI | Alternatif path yang sama |
| `GET`  | `/health` | - | Health check + summary |
| `GET`  | `/stats` | - | Detail: auth log, token usage, totals |
| `GET`  | `/proxy/reload` | - | Reload proxy list tanpa restart |
| `OPTIONS` | `/*` | - | CORS preflight |

---

## Stats & Monitoring

### `GET /health`

Ringkasan cepat:

```json
{
  "status": "ok",
  "uptime": 3600,
  "jwt_cached": true,
  "total_requests": 150,
  "success": 145,
  "failed": 5,
  "tokens": { "input": 12500, "output": 8300, "total": 20800 }
}
```

### `GET /stats`

Detail lengkap dengan login/logout log dan totals:

```json
{
  "gateway": {
    "status": "ok",
    "port": 3000,
    "upstream": "https://api.xiaomimimo.com/...",
    "startedAt": "2026-06-19T07:07:43.238Z",
    "uptime": "1h 23m 45s",
    "proxy": { "protocol": "socks5", "host": "47.79.79.35", "port": 10808 },
    "proxyCount": 45
  },
  "requests": {
    "total": 150,
    "success": 145,
    "failed": 5,
    "retried": 2,
    "stream": 120,
    "nonStream": 30,
    "openai": 100,
    "anthropic": 50
  },
  "tokens": {
    "input": 12500,
    "output": 8300,
    "total": 20800
  },
  "duration": {
    "avg": 1234,
    "min": 200,
    "max": 5678,
    "total": 185100
  },
  "authLog": [
    { "type": "LOGIN", "time": "2026-06-19T...", "detail": "JWT obtained via socks5://47.79.79.35:10808" },
    { "type": "LOGOUT", "time": "2026-06-19T...", "detail": "Bootstrap HTTP 403 via socks5://103.77.242.91:1" }
  ],
  "recent": [
    { "time": "2026-06-19T...", "status": 200, "model": "mimo-auto", "stream": true, "inputTokens": 37, "outputTokens": 19, "durationMs": 1200 }
  ],
  "totals": {
    "total_requests": 150,
    "total_tokens": 20800,
    "total_input_tokens": 12500,
    "total_output_tokens": 8300,
    "total_duration_ms": 185100,
    "uptime_seconds": 5025,
    "login_events": 3,
    "logout_events": 1,
    "avg_duration_ms": 1234
  }
}
```

### `GET /proxy/reload`

Reload proxy list dari file tanpa restart:

```json
{ "message": "Proxies reloaded", "active": 45 }
```

---

## Request / Response

### OpenAI Format — `POST /v1/chat/completions`

**Request:**

```json
{
  "model": "gpt-4",          // di-override ke "mimo-auto"
  "messages": [
    { "role": "system", "content": "Kamu asisten helpful." },
    { "role": "user", "content": "Halo!" }
  ],
  "stream": true
}
```

**Response (non-stream):**

```json
{
  "id": "9a46e90c50fe4aa2aa914a29dbe72f97",
  "choices": [{
    "finish_reason": "stop",
    "index": 0,
    "message": {
      "content": "Halo! Ada yang bisa dibantu?",
      "role": "assistant",
      "tool_calls": null
    }
  }],
  "model": "mimo-auto",
  "object": "chat.completion",
  "usage": {
    "completion_tokens": 19,
    "prompt_tokens": 37,
    "total_tokens": 56
  }
}
```

**Response (stream):** `text/event-stream` — OpenAI SSE chunks.

| Parameter | Tipe | Default | Keterangan |
|-----------|------|---------|------------|
| `messages` | `array` | **required** | Array pesan (system/user/assistant/tool) |
| `stream` | `boolean` | `true` | `true` -> SSE stream, `false` -> JSON |
| `model` | `string` | - | **Selalu di-override** ke `mimo-auto` |
| `max_tokens` | `number` | - | Maksimal token output |

---

### Anthropic Format — `POST /v1/messages`

**Request:**

```json
{
  "model": "claude-3-opus",  // di-override ke "mimo-auto"
  "system": "Kamu asisten helpful.",
  "messages": [
    { "role": "user", "content": "Halo!" }
  ],
  "max_tokens": 1024,
  "stream": true
}
```

**Response (non-stream):**

```json
{
  "id": "msg_9a46e90c50fe4aa2",
  "type": "message",
  "role": "assistant",
  "content": [
    { "type": "text", "text": "Halo! Ada yang bisa dibantu?" }
  ],
  "model": "mimo-auto",
  "stop_reason": "end_turn",
  "usage": {
    "input_tokens": 37,
    "output_tokens": 19
  }
}
```

**Response (stream):** `text/event-stream` — Anthropic SSE events:

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_xxx","type":"message","role":"assistant","content":[],"model":"mimo-auto","stop_reason":null,"usage":{"input_tokens":0,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Halo!"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}

event: message_stop
data: {"type":"message_stop"}
```

| Parameter | Tipe | Default | Keterangan |
|-----------|------|---------|------------|
| `messages` | `array` | **required** | Array pesan (user/assistant) |
| `system` | `string` or `array` | - | System prompt (diubah jadi `role:system`) |
| `max_tokens` | `number` | **required** | Maksimal token output |
| `stream` | `boolean` | `true` | `true` -> SSE stream, `false` -> JSON |
| `model` | `string` | - | **Selalu di-override** ke `mimo-auto` |

---

### Model Listing — `GET /v1/models`

```json
{
  "object": "list",
  "data": [
    {
      "id": "mimo-auto",
      "object": "model",
      "created": 1712345678,
      "owned_by": "mimo-gateway"
    }
  ]
}
```

Hanya mengembalikan model yang benar-benar didukung gateway (`mimo-auto`).

---

## Opsi

### Gateway

```bash
node gateway.js                           # port 3000, default upstream
node gateway.js --port 9090               # custom port
node gateway.js --chat-url "https://..."  # custom upstream endpoint
node gateway.js --proxy proxies.txt       # custom proxy list file
node gateway.js --help                    # tampilkan semua opsi
PORT=9090 node gateway.js                 # via env
CHAT_URL="https://..." node gateway.js    # custom upstream via env
```

| Flag | Env | Default | Deskripsi |
|------|-----|---------|-----------|
| `--port` | `PORT` | `3000` | Port listen |
| `--chat-url` | `CHAT_URL` | `https://api.xiaomimimo.com/api/free-ai/openai/chat` | Upstream MiMo chat endpoint |
| `--proxy` | - | _(auto-detect live.txt/proxies.txt)_ | Custom proxy list file |
| `--help` | - | - | Tampilkan usage dan exit |

### Proxy Checker

```bash
node proxy-checker.js                          # defaults
node proxy-checker.js --file proxies.txt       # custom file
node proxy-checker.js --timeout 5000           # faster timeout
node proxy-checker.js --json --no-output       # JSON output, no file write
node proxy-checker.js --help                   # tampilkan semua opsi
```

---

## Arsitektur

```
Agent CLI (pi / dll)
    |
    | POST /v1/chat/completions  atau  POST /v1/messages
    v
Gateway (0.0.0.0:3000)
    |
    |-- [1] Model override: model apapun -> "mimo-auto"
    |-- [2] Anthropic -> OpenAI conversion (jika perlu)
    |-- [3] Bootstrap JWT via proxy manager
    |       |
    |       |-- Coba proxy pertama dari live.txt
    |       |-- 403/error? blacklist + rotate ke proxy berikutnya
    |       |-- Semua gagal? "all proxies exhausted"
    |       |-- Work? cache JWT ~50 menit
    |
    |-- [4] Inject system marker: "You are MiMoCode..."
    |-- [5] Forward ke MiMo API via proxy
    |       Authorization: Bearer <JWT>
    |       X-Mimo-Source: mimocode-cli-free
    |       x-session-affinity: ses_<random>
    |
    |-- [6] Jika Anthropic streaming: konversi SSE OpenAI -> Anthropic
    |-- [7] Jika 401/403: blacklist proxy + rotate + retry
    |
    v
Response ke Agent CLI (SSE stream atau JSON)
```

---

## Konversi Format (OpenAI <-> Anthropic)

Gateway melakukan konversi otomatis antara kedua format. Detail:

### Request: Anthropic -> OpenAI

| Anthropic | OpenAI |
|-----------|--------|
| `system` (top-level string) | `messages[0].role: "system"` |
| `content: [{type:"text", text:"..."}]` | `content: "..."` (string) |
| `content: [{type:"tool_use", id, name, input}]` | `tool_calls: [{id, type:"function", function:{name, arguments}}]` |
| `role: "tool"` + `tool_use_id` | `role: "tool"` + `tool_call_id` |
| `max_tokens` (required) | `max_tokens` (optional) |

### Response: OpenAI -> Anthropic (non-stream)

| OpenAI | Anthropic |
|--------|-----------|
| `choices[0].message.content` | `content: [{type:"text", text:"..."}]` |
| `finish_reason: "stop"` | `stop_reason: "end_turn"` |
| `finish_reason: "length"` | `stop_reason: "max_tokens"` |
| `usage.prompt_tokens` | `usage.input_tokens` |
| `usage.completion_tokens` | `usage.output_tokens` |

### Streaming: OpenAI SSE -> Anthropic SSE

| OpenAI event | Anthropic event |
|-------------|-----------------|
| `data: {choices:[{delta:{content:"..."}}]}` | `content_block_delta {delta:{type:"text_delta", text:"..."}}` |
| `data: {choices:[{finish_reason:"stop"}]}` | `message_delta {delta:{stop_reason:"end_turn"}}` |
| `data: [DONE]` | `content_block_stop` + `message_stop` |

---

## File Structure

```
mimo/
├── args.js            # Shared CLI argument parser
├── gateway.js         # Gateway server (utama)
├── proxy-manager.js   # Proxy rotation manager
├── proxy-checker.js   # Proxy validator & public IP checker
├── package.json       # Config Node.js (type: module)
├── live.txt           # Daftar proxy aktif (SOCKS5/HTTP)
├── blacklist.txt      # Auto-generated: proxy yang gagal
└── README.md          # File ini
```

---

## CLI Argument Helper (`args.js`)

Modul shared untuk parsing CLI arguments — dipakai `gateway.js` dan `proxy-checker.js`.

```js
import { getArg, getArgEnv, getIntArgEnv, hasFlag, printUsage } from "./args.js";

// String arg: --name value
const file = getArg("--file", "live.txt");

// String with env fallback: --name > ENV > default
const port = getArgEnv("--port", "PORT", 3000);

// Integer with env fallback
const timeout = getIntArgEnv("--timeout", "TIMEOUT", 10000);

// Boolean flag: --verbose (true if present)
const verbose = hasFlag("--verbose");

// Auto-generate --help output
printUsage("My Tool", [
  { name: "--port", type: "int", default: 3000, description: "Port listen" },
], "node tool.js [options]");
```

Fungsi tersedia:

| Fungsi | Deskripsi |
|--------|-----------|
| `getArg(name, fallback)` | String arg: `--name value` |
| `getArgEnv(name, env, fallback)` | String with env fallback |
| `getIntArg(name, fallback)` | Integer arg |
| `getIntArgEnv(name, env, fallback)` | Integer with env fallback |
| `hasFlag(name)` | Boolean flag presence check |
| `hasNegatableFlag(name, default)` | `--no-X` vs `--X` toggle |
| `getBoolArg(name, fallback)` | Boolean from `true/false/1/0` string |
| `printUsage(title, options, example)` | Auto-generate help text |
| `buildConfig(defs)` | Build config object from definitions |

---

## Catatan

- **Model override**: Semua request, apapun model yang dikirim client, di-override ke `mimo-auto`.
- **JWT di-cache in-memory** selama ~50 menit. Restart gateway -> cache reset -> bootstrap ulang.
- **Fingerprint** dibuat dari gabungan `hostname | platform | arch | cpu | username` mesin tempat gateway jalan.
- **Proxy rotation**: gateway coba semua proxy secara berurutan. Proxy yang gagal (403/error) masuk `blacklist.txt` otomatis.
- **Zero restart**: tambah proxy baru ke `live.txt`, lalu `GET /proxy/reload` — gateway langsung pakai.
- Gateway **forward header dari client asli** ke upstream.
- Gateway **tidak menyimpan log chat** — hanya forward request.
- Untuk production, jalankan di belakang **nginx** atau **PM2**.
