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
const mcpService = require('./mcp-service');
const videoRecordingService = require('./video-recording-service');
const mcpLogger = require('./mcp-logger');
const { TOOL_DEFINITIONS, normalizeToolAccess } = require('./browser-tools-registry');
const { isUrlAllowedForUser } = require('./domain-policy');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const wsRuntime = new Map(); // `${browserId}_${userId}` -> ws connection/report stats

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
    const { username, password, isAdmin, allowedBrowsers } = req.body;
    const user = await userApi.create(username, password, isAdmin, allowedBrowsers);
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
    let browsers = browserApi.getAll();
    // Non-admin users: filter by their allowedBrowsers list
    if (!req.user.isAdmin) {
      const userRecord = userApi.getById(req.user.id);
      const allowed = userRecord?.allowedBrowsers || [];
      browsers = browsers.filter(b => allowed.includes(b.id));
    }
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
    // Non-admin users: check access permission
    if (!req.user.isAdmin) {
      const userRecord = userApi.getById(req.user.id);
      const allowed = userRecord?.allowedBrowsers || [];
      if (!allowed.includes(browser.id)) {
        return res.status(403).json({ error: 'No access to this browser' });
      }
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
    const { id, name, url, password, mcpEnabled, webApiEnabled, domainRestrictions } = req.body;
    const browser = await browserApi.create(
      id,
      name,
      url,
      password,
      mcpEnabled,
      webApiEnabled,
      domainRestrictions
    );
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

function getMcpEndpoint(req, browserId) {
  const host = req.get('host');
  const protocol = req.protocol;
  return `${protocol}://${host}${config.mcp.routePrefix}/${encodeURIComponent(browserId)}`;
}

function getMcpServerJson(req, browserId) {
  const endpoint = getMcpEndpoint(req, browserId);
  const tokenHint = '<browser-api-token>';
  return {
    mcpServers: {
      [browserId]: {
        transport: 'http',
        url: endpoint,
        headers: {
          Authorization: `Bearer ${tokenHint}`
        }
      }
    }
  };
}

function ensureBrowserReadableByUser(req, res, browserId) {
  if (req.user?.isAdmin) return true;
  const userRecord = userApi.getById(req.user?.id);
  const allowed = userRecord?.allowedBrowsers || [];
  if (!allowed.includes(browserId)) {
    res.status(403).json({ error: 'No access to this browser' });
    return false;
  }
  return true;
}

app.get('/api/browsers/:id/mcp-endpoint', authMiddleware, (req, res) => {
  const browser = browserApi.getById(req.params.id);
  if (!browser) {
    return res.status(404).json({ error: 'Browser not found' });
  }
  if (!ensureBrowserReadableByUser(req, res, browser.id)) return;
  const tokenInfo = browserApi.getAccessToken(browser.id);
  res.json({
    browserId: browser.id,
    mcpEnabled: !!browser.mcpEnabled,
    webApiEnabled: !!browser.webApiEnabled,
    apiToken: tokenInfo.apiToken,
    apiTokenUpdatedAt: tokenInfo.apiTokenUpdatedAt,
    endpoint: getMcpEndpoint(req, browser.id),
    mcpServerJson: getMcpServerJson(req, browser.id)
  });
});

app.get('/api/browsers/:id/access-token', authMiddleware, (req, res) => {
  try {
    const browser = browserApi.getById(req.params.id);
    if (!browser) return res.status(404).json({ error: 'Browser not found' });
    if (!ensureBrowserReadableByUser(req, res, browser.id)) return;
    const tokenInfo = browserApi.getAccessToken(browser.id);
    res.json({
      browserId: browser.id,
      apiToken: tokenInfo.apiToken,
      apiTokenUpdatedAt: tokenInfo.apiTokenUpdatedAt,
      tokenLength: String(tokenInfo.apiToken || '').length
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/browsers/:id/access-token/rotate', authMiddleware, (req, res) => {
  try {
    const browser = browserApi.getById(req.params.id);
    if (!browser) return res.status(404).json({ error: 'Browser not found' });
    if (!ensureBrowserReadableByUser(req, res, browser.id)) return;
    const tokenInfo = browserApi.rotateAccessToken(browser.id, 8);
    res.json({
      browserId: browser.id,
      apiToken: tokenInfo.apiToken,
      apiTokenUpdatedAt: tokenInfo.apiTokenUpdatedAt,
      tokenLength: String(tokenInfo.apiToken || '').length
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/browser-tools/catalog', authMiddleware, (req, res) => {
  res.json({
    tools: TOOL_DEFINITIONS,
    routePrefix: config.mcp.routePrefix
  });
});

app.get('/api/browsers/:id/tools-status', authMiddleware, (req, res) => {
  const browser = browserApi.getById(req.params.id);
  if (!browser) {
    return res.status(404).json({ error: 'Browser not found' });
  }
  const toolAccess = normalizeToolAccess(browser.toolAccess);
  res.json({
    browserId: browser.id,
    mcpEnabled: !!browser.mcpEnabled,
    webApiEnabled: !!browser.webApiEnabled,
    endpoint: getMcpEndpoint(req, browser.id),
    mcpServerJson: getMcpServerJson(req, browser.id),
    tools: TOOL_DEFINITIONS.map((tool) => ({
      ...tool,
      access: toolAccess[tool.id]
    }))
  });
});

app.put('/api/browsers/:id/tools-status', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const payload = {
      mcpEnabled: typeof req.body.mcpEnabled === 'boolean' ? req.body.mcpEnabled : undefined,
      webApiEnabled: typeof req.body.webApiEnabled === 'boolean' ? req.body.webApiEnabled : undefined,
      toolAccess: req.body.toolAccess
    };
    const browser = await browserApi.update(req.params.id, payload);
    res.json(browser);
  } catch (e) {
    res.status(400).json({ error: e.message });
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

app.get('/api/stream-health', authMiddleware, adminMiddleware, (req, res) => {
  try {
    res.json(streamService.getHealthStatus());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/report', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const now = Date.now();
    const allBrowsers = browserApi.getAll() || [];
    const allUsers = userApi.getAll() || [];
    const userNameMap = new Map(allUsers.map(u => [String(u.id), u.username]));
    const sessionReport = browserManager.getSessionReport();
    const runtimeMap = browserManager.getBrowserRuntimeMap();
    const streamSessions = streamService.getHealthStatus().sessions || [];
    const streamByKey = new Map(streamSessions.map((s) => [`${s.browserId}_${s.userId}`, s]));

    // Helper: build WS+stream diagnostics for a session item
    function buildSessionDiagnostics(item) {
      const stream = streamByKey.get(`${item.browserId}_${item.userId}`) || null;
      const ws = wsRuntime.get(`${item.browserId}_${item.userId}`) || null;
      const wsSeenAgeMs = ws?.lastSeenAt ? (now - new Date(ws.lastSeenAt).getTime()) : null;
      const wsAttached = !!ws;
      const wsConnected = !!(wsAttached && wsSeenAgeMs !== null && wsSeenAgeMs < 15000);
      const wsRttMs = Number(ws?.wsRttMs || 0);
      const wsLastPongAgeMs = ws?.lastPongAt ? (now - new Date(ws.lastPongAt).getTime()) : null;
      const wsHealthy = !!(wsConnected && wsLastPongAgeMs !== null && wsLastPongAgeMs < 15000);
      const streamRunning = !!stream?.running;
      const gatewayToChromeOk = !!(wsHealthy && streamRunning && item.browserAlive);
      const feedbackLatencyMs = wsHealthy ? Number(ws?.feedback?.rtt || 0) : 0;
      const endpointStatusReasons = [];
      if (!wsAttached) endpointStatusReasons.push('ws_not_attached');
      if (wsAttached && !wsConnected) endpointStatusReasons.push('ws_stale');
      if (wsConnected && !wsHealthy) endpointStatusReasons.push('ws_unhealthy');
      if (!streamRunning) endpointStatusReasons.push('stream_stopped');
      if (!item.browserAlive) endpointStatusReasons.push('browser_dead');
      return {
        stream: stream ? {
          running: !!stream.running,
          fps: stream.fps || 0,
          quality: stream.quality || 0,
          chromeFps: stream.chromeFps || 0,
          clientRtt: stream.clientRtt || 0,
          pendingFrames: ws?.feedback?.pendingFrames || 0,
          bytesSent: stream.bytesSent || 0,
          avgBandwidthBps: stream.avgBandwidthBps || 0,
          avgOutputFps: stream.avgOutputFps || 0,
          consecutiveErrors: stream.consecutiveErrors || 0,
          totalErrors: stream.totalErrors || 0,
          captureTimeouts: stream.captureTimeouts || 0,
          avgCaptureDurationMs: stream.avgCaptureDurationMs || 0,
          lastCaptureDurationMs: stream.lastCaptureDurationMs || 0,
          lastSuccessAgeMs: stream.lastSuccessAgeMs || 0,
          recoveries: stream.recoveries || 0,
          streamTargetId: stream.streamTargetId || '',
          streamPageUrl: stream.streamPageUrl || '',
          framesSent: stream.framesSent || 0
        } : null,
        connection: ws ? {
          endpoint: ws.endpoint,
          clientAddress: ws.clientAddress,
          forwardedFor: ws.forwardedFor,
          userAgent: ws.userAgent,
          connectedAt: ws.connectedAt,
          lastSeenAt: ws.lastSeenAt
        } : null,
        recentUserCommands: ws?.recentUserCommands || [],
        recentChromeCommands: ws?.recentChromeCommands || [],
        endpointStatus: {
          wsConnected,
          wsHealthy,
          wsRttMs,
          wsLastPongAgeMs,
          gatewayToChromeOk,
          streamRunning,
          speedBps: Number(stream?.avgBandwidthBps || 0),
          clientRttMs: wsHealthy ? wsRttMs : 0,
          frameDelayMs: feedbackLatencyMs > 0 ? feedbackLatencyMs : 0,
          status: gatewayToChromeOk ? 'ok' : (wsConnected ? 'degraded' : 'down'),
          reasons: endpointStatusReasons,
          streamTargetId: stream?.streamTargetId || '',
          streamPageUrl: stream?.streamPageUrl || ''
        }
      };
    }

    // Build per-session diagnostics (backward compat)
    const sessions = sessionReport.map((item) => {
      return { ...item, ...buildSessionDiagnostics(item) };
    });

    const byBrowser = allBrowsers.map((browser) => {
      const browserSessions = sessions.filter((s) => s.browserId === browser.id);
      const runtime = runtimeMap.get(browser.id) || { pid: null, alive: false };

      // ===== NEW: Tab info table =====
      const allTabs = browserManager.getAllTabsForBrowser(browser.id);
      const tabsEnriched = allTabs.map(tab => {
        // Find stream info for the tab's owner
        const ownerStream = streamByKey.get(`${browser.id}_${tab.owner}`) || null;
        const isStreamingThisTab = ownerStream && tab.isActive && ownerStream.streamTargetId === tab.targetId;
        return {
          ...tab,
          ownerName: userNameMap.get(String(tab.owner)) || tab.owner,
          chromeFps: (isStreamingThisTab && ownerStream) ? (ownerStream.chromeFps || 0) : null,
          streamRunning: (isStreamingThisTab && ownerStream) ? !!ownerStream.running : false,
          // Enrich commandLog with user names
          commandLog: (tab.commandLog || []).map(cmd => ({
            ...cmd,
            whoName: userNameMap.get(String(cmd.who)) || cmd.who
          }))
        };
      });

      // ===== NEW: User list =====
      const userSessions = browserManager.getUserSessionsForBrowser(browser.id);
      const usersEnriched = userSessions.map(u => {
        const wsKey = `${browser.id}_${u.userId}`;
        const ws = wsRuntime.get(wsKey) || null;
        const stream = streamByKey.get(wsKey) || null;
        const wsSeenAgeMs = ws?.lastSeenAt ? (now - new Date(ws.lastSeenAt).getTime()) : null;
        const wsAttached = !!ws;
        const wsConnected = !!(wsAttached && wsSeenAgeMs !== null && wsSeenAgeMs < 15000);
        const wsRttMs = Number(ws?.wsRttMs || 0);
        const wsLastPongAgeMs = ws?.lastPongAt ? (now - new Date(ws.lastPongAt).getTime()) : null;
        const wsHealthy = !!(wsConnected && wsLastPongAgeMs !== null && wsLastPongAgeMs < 15000);
        return {
          ...u,
          username: userNameMap.get(String(u.userId)) || u.userId,
          wsConnected,
          wsHealthy,
          wsRttMs,
          streamRunning: !!stream?.running,
          chromeFps: stream?.chromeFps || 0,
          lastSeenAt: ws?.lastSeenAt || null,
          connectedAt: ws?.connectedAt || null
        };
      });

      return {
        browserId: browser.id,
        browserName: browser.name,
        mcpEnabled: !!browser.mcpEnabled,
        webApiEnabled: !!browser.webApiEnabled,
        process: {
          pid: runtime.pid,
          alive: runtime.alive
        },
        mcpEndpoint: getMcpEndpoint(req, browser.id),
        wsEndpoint: `${req.protocol === 'https' ? 'wss' : 'ws'}://${req.get('host')}/ws`,
        sessionCount: browserSessions.length,
        tabCount: browserSessions.reduce((sum, s) => sum + (s.tabCount || 0), 0),
        tabs: tabsEnriched,
        users: usersEnriched,
        sessions: browserSessions
      };
    });

    res.json({
      generatedAt: new Date().toISOString(),
      totalBrowsers: allBrowsers.length,
      totalSessions: sessions.length,
      byBrowser
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/stream-recover/:browserId/:userId', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { browserId, userId } = req.params;
    const page = browserManager.getActivePage(browserId, userId);
    const result = streamService.recoverSession(browserId, userId, page);
    if (!result.ok) {
      return res.status(400).json(result);
    }
    res.json({ success: true });
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

// ============== MCP API ==============

app.get('/api/mcp/calls', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 200;
    const browserId = req.query.browserId || null;
    const source = req.query.source || null;
    res.json(mcpLogger.list(limit, browserId, source));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/calllog', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 200;
    const browserId = req.query.browserId || null;
    const source = req.query.source || null;
    res.json(mcpLogger.list(limit, browserId, source));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/mcp/help', authMiddleware, (req, res) => {
  const host = req.get('host');
  const protocol = req.protocol;
  res.json({
    title: 'Shared Browser MCP/API Help',
    routePrefix: config.mcp.routePrefix,
    browserIdHint: 'Replace :browserId with a real browser id (e.g. mcp-demo, test).',
    tools: TOOL_DEFINITIONS.map((tool) => ({
      ...tool,
      endpointTemplate: `${protocol}://${host}${config.mcp.routePrefix}/:browserId/${tool.mcpPath}`
    }))
  });
});

function ensureMcpAvailable(res) {
  if (!config.mcp.enabled) {
    res.status(503).json({ error: 'MCP disabled by server config' });
    return false;
  }
  return true;
}

function ensureBrowserApiModeEnabled(res, browser) {
  if (!browser.mcpEnabled && !browser.webApiEnabled) {
    res.status(403).json({ error: 'MCP/WebAPI disabled for this browser' });
    return false;
  }
  return true;
}

function ensureToolEnabled(res, browser, toolId) {
  const access = normalizeToolAccess(browser.toolAccess);
  const tool = access[toolId];
  if (!tool || !tool.apiEnabled) {
    res.status(403).json({ error: `API disabled for tool: ${toolId}` });
    return false;
  }
  return true;
}

function ensureMcpToolEnabled(res, browser, toolId) {
  const access = normalizeToolAccess(browser.toolAccess);
  const tool = access[toolId];
  if (!tool || !tool.mcpEnabled) {
    res.status(403).json({ error: `MCP disabled for tool: ${toolId}` });
    return false;
  }
  return true;
}

function inferCallSource(req) {
  const sessionHeader = req.get('mcp-session-id') || req.get('x-mcp-session-id') || req.get('x-mcp-session');
  const userAgent = String(req.get('user-agent') || '').toLowerCase();
  if (sessionHeader || userAgent.includes('mcp')) {
    return 'mcp';
  }
  return 'api';
}

function summarizeToolResponse(tool, data) {
  if (!data || typeof data !== 'object') return data;
  switch (tool) {
    case 'screenshot':
      return {
        hasImageBase64: !!data.imageBase64,
        imageBase64Length: data.imageBase64 ? data.imageBase64.length : 0,
        width: data.width,
        height: data.height,
        format: data.format
      };
    case 'dev_html':
      return {
        url: data.url,
        title: data.title,
        htmlLength: data.html ? data.html.length : 0
      };
    case 'dev_console':
      return {
        count: Array.isArray(data.entries) ? data.entries.length : 0
      };
    case 'start_video_recording':
      return {
        fileId: data.fileId,
        filename: data.filename,
        durationSec: data.durationSec,
        size: data.size
      };
    case 'list_recorded_videos':
      return {
        count: Array.isArray(data) ? data.length : 0
      };
    case 'fetch_video':
      return {
        fileId: data.fileId,
        filename: data.filename,
        size: data.size,
        mimeType: data.mimeType,
        hasContentBase64: !!data.contentBase64,
        contentBase64Length: data.contentBase64 ? data.contentBase64.length : 0
      };
    case 'viewClipboard':
      return {
        textLength: Number(data.textLength || 0),
        hasHtml: !!data.hasHtml,
        hasFiles: !!data.hasFiles,
        source: data.source || ''
      };
    case 'paste':
      return {
        mode: data.mode || '',
        textLength: Number(data.textLength || data.pastedTextLength || 0),
        fileCount: Array.isArray(data.files) ? data.files.length : Number(data.fileCount || 0)
      };
    default:
      return data;
  }
}

function canonicalToolId(toolIdRaw) {
  const name = String(toolIdRaw || '');
  if (name === 'input') return 'keyboard';
  if (name === 'view_clipboard') return 'viewClipboard';
  if (name === 'tab_list') return 'tablist';
  if (name === 'tabs_list') return 'tabs_list';
  return name;
}

function logToolCallStart(req, browserId, tool) {
  return {
    start: Date.now(),
    entry: {
      source: inferCallSource(req),
      method: req.method,
      path: req.originalUrl,
      browserId,
      tool,
      user: req.user?.username,
      request: {
        params: req.params,
        query: req.query,
        body: req.body
      }
    }
  };
}

function logToolCallOk(callCtx, data) {
  mcpLogger.log({
    ...callCtx.entry,
    status: 'ok',
    durationMs: Date.now() - callCtx.start,
    response: summarizeToolResponse(callCtx.entry.tool, data)
  });
}

function logToolCallError(callCtx, err) {
  mcpLogger.log({
    ...callCtx.entry,
    status: 'error',
    durationMs: Date.now() - callCtx.start,
    error: err?.message || String(err),
    response: {
      error: err?.message || String(err)
    }
  });
}

function makeJsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function makeJsonRpcError(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {})
    }
  };
}

function makeToolResultContent(data) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(data)
      }
    ],
    structuredContent: data
  };
}

function makeToolErrorResult(err, toolName) {
  const message = err?.message || String(err);
  const payload = {
    error: message,
    tool: toolName || ''
  };
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload)
      }
    ],
    structuredContent: payload
  };
}

function getMcpToolSchemas() {
  return {
    screenshot: {
      type: 'object',
      properties: {
        fullPage: { type: 'boolean', description: 'Capture full page (true) or viewport only (false).' },
        useLiveFrame: { type: 'boolean', description: 'Prefer latest stream frame cache when available.' }
      },
      additionalProperties: true
    },
    pointer: {
      type: 'object',
      properties: {
        start: { type: 'object', description: 'Start point: {x, y} in page viewport coordinates.' },
        end: { type: 'object', description: 'End point for drag/move: {x, y}.' },
        startSelector: { type: 'string', description: 'CSS selector to resolve start point center.' },
        endSelector: { type: 'string', description: 'CSS selector to resolve end point center.' },
        button: { type: 'string', description: 'Mouse button: left/right/middle.' },
        clickAtEnd: { type: 'boolean', description: 'Click at end point after move.' },
        clickCount: { type: 'number', description: 'Click count when clickAtEnd=true.' },
        pressAtStart: { type: 'boolean', description: 'Press mouse button down at start.' },
        releaseAtEnd: { type: 'boolean', description: 'Release mouse button at end.' },
        wheelDeltaX: { type: 'number', description: 'Horizontal wheel delta.' },
        wheelDeltaY: { type: 'number', description: 'Vertical wheel delta.' },
        steps: { type: 'number', description: 'Interpolation steps for mouse move.' }
      },
      additionalProperties: true
    },
    keyboard: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type.' },
        selector: { type: 'string', description: 'Optional CSS selector to focus before keyboard actions.' },
        clearBefore: { type: 'boolean', description: 'Clear target value/content before typing text.' },
        delayMs: { type: 'number', description: 'Delay between keystrokes in milliseconds.' },
        key: { type: 'string', description: 'Single key to press, supports aliases like pgup/pgdn.' },
        shortcut: { type: 'string', description: 'Alias of key. Example: pgup, pgdn, esc.' },
        shortcuts: { type: 'array', description: 'Sequence of keys to press in order.', items: { type: 'string' } },
        keys: { type: 'array', description: 'Press key combo together. Example: ["Control","a"].', items: { type: 'string' } },
        combo: { type: 'array', description: 'Alias of keys for combo press.', items: { type: 'string' } },
        repeat: { type: 'number', description: 'Repeat count for single key press.' },
        pressEnter: { type: 'boolean', description: 'Press Enter after typing.' }
      },
      additionalProperties: true
    },
    paste: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Optional selector to focus before paste.' },
        text: { type: 'string', description: 'Plain text to paste.' },
        html: { type: 'string', description: 'Optional HTML clipboard content.' },
        imageBase64: { type: 'string', description: 'Optional image content in base64 (without data URL prefix).' },
        imageMimeType: { type: 'string', description: 'Image MIME type, for example image/png.' },
        imageName: { type: 'string', description: 'Filename used for pasted image.' },
        files: {
          type: 'array',
          description: 'Optional files to include in paste clipboard.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Filename shown to target page.' },
              mimeType: { type: 'string', description: 'File MIME type.' },
              contentBase64: { type: 'string', description: 'File binary in base64.' }
            },
            required: ['contentBase64'],
            additionalProperties: true
          }
        }
      },
      additionalProperties: true
    },
    viewClipboard: {
      type: 'object',
      properties: {
        captureSelection: { type: 'boolean', description: 'Capture current selected text into clipboard before reading.' }
      },
      additionalProperties: true
    },
    input: {
      type: 'object',
      description: 'Deprecated alias of keyboard.',
      properties: {
        text: { type: 'string', description: 'Text to type.' },
        selector: { type: 'string', description: 'Optional CSS selector to focus before typing.' },
        clearBefore: { type: 'boolean', description: 'Clear target value/content before typing.' },
        delayMs: { type: 'number', description: 'Delay between keystrokes in milliseconds.' },
        pressEnter: { type: 'boolean', description: 'Press Enter after typing.' }
      },
      additionalProperties: true
    },
    tabs_list: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    tablist: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    navigate: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Target URL to open in current active tab.' }
      },
      required: ['url'],
      additionalProperties: true
    },
    tabs_select: {
      type: 'object',
      properties: {
        tabIndex: { type: 'number', description: 'Target tab index to activate.' }
      },
      required: ['tabIndex'],
      additionalProperties: true
    },
    tabs_new: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Optional URL. When omitted, browser default URL is used.' }
      },
      additionalProperties: true
    },
    tabs_close: {
      type: 'object',
      properties: {
        tabIndex: { type: 'number', description: 'Tab index to close.' }
      },
      required: ['tabIndex'],
      additionalProperties: true
    },
    start_video_recording: {
      type: 'object',
      properties: {
        durationSec: { type: 'number', description: 'Recording duration in seconds. Required. Max 15s (and admin-config limit).' }
      },
      required: ['durationSec'],
      additionalProperties: true
    },
    list_recorded_videos: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    fetch_video: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: 'File ID returned by start_video_recording/list_recorded_videos.' }
      },
      required: ['fileId'],
      additionalProperties: true
    },
    downloads: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    downloads_state: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    dev_html: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    dev_console: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum console entries to return.' }
      },
      additionalProperties: true
    },
    dev_eval: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'JavaScript source code to execute in page context.' }
      },
      required: ['script'],
      additionalProperties: true
    }
  };
}

function buildMcpToolsForBrowser(browser) {
  const access = normalizeToolAccess(browser.toolAccess);
  const schemas = getMcpToolSchemas();
  return TOOL_DEFINITIONS
    .filter((tool) => {
      const conf = access[tool.id];
      return !!(conf && conf.mcpEnabled);
    })
    .map((tool) => ({
      name: tool.id,
      description: tool.description,
      inputSchema: schemas[tool.id] || { type: 'object', properties: {}, additionalProperties: true }
    }));
}

async function executeMcpToolCall(browserId, userId, toolName, args = {}) {
  const canonicalTool = canonicalToolId(toolName);
  switch (canonicalTool) {
    case 'screenshot':
      return await mcpService.screenshot(browserId, args || {}, userId);
    case 'pointer':
      return await mcpService.pointerAction(browserId, args || {}, userId);
    case 'keyboard':
      return await mcpService.keyboardInput(browserId, args || {}, userId);
    case 'paste':
      return await mcpService.paste(browserId, args || {}, userId);
    case 'viewClipboard':
      return await mcpService.viewClipboard(browserId, args || {}, userId);
    case 'tabs_list':
      await browserManager.alignActiveTab(browserId, userId);
      return browserManager.getTabList(browserId, userId);
    case 'tablist':
      await browserManager.alignActiveTab(browserId, userId);
      return browserManager.getTabList(browserId, userId);
    case 'navigate': {
      const url = String(args?.url || '').trim();
      if (!url) throw new Error('url is required');
      const page = await browserManager.navigateCurrentTab(browserId, userId, url);
      if (!page) throw new Error('Failed to navigate current tab');
      return browserManager.getTabList(browserId, userId);
    }
    case 'tabs_select': {
      const tabIndex = Number(args?.tabIndex);
      if (!Number.isFinite(tabIndex)) throw new Error('tabIndex is required');
      const page = await browserManager.switchTab(browserId, userId, tabIndex);
      if (!page) throw new Error(`Failed to switch tab: ${tabIndex}`);
      return browserManager.getTabList(browserId, userId);
    }
    case 'tabs_new': {
      const page = await browserManager.createNewTab(browserId, userId, args?.url);
      if (!page) throw new Error('Failed to create new tab');
      return browserManager.getTabList(browserId, userId);
    }
    case 'tabs_close': {
      const tabIndex = Number(args?.tabIndex);
      if (!Number.isFinite(tabIndex)) throw new Error('tabIndex is required');
      await browserManager.closeTab(browserId, userId, tabIndex);
      return browserManager.getTabList(browserId, userId);
    }
    case 'start_video_recording':
      return await videoRecordingService.startRecording(browserId, userId, args || {});
    case 'list_recorded_videos':
      return videoRecordingService.listRecordedVideos(browserId);
    case 'fetch_video': {
      const fileId = String(args?.fileId || '');
      if (!fileId) throw new Error('fileId is required');
      return videoRecordingService.getVideoBase64(browserId, fileId);
    }
    case 'downloads':
      return await mcpService.listDownloads(browserId);
    case 'downloads_state': {
      const files = fileService.getDownloadedFiles(browserId, userId);
      const active = fileService.getActiveDownloads(browserId, userId);
      return { files, active };
    }
    case 'dev_html':
      return await mcpService.getHtml(browserId, userId);
    case 'dev_console': {
      const limit = Number(args?.limit || 200);
      return mcpService.getConsole(browserId, limit);
    }
    case 'dev_eval': {
      const script = String(args?.script || '');
      if (!script) throw new Error('script is required');
      return await mcpService.evalJs(browserId, script, userId);
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// MCP JSON-RPC endpoint (single-route MCP server for each browserId)
app.get(`${config.mcp.routePrefix}/:browserId`, authMiddleware, (req, res) => {
  try {
    if (!ensureMcpAvailable(res)) return;
    const browserId = req.params.browserId;
    const browser = browserApi.getById(browserId);
    if (!browser) return res.status(404).json({ error: 'Browser not found' });
    if (!browser.mcpEnabled) return res.status(403).json({ error: 'MCP disabled for this browser' });

    res.json({
      name: 'shared-browser-mcp',
      browserId,
      endpoint: getMcpEndpoint(req, browserId),
      transport: 'http',
      protocol: 'jsonrpc-2.0',
      hint: 'Use POST with MCP JSON-RPC methods: initialize, tools/list, tools/call',
      example: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {}
        }
      }
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post(`${config.mcp.routePrefix}/:browserId`, authMiddleware, async (req, res) => {
  try {
    if (!ensureMcpAvailable(res)) return;
    const browserId = req.params.browserId;
    const browser = browserApi.getById(browserId);
    if (!browser) return res.status(404).json({ error: 'Browser not found' });
    if (!browser.mcpEnabled) return res.status(403).json({ error: 'MCP disabled for this browser' });

    const body = req.body;
    if (!body || Array.isArray(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      return res.status(400).json(makeJsonRpcError(body?.id ?? null, -32600, 'Invalid Request'));
    }

    const method = body.method;
    const hasId = Object.prototype.hasOwnProperty.call(body, 'id');
    const id = hasId ? body.id : null;
    const params = body.params || {};

    if (method === 'initialize') {
      return res.json(makeJsonRpcResult(id, {
        protocolVersion: params.protocolVersion || '2024-11-05',
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: 'shared-browser-mcp',
          version: String(versionInfo.version || 'unknown')
        }
      }));
    }

    if (method === 'notifications/initialized' && !hasId) {
      // JSON-RPC notification: no response body to avoid client transport confusion.
      return res.status(202).end();
    }

    if (String(method).startsWith('notifications/') && !hasId) {
      return res.status(202).end();
    }

    if (method === 'notifications/initialized') {
      return res.json(makeJsonRpcResult(id, {}));
    }

    if (method === 'ping') {
      return res.json(makeJsonRpcResult(id, {}));
    }

    if (method === 'tools/list') {
      const tools = buildMcpToolsForBrowser(browser);
      return res.json(makeJsonRpcResult(id, { tools }));
    }

    if (method === 'tools/call') {
      const toolNameRaw = String(params.name || '');
      const toolName = canonicalToolId(toolNameRaw);
      if (!toolNameRaw) {
        return res.status(400).json(makeJsonRpcError(id, -32602, 'Invalid params: name is required'));
      }
      if (!ensureMcpToolEnabled(res, browser, toolName)) return;
      const callCtx = {
        start: Date.now(),
        entry: {
          source: 'mcp',
          method: 'POST',
          path: req.originalUrl,
          browserId,
          tool: toolNameRaw,
          user: req.user?.username,
          request: {
            params: req.params,
            query: req.query,
            body
          }
        }
      };
      try {
        const data = await executeMcpToolCall(browserId, req.user.id, toolNameRaw, params.arguments || {});
        logToolCallOk(callCtx, data);
        return res.json(makeJsonRpcResult(id, makeToolResultContent(data)));
      } catch (e) {
        logToolCallError(callCtx, e);
        // Tool runtime errors should be returned as tool result (isError),
        // so MCP clients do not treat them as transport/protocol failures.
        return res.json(makeJsonRpcResult(id, makeToolErrorResult(e, toolName)));
      }
    }

    return res.status(400).json(makeJsonRpcError(id, -32601, `Method not found: ${method}`));
  } catch (e) {
    return res.status(500).json(makeJsonRpcError(req.body?.id ?? null, -32000, e.message || String(e)));
  }
});

app.post(`${config.mcp.routePrefix}/:browserId/screenshot`, authMiddleware, async (req, res) => {
  const browserId = req.params.browserId;
  const callCtx = logToolCallStart(req, browserId, 'screenshot');
  try {
    if (!ensureMcpAvailable(res)) return;
    const browser = browserApi.getById(browserId);
    if (!browser) return res.status(404).json({ error: 'Browser not found' });
    if (!ensureBrowserApiModeEnabled(res, browser)) return;
    if (!ensureToolEnabled(res, browser, 'screenshot')) return;

    const data = await mcpService.screenshot(browserId, req.body || {}, req.user.id);
    logToolCallOk(callCtx, data);
    res.json(data);
  } catch (e) {
    logToolCallError(callCtx, e);
    res.status(400).json({ error: e.message });
  }
});

app.post(`${config.mcp.routePrefix}/:browserId/pointer`, authMiddleware, async (req, res) => {
  const browserId = req.params.browserId;
  const callCtx = logToolCallStart(req, browserId, 'pointer');
  try {
    if (!ensureMcpAvailable(res)) return;
    const browser = browserApi.getById(browserId);
    if (!browser) return res.status(404).json({ error: 'Browser not found' });
    if (!ensureBrowserApiModeEnabled(res, browser)) return;
    if (!ensureToolEnabled(res, browser, 'pointer')) return;

    const data = await mcpService.pointerAction(browserId, req.body || {}, req.user.id);
    if (data && data.end) {
      browserManager.updateRemoteCursor(browserId, {
        x: data.end.x,
        y: data.end.y,
        button: req.body?.button || 'left',
        source: 'webapi'
      }, req.user.id);
    }
    logToolCallOk(callCtx, data);
    res.json(data);
  } catch (e) {
    logToolCallError(callCtx, e);
    res.status(400).json({ error: e.message });
  }
});

app.post(`${config.mcp.routePrefix}/:browserId/keyboard`, authMiddleware, async (req, res) => {
  const browserId = req.params.browserId;
  const callCtx = logToolCallStart(req, browserId, 'keyboard');
  try {
    if (!ensureMcpAvailable(res)) return;
    const browser = browserApi.getById(browserId);
    if (!browser) return res.status(404).json({ error: 'Browser not found' });
    if (!ensureBrowserApiModeEnabled(res, browser)) return;
    if (!ensureToolEnabled(res, browser, 'keyboard')) return;

    const data = await mcpService.keyboardInput(browserId, req.body || {}, req.user.id);
    logToolCallOk(callCtx, data);
    res.json(data);
  } catch (e) {
    logToolCallError(callCtx, e);
    res.status(400).json({ error: e.message });
  }
});

// Backward compatibility for older clients using /input
app.post(`${config.mcp.routePrefix}/:browserId/input`, authMiddleware, async (req, res) => {
  const browserId = req.params.browserId;
  const callCtx = logToolCallStart(req, browserId, 'input');
  try {
    if (!ensureMcpAvailable(res)) return;
    const browser = browserApi.getById(browserId);
    if (!browser) return res.status(404).json({ error: 'Browser not found' });
    if (!ensureBrowserApiModeEnabled(res, browser)) return;
    if (!ensureToolEnabled(res, browser, 'keyboard')) return;

    const data = await mcpService.keyboardInput(browserId, req.body || {}, req.user.id);
    logToolCallOk(callCtx, data);
    res.json(data);
  } catch (e) {
    logToolCallError(callCtx, e);
    res.status(400).json({ error: e.message });
  }
});

app.post(`${config.mcp.routePrefix}/:browserId/paste`, authMiddleware, async (req, res) => {
  const browserId = req.params.browserId;
  const callCtx = logToolCallStart(req, browserId, 'paste');
  try {
    if (!ensureMcpAvailable(res)) return;
    const browser = browserApi.getById(browserId);
    if (!browser) return res.status(404).json({ error: 'Browser not found' });
    if (!ensureBrowserApiModeEnabled(res, browser)) return;
    if (!ensureToolEnabled(res, browser, 'paste')) return;

    const data = await mcpService.paste(browserId, req.body || {}, req.user.id);
    logToolCallOk(callCtx, data);
    res.json(data);
  } catch (e) {
    logToolCallError(callCtx, e);
    res.status(400).json({ error: e.message });
  }
});

app.get(`${config.mcp.routePrefix}/:browserId/clipboard/view`, authMiddleware, async (req, res) => {
  const browserId = req.params.browserId;
  const callCtx = logToolCallStart(req, browserId, 'viewClipboard');
  try {
    if (!ensureMcpAvailable(res)) return;
    const browser = browserApi.getById(browserId);
    if (!browser) return res.status(404).json({ error: 'Browser not found' });
    if (!ensureBrowserApiModeEnabled(res, browser)) return;
    if (!ensureToolEnabled(res, browser, 'viewClipboard')) return;

    const captureSelection = String(req.query.captureSelection || '').toLowerCase() === 'true';
    const data = await mcpService.viewClipboard(browserId, { captureSelection }, req.user.id);
    logToolCallOk(callCtx, data);
    res.json(data);
  } catch (e) {
    logToolCallError(callCtx, e);
    res.status(400).json({ error: e.message });
  }
});

app.get(`${config.mcp.routePrefix}/:browserId/tabs`, authMiddleware, async (req, res) => {
  const browserId = req.params.browserId;
  const callCtx = logToolCallStart(req, browserId, 'tabs_list');
  try {
    if (!ensureMcpAvailable(res)) return;
    const browser = browserApi.getById(browserId);
    if (!browser) return res.status(404).json({ error: 'Browser not found' });
    if (!ensureBrowserApiModeEnabled(res, browser)) return;
    if (!ensureToolEnabled(res, browser, 'tabs_list')) return;

    await browserManager.alignActiveTab(browserId, req.user.id);
    const data = browserManager.getTabList(browserId, req.user.id);
    logToolCallOk(callCtx, data);
    res.json(data);
  } catch (e) {
    logToolCallError(callCtx, e);
    res.status(400).json({ error: e.message });
  }
});

app.get(`${config.mcp.routePrefix}/:browserId/tablist`, authMiddleware, async (req, res) => {
  const browserId = req.params.browserId;
  const callCtx = logToolCallStart(req, browserId, 'tablist');
  try {
    if (!ensureMcpAvailable(res)) return;
    const browser = browserApi.getById(browserId);
    if (!browser) return res.status(404).json({ error: 'Browser not found' });
    if (!ensureBrowserApiModeEnabled(res, browser)) return;
    if (!ensureToolEnabled(res, browser, 'tablist')) return;

    await browserManager.alignActiveTab(browserId, req.user.id);
    const data = browserManager.getTabList(browserId, req.user.id);
    logToolCallOk(callCtx, data);
    res.json(data);
  } catch (e) {
    logToolCallError(callCtx, e);
    res.status(400).json({ error: e.message });
  }
});

app.post(`${config.mcp.routePrefix}/:browserId/navigate`, authMiddleware, async (req, res) => {
  const browserId = req.params.browserId;
  const callCtx = logToolCallStart(req, browserId, 'navigate');
  try {
    if (!ensureMcpAvailable(res)) return;
    const browser = browserApi.getById(browserId);
    if (!browser) return res.status(404).json({ error: 'Browser not found' });
    if (!ensureBrowserApiModeEnabled(res, browser)) return;
    if (!ensureToolEnabled(res, browser, 'navigate')) return;

    const url = String(req.body?.url || '').trim();
    if (!url) return res.status(400).json({ error: 'url is required' });
    await browserManager.navigateCurrentTab(browserId, req.user.id, url);
    const data = browserManager.getTabList(browserId, req.user.id);
    logToolCallOk(callCtx, data);
    res.json(data);
  } catch (e) {
    logToolCallError(callCtx, e);
    res.status(400).json({ error: e.message });
  }
});

app.post(`${config.mcp.routePrefix}/:browserId/tabs/select`, authMiddleware, async (req, res) => {
  const browserId = req.params.browserId;
  const callCtx = logToolCallStart(req, browserId, 'tabs_select');
  try {
    if (!ensureMcpAvailable(res)) return;
    const browser = browserApi.getById(browserId);
    if (!browser) return res.status(404).json({ error: 'Browser not found' });
    if (!ensureBrowserApiModeEnabled(res, browser)) return;
    if (!ensureToolEnabled(res, browser, 'tabs_select')) return;

    const tabIndex = Number(req.body?.tabIndex);
    if (!Number.isFinite(tabIndex)) return res.status(400).json({ error: 'tabIndex is required' });
    const page = await browserManager.switchTab(browserId, req.user.id, tabIndex);
    if (!page) return res.status(400).json({ error: `Failed to switch tab: ${tabIndex}` });
    const data = browserManager.getTabList(browserId, req.user.id);
    logToolCallOk(callCtx, data);
    res.json(data);
  } catch (e) {
    logToolCallError(callCtx, e);
    res.status(400).json({ error: e.message });
  }
});

app.post(`${config.mcp.routePrefix}/:browserId/tabs/new`, authMiddleware, async (req, res) => {
  const browserId = req.params.browserId;
  const callCtx = logToolCallStart(req, browserId, 'tabs_new');
  try {
    if (!ensureMcpAvailable(res)) return;
    const browser = browserApi.getById(browserId);
    if (!browser) return res.status(404).json({ error: 'Browser not found' });
    if (!ensureBrowserApiModeEnabled(res, browser)) return;
    if (!ensureToolEnabled(res, browser, 'tabs_new')) return;

    const data = await executeMcpToolCall(browserId, req.user.id, 'tabs_new', { url: req.body?.url });
    logToolCallOk(callCtx, data);
    res.json(data);
  } catch (e) {
    logToolCallError(callCtx, e);
    res.status(400).json({ error: e.message });
  }
});

app.post(`${config.mcp.routePrefix}/:browserId/tabs/close`, authMiddleware, async (req, res) => {
  const browserId = req.params.browserId;
  const callCtx = logToolCallStart(req, browserId, 'tabs_close');
  try {
    if (!ensureMcpAvailable(res)) return;
    const browser = browserApi.getById(browserId);
    if (!browser) return res.status(404).json({ error: 'Browser not found' });
    if (!ensureBrowserApiModeEnabled(res, browser)) return;
    if (!ensureToolEnabled(res, browser, 'tabs_close')) return;

    const tabIndex = Number(req.body?.tabIndex);
    if (!Number.isFinite(tabIndex)) return res.status(400).json({ error: 'tabIndex is required' });
    const data = await executeMcpToolCall(browserId, req.user.id, 'tabs_close', { tabIndex });
    logToolCallOk(callCtx, data);
    res.json(data);
  } catch (e) {
    logToolCallError(callCtx, e);
    res.status(400).json({ error: e.message });
  }
});

app.post(`${config.mcp.routePrefix}/:browserId/video/start`, authMiddleware, async (req, res) => {
  const browserId = req.params.browserId;
  const callCtx = logToolCallStart(req, browserId, 'start_video_recording');
  try {
    if (!ensureMcpAvailable(res)) return;
    const browser = browserApi.getById(browserId);
    if (!browser) return res.status(404).json({ error: 'Browser not found' });
    if (!ensureBrowserApiModeEnabled(res, browser)) return;
    if (!ensureToolEnabled(res, browser, 'start_video_recording')) return;

    const data = await videoRecordingService.startRecording(browserId, req.user.id, req.body || {});
    logToolCallOk(callCtx, data);
    res.json(data);
  } catch (e) {
    logToolCallError(callCtx, e);
    res.status(400).json({ error: e.message });
  }
});

app.get(`${config.mcp.routePrefix}/:browserId/video/list`, authMiddleware, async (req, res) => {
  const browserId = req.params.browserId;
  const callCtx = logToolCallStart(req, browserId, 'list_recorded_videos');
  try {
    if (!ensureMcpAvailable(res)) return;
    const browser = browserApi.getById(browserId);
    if (!browser) return res.status(404).json({ error: 'Browser not found' });
    if (!ensureBrowserApiModeEnabled(res, browser)) return;
    if (!ensureToolEnabled(res, browser, 'list_recorded_videos')) return;

    const data = videoRecordingService.listRecordedVideos(browserId);
    logToolCallOk(callCtx, data);
    res.json(data);
  } catch (e) {
    logToolCallError(callCtx, e);
    res.status(400).json({ error: e.message });
  }
});

app.get(`${config.mcp.routePrefix}/:browserId/video/:fileId`, authMiddleware, async (req, res) => {
  const browserId = req.params.browserId;
  const fileId = String(req.params.fileId || '');
  const callCtx = logToolCallStart(req, browserId, 'fetch_video');
  try {
    if (!ensureMcpAvailable(res)) return;
    const browser = browserApi.getById(browserId);
    if (!browser) return res.status(404).json({ error: 'Browser not found' });
    if (!ensureBrowserApiModeEnabled(res, browser)) return;
    if (!ensureToolEnabled(res, browser, 'fetch_video')) return;

    const info = videoRecordingService.getVideoFileInfo(browserId, fileId);
    logToolCallOk(callCtx, info);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', String(info.size));
    res.setHeader('Content-Disposition', `attachment; filename="${info.filename}"`);
    fs.createReadStream(info.path).pipe(res);
  } catch (e) {
    logToolCallError(callCtx, e);
    res.status(400).json({ error: e.message });
  }
});

app.get(`${config.mcp.routePrefix}/:browserId/downloads`, authMiddleware, async (req, res) => {
  const browserId = req.params.browserId;
  const callCtx = logToolCallStart(req, browserId, 'downloads');
  try {
    if (!ensureMcpAvailable(res)) return;
    const browser = browserApi.getById(browserId);
    if (!browser) return res.status(404).json({ error: 'Browser not found' });
    if (!ensureBrowserApiModeEnabled(res, browser)) return;
    if (!ensureToolEnabled(res, browser, 'downloads')) return;

    const data = await mcpService.listDownloads(browserId);
    logToolCallOk(callCtx, data);
    res.json(data);
  } catch (e) {
    logToolCallError(callCtx, e);
    res.status(400).json({ error: e.message });
  }
});

app.get(`${config.mcp.routePrefix}/:browserId/downloads/state`, authMiddleware, async (req, res) => {
  const browserId = req.params.browserId;
  const callCtx = logToolCallStart(req, browserId, 'downloads_state');
  try {
    if (!ensureMcpAvailable(res)) return;
    const browser = browserApi.getById(browserId);
    if (!browser) return res.status(404).json({ error: 'Browser not found' });
    if (!ensureBrowserApiModeEnabled(res, browser)) return;
    if (!ensureToolEnabled(res, browser, 'downloads_state')) return;

    const files = fileService.getDownloadedFiles(browserId, req.user.id);
    const active = fileService.getActiveDownloads(browserId, req.user.id);
    const data = { files, active };
    logToolCallOk(callCtx, data);
    res.json(data);
  } catch (e) {
    logToolCallError(callCtx, e);
    res.status(400).json({ error: e.message });
  }
});

app.get(`${config.mcp.routePrefix}/:browserId/dev/html`, authMiddleware, async (req, res) => {
  const browserId = req.params.browserId;
  const callCtx = logToolCallStart(req, browserId, 'dev_html');
  try {
    if (!ensureMcpAvailable(res)) return;
    const browser = browserApi.getById(browserId);
    if (!browser) return res.status(404).json({ error: 'Browser not found' });
    if (!ensureBrowserApiModeEnabled(res, browser)) return;
    if (!ensureToolEnabled(res, browser, 'dev_html')) return;

    const data = await mcpService.getHtml(browserId, req.user.id);
    logToolCallOk(callCtx, data);
    res.json(data);
  } catch (e) {
    logToolCallError(callCtx, e);
    res.status(400).json({ error: e.message });
  }
});

app.get(`${config.mcp.routePrefix}/:browserId/dev/console`, authMiddleware, async (req, res) => {
  const browserId = req.params.browserId;
  const callCtx = logToolCallStart(req, browserId, 'dev_console');
  try {
    if (!ensureMcpAvailable(res)) return;
    const browser = browserApi.getById(browserId);
    if (!browser) return res.status(404).json({ error: 'Browser not found' });
    if (!ensureBrowserApiModeEnabled(res, browser)) return;
    if (!ensureToolEnabled(res, browser, 'dev_console')) return;

    const limit = parseInt(req.query.limit, 10) || 200;
    const data = mcpService.getConsole(browserId, limit);
    logToolCallOk(callCtx, data);
    res.json(data);
  } catch (e) {
    logToolCallError(callCtx, e);
    res.status(400).json({ error: e.message });
  }
});

app.post(`${config.mcp.routePrefix}/:browserId/dev/eval`, authMiddleware, async (req, res) => {
  const browserId = req.params.browserId;
  const callCtx = logToolCallStart(req, browserId, 'dev_eval');
  try {
    if (!ensureMcpAvailable(res)) return;
    const browser = browserApi.getById(browserId);
    if (!browser) return res.status(404).json({ error: 'Browser not found' });
    if (!ensureBrowserApiModeEnabled(res, browser)) return;
    if (!ensureToolEnabled(res, browser, 'dev_eval')) return;

    const script = String(req.body?.script || '');
    if (!script) return res.status(400).json({ error: 'script is required' });
    const data = await mcpService.evalJs(browserId, script, req.user.id);
    logToolCallOk(callCtx, data);
    res.json(data);
  } catch (e) {
    logToolCallError(callCtx, e);
    res.status(400).json({ error: e.message });
  }
});

if (config.mcp.debugEnabled) {
  app.get('/mcp-debug/:browserId/screenshot', authMiddleware, async (req, res) => {
    try {
      const data = await mcpService.screenshot(req.params.browserId, { fullPage: req.query.fullPage === '1' }, req.user.id);
      res.json(data);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
}

// ============== 文件 API ==============

app.get('/api/files/:browserId', authMiddleware, (req, res) => {
  try {
    const browser = browserApi.getById(req.params.browserId);
    const isShared = !!(browser && (browser.mcpEnabled || browser.webApiEnabled));
    const files = isShared
      ? fileService.getDownloadedFilesForBrowser(req.params.browserId)
      : fileService.getDownloadedFiles(req.params.browserId, req.user.id);
    res.json(files);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/files/:browserId/active', authMiddleware, (req, res) => {
  try {
    const browser = browserApi.getById(req.params.browserId);
    const isShared = !!(browser && (browser.mcpEnabled || browser.webApiEnabled));
    const data = isShared
      ? fileService.getActiveDownloadsForBrowser(req.params.browserId)
      : fileService.getActiveDownloads(req.params.browserId, req.user.id);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/files/:browserId/:filename', authMiddleware, (req, res) => {
  try {
    const browser = browserApi.getById(req.params.browserId);
    const isShared = !!(browser && (browser.mcpEnabled || browser.webApiEnabled));
    const filePath = isShared
      ? fileService.getSharedDownloadFilePath(req.params.browserId, req.params.filename)
      : fileService.getDownloadFilePath(
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
    const browser = browserApi.getById(req.params.browserId);
    const isShared = !!(browser && (browser.mcpEnabled || browser.webApiEnabled));
    if (isShared) {
      fileService.deleteSharedDownloadedFile(req.params.browserId, req.params.filename);
    } else {
      fileService.deleteDownloadedFile(
        req.params.browserId,
        req.user.id,
        req.params.filename
      );
    }
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/files/:browserId', authMiddleware, (req, res) => {
  try {
    const browser = browserApi.getById(req.params.browserId);
    const isShared = !!(browser && (browser.mcpEnabled || browser.webApiEnabled));
    if (isShared) {
      fileService.clearBrowserDownloadDirs(req.params.browserId);
    } else {
      fileService.clearDownloadDir(req.params.browserId, req.user.id);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/files/:browserId/cancel/:guid', authMiddleware, async (req, res) => {
  try {
    const browser = browserApi.getById(req.params.browserId);
    const isShared = !!(browser && (browser.mcpEnabled || browser.webApiEnabled));
    const result = await fileService.cancelDownload(req.params.browserId, req.user.id, req.params.guid, isShared);
    res.json(result);
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
  let wsPingTimer = null;
  let warmFrameRetryTimer = null;
  let streamRecovering = false;
  let currentWsConnKey = null;

  // 安全发送消息
  function wsSend(data) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  function touchWsRuntime() {
    if (!currentWsConnKey || !wsRuntime.has(currentWsConnKey)) return;
    const item = wsRuntime.get(currentWsConnKey);
    item.lastSeenAt = new Date().toISOString();
    wsRuntime.set(currentWsConnKey, item);
  }

  // Track last N user WS commands and Chrome-dispatched commands
  // Also log to per-tab command history in browser-manager
  function logToTab(type, detail) {
    if (browserId && user) {
      browserManager.logTabCommand(browserId, user.id, type, detail);
    }
  }

  function trackUserCommand(type, detail) {
    if (!currentWsConnKey || !wsRuntime.has(currentWsConnKey)) return;
    const item = wsRuntime.get(currentWsConnKey);
    if (!item.recentUserCommands) item.recentUserCommands = [];
    item.recentUserCommands.unshift({ type, detail: detail || '', ts: new Date().toISOString() });
    if (item.recentUserCommands.length > 5) item.recentUserCommands.length = 5;
  }

  function trackChromeCommand(action, detail) {
    if (!currentWsConnKey || !wsRuntime.has(currentWsConnKey)) return;
    const item = wsRuntime.get(currentWsConnKey);
    if (!item.recentChromeCommands) item.recentChromeCommands = [];
    item.recentChromeCommands.unshift({ action, detail: detail || '', ts: new Date().toISOString() });
    if (item.recentChromeCommands.length > 5) item.recentChromeCommands.length = 5;
  }

  function startWsPingLoop() {
    if (wsPingTimer) {
      clearInterval(wsPingTimer);
      wsPingTimer = null;
    }
    const sendPing = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      wsSend({
        type: 'ws_ping',
        serverTs: Date.now()
      });
    };
    sendPing();
    wsPingTimer = setInterval(sendPing, 5000);
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
      touchWsRuntime();

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
            currentWsConnKey = `${browserId}_${user.id}`;
            wsRuntime.set(currentWsConnKey, {
              endpoint: req?.url || '/ws',
              clientAddress: req?.socket?.remoteAddress || '',
              forwardedFor: req?.headers?.['x-forwarded-for'] || '',
              userAgent: req?.headers?.['user-agent'] || '',
              connectedAt: new Date().toISOString(),
              lastSeenAt: new Date().toISOString(),
              lastPongAt: null,
              wsRttMs: 0,
              feedback: { rtt: 0, fps: 0, pendingFrames: 0 }
            });
            startWsPingLoop();

            // 创建输入处理器
            inputHandler = new InputHandler(activePage);

            // 创建串流会话
            streamSession = streamService.createSession(browserId, user.id, activePage, ws);

            // 若已有后台常驻串流缓存帧，先秒发一帧，减少首屏等待
            const sendWarmFrameIfAny = () => {
              const warmFrame = streamService.getLatestFrame(browserId);
              if (!warmFrame || ws.readyState !== WebSocket.OPEN) return false;
              try {
                ws.send(JSON.stringify({
                  type: 'frame',
                  timestamp: warmFrame.timestamp,
                  quality: warmFrame.quality,
                  size: warmFrame.size
                }));
                ws.send(warmFrame.buffer);
                return true;
              } catch (_) {
                return false;
              }
            };

            // Immediate attempt
            const sentWarmNow = sendWarmFrameIfAny();

            // Cold start: warmup stream may not have produced the first frame yet.
            // Retry briefly so users don't need to refresh the SB UI to see the first frame.
            if (!sentWarmNow) {
              if (warmFrameRetryTimer) clearInterval(warmFrameRetryTimer);
              let tries = 0;
              const maxTries = 10; // ~2s total
              warmFrameRetryTimer = setInterval(() => {
                tries += 1;
                const ok = sendWarmFrameIfAny();
                if (ok || tries >= maxTries) {
                  clearInterval(warmFrameRetryTimer);
                  warmFrameRetryTimer = null;
                }
              }, 200);
            }

            // New client: push one high-quality frame asap (best-effort, non-blocking).
            // Screencast may currently run at lower quality due to latency adaptation; the first frame
            // should still be crisp so the user does not see a blurry first impression.
            (async () => {
              try {
                if (ws.readyState !== WebSocket.OPEN) return;
                const client = await activePage.target().createCDPSession();
                try { await client.send('Page.enable'); } catch (_) {}
                const quality = 80;
                const result = await Promise.race([
                  client.send('Page.captureScreenshot', { format: 'jpeg', quality, fromSurface: true }),
                  new Promise((_, reject) => setTimeout(() => reject(new Error('HQ screenshot timeout')), 1200))
                ]);
                const buf = Buffer.from(result.data, 'base64');
                if (ws.readyState !== WebSocket.OPEN) return;
                ws.send(JSON.stringify({ type: 'frame', timestamp: Date.now(), quality, size: buf.length }));
                ws.send(buf);
              } catch (_) {
                // ignore
              }
            })();

            // 设置串流死亡回调
            streamSession.onStreamDied = (reason, detail, diagnostics = {}) => {
              logger.warn(browserId, `Stream died: ${reason}`, {
                detail,
                userId: user?.id,
                diagnostics
              });
              wsSend({
                type: 'stream_error',
                reason,
                detail,
                diagnostics,
                message: reason === 'page_closed'
                  ? `Page closed: ${detail || 'unknown'}`
                  : reason === 'browser_disconnected'
                    ? `Browser disconnected: ${detail || 'unknown'}`
                    : `Stream critical error (${reason}): ${detail || 'unknown'}`
              });

              if (!browserId || !user) return;
              if (reason !== 'too_many_errors' && reason !== 'page_closed' && reason !== 'browser_disconnected') return;
              if (streamRecovering) return;
              streamRecovering = true;
              const baseDelayMs = 350;
              const maxDelayMs = 5000;
              const getRetryDelay = (attempt) => Math.min(
                Math.floor(baseDelayMs * Math.pow(1.5, Math.max(0, attempt - 1))),
                maxDelayMs
              );
              const attemptRecover = async (attempt = 1) => {
                try {
                  if (ws.readyState !== WebSocket.OPEN) {
                    streamRecovering = false;
                    return;
                  }
                  let activePage = null;
                  try {
                    activePage = await browserManager.getPageForUser(browserId, user.id);
                  } catch (_) {
                    activePage = browserManager.getActivePage(browserId, user.id);
                  }
                  const result = streamService.recoverSession(browserId, user.id, activePage);
                  if (result.ok) {
                    wsSend({
                      type: 'stream_recovered',
                      message: 'Stream auto-recovered'
                    });
                    logger.info(browserId, `Stream auto-recovered for user ${user.id} (attempt ${attempt})`);
                    streamRecovering = false;
                    return;
                  }
                  if (attempt < 8) {
                    setTimeout(() => { attemptRecover(attempt + 1); }, getRetryDelay(attempt));
                    return;
                  }
                  logger.warn(browserId, `Stream auto-recover failed after retries: ${result.error}`);
                } catch (recoverErr) {
                  if (attempt < 8) {
                    setTimeout(() => { attemptRecover(attempt + 1); }, getRetryDelay(attempt));
                    return;
                  }
                  logger.warn(browserId, `Stream auto-recover exception after retries: ${recoverErr.message}`);
                }
                streamRecovering = false;
              };
              setTimeout(() => { attemptRecover(1); }, 300);
            };

            // 设置 Tab 事件监听
            browserManager.setEventListener(browserId, user.id, async (event) => {
              wsSend(event);
              if (event.type === 'clipboard_updated' && event.clipboard && typeof event.clipboard.text === 'string') {
                wsSend({
                  type: 'clipboard_content',
                  text: event.clipboard.text,
                  source: event.clipboard.source || 'clipboard_updated'
                });
              }

            // 当 tab 切换时，更新 stream/input 引用
            if (event.type === 'tab_switched') {
              const page = browserManager.getActivePage(browserId, user.id);
              if (page) {
                updateActivePage(page);
                mcpService.ensureClipboardHook(browserId, user.id, page)
                  .catch((e) => logger.warn(browserId, `clipboardHook(tab_switched) failed: ${e.message}`));
                // 重操作异步化，避免阻塞 tab 切换后的首帧恢复
                fileService.setupDownloadHandling(page, browserId, user.id)
                  .catch((e) => logger.warn(browserId, `setupDownloadHandling(tab_switched) failed: ${e.message}`));
                if (networkMonitor) {
                  networkMonitor.attach(page)
                    .catch((e) => logger.warn(browserId, `networkMonitor.attach(tab_switched) failed: ${e.message}`));
                }
              }
            }

              // 当新 tab 创建时（tabs_updated），为新 tab 设置文件处理
              if (event.type === 'tabs_updated') {
                const sess = browserManager.getSession(browserId, user.id);
                if (sess) {
                  for (const tab of sess.tabs) {
                    mcpService.ensureClipboardHook(browserId, user.id, tab.page)
                      .catch((e) => logger.warn(browserId, `clipboardHook(tabs_updated) failed: ${e.message}`));
                    fileService.setupDownloadHandling(tab.page, browserId, user.id)
                      .catch((e) => logger.warn(browserId, `setupDownloadHandling(tabs_updated) failed: ${e.message}`));
                  }
                }
              }

              // 处理浏览器崩溃/重启事件
              if (event.type === 'browser_crashed' || event.type === 'browser_restarted' ||
                  event.type === 'browser_restart_failed') {
                wsSend(event);
              }
            });

            // 启动串流
            streamSession.start();
            usageTracker.startSession(browserId, user.id);

            wsSend({ type: 'connected', browserId });
            wsSend({ type: 'tabs_updated', ...browserManager.getTabList(browserId, user.id) });

            // 后台完成重操作，避免阻塞连接首帧
            (async () => {
              try {
                await setupFileHandlingForAllTabs(browserId, user.id, session);
                for (const tab of session.tabs) {
                  mcpService.ensureClipboardHook(browserId, user.id, tab.page)
                    .catch((e) => logger.warn(browserId, `clipboardHook(connect) failed: ${e.message}`));
                }
                fileService.setListener(browserId, user.id, (event) => {
                  wsSend(event);
                  if (event.type === 'download_ready' || (event.type === 'download_progress' && event.state === 'completed')) {
                    usageTracker.trackDownload(browserId, user.id);
                  }
                });
              } catch (e) {
                logger.warn(browserId, `Failed to setup file handling: ${e.message}`);
              }
            })();

            (async () => {
              try {
                networkMonitor = new NetworkMonitor();
                await networkMonitor.attach(activePage);
              } catch (e) {
                logger.warn(browserId, `Failed to start network monitor: ${e.message}`);
              }
            })();

            networkStatsTimer = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN) {
                // Heal any drift between BrowserManager active tab and StreamSession page.
                // This can happen after browser restarts / target recreation where the WS stays connected
                // but the underlying Puppeteer Page object has changed.
                try {
                  const active = browserManager.getActivePage(browserId, user.id);
                  if (active && streamSession) {
                    let activeTid = '';
                    let streamTid = '';
                    try {
                      const t = active.target ? active.target() : null;
                      activeTid = (t && (t._targetId || t?._targetInfo?.targetId)) || '';
                    } catch (_) {}
                    try {
                      streamTid = (typeof streamSession._safeTargetId === 'function') ? (streamSession._safeTargetId() || '') : '';
                    } catch (_) {}
                    if (activeTid && activeTid !== streamTid) {
                      updateActivePage(active);
                    }
                  }
                } catch (_) {}

                const netStats = networkMonitor ? networkMonitor.getStats() : {};
                const strmStats = streamSession ? streamSession.getStats() : {};
                wsSend({
                  type: 'network_stats',
                  network: netStats,
                  stream: {
                    bytesSent: strmStats.bytesSent || 0,
                    framesSent: strmStats.framesSent || 0,
                    consecutiveErrors: strmStats.consecutiveErrors || 0,
                    latencyMs: Number(strmStats.clientRtt || 0),
                    quality: Number(strmStats.quality || 0),
                    scale: Number(strmStats.scale || 1.0),
                    decision: strmStats.decision || '',
                    screencastFps: Number(strmStats.screencastFps || 0),
                    allowedLatencyMs: Number(strmStats.allowedLatencyMs || 0)
                  }
                });
              }
            }, 2000);

          } catch (e) {
            logger.error(browserId, `Failed to connect browser: ${e.message}`);
            wsSend({ type: 'error', error: `Failed to connect browser: ${e.message}` });
          }
          break;
        }

        // ==================== 输入事件 ====================
        case 'input': {
          if (inputHandler) {
            if (browserId) browserManager.touchBrowser(browserId);
            const evtType = message.event?.type || 'unknown';
            // Track user command (skip high-freq mousemove)
            if (evtType !== 'mousemove') {
              trackUserCommand('input', `${evtType} x=${message.event?.x||''} y=${message.event?.y||''} key=${message.event?.key||''}`);
              logToTab('input', `${evtType} x=${message.event?.x||''} y=${message.event?.y||''} key=${message.event?.key||''}`);
            }
            if (browserId && user && message.event &&
              (message.event.type === 'mousedown' || message.event.type === 'mouseup')) {
              const pageForLog = browserManager.getActivePage(browserId, user.id);
              logger.info(browserId, `Input ${message.event.type}`, {
                userId: user.id,
                x: Number(message.event.x || 0),
                y: Number(message.event.y || 0),
                button: message.event.button,
                pageUrl: pageForLog ? pageForLog.url() : ''
              });
            }
            await inputHandler.handleEvent(message.event);
            // Track Chrome command
            if (evtType !== 'mousemove') {
              trackChromeCommand(`input.${evtType}`, `x=${message.event?.x||''} y=${message.event?.y||''} key=${message.event?.key||''}`);
            }
            if (browserId && message.event && (
              message.event.type === 'mousemove' ||
              message.event.type === 'mousedown' ||
              message.event.type === 'mouseup'
            )) {
              browserManager.updateRemoteCursor(browserId, {
                x: message.event.x,
                y: message.event.y,
                button: typeof message.event.button === 'number'
                  ? ({ 0: 'left', 1: 'middle', 2: 'right' }[message.event.button] || 'left')
                  : (message.event.button || 'left'),
                source: 'ws'
              }, user.id);
            }
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
          if (currentWsConnKey && wsRuntime.has(currentWsConnKey)) {
            const item = wsRuntime.get(currentWsConnKey);
            item.lastSeenAt = new Date().toISOString();
            item.feedback = {
              rtt: Number(message?.data?.rtt || 0),
              fps: Number(message?.data?.fps || 0),
              pendingFrames: Number(message?.data?.pendingFrames || 0)
            };
            wsRuntime.set(currentWsConnKey, item);
          }
          break;
        }

        case 'stream_recover': {
          if (browserId && user) {
            trackUserCommand('stream_recover', `reason=${message?.reason || 'manual'} idleMs=${message?.idleMs || 0}`);
            const idleMs = Number(message?.idleMs || 0);
            const reason = String(message?.reason || 'manual');
            const activePage = browserManager.getActivePage(browserId, user.id);
            const result = streamService.recoverSession(browserId, user.id, activePage);
            logger.info(browserId, 'WS stream_recover requested', {
              userId: user.id,
              reason,
              idleMs,
              ok: !!result.ok,
              error: result.error || null
            });
            if (result.ok) {
              wsSend({ type: 'stream_recovered', message: 'Stream recovered by watchdog' });
            } else {
              wsSend({ type: 'stream_error', reason: 'recover_failed', detail: result.error, message: `Stream recover failed: ${result.error}` });
            }
          }
          break;
        }

        case 'ws_pong': {
          if (currentWsConnKey && wsRuntime.has(currentWsConnKey)) {
            const now = Date.now();
            const item = wsRuntime.get(currentWsConnKey);
            const serverTs = Number(message.serverTs || 0);
            const rtt = serverTs > 0 ? Math.max(0, now - serverTs) : 0;
            item.lastSeenAt = new Date(now).toISOString();
            item.lastPongAt = new Date(now).toISOString();
            item.wsRttMs = rtt;
            wsRuntime.set(currentWsConnKey, item);
            // Use server-measured WS RTT for stream adaptation & UI stats (avoids clock skew).
            if (streamSession && typeof streamSession.updateNetworkRtt === 'function') {
              streamSession.updateNetworkRtt(rtt);
            }
          }
          break;
        }

        // ==================== URL 导航 ====================
        case 'navigate': {
          if (browserId && user) {
            trackUserCommand('navigate', message.url || '');
            logToTab('navigate', message.url || '');
            const startedAt = Date.now();
            browserManager.touchBrowser(browserId);
            const browserCfg = browserApi.getById(browserId);
            const accessCheck = isUrlAllowedForUser(message.url, browserCfg, user);
            if (!accessCheck.allowed) {
              wsSend({
                type: 'domain_blocked',
                blockedUrl: message.url || '',
                allowedDomains: browserCfg?.domainRestrictions || []
              });
              logger.warn(browserId, `Blocked navigation for non-admin user ${user.id}`, {
                url: message.url,
                allowedDomains: browserCfg?.domainRestrictions || []
              });
              break;
            }
            if (Number.isInteger(message.tabIndex)) {
              await browserManager.switchTab(browserId, user.id, Number(message.tabIndex));
            }
            const activePage = browserManager.getActivePage(browserId, user.id);
            if (activePage) {
              try {
                await activePage.goto(message.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                trackChromeCommand('page.goto', `${message.url} (${Date.now() - startedAt}ms)`);
                logger.info(browserId, `User ${user.id} navigated to ${message.url}`, {
                  elapsedMs: Date.now() - startedAt,
                  tabIndex: Number.isInteger(message.tabIndex) ? Number(message.tabIndex) : undefined
                });
                usageTracker.trackPageView(browserId, user.id);
              } catch (e) {
                trackChromeCommand('page.goto.FAIL', `${message.url}: ${e.message}`);
                logger.warn(browserId, `Navigation failed: ${e.message}`);
              }
            }
          }
          break;
        }

        // ==================== 浏览器导航（前进/后退/刷新/停止） ====================
        case 'go_back': {
          if (browserId && user) {
            trackUserCommand('go_back', '');
            logToTab('go_back', '');
            browserManager.touchBrowser(browserId);
            const activePage = browserManager.getActivePage(browserId, user.id);
            if (activePage) {
              try {
                await activePage.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
                trackChromeCommand('page.goBack', 'ok');
                usageTracker.trackPageView(browserId, user.id);
              } catch (e) {
                trackChromeCommand('page.goBack', 'no history');
              }
            }
          }
          break;
        }

        case 'go_forward': {
          if (browserId && user) {
            trackUserCommand('go_forward', '');
            logToTab('go_forward', '');
            browserManager.touchBrowser(browserId);
            const activePage = browserManager.getActivePage(browserId, user.id);
            if (activePage) {
              try {
                await activePage.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 });
                trackChromeCommand('page.goForward', 'ok');
                usageTracker.trackPageView(browserId, user.id);
              } catch (e) {
                trackChromeCommand('page.goForward', 'no history');
              }
            }
          }
          break;
        }

        case 'refresh': {
          if (browserId && user) {
            trackUserCommand('refresh', '');
            logToTab('refresh', '');
            browserManager.touchBrowser(browserId);
            const activePage = browserManager.getActivePage(browserId, user.id);
            if (activePage) {
              try {
                await activePage.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
                trackChromeCommand('page.reload', 'ok');
              } catch (e) {
                trackChromeCommand('page.reload.FAIL', e.message);
                logger.warn(browserId, `Refresh failed: ${e.message}`);
              }
            }
          }
          break;
        }

        case 'stop_loading': {
          if (browserId && user) {
            trackUserCommand('stop_loading', '');
            logToTab('stop_loading', '');
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
            const reason = String(message.reason || 'unspecified');
            if (message.refreshMeta === true) {
              await browserManager.refreshTabMeta(browserId, user.id);
            }
            const tabList = browserManager.getTabList(browserId, user.id);
            logger.info(browserId, 'Tab list requested', {
              userId: user.id,
              reason,
              refreshMeta: !!message.refreshMeta,
              tabCount: (tabList.tabs || []).length,
              activeIndex: tabList.activeIndex
            });
            wsSend({ type: 'tabs_updated', ...tabList });
          }
          break;
        }

        case 'tab_switch': {
          if (browserId && user && message.tabIndex !== undefined) {
            trackUserCommand('tab_switch', `tabIndex=${message.tabIndex}`);
            const switchStart = Date.now();
            const page = await browserManager.switchTab(browserId, user.id, message.tabIndex);
            if (page) {
              updateActivePage(page);
              wsSend({ type: 'tabs_updated', ...browserManager.getTabList(browserId, user.id) });
              fileService.setupDownloadHandling(page, browserId, user.id)
                .catch((e) => logger.warn(browserId, `setupDownloadHandling(tab_switch) failed: ${e.message}`));
              logger.info(browserId, `User ${user.id} switched tab`, {
                tabIndex: Number(message.tabIndex),
                elapsedMs: Date.now() - switchStart
              });
            }
          }
          break;
        }

        case 'tab_new': {
          if (browserId && user) {
            trackUserCommand('tab_new', message.url || 'blank');
            const createStart = Date.now();
            const browserCfg = browserApi.getById(browserId);
            if (message.url) {
              const accessCheck = isUrlAllowedForUser(message.url, browserCfg, user);
              if (!accessCheck.allowed) {
                wsSend({
                  type: 'domain_blocked',
                  blockedUrl: message.url,
                  allowedDomains: browserCfg?.domainRestrictions || []
                });
                logger.warn(browserId, `Blocked tab_new for non-admin user ${user.id}`, {
                  url: message.url,
                  allowedDomains: browserCfg?.domainRestrictions || []
                });
                break;
              }
            }
            const page = await browserManager.createNewTab(
              browserId, user.id, message.url || null
            );
            if (page) {
              updateActivePage(page);
              fileService.setupDownloadHandling(page, browserId, user.id)
                .catch((e) => logger.warn(browserId, `setupDownloadHandling(tab_new) failed: ${e.message}`));
              const tabMeta = browserManager.getTabList(browserId, user.id);
              logger.info(browserId, `User ${user.id} created tab via WS`, {
                elapsedMs: Date.now() - createStart,
                tabCount: (tabMeta.tabs || []).length,
                activeIndex: tabMeta.activeIndex
              });
            }
          }
          break;
        }

        case 'tab_close': {
          if (browserId && user && message.tabIndex !== undefined) {
            trackUserCommand('tab_close', `tabIndex=${message.tabIndex}`);
            trackChromeCommand('closeTab', `tabIndex=${message.tabIndex}`);
            await browserManager.closeTab(browserId, user.id, message.tabIndex);
            // 关闭后需要更新到新的活跃页面
            const activePage = browserManager.getActivePage(browserId, user.id);
            if (activePage) {
              updateActivePage(activePage);
            }
          }
          break;
        }

        case 'shutdown_browser': {
          if (browserId && user) {
            // For AI-controlled browsers, only admins can shutdown
            const browserCfg = browserApi.getById(browserId);
            if (browserCfg && (browserCfg.mcpEnabled || browserCfg.webApiEnabled) && !user.isAdmin) {
              wsSend({ type: 'error', error: 'Only admin can shutdown AI-controlled browsers' });
              break;
            }
            logger.info(browserId, `User ${user.id} requested shutdown_browser`);
            const result = await browserManager.shutdownUserSession(browserId, user.id);
            wsSend({ type: 'shutdown_done', ...result });
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
    if (wsPingTimer) {
      clearInterval(wsPingTimer);
      wsPingTimer = null;
    }
    if (warmFrameRetryTimer) {
      clearInterval(warmFrameRetryTimer);
      warmFrameRetryTimer = null;
    }

    if (networkMonitor) {
      await networkMonitor.detach();
      networkMonitor = null;
    }

    if (streamSession) {
      if (browserId && user) {
        streamService.stopSession(browserId, user.id);
      } else {
        streamSession.stop();
      }
    }

    if (browserId && user) {
      fileService.removeListener(browserId, user.id);
      browserManager.removeEventListener(browserId, user.id);
      usageTracker.endSession(browserId, user.id);
      // NOTE: Do NOT shutdown user session here.
      // Tabs stay alive so the user can return to the browser and resume.
      // Only the explicit "shutdown_browser" WS message closes all tabs.
    }
    if (currentWsConnKey) {
      wsRuntime.delete(currentWsConnKey);
    }
  });

  ws.on('error', (e) => {
    console.error('[WebSocket] Error:', e);
  });
});

// SPA 路由回退
app.all(`${config.mcp.routePrefix}/:browserId/*`, (req, res) => {
  res.status(404).json({
    error: 'Unknown MCP endpoint',
    hint: `Use ${config.mcp.routePrefix}/:browserId for JSON-RPC, or known tool paths from /api/mcp/help`
  });
});

app.all('/api/*', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

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
  if (config.browserDaemon && config.browserDaemon.enabled && config.browserDaemon.autoLaunchOnStart) {
    browserManager.ensureDaemonBrowsers()
      .then(() => {
        console.log('[Server] Browser daemon ensured');
      })
      .catch((e) => {
        console.warn('[Server] Browser daemon ensure failed:', e.message);
      });
  }
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
