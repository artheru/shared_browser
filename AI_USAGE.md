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
  - keyboard
  - paste
  - viewClipboard
   - tabs_list / tabs_select / tabs_new / tabs_close
   - start_video_recording / list_recorded_videos / fetch_video
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
- `POST /api/mcp/everything/keyboard`
- `POST /api/mcp/everything/paste`
- `GET  /api/mcp/everything/clipboard/view`
- `GET  /api/mcp/everything/tabs`
- `POST /api/mcp/everything/tabs/select`
- `POST /api/mcp/everything/tabs/new`
- `POST /api/mcp/everything/tabs/close`
- `POST /api/mcp/everything/video/start`
- `GET  /api/mcp/everything/video/list`
- `GET  /api/mcp/everything/video/<fileId>`
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

### 6.4 Keyboard input / shortcuts

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

Shortcut example (PageDown):

```json
{
  "shortcut": "pgdn"
}
```

### 6.5 Evaluate JS

```json
{
  "script": "document.title"
}
```

### 6.8 Paste and viewClipboard

Paste large text:

```json
{
  "text": "very long text..."
}
```

Paste image/file (base64):

```json
{
  "files": [
    {
      "name": "sample.png",
      "mimeType": "image/png",
      "contentBase64": "<base64>"
    }
  ]
}
```

View browser clipboard:

```bash
curl -s "http://192.168.0.190:3000/api/mcp/<browserId>/clipboard/view" \
  -H "Authorization: Bearer <token>"
```

### 6.6 Tab operations

List tabs:

```bash
curl -s "http://192.168.0.190:3000/api/mcp/<browserId>/tabs" \
  -H "Authorization: Bearer <token>"
```

Select tab:

```json
{
  "tabIndex": 1
}
```

New tab (optional URL):

```json
{
  "url": "https://example.com"
}
```

Close tab:

```json
{
  "tabIndex": 1
}
```

### 6.7 Video recording (AI)

Start recording (blocking call; returns only after MP4 is ready):

```json
{
  "durationSec": 8
}
```

Rules:

- `durationSec` is required.
- Hard cap is 15 seconds.
- Admin can lower cap via `params.json` -> `recording.maxDurationSec`.

List available recordings:

```bash
curl -s "http://192.168.0.190:3000/api/mcp/<browserId>/video/list" \
  -H "Authorization: Bearer <token>"
```

Fetch MP4:

```bash
curl -L "http://192.168.0.190:3000/api/mcp/<browserId>/video/<fileId>" \
  -H "Authorization: Bearer <token>" \
  -o record.mp4
```

Retention:

- Keeps latest `10` recordings by default.
- Admin can tune via `params.json` -> `recording.maxSavedFiles`.
- Older files are auto-pruned.

## 7. Reliable Action Loop (Important)

Use this loop for every UI action:

1. `screenshot` to capture current state.
2. `dev/html` or `dev/eval` to locate target element/selector.
3. Perform one action (`pointer` or `keyboard`).
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
