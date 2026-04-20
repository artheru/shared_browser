# ImportandReadSkillsFirst

## Purpose

This document helps AI agents interact with Shared Browser API without unnecessary data transfer.

## Read Full API Skills

Full API reference with copyable URLs (including token) is available at:

```
GET /api/ai/help/read-skills?token=<aiToken>
```

The response is plain text containing all endpoint URLs pre-filled with the token, parameter specs, and curl examples.

## Core Rules

- Use `?token=<token>` on every API call (or `Authorization: Bearer <token>`).
- Prefer selector-based pointer/keyboard operations; fall back to coordinates only when needed.
- For large binary data (screenshots, videos, downloads), use the returned `resourceUrl` — do NOT request raw base64.
- Prefer `devtools` over the old console endpoint when diagnosing failures; it exposes console/runtime/network/debugger state in one place.
- Fetch binary resources via: `curl -L "<resourceUrl>" -o output.bin`

## Data Transfer Pattern

Tools return a `resourceUrl` (short-lived, ~15 min) for binary content:

- `screenshot` → `resourceUrl` for JPEG/PNG image (application/octet-stream)
- `video/list` → each item has `resourceUrl` for MP4 (application/octet-stream)
- `downloads` → each completed file has `resourceUrl` (application/octet-stream)

## Key API Endpoints

| Action           | Method | Path                                    |
|------------------|--------|-----------------------------------------|
| Read skills      | GET    | /api/ai/help/read-skills?token=TOKEN    |
| List browsers    | GET    | /api/browsers?token=TOKEN               |
| Screenshot       | POST   | /api/mcp/:bid/screenshot                |
| Pointer          | POST   | /api/mcp/:bid/pointer                   |
| Keyboard         | POST   | /api/mcp/:bid/keyboard                  |
| Paste text       | POST   | /api/mcp/:bid/paste                     |
| Paste files      | POST   | /api/mcp/:bid/pasteFiles (multipart)    |
| View clipboard   | GET    | /api/mcp/:bid/clipboard/view            |
| Tab list         | GET    | /api/mcp/:bid/tablist                   |
| Navigate         | POST   | /api/mcp/:bid/navigate                  |
| Tab select/new/close | POST | /api/mcp/:bid/tabs/{select,new,close} |
| Record video     | POST   | /api/mcp/:bid/video/start               |
| List videos      | GET    | /api/mcp/:bid/video/list                |
| Downloads        | GET    | /api/mcp/:bid/downloads                 |
| HTML source      | GET    | /api/mcp/:bid/dev/html                  |
| Console log      | GET    | /api/mcp/:bid/dev/console               |
| DevTools         | GET/POST | /api/mcp/:bid/devtools                |
| Eval JS          | POST   | /api/mcp/:bid/dev/eval                  |

## pasteFiles Example

```bash
curl -X POST "http://<host>:<port>/api/mcp/<bid>/pasteFiles?token=<token>" \
  -F "selector=#upload-input" \
  -F "files=@/tmp/file.pdf"
```

## Reliable Action Loop

1. `screenshot` — capture current state
2. `devtools` or `dev/html`/`dev/eval` — inspect errors, network failures, selectors, or paused call frames
3. Perform one action (`pointer` or `keyboard`)
4. `screenshot` + `dev/eval` — verify result
5. If failed: retry with adjusted selector or coordinates
