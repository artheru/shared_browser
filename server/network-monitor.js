/**
 * 页面网络活动监控器
 * 通过 CDP Network 域追踪远程浏览器的网络请求和带宽
 */

class NetworkMonitor {
  constructor() {
    this.client = null;
    this.page = null;

    // 实时统计
    this.activeRequests = 0;
    this.totalBytes = 0;
    this.requestCount = 0;

    // 滑动窗口统计（每次 getStats 后重置）
    this.windowBytes = 0;
    this.windowRequests = 0;
    this.windowStartTime = Date.now();

    // 绑定事件处理器（便于移除）
    this._onRequestWillBeSent = this._onRequestWillBeSent.bind(this);
    this._onLoadingFinished = this._onLoadingFinished.bind(this);
    this._onLoadingFailed = this._onLoadingFailed.bind(this);
    this._onResponseReceived = this._onResponseReceived.bind(this);
  }

  /**
   * 附加到页面，开始监控网络活动
   */
  async attach(page) {
    await this.detach(); // 先清理旧的
    this.page = page;

    try {
      this.client = await page.target().createCDPSession();
      // 启用 Network 域，不缓存请求体（节省内存）
      await this.client.send('Network.enable', {
        maxTotalBufferSize: 0,
        maxResourceBufferSize: 0
      });

      this.client.on('Network.requestWillBeSent', this._onRequestWillBeSent);
      this.client.on('Network.loadingFinished', this._onLoadingFinished);
      this.client.on('Network.loadingFailed', this._onLoadingFailed);
      this.client.on('Network.responseReceived', this._onResponseReceived);

      // 重置统计
      this.activeRequests = 0;
      this.windowBytes = 0;
      this.windowRequests = 0;
      this.windowStartTime = Date.now();

    } catch (e) {
      // 页面可能已关闭
      console.error('[NetworkMonitor] Attach failed:', e.message);
      this.client = null;
    }
  }

  _onRequestWillBeSent() {
    this.activeRequests++;
    this.requestCount++;
    this.windowRequests++;
  }

  _onLoadingFinished(params) {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    const bytes = params.encodedDataLength || 0;
    this.totalBytes += bytes;
    this.windowBytes += bytes;
  }

  _onLoadingFailed() {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
  }

  _onResponseReceived(params) {
    // 可以追踪响应头大小等，暂不需要
  }

  /**
   * 获取统计信息（调用后重置滑动窗口）
   */
  getStats() {
    const now = Date.now();
    const elapsed = (now - this.windowStartTime) / 1000;
    const bytesPerSec = elapsed > 0 ? Math.round(this.windowBytes / elapsed) : 0;
    const reqPerSec = elapsed > 0 ? Math.round(this.windowRequests / elapsed * 10) / 10 : 0;

    // 重置滑动窗口
    this.windowBytes = 0;
    this.windowRequests = 0;
    this.windowStartTime = now;

    return {
      activeRequests: this.activeRequests,
      totalBytes: this.totalBytes,
      requestCount: this.requestCount,
      bytesPerSec,
      reqPerSec
    };
  }

  /**
   * 分离监控器
   */
  async detach() {
    if (this.client) {
      try {
        this.client.removeAllListeners();
        await this.client.detach();
      } catch (e) {
        // 忽略分离错误
      }
      this.client = null;
    }
    this.page = null;
    this.activeRequests = 0;
    this.windowBytes = 0;
    this.windowRequests = 0;
    this.windowStartTime = Date.now();
  }
}

module.exports = NetworkMonitor;
