const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { browserApi } = require('./auth');
const logger = require('./logger');

class BrowserManager {
  constructor() {
    this.browsers = new Map();        // browserId -> Browser instance
    this.userSessions = new Map();    // `${browserId}_${userId}` -> session object
    this.eventListeners = new Map();  // `${browserId}_${userId}` -> callback

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

      this.browsers.set(browserId, browser);

      // 标记启动成功，设置稳定计时器
      this._onBrowserStarted(browserId);

      logger.info(browserId, 'Browser launched successfully');
      return browser;
    } catch (e) {
      logger.error(browserId, 'Browser launch failed', e.message);
      throw e;
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
      if (key.startsWith(`${browserId}_`)) {
        affectedSessions.push(key);
        // 通知客户端浏览器崩溃
        this._emitEvent(key, {
          type: 'browser_crashed',
          message: 'Browser process disconnected, attempting auto-restart...'
        });
      }
    }

    // 清理会话
    for (const key of affectedSessions) {
      this.userSessions.delete(key);
    }

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
      for (const key of affectedSessionKeys) {
        this._emitEvent(key, {
          type: 'browser_restart_failed',
          message: `Browser stopped auto-restarting after multiple crashes. Please contact admin.`
        });
      }
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

        // 尝试恢复受影响的用户会话
        for (const key of affectedSessionKeys) {
          const callback = this.eventListeners.get(key);
          if (callback) {
            // 通知客户端浏览器已恢复
            try {
              callback({
                type: 'browser_restarted',
                message: 'Browser auto-restarted, please refresh the page to reconnect.'
              });
            } catch (e) {}
          }
        }

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
      for (const [browserId, browser] of this.browsers.entries()) {
        try {
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

  async getSessionForUser(browserId, userId) {
    const key = `${browserId}_${userId}`;

    if (this.userSessions.has(key)) {
      const session = this.userSessions.get(key);
      // 验证至少有一个可用的 tab
      if (session.tabs.length > 0) {
        try {
          await session.tabs[session.activeIndex].page.evaluate(() => true);
          return session;
        } catch (e) {
          // 活跃页面无效，移除它
          session.tabs.splice(session.activeIndex, 1);
          if (session.tabs.length > 0) {
            session.activeIndex = Math.min(session.activeIndex, session.tabs.length - 1);
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

    const browserConfig = browserApi.getById(browserId);

    const session = {
      tabs: [],
      activeIndex: 0,
      clipboard: ''  // 虚拟剪贴板（per-session，不污染系统剪贴板）
    };

    this.userSessions.set(key, session);

    // 尝试复用 browser 的现有空白页，否则创建新页面
    let page;
    const existingPages = await browser.pages();
    if (existingPages.length > 0 && existingPages[0].url() === 'about:blank') {
      page = existingPages[0];
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

    // 导航到默认 URL
    if (browserConfig && browserConfig.url) {
      try {
        await page.goto(browserConfig.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        session.tabs[0].title = await page.title().catch(() => 'New Tab');
        session.tabs[0].url = page.url();
        logger.info(browserId, `User ${userId} navigated to ${browserConfig.url}`);
      } catch (e) {
        logger.warn(browserId, `Navigation failed: ${e.message}`);
      }
    }

    return session;
  }

  // 向后兼容方法：获取用户的活跃页面
  async getPageForUser(browserId, userId) {
    const session = await this.getSessionForUser(browserId, userId);
    if (!session || session.tabs.length === 0) return null;
    return session.tabs[session.activeIndex].page;
  }

  // 获取活跃页面（同步版本，不创建新会话）
  getActivePage(browserId, userId) {
    const key = `${browserId}_${userId}`;
    const session = this.userSessions.get(key);
    if (!session || session.tabs.length === 0) return null;
    return session.tabs[session.activeIndex].page;
  }

  // ============== Tab 管理 ==============

  _addTabToSession(key, session, page) {
    const tab = {
      page,
      title: 'New Tab',
      url: page.url() || 'about:blank',
      pendingDialog: null
    };
    session.tabs.push(tab);

    // 解析 browserId 用于日志
    const browserId = key.split('_')[0];

    // 监听页面导航，更新 title 和 url
    page.on('framenavigated', async (frame) => {
      if (frame === page.mainFrame()) {
        try {
          tab.url = page.url();
          tab.title = await page.title() || tab.url;
        } catch (e) {}
        this._emitTabsUpdated(key);
      }
    });

    // 监听弹出窗口（window.open, target="_blank"）
    page.on('popup', async (newPage) => {
      logger.info(browserId, `New popup opened`);
      try {
        await newPage.setViewport({
          width: config.stream.viewportWidth,
          height: config.stream.viewportHeight
        });
        // 为新页面注入反检测脚本
        await this._setupAntiDetection(newPage);
      } catch (e) {}
      this._addTabToSession(key, session, newPage);
      // 自动切换到新 tab
      session.activeIndex = session.tabs.length - 1;
      this._emitTabsUpdated(key);
      this._emitTabSwitched(key, session.activeIndex);
    });

    // 监听 JS 对话框（alert/confirm/prompt）
    page.on('dialog', async (dialog) => {
      logger.info(browserId, `Dialog: ${dialog.type()} - ${dialog.message()}`);
      const tabIndex = session.tabs.findIndex(t => t.page === page);
      tab.pendingDialog = dialog;
      this._emitEvent(key, {
        type: 'dialog_opened',
        tabIndex,
        dialogType: dialog.type(),
        message: dialog.message(),
        defaultValue: dialog.defaultValue()
      });
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

    // 监听页面关闭
    page.on('close', () => {
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

  getTabList(browserId, userId) {
    const key = `${browserId}_${userId}`;
    const session = this.userSessions.get(key);
    if (!session) return { tabs: [], activeIndex: 0 };

    return {
      tabs: session.tabs.map((tab, index) => ({
        index,
        title: tab.title || 'New Tab',
        url: tab.url || 'about:blank',
        hasDialog: !!tab.pendingDialog
      })),
      activeIndex: session.activeIndex
    };
  }

  async switchTab(browserId, userId, tabIndex) {
    const key = `${browserId}_${userId}`;
    const session = this.userSessions.get(key);
    if (!session || tabIndex < 0 || tabIndex >= session.tabs.length) return null;

    session.activeIndex = tabIndex;
    const page = session.tabs[tabIndex].page;

    try {
      await page.bringToFront();
    } catch (e) {}

    this._emitTabSwitched(key, tabIndex);
    return page;
  }

  async createNewTab(browserId, userId, url) {
    const key = `${browserId}_${userId}`;
    const session = this.userSessions.get(key);
    if (!session) return null;

    const browser = this.browsers.get(browserId);
    if (!browser) return null;

    const page = await browser.newPage();
    await page.setViewport({
      width: config.stream.viewportWidth,
      height: config.stream.viewportHeight
    });

    // 为新标签页注入反检测脚本
    await this._setupAntiDetection(page);

    this._addTabToSession(key, session, page);
    session.activeIndex = session.tabs.length - 1;

    if (url) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const tab = session.tabs[session.activeIndex];
        tab.title = await page.title().catch(() => 'New Tab');
        tab.url = page.url();
      } catch (e) {
        logger.warn(browserId, `New tab navigation failed: ${e.message}`);
      }
    }

    logger.info(browserId, `User ${userId} created new tab`);
    this._emitTabsUpdated(key);
    this._emitTabSwitched(key, session.activeIndex);
    return page;
  }

  async closeTab(browserId, userId, tabIndex) {
    const key = `${browserId}_${userId}`;
    const session = this.userSessions.get(key);
    if (!session || tabIndex < 0 || tabIndex >= session.tabs.length) return;

    // 不关闭最后一个 tab，改为导航到空白页
    if (session.tabs.length === 1) {
      try {
        await session.tabs[0].page.goto('about:blank');
        session.tabs[0].title = 'New Tab';
        session.tabs[0].url = 'about:blank';
      } catch (e) {}
      this._emitTabsUpdated(key);
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

    // 最后关闭页面（close 事件中 findIndex 会返回 -1，不会重复处理）
    try {
      await tab.page.close();
    } catch (e) {}
  }

  // ============== 对话框处理 ==============

  async respondToDialog(browserId, userId, tabIndex, accept, promptText) {
    const key = `${browserId}_${userId}`;
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

  async copySelection(browserId, userId) {
    const key = `${browserId}_${userId}`;
    const session = this.userSessions.get(key);
    if (!session || session.tabs.length === 0) return '';

    const page = session.tabs[session.activeIndex].page;
    try {
      const text = await page.evaluate(() => window.getSelection().toString());
      session.clipboard = text;
      return text;
    } catch (e) {
      logger.error(browserId, `Copy failed: ${e.message}`);
      return '';
    }
  }

  async pasteText(browserId, userId, text) {
    const key = `${browserId}_${userId}`;
    const session = this.userSessions.get(key);
    if (!session || session.tabs.length === 0) return;

    // 更新虚拟剪贴板
    if (text) {
      session.clipboard = text;
    }

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

  _emitTabsUpdated(key) {
    const session = this.userSessions.get(key);
    if (!session) return;

    this._emitEvent(key, {
      type: 'tabs_updated',
      tabs: session.tabs.map((tab, index) => ({
        index,
        title: tab.title || 'New Tab',
        url: tab.url || 'about:blank',
        hasDialog: !!tab.pendingDialog
      })),
      activeIndex: session.activeIndex
    });
  }

  _emitTabSwitched(key, activeIndex) {
    this._emitEvent(key, {
      type: 'tab_switched',
      activeIndex
    });
  }

  // ============== 清理 ==============

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
        if (key.startsWith(`${browserId}_`)) {
          this.userSessions.delete(key);
          this.eventListeners.delete(key);
        }
      }
    }
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
        if (key.startsWith(`${browserId}_`)) {
          const parts = key.split('_');
          const userId = parts.slice(1).join('_');
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

  async closeAll() {
    this.stopHealthCheck();
    const browserIds = [...this.browsers.keys()];
    for (const browserId of browserIds) {
      await this.closeBrowser(browserId);
    }
  }
}

// 单例
const browserManager = new BrowserManager();

module.exports = browserManager;
