const path = require('path');
const fs = require('fs');
const os = require('os');

function readParamsFile() {
  const candidates = [
    path.join(process.cwd(), 'params.json'),
    path.join(__dirname, '..', 'params.json')
  ];

  for (const filePath of candidates) {
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      }
    } catch (e) {
      console.warn(`[Config] Failed to read params.json at ${filePath}: ${e.message}`);
    }
  }

  return {};
}

function parseStringList(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function parsePortList(value, fallback = []) {
  const out = [];
  const seen = new Set();
  for (const raw of parseStringList(value)) {
    const port = Number(raw);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    if (seen.has(port)) continue;
    seen.add(port);
    out.push(port);
  }
  if (out.length > 0) return out;
  return fallback;
}

function getLocalIpv4Addresses() {
  const out = [];
  const seen = new Set();
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.family !== 'IPv4' || entry.internal) continue;
      const address = String(entry.address || '').trim();
      if (!address || seen.has(address)) continue;
      seen.add(address);
      out.push(address);
    }
  }
  return out;
}

function getWebGpuSecureOrigins(params) {
  const explicitOrigins = parseStringList(
    process.env.UNSAFE_WEBGPU_SECURE_ORIGINS ||
    params.puppeteer?.webgpuSecureOrigins ||
    params.puppeteer?.secureOrigins
  );
  const securePorts = parsePortList(
    process.env.UNSAFE_WEBGPU_SECURE_PORTS ||
    params.puppeteer?.webgpuSecurePorts ||
    params.puppeteer?.securePorts,
    [8081]
  );

  const origins = new Set(explicitOrigins);
  const localHosts = ['localhost', '127.0.0.1', ...getLocalIpv4Addresses()];
  for (const port of securePorts) {
    for (const host of localHosts) {
      origins.add(`http://${host}:${port}`);
    }
  }
  return Array.from(origins);
}

const params = readParamsFile();
const gpuEnabled = params.puppeteer?.enableGpu !== false;
const webgpuSecureOrigins = getWebGpuSecureOrigins(params);

const puppeteerArgs = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  // ====== 反自动化检测参数 ======
  '--disable-blink-features=AutomationControlled',   // 隐藏自动化标记（Blink 层）
  '--disable-features=AutomationControlled,TranslateUI',  // 隐藏自动化标记（Chrome 层）+ 禁用翻译弹窗
  '--disable-infobars',                              // 禁用 "Chrome正在被自动化" 信息栏
  '--disable-background-networking',                  // 减少后台网络请求
  '--disable-default-apps',                           // 禁用默认应用
  '--disable-extensions',                             // 禁用扩展（避免扩展干扰）
  '--disable-hang-monitor',                           // 禁用挂起监控
  '--disable-popup-blocking',                         // 禁用弹窗拦截
  '--disable-prompt-on-repost',                       // 禁用重新提交提示
  '--disable-sync',                                   // 禁用同步
  '--metrics-recording-only',                         // 仅记录指标
  '--no-first-run',                                   // 跳过首次运行向导
  '--password-store=basic',                           // 基本密码存储
  '--use-mock-keychain',                              // 使用模拟密钥链
  '--lang=zh-CN',
  '--window-size=1280,720',
  '--window-position=0,0'
];

if (gpuEnabled) {
  puppeteerArgs.push(
    '--enable-gpu-rasterization',
    '--enable-zero-copy',
    '--ignore-gpu-blocklist',
    '--force_high_performance_gpu'
  );
  if (webgpuSecureOrigins.length > 0) {
    puppeteerArgs.push(
      '--enable-unsafe-webgpu',
      `--unsafely-treat-insecure-origin-as-secure=${webgpuSecureOrigins.join(',')}`
    );
  }
  if (process.platform === 'win32') {
    puppeteerArgs.push('--use-angle=d3d11');
  }
} else {
  puppeteerArgs.push('--disable-accelerated-2d-canvas', '--disable-gpu');
}

module.exports = {
  // 服务器配置
  port: process.env.PORT || params.port || 3000,
  host: process.env.HOST || params.host || '0.0.0.0',  // 监听所有网络接口，允许远程访问

  // JWT 配置
  jwtSecret: process.env.JWT_SECRET || 'shared-browser-secret-key-change-in-production',
  jwtExpiresIn: '24h',

  // 数据存储路径
  dataDir: path.join(__dirname, 'data'),
  usersFile: path.join(__dirname, 'data', 'users.json'),
  browsersFile: path.join(__dirname, 'data', 'browsers.json'),

  // Chrome Profile 存储路径
  profilesDir: path.join(__dirname, '..', 'profiles'),

  // 文件上传配置
  uploadsDir: path.join(__dirname, '..', 'uploads'),
  downloadsDir: path.join(__dirname, '..', 'downloads'),
  recordingsDir: path.join(__dirname, '..', 'recordings'),
  maxFileSize: 100 * 1024 * 1024, // 100MB

  // 串流配置
  stream: {
    defaultQuality: 80,      // JPEG 质量 (1-100)
    minQuality: 20,
    maxQuality: 95,
    defaultFps: 15,          // 默认帧率
    minFps: 5,
    maxFps: 30,
    viewportWidth: 1280,
    viewportHeight: 720,
    screenshotTimeoutMs: params.stream?.screenshotTimeoutMs || 12000
  },

  // Puppeteer 配置
  puppeteer: {
    headless: 'new',  // 新版无头模式
    executablePath: process.env.CHROME_PATH ||
      (process.platform === 'win32'
        ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
        : process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : '/usr/bin/google-chrome'),
    args: puppeteerArgs,
    enableGpu: gpuEnabled,
    webgpuSecureOrigins,
    // 真实浏览器 User-Agent（匹配近期 Chrome 版本，避免被标记为过时浏览器）
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  },

  // 自动重启配置
  autoRestart: {
    enabled: true,
    maxRetries: 5,              // 最大连续重试次数
    retryDelay: 5000,           // 初始重试间隔（毫秒）
    maxRetryDelay: 60000,       // 最大重试间隔（毫秒）
    resetRetriesAfter: 300000,  // 运行稳定后重置重试计数（5分钟无崩溃）
    healthCheckInterval: 30000  // 健康检查间隔（30秒）
  },

  // 空闲关闭配置（无会话时回收浏览器）
  idleClose: {
    enabled: params.idleClose?.enabled !== false,
    timeoutMs: params.idleClose?.timeoutMs || 30 * 60 * 1000
  },

  // 浏览器常驻 daemon 配置
  browserDaemon: {
    enabled: params.browserDaemon?.enabled !== false,
    autoLaunchOnStart: params.browserDaemon?.autoLaunchOnStart !== false
  },

  // MCP 配置
  mcp: {
    enabled: params.mcp?.enabled !== false,
    routePrefix: params.mcp?.routePrefix || '/api/mcp',
    debugEnabled: !!params['mcp-debug']
  },

  // AI 视频录制配置
  recording: {
    // hard ceiling is always <= 15s even if configured larger
    maxDurationSec: Number(params.recording?.maxDurationSec || 15),
    maxSavedFiles: Number(params.recording?.maxSavedFiles || 10),
    fps: Number(params.recording?.fps || 10),
    quality: Number(params.recording?.quality || 80),
    ffmpegPath: params.recording?.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg'
  },

  // 日志轮转配置
  logging: {
    maxFileBytes: Number(params.logging?.maxFileBytes || 5 * 1024 * 1024),
    maxFiles: Number(params.logging?.maxFiles || 5)
  },

  // AI 静态 token（用于 /api/ai/* 端点，配置在 params.json 的 aiToken 字段）
  aiToken: params.aiToken || null
};
