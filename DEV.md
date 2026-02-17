# Shared Browser (Quick DEV Guide)

## 1) 一句话理解

Shared Browser = **一个后端托管的 Chrome 实例** + **前端实时画面** + **WebSocket 输入回放**。  
用户看到的是“远程浏览器画面”，操作会被转发到 Puppeteer/CDP 执行。

## 2) 实现思路（给人快速理解）

- **核心目标**：低门槛“共享浏览器操作能力”，同时保证会话可控、可观测、可恢复。
- **设计取舍**：
  - 用截图流（JPEG frame）代替完整远程桌面协议，复杂度更低、可控性更强。
  - 用 WebSocket 做输入事件通道，保证实时性和状态同步。
  - 后端统一托管下载/上传与 Tab 生命周期，前端只做展示和交互。
- **关键原则**：
  - 以 `targetId` 作为 tab 真实标识，避免“幽灵 tab / 重复 tab”。
  - 任何高风险状态（stream 卡死、tab 切换、下载中）都要有 fallback 和可观测日志。

## 3) 请求链路（最重要）

1. 用户登录后进入 `client/src/views/BrowserView.vue`。  
2. 前端发 `ws://.../ws`，认证后发送 `connect`。  
3. 服务端在 `server/index.js` 创建会话：
   - `browser-manager` 负责 tab / page
   - `stream-service` 负责帧流
   - `input-handler` 负责鼠标键盘回放
   - `file-service` 负责下载上传
4. 前端收到 `frame` + `tabs_updated` + 下载事件，更新 UI。

## 4) 目录与职责

- `server/index.js`: API 路由、WS 协议入口、事件编排。
- `server/browser-manager.js`: 浏览器生命周期、tab 管理、`targetId` 对齐。
- `server/stream-service.js`: 页面截图与 frame 推送、恢复策略。
- `server/input-handler.js`: 鼠标/键盘映射，含中键新标签特殊处理。
- `server/file-service.js`: 下载监听（CDP）、文件上传、文件列表。
- `client/src/views/BrowserView.vue`: 浏览器主界面、输入采集、文件面板。
- `client/src/views/AdminReport.vue`: 管理员诊断页（tab id、状态、命令）。

## 5) 本地开发与构建

```bash
npm install
cd client && npm install && cd ..
npm run dev
```

- Server: `http://localhost:3000`
- Client dev: `http://localhost:5173`

打包：

```bash
./build.ps1
```

## 6) 排障入口（高频）

- **Tab 对不齐/重复**：看 `browser-manager.js` 的 `_cleanupSessionTabs()` 与 `targetId`。
- **画面卡住**：看 `stream-service.js` 连续错误与 recover 逻辑。
- **中键开页异常**：看 `input-handler.js` middle-click fallback + `targetcreated` 同步。
- **下载为空**：先确认测试页是否真在 `127.0.0.1:8877/testpage`，再看 `file-service.js` 事件。
- **上传失败**：检查是否有 `filechooser` 或 `input[type=file]` 可用目标。

## 7) 测试页说明（8877）

- 默认测试页：`http://127.0.0.1:8877/testpage`
- 用于验证：popup、download、upload、canvas 点击。
- 若 node 版测试页脚本不存在，使用 `test-server/test_page_server.py` fallback 启动。
