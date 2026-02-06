const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cors = require('cors');

const config = require('./config');
const { login, authMiddleware, adminMiddleware, verifyWsToken, userApi, browserApi } = require('./auth');

// Read version info
let versionInfo = { version: 'unknown', buildTime: 'unknown' };
try {
  const versionPath = path.join(__dirname, '..', 'version.json');
  if (fs.existsSync(versionPath)) {
    let content = fs.readFileSync(versionPath, 'utf-8');
    // Strip UTF-8 BOM if present (PowerShell may add it)
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
    versionInfo = JSON.parse(content);
  }
} catch (e) {
  console.warn('[Server] Failed to read version.json:', e.message);
}
const browserManager = require('./browser-manager');
const streamService = require('./stream-service');
const fileService = require('./file-service');
const InputHandler = require('./input-handler');
const NetworkMonitor = require('./network-monitor');
const usageTracker = require('./usage-tracker');
const logger = require('./logger');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 中间件
app.use(cors());
app.use(express.json());

// 静态文件服务（生产环境）
app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));

// 文件上传配置
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxFileSize }
});

// ============== Version API ==============
app.get('/api/version', (req, res) => {
  res.json(versionInfo);
});

// ============== 认证 API ==============

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await login(username, password);
    res.json(result);
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

app.get('/api/auth/verify', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// ============== 用户管理 API ==============

app.get('/api/users', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const users = userApi.getAll();
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { username, password, isAdmin } = req.body;
    const user = await userApi.create(username, password, isAdmin);
    res.json(user);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const user = await userApi.update(req.params.id, req.body);
    res.json(user);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  try {
    userApi.delete(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ============== 浏览器管理 API ==============

app.get('/api/browsers', authMiddleware, (req, res) => {
  try {
    const browsers = browserApi.getAll();
    res.json(browsers);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/browsers/:id', authMiddleware, (req, res) => {
  try {
    const browser = browserApi.getById(req.params.id);
    if (!browser) {
      return res.status(404).json({ error: 'Browser not found' });
    }
    res.json(browser);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/browsers/:id/verify', authMiddleware, async (req, res) => {
  try {
    const { password } = req.body;
    const valid = await browserApi.verifyPassword(req.params.id, password);
    res.json({ valid });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/browsers', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { id, name, url, password } = req.body;
    const browser = await browserApi.create(id, name, url, password);
    res.json(browser);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/browsers/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const browser = await browserApi.update(req.params.id, req.body);
    res.json(browser);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/browsers/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await browserManager.closeBrowser(req.params.id);
    browserApi.delete(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 手动重启浏览器
app.post('/api/browsers/:id/restart', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await browserManager.restartBrowser(req.params.id);
    res.json({ success: true, message: 'Browser restarted' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/status', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const status = browserManager.getStatus();
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============== 用量统计 API ==============

app.get('/api/usage', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const stats = usageTracker.getAllStats();
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============== 日志 API ==============

// 获取所有浏览器的最新日志（合并按时间排序）
app.get('/api/logs', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 200;
    const logs = logger.getRecentLogs(limit);
    res.json(logs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 获取某个浏览器的日志
app.get('/api/logs/:browserId', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 200;
    const level = req.query.level || null;
    const logs = logger.getLogs(req.params.browserId, limit, level);
    res.json(logs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 清除某个浏览器的日志
app.delete('/api/logs/:browserId', authMiddleware, adminMiddleware, (req, res) => {
  try {
    logger.clearLogs(req.params.browserId);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 获取有日志的浏览器 ID 列表
app.get('/api/logs-browsers', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const browserIds = logger.getBrowserIds();
    res.json(browserIds);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============== 文件 API ==============

app.get('/api/files/:browserId', authMiddleware, (req, res) => {
  try {
    const files = fileService.getDownloadedFiles(req.params.browserId, req.user.id);
    res.json(files);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/files/:browserId/:filename', authMiddleware, (req, res) => {
  try {
    const filePath = fileService.getDownloadFilePath(
      req.params.browserId,
      req.user.id,
      req.params.filename
    );
    res.download(filePath);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.post('/api/files/:browserId/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const filePath = fileService.saveUploadedFile(req.file);
    await fileService.handleFileUpload(req.params.browserId, req.user.id, filePath);
    usageTracker.trackUpload(req.params.browserId, req.user.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 拖拽文件上传
app.post('/api/files/:browserId/drop', authMiddleware, upload.array('files', 20), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    const x = parseFloat(req.body.x) || 0;
    const y = parseFloat(req.body.y) || 0;

    // 保存文件
    const filePaths = fileService.saveUploadedFiles(req.files);

    // 获取活跃页面
    const page = browserManager.getActivePage(req.params.browserId, req.user.id);
    if (!page) {
      return res.status(400).json({ error: 'No active browser page' });
    }

    // 处理拖放
    const result = await fileService.handleDropFiles(
      req.params.browserId, req.user.id, filePaths, x, y, page
    );

    res.json({ success: true, ...result });
  } catch (e) {
    console.error('[FileService] Drag-drop upload failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/files/:browserId/:filename', authMiddleware, (req, res) => {
  try {
    fileService.deleteDownloadedFile(
      req.params.browserId,
      req.user.id,
      req.params.filename
    );
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ============== WebSocket 连接处理 ==============

wss.on('connection', async (ws, req) => {
  console.log('[WebSocket] New connection');

  let user = null;
  let browserId = null;
  let inputHandler = null;
  let streamSession = null;
  let networkMonitor = null;
  let networkStatsTimer = null;

  // 安全发送消息
  function wsSend(data) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  // 为会话中所有 tab 设置文件处理
  async function setupFileHandlingForAllTabs(bId, uId, session) {
    for (const tab of session.tabs) {
      await fileService.setupDownloadHandling(tab.page, bId, uId);
    }
  }

  // Tab 切换时更新 stream 和 input 的 page 引用
  function updateActivePage(page) {
    if (inputHandler) inputHandler.setPage(page);
    if (streamSession) streamSession.setPage(page);
  }

  ws.on('message', async (data) => {
    try {
      // 尝试解析 JSON（二进制帧不会到这里）
      const message = JSON.parse(data.toString());

      switch (message.type) {
        // ==================== 认证 ====================
        case 'auth': {
          user = verifyWsToken(message.token);
          if (!user) {
            wsSend({ type: 'error', error: 'Authentication failed' });
            ws.close();
            return;
          }
          wsSend({ type: 'auth_ok', user });
          break;
        }

        // ==================== 连接浏览器 ====================
        case 'connect': {
          if (!user) {
            wsSend({ type: 'error', error: 'Please authenticate first' });
            return;
          }

          browserId = message.browserId;

          const browserConfig = browserApi.getById(browserId);
          if (!browserConfig) {
            wsSend({ type: 'error', error: 'Browser not found' });
            return;
          }

          try {
            // 获取会话（含多 Tab）
            const session = await browserManager.getSessionForUser(browserId, user.id);
            const activePage = session.tabs[session.activeIndex].page;

            // 创建输入处理器
            inputHandler = new InputHandler(activePage);

            // 设置文件服务（所有 tab）
            await setupFileHandlingForAllTabs(browserId, user.id, session);
            fileService.setListener(browserId, user.id, (event) => {
              wsSend(event);
              // Track download completion
              if (event.type === 'download_ready' || (event.type === 'download_progress' && event.state === 'completed')) {
                usageTracker.trackDownload(browserId, user.id);
              }
            });

            // 创建串流会话
            streamSession = streamService.createSession(browserId, user.id, activePage, ws);

            // 设置串流死亡回调
            streamSession.onStreamDied = (reason, detail) => {
              logger.warn(browserId, `Stream died: ${reason} - ${detail}`);
              wsSend({
                type: 'stream_error',
                reason,
                message: reason === 'page_closed' ? 'Page closed' :
                         reason === 'browser_disconnected' ? 'Browser disconnected, auto-restarting...' :
                         'Stream encountered a critical error'
              });
            };

            // 设置 Tab 事件监听
            browserManager.setEventListener(browserId, user.id, async (event) => {
              wsSend(event);

            // 当 tab 切换时，更新 stream/input 引用
            if (event.type === 'tab_switched') {
              const page = browserManager.getActivePage(browserId, user.id);
              if (page) {
                updateActivePage(page);
                // 为新页面设置文件处理
                await fileService.setupDownloadHandling(page, browserId, user.id);
                // 重新附加网络监控
                if (networkMonitor) {
                  await networkMonitor.attach(page);
                }
              }
            }

              // 当新 tab 创建时（tabs_updated），为新 tab 设置文件处理
              if (event.type === 'tabs_updated') {
                const sess = browserManager.userSessions.get(`${browserId}_${user.id}`);
                if (sess) {
                  for (const tab of sess.tabs) {
                    await fileService.setupDownloadHandling(tab.page, browserId, user.id);
                  }
                }
              }

              // 处理浏览器崩溃/重启事件
              if (event.type === 'browser_crashed' || event.type === 'browser_restarted' ||
                  event.type === 'browser_restart_failed') {
                wsSend(event);
              }
            });

            // Start usage tracking
            usageTracker.startSession(browserId, user.id);

            wsSend({ type: 'connected', browserId });

            // 发送初始 tab 列表
            const tabList = browserManager.getTabList(browserId, user.id);
            wsSend({ type: 'tabs_updated', ...tabList });

            // 启动网络监控
            networkMonitor = new NetworkMonitor();
            await networkMonitor.attach(activePage);

            // 定时发送网络统计（每 2 秒）
            networkStatsTimer = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN) {
                const netStats = networkMonitor ? networkMonitor.getStats() : {};
                const strmStats = streamSession ? streamSession.getStats() : {};
                wsSend({
                  type: 'network_stats',
                  network: netStats,
                  stream: {
                    bytesSent: strmStats.bytesSent || 0,
                    framesSent: strmStats.framesSent || 0,
                    consecutiveErrors: strmStats.consecutiveErrors || 0
                  }
                });
              }
            }, 2000);

            // 启动串流
            streamSession.start();

          } catch (e) {
            logger.error(browserId, `Failed to connect browser: ${e.message}`);
            wsSend({ type: 'error', error: `Failed to connect browser: ${e.message}` });
          }
          break;
        }

        // ==================== 输入事件 ====================
        case 'input': {
          if (inputHandler) {
            await inputHandler.handleEvent(message.event);
            // Track usage
            if (browserId && user) {
              const evt = message.event;
              if (evt.type === 'mousemove') {
                usageTracker.trackMouseMove(browserId, user.id, evt.x, evt.y);
              } else if (evt.type === 'keydown') {
                usageTracker.trackInput(browserId, user.id);
              }
            }
          }
          break;
        }

        // ==================== 客户端反馈 ====================
        case 'feedback': {
          if (streamSession) {
            streamSession.updateFeedback(message.data);
          }
          break;
        }

        // ==================== URL 导航 ====================
        case 'navigate': {
          if (browserId && user) {
            const activePage = browserManager.getActivePage(browserId, user.id);
            if (activePage) {
              try {
                await activePage.goto(message.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                logger.info(browserId, `User ${user.id} navigated to ${message.url}`);
                usageTracker.trackPageView(browserId, user.id);
              } catch (e) {
                logger.warn(browserId, `Navigation failed: ${e.message}`);
              }
            }
          }
          break;
        }

        // ==================== 浏览器导航（前进/后退/刷新/停止） ====================
        case 'go_back': {
          if (browserId && user) {
            const activePage = browserManager.getActivePage(browserId, user.id);
            if (activePage) {
              try {
                await activePage.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
                usageTracker.trackPageView(browserId, user.id);
              } catch (e) {
                // 没有可以后退的历史记录
              }
            }
          }
          break;
        }

        case 'go_forward': {
          if (browserId && user) {
            const activePage = browserManager.getActivePage(browserId, user.id);
            if (activePage) {
              try {
                await activePage.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 });
                usageTracker.trackPageView(browserId, user.id);
              } catch (e) {
                // 没有可以前进的历史记录
              }
            }
          }
          break;
        }

        case 'refresh': {
          if (browserId && user) {
            const activePage = browserManager.getActivePage(browserId, user.id);
            if (activePage) {
              try {
                await activePage.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
              } catch (e) {
                logger.warn(browserId, `Refresh failed: ${e.message}`);
              }
            }
          }
          break;
        }

        case 'stop_loading': {
          if (browserId && user) {
            const activePage = browserManager.getActivePage(browserId, user.id);
            if (activePage) {
              try {
                // 通过 CDP 停止页面加载
                const client = await activePage.target().createCDPSession();
                await client.send('Page.stopLoading');
                await client.detach();
              } catch (e) {
                // 忽略错误
              }
            }
          }
          break;
        }

        // ==================== Tab 管理 ====================
        case 'tab_list': {
          if (browserId && user) {
            const tabList = browserManager.getTabList(browserId, user.id);
            wsSend({ type: 'tabs_updated', ...tabList });
          }
          break;
        }

        case 'tab_switch': {
          if (browserId && user && message.tabIndex !== undefined) {
            const page = await browserManager.switchTab(browserId, user.id, message.tabIndex);
            if (page) {
              updateActivePage(page);
              await fileService.setupDownloadHandling(page, browserId, user.id);
            }
          }
          break;
        }

        case 'tab_new': {
          if (browserId && user) {
            const page = await browserManager.createNewTab(
              browserId, user.id, message.url || null
            );
            if (page) {
              updateActivePage(page);
              await fileService.setupDownloadHandling(page, browserId, user.id);
            }
          }
          break;
        }

        case 'tab_close': {
          if (browserId && user && message.tabIndex !== undefined) {
            await browserManager.closeTab(browserId, user.id, message.tabIndex);
            // 关闭后需要更新到新的活跃页面
            const activePage = browserManager.getActivePage(browserId, user.id);
            if (activePage) {
              updateActivePage(activePage);
            }
          }
          break;
        }

        // ==================== 对话框响应 ====================
        case 'tab_dialog_respond': {
          if (browserId && user) {
            await browserManager.respondToDialog(
              browserId,
              user.id,
              message.tabIndex,
              message.accept,
              message.promptText
            );
          }
          break;
        }

        // ==================== 虚拟剪贴板 ====================
        case 'clipboard_copy': {
          if (browserId && user) {
            const text = await browserManager.copySelection(browserId, user.id);
            wsSend({ type: 'clipboard_content', text });
          }
          break;
        }

        case 'clipboard_paste': {
          if (browserId && user) {
            await browserManager.pasteText(browserId, user.id, message.text);
          }
          break;
        }

        case 'clipboard_cut': {
          if (browserId && user) {
            const text = await browserManager.cutSelection(browserId, user.id);
            wsSend({ type: 'clipboard_content', text });
          }
          break;
        }

        // ==================== 文件操作 ====================
        case 'file_response': {
          if (message.cancelled) {
            await fileService.cancelFileChooser(browserId, user.id);
          }
          break;
        }

        default:
          console.log(`[WebSocket] Unknown message type: ${message.type}`);
      }
    } catch (e) {
      if (e instanceof SyntaxError) {
        // 二进制数据，忽略 JSON 解析错误
        return;
      }
      console.error('[WebSocket] Message processing error:', e);
      wsSend({ type: 'error', error: e.message });
    }
  });

  ws.on('close', async () => {
    console.log('[WebSocket] Connection closed');

    if (networkStatsTimer) {
      clearInterval(networkStatsTimer);
      networkStatsTimer = null;
    }

    if (networkMonitor) {
      await networkMonitor.detach();
      networkMonitor = null;
    }

    if (streamSession) {
      streamSession.stop();
    }

    if (browserId && user) {
      fileService.removeListener(browserId, user.id);
      browserManager.removeEventListener(browserId, user.id);
      usageTracker.endSession(browserId, user.id);
    }
  });

  ws.on('error', (e) => {
    console.error('[WebSocket] Error:', e);
  });
});

// SPA 路由回退
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'dist', 'index.html'));
});

// 启动服务器
server.listen(config.port, config.host, () => {
  console.log(`[Server] Shared Browser v${versionInfo.version} (built: ${versionInfo.buildTime})`);
  console.log(`[Server] Started at http://${config.host}:${config.port}`);
  console.log(`[Server] Data directory: ${config.dataDir}`);
  console.log(`[Server] Profile directory: ${config.profilesDir}`);
  console.log(`[Server] Auto-restart: ${config.autoRestart.enabled ? 'enabled' : 'disabled'}`);

  // 启动浏览器健康检查
  browserManager.startHealthCheck();
});

// 优雅退出
process.on('SIGINT', async () => {
  console.log('\n[Server] Shutting down...');

  streamService.stopAll();
  await browserManager.closeAll();

  server.close(() => {
    console.log('[Server] Closed');
    process.exit(0);
  });
});

process.on('SIGTERM', async () => {
  console.log('\n[Server] Received SIGTERM...');

  streamService.stopAll();
  await browserManager.closeAll();

  server.close(() => {
    process.exit(0);
  });
});

// 全局未捕获异常处理
process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception:', err);
  // 不要退出进程，让服务继续运行
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Server] Unhandled promise rejection:', reason);
});
