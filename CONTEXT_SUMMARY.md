# CONTEXT_SUMMARY

## 2026-02-18
- Goal: rollback WebRTC (stability/robustness not acceptable for remote control) and keep previously-correct UX/features working.
- Local repo: updated client/server to address post-rollback requirements:
  - MCP/API help split to `/tools-help/mcp` vs `/tools-help/api`
  - Domain restriction: preflight navigation blocking + H5 warning toast (no `alert()`)
  - Keyboard input: add hidden text-bridge textarea for reliable text/IME input; keep mobile keyboard button
  - UI: removed Status entry from header (Report kept)
- Remote deploy: updated `192.168.0.190` (`C:\\shared-browser`) to build `2026.02.18-201633`.
- Verification: `/api/version` OK + `/api/mcp` loop OK; evidence saved under `ai-deck/tmp/deploy-verify-20260218-201633/`.
- Follow-up: addressed startup blank/connecting and intermittent keyboard issues; remote updated to `2026.02.18-204828`.
- Transport: switched stream adaptation to latency-driven policy (Q80@720p when <=100ms; degrade to Q20 then 360p floor); remote updated to `2026.02.18-212723`.
- Debug: fixed WS connect hang (page probe timeout) + switched stream to `Page.startScreencast`; remote updated to `2026.02.18-214935`.
- Transport fix: keep Chrome at 720p; downsample stream output via `Page.startScreencast(maxWidth/maxHeight)` (no `page.setViewport()` scaling). UI shows server latency + decision like `Q20x0.6`; remote updated to `2026.02.18-220251`.
- Stream UX: status bar shows stream downlink bandwidth + screencast FPS; adaptation threshold uses `max(100ms, 1000/FPS)`; remote updated to `2026.02.18-222513` (evidence: `ai-deck/tmp/deploy-verify-20260218-222513/`).
- Stability fix: high-refresh pages (`clock.zone`) could cause huge "latency" and high CPU due to unthrottled screencast delivery + clock-skew RTT bug + stream page drift after restarts.
  - Server now throttles screencast decode/delivery to target FPS, drops when WS backpressured, and has a watchdog to restart screencast / fall back to screenshot loop if frames stall.
  - RTT is now derived from server WS ping/pong (no client/server clock skew).
  - Server periodically re-syncs StreamSession page to BrowserManager active tab to avoid stale/blank frames after restart/shutdown.
  - Remote deploy: pushed updated server JS via VehicleHelper file upload + restarted node via remote GUI keyboard.
- Deploy verification improvement: `build.ps1` supports embedding a phrase into `version.json` (e.g. `jackie`) so `/api/version` can confirm the correct build is running. Remote updated and verified: `2026.02.19-050408-jackie`.
- Default page behavior: new tab and "close last tab" now navigate to the browser's configured default URL (instead of leaving the user on `about:blank`). Deployed and verified with phrase: `2026.02.19-051225-jackie2`.
- Input coordinate fix: mouse coordinates are now computed from the actual stream content box (excluding letterbox/pillarbox bars under `object-fit: contain`), preventing click/move offset when the stream does not fill the container. Deployed and verified with phrase: `2026.02.20-070835-jackie3` (evidence: `ai-deck/tmp/deploy-verify-20260220-070835-jackie3/`).
- MCP server fix: implemented MCP JSON-RPC endpoint at `/api/mcp/:browserId` with `initialize`, `ping`, `tools/list`, `tools/call` (auth-required HTTP transport). Deployed and verified on `http://192.168.0.190:3000/api/mcp/test` with phrase `jackie4`.
- MCP usability enhancement: added clear parameter descriptions in MCP tool schemas and added tab control tools for both MCP and API (`tabs_list`, `tabs_select`, `tabs_new`, `tabs_close`). Deployed and verified with phrase `jackie5`.

