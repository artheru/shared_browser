/**
 * 浏览器事件日志系统
 * 记录每个浏览器的生命周期事件、错误、崩溃等
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

class BrowserLogger {
  constructor() {
    this.logDir = path.join(config.dataDir, 'logs');
    this.textLogDir = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    if (!fs.existsSync(this.textLogDir)) {
      fs.mkdirSync(this.textLogDir, { recursive: true });
    }
    this.maxLogEntries = 1000; // 每个浏览器最多保存的日志条数
    this.maxLogFileBytes = Number(config.logging?.maxFileBytes || 5 * 1024 * 1024);
    this.maxLogFiles = Number(config.logging?.maxFiles || 5);
  }

  _getLogFile(browserId) {
    return path.join(this.logDir, `${browserId}.json`);
  }

  _readLogs(browserId) {
    const logFile = this._getLogFile(browserId);
    if (!fs.existsSync(logFile)) return [];
    try {
      return JSON.parse(fs.readFileSync(logFile, 'utf-8'));
    } catch (e) {
      return [];
    }
  }

  _writeLogs(browserId, logs) {
    // 截断到最大条数
    if (logs.length > this.maxLogEntries) {
      logs = logs.slice(-this.maxLogEntries);
    }
    const logFile = this._getLogFile(browserId);
    try {
      fs.writeFileSync(logFile, JSON.stringify(logs, null, 2));
    } catch (e) {
      console.error(`[Logger] Failed to write logs: ${e.message}`);
    }
  }

  _getTextLogFile(baseName) {
    return path.join(this.textLogDir, `${baseName}.log`);
  }

  _rotateTextLogIfNeeded(baseName) {
    const currentFile = this._getTextLogFile(baseName);
    try {
      if (!fs.existsSync(currentFile)) return;
      const size = fs.statSync(currentFile).size;
      if (size < this.maxLogFileBytes) return;
      for (let i = this.maxLogFiles - 1; i >= 1; i--) {
        const src = `${currentFile}.${i}`;
        const dst = `${currentFile}.${i + 1}`;
        if (fs.existsSync(src)) {
          try {
            fs.renameSync(src, dst);
          } catch (e) {}
        }
      }
      fs.renameSync(currentFile, `${currentFile}.1`);
    } catch (e) {
      console.error(`[Logger] Failed to rotate text log ${baseName}: ${e.message}`);
    }
  }

  _appendTextLog(baseName, line) {
    const currentFile = this._getTextLogFile(baseName);
    this._rotateTextLogIfNeeded(baseName);
    try {
      fs.appendFileSync(currentFile, `${line}\n`, 'utf8');
    } catch (e) {
      console.error(`[Logger] Failed to append text log ${baseName}: ${e.message}`);
    }
  }

  _stringifyDetails(details) {
    if (details === null || details === undefined) return '';
    if (typeof details === 'string') return details;
    try {
      return JSON.stringify(details);
    } catch (e) {
      return String(details);
    }
  }

  /**
   * 记录日志
   * @param {string} browserId - 浏览器 ID
   * @param {'info'|'warn'|'error'|'crash'} level - 日志级别
   * @param {string} message - 日志消息
   * @param {*} details - 附加详情
   */
  log(browserId, level, message, details = null) {
    const detailsText = this._stringifyDetails(details);
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      details: detailsText || null
    };

    const logs = this._readLogs(browserId);
    logs.push(entry);
    this._writeLogs(browserId, logs);

    const textLine = `[${entry.timestamp}] [${level.toUpperCase()}] [${browserId}] ${message}${detailsText ? ` | ${detailsText}` : ''}`;
    this._appendTextLog('server', textLine);
    this._appendTextLog(browserId, textLine);

    // 同时输出到控制台
    const prefix = `[Browser:${browserId}]`;
    switch (level) {
      case 'error':
      case 'crash':
        console.error(`${prefix} [${level.toUpperCase()}] ${message}`, details || '');
        break;
      case 'warn':
        console.warn(`${prefix} [WARN] ${message}`, details || '');
        break;
      default:
        console.log(`${prefix} [INFO] ${message}`);
    }

    return entry;
  }

  info(browserId, message, details) { return this.log(browserId, 'info', message, details); }
  warn(browserId, message, details) { return this.log(browserId, 'warn', message, details); }
  error(browserId, message, details) { return this.log(browserId, 'error', message, details); }
  crash(browserId, message, details) { return this.log(browserId, 'crash', message, details); }

  /**
   * 获取某个浏览器的日志
   * @param {string} browserId
   * @param {number} limit - 最大返回条数
   * @param {string} level - 可选，筛选日志级别
   */
  getLogs(browserId, limit = 200, level = null) {
    let logs = this._readLogs(browserId);
    if (level) {
      logs = logs.filter(l => l.level === level);
    }
    return logs.slice(-limit);
  }

  /**
   * 获取所有浏览器的日志摘要
   * @param {number} limit - 每个浏览器返回的条数
   */
  getAllLogs(limit = 50) {
    const result = {};
    try {
      const files = fs.readdirSync(this.logDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const browserId = file.replace('.json', '');
          const logs = this._readLogs(browserId);
          result[browserId] = logs.slice(-limit);
        }
      }
    } catch (e) {
      console.error(`[Logger] Failed to read log directory: ${e.message}`);
    }
    return result;
  }

  /**
   * 获取所有浏览器的最新日志（合并排序）
   */
  getRecentLogs(limit = 100) {
    const allLogs = [];
    try {
      const files = fs.readdirSync(this.logDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const browserId = file.replace('.json', '');
          const logs = this._readLogs(browserId);
          for (const log of logs) {
            allLogs.push({ ...log, browserId });
          }
        }
      }
    } catch (e) {}

    // 按时间倒序排列
    allLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return allLogs.slice(0, limit);
  }

  /**
   * 清除某个浏览器的日志
   */
  clearLogs(browserId) {
    const logFile = this._getLogFile(browserId);
    if (fs.existsSync(logFile)) {
      fs.unlinkSync(logFile);
    }
  }

  /**
   * 获取所有有日志的浏览器 ID 列表
   */
  getBrowserIds() {
    try {
      const files = fs.readdirSync(this.logDir);
      return files
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''));
    } catch (e) {
      return [];
    }
  }
}

// 单例
const logger = new BrowserLogger();

module.exports = logger;
