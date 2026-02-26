# Shared Browser - 共享浏览器

基于 Web 的远程浏览器共享系统。在服务器上运行 Chrome，通过浏览器即可远程访问和操控。

> 适用于远程桌面、自动化测试、AI 驱动 Web 操作等场景。

## 功能

- **实时串流** — 服务端 Chrome 画面实时推送到浏览器，支持自适应画质/帧率
- **输入转发** — 鼠标点击、键盘输入、滚轮滚动，远程操作如同本地
- **多浏览器实例** — 可同时运行多个独立的 Chrome 实例，各自隔离 Profile
- **多标签页** — 每个浏览器实例支持新建/切换/关闭标签页
- **导航控制** — 前进、后退、刷新、地址栏输入
- **文件传输** — 上传文件到远程浏览器、下载远程浏览器中的文件
- **用户管理** — 管理员/普通用户，JWT 认证，浏览器可设密码保护
- **中英双语** — 界面支持中文和英文切换

## 系统要求

- **Node.js** 18+
- **Chrome / Chromium**（已安装在系统中）

## 快速部署

### 1. 打包

在开发机上运行打包脚本，生成 `shared-browser.zip`：

```powershell
# Windows (PowerShell)
.\build.ps1

# Linux / macOS
bash build.sh
```

### 2. 安装

将 `shared-browser.zip` 复制到目标机器，解压后运行安装脚本：

```powershell
# Windows — 双击 install.bat 或在命令行运行：
install.bat

# Linux / macOS
bash install.sh
```

安装脚本会引导你完成：
- 检测 Node.js 和 Chrome 环境
- 安装 npm 依赖
- 配置服务端口
- 配置防火墙规则
- 启动服务

### 3. 访问

安装完成后，在浏览器中打开：

```
http://<目标机器IP>:3000
```

默认账户：`admin` / `admin123`

## 目录结构

```
shared-browser/
├── server/            # Node.js 后端
├── client/dist/       # Vue.js 前端（构建产物）
├── package.json       # 后端依赖
├── version.json       # 版本信息
├── API_REFERENCE.md   # 人类测试用 API 文档
├── build.ps1          # 打包脚本 (Windows)
├── build.sh           # 打包脚本 (Linux/macOS)
├── install.bat        # 安装脚本 (Windows)
└── install.sh         # 安装脚本 (Linux/macOS)
```

## 配置

通过环境变量自定义配置：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 服务端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `CHROME_PATH` | 系统默认路径 | Chrome 可执行文件路径 |
| `JWT_SECRET` | 内置默认值 | JWT 密钥（生产环境应修改） |

此外可在启动目录放置 `params.json`（参考 `params.example.json`）：
- 端口/监听地址（`port`、`host`）
- MCP 开关与路由前缀（`mcp.enabled`、`mcp.routePrefix`）
- MCP 调试 URL（`mcp-debug: true` 启用 `/mcp-debug/:browserId/*`）
- 浏览器空闲自动关闭（`idleClose.timeoutMs`）
- 截图超时保护（`stream.screenshotTimeoutMs`）

## 开发

```bash
# 安装依赖
npm install
cd client && npm install

# 构建前端
npm run client:build

# 启动服务
npm start
```

## API 文档

- 人类手工测试（curl/Postman）请看：`API_REFERENCE.md`
- AI/MCP 使用说明请看：`AI_USAGE.md`

## 许可证

MIT
