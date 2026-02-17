const config = require('./config');
const logger = require('./logger');

class StreamSession {
  constructor(page, ws, userId, browserId, options = {}) {
    this.page = page;
    this.ws = ws;
    this.userId = userId;
    this.browserId = browserId || 'unknown';
    this.running = false;

    // 自适应参数
    this.quality = config.stream.defaultQuality;
    this.fps = config.stream.defaultFps;
    this.interval = Math.floor(1000 / this.fps);

    // 统计数据
    this.framesSent = 0;
    this.bytesSent = 0;
    this.lastFrameTime = 0;
    this.lastSuccessTime = Date.now();
    this.createdAt = Date.now();
    this.firstFrameAt = null;

    // 客户端反馈
    this.clientRtt = 100;
    this.clientFps = this.fps;
    this.pendingFrames = 0;

    // 错误追踪
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 30; // 连续 30 帧错误后认为串流严重故障
    this.totalErrors = 0;
    this.captureCount = 0;
    this.captureDurationTotal = 0;
    this.lastCaptureDurationMs = 0;
    this.captureTimeouts = 0;
    this.slowCaptures = 0;
    this.recoveries = 0;
    this.captureInFlight = null;
    this.captureInFlightStartedAt = 0;
    this.switchFastFrames = 0;
    this.lastPageSwitchAt = 0;
    this.switchCaptureLogged = false;
    this.chromeFps = 0;
    this.lastMetricSampleAt = 0;
    this.lastMetricFrames = null;

    // Persistent CDP session (reused across frames to avoid per-frame overhead)
    this._cdpClient = null;

    // 回调
    this.onStreamDied = null; // 串流死亡回调
    this.keepAlive = !!options.keepAlive;
    this.onFrame = typeof options.onFrame === 'function' ? options.onFrame : null;
  }

  // 动态切换串流目标页面（Tab 切换时调用）
  setPage(page) {
    // Detach old CDP session when page changes (target changes)
    this._disposeCdpClient();
    this.page = page;
    this.consecutiveErrors = 0; // 切换页面时重置错误计数
    this.switchFastFrames = 10; // 切换后的前几帧优先低延迟恢复
    this.lastPageSwitchAt = Date.now();
    this.switchCaptureLogged = false;
  }

  // Safely detach and clear the cached CDP client
  _disposeCdpClient() {
    if (this._cdpClient) {
      const client = this._cdpClient;
      this._cdpClient = null;
      // detach() returns a promise; catch to prevent unhandled rejection crash
      try { client.detach().catch(() => {}); } catch (_) {}
    }
  }

  // 启动串流
  async start() {
    if (this.running) return;
    this.running = true;

    logger.info(this.browserId, `Stream started, userId: ${this.userId}`);

    this.streamLoop();
  }

  // 停止串流
  stop() {
    this.running = false;
    this._disposeCdpClient();
    logger.info(this.browserId, `Stream stopped, userId: ${this.userId}, totalFrames: ${this.framesSent}, errors: ${this.totalErrors}`);
  }

  markRecovered() {
    this.recoveries += 1;
    this.consecutiveErrors = 0;
  }

  getSessionKey() {
    return `${this.browserId}_${this.userId}`;
  }

  // 更新客户端反馈
  updateFeedback(feedback) {
    if (feedback.rtt !== undefined) {
      this.clientRtt = feedback.rtt;
    }
    if (feedback.fps !== undefined) {
      this.clientFps = feedback.fps;
    }
    if (feedback.pendingFrames !== undefined) {
      this.pendingFrames = feedback.pendingFrames;
    }

    // 根据反馈调整参数
    this.adaptQuality();
  }

  // 自适应质量调整
  adaptQuality() {
    const rtt = this.clientRtt;
    const pending = this.pendingFrames;

    // 根据 RTT 和待处理帧数调整
    if (rtt > 300 || pending > 5) {
      // 网络差，降低质量和帧率
      this.quality = Math.max(config.stream.minQuality, this.quality - 10);
      this.fps = Math.max(config.stream.minFps, this.fps - 2);
    } else if (rtt > 150 || pending > 2) {
      // 网络一般，轻微降低
      this.quality = Math.max(config.stream.minQuality, this.quality - 5);
      this.fps = Math.max(config.stream.minFps, this.fps - 1);
    } else if (rtt < 80 && pending === 0) {
      // 网络好，提升质量
      this.quality = Math.min(config.stream.maxQuality, this.quality + 5);
      this.fps = Math.min(config.stream.maxFps, this.fps + 1);
    }

    this.interval = Math.floor(1000 / this.fps);
  }

  // 串流循环
  async streamLoop() {
    while (this.running && (this.keepAlive || (this.ws && this.ws.readyState === 1))) { // WebSocket.OPEN = 1
      const startTime = Date.now();

      try {
        // 截取当前活跃页面的截图
        const captureStart = Date.now();
        const screenshot = await this.captureWithTimeout();
        const captureDuration = Date.now() - captureStart;

        if (this.onFrame) {
          try {
            this.onFrame(screenshot, {
              timestamp: startTime,
              quality: this.quality,
              size: screenshot.length
            });
          } catch (_) {}
        }

        // Sample Chrome render FPS from page metrics.
        this.sampleChromeFps().catch(() => {});

        // 发送帧数据（仅用户会话）
        if (this.ws && this.ws.readyState === 1) {
          const frameInfo = {
            type: 'frame',
            timestamp: startTime,
            quality: this.quality,
            size: screenshot.length
          };

          this.ws.send(JSON.stringify(frameInfo));
          this.ws.send(screenshot);

          this.framesSent++;
          this.bytesSent += screenshot.length;
          this.lastFrameTime = startTime;
          this.lastSuccessTime = startTime;
          this.lastCaptureDurationMs = captureDuration;
          this.captureDurationTotal += captureDuration;
          this.captureCount++;
          if (!this.firstFrameAt) this.firstFrameAt = startTime;
          if (captureDuration > Math.max(1200, (config.stream.screenshotTimeoutMs || 2500) / 2)) {
            this.slowCaptures += 1;
          }

          // 成功截图，重置连续错误计数
          this.consecutiveErrors = 0;
          if (!this.switchCaptureLogged && this.lastPageSwitchAt > 0) {
            const sinceSwitchMs = startTime - this.lastPageSwitchAt;
            logger.info(this.browserId, `Stream first frame after tab switch`, {
              userId: this.userId,
              sinceSwitchMs,
              captureDurationMs: captureDuration
            });
            this.switchCaptureLogged = true;
          }
          if (this.switchFastFrames > 0) {
            this.switchFastFrames -= 1;
          }
        }
      } catch (e) {
        const errorMessage = (e && typeof e.message === 'string') ? e.message : String(e);
        const pageUrl = this._safePageUrl();
        const lastSuccessAgeMs = Date.now() - (this.lastSuccessTime || Date.now());
        const inSwitchWarmup = this.switchFastFrames > 0;
        if (inSwitchWarmup) {
          this.switchFastFrames -= 1;
        } else {
          this.consecutiveErrors++;
        }
        this.totalErrors++;
        if (errorMessage.includes('Screenshot timeout')) {
          this.captureTimeouts += 1;
        }

        const errorType = this._classifyStreamError(errorMessage);

        if (errorType === 'page_closed') {
          logger.warn(this.browserId, `Stream: page closed (userId: ${this.userId})`, {
            errorType,
            errorMessage,
            pageUrl,
            consecutiveErrors: this.consecutiveErrors,
            totalErrors: this.totalErrors,
            captureTimeouts: this.captureTimeouts,
            lastSuccessAgeMs
          });
          this.running = false;

          // 通知串流已死亡（供上层恢复）
          if (this.onStreamDied) {
            this.onStreamDied('page_closed', errorMessage, {
              errorType,
              pageUrl,
              consecutiveErrors: this.consecutiveErrors,
              totalErrors: this.totalErrors,
              captureTimeouts: this.captureTimeouts,
              lastSuccessAgeMs
            });
          }
          break;
        }

        if (errorType === 'browser_disconnected') {
          logger.error(this.browserId, `Stream: browser disconnected (userId: ${this.userId})`, {
            errorType,
            errorMessage,
            pageUrl,
            consecutiveErrors: this.consecutiveErrors,
            totalErrors: this.totalErrors,
            captureTimeouts: this.captureTimeouts,
            lastSuccessAgeMs
          });
          this.running = false;

          if (this.onStreamDied) {
            this.onStreamDied('browser_disconnected', errorMessage, {
              errorType,
              pageUrl,
              consecutiveErrors: this.consecutiveErrors,
              totalErrors: this.totalErrors,
              captureTimeouts: this.captureTimeouts,
              lastSuccessAgeMs
            });
          }
          break;
        }

        // 连续错误过多
        if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
          logger.error(this.browserId, `Stream: ${this.consecutiveErrors} consecutive frame errors, stopping stream`, {
            errorType,
            errorMessage,
            pageUrl,
            inSwitchWarmup,
            totalErrors: this.totalErrors,
            captureTimeouts: this.captureTimeouts,
            lastSuccessAgeMs,
            captureInFlightMs: this.captureInFlightStartedAt ? (Date.now() - this.captureInFlightStartedAt) : 0
          });
          this.running = false;

          if (this.onStreamDied) {
            this.onStreamDied('too_many_errors', errorMessage, {
              errorType,
              pageUrl,
              inSwitchWarmup,
              consecutiveErrors: this.consecutiveErrors,
              totalErrors: this.totalErrors,
              captureTimeouts: this.captureTimeouts,
              lastSuccessAgeMs
            });
          }
          break;
        }

        // 间歇性错误（Tab 切换、页面刷新等），降低频率等待恢复
        if (errorType === 'capture_timeout' || (!inSwitchWarmup && this.consecutiveErrors % 10 === 0)) {
          logger.warn(this.browserId, `Stream frame capture issue`, {
            errorType,
            errorMessage,
            userId: this.userId,
            pageUrl,
            inSwitchWarmup,
            consecutiveErrors: this.consecutiveErrors,
            totalErrors: this.totalErrors,
            captureTimeouts: this.captureTimeouts,
            lastSuccessAgeMs,
            captureInFlightMs: this.captureInFlightStartedAt ? (Date.now() - this.captureInFlightStartedAt) : 0
          });
        }
      }

      // 等待下一帧
      const elapsed = Date.now() - startTime;
      const waitTime = Math.max(0, this.interval - elapsed);

      // 连续错误时增加等待时间（最多 2 秒）
      const errorWait = this.consecutiveErrors > 0
        ? Math.min(this.consecutiveErrors * 100, 2000)
        : 0;

      // 至少让出一次事件循环，避免极端情况下 tight loop 占满单核
      const totalWait = Math.max(1, waitTime + errorWait);
      await this.sleep(totalWait);
    }

    this.running = false;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async captureFrameBinary() {
    // Reuse persistent CDP session; create on first call or after failure.
    // If the cached session is stale (e.g. page navigated cross-origin), retry
    // once with a fresh session before bubbling the error up to the stream loop.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this._cdpClient) {
        try {
          this._cdpClient = await this.page.target().createCDPSession();
        } catch (createErr) {
          this._cdpClient = null;
          throw createErr; // page truly closed, let stream loop handle
        }
      }
      try {
        const result = await this._cdpClient.send('Page.captureScreenshot', {
          format: 'jpeg',
          quality: this.quality,
          fromSurface: true
        });
        return Buffer.from(result.data, 'base64');
      } catch (e) {
        // CDP session is broken; discard it
        this._disposeCdpClient();
        if (attempt === 0) {
          // First failure: retry with a fresh session (covers stale-session case)
          continue;
        }
        throw e; // second attempt also failed, page is truly gone
      }
    }
  }

  async captureWithTimeout() {
    const defaultTimeoutMs = config.stream.screenshotTimeoutMs || 2500;
    const timeoutMs = this.switchFastFrames > 0
      ? Math.min(defaultTimeoutMs, 900)
      : defaultTimeoutMs;
    if (this.captureInFlight) {
      const inFlightMs = Date.now() - this.captureInFlightStartedAt;
      // Defensive recovery: stale in-flight capture may block all future frames.
      // If it lives far beyond timeout, drop the stale reference and continue.
      if (inFlightMs > Math.max(2000, timeoutMs + 800)) {
        this.captureInFlight = null;
        this.captureInFlightStartedAt = 0;
      } else {
        throw new Error(`Screenshot still running for ${inFlightMs}ms`);
      }
    }
    if (this.captureInFlight) {
      const inFlightMs = Date.now() - this.captureInFlightStartedAt;
      throw new Error(`Screenshot still running for ${inFlightMs}ms`);
    }
    let timer = null;
    let timedOut = false;
    this.captureInFlightStartedAt = Date.now();
    const capturePromise = this.captureFrameBinary().finally(() => {
      this.captureInFlight = null;
      this.captureInFlightStartedAt = 0;
    });
    this.captureInFlight = capturePromise;
    try {
      return await Promise.race([
        capturePromise,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error(`Screenshot timeout after ${timeoutMs}ms`));
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        // Release blocked loop immediately; late capture settle is ignored.
        this.captureInFlight = null;
        this.captureInFlightStartedAt = 0;
      }
    }
  }

  _safePageUrl() {
    try {
      return this.page && this.page.url ? this.page.url() : '';
    } catch (_) {
      return '';
    }
  }

  _safeTargetId() {
    try {
      const target = this.page && this.page.target ? this.page.target() : null;
      return (target && (target._targetId || target?._targetInfo?.targetId)) || '';
    } catch (_) {
      return '';
    }
  }

  async sampleChromeFps() {
    const now = Date.now();
    if (!this.page || !this.page.metrics) return;
    if (now - this.lastMetricSampleAt < 2000) return;
    this.lastMetricSampleAt = now;
    const metrics = await this.page.metrics();
    const frames = Number(metrics?.Frames || 0);
    if (this.lastMetricFrames !== null && frames >= this.lastMetricFrames) {
      const deltaFrames = frames - this.lastMetricFrames;
      const deltaSec = Math.max(0.001, (now - (this._lastMetricAtForFps || now)) / 1000);
      this.chromeFps = Number((deltaFrames / deltaSec).toFixed(2));
    }
    this._lastMetricAtForFps = now;
    this.lastMetricFrames = frames;
  }

  _classifyStreamError(message) {
    if (!message) return 'unknown';
    if (message.includes('Screenshot timeout')) return 'capture_timeout';
    if (message.includes('Screenshot still running')) return 'capture_busy';
    if (message.includes('Not attached to an active page')) return 'page_closed';
    if (message.includes('No target with given id')) return 'page_closed';
    if (message.includes('Target closed') || message.includes('Session closed')) return 'page_closed';
    if (message.includes('Protocol error') || message.includes('Browser has disconnected')) return 'browser_disconnected';
    return 'unknown';
  }

  getStats() {
    const now = Date.now();
    const firstFrameDelayMs = this.firstFrameAt ? this.firstFrameAt - this.createdAt : null;
    const uptimeMs = Math.max(1, now - this.createdAt);
    const avgBandwidthBps = Math.round((this.bytesSent * 1000) / uptimeMs);
    const avgOutputFps = Number(((this.framesSent * 1000) / uptimeMs).toFixed(2));
    return {
      sessionKey: this.getSessionKey(),
      browserId: this.browserId,
      userId: this.userId,
      running: this.running,
      uptimeMs,
      framesSent: this.framesSent,
      bytesSent: this.bytesSent,
      avgBandwidthBps,
      avgOutputFps,
      chromeFps: this.chromeFps || 0,
      quality: this.quality,
      fps: this.fps,
      clientRtt: this.clientRtt,
      streamTargetId: this._safeTargetId(),
      streamPageUrl: this._safePageUrl(),
      consecutiveErrors: this.consecutiveErrors,
      totalErrors: this.totalErrors,
      lastSuccessTime: this.lastSuccessTime,
      lastSuccessAgeMs: now - this.lastSuccessTime,
      firstFrameDelayMs,
      lastCaptureDurationMs: this.lastCaptureDurationMs,
      avgCaptureDurationMs: this.captureCount > 0 ? Math.round(this.captureDurationTotal / this.captureCount) : 0,
      captureTimeouts: this.captureTimeouts,
      slowCaptures: this.slowCaptures,
      recoveries: this.recoveries
    };
  }
}

class StreamService {
  constructor() {
    this.sessions = new Map(); // `${browserId}_${userId}` -> StreamSession
    this.warmupSessions = new Map(); // browserId -> StreamSession
    this.latestFrames = new Map(); // browserId -> { buffer, timestamp, quality, size }
  }

  createSession(browserId, userId, page, ws) {
    const key = `${browserId}_${userId}`;

    // 如果已有会话，先停止
    if (this.sessions.has(key)) {
      this.sessions.get(key).stop();
    }

    const session = new StreamSession(page, ws, userId, browserId, {
      keepAlive: false,
      onFrame: (buffer, meta) => {
        this.latestFrames.set(browserId, {
          buffer,
          timestamp: meta.timestamp,
          quality: meta.quality,
          size: meta.size
        });
      }
    });
    this.sessions.set(key, session);

    return session;
  }

  ensureWarmupSession(browserId, page) {
    if (!browserId || !page) return null;
    const existing = this.warmupSessions.get(browserId);
    if (existing) {
      existing.setPage(page);
      if (!existing.running) existing.start();
      return existing;
    }
    const warmup = new StreamSession(page, null, '__warmup__', browserId, {
      keepAlive: true,
      onFrame: (buffer, meta) => {
        this.latestFrames.set(browserId, {
          buffer,
          timestamp: meta.timestamp,
          quality: meta.quality,
          size: meta.size
        });
      }
    });
    this.warmupSessions.set(browserId, warmup);
    warmup.start();
    return warmup;
  }

  stopWarmupSession(browserId) {
    const session = this.warmupSessions.get(browserId);
    if (session) {
      session.stop();
      this.warmupSessions.delete(browserId);
    }
    this.latestFrames.delete(browserId);
  }

  getLatestFrame(browserId) {
    return this.latestFrames.get(browserId) || null;
  }

  getSession(browserId, userId) {
    const key = `${browserId}_${userId}`;
    return this.sessions.get(key);
  }

  getAnySessionForBrowser(browserId) {
    for (const session of this.sessions.values()) {
      if (session.browserId !== browserId) continue;
      if (session.running) return session;
    }
    for (const session of this.sessions.values()) {
      if (session.browserId !== browserId) continue;
      return session;
    }
    return null;
  }

  stopSession(browserId, userId) {
    const key = `${browserId}_${userId}`;
    const session = this.sessions.get(key);

    if (session) {
      session.stop();
      this.sessions.delete(key);
    }
  }

  stopSessionsForBrowser(browserId) {
    for (const [key, session] of this.sessions.entries()) {
      if (!session || session.browserId !== browserId) continue;
      try {
        session.stop();
      } catch (_) {}
      this.sessions.delete(key);
    }
    this.stopWarmupSession(browserId);
    this.latestFrames.delete(browserId);
  }

  clearLatestFrame(browserId) {
    this.latestFrames.delete(browserId);
  }

  stopAll() {
    for (const [key, session] of this.sessions.entries()) {
      session.stop();
    }
    this.sessions.clear();
    for (const session of this.warmupSessions.values()) {
      session.stop();
    }
    this.warmupSessions.clear();
    this.latestFrames.clear();
  }

  getHealthStatus() {
    const sessions = [];
    const byBrowser = new Map();
    for (const session of this.sessions.values()) {
      const stat = session.getStats();
      sessions.push(stat);
      if (!byBrowser.has(stat.browserId)) {
        byBrowser.set(stat.browserId, {
          browserId: stat.browserId,
          sessions: 0,
          runningSessions: 0,
          totalErrors: 0,
          captureTimeouts: 0,
          maxConsecutiveErrors: 0,
          maxLastSuccessAgeMs: 0
        });
      }
      const item = byBrowser.get(stat.browserId);
      item.sessions += 1;
      if (stat.running) item.runningSessions += 1;
      item.totalErrors += stat.totalErrors;
      item.captureTimeouts += stat.captureTimeouts;
      item.maxConsecutiveErrors = Math.max(item.maxConsecutiveErrors, stat.consecutiveErrors);
      item.maxLastSuccessAgeMs = Math.max(item.maxLastSuccessAgeMs, stat.lastSuccessAgeMs);
    }
    return {
      sessions,
      browsers: Array.from(byBrowser.values())
    };
  }

  recoverSession(browserId, userId, page) {
    const key = `${browserId}_${userId}`;
    const session = this.sessions.get(key);
    if (!session) return { ok: false, error: 'Stream session not found' };
    if (!page) return { ok: false, error: 'No active page to recover' };
    session.setPage(page);
    session.markRecovered();
    if (!session.running) {
      session.start();
    }
    return { ok: true };
  }
}

// 单例
const streamService = new StreamService();

module.exports = streamService;
