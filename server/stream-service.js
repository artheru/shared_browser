const config = require('./config');
const logger = require('./logger');

class StreamSession {
  constructor(page, ws, userId, browserId) {
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

    // 客户端反馈
    this.clientRtt = 100;
    this.clientFps = this.fps;
    this.pendingFrames = 0;

    // 错误追踪
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 30; // 连续 30 帧错误后认为串流严重故障
    this.totalErrors = 0;

    // 回调
    this.onStreamDied = null; // 串流死亡回调
  }

  // 动态切换串流目标页面（Tab 切换时调用）
  setPage(page) {
    this.page = page;
    this.consecutiveErrors = 0; // 切换页面时重置错误计数
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
    logger.info(this.browserId, `Stream stopped, userId: ${this.userId}, totalFrames: ${this.framesSent}, errors: ${this.totalErrors}`);
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
    while (this.running && this.ws.readyState === 1) { // WebSocket.OPEN = 1
      const startTime = Date.now();

      try {
        // 截取当前活跃页面的截图
        const screenshot = await this.page.screenshot({
          type: 'jpeg',
          quality: this.quality,
          encoding: 'binary'
        });

        // 发送帧数据
        if (this.ws.readyState === 1) {
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

          // 成功截图，重置连续错误计数
          this.consecutiveErrors = 0;
        }
      } catch (e) {
        this.consecutiveErrors++;
        this.totalErrors++;

        if (e.message.includes('Target closed') || e.message.includes('Session closed')) {
          logger.warn(this.browserId, `Stream: page closed (userId: ${this.userId})`);
          this.running = false;

          // 通知串流已死亡（供上层恢复）
          if (this.onStreamDied) {
            this.onStreamDied('page_closed', e.message);
          }
          break;
        }

        if (e.message.includes('Protocol error') || e.message.includes('Browser has disconnected')) {
          logger.error(this.browserId, `Stream: browser disconnected (userId: ${this.userId})`);
          this.running = false;

          if (this.onStreamDied) {
            this.onStreamDied('browser_disconnected', e.message);
          }
          break;
        }

        // 连续错误过多
        if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
          logger.error(this.browserId, `Stream: ${this.consecutiveErrors} consecutive frame errors, stopping stream`, e.message);
          this.running = false;

          if (this.onStreamDied) {
            this.onStreamDied('too_many_errors', e.message);
          }
          break;
        }

        // 间歇性错误（Tab 切换、页面刷新等），降低频率等待恢复
        if (this.consecutiveErrors % 10 === 0) {
          logger.warn(this.browserId, `Stream: ${this.consecutiveErrors} consecutive frame errors`, e.message);
        }
      }

      // 等待下一帧
      const elapsed = Date.now() - startTime;
      const waitTime = Math.max(0, this.interval - elapsed);

      // 连续错误时增加等待时间（最多 2 秒）
      const errorWait = this.consecutiveErrors > 0
        ? Math.min(this.consecutiveErrors * 100, 2000)
        : 0;

      const totalWait = waitTime + errorWait;

      if (totalWait > 0) {
        await this.sleep(totalWait);
      }
    }

    this.running = false;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getStats() {
    return {
      framesSent: this.framesSent,
      bytesSent: this.bytesSent,
      quality: this.quality,
      fps: this.fps,
      clientRtt: this.clientRtt,
      consecutiveErrors: this.consecutiveErrors,
      totalErrors: this.totalErrors,
      lastSuccessTime: this.lastSuccessTime
    };
  }
}

class StreamService {
  constructor() {
    this.sessions = new Map(); // `${browserId}_${userId}` -> StreamSession
  }

  createSession(browserId, userId, page, ws) {
    const key = `${browserId}_${userId}`;

    // 如果已有会话，先停止
    if (this.sessions.has(key)) {
      this.sessions.get(key).stop();
    }

    const session = new StreamSession(page, ws, userId, browserId);
    this.sessions.set(key, session);

    return session;
  }

  getSession(browserId, userId) {
    const key = `${browserId}_${userId}`;
    return this.sessions.get(key);
  }

  stopSession(browserId, userId) {
    const key = `${browserId}_${userId}`;
    const session = this.sessions.get(key);

    if (session) {
      session.stop();
      this.sessions.delete(key);
    }
  }

  stopAll() {
    for (const [key, session] of this.sessions.entries()) {
      session.stop();
    }
    this.sessions.clear();
  }
}

// 单例
const streamService = new StreamService();

module.exports = streamService;
