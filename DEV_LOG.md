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
