# ImportandReadSkillsFirst

## Purpose

This capability describes how AI should interact with Shared Browser MCP without transferring huge base64 payloads.

## Core Rules

- Prefer MCP tool calls and API JSON endpoints first.
- For large binary data, use returned `resourceUrl` + `resourceToken`.
- Fetch binary via `GET /api/mcp/:browserId/dl_res?...` with `curl`.
- Do not request giant `contentBase64` blobs for screenshot/video/downloads.

## New Data Transfer Pattern

Tools now return:

- `resourceUrl`: direct GET URL for binary fetch
- `resourceToken`: short-lived token embedded in URL query

Use:

```bash
curl -L "<resourceUrl>" -o out.bin
```

## Tool Notes

- `screenshot`:
  - returns metadata + `resourceUrl`
  - server keeps only latest 10 screenshots per browser
- `list_recorded_videos`:
  - each item includes `resourceUrl`
- `downloads`:
  - returns `{ files, active }`, and both entries include `resourceUrl`
- `paste`:
  - text/html only
- `pasteFiles`:
  - use multipart upload for files

## pasteFiles Example

```bash
curl -X POST "http://<host>:3000/api/mcp/<browserId>/pasteFiles" \
  -H "Authorization: Bearer <token>" \
  -F "selector=#target" \
  -F "files=@C:/tmp/a.png" \
  -F "files=@C:/tmp/b.txt"
```

## Compatibility

- Existing MCP JSON-RPC `tools/call` remains available.
- WebAPI and MCP still share the same execution path.
