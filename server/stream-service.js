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

    // Transport adaptation: quality + stream downsampling are driven primarily by latency.
    // IMPORTANT: Do NOT change Chrome viewport resolution.
    // Chrome stays at 720p; we downsample the streamed frames (via startScreencast maxWidth/maxHeight).
    //
    // Policy:
    // - latency <= 100ms: Q80 x 1.0 (720p stream)
    // - latency >  100ms: lower quality down to Q20 (keep scale=1.0)
    // - if already Q20 and still high latency: drop stream scale down to 0.5 (360p), floor there.
    this._latencyMs = 0;
    this._highLatencyStreak = 0;
    this._lowLatencyStreak = 0;
    this._scale = 1.0;
    this._desiredScale = 1.0;

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

    // Screencast stream (event-driven) state
    this._screencastEnabled = false;
    this._onScreencastFrame = null;
    this._screencastRestartTimer = null;
    this._lastScreencastStartAt = 0;
    this._lastScreencastRestartAt = 0;
    this._screencastFps = 0;
    this._screencastFpsSampleAt = Date.now();
    this._screencastFramesSinceSample = 0;
    this._lastScreencastProcessedAt = 0;

    // Legacy capture loop guard (fallback when screencast stalls)
    this._legacyLoopRunning = false;
    this._legacyLoopRequested = false;

    // Watchdog: prevent permanent blank/stale frames when screencast stops emitting
    this._watchdogTimer = null;

    // Effective latency threshold used by adaptation (ms)
    // Spec: max(100ms, 1000/FPS).
    this._allowedLatencyMs = 100;

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

    // Avoid "no frames forever" after navigation/background throttling.
    this._startWatchdog();

    // Use Page.startScreencast: only produces frames when the page paints.
    // This avoids wasting CPU/bandwidth on unchanged pages.
    this._ensureScreencast().catch((e) => {
      // If screencast cannot start, fall back to legacy screenshot loop.
      logger.warn(this.browserId, `Failed to start screencast, fallback to capture loop: ${e.message}`, {
        userId: this.userId
      });
      this._ensureLegacyLoop();
    });
  }

  // 停止串流
  stop() {
    this.running = false;
    this._stopWatchdog();
    this._stopScreencast();
    this._disposeCdpClient();
    logger.info(this.browserId, `Stream stopped, userId: ${this.userId}, totalFrames: ${this.framesSent}, errors: ${this.totalErrors}`);
  }

  markRecovered() {
    this.recoveries += 1;
    this.consecutiveErrors = 0;
  }

  _startWatchdog() {
    if (this._watchdogTimer) return;
    this._watchdogTimer = setInterval(() => {
      try {
        if (!this.running) return;
        // Only meaningful for live WS viewers (warmup keepAlive can be idle)
        if (!this.ws || this.ws.readyState !== 1) return;
        const now = Date.now();
        const idleMs = now - Number(this.lastSuccessTime || 0);
        if (idleMs < 2500) return;

        // Prefer restarting screencast first. If it still doesn't recover, ensure legacy loop.
        this._forceRestartScreencast('watchdog_idle');
        if (idleMs > 8000) {
          this._ensureLegacyLoop();
        }
      } catch (_) {}
    }, 1500);
  }

  _stopWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  _ensureLegacyLoop() {
    if (this._legacyLoopRunning || this._legacyLoopRequested) return;
    this._legacyLoopRequested = true;
    this.streamLoop().catch(() => {}).finally(() => {
      this._legacyLoopRequested = false;
    });
  }

  _forceRestartScreencast(reason) {
    if (!this.running) return;
    if (!this._cdpClient) return;
    const now = Date.now();
    if (now - this._lastScreencastRestartAt < 2000) return;
    this._lastScreencastRestartAt = now;
    try { this._stopScreencast(); } catch (_) {}
    this._ensureScreencast().catch((e) => {
      logger.warn(this.browserId, `Force screencast restart failed (${reason}): ${e.message}`, {
        userId: this.userId
      });
      this._ensureLegacyLoop();
    });
  }

  recoverTransport(reason = 'manual') {
    // Called by external recover requests to kick the transport even if already running.
    this.markRecovered();
    this._forceRestartScreencast(`recover:${reason}`);
    this._ensureLegacyLoop();
  }

  getSessionKey() {
    return `${this.browserId}_${this.userId}`;
  }

  // 更新客户端反馈
  updateFeedback(feedback) {
    // NOTE: do not trust client-side RTT derived from frame timestamps.
    // Server/client clocks can be skewed, causing bogus "huge latency".
    // We update RTT from the WS ping/pong loop via updateNetworkRtt().
    if (feedback.fps !== undefined) {
      this.clientFps = feedback.fps;
    }
    if (feedback.pendingFrames !== undefined) {
      this.pendingFrames = feedback.pendingFrames;
    }

    // 根据反馈调整参数
    this.adaptQuality();
  }

  updateNetworkRtt(rttMs) {
    const rtt = Math.max(0, Number(rttMs || 0));
    if (!Number.isFinite(rtt)) return;
    this.clientRtt = rtt;
    this._latencyMs = rtt;
    this.adaptQuality();
  }

  // 自适应质量调整
  adaptQuality() {
    const latencyMs = Number(this._latencyMs || 0);
    if (!Number.isFinite(latencyMs) || latencyMs <= 0) return;

    // Use client-reported display FPS if available; it reflects real delivery/paint on the viewer.
    const effectiveFps = Math.max(1, Number(this.clientFps || 0) || Number(this.fps || 15));
    const LOW_LATENCY_MS = Math.max(100, Math.round(1000 / effectiveFps));
    this._allowedLatencyMs = LOW_LATENCY_MS;
    const QUALITY_GOOD = 80;
    const QUALITY_MIN = 20;
    const SCALE_GOOD = 1.0;
    const SCALE_MIN = 0.5;

    if (latencyMs <= LOW_LATENCY_MS) {
      this._highLatencyStreak = 0;
      this._lowLatencyStreak += 1;

      // Snap back to the desired quality when latency is good.
      this.quality = QUALITY_GOOD;
      this.quality = Math.min(config.stream.maxQuality, Math.max(config.stream.minQuality, this.quality));

      // Restore scale after a small streak to avoid flapping around the threshold.
      if (this._lowLatencyStreak >= 2) {
        this._setDesiredScale(SCALE_GOOD);
      }
    } else {
      this._lowLatencyStreak = 0;
      this._highLatencyStreak += 1;

      // Step down quality until it reaches Q20.
      if (this.quality > QUALITY_MIN) {
        const step = 5;
        this.quality = Math.max(QUALITY_MIN, this.quality - step);
      }

      // If we're already at minimum quality and still high latency, reduce stream scale to 360p.
      if (this.quality <= QUALITY_MIN && this._highLatencyStreak >= 2) {
        this._setDesiredScale(SCALE_MIN);
      }
    }

    // Keep FPS stable (avoid dropping to Q20 due to pending frames alone).
    this.interval = Math.floor(1000 / this.fps);

    // Restart screencast when quality/viewport target changes (throttled).
    this._scheduleScreencastRestart();
  }

  _setDesiredScale(value) {
    const n = Number(value || 1);
    if (!Number.isFinite(n) || n <= 0) return;
    const clamped = Math.max(0.5, Math.min(1.0, n));
    this._desiredScale = clamped;
  }

  _getScreencastDims() {
    const baseW = Number(config.stream.viewportWidth || 1280);
    const baseH = Number(config.stream.viewportHeight || 720);
    // Apply desired scale but do NOT change the underlying Chrome viewport.
    const scale = Math.max(0.5, Math.min(1.0, Number(this._desiredScale || 1)));
    const w = Math.max(320, Math.floor(baseW * scale));
    const h = Math.max(180, Math.floor(baseH * scale));
    // Track applied scale used for this screencast stream.
    this._scale = scale;
    return { maxWidth: w, maxHeight: h, scale };
  }

  async _ensureScreencast() {
    if (this._screencastEnabled) return;
    if (!this.page) throw new Error('No page');
    // Create CDP session if needed
    if (!this._cdpClient) {
      this._cdpClient = await this.page.target().createCDPSession();
    }
    const client = this._cdpClient;

    // Make sure Page domain is available
    try { await client.send('Page.enable'); } catch (_) {}

    // Register event handler once
    this._onScreencastFrame = async (params) => {
      if (!this.running) return;
      try {
        // Always ACK to keep frames flowing
        const sid = params && params.sessionId;
        if (sid) {
          try { await client.send('Page.screencastFrameAck', { sessionId: sid }); } catch (_) {}
        }

        const dataB64 = params && params.data;
        if (!dataB64) return;
        const now = Date.now();

        // Screencast FPS is the paint-driven rate of Chrome->server frames.
        this._screencastFramesSinceSample += 1;
        const dt = now - this._screencastFpsSampleAt;
        if (dt >= 1000) {
          this._screencastFps = Number(((this._screencastFramesSinceSample * 1000) / dt).toFixed(1));
          this._screencastFramesSinceSample = 0;
          this._screencastFpsSampleAt = now;
        }

        // High-refresh pages can paint at 60+ fps; do not decode+push every paint frame.
        // We keep Chrome sending frames (ACK always), but only process at target FPS.
        const targetFps = Math.max(1, Number(this.fps || 15));
        const minIntervalMs = Math.max(1, Math.floor(1000 / targetFps));
        if (this._lastScreencastProcessedAt && (now - this._lastScreencastProcessedAt) < minIntervalMs) {
          return;
        }
        this._lastScreencastProcessedAt = now;

        const buf = Buffer.from(dataB64, 'base64');

        if (this.onFrame) {
          try {
            this.onFrame(buf, { timestamp: now, quality: this.quality, size: buf.length });
          } catch (_) {}
        }

        // If the client can't keep up, drop delivery (keep latest frame updated via onFrame).
        const MAX_WS_BUFFERED = 3 * 1024 * 1024; // 3MB
        const canSend = !!(this.ws && this.ws.readyState === 1 && (this.ws.bufferedAmount || 0) < MAX_WS_BUFFERED);
        if (canSend) {
          this.ws.send(JSON.stringify({
            type: 'frame',
            timestamp: now,
            quality: this.quality,
            size: buf.length
          }));
          this.ws.send(buf);
          this.framesSent++;
          this.bytesSent += buf.length;
        }
        this.lastFrameTime = now;
        this.lastSuccessTime = now;
        if (!this.firstFrameAt) this.firstFrameAt = now;
        this.consecutiveErrors = 0;
      } catch (e) {
        this.totalErrors++;
        this.consecutiveErrors++;
        const errorMessage = (e && typeof e.message === 'string') ? e.message : String(e);
        const errorType = this._classifyStreamError(errorMessage);
        if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
          this.running = false;
          this._stopScreencast();
          this.onStreamDied && this.onStreamDied('too_many_errors', errorMessage, {
            errorType,
            totalErrors: this.totalErrors,
            consecutiveErrors: this.consecutiveErrors
          });
        }
      }
    };
    client.on('Page.screencastFrame', this._onScreencastFrame);

    const dims = this._getScreencastDims();
    await client.send('Page.startScreencast', {
      format: 'jpeg',
      quality: Math.max(0, Math.min(100, Number(this.quality || 80))),
      maxWidth: dims.maxWidth,
      maxHeight: dims.maxHeight,
      everyNthFrame: 1
    });

    this._screencastEnabled = true;
    this._lastScreencastStartAt = Date.now();
  }

  _stopScreencast() {
    if (this._screencastRestartTimer) {
      clearTimeout(this._screencastRestartTimer);
      this._screencastRestartTimer = null;
    }
    if (!this._screencastEnabled) return;
    this._screencastEnabled = false;
    const client = this._cdpClient;
    if (client) {
      try { client.send('Page.stopScreencast').catch(() => {}); } catch (_) {}
      if (this._onScreencastFrame) {
        try { client.off('Page.screencastFrame', this._onScreencastFrame); } catch (_) {}
      }
    }
    this._onScreencastFrame = null;
  }

  _scheduleScreencastRestart() {
    if (!this._screencastEnabled) return;
    if (this._screencastRestartTimer) return;
    // Throttle restarts (quality may adjust often)
    const now = Date.now();
    if (now - this._lastScreencastStartAt < 2500) return;
    this._screencastRestartTimer = setTimeout(async () => {
      this._screencastRestartTimer = null;
      if (!this.running) return;
      // Restart to apply quality / dimension changes.
      try {
        this._stopScreencast();
        await this._ensureScreencast();
      } catch (e) {
        logger.warn(this.browserId, `Screencast restart failed: ${e.message}`, { userId: this.userId });
      }
    }, 350);
  }

  // 串流循环
  async streamLoop() {
    if (this._legacyLoopRunning) return;
    this._legacyLoopRunning = true;
    this._legacyLoopRequested = false;
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
    this._legacyLoopRunning = false;
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
      screencastFps: Number(this._screencastFps || 0),
      quality: this.quality,
      fps: this.fps,
      clientRtt: this.clientRtt,
      allowedLatencyMs: Number(this._allowedLatencyMs || 100),
      scale: Number(this._scale || 1.0),
      desiredScale: Number(this._desiredScale || 1.0),
      decision: `Q${Number(this.quality || 0)}x${Number(this._scale || 1.0).toFixed(2)}`,
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

    // Warmup is only for "no viewer" cases; stop it once a real viewer session exists,
    // otherwise it can overwrite latestFrames with stale/other pages.
    this.stopWarmupSession(browserId);

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
    if (!session.running) session.start();
    // Even if running, restart transport to avoid being stuck with no frames.
    session.recoverTransport('api');
    return { ok: true };
  }
}

// 单例
const streamService = new StreamService();

module.exports = streamService;
