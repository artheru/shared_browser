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

