const path = require('path');
const fs = require('fs');

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

const params = readParamsFile();

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
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      // ====== 反自动化检测参数 ======
      '--disable-blink-features=AutomationControlled',   // 隐藏自动化标记（Blink 层）
      '--disable-features=AutomationControlled,VizDisplayCompositor,TranslateUI',  // 隐藏自动化标记（Chrome 层）+ 禁用翻译弹窗
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
    ],
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
  }
};
