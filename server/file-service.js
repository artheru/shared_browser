const fs = require('fs');
const path = require('path');
const config = require('./config');
const browserManager = require('./browser-manager');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

class FileService {
  constructor() {
    ensureDir(config.uploadsDir);
    ensureDir(config.downloadsDir);

    // 下载/文件事件监听器
    this.downloadListeners = new Map(); // browserId_userId -> callback
    // 待处理的文件选择器
    this.pendingFileChoosers = new Map(); // browserId_userId -> fileChooser
    // 页面下载会话信息：page -> { client, key, downloadDir }
    this.pageSessions = new WeakMap();
    // key -> Set<CDPSession>
    this.downloadClients = new Map();
    // Download guid -> filename mapping
    this.downloadGuids = new Map(); // guid -> { key, suggestedFilename, receivedBytes, totalBytes, state, timestamp }
  }

  _removeClientFromAllKeys(client) {
    if (!client) return;
    for (const [key, set] of this.downloadClients.entries()) {
      set.delete(client);
      if (set.size === 0) {
        this.downloadClients.delete(key);
      }
    }
  }

  // 为页面设置下载处理（支持多 Tab：每个新页面都调用一次）
  async setupDownloadHandling(page, browserId, userId) {
    const key = `${browserId}_${userId}`;

    // 创建该用户的下载目录
    const userDownloadDir = path.join(config.downloadsDir, key);
    ensureDir(userDownloadDir);

    let session = this.pageSessions.get(page);
    if (session && session.key === key) {
      return userDownloadDir;
    }

    // 同一页面切换操作者时，复用 CDP 会话并更新下载目录
    if (session && session.client) {
      try {
        const oldKey = session.key;
        await session.client.send('Page.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: userDownloadDir
        });
        session.key = key;
        session.downloadDir = userDownloadDir;
        if (!this.downloadClients.has(key)) {
          this.downloadClients.set(key, new Set());
        }
        this.downloadClients.get(key).add(session.client);
        if (oldKey && oldKey !== key && this.downloadClients.has(oldKey)) {
          this.downloadClients.get(oldKey).delete(session.client);
        }
        return userDownloadDir;
      } catch (e) {
        // 旧会话失效，继续重建
      }
    }

    try {
      const client = await page.target().createCDPSession();
      await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: userDownloadDir
      });

      session = { client, key, downloadDir: userDownloadDir };
      this.pageSessions.set(page, session);
      if (!this.downloadClients.has(key)) {
        this.downloadClients.set(key, new Set());
      }
      this.downloadClients.get(key).add(client);

      client.on('Page.downloadWillBegin', (event) => {
        const activeSession = this.pageSessions.get(page);
        const ownerKey = activeSession?.key || key;
        const callback = this.downloadListeners.get(ownerKey);
        const payload = {
          guid: event.guid,
          state: 'started',
          filename: event.suggestedFilename,
          url: event.url,
          receivedBytes: 0,
          totalBytes: 0,
          progress: 0
        };
        this.downloadGuids.set(event.guid, {
          key: ownerKey,
          suggestedFilename: event.suggestedFilename,
          url: event.url,
          state: 'started',
          receivedBytes: 0,
          totalBytes: 0,
          timestamp: Date.now()
        });
        if (callback) {
          callback({ type: 'download_progress', ...payload });
        }
      });

      client.on('Page.downloadProgress', (event) => {
        const info = this.downloadGuids.get(event.guid);
        const ownerKey = info?.key;
        const callback = ownerKey ? this.downloadListeners.get(ownerKey) : null;
        const filename = info?.suggestedFilename || null;
        const receivedBytes = Number(event.receivedBytes || 0);
        const totalBytes = Number(event.totalBytes || 0);
        const progress = totalBytes > 0 ? Math.min(100, Math.round((receivedBytes * 100) / totalBytes)) : 0;

        if (info) {
          info.state = event.state;
          info.receivedBytes = receivedBytes;
          info.totalBytes = totalBytes;
          this.downloadGuids.set(event.guid, info);
        }

        if (callback) {
          callback({
            type: 'download_progress',
            guid: event.guid,
            state: event.state,
            filename,
            receivedBytes,
            totalBytes,
            progress
          });
        }

        if (event.state === 'completed') {
          console.log(`[FileService] Download completed: ${ownerKey || key}`);
          this.downloadGuids.delete(event.guid);
          if (callback && filename) {
            callback({
              type: 'download_ready',
              filename,
              size: totalBytes
            });
            const latestSession = this.pageSessions.get(page);
            const targetDir = latestSession?.downloadDir || userDownloadDir;
            setTimeout(() => {
              try {
                const filePath = path.join(targetDir, filename);
                if (fs.existsSync(filePath)) {
                  fs.unlinkSync(filePath);
                  console.log(`[FileService] Auto-cleaned: ${filePath}`);
                }
              } catch (e) { /* ignore */ }
            }, 60000);
          }
        }
      });

      page.on('close', () => {
        const closingSession = this.pageSessions.get(page);
        if (!closingSession || !closingSession.client) return;
        this._removeClientFromAllKeys(closingSession.client);
      });
    } catch (e) {
      console.error(`[FileService] Failed to setup download handling:`, e.message);
    }

    // 监听文件选择器
    page.on('filechooser', async (fileChooser) => {
      console.log(`[FileService] File chooser opened: ${key}`);
      this.pendingFileChoosers.set(key, fileChooser);

      const callback = this.downloadListeners.get(key);
      if (callback) {
        callback({
          type: 'file_chooser',
          isMultiple: fileChooser.isMultiple()
        });
      }
    });

    return userDownloadDir;
  }

  // 设置下载/文件事件监听器
  setListener(browserId, userId, callback) {
    const key = `${browserId}_${userId}`;
    this.downloadListeners.set(key, callback);
  }

  // 移除监听器
  removeListener(browserId, userId) {
    const key = `${browserId}_${userId}`;
    this.downloadListeners.delete(key);
    this.pendingFileChoosers.delete(key);
    this.downloadClients.delete(key);
    for (const [guid, info] of this.downloadGuids.entries()) {
      if (info && info.key === key) {
        this.downloadGuids.delete(guid);
      }
    }
  }

  cleanupBrowserResources(browserId) {
    const prefix = `${browserId}_`;
    for (const key of this.downloadListeners.keys()) {
      if (String(key).startsWith(prefix)) {
        this.downloadListeners.delete(key);
      }
    }
    for (const key of this.pendingFileChoosers.keys()) {
      if (String(key).startsWith(prefix)) {
        this.pendingFileChoosers.delete(key);
      }
    }
    for (const key of this.downloadClients.keys()) {
      if (String(key).startsWith(prefix)) {
        this.downloadClients.delete(key);
      }
    }
    for (const [guid, info] of this.downloadGuids.entries()) {
      if (info && String(info.key || '').startsWith(prefix)) {
        this.downloadGuids.delete(guid);
      }
    }
  }

  // 处理文件上传
  async handleFileUpload(browserId, userId, filePath) {
    const key = `${browserId}_${userId}`;
    const fileChooser = this.pendingFileChoosers.get(key);

    try {
      if (fileChooser) {
        await fileChooser.accept([filePath]);
        this.pendingFileChoosers.delete(key);
        console.log(`[FileService] File upload successful via chooser: ${filePath}`);
        return true;
      }

      // Fallback for MCP/WebAPI-driven flows where no filechooser event is pending.
      let page = await browserManager.getPageForUser(browserId, userId);
      if (!page) {
        page = await browserManager.getAnyPage(browserId);
      }
      if (!page) {
        throw new Error('No active page for file upload');
      }

      const input = await page.$('input[type="file"]');
      if (!input) {
        throw new Error('No pending file chooser and no file input found');
      }
      await input.uploadFile(filePath);
      await page.evaluate(() => {
        const el = document.querySelector('input[type="file"]');
        if (el) {
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      console.log(`[FileService] File upload successful via input fallback: ${filePath}`);
      return true;
    } catch (e) {
      console.error(`[FileService] File upload failed:`, e.message);
      throw e;
    }
  }

  // 取消文件选择
  async cancelFileChooser(browserId, userId) {
    const key = `${browserId}_${userId}`;
    const fileChooser = this.pendingFileChoosers.get(key);

    if (fileChooser) {
      try {
        await fileChooser.cancel();
      } catch (e) {
        // 忽略取消错误
      }
      this.pendingFileChoosers.delete(key);
    }
  }

  // 获取下载目录中的文件列表
  getDownloadedFiles(browserId, userId) {
    const key = `${browserId}_${userId}`;
    const userDownloadDir = path.join(config.downloadsDir, key);

    if (!fs.existsSync(userDownloadDir)) {
      return [];
    }

    const files = fs.readdirSync(userDownloadDir);
    return files.map(filename => {
      const filePath = path.join(userDownloadDir, filename);
      try {
        const stats = fs.statSync(filePath);
        return {
          name: filename,
          size: stats.size,
          mtime: stats.mtime
        };
      } catch (e) {
        return null;
      }
    }).filter(Boolean).sort((a, b) => {
      const ta = new Date(a.mtime).getTime();
      const tb = new Date(b.mtime).getTime();
      return tb - ta;
    });
  }

  _listBrowserDownloadDirs(browserId) {
    if (!fs.existsSync(config.downloadsDir)) return [];
    return fs.readdirSync(config.downloadsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith(`${browserId}_`))
      .map((d) => path.join(config.downloadsDir, d.name));
  }

  getDownloadedFilesForBrowser(browserId) {
    const dirs = this._listBrowserDownloadDirs(browserId);
    const files = [];
    const seen = new Set();
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const filename of fs.readdirSync(dir)) {
        const filePath = path.join(dir, filename);
        if (seen.has(filePath)) continue;
        seen.add(filePath);
        try {
          const stats = fs.statSync(filePath);
          files.push({
            name: filename,
            size: stats.size,
            mtime: stats.mtime
          });
        } catch (e) {}
      }
    }
    return files.sort((a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime());
  }

  // 获取下载文件的路径
  getDownloadFilePath(browserId, userId, filename) {
    const key = `${browserId}_${userId}`;
    const filePath = path.join(config.downloadsDir, key, filename);

    // 安全检查
    const normalizedPath = path.normalize(filePath);
    const normalizedBase = path.normalize(path.join(config.downloadsDir, key));

    if (!normalizedPath.startsWith(normalizedBase)) {
      throw new Error('Invalid file path');
    }

    if (!fs.existsSync(filePath)) {
      throw new Error('File not found');
    }

    return filePath;
  }

  getSharedDownloadFilePath(browserId, filename) {
    const dirs = this._listBrowserDownloadDirs(browserId);
    for (const dir of dirs) {
      const filePath = path.join(dir, filename);
      const normalizedPath = path.normalize(filePath);
      const normalizedBase = path.normalize(dir);
      if (!normalizedPath.startsWith(normalizedBase)) continue;
      if (fs.existsSync(filePath)) return filePath;
    }
    throw new Error('File not found');
  }

  // 删除下载的文件
  deleteDownloadedFile(browserId, userId, filename) {
    const filePath = this.getDownloadFilePath(browserId, userId, filename);
    fs.unlinkSync(filePath);
  }

  deleteSharedDownloadedFile(browserId, filename) {
    const filePath = this.getSharedDownloadFilePath(browserId, filename);
    fs.unlinkSync(filePath);
  }

  // 清理用户的下载目录
  clearDownloadDir(browserId, userId) {
    const key = `${browserId}_${userId}`;
    const userDownloadDir = path.join(config.downloadsDir, key);

    if (fs.existsSync(userDownloadDir)) {
      const files = fs.readdirSync(userDownloadDir);
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(userDownloadDir, file));
        } catch (e) {}
      }
    }
  }

  clearBrowserDownloadDirs(browserId) {
    const dirs = this._listBrowserDownloadDirs(browserId);
    for (const dir of dirs) {
      const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(dir, file));
        } catch (e) {}
      }
    }
  }

  getActiveDownloads(browserId, userId) {
    const key = `${browserId}_${userId}`;
    const out = [];
    for (const [guid, info] of this.downloadGuids.entries()) {
      if (!info || info.key !== key) continue;
      const totalBytes = Number(info.totalBytes || 0);
      const receivedBytes = Number(info.receivedBytes || 0);
      out.push({
        guid,
        filename: info.suggestedFilename || '',
        url: info.url || '',
        state: info.state || 'inProgress',
        receivedBytes,
        totalBytes,
        progress: totalBytes > 0 ? Math.min(100, Math.round((receivedBytes * 100) / totalBytes)) : 0,
        startedAt: info.timestamp || Date.now()
      });
    }
    out.sort((a, b) => b.startedAt - a.startedAt);
    return out;
  }

  getActiveDownloadsForBrowser(browserId) {
    const out = [];
    for (const [guid, info] of this.downloadGuids.entries()) {
      if (!info || !String(info.key || '').startsWith(`${browserId}_`)) continue;
      const totalBytes = Number(info.totalBytes || 0);
      const receivedBytes = Number(info.receivedBytes || 0);
      out.push({
        guid,
        filename: info.suggestedFilename || '',
        url: info.url || '',
        state: info.state || 'inProgress',
        receivedBytes,
        totalBytes,
        progress: totalBytes > 0 ? Math.min(100, Math.round((receivedBytes * 100) / totalBytes)) : 0,
        startedAt: info.timestamp || Date.now()
      });
    }
    out.sort((a, b) => b.startedAt - a.startedAt);
    return out;
  }

  async cancelDownload(browserId, userId, guid, allowShared = false) {
    const key = `${browserId}_${userId}`;
    const info = this.downloadGuids.get(guid);
    const own = !!(info && info.key === key);
    const shared = !!(allowShared && info && String(info.key || '').startsWith(`${browserId}_`));
    if (!own && !shared) {
      throw new Error('Download not found');
    }

    // 优先通过 Browser.cancelDownload 中止
    const clients = this.downloadClients.get(key);
    if (!clients || clients.size === 0) {
      throw new Error('No active download client');
    }
    for (const client of clients.values()) {
      try {
        await client.send('Browser.cancelDownload', { guid });
        return { success: true };
      } catch (e) {
        // 某些 Chromium 版本不支持，继续尝试其他会话
      }
    }
    throw new Error('Cancel download is not supported by current browser');
  }

  // 保存上传的文件
  saveUploadedFile(file) {
    const uploadPath = path.join(config.uploadsDir, `${Date.now()}_${file.originalname}`);
    fs.writeFileSync(uploadPath, file.buffer);
    return uploadPath;
  }

  // 保存多个上传的文件并返回路径数组
  saveUploadedFiles(files) {
    return files.map(file => {
      const uploadPath = path.join(config.uploadsDir, `${Date.now()}_${file.originalname}`);
      fs.writeFileSync(uploadPath, file.buffer);
      return uploadPath;
    });
  }

  // 处理拖拽文件上传
  async handleDropFiles(browserId, userId, filePaths, x, y, page) {
    const key = `${browserId}_${userId}`;
    const fileChooser = this.pendingFileChoosers.get(key);

    // 如果有待处理的文件选择器，优先使用文件选择器
    if (fileChooser) {
      try {
        await fileChooser.accept(filePaths);
        this.pendingFileChoosers.delete(key);
        console.log(`[FileService] Files uploaded via file chooser: ${filePaths.join(', ')}`);
        return { method: 'file_chooser' };
      } catch (e) {
        console.error(`[FileService] File chooser accept failed:`, e.message);
        this.pendingFileChoosers.delete(key);
        // 回退到拖放方式
      }
    }

    // 没有文件选择器 —— 通过 CDP 模拟拖放事件
    try {
      const client = await page.target().createCDPSession();

      const dragData = {
        items: [],
        files: filePaths,
        dragOperationsMask: 1 // Copy
      };

      const roundX = Math.round(x);
      const roundY = Math.round(y);

      await client.send('Input.dispatchDragEvent', {
        type: 'dragEnter',
        x: roundX,
        y: roundY,
        data: dragData
      });

      await new Promise(r => setTimeout(r, 50));

      await client.send('Input.dispatchDragEvent', {
        type: 'dragOver',
        x: roundX,
        y: roundY,
        data: dragData
      });

      await new Promise(r => setTimeout(r, 50));

      await client.send('Input.dispatchDragEvent', {
        type: 'drop',
        x: roundX,
        y: roundY,
        data: dragData
      });

      await client.detach();
      console.log(`[FileService] Drag-drop successful: ${filePaths.join(', ')} at (${roundX}, ${roundY})`);
      return { method: 'drag_drop' };
    } catch (e) {
      console.error(`[FileService] CDP drag-drop failed:`, e.message);
      throw e;
    }
  }
}

// 单例
const fileService = new FileService();

module.exports = fileService;
