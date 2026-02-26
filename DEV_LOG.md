# DEV_LOG

## 2026-02-18 Local rollback
- WebRTC introduction commit (local history): `bb61482`.
- Reset local branch back to pre-WebRTC baseline and cleaned workspace:
  - `git reset --hard origin/master` -> `5524d01`
  - `git clean -fd`

## 2026-02-18 Remote rollback deploy (192.168.0.190)
- Observed remote running build via `GET http://192.168.0.190:3000/api/version`:
  - before: `2026.02.18-181424` (WebRTC build)
  - after: `2026.02.18-194125` (rollback build from current `origin/master`)
- Located active install directory on remote: `C:\\shared-browser` (PID `59388` listening on `:3000`).
- Built rollback package locally: `shared-browser.zip` (version `2026.02.18-194125`).
- Deployed via VehicleHelper (`http://192.168.0.190:9697`):
  - uploaded zip to `C:\\shared-browser\\shared-browser.zip`
  - expanded zip into `C:\\shared-browser`

## 2026-02-18 Deployment verification evidence
- MCP loop OK (screenshot -> pointer -> input -> screenshot) on remote `browserId=test`.
- Evidence screenshots:
  - `ai-deck/tmp/deploy-verify-20260218-194951-01.png`
  - `ai-deck/tmp/deploy-verify-20260218-194951-02.png`

## 2026-02-18 Post-rollback fixes (UX + policy)
- Implemented domain restriction preflight blocking (abort navigation request before Chrome leaves page):
  - server: `server/browser-manager.js` request interception + `domain_blocked` event
  - client: `client/src/views/BrowserView.vue` shows H5 toast for `domain_blocked`
- Fixed keyboard text input not landing in page in some environments (IME/composition):
  - client: keep a hidden textarea focused on desktop to capture real text input; send `keypress` events on `@input`
  - avoid double-typing by skipping printable `keydown/keyup` forwarding when the bridge textarea is focused
- Split help entrypoints:
  - route: `/tools-help/mcp` and `/tools-help/api` (previously `ai`)
  - Guide Generator tightened: only `Server Base URL` editable; `browserId` and `token` read-only + `New token` modal
- UI cleanup: removed `Status` header button from browser list (Report kept)

## 2026-02-18 Remote deploy update (192.168.0.190)
- Built new package: `shared-browser.zip` version `2026.02.18-201633`.
- Deployed via VehicleHelper:
  - upload: `C:\\shared-browser\\shared-browser.zip`
  - expand: `Expand-Archive -Force` into `C:\\shared-browser`
- Note: `install.bat /update` triggered unexpected interactive flow in VehicleHelper terminal; used explicit process restart instead.
- Restarted service:
  - `taskkill /PID 69528 /F`
  - `start /D C:\\shared-browser node server\\index.js`
- Verified:
  - `GET http://192.168.0.190:3000/api/version` -> `2026.02.18-201633`
  - MCP loop evidence:
    - `ai-deck/tmp/deploy-verify-20260218-201633/01-before.jpg`
    - `ai-deck/tmp/deploy-verify-20260218-201633/02-after.jpg`

## 2026-02-18 Startup blank + keyboard follow-up
- Symptom: newly started browser view may stay blank/connecting until refresh; keyboard sometimes appears to do nothing.
- Server: `server/index.js`
  - Added warm-frame retry loop: if no cached frame exists at WS connect time, retry for ~2s and send first available cached frame.
- Client: `client/src/views/BrowserView.vue`
  - Focus reliability: always focus the hidden text bridge on stream `mousedown` (desktop) so text/IME is not lost.
  - Paste reliability: allow `paste` handling when the hidden bridge textarea is focused.
  - Added timers/guards to avoid infinite "connecting..." state when WS repeatedly fails; shows `wsConnectFailed` message instead of blank.
- Remote deploy:
  - Updated `192.168.0.190` to `2026.02.18-204828` (`GET /api/version`).

## 2026-02-18 Transport optimization (latency-driven)
- Observed issue: JPEG quality could drop all the way to Q20 even when bandwidth looked sufficient.
- Updated adaptation policy to use latency (client feedback) as the primary control:
  - latency <= 100ms: force `quality=80` at 720p
  - latency  > 100ms: step down quality until `quality=20`
  - if already `quality=20` and still high latency: drop viewport to 360p (floor; no further downscale)
- Implementation: `server/stream-service.js`
  - uses CDP `Page.captureScreenshot` (JPEG) loop; no `Page.startScreencast`
  - added `viewportMode` + `desiredViewportMode` into `/api/stream-health` stats for observability
- Remote deploy:
  - Updated `192.168.0.190` to `2026.02.18-212723` (`GET /api/version`).

## 2026-02-18 WS connect fix + startScreencast
- Symptom: Web UI stuck in retry loop with `WebSocket connection failed`, no `connected` event.
- Root cause: WS `connect` handler awaited `page.evaluate(() => true)` inside `browserManager.getSessionForUser()`; on some stuck pages this promise can hang indefinitely, blocking the handshake.
- Fix: `server/browser-manager.js` add `_probePageAlive()` with timeout; on timeout treat page invalid and rebuild session.
- Stream transport: switched `StreamSession.start()` to prefer `Page.startScreencast` (event-driven frames) and only fall back to screenshot loop if screencast start fails.
- New connection UX: `server/index.js` now pushes one best-effort high-quality (`Q80`) screenshot right after WS connect (non-blocking).
- Fit-to-window: `client/src/views/BrowserView.vue` `.stream-image` uses `width/height: 100%` + `object-fit: contain`.
- Remote deploy:
  - Updated `192.168.0.190` to `2026.02.18-214935` (`GET /api/version`).

## 2026-02-18 Stream downsample fix (do not change Chrome viewport)
- Problem: adaptive "resolution drop" was implemented by changing Chrome/page viewport, which is wrong for remote-control UX; we should keep Chrome rendering at 720p and only downsample the streamed JPEG frames.
- Fix: `server/stream-service.js`
  - removed viewport-mode switching and all `page.setViewport()` adaptation
  - keep base viewport 1280x720; adapt stream using `Page.startScreencast(maxWidth/maxHeight)` + JPEG quality
  - policy now becomes: `<=100ms -> Q80 x 1.0`, `>100ms -> step quality down to Q20`, `Q20 + still high -> scale=0.5 (360p floor)`
  - added stats: `scale`, `desiredScale`, `decision` (e.g. `Q20x0.60`) to `/api/stream-health`
- Fix: `server/index.js` send `network_stats.stream` with `latencyMs`, `quality`, `scale`, `decision`.
- Fix: `client/src/views/BrowserView.vue`
  - status bar now displays `latencyMs | Qxx x scale` (server decision); FPS no longer shown as primary status
  - added i18n: `browserView.statsTooltip2`
- Remote deploy:
  - Updated `192.168.0.190` to `2026.02.18-220251` (`GET /api/version`).

## 2026-02-18 Status: bandwidth + screencast FPS + adaptive threshold
- Request:
  - Keep showing server<->client stream bandwidth.
  - Show CDP `Page.startScreencast` FPS (Chrome paint-driven) for diagnosis.
  - Use allowed latency threshold: `max(100ms, 1000/FPS)` so low FPS tolerates larger RTT.
- Server: `server/stream-service.js`
  - added screencast FPS estimator from `Page.screencastFrame` event rate (`screencastFps`)
  - added `allowedLatencyMs` to stats and used it as the "good latency" threshold in adaptation
- Server: `server/index.js`
  - extended `network_stats.stream` with `screencastFps` + `allowedLatencyMs`
- Client: `client/src/views/BrowserView.vue`
  - status bar now shows: `latencyMs | Qxx x scale | SC <fps> | ↓<bandwidth>`
  - kept remote browser network activity indicator separately
- Evidence (remote MCP loop):
  - `ai-deck/tmp/deploy-verify-20260218-222513/01-before.png`
  - `ai-deck/tmp/deploy-verify-20260218-222513/02-after.png`
- Remote deploy:
  - Updated `192.168.0.190` to `2026.02.18-222513` (`GET /api/version`).

## 2026-02-19 High-refresh page latency/CPU + blank/stale view fixes
- Symptom:
  - Visiting high-refresh sites like `https://clock.zone/` could make "latency" explode and push Node CPU high.
  - After shutdown/restart, first entry could be blank or show previous page; stream could drift away from the active tab.
- Root causes addressed:
  - Server was delivering every `Page.screencastFrame` paint (60+ fps) -> WS backlog -> huge effective delay + high CPU.
  - Client RTT derived from `now - serverFrameTimestamp` is invalid when server/client clocks are skewed.
  - StreamSession page could drift from BrowserManager active tab after restarts/target recreation.
- Fixes:
  - `server/stream-service.js`
    - throttle screencast decode+delivery to target FPS (ACK every frame, but process at <= configured fps)
    - drop WS delivery when `ws.bufferedAmount` is high (still updates latest frame cache)
    - watchdog: if no frames for a while, force restart screencast; if still stalled, fall back to legacy capture loop (prevents permanent blank/stale image)
    - ignore client-provided RTT; update RTT from server WS ping/pong (`updateNetworkRtt`)
  - `server/browser-manager.js`
    - warmup now always uses a fresh home page and closes other pages to avoid "last page carry-over"
    - after last user session shutdown, reset browser to configured home page
  - `server/index.js`
    - on `ws_pong`, feed server-measured RTT into StreamSession (adaptation + UI)
    - periodic drift-heal: re-sync StreamSession page to BrowserManager active page in `network_stats` interval
- Remote deploy notes:
  - VehicleHelper `files/upload` for full zip started timing out; deployed by uploading only the modified server JS files.
  - VehicleHelper AI terminal endpoints became unstable under high load; restarted node via remote GUI keyboard (Win+R -> cmd -> taskkill+start).
- Verification:
  - `api/admin/report` shows active tab URL == stream page URL after navigation to `clock.zone`.
  - `stream-health` RTT is now small (WS ping/pong) and no longer shows clock-skew inflated values.

## 2026-02-19 Deploy verify phrase (jackie)
- Request: add a build phrase to `version.json` so deployment can be verified by checking `/api/version` contains the phrase.
- Implemented: `build.ps1`
  - supports `-Phrase <token>` (or env `SB_BUILD_PHRASE`)
  - embeds `phrase` field into `version.json` and appends phrase to `version` string
- Remote deploy: full zip deployed and expanded; restarted node via VehicleHelper GUI keyboard.
- Verified:
  - `GET http://192.168.0.190:3000/api/version` -> `version=2026.02.19-050408-jackie`, `phrase=jackie`
  - MCP loop evidence: `ai-deck/tmp/deploy-verify-20260219-050408-jackie/01-before.png`, `02-after.png`

## 2026-02-19 Default page for new tab / last tab close (jackie2)
- Request:
  - If current page is `about:blank`, UI must show a hint (already present in `BrowserView.vue`).
  - Entering a browser should navigate to its configured default URL.
  - Creating a new tab (no explicit URL) should also navigate to the configured default URL.
  - Closing the last remaining tab should not leave the user on `about:blank`; it should return to the configured default URL.
- Server: `server/browser-manager.js`
  - `createNewTab()` now defaults to `browserConfig.url` when `url` is not provided and pre-sets the tab list to `Loading...` + target URL.
  - `closeTab()` when it is the last tab now navigates back to `browserConfig.url` (with domain policy check) instead of forcing `about:blank`.
- Remote deploy:
  - Built with phrase: `jackie2`
  - Verified: `GET /api/version` shows `2026.02.19-051225-jackie2` + `phrase=jackie2`

## 2026-02-20 Mouse coordinate offset fix (jackie3)
- Symptom: when the stream is displayed with `object-fit: contain` and the container has letterbox/pillarbox bars, mouse coordinates were computed from the container/element box instead of the actual painted content, causing input offset.
- Fix: `client/src/views/BrowserView.vue`
  - compute stream content rect inside the `<img>` box based on fixed stream aspect (1280x720)
  - map mouse events using the content rect; ignore clicks on black bars; clamp moves while dragging
  - apply the same content rect logic to the remote cursor overlay
- Remote deploy:
  - Built with phrase: `jackie3`
  - Verified: `GET /api/version` shows `2026.02.20-070835-jackie3` + `phrase=jackie3`
  - Evidence: `ai-deck/tmp/deploy-verify-20260220-070835-jackie3/01-before.png`, `02-after.png`

## 2026-02-21 MCP JSON-RPC server endpoint fix (jackie4)
- Symptom: direct MCP endpoint `http://192.168.0.190:3000/api/mcp/test` was not usable as a standard MCP server route.
- Implemented in `server/index.js`:
  - `GET /api/mcp/:browserId` returns endpoint metadata/hint for MCP client setup
  - `POST /api/mcp/:browserId` handles JSON-RPC methods:
    - `initialize`
    - `ping`
    - `tools/list`
    - `tools/call`
  - Added MCP tool gating by `toolAccess.*.mcpEnabled` (`ensureMcpToolEnabled`)
  - Added MCP tool adapters to existing services (`mcpService`, `fileService`) with structured MCP responses
- Remote deploy:
  - Built with phrase: `jackie4`
  - Verified: `GET /api/version` => `2026.02.21-044227-jackie4`, `phrase=jackie4`
- Remote MCP verification:
  - `GET /api/mcp/test` works (with bearer token)
  - `POST /api/mcp/test` `initialize` returns server info/version
  - `tools/list` returns 8 tools
  - `tools/call` (`dev_html`) returns content + structuredContent## 2026-02-21 MCP parameter descriptions + tab tools (jackie5)
- Request:
  - MCP tool parameter descriptions should be explicit (no `No description` in client UI).
  - AI must be able to access/select tabs through both MCP and WebAPI endpoints.
- Implemented:
  - `server/index.js`
    - enriched `getMcpToolSchemas()` with `description` for tool parameters (pointer/input/dev_console/dev_eval/etc.)
    - added MCP schemas for `tabs_list`, `tabs_select`, `tabs_new`, `tabs_close`
    - extended MCP `tools/call` dispatcher to support tab operations via `browserManager`
    - added WebAPI routes:
      - `GET /api/mcp/:browserId/tabs`
      - `POST /api/mcp/:browserId/tabs/select`
      - `POST /api/mcp/:browserId/tabs/new`
      - `POST /api/mcp/:browserId/tabs/close`
  - `server/browser-tools-registry.js`
    - registered 4 new tools with route metadata
- Remote deploy:
  - Built with phrase: `jackie5`
  - Verified: `GET /api/version` => `2026.02.21-045646-jackie5`, `phrase=jackie5`
- Remote functional verification:
  - MCP `tools/list` contains `tabs_list/tabs_select/tabs_new/tabs_close`
  - MCP schema now returns parameter descriptions (e.g., pointer fields, `tabIndex` description)
  - MCP tab flow works (`tabs_list -> tabs_new -> tabs_select -> tabs_close`)
  - WebAPI tab routes work (`/api/mcp/test/tabs` and `/tabs/select`)
  - MCP loop evidence: `ai-deck/tmp/deploy-verify-20260221-045646-jackie5/01-before.png`, `02-after.png`

## 2026-02-22 AI video recording tools + deploy (jackie7)
- Request: add AI-side video recording capability with strict duration and retrieval APIs:
  - `start video recording` (must wait until ready, return `fileId`)
  - `list_recorded_videos` (currently available `fileId`s, retention-limited)
  - `fetch_video` (MP4 retrieval)
- Implemented:
  - New service: `server/video-recording-service.js`
    - captures frames with CDP `Page.startScreencast`
    - records for required `durationSec` (blocking call)
    - encodes JPG frame sequence to MP4 via `ffmpeg`
    - returns metadata incl. `fileId`, `filename`, `durationSec`, `size`
    - enforces hard max duration <= 15s (plus admin-configured cap)
    - auto-prunes old files (default latest 10)
  - Config: `server/config.js`
    - added `recordingsDir` and `recording` options:
      - `maxDurationSec`, `maxSavedFiles`, `fps`, `quality`, `ffmpegPath`
  - Tool registry: `server/browser-tools-registry.js`
    - added `start_video_recording`, `list_recorded_videos`, `fetch_video`
  - MCP + WebAPI wiring: `server/index.js`
    - MCP schemas and `tools/call` dispatch cases for all 3 video tools
    - WebAPI routes:
      - `POST /api/mcp/:browserId/video/start`
      - `GET  /api/mcp/:browserId/video/list`
      - `GET  /api/mcp/:browserId/video/:fileId`
    - logging summary avoids dumping full base64 payload in logs
  - Docs: `AI_USAGE.md`
    - added tab APIs and full video section (rules/examples/retention)
- Issue encountered during deploy:
  - Remote lacked `ffmpeg` in PATH; `start_video_recording` failed with:
    - `ffmpeg not found at "ffmpeg". Configure recording.ffmpegPath or install ffmpeg.`
  - Fix on remote:
    - uploaded `ffmpeg.exe` from local `ffmpeg-static` package to `C:\\shared-browser\\tools` via chunked `VehicleHelper /api/ai/files/upload`
    - set `params.json`:
      - `recording.ffmpegPath = "C:\\shared-browser\\tools\\ffmpeg.exe"`
      - `recording.maxDurationSec = 15`
      - `recording.maxSavedFiles = 10`
    - restarted shared-browser service
- Deploy:
  - First build `jackie6` exposed config path bug; fixed `video-recording-service` root dir usage and rebuilt.
  - Final build/deploy: `2026.02.22-004827-jackie7`
  - Verified `/api/version` returns phrase `jackie7`
- Remote validation (browser `test`):
  - Navigated to `https://www.shadertoy.com/view/XstXR2`
  - MCP flow success:
    - `tools/call start_video_recording {durationSec:6}` -> returns `fileId`
    - `tools/call list_recorded_videos` -> includes the `fileId`
    - `tools/call fetch_video` -> returns base64 MP4 payload
    - `GET /api/mcp/test/video/<fileId>` -> HTTP 200, binary length matches recorded size
  - Example verified output:
    - `fileId = mlwkdz5s-8ad901d1`
    - MP4 size: `678935` bytes
  - Screenshot evidence captured:
    - `ai-deck/tmp/shadertoy-after-record.jpg` (visible Shadertoy editor + preview)

## 2026-02-22 ToolsHelp video examples + local recording artifact (jackie8)
- Request follow-up:
  - add recording APIs into AI Guide Generator output
  - save test recording under `ai-deck` for manual check
- Updated `client/src/views/ToolsHelp.vue`:
  - `buildGuideMarkdown()` now includes:
    - WebAPI examples for:
      - `POST /video/start`
      - `GET /video/list`
      - `GET /video/<fileId>`
    - MCP JSON-RPC examples for:
      - `start_video_recording`
      - `list_recorded_videos`
      - `fetch_video`
    - operation manual explicitly notes `start_video_recording` is blocking and returns `fileId`
- Pulled remote test recording to local `ai-deck`:
  - source: `GET http://192.168.0.190:3000/api/mcp/test/video/mlwkdz5s-8ad901d1`
  - saved as: `ai-deck/tmp/test-recording-mlwkdz5s-8ad901d1.mp4`
  - size: `678935` bytes
- Remote deploy:
  - built with phrase: `jackie8`
  - deployed and restarted on `192.168.0.190`
  - verified `/api/version` => `2026.02.22-010621-jackie8`, `phrase=jackie8`

## 2026-02-22 MCP tool-error response mode fix (jackie9)
- User issue:
  - some invalid selector errors were returned as JSON-RPC top-level `error` from `/api/mcp/:browserId`
  - MCP clients interpreted this as protocol/transport failure, requiring reconnect/restart
- Fix in `server/index.js`:
  - added `makeToolErrorResult(err, toolName)` that returns MCP tool result payload:
    - `isError: true`
    - `content: [{ type: "text", text: "{\"error\":\"...\",\"tool\":\"...\"}" }]`
    - `structuredContent: { error, tool }`
  - changed `tools/call` catch branch:
    - from `makeJsonRpcError(...)` HTTP 400
    - to `makeJsonRpcResult(id, makeToolErrorResult(...))` HTTP 200
  - kept protocol-level validation errors (`Invalid Request`, `Method not found`, etc.) as JSON-RPC `error` (correct behavior)
- Remote deploy:
  - built with phrase: `jackie9`
  - deployed and restarted on `192.168.0.190`
  - verified `/api/version` => `2026.02.22-045835-jackie9`, `phrase=jackie9`
- Verification of behavior:
  - intentionally called MCP `tools/call` `pointer` with invalid selector `button:contains(\"x\")`
  - confirmed response is:
    - `jsonrpc: "2.0"`
    - `result.isError: true`
    - no top-level `error` object

## 2026-02-22 keyboard rename + shortcuts + paste/viewClipboard (jackie10)
- User request:
  - `input` not stable -> rename to `keyboard`
  - support keyboard shortcut usage (`pgup`/`pgdn` etc.)
  - add `paste` method for large text/image/file input
  - add `viewClipboard` method for clipboard inspection (without relying on blocked JS Clipboard API)
  - ensure MCP parameter descriptions include these capabilities
- Server changes:
  - `server/browser-tools-registry.js`
    - replaced tool id `input` with `keyboard`
    - added tools: `paste`, `viewClipboard`
    - backward-compat: map legacy `toolAccess.input` settings to `keyboard`
  - `server/mcp-service.js`
    - added `keyboardInput()`:
      - supports `text`, `key`, `shortcut`, `shortcuts`, `keys`/`combo`, `repeat`, `pressEnter`
      - key alias normalization for `pgup`, `pgdn`, arrows, ctrl/win/meta etc.
      - virtual clipboard aware handling for `Ctrl+C / Ctrl+X / Ctrl+V`
    - kept `inputText()` as compatibility wrapper to `keyboardInput()`
    - added `paste()`:
      - text fast-path via `Input.insertText`
      - supports HTML/image/files via synthetic paste event + DataTransfer
    - added `viewClipboard()` with optional `captureSelection`
    - introduced per-browser-user clipboard cache (`clipboardStore`)
  - `server/index.js`
    - MCP schema updates in `getMcpToolSchemas()` for:
      - `keyboard` (shortcut/combo params + descriptions)
      - `paste` (text/html/image/files params + descriptions)
      - `viewClipboard` (`captureSelection`)
      - `input` kept as deprecated schema alias
    - tool dispatch updates:
      - canonical tool remap (`input -> keyboard`, `view_clipboard -> viewClipboard`)
      - `executeMcpToolCall()` supports `keyboard`, `paste`, `viewClipboard`
    - WebAPI routes:
      - new: `POST /api/mcp/:browserId/keyboard`
      - legacy alias kept: `POST /api/mcp/:browserId/input`
      - new: `POST /api/mcp/:browserId/paste`
      - new: `GET /api/mcp/:browserId/clipboard/view`
  - `AI_USAGE.md` and `client/src/views/ToolsHelp.vue`
    - replaced primary usage `input -> keyboard`
    - added shortcut examples (`pgdn`)
    - added `paste`/`viewClipboard` examples and guidance
- Remote deploy:
  - built with phrase: `jackie10`
  - deployed and restarted on `192.168.0.190`
  - verified `/api/version` => `2026.02.22-053808-jackie10`, `phrase=jackie10`
- Remote validation (browser `test`, MCP + API loop):
  - `tools/list` contains `keyboard`, `paste`, `viewClipboard`
  - MCP schema includes expected parameter descriptions (`shortcut`, `files`, `captureSelection`)
  - `keyboard` with `shortcut=pgdn` returns `ok: true`
  - `paste` large text returns `mode: insertText`
  - `viewClipboard` returns expected text length (`2000`)
  - legacy MCP `input` alias still works (`ok: true`)
  - evidence screenshots:
    - `ai-deck/tmp/keyboard-paste-before.jpg`
    - `ai-deck/tmp/keyboard-paste-after.jpg`

## 2026-02-22 MCP JSON parse failure fix for Cursor fallback paths (jackie11)
- User report:
  - Cursor MCP logs showed `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`
  - occurred when streamable HTTP failed and client fell back to SSE path(s)
- Root cause:
  - unknown MCP/API routes could fall through to SPA catch-all (`index.html`)
  - MCP client expected JSON but received HTML
- Fix in `server/index.js`:
  - added explicit fallback before SPA route:
    - `app.all('${config.mcp.routePrefix}/:browserId/*', ...)` => JSON 404 `{ error: "Unknown MCP endpoint", hint: ... }`
    - `app.all('/api/*', ...)` => JSON 404 `{ error: "API endpoint not found" }`
  - keeps SPA fallback only for non-API frontend routes
- Remote deploy:
  - built with phrase: `jackie11`
  - deployed and restarted on `192.168.0.190`
  - verified `/api/version` => `2026.02.22-054339-jackie11`, `phrase=jackie11`
- Verification:
  - `GET /api/mcp/test/sse` now returns JSON error (404), not HTML
  - `GET /api/does-not-exist` now returns JSON error (404), not HTML

## 2026-02-22 JS copy capture via viewClipboard (jackie12)
- User report:
  - `viewClipboard` seemed to reflect Ctrl+C path but not JS-triggered copy flows
- Root cause:
  - clipboard state was mainly updated by tool-level operations (`keyboard` combo/paste)
  - page-originated JS copy pipeline (`copy` event / `navigator.clipboard.writeText`) was not consistently captured
- Fix in `server/mcp-service.js`:
  - Added `ensureClipboardHook(browserId, userId, page)` and call it from `getPage()`
  - Hook behavior injected into page:
    - captures `copy`, `cut`, `paste` events and stores `text/html/files` into `window.__sbVirtualClipboard`
    - attempts to wrap `navigator.clipboard.writeText` to mirror writes into virtual clipboard cache
    - installs on current document and via `evaluateOnNewDocument` for future navigations
  - `viewClipboard()` now reads page cache (`window.__sbVirtualClipboard`) and merges into service-side clipboard store before returning
- Remote deploy:
  - built with phrase: `jackie12`
  - deployed and restarted on `192.168.0.190`
  - verified `/api/version` => `2026.02.22-060437-jackie12`, `phrase=jackie12`
- Testpage validation requested by user:
  - created in-page button `#mcp-js-copy-btn` via `dev/eval`
  - button click triggers JS copy of a large text payload (`JS_COPY_` + 6000 chars) using:
    - `document.execCommand('copy')` with `clipboardData.setData`
    - `navigator.clipboard.writeText` fallback
  - clicked button through MCP `pointer`
  - `viewClipboard` result:
    - `textLength = 6008`
    - `source = clipboard_writeText`
    - `text` head begins with `JS_COPY_...`
  - evidence screenshot:
    - `ai-deck/tmp/js-copy-testpage.jpg`

## 2026-02-22 Clipboard robustness follow-up (jackie13)
- User report:
  - Ctrl+C selection was still not reflected in `viewClipboard` in some cases
  - ToolsHelp “复制 token” JS copy path still appeared unreadable in UI scenarios
- Root cause:
  - `browserManager.copySelection()` only read `window.getSelection()`, missing `input/textarea` selection range.
  - page hook did not cover `document.execCommand('copy')` path explicitly.
  - `viewClipboard` did not attempt a direct clipboard read from page when permissions/context allow it.
- Fixes:
  - `server/browser-manager.js`
    - `copySelection()` now captures selected substring from focused `input/textarea` via `selectionStart/selectionEnd`, then falls back to `window.getSelection()`.
  - `server/mcp-service.js`
    - enhanced page clipboard hook:
      - shared `captureActiveSelection()` for robust text extraction
      - `copy/cut` handlers now use active input selection fallback
      - wrapped `document.execCommand` to capture `copy/cut` operations triggered by JS fallback copy
    - `viewClipboard()` now also tries real clipboard read:
      - grants CDP permissions (`clipboardReadWrite`, `clipboardSanitizedWrite`) for current page origin
      - attempts `navigator.clipboard.readText()` and syncs into virtual clipboard when successful
- Remote deploy:
  - built with phrase: `jackie13`
  - deployed and restarted on `192.168.0.190`
  - verified `/api/version` => `2026.02.22-062917-jackie13`, `phrase=jackie13`
- Verification:
  - ToolsHelp page `http://127.0.0.1:3000/tools-help/mcp?browserId=test&helpType=mcp`
    - clicked “复制 token” button through page script
    - `viewClipboard` returned JWT-like token head (`eyJ...`), `source=clipboard_writeText`, `textLength=185`
  - Ctrl+C selection test in textarea:
    - selected substring `CTRL_C`
    - `keyboard` combo `Control+C` -> `viewClipboard.text == "CTRL_C"`, `source=copy`
  - evidence:
    - `ai-deck/tmp/toolshelp-copytoken-ok.jpg`

## 2026-02-22 Clipboard route unification + precedence fix (jackie14-jackie16)
- User clarification:
  - JS clipboard path and Ctrl+C path were still diverging
  - need single synced cache/event path so later `viewClipboard` always reflects latest copy source
  - recommendation to use init-script style early hook (Playwright `addInitScript` equivalent)
- Implemented unification:
  - `server/mcp-service.js`
    - `_setClipboard()` now syncs into `browserManager.setClipboard(...)` (single shared session cache)
    - page hook upgraded and pushed via `evaluateOnNewDocument` (init-script equivalent)
    - exposed bridge `page.exposeFunction('__sbClipboardNotify', ...)` so page-side clipboard events immediately notify server
    - hook coverage:
      - `copy/cut/paste` events
      - `navigator.clipboard.writeText` wrapper (`bind`-safe)
      - `document.execCommand('copy'/'cut')` wrapper
    - per-page access now attempts early clipboard permission grant:
      - `browserContext.overridePermissions(origin, ['clipboard-read','clipboard-write'])`
      - CDP `Browser.grantPermissions`
  - `server/index.js`
    - WS lifecycle now also installs clipboard hook on active/new/switched tabs, not only MCP routes
  - `server/browser-manager.js`
    - added `setClipboard()` / `getClipboard()` with `clipboard_updated` event emission
    - existing copy/paste/cut operations now write through shared session clipboard API
- Found and fixed merge bug:
  - `viewClipboard()` merged page cache too aggressively, overwriting recent Ctrl+C text with older JS token
  - final fix (`jackie16`): only apply page cache when empty/newer (or explicitly preferred)
- Deploy timeline:
  - `jackie14`: initial route unification + WS hook install
  - `jackie15`: attempt to reduce system clipboard override
  - `jackie16`: definitive precedence fix for Ctrl+C vs stale JS cache
  - final verified version: `2026.02.22-065827-jackie16`
- Final verification:
  - Step1 ToolsHelp “复制 token” JS copy -> `viewClipboard`: `source=clipboard_writeText`, `len=185`
  - Step2 textarea `Ctrl+A` + `Ctrl+C` -> `viewClipboard`: `source=copy`, `text=FULL_SELECTION_TEXT_123`, `len=23`
  - confirms both routes now sync and latest copy source wins

## 2026-02-22 Regression from user report + final fix (jackie17)
- User reported jackie16 still wrong:
  - wanted tests on normal page text selection (not textarea workaround)
  - Ctrl+A/C and JS copy still looked divergent in practical use
- Root cause found:
  - `keyboard` handler for `Ctrl+C/Ctrl+X` used early-return short-circuit path in MCP service, so real key combo events did not always run first
  - this could diverge from actual page/system clipboard behavior and produce stale sync
- Final fix:
  - `server/mcp-service.js` `keyboardInput()`:
    - removed pre-short-circuit for `Ctrl+C/Ctrl+X/Ctrl+V`
    - now executes real keyboard combo first, then post-syncs clipboard cache
  - `server/index.js` WS event bridge:
    - when `clipboard_updated` event arrives, also emits `clipboard_content`
    - keeps client-side clipboard bridge aligned with API/MCP cache updates
- Remote deploy:
  - built with phrase: `jackie17`
  - deployed/restarted on `192.168.0.190`
  - verified `/api/version` => `2026.02.22-135254-jackie17`
- Required real-page verification (no textarea setup):
  - Page: `https://example.com` (plain selectable text)
  - Action A: `Ctrl+A` then `Ctrl+C`
    - `copyAction.textLength = 128`
    - `viewClipboard.source = event_copy`
    - `viewClipboard.head = "Example Domain\\nThis domain is for use in..."`
  - Action B: JS copy `navigator.clipboard.writeText("JS_SYNC_TEST_...")`
    - `viewClipboard.source = clipboard_writeText`
    - `viewClipboard.len = 1213`
    - content head matches `JS_SYNC_TEST_...`
  - evidence:
    - `ai-deck/tmp/clipboard-plainpage-jackie17.jpg`

## 2026-02-22 API route mismatch with MCP clipboard (jackie18)
- User report:
  - JS copy path looked OK for client
  - but Ctrl+C text was not visible via API route:
    - `GET /api/mcp/test/clipboard/view` (curl)
  - suspected API and MCP paths behaved differently
- Root cause confirmed:
  - clipboard cache selection was session/user scoped in some paths
  - WebAPI call user and active browser-control user can differ, so API might read stale/empty session clip
- Fix:
  - `server/browser-manager.js`
    - added `browserClipboard` map (browser-level latest clipboard payload)
    - `setClipboard(...)` now updates both session clipboard and browser-level clipboard
    - added `getBrowserClipboard(browserId)` and cleanup on browser teardown
  - `server/mcp-service.js`
    - `_getClipboard(...)` now merges candidates:
      - per-user cache
      - per-session clipboard
      - browser-level latest clipboard
    - chooses newest by `updatedAt` to keep API/MCP views aligned
- Deploy:
  - built with phrase: `jackie18`
  - deployed and restarted on `192.168.0.190`
  - verified `/api/version` => `2026.02.22-140435-jackie18`, `phrase=jackie18`
- Cross-user validation (proves API path consistency):
  - user `cliptest2` performed Ctrl+A/C on `https://example.com` via MCP keyboard
  - admin called WebAPI `GET /api/mcp/test/clipboard/view`
  - result:
    - API (admin): `Example Domain...`, len 128
    - MCP (user2): `Example Domain...`, len 128
  - confirms API route now follows same latest browser clipboard state as MCP

## 2026-02-23 Browser-scoped short token + Codex MCP handshake hardening
- User request:
  1) API token too long; 8 chars is enough.
  2) Token must not auto-refresh with session/JWT; only manual rotate, bound to browser data.
  3) Codex MCP fails with `resources/list failed ... initialized notification ... Transport channel closed`.

- Server changes:
  - `server/auth.js`
    - added browser API token generator (`generateBrowserApiToken`) using `crypto.randomBytes`
    - normalized browser data loading to ensure each browser has `apiToken` + `apiTokenUpdatedAt`
    - added browser token APIs in `browserApi`:
      - `getAccessToken(id)`
      - `rotateAccessToken(id, length=8)`
    - `browserApi.create()` now initializes browser-level token
    - `authMiddleware` fallback path:
      - for `/api/mcp/:browserId/*`, if JWT verify fails, try browser-level token match
      - on success, request is authenticated as browser-token mode
  - `server/index.js`
    - `getMcpServerJson()` hint changed to `Bearer <browser-api-token>`
    - added helper `ensureBrowserReadableByUser()` for per-browser visibility checks
    - enhanced `GET /api/browsers/:id/mcp-endpoint` response:
      - includes `apiToken`, `apiTokenUpdatedAt`
    - added routes:
      - `GET /api/browsers/:id/access-token`
      - `POST /api/browsers/:id/access-token/rotate`
    - MCP JSON-RPC notification handling hardened:
      - if request has no `id` and method is `notifications/*`, return `202` empty body
      - specifically fixes `notifications/initialized` compatibility for strict clients (Codex/rmcp style)

- Client changes:
  - `client/src/views/ToolsHelp.vue`
    - token source switched from `localStorage JWT` to browser token API (`/api/browsers/:id/access-token`)
    - reload button now reloads browser token
    - “new token” action now calls manual rotate endpoint (`/access-token/rotate`)
    - removed username/password form dependency for token generation flow
  - `client/src/views/BrowserList.vue`
    - MCP JSON preview now fills `Authorization` with browser token (`toolsStatus.apiToken`) instead of local JWT
    - added `apiToken` in `toolsStatus` local state
  - i18n updates:
    - `client/src/i18n/en.js`
    - `client/src/i18n/zh-CN.js`
    - token-related text updated to browser-scoped/manual-rotate semantics

- Local verification:
  - Lint:
    - `ReadLints` on edited files: no errors
  - Client build:
    - `npm run client:build` passed
  - Browser token behavior smoke test:
    - `node -e` test confirmed:
      - length=8
      - stable across repeated get
      - rotate returns changed token with length=8
  - MCP handshake behavior test (local server on port `3301`):
    - `initialize` -> HTTP `200`
    - `notifications/initialized` (no id) -> HTTP `202`, empty body
  - MCP WebAPI route auth with browser token:
    - `GET /api/mcp/test/clipboard/view` -> HTTP `200`

- Notes:
  - Port `3000` on this machine pointed to another running service in the environment; used local isolated server on `3301` for deterministic handshake validation.

## 2026-02-23 Deploy and remote verification (`192.168.0.190` + `192.168.0.146`)
- Target:
  - deploy latest local changes to `192.168.0.190`
  - verify MCP/API with screenshot + pointer/keyboard loop
  - run Codex CLI on `192.168.0.146` to validate MCP startup path

- Deployment path:
  - `deploy.ps1` direct run was blocked because `VehicleHelper /api/ai/terminal/*` repeatedly timed out (`408`) and `/api/ai/status` was unstable.
  - workaround used:
    1) built package already produced by deploy flow: `deploy-package.zip` (version `2026.02.23-075519`)
    2) uploaded package via `POST /api/ai/files/upload` to:
       - `C:\\shared-browser\\deploy-package.zip`
    3) used VehicleHelper GUI input path (mouse/keyboard + screenshot loop) to run deploy command in remote PowerShell:
       - `taskkill /f /im node.exe; Expand-Archive -Path 'C:\\shared-browser\\deploy-package.zip' -DestinationPath 'C:\\shared-browser' -Force; cd C:\\shared-browser; node server/index.js`
    4) verified service version:
       - `GET http://192.168.0.190:3000/api/version` => `2026.02.23-075519`

- Evidence (remote GUI + test loop screenshots in `ai-deck/tmp/`):
  - `deploy-gui-before.png`
  - `deploy-gui-after.png`
  - `deploy-gui-run-command.png`
  - `mcp-loop-before.png`
  - `mcp-loop-after.png`

- Remote MCP/API verification (`192.168.0.190`):
  - login/admin OK
  - browser token endpoint:
    - `GET /api/browsers/test/access-token` -> token length `8` (example: `ZknLvnw5`)
  - browser token auth on MCP/API route:
    - `GET /api/mcp/test/clipboard/view` -> `ok=true`
  - JSON-RPC handshake:
    - `POST /api/mcp/test` `initialize` -> `200`
    - `POST /api/mcp/test` `notifications/initialized` (no id) -> `202`, empty body
  - tool loop on Test browser:
    - screenshot -> pointer -> keyboard (`pgdn`) -> screenshot
    - pointer/keyboard API responses return `ok=true`

- Codex CLI test on `192.168.0.146`:
  - initial failure:
    - Node `v12.22.9` too old for installed Codex CLI (`Unexpected reserved word`)
  - remediation:
    - upgraded node using `n` to `v20.18.1`
    - reinstalled Codex:
      - `npm install -g @openai/codex@latest`
  - validation:
    - `codex --version` -> `codex-cli 0.104.0`
    - MCP server added:
      - `codex mcp add shared-browser-test --url http://192.168.0.190:3000/api/mcp/test --bearer-token-env-var SB_TOKEN`
    - `codex exec` run succeeded with MCP startup logs:
      - `mcp startup: ready: shared-browser-test, codex_apps`
      - MCP tool call succeeded (`shared-browser-test.tabs_list`)
      - returned final tool count output: `17`

## 2026-02-23 Add `tablist` and `navigate` tools (tab reuse navigation)
- User request:
  - Agent should not rely only on `tabs_new(url)` for page access.
  - Need:
    - `tablist`: list all tabs (url/title) and indicate current active tab.
    - `navigate`: navigate current tab to target URL.

- Server implementation:
  - `server/browser-tools-registry.js`
    - added tool definitions:
      - `tablist` (`GET /api/mcp/:browserId/tablist`)
      - `navigate` (`POST /api/mcp/:browserId/navigate`)
  - `server/browser-manager.js`
    - added `navigateCurrentTab(browserId, userId, url)`:
      - resolves current active tab
      - enforces domain policy via `isUrlAllowedForUser`
      - navigates with `page.goto(..., waitUntil: domcontentloaded)`
      - updates tab meta/title/url and emits tabs updates
  - `server/index.js`
    - MCP schema additions:
      - `tablist` (no args)
      - `navigate` (`url` required)
    - MCP dispatcher additions in `executeMcpToolCall`:
      - `tablist` -> same tab list payload (`tabs`, `activeIndex`, etc.)
      - `navigate` -> navigate current tab and return updated tab list
    - WebAPI routes added:
      - `GET /api/mcp/:browserId/tablist`
      - `POST /api/mcp/:browserId/navigate`

- Docs:
  - `AI_USAGE.md` updated:
    - route list includes `tablist` and `navigate`
    - tab operations section includes `tablist` example and navigate payload

- Build/deploy:
  - built with phrase: `jackie19nav`
    - local build version: `2026.02.23-084352-jackie19nav`
  - uploaded package to remote:
    - `C:\\shared-browser\\deploy-package.zip`
  - because VehicleHelper terminal endpoints remained unstable, used GUI execution path:
    - Win+R + keyboard command to run:
      - `taskkill /f /im node.exe`
      - `tar -xf C:\\shared-browser\\deploy-package.zip -C C:\\shared-browser`
      - `node server/index.js`
  - deployment verification:
    - `GET http://192.168.0.190:3000/api/version` -> `2026.02.23-084352-jackie19nav`

- Remote functional tests (`browserId=test`):
  - browser token length remains 8.
  - `GET /api/mcp/test/tablist`:
    - returns `tabs` array with `url/title`
    - includes `activeIndex`
  - `POST /api/mcp/test/navigate` with `https://example.com`:
    - active tab url/title updated to `https://example.com/` / `Example Domain`
  - MCP JSON-RPC tests:
    - `tools/list` contains `tablist` and `navigate`
    - `tools/call` for `navigate` returns structured result successfully
  - screenshot + pointer/keyboard loop executed and evidence saved:
    - `ai-deck/tmp/nav-loop-before.png`
    - `ai-deck/tmp/nav-loop-after.png` (live frame path may lag)
    - `ai-deck/tmp/nav-loop-after-forced.png` (`useLiveFrame=false`, shows Example Domain)
    - `ai-deck/tmp/nav-deploy-winr-after.png`

## 2026-02-23 Browser-token identity correction (run as admin session)
- User clarification:
  - MCP access via browser token should NOT appear as `browser-token` user.
  - Browser token is only for browser authorization; runtime actions should run as admin so admin UI can observe all AI operations.
  - Tab switch/new tab done by AI should sync to user UI tab state.

- Root cause:
  - `authMiddleware` fallback for browser token set:
    - `req.user.id = 'browser-token'`
    - this created a separate session key (`test_browser-token`) and separated tab/runtime state from admin UI (`test_1`).

- Fix:
  - `server/auth.js`
    - added `resolveAdminIdentity()`:
      - prefers `username=admin && isAdmin=true`
      - fallback to first admin, then first user
    - browser-token fallback now:
      - validates token against `browser.apiToken`
      - sets `req.user` to resolved admin identity
      - sets `req.authMode='browser-token-admin'` and `req.browserTokenBrowserId`
    - removed pseudo identity usage for browser token path- Deploy:
  - built with phrase: `jackie20sync`
    - version: `2026.02.23-090148-jackie20sync`
  - remote deploy (`192.168.0.190`) via VehicleHelper:
    - upload zip through `/api/ai/files/upload`
    - GUI Win+R command to restart service with updated files
  - verified:
    - `GET /api/version` returns `jackie20sync`

- Validation of requested behavior:
  - Session/owner:
    - `GET /api/admin/report` for browser `test` shows:
      - tab `ownerName=admin`
      - session key only `test_1`
      - no `browser-token` owner/session
  - Tab sync (browser token -> admin UI/session):
    - call `POST /api/mcp/test/tabs/new` with browser token
    - admin JWT `GET /api/mcp/test/tablist` count increased immediately (`1 -> 2`)
    - active index matched in both views
    - call `POST /api/mcp/test/tabs/select` with browser token (`tabIndex=0`)
    - admin JWT `tablist.activeIndex` becomes `0` immediately
  - This confirms AI tab create/switch operations now synchronize with admin-visible session state.

## 2026-02-25 Detailed API docs + API/MCP execution-path unification
- User request:
  - provide detailed API docs for human manual testing
  - ensure API and MCP use the same backend function path
  - provide evidence
  - also received AI feedback claiming pointer absolute coords returned `(0,0)` while selector path worked

- Documentation updates:
  - added `API_REFERENCE.md`
    - auth flow (JWT + browser token)
    - per-tool WebAPI endpoints with payload/response examples
    - MCP JSON-RPC examples (`initialize`, `tools/list`, `tools/call`)
    - manual repro script guidance
  - updated `README.md` to link:
    - `API_REFERENCE.md`
    - `AI_USAGE.md`

- Architecture changes:
  - `server/index.js` WebAPI tool routes now execute via `executeMcpToolCall(...)` (same entry as MCP `tools/call`)
  - unified routes include:
    - `screenshot`, `pointer`, `keyboard`, `input` alias, `paste`, `viewClipboard`
    - `tabs`, `tablist`, `navigate`, `tabs/select`, `tabs/new`, `tabs/close`
    - `start_video_recording`, `list_recorded_videos`
    - `downloads`, `downloads_state`
    - `dev_html`, `dev_console`, `dev_eval`
  - Result: API and MCP channels share the same tool dispatcher and same implementation functions.

- Pointer issue fix (for AI feedback):
  - Root cause:
    - `pointerAction` previously expected nested `start/end`, so callers sending only top-level `x/y` could resolve to `(0,0)`.
  - Fix in `server/mcp-service.js`:
    - added shorthand compatibility:
      - start: `x/y` or `startX/startY`
      - end: `endX/endY`
    - keeps existing `start/end` object support

- Validation:
  - local checks:
    - `node --check server/index.js`
    - `node --check server/mcp-service.js`
    - `npm run client:build`
    - lints clean on modified files
  - remote deploy to `192.168.0.190`:
    - built with phrase `jackie21docs`
    - deployed via VehicleHelper file upload + GUI restart path
    - `/api/version` => `2026.02.25-214127-jackie21docs`
  - runtime evidence:
    - call log (`/api/mcp/calls`) includes both `source=api` and `source=mcp` entries for same tools (`pointer`, `navigate`)
    - this confirms both channels flow into unified tool dispatch and logging path

## 2026-02-25 Regression test execution (user requested "进行测试")
- Target host: `192.168.0.190`
- Scope:
  - browser token retrieval
  - API/MCP pointer consistency with top-level `x/y`
  - API/MCP navigate consistency
  - calllog source evidence
- Initial run:
  - token retrieval OK (`len=8`)
  - encountered intermittent remote failures:
    - `tabs/new` timeout
    - `Network.enable timed out...`
    - `No active tab available`
  - calllog still recorded mixed channel sources:
    - pointer: includes `api` + `mcp`
    - navigate: includes `api` + `mcp`
- Recovery:
  - executed `POST /api/browsers/test/restart` using admin JWT
  - wait 8s, then reran tests
- Retest results (pass):
  - API pointer:
    - request body `{x:113,y:142,clickAtEnd:true,button:'left'}`
    - response `start/end = 113,142 -> 113,142`
  - MCP pointer (`tools/call` same args):
    - response `start/end = 113,142 -> 113,142`
  - API navigate:
    - active tab URL => `https://example.com/?retest-nav=api`
  - MCP navigate (`tools/call`):
    - active tab URL => `https://example.com/?retest-nav=mcp`

## 2026-02-25 GPU acceleration investigation (GTX1060 usage concern)
- User report:
  - remote host has GTX1060 but Task Manager shows Chrome CPU high / GPU near zero.
- Findings:
  - `server/config.js` had explicit GPU-disabling flags:
    - `--disable-gpu`
    - `--disable-accelerated-2d-canvas`
    - plus `--disable-features=...VizDisplayCompositor...`
  - this configuration can force software path and suppress GPU utilization.
- Local code fix prepared:
  - added `gpuEnabled = params.puppeteer?.enableGpu !== false` (default enabled)
  - when enabled:
    - remove disable-gpu/disable-2d-canvas path
    - remove VizDisplayCompositor disable from default features string
    - add GPU-friendly flags:
      - `--enable-gpu-rasterization`
      - `--enable-zero-copy`
      - `--ignore-gpu-blocklist`
      - `--force_high_performance_gpu`
      - Windows extra: `--use-angle=d3d11`
  - when disabled via params:
    - keep legacy `--disable-accelerated-2d-canvas` + `--disable-gpu`
- Validation before deploy:
  - syntax check passed: `node --check server/config.js`
  - built package with phrase: `jackie22gpu`
- Deployment status:
  - blocked at this time because VehicleHelper endpoint unreachable:
    - `http://192.168.0.190:9697/version` repeated DOWN
  - shared-browser service (`:3000`) still reachable and running prior version `jackie21docs`
- Temporary evidence captured:
  - saved `chrome://gpu` screenshot before fix deploy:
    - `ai-deck/tmp/gpu-status-before-fix.png`

## 2026-02-25 Stage10 input commit debugging (`192.168.0.155:8081`)
- User reported Stage10 blocked despite pointer/text/paste attempts.
- Reproduction and probe:
  - navigated to `http://192.168.0.155:8081/` in `browserId=test`
  - installed runtime input trace hook via `dev/eval` for:
    - `keydown`, `keypress`, `keyup`, `beforeinput`, `input`, `paste`, `composition*`
  - executed:
    - pointer click on `#canvas`
    - `keyboard(text='CycleGUI')` + `keyboard(key='Enter')`
    - `paste(text='CycleGUI')` + `keyboard(key='Enter')`
- Observed evidence:
  - `document.activeElement` before and after click remains `BODY`
  - event trace shows key events delivered with `isTrusted=true`, target/body = `BODY`
  - screenshot confirms UI still `Current Stage:10`, `Progress: 9/19`
    - `ai-deck/tmp/stage10-input-debug.png`
  - explicit coordinate attempt also still blocked:
    - pointer `(113,142)` then type+enter
    - screenshot `ai-deck/tmp/stage10-click113142-type-enter.png`
- Conclusion:
  - pointer coordinate mapping is no longer the blocker here
  - blocker is input commit path/focus routing for canvas/ImGui stage
- Local fix prepared in code (`server/mcp-service.js`):
  - added `ensureSelectorFocus(page, selector)`
    - for canvas selector, auto set `tabindex='-1'`, then `focus()`
  - wired into:
    - `keyboardInput` (when `selector` provided)
    - `paste` (when `selector` provided)
    - `pointerAction` after selector click (`startSelector/endSelector`)
- Deploy status:
  - initially blocked because VehicleHelper endpoint `192.168.0.190:9697` unavailable.
  - after recovery, deployed build with phrase `jackie23stage10`.

## 2026-02-25 Stage10 retest after deployed focus hardening (`jackie23stage10`)
- Deploy verify:
  - `/api/version` => `2026.02.25-225510-jackie23stage10`
- Behavior change confirmed:
  - before fix: active element stayed `BODY`
  - after fix: active element in selector flows became `CANVAS#canvas`
- Regression matrix executed on `http://192.168.0.155:8081/`:
  1) `pointer(#canvas click)` + `keyboard(selector=#canvas,text=CycleGUI)` + `keyboard(selector=#canvas,key=Enter)`
  2) `pointer(#canvas double click)` + `paste(selector=#canvas,text=CycleGUI)` + `keyboard(selector=#canvas,key=Enter)`
  3) `pointer(x=113,y=142 click)` + `keyboard(selector=#canvas,text=CycleGUI)` + `keyboard(selector=#canvas,key=Enter)`
  4) `pointer(x=120,y=160 double click)` + `keyboard(text=CycleGUI,pressEnter=true)`
  5) same as #4 but `key=NumpadEnter`
- Results:
  - all variants still show:
    - `Current Stage:10`
    - `Progress: 9/19 stages completed`
  - input text is now visible in the Stage10 input row (`CycleGUI`) in coordinate variants (#4/#5), proving text entry reached UI
  - Enter/NumpadEnter still does not trigger commit/advance
- Evidence:
  - `ai-deck/tmp/stage10-retest-variant1.png`
  - `ai-deck/tmp/stage10-retest-variant2.png`
  - `ai-deck/tmp/stage10-retest-variant3.png`
  - `ai-deck/tmp/stage10-retest-xy120-160.png`
  - `ai-deck/tmp/stage10-retest-numpadenter.png`
- Current conclusion:
  - focus routing issue is partially solved (BODY -> CANVAS fixed)
  - remaining blocker is Stage10 submit/commit acceptance path for Enter (likely app-side event handling requirement beyond current MCP event sequence)

## 2026-02-25 Stage10 selector-chain fix + deploy (`jackie25selector`)
- Trigger:
  - user confirmed manual Enter works; requested continued fixing on automation path.
- Code changes (`server/mcp-service.js`):
  1) Added `await page.bringToFront().catch(() => {})` at start of:
     - `pointerAction(...)`
     - `keyboardInput(...)`
     - `paste(...)`
  2) Hardened `ensureSelectorFocus(...)`:
     - now computes `alreadyFocused = document.activeElement === target`
     - skips repeated `scrollIntoView/focus()` when `alreadyFocused=true`
     - returns `alreadyFocused` in result payload for diagnostics
- Why:
  - selector-based keyboard workflows on canvas/ImGui can lose widget-level active edit state if canvas is force-focused again right before typing/Enter.
  - this manifested as Stage10 staying at `9/19` despite text sometimes showing.
- Deploy:
  - built package: `2026.02.25-231218-jackie25selector`
  - uploaded/restarted via VehicleHelper (`192.168.0.190:9697`)
  - runtime verify:
    - `GET /api/version` => phrase `jackie25selector`
- Retest matrix (`browserId=test`, url `http://192.168.0.155:8081/`):
  - baseline check with previous failing route reproduced/diagnosed using step screenshots
  - pass case A (no selector on keyboard):
    - pointer click input row -> keyboard text -> Enter
    - result: `Current Stage:11`, `Progress:10/19`
  - pass case B (selector flow after fix):
    - pointer click input row -> `keyboard(text='CycleGUI', selector='#canvas', pressEnter=true)`
    - result: `Current Stage:11`, `Progress:10/19`
- Evidence files:
  - `ai-deck/tmp/stage10-step0-load.png`
  - `ai-deck/tmp/stage10-step1-dblclick.png`
  - `ai-deck/tmp/stage10-step2-paste.png`
  - `ai-deck/tmp/stage10-step3-enter.png`
  - `ai-deck/tmp/stage10-kb-nosel-step1-click.png`
  - `ai-deck/tmp/stage10-kb-nosel-step2-type.png`
  - `ai-deck/tmp/stage10-kb-nosel-step3-enter.png`
  - `ai-deck/tmp/stage10-singlecall-pressenter.png`
  - `ai-deck/tmp/stage10-selectorflow-jackie25.png`
