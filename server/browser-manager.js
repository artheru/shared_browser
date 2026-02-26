const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { browserApi, userApi } = require('./auth');
const logger = require('./logger');
const streamService = require('./stream-service');
const { isUrlAllowedForUser } = require('./domain-policy');

class BrowserManager {
  constructor() {
    this.browsers = new Map();        // browserId -> Browser instance
    this.userSessions = new Map();    // `${browserId}_${userId}` -> session object
    this.eventListeners = new Map();  // `${browserId}_${userId}` -> callback
    this.browserClipboard = new Map(); // browserId -> latest clipboard payload (cross-session)
    this.cursorStates = new Map();    // browserId -> cursor state
    this.browserLastActive = new Map(); // browserId -> timestamp(ms)
    this.noOpenerSuppressionUntil = new Map(); // browserId -> timestamp(ms)
    this.tabIdSeq = 0;

    // 自动重启状态
    this.restartState = new Map();    // browserId -> { retries, lastCrash, timer, stableTimer }

    // 健康检查
    this.healthCheckTimer = null;

    // 确保 profiles 目录存在
    if (!fs.existsSync(config.profilesDir)) {
      fs.mkdirSync(config.profilesDir, { recursive: true });
    }
  }

  // ============== 反自动化检测：页面初始化 ==============

  /**
   * 对每个新页面注入反检测脚本
   * 这些脚本在页面加载前执行，伪装为真实浏览器
   * 目标：通过 Google、Cloudflare 等主流网站的机器人检测
   */
  async _setupAntiDetection(page) {
    // 设置 User-Agent（必须在 evaluateOnNewDocument 之前）
    if (config.puppeteer.userAgent) {
      await page.setUserAgent(config.puppeteer.userAgent);
    }

    // 设置额外的 HTTP 头部，模拟真实浏览器
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7'
    });

    // 在页面加载前注入反检测脚本（每次导航都会执行）
    await page.evaluateOnNewDocument(() => {
      // ====== 1. navigator.webdriver ======
      // 这是最基本的检测点，Puppeteer 默认会将其设为 true
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,  // 真实浏览器中此属性为 undefined（非 false）
        configurable: true
      });

      // 同时删除 webdriver 属性（某些检测脚本用 'webdriver' in navigator）
      // 这个在新版Chrome中不太需要，但保留兼容性
      const origGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
      Object.getOwnPropertyDescriptor = function(obj, prop) {
        if (obj === navigator && prop === 'webdriver') {
          return undefined;
        }
        return origGetOwnPropertyDescriptor.apply(this, arguments);
      };

      // ====== 2. window.chrome 对象 ======
      // Google 专门检查 chrome 对象的完整性
      if (!window.chrome) {
        window.chrome = {};
      }
      if (!window.chrome.runtime) {
        window.chrome.runtime = {
          PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
          PlatformArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
          PlatformNaclArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
          RequestUpdateCheckStatus: { THROTTLED: 'throttled', NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available' },
          OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
          OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
          connect: function() { return { onDisconnect: { addListener: function() {} } }; },
          sendMessage: function() {},
          id: undefined
        };
      }
      // 确保 chrome.app 存在
      if (!window.chrome.app) {
        window.chrome.app = {
          isInstalled: false,
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
          getDetails: function() { return null; },
          getIsInstalled: function() { return false; }
        };
      }
      // 确保 chrome.csi 和 chrome.loadTimes 存在
      if (!window.chrome.csi) {
        window.chrome.csi = function() {
          return {
            startE: Date.now(),
            onloadT: Date.now(),
            pageT: Math.random() * 1000 + 500,
            tran: 15
          };
        };
      }
      if (!window.chrome.loadTimes) {
        window.chrome.loadTimes = function() {
          return {
            commitLoadTime: Date.now() / 1000,
            connectionInfo: 'h2',
            finishDocumentLoadTime: Date.now() / 1000 + 0.1,
            finishLoadTime: Date.now() / 1000 + 0.2,
            firstPaintAfterLoadTime: 0,
            firstPaintTime: Date.now() / 1000 + 0.05,
            navigationType: 'Other',
            npnNegotiatedProtocol: 'h2',
            requestTime: Date.now() / 1000 - 0.5,
            startLoadTime: Date.now() / 1000 - 0.4,
            wasAlternateProtocolAvailable: false,
            wasFetchedViaSpdy: true,
            wasNpnNegotiated: true
          };
        };
      }

      // ====== 3. navigator.plugins ======
      // 构建更真实的 PluginArray，模拟 length 和 item() 方法
      const pluginData = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', mimeTypes: [{ type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' }] },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', mimeTypes: [{ type: 'application/pdf', suffixes: 'pdf', description: '' }] },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', mimeTypes: [{ type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable' }, { type: 'application/x-pnacl', suffixes: '', description: 'Portable Native Client Executable' }] }
      ];

      const pluginArray = Object.create(PluginArray.prototype);
      const mimeTypeArray = Object.create(MimeTypeArray.prototype);
      const allMimeTypes = [];

      pluginData.forEach((pd, i) => {
        const plugin = Object.create(Plugin.prototype);
        Object.defineProperties(plugin, {
          name: { value: pd.name, enumerable: true },
          filename: { value: pd.filename, enumerable: true },
          description: { value: pd.description, enumerable: true },
          length: { value: pd.mimeTypes.length, enumerable: true }
        });
        pd.mimeTypes.forEach((mt, j) => {
          const mimeType = Object.create(MimeType.prototype);
          Object.defineProperties(mimeType, {
            type: { value: mt.type, enumerable: true },
            suffixes: { value: mt.suffixes, enumerable: true },
            description: { value: mt.description, enumerable: true },
            enabledPlugin: { value: plugin, enumerable: true }
          });
          Object.defineProperty(plugin, j, { value: mimeType, enumerable: false });
          allMimeTypes.push(mimeType);
        });
        Object.defineProperty(pluginArray, i, { value: plugin, enumerable: false });
      });

      Object.defineProperty(pluginArray, 'length', { value: pluginData.length, enumerable: true });
      pluginArray.item = function(index) { return this[index] || null; };
      pluginArray.namedItem = function(name) {
        for (let i = 0; i < this.length; i++) { if (this[i].name === name) return this[i]; }
        return null;
      };
      pluginArray.refresh = function() {};

      allMimeTypes.forEach((mt, i) => {
        Object.defineProperty(mimeTypeArray, i, { value: mt, enumerable: false });
      });
      Object.defineProperty(mimeTypeArray, 'length', { value: allMimeTypes.length, enumerable: true });
      mimeTypeArray.item = function(index) { return this[index] || null; };
      mimeTypeArray.namedItem = function(name) {
        for (let i = 0; i < this.length; i++) { if (this[i].type === name) return this[i]; }
        return null;
      };

      Object.defineProperty(navigator, 'plugins', { get: () => pluginArray, configurable: true });
      Object.defineProperty(navigator, 'mimeTypes', { get: () => mimeTypeArray, configurable: true });

      // ====== 4. navigator.languages ======
      Object.defineProperty(navigator, 'languages', {
        get: () => ['zh-CN', 'zh', 'en-US', 'en'],
        configurable: true
      });

      // ====== 5. navigator.maxTouchPoints ======
      // 桌面浏览器通常为 0，但某些检测脚本会检查此值存在性
      if (navigator.maxTouchPoints === undefined) {
        Object.defineProperty(navigator, 'maxTouchPoints', {
          get: () => 0,
          configurable: true
        });
      }

      // ====== 6. navigator.hardwareConcurrency ======
      // 确保返回合理的 CPU 核心数（headless 模式可能返回异常值）
      Object.defineProperty(navigator, 'hardwareConcurrency', {
        get: () => 8,
        configurable: true
      });

      // ====== 7. navigator.deviceMemory ======
      // 返回合理的内存大小（GB）
      if (!navigator.deviceMemory) {
        Object.defineProperty(navigator, 'deviceMemory', {
          get: () => 8,
          configurable: true
        });
      }

      // ====== 8. permissions query ======
      const originalQuery = window.navigator.permissions?.query;
      if (originalQuery) {
        window.navigator.permissions.query = (parameters) => {
          if (parameters.name === 'notifications') {
            return Promise.resolve({ state: Notification.permission, onchange: null });
          }
          return originalQuery.call(window.navigator.permissions, parameters);
        };
      }

      // ====== 9. WebGL 指纹 ======
      // 同时处理 WebGL 和 WebGL2 上下文
      const spoofWebGLParameter = function(target) {
        const origGetParameter = target.prototype.getParameter;
        target.prototype.getParameter = function(parameter) {
          // UNMASKED_VENDOR_WEBGL
          if (parameter === 37445) return 'Intel Inc.';
          // UNMASKED_RENDERER_WEBGL
          if (parameter === 37446) return 'Intel(R) UHD Graphics 630';
          return origGetParameter.apply(this, arguments);
        };
      };
      spoofWebGLParameter(WebGLRenderingContext);
      if (typeof WebGL2RenderingContext !== 'undefined') {
        spoofWebGLParameter(WebGL2RenderingContext);
      }

      // ====== 10. window 尺寸 ======
      // headless 模式下 outerWidth/outerHeight 可能为 0
      if (window.outerWidth === 0) {
        Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });
      }
      if (window.outerHeight === 0) {
        Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 85 });
      }

      // ====== 11. navigator.connection ======
      if (!navigator.connection) {
        const connectionProxy = {
          effectiveType: '4g',
          rtt: 50,
          downlink: 10,
          saveData: false,
          onchange: null,
          addEventListener: function() {},
          removeEventListener: function() {},
          dispatchEvent: function() { return true; }
        };
        Object.defineProperty(navigator, 'connection', {
          get: () => connectionProxy,
          configurable: true
        });
      }

      // ====== 12. screen 属性 ======
      // 确保 screen 属性看起来正常
      if (screen.colorDepth === 0) {
        Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
      }
      if (screen.pixelDepth === 0) {
        Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });
      }

      // ====== 13. Notification ======
      // 确保 Notification API 存在且看起来正常
      if (typeof Notification === 'undefined') {
        window.Notification = {
          permission: 'default',
          requestPermission: function() { return Promise.resolve('default'); }
        };
      }

      // ====== 14. 阻止 iframe 内的 webdriver 检测 ======
      // 某些网站通过 iframe 检测 navigator.webdriver
      const originalAttachShadow = Element.prototype.attachShadow;
      if (originalAttachShadow) {
        Element.prototype.attachShadow = function() {
          return originalAttachShadow.apply(this, arguments);
        };
      }

      // ====== 15. 防止通过 Error stack trace 检测 Puppeteer ======
      // 某些检测脚本会检查 Error 堆栈中是否包含 puppeteer 相关路径
      const originalError = Error;
      const newError = function(...args) {
        const error = new originalError(...args);
        const originalStack = error.stack;
        if (originalStack) {
          Object.defineProperty(error, 'stack', {
            get: function() {
              return originalStack.replace(/puppeteer/gi, 'chrome-extension');
            },
            configurable: true
          });
        }
        return error;
      };
      newError.prototype = originalError.prototype;
      // 注意：不覆盖全局 Error，仅作为参考 - 全局覆盖可能导致兼容性问题

      // ====== 16. performance.now() 精度调整 ======
      // headless Chrome 中 performance.now() 精度可能异常高
      // 真实浏览器出于安全考虑会降低精度到 100μs
      // （注意：这在最新Chrome中已不需要，但保留作为额外保护）
    });

    // 设置 CDP 级别的反检测（在协议层面处理，不受页面脚本影响）
    try {
      const client = await page.target().createCDPSession();
      // 删除 webdriver 标志
      await client.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          delete navigator.__proto__.webdriver;
        `
      });
      await client.detach();
    } catch (e) {
      // 忽略 CDP 错误
    }
  }

  // ============== 浏览器生命周期 ==============

  async launchBrowser(browserId) {
    if (this.browsers.has(browserId)) {
      this.touchBrowser(browserId);
      return this.browsers.get(browserId);
    }

    const profilePath = path.join(config.profilesDir, browserId);
    if (!fs.existsSync(profilePath)) {
      fs.mkdirSync(profilePath, { recursive: true });
    }

    // 清理可能的 Chrome 锁文件（崩溃后残留）
    this._cleanupLockFiles(profilePath);

    logger.info(browserId, 'Launching browser', { profilePath });

    try {
      const executableExists = !!(config.puppeteer.executablePath && fs.existsSync(config.puppeteer.executablePath));
      const browser = await puppeteer.launch({
        headless: config.puppeteer.headless,
        executablePath: config.puppeteer.executablePath,
        userDataDir: profilePath,
        args: config.puppeteer.args,
        defaultViewport: {
          width: config.stream.viewportWidth,
          height: config.stream.viewportHeight
        },
        // 忽略 HTTPS 错误（某些站点证书问题）
        ignoreHTTPSErrors: true
      });

      // 监听浏览器断开事件
      browser.on('disconnected', () => {
        logger.warn(browserId, 'Browser process disconnected');
        this._handleBrowserDisconnect(browserId);
      });

      // 捕获中键后台开页等非 popup 场景，保持 tab 列表同步
      browser.on('targetcreated', async (target) => {
        try {
          await this._handleTargetCreated(browserId, target);
        } catch (e) {
          logger.warn(browserId, `targetcreated handler failed: ${e.message}`);
        }
      });

      this.browsers.set(browserId, browser);
      this.touchBrowser(browserId);
      await this._ensureWarmupStream(browserId, browser);

      // 标记启动成功，设置稳定计时器
      this._onBrowserStarted(browserId);

      logger.info(browserId, 'Browser launched successfully');
      return browser;
    } catch (e) {
      const details = {
        message: e.message,
        stack: e.stack,
        executablePath: config.puppeteer.executablePath,
        executableExists: !!(config.puppeteer.executablePath && fs.existsSync(config.puppeteer.executablePath)),
        headless: config.puppeteer.headless,
        profilePath
      };
      logger.error(browserId, 'Browser launch failed', details);
      const err = new Error(
        `Failed to launch browser process. executablePath="${details.executablePath}", ` +
        `executableExists=${details.executableExists}, profilePath="${profilePath}". ` +
        `Original: ${e.message}`
      );
      err.cause = e;
      throw err;
    }
  }

  async _ensureWarmupStream(browserId, browser) {
    try {
      const browserConfig = browserApi.getById(browserId);
      const targetUrl = (browserConfig && browserConfig.url) ? String(browserConfig.url) : 'about:blank';

      // Always create a fresh home page to avoid restoring previous tabs/pages after a shutdown/restart.
      const page = await browser.newPage();
      await page.setViewport({
        width: config.stream.viewportWidth,
        height: config.stream.viewportHeight
      });
      await this._setupAntiDetection(page);

      if (targetUrl && targetUrl !== 'about:blank') {
        try {
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        } catch (e) {
          logger.warn(browserId, `Warmup home navigation failed: ${e.message}`);
        }
      }

      // Close all other pages best-effort to prevent stale-page carry-over.
      try {
        const pages = await browser.pages();
        for (const p of pages) {
          if (p === page) continue;
          try { await p.close(); } catch (_) {}
        }
      } catch (_) {}

      streamService.ensureWarmupSession(browserId, page);
      logger.info(browserId, 'Warmup home page ensured', { url: targetUrl });
    } catch (e) {
      logger.warn(browserId, `Failed to ensure warmup stream: ${e.message}`);
    }
  }

  /**
   * 清理 Chrome 崩溃后残留的锁文件
   */
  _cleanupLockFiles(profilePath) {
    const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
    for (const lockFile of lockFiles) {
      const lockPath = path.join(profilePath, lockFile);
      try {
        if (fs.existsSync(lockPath)) {
          fs.unlinkSync(lockPath);
          console.log(`[BrowserManager] Cleaned lock file: ${lockPath}`);
        }
      } catch (e) {
        // 忽略删除失败
      }
    }
  }

  // ============== 自动重启机制 ==============

  _getRestartState(browserId) {
    if (!this.restartState.has(browserId)) {
      this.restartState.set(browserId, {
        retries: 0,
        lastCrash: null,
        timer: null,
        stableTimer: null
      });
    }
    return this.restartState.get(browserId);
  }

  /**
   * 浏览器启动成功后调用 —— 设置稳定计时器，到期后重置重试计数
   */
  _onBrowserStarted(browserId) {
    const state = this._getRestartState(browserId);

    // 清除之前的稳定计时器
    if (state.stableTimer) {
      clearTimeout(state.stableTimer);
    }

    // 设置稳定计时器：如果在 resetRetriesAfter 时间内没有崩溃，重置重试次数
    state.stableTimer = setTimeout(() => {
      if (state.retries > 0) {
        logger.info(browserId, `Browser running stable, resetting retry count (was: ${state.retries})`);
        state.retries = 0;
      }
    }, config.autoRestart.resetRetriesAfter);
  }

  /**
   * 处理浏览器断开连接（崩溃或意外退出）
   */
  _handleBrowserDisconnect(browserId) {
    // 清理浏览器实例和相关会话
    this.browsers.delete(browserId);

    // 收集受影响的用户会话
    const affectedSessions = [];
    for (const [key, session] of this.userSessions.entries()) {
      if (this._isBrowserSessionKey(key, browserId)) {
        affectedSessions.push(key);
      }
    }

    // 通知客户端浏览器崩溃
    this._emitEventForBrowser(browserId, {
      type: 'browser_crashed',
      message: 'Browser process disconnected, attempting auto-restart...'
    });

    // 清理会话
    for (const key of affectedSessions) {
      this.userSessions.delete(key);
    }
    this._cleanupBrowserRuntimeData(browserId);

    // 尝试自动重启
    if (config.autoRestart.enabled) {
      this._scheduleRestart(browserId, affectedSessions);
    } else {
      logger.warn(browserId, 'Auto-restart disabled, browser will not recover automatically');
    }
  }

  /**
   * 安排浏览器自动重启
   */
  _scheduleRestart(browserId, affectedSessionKeys) {
    const state = this._getRestartState(browserId);

    state.retries++;
    state.lastCrash = new Date().toISOString();

    if (state.retries > config.autoRestart.maxRetries) {
      logger.crash(browserId, `Consecutive crashes (${state.retries}) exceeded limit (${config.autoRestart.maxRetries}), stopping auto-restart`);
      // 通知所有受影响的客户端
      this._emitEventForBrowser(browserId, {
        type: 'browser_restart_failed',
        message: `Browser stopped auto-restarting after multiple crashes. Please contact admin.`
      });
      return;
    }

    // 计算退避延迟：retryDelay * 2^(retries-1)，上限 maxRetryDelay
    const delay = Math.min(
      config.autoRestart.retryDelay * Math.pow(2, state.retries - 1),
      config.autoRestart.maxRetryDelay
    );

    logger.warn(browserId, `Will auto-restart in ${delay}ms (attempt ${state.retries}/${config.autoRestart.maxRetries})`);

    // 清除之前的重启计时器
    if (state.timer) {
      clearTimeout(state.timer);
    }

    state.timer = setTimeout(async () => {
      try {
        logger.info(browserId, `Starting auto-restart...`);

        const browser = await this.launchBrowser(browserId);

        // 通知所有受影响的客户端浏览器已恢复
        this._emitEventForBrowser(browserId, {
          type: 'browser_restarted',
          message: 'Browser auto-restarted, please refresh the page to reconnect.'
        });

        logger.info(browserId, 'Auto-restart successful');
      } catch (e) {
        logger.error(browserId, 'Auto-restart failed', e.message);
        // 继续重试
        this._scheduleRestart(browserId, affectedSessionKeys);
      }
    }, delay);
  }

  /**
   * 重置某个浏览器的重启状态
   */
  resetRestartState(browserId) {
    const state = this.restartState.get(browserId);
    if (state) {
      if (state.timer) clearTimeout(state.timer);
      if (state.stableTimer) clearTimeout(state.stableTimer);
      this.restartState.delete(browserId);
    }
  }

  // ============== 健康检查 ==============

  /**
   * 启动定期健康检查
   */
  startHealthCheck() {
    if (this.healthCheckTimer) return;

    this.healthCheckTimer = setInterval(async () => {
      if (config.browserDaemon && config.browserDaemon.enabled) {
        await this.ensureDaemonBrowsers();
      }
      for (const [browserId, browser] of this.browsers.entries()) {
        try {
          // 无活跃会话时按空闲超时回收浏览器实例
          const hasSession = this.hasSessionsForBrowser(browserId);
          const lastActive = this.browserLastActive.get(browserId) || 0;
          const daemonEnabled = !!(config.browserDaemon && config.browserDaemon.enabled);
          if (!daemonEnabled && config.idleClose.enabled && !hasSession && Date.now() - lastActive > config.idleClose.timeoutMs) {
            logger.info(browserId, `Idle timeout reached (${config.idleClose.timeoutMs}ms), closing browser`);
            await this.closeBrowser(browserId);
            continue;
          }

          if (!browser.isConnected()) {
            logger.warn(browserId, 'Health check: browser disconnected');
            this._handleBrowserDisconnect(browserId);
            continue;
          }

          // 检查是否有页面仍然响应
          const pages = await browser.pages();
          if (pages.length === 0) {
            logger.warn(browserId, 'Health check: no open pages');
          }
        } catch (e) {
          logger.error(browserId, 'Health check failed', e.message);
        }
      }
    }, config.autoRestart.healthCheckInterval);
  }

  /**
   * 停止健康检查
   */
  stopHealthCheck() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  // ============== 用户会话管理（多 Tab） ==============

  // Per-user session key – each user always gets their own tab space
  _getSessionKey(browserId, userId) {
    return `${browserId}_${userId}`;
  }

  _isBrowserSessionKey(key, browserId) {
    return key.startsWith(`${browserId}_`);
  }

  _extractBrowserIdFromSessionKey(key) {
    const idx = key.indexOf('_');
    return idx === -1 ? key : key.slice(0, idx);
  }

  _extractUserIdFromSessionKey(key) {
    const idx = key.indexOf('_');
    return idx === -1 ? '' : key.slice(idx + 1);
  }

  _cleanupSessionTabs(session) {
    if (!session || !Array.isArray(session.tabs)) return;
    const seenPages = new Set();
    const seenTargetIds = new Set();
    const nextTabs = [];
    for (const tab of session.tabs) {
      if (!tab || !tab.page) continue;
      try {
        if (tab.page.isClosed && tab.page.isClosed()) continue;
      } catch (_) {}
      const targetId = String(this._safeTargetIdForPage(tab.page) || tab.targetId || '');
      if (targetId) {
        if (seenTargetIds.has(targetId)) continue;
        seenTargetIds.add(targetId);
      } else {
        if (seenPages.has(tab.page)) continue;
        seenPages.add(tab.page);
      }
      tab.targetId = targetId;
      nextTabs.push(tab);
    }
    session.tabs = nextTabs;
    if (session.tabs.length === 0) {
      session.activeIndex = 0;
      return;
    }
    if (session.activeIndex < 0 || session.activeIndex >= session.tabs.length) {
      session.activeIndex = Math.min(Math.max(0, session.activeIndex), session.tabs.length - 1);
    }
  }

  async getSessionForUser(browserId, userId) {
    const key = this._getSessionKey(browserId, userId);

    if (this.userSessions.has(key)) {
      const session = this.userSessions.get(key);
      if (session.users) session.users.add(String(userId));
      await this._syncSessionActiveIndexByFocus(browserId, userId, session);
      // 验证至少有一个可用的 tab
      if (session.tabs.length > 0) {
        try {
          // NOTE: page.evaluate() may hang indefinitely when the page is in a bad state.
          // This blocks the WS connect handshake and makes the UI look like "cannot connect".
          await this._probePageAlive(session.tabs[session.activeIndex].page);
          this.touchBrowser(browserId);
          streamService.ensureWarmupSession(browserId, session.tabs[session.activeIndex].page);
          return session;
        } catch (e) {
          // 活跃页面无效，移除它
          session.tabs.splice(session.activeIndex, 1);
          if (session.tabs.length > 0) {
            session.activeIndex = Math.min(session.activeIndex, session.tabs.length - 1);
            this.touchBrowser(browserId);
            streamService.ensureWarmupSession(browserId, session.tabs[session.activeIndex].page);
            return session;
          }
          this.userSessions.delete(key);
        }
      } else {
        this.userSessions.delete(key);
      }
    }

    // 创建新会话
    let browser = this.browsers.get(browserId);
    if (!browser) {
      browser = await this.launchBrowser(browserId);
    }
    this.touchBrowser(browserId);

    const browserConfig = browserApi.getById(browserId);

    const session = {
      browserId,
      userId: String(userId),
      tabs: [],
      activeIndex: 0,
      clipboard: '',  // 虚拟剪贴板（per-session，不污染系统剪贴板）
      clipboardMeta: null,
      creatingTab: false,
      users: new Set([String(userId)])
    };

    this.userSessions.set(key, session);

    // 尝试复用 browser 的现有空白页（仅当未被其他 session 占用时），否则创建新页面
    let page;
    const existingPages = await browser.pages();
    const reuseCandidate = existingPages.find(p => p.url() === 'about:blank' && !p.__sharedTracked);
    if (reuseCandidate) {
      page = reuseCandidate;
      await page.setViewport({
        width: config.stream.viewportWidth,
        height: config.stream.viewportHeight
      });
    } else {
      page = await browser.newPage();
      await page.setViewport({
        width: config.stream.viewportWidth,
        height: config.stream.viewportHeight
      });
    }

    // 注入反检测脚本
    await this._setupAntiDetection(page);

    // 添加第一个 tab
    this._addTabToSession(key, session, page);

    // 导航到默认 URL（异步，不阻塞首帧）
    if (browserConfig && browserConfig.url) {
      const user = this._resolveUserForTabOwner(userId);
      const check = isUrlAllowedForUser(browserConfig.url, browserConfig, user);
      if (check.allowed) {
        if (session.tabs[0]) session.tabs[0].url = browserConfig.url;
        page.goto(browserConfig.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
          .then(async () => {
            const firstTab = session.tabs[0];
            if (!firstTab || firstTab.page !== page) return;
            firstTab.title = await page.title().catch(() => 'New Tab');
            firstTab.url = page.url();
            this._emitTabsUpdated(key);
            logger.info(browserId, `User ${userId} navigated to ${browserConfig.url}`);
          })
          .catch((e) => {
            logger.warn(browserId, `Navigation failed: ${e.message}`);
          });
      } else {
        this._emitEvent(key, {
          type: 'domain_blocked',
          blockedUrl: browserConfig.url,
          allowedDomains: browserConfig?.domainRestrictions || []
        });
      }
    }

    return session;
  }

  async _syncSessionActiveIndexByFocus(browserId, userId, session) {
    if (!session || !Array.isArray(session.tabs) || session.tabs.length <= 1) return;
    const oldIndex = Math.min(
      Math.max(0, Number(session.activeIndex || 0)),
      session.tabs.length - 1
    );
    let focusedIndex = -1;

    for (let i = 0; i < session.tabs.length; i++) {
      const tab = session.tabs[i];
      if (!tab || !tab.page) continue;
      let timer = null;
      try {
        const focused = await Promise.race([
          tab.page.evaluate(() => {
            return document.hasFocus() || document.visibilityState === 'visible';
          }),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), 220);
          })
        ]);
        if (focused) {
          focusedIndex = i;
          break;
        }
      } catch (_) {
        // ignore per-tab focus probing failure
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    if (focusedIndex >= 0 && focusedIndex !== oldIndex) {
      session.activeIndex = focusedIndex;
      logger.info(browserId, 'Aligned active tab by focus probe', {
        userId,
        oldIndex,
        newIndex: focusedIndex
      });
    }
  }

  async alignActiveTab(browserId, userId) {
    const session = await this.getSessionForUser(browserId, userId);
    if (!session) return null;
    await this._syncSessionActiveIndexByFocus(browserId, userId, session);
    return session;
  }

  async _probePageAlive(page, timeoutMs = 800) {
    if (!page) throw new Error('No page');
    const run = async () => {
      // A trivial eval is enough to detect "Target closed"/detached.
      await page.evaluate(() => true);
      return true;
    };
    let timer = null;
    try {
      return await Promise.race([
        run(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`probe timeout after ${timeoutMs}ms`)), timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // 向后兼容方法：获取用户的活跃页面
  async getPageForUser(browserId, userId) {
    const session = await this.getSessionForUser(browserId, userId);
    if (!session || session.tabs.length === 0) return null;
    return session.tabs[session.activeIndex].page;
  }

  // 获取活跃页面（同步版本，不创建新会话）
  getSession(browserId, userId) {
    const key = this._getSessionKey(browserId, userId);
    return this.userSessions.get(key) || null;
  }

  getActivePage(browserId, userId) {
    const key = this._getSessionKey(browserId, userId);
    const session = this.userSessions.get(key);
    if (!session || session.tabs.length === 0) return null;
    this.touchBrowser(browserId);
    streamService.ensureWarmupSession(browserId, session.tabs[session.activeIndex].page);
    return session.tabs[session.activeIndex].page;
  }

  async getAnyPage(browserId) {
    // 优先返回活跃会话页面
    for (const [key, session] of this.userSessions.entries()) {
      if (!this._isBrowserSessionKey(key, browserId)) continue;
      if (session.tabs.length > 0) {
        this.touchBrowser(browserId);
        streamService.ensureWarmupSession(browserId, session.tabs[session.activeIndex].page);
        return session.tabs[session.activeIndex].page;
      }
    }

    // 没有会话时，尝试返回浏览器已有页面
    const browser = this.browsers.get(browserId);
    if (!browser) return null;
    const pages = await browser.pages();
    if (pages.length === 0) return null;
    this.touchBrowser(browserId);
    streamService.ensureWarmupSession(browserId, pages[0]);
    return pages[0];
  }

  _findSessionByPage(browserId, page) {
    for (const [key, session] of this.userSessions.entries()) {
      if (!this._isBrowserSessionKey(key, browserId)) continue;
      const idx = session.tabs.findIndex((tab) => tab.page === page);
      if (idx !== -1) return { key, session, tabIndex: idx };
    }
    return null;
  }

  async _handleTargetCreated(browserId, target) {
    if (!target || target.type() !== 'page') return;
    const newPage = await target.page();
    if (!newPage || newPage.__sharedTracked) return;
    if (newPage.isClosed && newPage.isClosed()) return;
    let initialUrl = '';
    try {
      initialUrl = newPage.url() || '';
    } catch (_) {}

    const openerTarget = target.opener();
    if (!openerTarget || openerTarget.type() !== 'page') {
      if (initialUrl === 'about:blank') {
        // Some middle-click/new-window flows are created as about:blank first.
        // Wait briefly for URL stabilization before deciding to ignore.
        await new Promise((resolve) => setTimeout(resolve, 900));
        if (newPage.isClosed && newPage.isClosed()) return;
        try {
          initialUrl = newPage.url() || '';
        } catch (_) {
          initialUrl = '';
        }
        if (initialUrl === 'about:blank') return;
      }
      const suppressUntil = this.noOpenerSuppressionUntil.get(browserId) || 0;
      if (Date.now() < suppressUntil) {
        // Ignore transient no-opener targets right after programmatic new tab creation.
        logger.info(browserId, 'Ignored no-opener target during suppression window');
        return;
      }
      // 部分 middle click/新窗口场景可能没有 opener，若该浏览器仅一个会话则归属该会话
      const sessions = [];
      for (const [key, session] of this.userSessions.entries()) {
        if (this._isBrowserSessionKey(key, browserId)) sessions.push({ key, session });
      }
      if (sessions.length === 1) {
        const { key, session } = sessions[0];
        await new Promise((resolve) => setTimeout(resolve, 900));
        if (newPage.isClosed && newPage.isClosed()) return;
        let stableUrl = '';
        try {
          stableUrl = newPage.url() || '';
        } catch (_) {}
        if (!stableUrl || stableUrl === 'about:blank') {
          logger.info(browserId, 'Ignored no-opener target without stable URL');
          return;
        }
        const activeTab = session.tabs[session.activeIndex];
        const activeUrl = activeTab && activeTab.url ? activeTab.url : '';
        // Do not drop same-URL tabs: middle-click/open-in-new-tab may legitimately
        // create a background tab with URL identical to the active tab.
        if (activeUrl && stableUrl === activeUrl) {
          logger.info(browserId, 'No-opener target has same URL as active tab; keep and sync', {
            stableUrl
          });
        }
        try {
          await newPage.setViewport({
            width: config.stream.viewportWidth,
            height: config.stream.viewportHeight
          });
          await this._setupAntiDetection(newPage);
        } catch (e) {}
        this._addTabToSession(key, session, newPage);
        this._emitTabsUpdated(key);
        logger.info(browserId, 'Background tab (no opener) synced to single session', {
          targetUrl: newPage.url(),
          tabCount: session.tabs.length
        });
      }
      return;
    }

    let openerPage = null;
    try {
      openerPage = await openerTarget.page();
    } catch (e) {
      return;
    }
    if (!openerPage) return;

    const match = this._findSessionByPage(browserId, openerPage);
    if (!match) return;

    // Delay briefly to filter out short-lived ad/tracker popups that close immediately.
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (newPage.isClosed && newPage.isClosed()) return;

    if (initialUrl === 'about:blank') {
      try {
        await Promise.race([
          newPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 2500 }),
          new Promise((resolve) => setTimeout(resolve, 2500))
        ]);
      } catch (_) {}
      if (newPage.isClosed && newPage.isClosed()) return;
      try {
        if ((newPage.url() || '') === 'about:blank') return;
      } catch (_) {}
    }

    try {
      await newPage.setViewport({
        width: config.stream.viewportWidth,
        height: config.stream.viewportHeight
      });
      await this._setupAntiDetection(newPage);
    } catch (e) {}

    this._addTabToSession(match.key, match.session, newPage);
    this._emitTabsUpdated(match.key);
    logger.info(browserId, 'Background tab detected and synced', {
      targetUrl: newPage.url(),
      tabCount: match.session.tabs.length
    });
  }

  _resolveUserForTabOwner(ownerUserId) {
    const user = userApi.getById(String(ownerUserId || ''));
    return user || { id: String(ownerUserId || ''), isAdmin: false };
  }

  async _enforceDomainRestriction(browserId, key, tab, page, url) {
    const browserConfig = browserApi.getById(browserId);
    const user = this._resolveUserForTabOwner(tab?.owner);
    const check = isUrlAllowedForUser(url, browserConfig, user);
    if (check.allowed || url === 'about:blank') return true;

    logger.warn(browserId, 'Blocked navigation by domain policy', {
      userId: user.id,
      url,
      allowedDomains: browserConfig?.domainRestrictions || []
    });
    this._emitEvent(key, {
      type: 'domain_blocked',
      blockedUrl: url,
      allowedDomains: browserConfig?.domainRestrictions || []
    });
    try {
      await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10000 });
    } catch (_) {}
    tab.url = 'about:blank';
    tab.title = 'Blocked by domain policy';
    tab.isReady = true;
    return false;
  }

  // ============== Tab 管理 ==============

  _addTabToSession(key, session, page) {
    if (page.__sharedTracked) {
      return session.tabs.findIndex((tab) => tab.page === page);
    }
    page.__sharedTracked = true;
    page.__sharedSessionKey = key;
    const browserId = this._extractBrowserIdFromSessionKey(key);
    const tabIdentifier = `${browserId}_${Date.now()}_${++this.tabIdSeq}`;

    const ownerUserId = this._extractUserIdFromSessionKey(key);
    const tab = {
      page,
      title: 'New Tab',
      url: page.url() || 'about:blank',
      targetId: String(this._safeTargetIdForPage(page) || ''),
      isReady: (page.url() || 'about:blank') === 'about:blank',
      lastNavigationTarget: '',
      lastNavigationAt: null,
      lastNavigationError: null,
      openedAt: Date.now(),
      pendingDialog: null,
      tabIdentifier,
      tab_identifier: tabIdentifier,
      owner: ownerUserId,          // user who owns this tab
      commandLog: []               // last N commands: { who, type, detail, ts }
    };
    session.tabs.push(tab);

    // ====== Domain restriction: preflight intercept (avoid navigating first) ======
    // We still keep _enforceDomainRestriction as a last-resort guard, but for user clicks
    // we want to block the navigation request before Chrome actually leaves the page.
    this._setupDomainRestrictionInterception(key, tab, page).catch((e) => {
      logger.warn(this._extractBrowserIdFromSessionKey(key), `Domain interception setup failed: ${e.message}`);
    });

    let navDebounceTimer = null;
    let readyDebounceTimer = null;
    let readyFallbackTimer = null;
    const emitTabsUpdatedDebounced = (delayMs = 120) => {
      if (readyDebounceTimer) clearTimeout(readyDebounceTimer);
      readyDebounceTimer = setTimeout(() => {
        readyDebounceTimer = null;
        this._emitTabsUpdated(key);
      }, delayMs);
    };

    // 监听页面导航，更新 title 和 url
    page.on('framenavigated', async (frame) => {
      if (frame !== page.mainFrame()) return;
      if (navDebounceTimer) clearTimeout(navDebounceTimer);
      navDebounceTimer = setTimeout(async () => {
        navDebounceTimer = null;
        try {
          tab.url = page.url();
          const allowed = await this._enforceDomainRestriction(browserId, key, tab, page, tab.url);
          if (!allowed) {
            this._emitTabsUpdated(key);
            return;
          }
          tab.isReady = false;
          tab.title = await page.title() || tab.url;
          // Fallback: some popup/new-tab flows do not fire load reliably.
          if (readyFallbackTimer) clearTimeout(readyFallbackTimer);
          readyFallbackTimer = setTimeout(() => {
            readyFallbackTimer = null;
            if (tab.isReady === false) {
              tab.isReady = true;
              this._emitTabsUpdated(key);
              logger.info(browserId, 'Tab ready fallback promoted', {
                tabIdentifier: tab.tabIdentifier,
                url: tab.url
              });
            }
          }, 1800);
        } catch (e) {}
        this._emitTabsUpdated(key);
      }, 160);
    });

    page.on('domcontentloaded', () => {
      tab.isReady = true;
      if (readyFallbackTimer) {
        clearTimeout(readyFallbackTimer);
        readyFallbackTimer = null;
      }
      emitTabsUpdatedDebounced(120);
    });

    page.on('load', () => {
      tab.isReady = true;
      if (readyFallbackTimer) {
        clearTimeout(readyFallbackTimer);
        readyFallbackTimer = null;
      }
      emitTabsUpdatedDebounced(120);
    });

    // 监听弹出窗口（window.open, target="_blank"）
    page.on('popup', async (newPage) => {
      if (!newPage || (newPage.isClosed && newPage.isClosed())) return;
      // Delay sync to avoid UI flicker from transient popup targets.
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (newPage.isClosed && newPage.isClosed()) return;
      let popupUrl = '';
      try {
        popupUrl = newPage.url() || '';
      } catch (_) {}
      if (popupUrl === 'about:blank') {
        try {
          await Promise.race([
            newPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 1000 }),
            new Promise((resolve) => setTimeout(resolve, 1000))
          ]);
        } catch (_) {}
        if (newPage.isClosed && newPage.isClosed()) return;
        try {
          popupUrl = newPage.url() || '';
        } catch (_) {}
        if (popupUrl === 'about:blank') {
          logger.info(browserId, 'Ignored popup target that remained about:blank', {
            openerUrl: page.url()
          });
          return;
        }
      }
      logger.info(browserId, 'New popup opened', {
        openerUrl: page.url(),
        popupUrl
      });
      const openerUrl = (() => {
        try { return page.url() || ''; } catch (_) { return ''; }
      })();
      if (popupUrl && openerUrl && popupUrl === openerUrl) {
        logger.info(browserId, 'Ignored popup same as opener URL', {
          openerUrl,
          popupUrl
        });
        return;
      }
      try {
        await newPage.setViewport({
          width: config.stream.viewportWidth,
          height: config.stream.viewportHeight
        });
        // 为新页面注入反检测脚本
        await this._setupAntiDetection(newPage);
      } catch (e) {}
      const exists = session.tabs.find((t) => t.page === newPage);
      if (!exists) this._addTabToSession(key, session, newPage);
      // 保持当前标签为活跃，弹出页默认作为后台标签
      this._emitTabsUpdated(key);
    });

    // 监听 JS 对话框（alert/confirm/prompt）
    page.on('dialog', async (dialog) => {
      logger.info(browserId, `Dialog: ${dialog.type()} - ${dialog.message()}`);
      const tabIndex = session.tabs.findIndex(t => t.page === page);
      tab.pendingDialog = dialog;
      const dialogEvent = {
        type: 'dialog_opened',
        tabIndex,
        dialogType: dialog.type(),
        message: dialog.message(),
        defaultValue: dialog.defaultValue()
      };
      this._emitEvent(key, dialogEvent);
      this._emitTabsUpdated(key);
    });

    // 监听页面错误
    page.on('error', (error) => {
      logger.error(browserId, `Page crashed: ${error.message}`);
    });

    // 监听页面 console（可选，用于调试）
    page.on('pageerror', (error) => {
      // 只记录严重错误，不记录普通 JS 错误
      if (error.message && (error.message.includes('crash') || error.message.includes('oom'))) {
        logger.warn(browserId, `Page JS critical error: ${error.message}`);
      }
    });

    page.on('requestfailed', (request) => {
      if (request.resourceType() !== 'document') return;
      const failure = request.failure();
      logger.warn(browserId, 'Document request failed', {
        url: request.url(),
        method: request.method(),
        reason: failure ? failure.errorText : 'unknown'
      });
    });

    // 监听页面关闭
    page.on('close', () => {
      if (navDebounceTimer) {
        clearTimeout(navDebounceTimer);
        navDebounceTimer = null;
      }
      if (readyDebounceTimer) {
        clearTimeout(readyDebounceTimer);
        readyDebounceTimer = null;
      }
      if (readyFallbackTimer) {
        clearTimeout(readyFallbackTimer);
        readyFallbackTimer = null;
      }
      const idx = session.tabs.findIndex(t => t.page === page);
      if (idx !== -1) {
        session.tabs.splice(idx, 1);
        if (session.tabs.length > 0) {
          if (session.activeIndex >= session.tabs.length) {
            session.activeIndex = session.tabs.length - 1;
          }
        } else {
          session.activeIndex = 0;
        }
        this._emitTabsUpdated(key);
        if (session.tabs.length > 0) {
          this._emitTabSwitched(key, session.activeIndex);
        }
      }
    });

    return session.tabs.length - 1;
  }

  async _setupDomainRestrictionInterception(key, tab, page) {
    if (!page || page.__sbDomainInterceptHooked) return;
    page.__sbDomainInterceptHooked = true;

    const browserId = this._extractBrowserIdFromSessionKey(key);
    // Interception can be enabled only once per page; ignore if it fails (e.g. already enabled).
    try {
      await page.setRequestInterception(true);
    } catch (_) {}

    // Avoid spamming the UI with repeated blocked events (some sites retry).
    let lastBlocked = { url: '', at: 0 };

    page.on('request', async (req) => {
      try {
        if (!req) return;
        // Only block top-level navigations to http(s). Let subresources through.
        if (!req.isNavigationRequest || !req.isNavigationRequest()) return req.continue();
        if (req.resourceType && req.resourceType() !== 'document') return req.continue();
        const frame = req.frame && req.frame();
        if (frame && page.mainFrame && frame !== page.mainFrame()) return req.continue();

        const url = String(req.url ? req.url() : '');
        if (!(url.startsWith('http://') || url.startsWith('https://'))) return req.continue();

        const browserCfg = browserApi.getById(browserId);
        const user = this._resolveUserForTabOwner(tab?.owner);
        const check = isUrlAllowedForUser(url, browserCfg, user);
        if (check.allowed) return req.continue();

        const now = Date.now();
        if (lastBlocked.url !== url || (now - lastBlocked.at) > 1200) {
          lastBlocked = { url, at: now };
          logger.warn(browserId, `Blocked navigation (preflight) for user ${user.id}`, {
            url,
            reason: check.reason || '',
            allowedDomains: browserCfg?.domainRestrictions || []
          });
          this._emitEvent(key, {
            type: 'domain_blocked',
            blockedUrl: url,
            allowedDomains: browserCfg?.domainRestrictions || []
          });
        }
        try {
          // Provide a reason string when possible; puppeteer may ignore unknown codes.
          await req.abort('blockedbyclient');
        } catch (_) {
          try { await req.abort(); } catch (_) {}
        }
      } catch (e) {
        try { await req.continue(); } catch (_) {}
      }
    });

    // Keep tabs list updated if the browser produced an error page after a blocked attempt.
    page.on('framenavigated', () => {
      // no-op; the existing framenavigated handler in _addTabToSession covers tab url/title.
    });
  }

  getTabList(browserId, userId) {
    const key = this._getSessionKey(browserId, userId);
    const session = this.userSessions.get(key);
    if (!session) return { tabs: [], activeIndex: 0 };
    this._cleanupSessionTabs(session);
    const streamReady = this._isSessionStreamReady(browserId, userId, session);
    const activeIndex = Math.min(
      Math.max(0, Number(session.activeIndex || 0)),
      Math.max(0, (session.tabs || []).length - 1)
    );

    return {
      tabs: session.tabs.map((tab, index) => ({
        index,
        title: tab.title || 'New Tab',
        url: tab.url || 'about:blank',
        targetId: String(tab.targetId || this._safeTargetIdForPage(tab.page) || ''),
        isReady: this._resolveTabReadyState(tab, index, activeIndex, streamReady),
        lastNavigationTarget: tab.lastNavigationTarget || '',
        lastNavigationAt: tab.lastNavigationAt || null,
        lastNavigationError: tab.lastNavigationError || null,
        hasDialog: !!tab.pendingDialog,
        tabIdentifier: tab.tabIdentifier,
        tab_identifier: tab.tab_identifier || tab.tabIdentifier,
        owner: tab.owner || userId
      })),
      activeIndex,
      creatingTab: !!session.creatingTab
    };
  }

  async refreshTabMeta(browserId, userId) {
    const key = this._getSessionKey(browserId, userId);
    const session = this.userSessions.get(key);
    if (!session) return;
    await this._refreshSessionTabMeta(session);
  }

  async _refreshSessionTabMeta(session) {
    for (const tab of session.tabs) {
      try {
        tab.url = tab.page.url() || tab.url || 'about:blank';
        const title = await tab.page.title();
        if (title) tab.title = title;
      } catch (e) {
        // Ignore tab metadata refresh failures on closing tabs
      }
    }
  }

  async switchTab(browserId, userId, tabIndex) {
    const key = this._getSessionKey(browserId, userId);
    const session = this.userSessions.get(key);
    if (!session || tabIndex < 0 || tabIndex >= session.tabs.length) return null;

    session.activeIndex = tabIndex;
    const page = session.tabs[tabIndex].page;

    this._emitTabSwitched(key, tabIndex);
    this.touchBrowser(browserId);
    streamService.ensureWarmupSession(browserId, page);
    // 不阻塞切换主流程，避免 bringToFront 慢时卡住流/控制链路。
    const bringToFrontStartedAt = Date.now();
    page.bringToFront()
      .then(() => {
        const elapsedMs = Date.now() - bringToFrontStartedAt;
        if (elapsedMs > 600) {
          logger.info(browserId, 'bringToFront slow on tab switch', {
            userId,
            tabIndex,
            elapsedMs
          });
        }
      })
      .catch(() => {});
    return page;
  }

  async navigateCurrentTab(browserId, userId, url) {
    const key = this._getSessionKey(browserId, userId);
    const session = this.userSessions.get(key);
    if (!session || !Array.isArray(session.tabs) || session.tabs.length === 0) {
      throw new Error('No active tab available');
    }

    const targetUrl = String(url || '').trim();
    if (!targetUrl) {
      throw new Error('url is required');
    }

    const activeIndex = Math.min(
      Math.max(0, Number(session.activeIndex || 0)),
      Math.max(0, session.tabs.length - 1)
    );
    session.activeIndex = activeIndex;
    const tab = session.tabs[activeIndex];
    if (!tab || !tab.page) {
      throw new Error('Active tab is unavailable');
    }

    const browserConfig = browserApi.getById(browserId);
    const user = this._resolveUserForTabOwner(tab.owner || userId);
    const check = isUrlAllowedForUser(targetUrl, browserConfig, user);
    if (!check.allowed) {
      this._emitEvent(key, {
        type: 'domain_blocked',
        blockedUrl: targetUrl,
        allowedDomains: browserConfig?.domainRestrictions || []
      });
      throw new Error('Navigation blocked by domain policy');
    }

    tab.url = targetUrl;
    tab.title = 'Loading...';
    tab.isReady = false;
    tab.lastNavigationTarget = targetUrl;
    tab.lastNavigationAt = new Date().toISOString();
    tab.lastNavigationError = null;
    this._emitTabsUpdated(key);

    try {
      await tab.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      tab.url = tab.page.url() || targetUrl;
      tab.title = await tab.page.title().catch(() => tab.title || 'New Tab');
      if (String(tab.url || '').startsWith('chrome-error://')) {
        const detail = await this._buildNavigationFailureDetail(
          tab.page,
          targetUrl,
          new Error('Chrome displayed an internal error page')
        );
        tab.isReady = true;
        tab.lastNavigationError = detail;
        this._emitTabsUpdated(key);
        const err = new Error(`Navigation failed: ${detail.category}${detail.chromeErrorCode ? ` (${detail.chromeErrorCode})` : ''}`);
        err.details = detail;
        throw err;
      }
      tab.isReady = true;
      tab.lastNavigationError = null;
    } catch (e) {
      const detail = await this._buildNavigationFailureDetail(tab.page, targetUrl, e);
      tab.url = detail.finalUrl || targetUrl;
      tab.title = detail.pageTitle || 'Navigation failed';
      tab.isReady = true;
      tab.lastNavigationError = detail;
      this._emitTabsUpdated(key);
      logger.warn(browserId, `Navigate failed: ${detail.category}`, {
        userId,
        targetUrl,
        finalUrl: detail.finalUrl,
        chromeErrorCode: detail.chromeErrorCode,
        reason: detail.reason
      });
      const err = new Error(`Navigation failed: ${detail.category}${detail.chromeErrorCode ? ` (${detail.chromeErrorCode})` : ''}`);
      err.details = detail;
      throw err;
    }

    this._emitTabsUpdated(key);
    streamService.ensureWarmupSession(browserId, tab.page);
    this.touchBrowser(browserId);
    return tab.page;
  }

  _extractChromeErrorCode(text = '') {
    const m = String(text || '').match(/\bERR_[A-Z0-9_]+\b/);
    return m ? m[0] : '';
  }

  _classifyNavigationError(errorMessage = '', chromeErrorCode = '') {
    const msg = String(errorMessage || '').toUpperCase();
    const code = String(chromeErrorCode || '').toUpperCase();
    if (msg.includes('TIMEOUT') || code.includes('TIMED_OUT')) return 'timeout';
    if (code.includes('CONNECTION_REFUSED') || code.includes('ADDRESS_UNREACHABLE')) return 'connection_refused';
    if (code.includes('NAME_NOT_RESOLVED') || code.includes('DNS')) return 'dns_error';
    if (code.startsWith('ERR_CERT_') || code.includes('SSL')) return 'tls_certificate';
    if (code.includes('INTERNET_DISCONNECTED') || code.includes('NETWORK_CHANGED') || code.includes('CONNECTION_RESET')) return 'network_error';
    return 'navigation_failed';
  }

  async _buildNavigationFailureDetail(page, targetUrl, error) {
    let finalUrl = '';
    let pageTitle = '';
    let pageText = '';
    try { finalUrl = String(page.url() || ''); } catch (_) {}
    if (finalUrl.startsWith('chrome-error://')) {
      try {
        const info = await page.evaluate(() => ({
          title: String(document.title || ''),
          text: String(document.body?.innerText || '').slice(0, 4000)
        }));
        pageTitle = String(info?.title || '');
        pageText = String(info?.text || '');
      } catch (_) {}
    }
    const chromeErrorCode = this._extractChromeErrorCode(pageText);
    const reason = String(error?.message || error || '');
    const category = this._classifyNavigationError(reason, chromeErrorCode);
    return {
      category,
      reason,
      targetUrl: String(targetUrl || ''),
      finalUrl: finalUrl || String(targetUrl || ''),
      chromeErrorCode,
      pageTitle,
      at: new Date().toISOString()
    };
  }

  async createNewTab(browserId, userId, url) {
    const key = this._getSessionKey(browserId, userId);
    const session = this.userSessions.get(key);
    if (!session) return null;

    const browser = this.browsers.get(browserId);
    if (!browser) return null;

    const beginAt = Date.now();
    session.creatingTab = true;
    this._emitTabsUpdated(key);
    try {
      this.noOpenerSuppressionUntil.set(browserId, Date.now() + 1200);
      const page = await browser.newPage();
      await page.setViewport({
        width: config.stream.viewportWidth,
        height: config.stream.viewportHeight
      });

      // 为新标签页注入反检测脚本
      await this._setupAntiDetection(page);

      this._addTabToSession(key, session, page);
      session.activeIndex = session.tabs.length - 1;
      // Immediate feedback: new tab appears first as not-ready.
      this._emitTabsUpdated(key);
      this._emitTabSwitched(key, session.activeIndex);

      const browserConfig = browserApi.getById(browserId);
      const targetUrl = url || (browserConfig && browserConfig.url) || '';
      if (targetUrl) {
        try {
          const user = this._resolveUserForTabOwner(userId);
          const check = isUrlAllowedForUser(targetUrl, browserConfig, user);
          if (check.allowed) {
            // Optimistically reflect the destination in tab list to avoid showing about:blank.
            const tabRef = session.tabs[session.activeIndex];
            tabRef.url = targetUrl;
            tabRef.title = 'Loading...';
            tabRef.isReady = false;
            this._emitTabsUpdated(key);

            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            tabRef.title = await page.title().catch(() => 'New Tab');
            tabRef.url = page.url();
            tabRef.isReady = true;
          } else {
            this._emitEvent(key, {
              type: 'domain_blocked',
              blockedUrl: targetUrl,
              allowedDomains: browserConfig?.domainRestrictions || []
            });
          }
        } catch (e) {
          logger.warn(browserId, `New tab navigation failed: ${e.message}`);
        }
      }

      logger.info(browserId, `User ${userId} created new tab`, {
        elapsedMs: Date.now() - beginAt,
        tabCount: session.tabs.length
      });
      this._emitTabsUpdated(key);
      this._emitTabSwitched(key, session.activeIndex);
      this.touchBrowser(browserId);
      streamService.ensureWarmupSession(browserId, page);
      return page;
    } finally {
      session.creatingTab = false;
      this._emitTabsUpdated(key);
    }
  }

  async closeTab(browserId, userId, tabIndex) {
    const key = this._getSessionKey(browserId, userId);
    const session = this.userSessions.get(key);
    if (!session || tabIndex < 0 || tabIndex >= session.tabs.length) return;

    // 不关闭最后一个 tab，改为导航到空白页
    if (session.tabs.length === 1) {
      try {
        const browserConfig = browserApi.getById(browserId);
        const targetUrl = (browserConfig && browserConfig.url) ? String(browserConfig.url) : 'about:blank';
        const user = this._resolveUserForTabOwner(userId);
        const check = isUrlAllowedForUser(targetUrl, browserConfig, user);
        if (check.allowed) {
          session.tabs[0].title = 'Loading...';
          session.tabs[0].url = targetUrl;
          session.tabs[0].isReady = false;
          this._emitTabsUpdated(key);
          await session.tabs[0].page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          session.tabs[0].title = await session.tabs[0].page.title().catch(() => 'New Tab');
          session.tabs[0].url = session.tabs[0].page.url() || targetUrl;
          session.tabs[0].isReady = true;
        } else {
          await session.tabs[0].page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10000 });
          session.tabs[0].title = 'Blocked by domain policy';
          session.tabs[0].url = 'about:blank';
          session.tabs[0].isReady = true;
          this._emitEvent(key, {
            type: 'domain_blocked',
            blockedUrl: targetUrl,
            allowedDomains: browserConfig?.domainRestrictions || []
          });
        }
      } catch (e) {}
      this._emitTabsUpdated(key);
      streamService.ensureWarmupSession(browserId, session.tabs[0].page);
      return;
    }

    const tab = session.tabs[tabIndex];

    // 先从数组中移除（防止 close 事件二次处理产生竞态条件）
    session.tabs.splice(tabIndex, 1);

    // 调整活跃索引
    if (session.activeIndex >= session.tabs.length) {
      session.activeIndex = session.tabs.length - 1;
    } else if (session.activeIndex > tabIndex) {
      session.activeIndex--;
    }

    // 先发送事件，再关闭页面
    this._emitTabsUpdated(key);
    this._emitTabSwitched(key, session.activeIndex);
    if (session.tabs[session.activeIndex]) {
      streamService.ensureWarmupSession(browserId, session.tabs[session.activeIndex].page);
    }

    // 最后关闭页面（close 事件中 findIndex 会返回 -1，不会重复处理）
    try {
      await tab.page.close();
    } catch (e) {}
    this.touchBrowser(browserId);
  }

  // ============== 对话框处理 ==============

  async respondToDialog(browserId, userId, tabIndex, accept, promptText) {
    const key = this._getSessionKey(browserId, userId);
    const session = this.userSessions.get(key);
    if (!session || tabIndex < 0 || tabIndex >= session.tabs.length) return;

    const tab = session.tabs[tabIndex];
    if (!tab.pendingDialog) return;

    try {
      if (accept) {
        if (promptText !== undefined && promptText !== null) {
          await tab.pendingDialog.accept(promptText);
        } else {
          await tab.pendingDialog.accept();
        }
      } else {
        await tab.pendingDialog.dismiss();
      }
    } catch (e) {
      logger.error(browserId, `Dialog response failed: ${e.message}`);
    }

    tab.pendingDialog = null;
    this._emitTabsUpdated(key);
  }

  // ============== 虚拟剪贴板 ==============

  setClipboard(browserId, userId, text, options = {}) {
    const key = this._getSessionKey(browserId, userId);
    const session = this.userSessions.get(key);
    if (!session) return null;
    const nextText = String(text || '');
    session.clipboard = nextText;
    session.clipboardMeta = {
      text: nextText,
      html: String(options.html || ''),
      files: Array.isArray(options.files) ? options.files : [],
      source: String(options.source || 'unknown'),
      updatedAt: new Date().toISOString()
    };
    this.browserClipboard.set(browserId, {
      text: nextText,
      html: session.clipboardMeta.html,
      files: session.clipboardMeta.files,
      source: session.clipboardMeta.source,
      updatedAt: session.clipboardMeta.updatedAt,
      userId: String(userId || '')
    });
    this._emitEvent(key, {
      type: 'clipboard_updated',
      clipboard: {
        text: nextText,
        html: session.clipboardMeta.html,
        files: session.clipboardMeta.files,
        source: session.clipboardMeta.source,
        updatedAt: session.clipboardMeta.updatedAt
      }
    });
    return session.clipboardMeta;
  }

  getClipboard(browserId, userId) {
    const key = this._getSessionKey(browserId, userId);
    const session = this.userSessions.get(key);
    if (!session) return null;
    const meta = session.clipboardMeta || {};
    return {
      text: String(session.clipboard || ''),
      html: String(meta.html || ''),
      files: Array.isArray(meta.files) ? meta.files : [],
      source: String(meta.source || (session.clipboard ? 'session' : 'empty')),
      updatedAt: meta.updatedAt || null
    };
  }

  getBrowserClipboard(browserId) {
    const clip = this.browserClipboard.get(browserId);
    if (!clip) return null;
    return {
      text: String(clip.text || ''),
      html: String(clip.html || ''),
      files: Array.isArray(clip.files) ? clip.files : [],
      source: String(clip.source || 'browser'),
      updatedAt: clip.updatedAt || null,
      userId: String(clip.userId || '')
    };
  }

  async copySelection(browserId, userId) {
    const key = this._getSessionKey(browserId, userId);
    const session = this.userSessions.get(key);
    if (!session || session.tabs.length === 0) return '';

    const page = session.tabs[session.activeIndex].page;
    try {
      const text = await page.evaluate(() => {
        const active = document.activeElement;
        // input/textarea selection is not reflected by window.getSelection()
        if (active && (active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'submit', 'file'].includes((active.type || '').toLowerCase())))) {
          const v = String(active.value || '');
          const start = Number.isFinite(active.selectionStart) ? active.selectionStart : 0;
          const end = Number.isFinite(active.selectionEnd) ? active.selectionEnd : start;
          if (end > start) return v.slice(start, end);
        }
        if (active && active.isContentEditable) {
          const sel = window.getSelection();
          return sel ? String(sel.toString() || '') : '';
        }
        const sel = window.getSelection();
        return sel ? String(sel.toString() || '') : '';
      });
      this.setClipboard(browserId, userId, text, { source: 'copy' });
      return text;
    } catch (e) {
      logger.error(browserId, `Copy failed: ${e.message}`);
      return '';
    }
  }

  async pasteText(browserId, userId, text) {
    const key = this._getSessionKey(browserId, userId);
    const session = this.userSessions.get(key);
    if (!session || session.tabs.length === 0) return;

    // 更新虚拟剪贴板
    if (text) this.setClipboard(browserId, userId, text, { source: 'paste' });

    const textToPaste = text || session.clipboard;
    if (!textToPaste) return;

    const page = session.tabs[session.activeIndex].page;
    try {
      // 使用 CDP insertText 注入文本（支持所有可编辑元素）
      const client = await page.target().createCDPSession();
      await client.send('Input.insertText', { text: textToPaste });
      await client.detach();
    } catch (e) {
      // 回退到 keyboard.type
      try {
        await page.keyboard.type(textToPaste);
      } catch (e2) {
        logger.error(browserId, `Paste failed: ${e2.message}`);
      }
    }
  }

  async cutSelection(browserId, userId) {
    const text = await this.copySelection(browserId, userId);
    if (text) {
      this.setClipboard(browserId, userId, text, { source: 'cut' });
      const page = this.getActivePage(browserId, userId);
      if (page) {
        try {
          await page.keyboard.press('Backspace');
        } catch (e) {}
      }
    }
    return text;
  }

  // ============== 事件系统 ==============

  setEventListener(browserId, userId, callback) {
    const key = `${browserId}_${userId}`;
    this.eventListeners.set(key, callback);
  }

  removeEventListener(browserId, userId) {
    const key = `${browserId}_${userId}`;
    this.eventListeners.delete(key);
  }

  _emitEvent(key, event) {
    const callback = this.eventListeners.get(key);
    if (callback) {
      try {
        callback(event);
      } catch (e) {
        console.error(`[BrowserManager] Event callback error:`, e.message);
      }
    }
  }

  _emitEventForBrowser(browserId, event) {
    for (const [key, callback] of this.eventListeners.entries()) {
      if (!this._isBrowserSessionKey(key, browserId)) continue;
      try {
        callback(event);
      } catch (e) {
        console.error('[BrowserManager] Browser event callback error:', e.message);
      }
    }
  }

  _emitTabsUpdated(key) {
    const session = this.userSessions.get(key);
    if (!session) return;
    this._cleanupSessionTabs(session);
    const browserId = this._extractBrowserIdFromSessionKey(key);
    const userId = this._extractUserIdFromSessionKey(key);
    const streamReady = this._isSessionStreamReady(browserId, userId, session);
    const activeIndex = Math.min(
      Math.max(0, Number(session.activeIndex || 0)),
      Math.max(0, (session.tabs || []).length - 1)
    );

    const payload = {
      type: 'tabs_updated',
      tabs: session.tabs.map((tab, index) => ({
        index,
        title: tab.title || 'New Tab',
        url: tab.url || 'about:blank',
        isReady: this._resolveTabReadyState(tab, index, activeIndex, streamReady),
        hasDialog: !!tab.pendingDialog,
        tabIdentifier: tab.tabIdentifier,
        tab_identifier: tab.tab_identifier || tab.tabIdentifier
      })),
      activeIndex
    };

    this._emitEvent(key, payload);
  }

  _emitTabSwitched(key, activeIndex) {
    const payload = {
      type: 'tab_switched',
      activeIndex
    };
    this._emitEvent(key, payload);
  }

  // ============== Tab command log (per-tab recent ops) ==============

  logTabCommand(browserId, userId, type, detail) {
    const session = this.getSession(browserId, userId);
    if (!session || session.tabs.length === 0) return;
    const tab = session.tabs[session.activeIndex];
    if (!tab) return;
    if (!tab.commandLog) tab.commandLog = [];
    tab.commandLog.unshift({
      who: String(userId),
      type: type,
      detail: detail || '',
      ts: new Date().toISOString()
    });
    if (tab.commandLog.length > 2) tab.commandLog.length = 2;
  }

  // Get all tabs across all user sessions for a given browser (used by report)
  getAllTabsForBrowser(browserId) {
    const tabs = [];
    for (const [key, session] of this.userSessions.entries()) {
      if (!this._isBrowserSessionKey(key, browserId)) continue;
      const userId = this._extractUserIdFromSessionKey(key);
      this._cleanupSessionTabs(session);
      const streamReady = this._isSessionStreamReady(browserId, userId, session);
      const activeIndex = Math.min(
        Math.max(0, Number(session.activeIndex || 0)),
        Math.max(0, (session.tabs || []).length - 1)
      );
      for (let i = 0; i < session.tabs.length; i++) {
        const tab = session.tabs[i];
        let targetId = '';
        let pageAlive = true;
        try {
          const target = tab.page && tab.page.target ? tab.page.target() : null;
          targetId = (target && (target._targetId || target?._targetInfo?.targetId)) || '';
          pageAlive = !(tab.page && tab.page.isClosed && tab.page.isClosed());
        } catch (_) {
          pageAlive = false;
        }
        tabs.push({
          index: i,
          title: tab.title || 'New Tab',
          url: tab.url || 'about:blank',
          isReady: this._resolveTabReadyState(tab, i, activeIndex, streamReady),
          isActive: i === activeIndex,
          pageAlive,
          owner: tab.owner || userId,
          targetId: targetId || String(tab.targetId || ''),
          tabIdentifier: tab.tabIdentifier,
          commandLog: (tab.commandLog || []).slice(0, 2)
        });
      }
    }
    return tabs;
  }

  // Get all user session summaries for a given browser (used by report)
  getUserSessionsForBrowser(browserId) {
    const users = [];
    for (const [key, session] of this.userSessions.entries()) {
      if (!this._isBrowserSessionKey(key, browserId)) continue;
      const userId = this._extractUserIdFromSessionKey(key);
      this._cleanupSessionTabs(session);
      const activeIndex = Math.min(
        Math.max(0, Number(session.activeIndex || 0)),
        Math.max(0, (session.tabs || []).length - 1)
      );
      const activeTab = session.tabs[activeIndex] || null;
      users.push({
        userId,
        sessionKey: key,
        tabCount: session.tabs.length,
        activeTabIndex: activeIndex,
        activeTabTitle: activeTab ? (activeTab.title || 'New Tab') : '-',
        activeTabUrl: activeTab ? (activeTab.url || 'about:blank') : '-'
      });
    }
    return users;
  }

  updateRemoteCursor(browserId, cursor, userId) {
    const state = {
      x: Number(cursor.x || 0),
      y: Number(cursor.y || 0),
      button: cursor.button || 'none',
      source: cursor.source || 'unknown',
      updatedAt: Date.now()
    };
    this.cursorStates.set(browserId, state);
    if (userId) {
      // Per-user isolation: only send cursor to the user who owns it
      const key = this._getSessionKey(browserId, userId);
      this._emitEvent(key, { type: 'remote_cursor', ...state });
    } else {
      this._emitEventForBrowser(browserId, { type: 'remote_cursor', ...state });
    }
  }

  // ============== 清理 ==============

  async shutdownUserSession(browserId, userId) {
    const key = this._getSessionKey(browserId, userId);
    const session = this.userSessions.get(key);
    if (!session) return { closedTabs: 0 };
    logger.info(browserId, `Shutdown requested by user ${userId}`, {
      tabCountBefore: session.tabs.length
    });

    const tabs = [...session.tabs];
    for (const tab of tabs) {
      try {
        await tab.page.close();
      } catch (e) {}
    }

    this.userSessions.delete(key);
    this.eventListeners.delete(key);
    this.touchBrowser(browserId);

    // If this was the last viewer session, reset the browser to the configured home page
    // to avoid "stuck on previous page" / blank tab issues on next entry.
    try {
      if (!this.hasSessionsForBrowser(browserId)) {
        const browser = this.browsers.get(browserId);
        if (browser && browser.isConnected && browser.isConnected()) {
          streamService.stopWarmupSession(browserId);
          streamService.clearLatestFrame(browserId);
          await this._ensureWarmupStream(browserId, browser);
        }
      }
    } catch (_) {}

    logger.info(browserId, `Shutdown finished for user ${userId}`, {
      closedTabs: tabs.length
    });
    return { closedTabs: tabs.length };
  }

  async closeBrowser(browserId) {
    const browser = this.browsers.get(browserId);
    if (browser) {
      logger.info(browserId, 'Manually closing browser');
      try {
        await browser.close();
      } catch (e) {
        logger.warn(browserId, `Failed to close browser: ${e.message}`);
      }
      this.browsers.delete(browserId);
      this.resetRestartState(browserId);
      for (const [key] of this.userSessions.entries()) {
        if (this._isBrowserSessionKey(key, browserId)) {
          this.userSessions.delete(key);
          this.eventListeners.delete(key);
        }
      }
    }
    this._cleanupBrowserRuntimeData(browserId);
  }

  /**
   * 手动重启浏览器
   */
  async restartBrowser(browserId) {
    logger.info(browserId, 'Manually restarting browser');
    await this.closeBrowser(browserId);
    this.resetRestartState(browserId);
    return await this.launchBrowser(browserId);
  }

  getStatus() {
    const status = {
      browsers: [],
      totalSessions: this.userSessions.size
    };
    for (const [browserId, browser] of this.browsers.entries()) {
      const restartState = this.restartState.get(browserId);
      const sessions = [];
      for (const [key, session] of this.userSessions.entries()) {
        if (this._isBrowserSessionKey(key, browserId)) {
          const userId = this._extractUserIdFromSessionKey(key);
          sessions.push({ userId, tabCount: session.tabs.length });
        }
      }
      status.browsers.push({
        id: browserId,
        isConnected: browser.isConnected(),
        sessionCount: sessions.length,
        sessions,
        restartInfo: restartState ? {
          retries: restartState.retries,
          lastCrash: restartState.lastCrash
        } : null
      });
    }
    return status;
  }

  getBrowserRuntimeMap() {
    const map = new Map();
    for (const [browserId, browser] of this.browsers.entries()) {
      let pid = null;
      let alive = false;
      try {
        pid = browser && browser.process ? (browser.process()?.pid || null) : null;
        alive = !!(browser && browser.isConnected && browser.isConnected());
      } catch (_) {}
      map.set(browserId, { pid, alive });
    }
    return map;
  }

  getSessionReport() {
    const report = [];
    for (const [key, session] of this.userSessions.entries()) {
      const browserId = this._extractBrowserIdFromSessionKey(key);
      const userId = this._extractUserIdFromSessionKey(key);
      const browser = this.browsers.get(browserId);
      let browserPid = null;
      let browserAlive = false;
      try {
        browserPid = browser && browser.process ? (browser.process()?.pid || null) : null;
        browserAlive = !!(browser && browser.isConnected && browser.isConnected());
      } catch (_) {}
      this._cleanupSessionTabs(session);
      const activeIndex = Math.min(Math.max(0, session.activeIndex || 0), Math.max(0, (session.tabs || []).length - 1));
      const streamReady = this._isSessionStreamReady(browserId, userId, session);
      const tabs = (session.tabs || []).map((tab, index) => ({
        ...(() => {
          let targetId = '';
          let pageAlive = true;
          try {
            const target = tab.page && tab.page.target ? tab.page.target() : null;
            targetId = (target && (target._targetId || target?._targetInfo?.targetId)) || '';
            pageAlive = !(tab.page && tab.page.isClosed && tab.page.isClosed());
          } catch (_) {
            pageAlive = false;
          }
          return {
            index,
            title: tab.title || 'New Tab',
            url: tab.url || 'about:blank',
            isReady: this._resolveTabReadyState(tab, index, activeIndex, streamReady),
            hasDialog: !!tab.pendingDialog,
            tabIdentifier: tab.tabIdentifier || tab.tab_identifier,
            targetId: targetId || String(tab.targetId || ''),
            browserPid,
            pageAlive,
            owner: tab.owner || userId,
            commandLog: (tab.commandLog || []).slice(0, 2)
          };
        })()
      }));
      report.push({
        sessionKey: key,
        browserId,
        userId,
        browserPid,
        browserAlive,
        creatingTab: !!session.creatingTab,
        tabCount: tabs.length,
        activeIndex,
        activeTab: tabs[activeIndex] || null,
        tabs,
        users: Array.from(session.users || [])
      });
    }
    return report;
  }

  _safeTargetIdForPage(page) {
    try {
      const target = page && page.target ? page.target() : null;
      return (target && (target._targetId || target?._targetInfo?.targetId)) || '';
    } catch (_) {
      return '';
    }
  }

  _isSessionStreamReady(browserId, userId, session) {
    if (!session || !session.tabs || session.tabs.length === 0) return false;
    const activeIndex = Math.min(Math.max(0, Number(session.activeIndex || 0)), session.tabs.length - 1);
    const activeTab = session.tabs[activeIndex];
    if (!activeTab || !activeTab.page) return false;
    let streamSession = streamService.getSession(browserId, userId);
    if (!streamSession || !streamSession.running) return false;
    let stats = null;
    try {
      stats = streamSession.getStats ? streamSession.getStats() : null;
    } catch (_) {}
    if (!stats || !stats.running) return false;
    const activeTargetId = this._safeTargetIdForPage(activeTab.page);
    const streamTargetId = String(stats.streamTargetId || '');
    if (activeTargetId && streamTargetId && activeTargetId !== streamTargetId) return false;
    const lastSuccessAgeMs = Number(stats.lastSuccessAgeMs || Number.MAX_SAFE_INTEGER);
    return lastSuccessAgeMs < 8000;
  }

  _resolveTabReadyState(tab, index, activeIndex, activeStreamReady) {
    const openedAt = Number(tab?.openedAt || 0);
    const now = Date.now();
    // New tab should be reported immediately and marked not-ready for a short bootstrap window.
    if (openedAt > 0 && (now - openedAt) < 1500) {
      return false;
    }
    if (index !== activeIndex) {
      return true;
    }
    return !!activeStreamReady;
  }

  async ensureDaemonBrowsers() {
    const list = browserApi.getAll() || [];
    for (const item of list) {
      const browserId = item.id;
      if (!browserId || this.browsers.has(browserId)) continue;
      try {
        await this.launchBrowser(browserId);
      } catch (e) {
        logger.warn(browserId, `Daemon launch skipped due to error: ${e.message}`);
      }
    }
  }

  async closeAll() {
    this.stopHealthCheck();
    const browserIds = [...this.browsers.keys()];
    for (const browserId of browserIds) {
      await this.closeBrowser(browserId);
    }
  }

  hasSessionsForBrowser(browserId) {
    for (const key of this.userSessions.keys()) {
      if (this._isBrowserSessionKey(key, browserId)) return true;
    }
    return false;
  }

  touchBrowser(browserId) {
    this.browserLastActive.set(browserId, Date.now());
  }

  _cleanupBrowserRuntimeData(browserId) {
    this.browserLastActive.delete(browserId);
    this.cursorStates.delete(browserId);
    this.browserClipboard.delete(browserId);
    this.noOpenerSuppressionUntil.delete(browserId);
    streamService.stopSessionsForBrowser(browserId);

    // Lazy-require to avoid hard circular dependency at module init time.
    try {
      const mcpService = require('./mcp-service');
      if (mcpService && mcpService.clearConsoleBuffer) {
        mcpService.clearConsoleBuffer(browserId);
      }
    } catch (_) {}
    try {
      const fileService = require('./file-service');
      if (fileService && fileService.cleanupBrowserResources) {
        fileService.cleanupBrowserResources(browserId);
      }
    } catch (_) {}
  }
}

// 单例
const browserManager = new BrowserManager();

module.exports = browserManager;
