const fs = require('fs');
const path = require('path');
const config = require('./config');

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
    // 已设置下载处理的页面（防止重复设置）
    this.setupPages = new WeakSet();
    // Download guid -> filename mapping
    this.downloadGuids = new Map(); // guid -> { suggestedFilename, timestamp }
  }

  // 为页面设置下载处理（支持多 Tab：每个新页面都调用一次）
  async setupDownloadHandling(page, browserId, userId) {
    // 防止同一页面重复设置
    if (this.setupPages.has(page)) {
      return;
    }
    this.setupPages.add(page);

    const key = `${browserId}_${userId}`;

    // 创建该用户的下载目录
    const userDownloadDir = path.join(config.downloadsDir, key);
    ensureDir(userDownloadDir);

    // 获取 CDP 会话
    try {
      const client = await page.target().createCDPSession();

      // 设置下载行为
      await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: userDownloadDir
      });

      // 监听下载开始事件（获取文件名）
      client.on('Page.downloadWillBegin', (event) => {
        this.downloadGuids.set(event.guid, {
          suggestedFilename: event.suggestedFilename,
          url: event.url,
          timestamp: Date.now()
        });
      });

      // 监听下载进度事件
      client.on('Page.downloadProgress', (event) => {
        const callback = this.downloadListeners.get(key);

        if (event.state === 'completed') {
          console.log(`[FileService] Download completed: ${key}`);
          const downloadInfo = this.downloadGuids.get(event.guid);
          const filename = downloadInfo?.suggestedFilename;
          this.downloadGuids.delete(event.guid);

          // Auto-stream: notify client to download, then schedule cleanup
          if (callback && filename) {
            callback({
              type: 'download_ready',
              filename,
              size: event.totalBytes
            });
            // Auto-cleanup after 60 seconds
            setTimeout(() => {
              try {
                const filePath = path.join(userDownloadDir, filename);
                if (fs.existsSync(filePath)) {
                  fs.unlinkSync(filePath);
                  console.log(`[FileService] Auto-cleaned: ${filePath}`);
                }
              } catch (e) { /* ignore */ }
            }, 60000);
          } else if (callback) {
            // Fallback: scan directory for latest file
            callback({
              type: 'download_progress',
              guid: event.guid,
              state: event.state,
              receivedBytes: event.receivedBytes,
              totalBytes: event.totalBytes
            });
          }
        } else if (callback) {
          callback({
            type: 'download_progress',
            guid: event.guid,
            state: event.state,
            receivedBytes: event.receivedBytes,
            totalBytes: event.totalBytes
          });
        }
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
  }

  // 处理文件上传
  async handleFileUpload(browserId, userId, filePath) {
    const key = `${browserId}_${userId}`;
    const fileChooser = this.pendingFileChoosers.get(key);

    if (!fileChooser) {
      throw new Error('No pending file chooser');
    }

    try {
      await fileChooser.accept([filePath]);
      this.pendingFileChoosers.delete(key);
      console.log(`[FileService] File upload successful: ${filePath}`);
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
    }).filter(Boolean);
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

  // 删除下载的文件
  deleteDownloadedFile(browserId, userId, filename) {
    const filePath = this.getDownloadFilePath(browserId, userId, filename);
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
