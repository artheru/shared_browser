# VehicleHelper AI Agent 使用指南

本文档面向 AI Agent（如 Claude、GPT、Cursor Agent 等），详细说明如何通过 VehicleHelper 的 HTTP API 远程控制目标计算机。

**所有 AI 可用的接口统一在 `/api/ai/` 命名空间下。**

## 基本信息

- **服务地址**: `http://<目标机器IP>:9697`
- **协议**: HTTP REST API，所有 POST 请求体和响应均为 JSON（Content-Type: application/json）
- **认证**: AI API 默认禁用，每次服务重启后需手动启用
- **平台**: 支持 Windows 和 Linux

---

## 1. AI API 控制

```
GET  /api/ai/calls                         # 查看调用历史（最多 100 条）
POST /api/ai/calls/clear   Body: ""        # 清空调用历史
```

---

## 2. 截屏

```
POST /api/ai/screenshot                    # 返回 image/png 二进制
GET  /api/ai/screenshot                    # 同上
```

截屏是最重要的操作之一。在执行 GUI 操作前后都应截屏观察状态并验证结果。

---

## 3. 鼠标操作

坐标原点 (0,0) 在屏幕左上角，X 向右，Y 向下，单位像素。

```
POST /api/ai/mouse/move          Body: {"X": 500, "Y": 300}
POST /api/ai/mouse/click         Body: {"X": 500, "Y": 300, "Button": "left"}
POST /api/ai/mouse/doubleclick   Body: {"X": 500, "Y": 300}
POST /api/ai/mouse/drag          Body: {"X1": 100, "Y1": 100, "X2": 500, "Y2": 500}
POST /api/ai/mouse/scroll        Body: {"Delta": 3}
```

- `Button` 可选: `left`（默认）、`right`、`middle`
- `Delta` 正值向上滚动，负值向下

---

## 4. 键盘操作（GUI 全局键盘）

这些操作发送到当前焦点窗口，适用于 GUI 操作。

```
POST /api/ai/keyboard/type    Body: {"Text": "Hello World"}
POST /api/ai/keyboard/key     Body: {"Key": "Enter"}
POST /api/ai/keyboard/combo   Body: {"Keys": ["Ctrl", "c"]}
```

支持的特殊键: `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `Up`, `Down`, `Left`, `Right`, `Home`, `End`, `PageUp`, `PageDown`, `F1`-`F12`, `Ctrl`, `Alt`, `Shift`, `Win`, `Space`

组合键示例:
- `{"Keys": ["Ctrl", "c"]}` → 复制
- `{"Keys": ["Ctrl", "v"]}` → 粘贴
- `{"Keys": ["Alt", "Tab"]}` → 切换窗口
- `{"Keys": ["Alt", "F4"]}` → 关闭窗口

> **注意**: 这是全局 GUI 键盘。要向 AI Terminal 中的程序发送按键，请用 `terminal/sendkey`。

---

## 5. AI Terminal（命令行终端）

AI Terminal 是一个独立的 `cmd.exe`（Windows）/ `bash`（Linux）进程，后端持久运行。

### 终端控制

```
POST /api/ai/terminal/start    Body: ""     # 启动终端
POST /api/ai/terminal/stop     Body: ""     # 停止终端
POST /api/ai/terminal/reset    Body: ""     # 杀死所有子进程并重启
POST /api/ai/terminal/clear    Body: ""     # 清空输出缓冲区
GET  /api/ai/terminal/output                # → {"Output": "...", "IsRunning": true}
```

### 执行命令

```
POST /api/ai/terminal/execute   Body: {"Command": "dir C:\\"}
```

在终端中输入一行命令并自动回车。适用于执行单条命令。

> Windows 默认 shell 是 `cmd.exe`。执行 PowerShell 命令用:
> `{"Command": "powershell -Command \"Get-Process\""}`

### TUI 交互（终端 UI 操作）

TUI 功能让 AI 可以与终端中的交互式程序（菜单、REPL、编辑器等）进行操作。

#### 发送原始文本

直接写入 stdin，**不自动追加换行符**：

```
POST /api/ai/terminal/input     Body: {"Input": "hello"}
```

#### 发送特殊按键

```
POST /api/ai/terminal/sendkey   Body: {"Key": "Up"}
POST /api/ai/terminal/sendkey   Body: {"Key": "Ctrl+C"}
POST /api/ai/terminal/sendkey   Body: {"Key": "Enter"}
```

支持的按键:

| 类别 | 按键 |
|------|------|
| 方向键 | `Up`, `Down`, `Left`, `Right` |
| 导航键 | `Home`, `End`, `PageUp`, `PageDown`, `Insert`, `Delete` |
| 常用键 | `Enter`, `Tab`, `Escape`, `Backspace`, `Space` |
| 功能键 | `F1` - `F12` |
| Ctrl 组合 | `Ctrl+A` ~ `Ctrl+Z` |

常用 Ctrl 组合:
- `Ctrl+C` — 中断/终止程序
- `Ctrl+D` — 发送 EOF（退出 python/bash 等）
- `Ctrl+Z` — 挂起（Linux）/ EOF（Windows cmd）
- `Ctrl+L` — 清屏

#### execute vs input+sendkey

| | `terminal/execute` | `terminal/input` + `terminal/sendkey` |
|---|---|---|
| 自动换行 | 是 | 否（需手动 sendkey Enter） |
| 适用场景 | 执行完整命令 | 与交互式 TUI 程序交互 |
| 特殊按键 | 不支持 | 支持方向键、Ctrl 等 |
| 典型用例 | `dir`, `ls`, `pip install` | 菜单选择、python REPL、vim |

---

## 6. 文件管理

所有文件操作都在 `/api/ai/files/` 下，均为 POST 请求。

### 读取文本文件

```
POST /api/ai/files/read
Body: {"Path": "C:\\path\\to\\file.txt"}
→ {"Success": true, "Content": "文件内容...", "Message": "Read 123 characters"}
```

### 写入文本文件

```
POST /api/ai/files/write
Body: {"Path": "C:\\path\\to\\file.txt", "Content": "要写入的内容"}
→ {"Success": true, "Message": "Written 20 characters to ..."}
```

### 列出目录

```
POST /api/ai/files/list
Body: {"Path": "C:\\Users"}
→ {"Success": true, "Items": [{"Name": "file.txt", "Path": "C:\\...", "IsDirectory": false, "Size": 1234, "LastModified": "..."}], "Message": "Listed 10 items"}
```

### 创建目录

```
POST /api/ai/files/mkdir
Body: {"Path": "C:\\path\\to\\new_dir"}
→ {"Success": true, "Message": "Created directory: ..."}
```

### 删除文件/目录

```
POST /api/ai/files/delete
Body: {"Path": "C:\\path\\to\\target"}
→ {"Success": true, "Message": "Deleted: ..."}
```

### 重命名/移动

```
POST /api/ai/files/rename
Body: {"OldPath": "C:\\old\\path", "NewPath": "C:\\new\\path"}
→ {"Success": true, "Message": "Renamed to ..."}
```

### 上传二进制文件（Base64）

```
POST /api/ai/files/upload
Body: {"Path": "C:\\path\\to\\file.bin", "ContentBase64": "<base64编码的文件内容>"}
→ {"Success": true, "Message": "Uploaded 1024 bytes to ..."}
```

### 下载文件（Base64）

```
POST /api/ai/files/download
Body: {"Path": "C:\\path\\to\\file.bin"}
→ {"Success": true, "ContentBase64": "<base64>", "Size": 1024, "Message": "Downloaded 1024 bytes"}
```

> **提示**: 文本文件用 `read`/`write` 更方便；二进制文件（exe、图片等）用 `upload`/`download` + Base64。

---

## 7. API 总览

| 端点 | 方法 | 功能 |
|------|------|------|
| `/api/ai/enable` | POST | 启用 AI API |
| `/api/ai/disable` | POST | 禁用 AI API |
| `/api/ai/status` | GET | 查看 AI 状态 |
| `/api/ai/screenshot` | POST/GET | 截取屏幕 |
| `/api/ai/mouse/move` | POST | 移动鼠标 |
| `/api/ai/mouse/click` | POST | 点击 |
| `/api/ai/mouse/doubleclick` | POST | 双击 |
| `/api/ai/mouse/drag` | POST | 拖拽 |
| `/api/ai/mouse/scroll` | POST | 滚动 |
| `/api/ai/keyboard/type` | POST | 输入文本 |
| `/api/ai/keyboard/key` | POST | 按单个键 |
| `/api/ai/keyboard/combo` | POST | 组合键 |
| `/api/ai/terminal/start` | POST | 启动终端 |
| `/api/ai/terminal/stop` | POST | 停止终端 |
| `/api/ai/terminal/reset` | POST | 重置终端 |
| `/api/ai/terminal/clear` | POST | 清空终端输出 |
| `/api/ai/terminal/output` | GET | 获取终端输出 |
| `/api/ai/terminal/execute` | POST | 执行命令 |
| `/api/ai/terminal/input` | POST | 发送原始文本（TUI） |
| `/api/ai/terminal/sendkey` | POST | 发送特殊按键（TUI） |
| `/api/ai/files/read` | POST | 读取文本文件 |
| `/api/ai/files/write` | POST | 写入文本文件 |
| `/api/ai/files/list` | POST | 列出目录 |
| `/api/ai/files/mkdir` | POST | 创建目录 |
| `/api/ai/files/delete` | POST | 删除文件/目录 |
| `/api/ai/files/rename` | POST | 重命名/移动 |
| `/api/ai/files/upload` | POST | 上传二进制文件(Base64) |
| `/api/ai/files/download` | POST | 下载文件(Base64) |
| `/api/ai/calls` | GET | 查看调用历史 |
| `/api/ai/calls/clear` | POST | 清空调用历史 |

---

## 操作策略

### 核心工作流

```
1. POST /api/ai/enable                      ← 启用 AI
2. POST /api/ai/terminal/start              ← 启动终端（如需要）
3. 循环执行：
   ├── 截屏 → 了解当前状态
   ├── 操作（鼠标/键盘/终端/TUI/文件）
   ├── 等待（100-500ms）
   └── 截屏 → 验证结果
4. POST /api/ai/disable                     ← 完成后禁用（可选）
```

### 选择正确的工具

| 任务 | 推荐 API | 原因 |
|------|----------|------|
| 执行系统命令 | `terminal/execute` | 简单直接 |
| 操作交互式程序 | `terminal/input` + `terminal/sendkey` | 支持单字符和特殊键 |
| 中断运行中的命令 | `terminal/sendkey {"Key": "Ctrl+C"}` | 发送中断信号 |
| 终端完全卡死 | `terminal/reset` | 强制杀死并重启 |
| 操作 GUI 应用 | 鼠标 + 键盘 + 截屏 | 需配合截屏定位坐标 |
| 读写文件内容 | `files/read` / `files/write` | 比终端命令更可靠 |
| 上传/下载二进制 | `files/upload` / `files/download` | Base64 编码传输 |

### 最佳实践

1. **优先使用终端**：终端操作比鼠标点击更可靠、更快
2. **读写文件用文件API**：`files/read`/`files/write` 比终端 `type`/`echo` 更可靠
3. **操作后等待再读输出**：`execute` 后等 500ms-2s，`input`/`sendkey` 后等 200-500ms
4. **GUI 操作前截屏**：先截屏确认窗口状态，再操作，再截屏验证
5. **用键盘快捷键代替鼠标**：如 Alt+F 打开菜单比点击更可靠
6. **TUI 注意事项**：`input` 不追加换行，需手动 `sendkey Enter`
7. **JSON 字段名区分大小写**：`Command`、`Input`、`Key`、`Path`、`Content` 等首字母大写

### TUI 典型场景

#### 与 Python REPL 交互

```
terminal/execute    {"Command": "python"}
# 等待 1s
terminal/input      {"Input": "print('hello')"}
terminal/sendkey    {"Key": "Enter"}
# 等待看输出
terminal/output     → GET
# 退出
terminal/sendkey    {"Key": "Ctrl+D"}
```

#### 中断长时间命令

```
terminal/execute    {"Command": "ping -t 192.168.0.1"}
# 等待若干秒后
terminal/sendkey    {"Key": "Ctrl+C"}
```

#### Tab 自动补全

```
terminal/input      {"Input": "cd C:\\Pro"}
terminal/sendkey    {"Key": "Tab"}
# Tab 自动补全为 C:\Program Files
terminal/sendkey    {"Key": "Enter"}
```

#### 浏览命令历史

```
terminal/sendkey    {"Key": "Up"}       # 上一条命令
terminal/sendkey    {"Key": "Up"}       # 再上一条
terminal/sendkey    {"Key": "Down"}     # 下一条
terminal/sendkey    {"Key": "Enter"}    # 执行选中的命令
```

---

## 完整示例

### Python

```python
import requests, time, base64

BASE = "http://192.168.0.190:9697"

def ai(path, body=None):
    if body is not None:
        return requests.post(f"{BASE}/api/ai/{path}", json=body).json()
    return requests.get(f"{BASE}/api/ai/{path}").json()

# 启用 AI + 启动终端
ai("enable", "")
ai("terminal/start", "")
time.sleep(1)

# 执行命令
ai("terminal/execute", {"Command": "dir C:\\"})
time.sleep(2)
print(ai("terminal/output")["Output"])

# 文件操作
ai("files/write", {"Path": "C:\\test.txt", "Content": "Hello AI!"})
result = ai("files/read", {"Path": "C:\\test.txt"})
print(result["Content"])  # "Hello AI!"

# 上传二进制
data = base64.b64encode(b"binary data").decode()
ai("files/upload", {"Path": "C:\\test.bin", "ContentBase64": data})

# 下载
dl = ai("files/download", {"Path": "C:\\test.bin"})
print(base64.b64decode(dl["ContentBase64"]))  # b"binary data"

# TUI: 与交互式程序对话
ai("terminal/input", {"Input": "echo hello"})
ai("terminal/sendkey", {"Key": "Enter"})
time.sleep(1)
print(ai("terminal/output")["Output"])

# 截屏
screenshot = requests.post(f"{BASE}/api/ai/screenshot")
with open("screen.png", "wb") as f:
    f.write(screenshot.content)

# 清理
ai("files/delete", {"Path": "C:\\test.txt"})
ai("files/delete", {"Path": "C:\\test.bin"})
```

---

## 常见问题

| 问题 | 解决 |
|------|------|
| "AI API is not enabled" | `POST /api/ai/enable` |
| "Terminal is not running" | `POST /api/ai/terminal/start` |
| 终端输出为空 | 命令还在执行，多等一会再 GET output |
| 终端被阻塞 | `sendkey {"Key":"Ctrl+C"}` 或 `terminal/reset` |
| 鼠标/键盘无效 | 先截屏确认窗口状态，点击激活目标窗口 |
| "Unknown key" | 检查按键名拼写（参考支持列表） |
| self-update 后无法连接 | 服务重启中，等 5-10 秒 |
| 文件读写中文乱码 | files/read 和 files/write 使用 UTF-8 编码 |
