/**
 * User usage statistics tracker
 * Tracks per-session: mouse distance, input count, page views, downloads, uploads
 */

class UsageTracker {
  constructor() {
    // `${browserId}_${userId}` -> stats
    this.sessions = new Map();
  }

  _getKey(browserId, userId) {
    return `${browserId}_${userId}`;
  }

  _ensureSession(browserId, userId) {
    const key = this._getKey(browserId, userId);
    if (!this.sessions.has(key)) {
      this.sessions.set(key, {
        browserId,
        userId,
        connectedAt: Date.now(),
        lastActiveAt: Date.now(),
        mouseDistance: 0,
        lastMouseX: null,
        lastMouseY: null,
        inputCount: 0,
        pageViews: 0,
        downloadCount: 0,
        uploadCount: 0,
      });
    }
    return this.sessions.get(key);
  }

  startSession(browserId, userId) {
    return this._ensureSession(browserId, userId);
  }

  endSession(browserId, userId) {
    const key = this._getKey(browserId, userId);
    this.sessions.delete(key);
  }

  trackMouseMove(browserId, userId, x, y) {
    const s = this._ensureSession(browserId, userId);
    s.lastActiveAt = Date.now();
    if (s.lastMouseX !== null && s.lastMouseY !== null) {
      const dx = x - s.lastMouseX;
      const dy = y - s.lastMouseY;
      s.mouseDistance += Math.sqrt(dx * dx + dy * dy);
    }
    s.lastMouseX = x;
    s.lastMouseY = y;
  }

  trackInput(browserId, userId) {
    const s = this._ensureSession(browserId, userId);
    s.lastActiveAt = Date.now();
    s.inputCount++;
  }

  trackPageView(browserId, userId) {
    const s = this._ensureSession(browserId, userId);
    s.lastActiveAt = Date.now();
    s.pageViews++;
  }

  trackDownload(browserId, userId) {
    const s = this._ensureSession(browserId, userId);
    s.downloadCount++;
  }

  trackUpload(browserId, userId) {
    const s = this._ensureSession(browserId, userId);
    s.uploadCount++;
  }

  getSessionStats(browserId, userId) {
    const key = this._getKey(browserId, userId);
    const s = this.sessions.get(key);
    if (!s) return null;
    return {
      ...s,
      mouseDistance: Math.round(s.mouseDistance),
      connectedDuration: Date.now() - s.connectedAt,
    };
  }

  getAllStats() {
    const result = [];
    for (const s of this.sessions.values()) {
      result.push({
        browserId: s.browserId,
        userId: s.userId,
        connectedAt: s.connectedAt,
        lastActiveAt: s.lastActiveAt,
        mouseDistance: Math.round(s.mouseDistance),
        inputCount: s.inputCount,
        pageViews: s.pageViews,
        downloadCount: s.downloadCount,
        uploadCount: s.uploadCount,
        connectedDuration: Date.now() - s.connectedAt,
      });
    }
    return result;
  }
}

const usageTracker = new UsageTracker();
module.exports = usageTracker;
