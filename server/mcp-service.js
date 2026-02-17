const fs = require('fs');
const path = require('path');
const browserManager = require('./browser-manager');
const config = require('./config');
const fileService = require('./file-service');
const streamService = require('./stream-service');

class McpService {
  constructor() {
    this.consoleBuffer = new Map(); // browserId -> [{timestamp,type,text}]
    this.maxConsoleEntries = 500;
  }

  async getPage(browserId, userId = 'api') {
    // Prefer current caller's active session page to avoid acting on stale background tabs.
    let page = await browserManager.getPageForUser(browserId, userId);
    if (!page) {
      page = await browserManager.getAnyPage(browserId);
    }
    if (!page) {
      // WebAPI-first usage may not have an active WS viewer yet.
      page = await browserManager.getPageForUser(browserId, 'api');
    }
    if (!page) {
      throw new Error(`No active page for browser ${browserId}`);
    }
    this.ensureConsoleHook(browserId, page);
    // WebAPI-only flows may not have WS viewers, so make sure downloads are still captured.
    const downloadOwner = String(userId || 'api');
    if (page.__mcpDownloadReadyFor !== downloadOwner) {
      await fileService.setupDownloadHandling(page, browserId, downloadOwner);
      page.__mcpDownloadReadyFor = downloadOwner;
    }
    return page;
  }

  ensureConsoleHook(browserId, page) {
    if (page.__mcpConsoleHooked) return;
    page.__mcpConsoleHooked = true;
    page.on('console', (msg) => {
      const existing = this.consoleBuffer.get(browserId) || [];
      existing.push({
        timestamp: new Date().toISOString(),
        type: msg.type(),
        text: msg.text()
      });
      if (existing.length > this.maxConsoleEntries) {
        existing.splice(0, existing.length - this.maxConsoleEntries);
      }
      this.consoleBuffer.set(browserId, existing);
    });
    page.on('close', () => {
      // Clear per-page hook marker to avoid retaining stale state on reused objects.
      try {
        page.__mcpConsoleHooked = false;
      } catch (_) {}
    });
  }

  async screenshot(browserId, options = {}, userId = 'api') {
    const page = await this.getPage(browserId, userId);
    let image = '';
    let source = 'page_capture';
    const preferLiveFrame = options.useLiveFrame !== false && !options.fullPage;
    if (preferLiveFrame) {
      const latest = streamService.getLatestFrame(browserId);
      if (latest && latest.buffer) {
        image = latest.buffer.toString('base64');
        source = 'stream_latest_frame';
      }
    }
    if (!image) {
      image = await page.screenshot({
        type: 'png',
        fullPage: !!options.fullPage,
        encoding: 'base64'
      });
      source = 'page_capture';
    }
    const title = await page.title().catch(() => '');
    const url = page.url();
    const dialogs = this.getDialogStates(browserId);
    return { imageBase64: image, title, url, dialogs, source };
  }

  async resolvePoint(page, point = {}, selector = null) {
    if (selector) {
      const rect = await page.$eval(selector, (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      return rect;
    }
    return {
      x: Number(point.x || 0),
      y: Number(point.y || 0)
    };
  }

  async pointerAction(browserId, payload = {}, userId = 'api') {
    const page = await this.getPage(browserId, userId);
    const mouse = page.mouse;

    const start = await this.resolvePoint(page, payload.start, payload.startSelector);
    const end = await this.resolvePoint(page, payload.end || start, payload.endSelector);
    const button = payload.button || 'left';

    await mouse.move(start.x, start.y);

    if (payload.pressAtStart) {
      await mouse.down({ button });
    }

    if (start.x !== end.x || start.y !== end.y) {
      await mouse.move(end.x, end.y, { steps: payload.steps || 10 });
    }

    if (payload.wheelDeltaY || payload.wheelDeltaX) {
      await mouse.wheel({
        deltaX: Number(payload.wheelDeltaX || 0),
        deltaY: Number(payload.wheelDeltaY || 0)
      });
    }

    if (payload.clickAtEnd) {
      if (button === 'middle') {
        const href = await page.evaluate(({ px, py }) => {
          const el = document.elementFromPoint(px, py);
          const link = el && el.closest ? el.closest('a[href]') : null;
          return link ? link.href : '';
        }, { px: end.x, py: end.y }).catch(() => false);

        if (href) {
          await page.evaluate((url) => {
            window.open(url, '_blank');
          }, href);
        } else {
          await mouse.click(end.x, end.y, { button, clickCount: payload.clickCount || 1 });
        }
      } else {
        await mouse.click(end.x, end.y, { button, clickCount: payload.clickCount || 1 });
      }
    }

    if (payload.releaseAtEnd) {
      await mouse.up({ button });
    }

    return { ok: true, start, end };
  }

  async inputText(browserId, payload = {}, userId = 'api') {
    const page = await this.getPage(browserId, userId);
    const text = String(payload.text || '');
    if (payload.selector) {
      await page.focus(payload.selector);
    }
    if (payload.clearBefore && payload.selector) {
      await page.$eval(payload.selector, (el) => {
        if ('value' in el) {
          el.value = '';
        } else {
          el.textContent = '';
        }
      });
    }
    await page.keyboard.type(text, { delay: payload.delayMs || 0 });
    if (payload.pressEnter) {
      await page.keyboard.press('Enter');
    }
    return { ok: true };
  }

  async listDownloads(browserId) {
    const result = [];
    const seen = new Set();
    const rootDir = config.downloadsDir;
    if (!fs.existsSync(rootDir)) return result;

    const pushFilesFromDir = (userId, userDir) => {
      if (!fs.existsSync(userDir)) return;
      const files = fs.readdirSync(userDir, { withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => d.name);

      for (const name of files) {
        const filePath = path.join(userDir, name);
        if (seen.has(filePath)) continue;
        seen.add(filePath);
        const stat = fs.statSync(filePath);
        result.push({
          userId,
          name,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString()
        });
      }
    };

    // Current layout used by FileService: downloads/<browserId>_<userId>
    const flatEntries = fs.readdirSync(rootDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith(`${browserId}_`))
      .map((d) => d.name);
    for (const entry of flatEntries) {
      const userId = entry.slice(browserId.length + 1);
      if (!userId) continue;
      pushFilesFromDir(userId, path.join(rootDir, entry));
    }

    // Backward-compatible layout: downloads/<browserId>/<userId>
    const nestedBrowserDir = path.join(rootDir, browserId);
    if (fs.existsSync(nestedBrowserDir)) {
      const users = fs.readdirSync(nestedBrowserDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      for (const userId of users) {
        pushFilesFromDir(userId, path.join(nestedBrowserDir, userId));
      }
    }

    return result.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
  }

  async getHtml(browserId, userId = 'api') {
    const page = await this.getPage(browserId, userId);
    return {
      url: page.url(),
      html: await page.content()
    };
  }

  getConsole(browserId, limit = 200) {
    const list = this.consoleBuffer.get(browserId) || [];
    return list.slice(-limit).reverse();
  }

  clearConsoleBuffer(browserId) {
    this.consoleBuffer.delete(browserId);
  }

  async evalJs(browserId, script, userId = 'api') {
    const page = await this.getPage(browserId, userId);
    const value = await page.evaluate((src) => {
      // eslint-disable-next-line no-eval
      return eval(src);
    }, script);
    return { value };
  }

  getDialogStates(browserId) {
    const states = [];
    for (const [key, session] of browserManager.userSessions.entries()) {
      if (!(key.startsWith(`${browserId}_`) || key === `${browserId}__shared`)) continue;
      session.tabs.forEach((tab, index) => {
        if (!tab.pendingDialog) return;
        states.push({
          session: key,
          tabIndex: index,
          type: tab.pendingDialog.type(),
          message: tab.pendingDialog.message(),
          defaultValue: tab.pendingDialog.defaultValue()
        });
      });
    }
    return states;
  }
}

module.exports = new McpService();
