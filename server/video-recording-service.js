const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const config = require('./config');
const browserManager = require('./browser-manager');
const logger = require('./logger');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function removeDirSafe(dir) {
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

class VideoRecordingService {
  constructor() {
    this.rootDir = config.recordingsDir || path.join(__dirname, '..', 'recordings');
    ensureDir(this.rootDir);
    this.active = new Map(); // `${browserId}_${userId}` -> { fileId, startedAt }
  }

  _sessionKey(browserId, userId) {
    return `${browserId}_${userId}`;
  }

  _browserDir(browserId) {
    const safe = String(browserId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.rootDir, safe);
  }

  _maxDurationSec() {
    const v = Number(config.recording.maxDurationSec || 15);
    if (!Number.isFinite(v) || v <= 0) return 15;
    return Math.min(15, Math.floor(v));
  }

  _maxSavedFiles() {
    const v = Number(config.recording.maxSavedFiles || 10);
    if (!Number.isFinite(v) || v <= 0) return 10;
    return Math.max(1, Math.floor(v));
  }

  _ffmpegPath() {
    return String(config.recording.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg');
  }

  _isValidFileId(fileId) {
    return /^[a-zA-Z0-9._-]+$/.test(String(fileId || ''));
  }

  _filePathFor(browserId, fileId) {
    if (!this._isValidFileId(fileId)) throw new Error('Invalid fileId');
    const browserDir = this._browserDir(browserId);
    const full = path.join(browserDir, `${fileId}.mp4`);
    const normFull = path.normalize(full);
    const normBase = path.normalize(browserDir);
    if (!normFull.startsWith(normBase)) throw new Error('Invalid file path');
    return full;
  }

  async _encodeMp4FromFrames(frameDir, outPath, fps) {
    const ffmpegPath = this._ffmpegPath();
    const framePattern = path.join(frameDir, 'frame_%06d.jpg');
    const args = [
      '-y',
      '-framerate', String(Math.max(1, Math.round(fps || 10))),
      '-i', framePattern,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outPath
    ];
    await new Promise((resolve, reject) => {
      let stderr = '';
      const p = spawn(ffmpegPath, args, { windowsHide: true });
      p.stderr.on('data', (buf) => {
        stderr += String(buf || '');
      });
      p.on('error', (err) => {
        if (err && err.code === 'ENOENT') {
          reject(new Error(`ffmpeg not found at "${ffmpegPath}". Configure recording.ffmpegPath or install ffmpeg.`));
          return;
        }
        reject(err);
      });
      p.on('exit', (code) => {
        if (code === 0) return resolve();
        reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-800)}`));
      });
    });
  }

  _collectVideoFiles(browserId) {
    const dir = this._browserDir(browserId);
    ensureDir(dir);
    const files = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.mp4'))
      .map((d) => {
        const filePath = path.join(dir, d.name);
        const st = fs.statSync(filePath);
        return {
          fileId: d.name.slice(0, -4),
          filename: d.name,
          path: filePath,
          size: st.size,
          createdAt: st.mtime.toISOString(),
          mtimeMs: st.mtimeMs
        };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files;
  }

  _pruneOld(browserId) {
    const maxSaved = this._maxSavedFiles();
    const files = this._collectVideoFiles(browserId);
    if (files.length <= maxSaved) return;
    for (const item of files.slice(maxSaved)) {
      try { fs.unlinkSync(item.path); } catch (_) {}
    }
  }

  listRecordedVideos(browserId) {
    this._pruneOld(browserId);
    return this._collectVideoFiles(browserId).map((x) => ({
      fileId: x.fileId,
      filename: x.filename,
      size: x.size,
      createdAt: x.createdAt,
      mimeType: 'video/mp4'
    }));
  }

  getVideoFileInfo(browserId, fileId) {
    const filePath = this._filePathFor(browserId, fileId);
    if (!fs.existsSync(filePath)) {
      throw new Error('Video not found');
    }
    const st = fs.statSync(filePath);
    return {
      fileId,
      filename: `${fileId}.mp4`,
      path: filePath,
      size: st.size,
      createdAt: st.mtime.toISOString(),
      mimeType: 'video/mp4'
    };
  }

  getVideoBase64(browserId, fileId) {
    const info = this.getVideoFileInfo(browserId, fileId);
    const contentBase64 = fs.readFileSync(info.path).toString('base64');
    return {
      fileId: info.fileId,
      filename: info.filename,
      size: info.size,
      mimeType: info.mimeType,
      createdAt: info.createdAt,
      contentBase64
    };
  }

  async startRecording(browserId, userId, payload = {}) {
    const durationRaw = Number(payload.durationSec ?? payload.duration ?? payload.seconds);
    if (!Number.isFinite(durationRaw) || durationRaw <= 0) {
      throw new Error('durationSec is required and must be > 0');
    }
    const maxDuration = this._maxDurationSec();
    const durationSec = Math.min(maxDuration, Math.max(1, Math.round(durationRaw)));
    if (durationRaw > maxDuration) {
      throw new Error(`durationSec exceeds max ${maxDuration}s`);
    }

    const key = this._sessionKey(browserId, userId);
    if (this.active.has(key)) {
      throw new Error('Recording already in progress for this session');
    }

    let page = await browserManager.getPageForUser(browserId, userId);
    if (!page) {
      page = await browserManager.getAnyPage(browserId);
    }
    if (!page) {
      throw new Error(`No active page for browser ${browserId}`);
    }

    const browserDir = this._browserDir(browserId);
    ensureDir(browserDir);
    const fileId = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const frameDir = path.join(browserDir, `tmp-${fileId}`);
    const outPath = path.join(browserDir, `${fileId}.mp4`);
    ensureDir(frameDir);

    const cdp = await page.target().createCDPSession();
    this.active.set(key, { fileId, startedAt: Date.now(), durationSec });

    let frameIndex = 0;
    let writeChain = Promise.resolve();
    const fpsTarget = Number(config.recording.fps || 10);

    const onFrame = async (params) => {
      const sid = params && params.sessionId;
      if (sid) {
        try { await cdp.send('Page.screencastFrameAck', { sessionId: sid }); } catch (_) {}
      }
      const dataB64 = params && params.data;
      if (!dataB64) return;
      const idx = ++frameIndex;
      const fpath = path.join(frameDir, `frame_${String(idx).padStart(6, '0')}.jpg`);
      const buf = Buffer.from(dataB64, 'base64');
      writeChain = writeChain.then(() => fs.promises.writeFile(fpath, buf)).catch(() => {});
    };

    const startedAt = Date.now();
    cdp.on('Page.screencastFrame', onFrame);
    try {
      try { await cdp.send('Page.enable'); } catch (_) {}
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: Math.max(10, Math.min(100, Number(config.recording.quality || 80))),
        maxWidth: Number(config.stream.viewportWidth || 1280),
        maxHeight: Number(config.stream.viewportHeight || 720),
        everyNthFrame: 1
      });
      await new Promise((resolve) => setTimeout(resolve, durationSec * 1000));
      try { await cdp.send('Page.stopScreencast'); } catch (_) {}
      try { cdp.off('Page.screencastFrame', onFrame); } catch (_) {}
      await writeChain;

      if (frameIndex < 2) {
        throw new Error('Captured too few frames for video recording');
      }

      const elapsedMs = Math.max(1, Date.now() - startedAt);
      const fps = Math.min(30, Math.max(1, Math.round((frameIndex * 1000) / elapsedMs) || fpsTarget));
      await this._encodeMp4FromFrames(frameDir, outPath, fps);
      const st = fs.statSync(outPath);
      this._pruneOld(browserId);
      const out = {
        fileId,
        filename: `${fileId}.mp4`,
        durationSec,
        frames: frameIndex,
        size: st.size,
        createdAt: st.mtime.toISOString(),
        mimeType: 'video/mp4'
      };
      logger.info(browserId, 'Video recording completed', {
        userId,
        fileId,
        durationSec,
        frames: frameIndex,
        size: st.size
      });
      return out;
    } finally {
      try { cdp.off('Page.screencastFrame', onFrame); } catch (_) {}
      try { await cdp.send('Page.stopScreencast'); } catch (_) {}
      try { await cdp.detach(); } catch (_) {}
      this.active.delete(key);
      removeDirSafe(frameDir);
    }
  }
}

module.exports = new VideoRecordingService();

