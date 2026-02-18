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

