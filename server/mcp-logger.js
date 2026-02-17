const fs = require('fs');
const path = require('path');
const config = require('./config');

class McpLogger {
  constructor() {
    this.logFile = path.join(config.dataDir, 'mcp-calls.json');
    this.maxEntries = 5000;
    this.maxStringLength = 1200;
    this.maxArrayLength = 30;
    this.ensureLogFile();
  }

  ensureLogFile() {
    if (!fs.existsSync(config.dataDir)) {
      fs.mkdirSync(config.dataDir, { recursive: true });
    }
    if (!fs.existsSync(this.logFile)) {
      fs.writeFileSync(this.logFile, JSON.stringify({ calls: [] }, null, 2));
    }
  }

  readAll() {
    this.ensureLogFile();
    try {
      const data = JSON.parse(fs.readFileSync(this.logFile, 'utf-8'));
      return Array.isArray(data.calls) ? data.calls : [];
    } catch (e) {
      return [];
    }
  }

  writeAll(calls) {
    const trimmed = calls.slice(-this.maxEntries);
    fs.writeFileSync(this.logFile, JSON.stringify({ calls: trimmed }, null, 2));
  }

  sanitize(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (depth > 4) return '[depth-truncated]';

    if (typeof value === 'string') {
      if (value.length > this.maxStringLength) {
        return `${value.slice(0, this.maxStringLength)}... [truncated ${value.length - this.maxStringLength} chars]`;
      }
      return value;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }

    if (Array.isArray(value)) {
      const trimmed = value.slice(0, this.maxArrayLength).map((item) => this.sanitize(item, depth + 1));
      if (value.length > this.maxArrayLength) {
        trimmed.push(`[truncated ${value.length - this.maxArrayLength} items]`);
      }
      return trimmed;
    }

    if (typeof value === 'object') {
      const out = {};
      const keys = Object.keys(value);
      for (const key of keys) {
        out[key] = this.sanitize(value[key], depth + 1);
      }
      return out;
    }

    return String(value);
  }

  log(entry) {
    const calls = this.readAll();
    const request = entry.request ? this.sanitize(entry.request) : undefined;
    const response = entry.response ? this.sanitize(entry.response) : undefined;
    calls.push({
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      ...entry,
      request,
      response
    });
    this.writeAll(calls);
  }

  list(limit = 200, browserId = null, source = null) {
    let calls = this.readAll();
    if (browserId) {
      calls = calls.filter((x) => x.browserId === browserId);
    }
    if (source) {
      const normalized = String(source).toLowerCase();
      calls = calls.filter((x) => String(x.source || '').toLowerCase() === normalized);
    }
    return calls.slice(-limit).reverse();
  }
}

module.exports = new McpLogger();
