# Shared Browser AI Usage

This document is a practical guide for AI agents to operate Shared Browser through WebAPI/MCP endpoints.

## 1. Scope and Entry

- Service URL: `http://<host>:3000`
- Auth endpoint: `POST /api/auth/login`
- Browser list endpoint: `GET /api/browsers`
- MCP help endpoint: `GET /api/mcp/help`
- MCP route prefix (default): `/api/mcp`

All protected endpoints require:

- `Authorization: Bearer <token>`

## 2. Minimal Workflow

1. Login and get token.
2. Read available browser IDs from `/api/browsers`.
3. Pick a browser with `mcpEnabled` or `webApiEnabled`.
4. Use MCP/WebAPI tools to inspect and operate pages:
   - screenshot
   - pointer
   - input
   - dev_html
   - dev_console
   - dev_eval
5. Verify result by screenshot + HTML/eval checks.

## 3. Login and Token

```bash
curl -s -X POST "http://192.168.0.190:3000/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"artheru\",\"password\":\"zoku6_KR\"}"
```

Expected response:

```json
{
  "token": "<jwt>",
  "user": {
    "id": "2",
    "username": "artheru",
    "isAdmin": false
  }
}
```

## 4. Discover Browser and Tool Status

```bash
curl -s "http://192.168.0.190:3000/api/browsers" \
  -H "Authorization: Bearer <token>"
```

Optional (tool matrix for one browser):

```bash
curl -s "http://192.168.0.190:3000/api/browsers/<browserId>/tools-status" \
  -H "Authorization: Bearer <token>"
```

## 5. Tool Endpoints

For browser `everything`, route pattern is:

- `POST /api/mcp/everything/screenshot`
- `POST /api/mcp/everything/pointer`
- `POST /api/mcp/everything/input`
- `GET  /api/mcp/everything/dev/html`
- `GET  /api/mcp/everything/dev/console`
- `POST /api/mcp/everything/dev/eval`

Common headers:

- `Authorization: Bearer <token>`
- `Content-Type: application/json`

## 6. Typical Payloads

### 6.1 Screenshot

```bash
curl -s -X POST "http://192.168.0.190:3000/api/mcp/<browserId>/screenshot" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d "{}"
```

Returns `imageBase64`, `url`, `title`, `dialogs`, `source`.

### 6.2 Pointer click by coordinates

```json
{
  "start": { "x": 500, "y": 300 },
  "end": { "x": 500, "y": 300 },
  "clickAtEnd": true,
  "button": "left"
}
```

### 6.3 Pointer click by selector center

```json
{
  "startSelector": "button[type='submit']",
  "endSelector": "button[type='submit']",
  "clickAtEnd": true,
  "button": "left"
}
```

### 6.4 Input text

```json
{
  "selector": "input[name='username']",
  "clearBefore": true,
  "text": "artheru"
}
```

Press Enter at end:

```json
{
  "text": "hello world",
  "pressEnter": true
}
```

### 6.5 Evaluate JS

```json
{
  "script": "document.title"
}
```

## 7. Reliable Action Loop (Important)

Use this loop for every UI action:

1. `screenshot` to capture current state.
2. `dev/html` or `dev/eval` to locate target element/selector.
3. Perform one action (`pointer` or `input`).
4. Wait briefly (200ms-1500ms).
5. `screenshot` + `dev/eval` to confirm effect.
6. If failed, retry with adjusted selector or coordinates.

Avoid issuing many blind actions in batch.

## 8. Troubleshooting

- `401 Invalid authentication token`: login again, refresh JWT.
- `403 MCP/WebAPI disabled for this browser`: ask admin to enable at browser config.
- `403 API disabled for tool: xxx`: tool-level API access is off.
- `404 Browser not found`: check real `browserId` from `/api/browsers`.
- `No active page for browser`: open/activate tab via web UI first, or reconnect session.

## 9. Notes for Automation Tasks

- Prefer selector-based operations first; fallback to coordinates only when needed.
- Keep operation logs (`/api/mcp/calls`) for traceability.
- For long tasks, periodically verify page URL/title via `dev/eval`.
- If page logic is complex, combine:
  - `dev/html` for structure
  - `dev/console` for runtime errors
  - `dev/eval` for exact state assertions

## 10. Security Notes

- Do not print raw credentials in shared logs.
- Do not persist JWT tokens in repo files.
- Use least-privilege account when possible.
