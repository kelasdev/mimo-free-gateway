# MiMo Free Gateway

**Proxy gateway** untuk **MiMo Free API** — memungkinkan agent CLI (seperti [pi](https://github.com/earendil-works/pi-coding-agent)) menggunakan endpoint gratis MiMo tanpa repot urusan JWT, fingerprint, atau anti-abuse marker.

Cukup arahkan `baseUrl` agent CLI ke gateway ini, dan gateway akan menangani:

- ✅ **Model override** — model apapun dari client (`gpt-4`, `claude-3`, dsb.) di-override otomatis ke `mimo-auto`
- ✅ **Dual API format** — dukung OpenAI (`/v1/chat/completions`) **dan** Anthropic (`/v1/messages`)
- ✅ **Request/response conversion** — Anthropic ↔ OpenAI otomatis, termasuk streaming SSE
- ✅ **Model listing** — endpoint `/v1/models` hanya mengembalikan model yang didukung gateway
- ✅ **Bootstrap JWT** — otomatis dari API MiMo
- ✅ **Device fingerprint** — dari hardware signature mesin gateway
- ✅ **Anti-abuse system marker** — auto-inject ke setiap request
- ✅ **Session affinity** — generate `x-session-affinity` per request
- ✅ **Forward header client** — `User-Agent`, `Origin`, `Cookie`, `X-Mimo-*`, dll
- ✅ **Streaming SSE** — proxy langsung (OpenAI) atau konversi ke format Anthropic
- ✅ **Auth retry** — jika 401/403, reset cache + retry 1x
- ✅ **CORS** — support preflight, origin bebas

**Zero dependencies** — hanya pakai built-in Node.js (`http`, `https`, `crypto`, `os`).

---

## Cara Pakai

### 1. Jalankan Gateway

```bash
cd mimo
node gateway.js
```

Output:

```
╔══════════════════════════════════════════════════════╗
║           MiMo Free Gateway — running               ║
╠══════════════════════════════════════════════════════╣
║  Listen  : 0.0.0.0:3000                             ║
║  Chat    : POST /v1/chat/completions   (OpenAI)     ║
║  Chat    : POST /v1/messages           (Anthropic)  ║
║  Models  : GET  /v1/models                          ║
║  Health  : GET  /health                             ║
║                                                     ║
║  Upstream: https://api.xiaomimimo.com/.../openai/chat║
╚══════════════════════════════════════════════════════╝
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

## Endpoint

| Method | Path | Format | Deskripsi |
|--------|------|--------|-----------|
| `POST` | `/v1/chat/completions` | OpenAI | Chat completion (request & response) |
| `POST` | `/chat` | OpenAI | Alternatif path yang sama |
| `POST` | `/v1/messages` | Anthropic | Messages API (request & response) |
| `POST` | `/messages` | Anthropic | Alternatif path yang sama |
| `GET`  | `/v1/models` | OpenAI | Daftar model yang didukung |
| `GET`  | `/models` | OpenAI | Alternatif path yang sama |
| `GET`  | `/health` | - | Health check + status JWT cache |
| `OPTIONS` | `/*` | - | CORS preflight |

---

## Request / Response

### OpenAI Format — `POST /v1/chat/completions`

**Request:**

```json
{
  "model": "gpt-4",          ← di-override ke "mimo-auto"
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
| `stream` | `boolean` | `true` | `true` → SSE stream, `false` → JSON |
| `model` | `string` | - | **Selalu di-override** ke `mimo-auto` |
| `max_tokens` | `number` | - | Maksimal token output |

---

### Anthropic Format — `POST /v1/messages`

**Request:**

```json
{
  "model": "claude-3-opus",  ← di-override ke "mimo-auto"
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
    {
      "type": "text",
      "text": "Halo! Ada yang bisa dibantu?"
    }
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
| `stream` | `boolean` | `true` | `true` → SSE stream, `false` → JSON |
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

```bash
node gateway.js                           # port 3000
node gateway.js --port 9090               # custom port
PORT=9090 node gateway.js                 # via env
CHAT_URL="https://..." node gateway.js    # custom upstream
```

Environment variables:

| Variable | Default | Deskripsi |
|----------|---------|-----------|
| `PORT` | `3000` | Port listen |
| `CHAT_URL` | `https://api.xiaomimimo.com/api/free-ai/openai/chat` | Upstream MiMo chat endpoint |

---

## Arsitektur

```
┌──────────────┐     POST /v1/chat/completions     ┌──────────────────┐
│  Agent CLI   │ ─────────────────────────────────→ │  Gateway-mu      │
│  (pi / dll)  │     POST /v1/messages              │  0.0.0.0:3000   │
│              │    (OpenAI atau Anthropic format)   │                  │
└──────────────┘                                    └────────┬─────────┘
       ↑                                                     │
       │   SSE stream / JSON                                 │
       └─────────────────────────────────────────────────────┘
                                                            │
                                ┌────────────────────────────┘
                                ↓
                    ┌─────────────────────────────────────────────────────┐
                    │  0. Model override                                 │
                    │     model apapun dari client → "mimo-auto"         │
                    └─────────────────────────────────────────────────────┘
                                ↓
                    ┌─────────────────────────────────────────────────────┐
                    │  0a. Jika Anthropic request → konversi ke OpenAI   │
                    │      system → role:system, content blocks → string  │
                    │      stop_reason, usage → mapping                  │
                    └─────────────────────────────────────────────────────┘
                                ↓
                    ┌─────────────────────────────────────┐
                    │  1. Bootstrap JWT dari MiMo         │
                    │     POST /api/free-ai/bootstrap     │
                    │     { client: <fingerprint> }       │
                    │     → JWT (cache ~50 menit)         │
                    └──────────┬──────────────────────────┘
                               ↓
                    ┌─────────────────────────────────────┐
                    │  2. Inject system marker            │
                    │     "You are MiMoCode..."           │
                    │     → sisipkan ke messages[]        │
                    └──────────┬──────────────────────────┘
                               ↓
                    ┌──────────────────────────────────────────────┐
                    │  3. Forward ke MiMo Chat API                │
                    │     POST /api/free-ai/openai/chat           │
                    │     Authorization: Bearer <jwt>             │
                    │     X-Mimo-Source: mimocode-cli-free        │
                    │     x-session-affinity: ses_<random>        │
                    │     + forward headers dari client asli      │
                    └──────────┬──────────────────────────────────┘
                               ↓
                    ┌──────────────────────────────────────────────┐
                    │  3a. Jika Anthropic & streaming →            │
                    │     Konversi SSE OpenAI → Anthropic          │
                    │     message_start, content_block_delta, dll. │
                    └──────────────────────────────────────────────┘
                               ↓
                    ┌──────────────────────────────────────────────┐
                    │  4. Jika 401/403                           │
                    │     → reset JWT cache                      │
                    │     → bootstrap ulang                      │
                    │     → retry 1x                             │
                    └──────────────────────────────────────────────┘
```

---

## Konversi Format (OpenAI ↔ Anthropic)

Gateway melakukan konversi otomatis antara kedua format. Detail:

### Request: Anthropic → OpenAI

| Anthropic | OpenAI |
|-----------|--------|
| `system` (top-level string) | `messages[0].role: "system"` |
| `content: [{type:"text", text:"..."}]` | `content: "..."` (string) |
| `content: [{type:"tool_use", id, name, input}]` | `tool_calls: [{id, type:"function", function:{name, arguments}}]` |
| `role: "tool"` + `tool_use_id` | `role: "tool"` + `tool_call_id` |
| `max_tokens` (required) | `max_tokens` (optional) |

### Response: OpenAI → Anthropic (non-stream)

| OpenAI | Anthropic |
|--------|-----------|
| `choices[0].message.content` | `content: [{type:"text", text:"..."}]` |
| `finish_reason: "stop"` | `stop_reason: "end_turn"` |
| `finish_reason: "length"` | `stop_reason: "max_tokens"` |
| `usage.prompt_tokens` | `usage.input_tokens` |
| `usage.completion_tokens` | `usage.output_tokens` |

### Streaming: OpenAI SSE → Anthropic SSE

| OpenAI event | Anthropic event |
|-------------|-----------------|
| `data: {choices:[{delta:{content:"..."}}]}` | `content_block_delta {delta:{type:"text_delta", text:"..."}}` |
| `data: {choices:[{finish_reason:"stop"}]}` | `message_delta {delta:{stop_reason:"end_turn"}}` |
| `data: [DONE]` | `content_block_stop` + `message_stop` |

---

## File Structure

```
mimo/
├── gateway.js        # ← Gateway server (utama)
├── mimo-free.js      # ← Executor asli (referensi)
├── package.json      # Config Node.js (type: module)
└── README.md         # ← File ini
```

---

## Catatan

- **Model override**: Semua request, apapun model yang dikirim client (`gpt-4`, `claude-3-opus`, `mimo-v2.5-free`, dsb.), akan di-override ke `mimo-auto` — satu-satunya model yang didukung upstream.
- **JWT di-cache in-memory** selama ~50 menit (TTL 3000 detik, buffer 5 menit). Restart gateway → cache reset → bootstrap ulang.
- **Fingerprint** dibuat dari gabungan `hostname | platform | arch | cpu | username` mesin tempat gateway jalan.
- Gateway **forward header dari client asli** (`User-Agent`, `Origin`, `Cookie`, `X-Mimo-*`, dll) ke upstream.
- Gateway **tidak menyimpan log chat** — hanya forward request.
- Untuk production, jalankan di belakang **nginx** atau **PM2**.
