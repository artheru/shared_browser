# Shared Browser API Reference

Human-oriented API document for manual testing with `curl`/Postman.

## 1) Base URL and Auth

- Base URL: `http://<host>:3000`
- Browser MCP/API route prefix: `/api/mcp/:browserId/*`

Two auth modes are supported for `/api/mcp/:browserId/*`:

1. JWT login token (user login)
2. Browser API token (8 chars, browser-scoped)

### 1.1 Get JWT

```bash
curl -s -X POST "http://<host>:3000/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'
```

### 1.2 Get browser token

```bash
# Use JWT in Authorization first
curl -s "http://<host>:3000/api/browsers/test/access-token" \
  -H "Authorization: Bearer <jwt>"
```

Response contains `apiToken` (8 chars).

---

## 2) Core Tool Endpoints (WebAPI)

All examples below use:

```bash
-H "Authorization: Bearer <token>"
-H "Content-Type: application/json"
```

### 2.1 Screenshot

```bash
curl -s -X POST "http://<host>:3000/api/mcp/test/screenshot" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"useLiveFrame":true}'
```

### 2.2 Pointer

Recommended explicit form:

```json
{
  "start": { "x": 113, "y": 142 },
  "end": { "x": 113, "y": 142 },
  "clickAtEnd": true,
  "button": "left"
}
```

Compatibility shorthand is also supported:

```json
{
  "x": 113,
  "y": 142,
  "clickAtEnd": true
}
```

### 2.3 Keyboard

```json
{ "key": "Tab" }
```

or

```json
{ "shortcut": "pgdn" }
```

### 2.4 Tab List (`tablist`)

```bash
curl -s "http://<host>:3000/api/mcp/test/tablist" \
  -H "Authorization: Bearer <token>"
```

Response shape:

```json
{
  "tabs": [
    { "index": 0, "title": "...", "url": "...", "targetId": "...", "isReady": true }
  ],
  "activeIndex": 0,
  "creatingTab": false
}
```

### 2.5 Navigate current active tab

```bash
curl -s -X POST "http://<host>:3000/api/mcp/test/navigate" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

### 2.6 Tabs new/select/close

```bash
curl -s -X POST "http://<host>:3000/api/mcp/test/tabs/new" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

```bash
curl -s -X POST "http://<host>:3000/api/mcp/test/tabs/select" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"tabIndex":1}'
```

```bash
curl -s -X POST "http://<host>:3000/api/mcp/test/tabs/close" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"tabIndex":1}'
```

---

## 3) MCP JSON-RPC Endpoint

Endpoint: `POST /api/mcp/:browserId`

### 3.1 Initialize

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": { "protocolVersion": "2024-11-05", "capabilities": {} }
}
```

### 3.2 tools/list

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }
```

### 3.3 tools/call (example: navigate)

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "navigate",
    "arguments": { "url": "https://example.com" }
  }
}
```

### 3.4 notifications/initialized

For notification (without `id`), server returns HTTP `202` with empty body.

---

## 4) Architecture Guarantee: WebAPI and MCP share same function path

Server now routes both:

- MCP: `tools/call` -> `executeMcpToolCall(...)`
- WebAPI: `/api/mcp/:browserId/<tool>` -> `executeMcpToolCall(...)`

So both channels execute the same tool implementation (same function stack).

---

## 5) Quick Repro Script (pointer + navigate + tab sync)

1. Get token.
2. Call `tablist`.
3. Call `pointer` with absolute `start/end`.
4. Call `navigate`.
5. Call `tablist` again and verify active tab `url/title` changed.

