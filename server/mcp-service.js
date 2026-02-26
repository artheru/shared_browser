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
    this.clipboardStore = new Map(); // `${browserId}_${userId}` -> { text, html, files, updatedAt, source }
  }

  _clipboardKey(browserId, userId = 'api') {
    return `${browserId}_${userId || 'api'}`;
  }

  _getSessionClipboard(browserId, userId = 'api') {
    const clip = browserManager.getClipboard(browserId, userId);
    return clip?.text || '';
  }

  _setClipboard(browserId, userId, payload = {}) {
    const key = this._clipboardKey(browserId, userId);
    const current = this.clipboardStore.get(key) || {};
    const next = {
      text: payload.text !== undefined ? String(payload.text || '') : (current.text || ''),
      html: payload.html !== undefined ? String(payload.html || '') : (current.html || ''),
      files: Array.isArray(payload.files) ? payload.files : (current.files || []),
      updatedAt: new Date().toISOString(),
      source: payload.source || current.source || 'tool'
    };
    this.clipboardStore.set(key, next);
    // Keep BrowserManager clipboard cache in sync (WS + MCP share one source of truth).
    try {
      browserManager.setClipboard(browserId, userId, next.text, {
        html: next.html,
        files: next.files,
        source: next.source
      });
    } catch (_) {}
    return next;
  }

  _getClipboard(browserId, userId = 'api') {
    const key = this._clipboardKey(browserId, userId);
    const cached = this.clipboardStore.get(key) || null;
    const sessionClip = browserManager.getClipboard(browserId, userId);
    const browserClip = browserManager.getBrowserClipboard(browserId);
    if (cached || sessionClip || browserClip) {
      const candidates = [];
      if (cached) {
        candidates.push({
          text: String(cached.text || ''),
          html: String(cached.html || ''),
          files: Array.isArray(cached.files) ? cached.files : [],
          source: String(cached.source || 'cache'),
          updatedAt: cached.updatedAt || null
        });
      }
      if (sessionClip) candidates.push(sessionClip);
      if (browserClip) candidates.push(browserClip);
      const pickTs = (x) => Date.parse(String(x?.updatedAt || '')) || 0;
      candidates.sort((a, b) => pickTs(b) - pickTs(a));
      const top = candidates[0] || {};
      return {
        text: String(top.text || ''),
        html: String(top.html || ''),
        files: Array.isArray(top.files) ? top.files : [],
        updatedAt: top.updatedAt || null,
        source: String(top.source || 'unknown')
      };
    }
    const sessionText = this._getSessionClipboard(browserId, userId);
    return {
      text: sessionText || '',
      html: '',
      files: [],
      updatedAt: null,
      source: sessionText ? 'session' : 'empty'
    };
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
    await this.ensureClipboardHook(browserId, userId, page);
    return page;
  }

  async ensureClipboardHook(browserId, userId, page) {
    try {
      const pageUrl = String(page.url() || '');
      const origin = pageUrl.startsWith('http') ? new URL(pageUrl).origin : '';
      if (origin) {
        await page.browserContext().overridePermissions(origin, ['clipboard-read', 'clipboard-write']).catch(() => {});
        const cdpGrant = await page.target().createCDPSession();
        try {
          await cdpGrant.send('Browser.grantPermissions', {
            origin,
            permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite']
          });
        } catch (_) {}
        try { await cdpGrant.detach(); } catch (_) {}
      }
    } catch (_) {}

    if (!page.__sbClipboardNotifyExposed) {
      page.__sbClipboardNotifyExposed = true;
      await page.exposeFunction('__sbClipboardNotify', async (payload = {}) => {
        const ownerUserId = String(payload.userId || userId || 'api');
        this._setClipboard(browserId, ownerUserId, {
          text: payload.text || '',
          html: payload.html || '',
          files: Array.isArray(payload.files) ? payload.files : [],
          source: payload.source || 'page_hook'
        });
      }).catch(() => {});
    }

    const installScript = () => {
      const notify = (payload = {}) => {
        try {
          const fn = window.__sbClipboardNotify;
          if (typeof fn === 'function') {
            fn({
              userId: window.__sbClipboardUserId || 'api',
              ...payload
            });
          }
        } catch (_) {}
      };
      const update = (payload = {}) => {
        const prev = window.__sbVirtualClipboard || {};
        const next = {
          text: payload.text !== undefined ? String(payload.text || '') : String(prev.text || ''),
          html: payload.html !== undefined ? String(payload.html || '') : String(prev.html || ''),
          files: Array.isArray(payload.files) ? payload.files : (Array.isArray(prev.files) ? prev.files : []),
          updatedAt: new Date().toISOString(),
          source: payload.source || prev.source || 'hook'
        };
        window.__sbVirtualClipboard = next;
        notify(next);
      };

      if (!window.__sbVirtualClipboard) {
        update({ text: '', html: '', files: [], source: 'init' });
      }

      if (window.__sbClipboardHookInstalled) {
        window.__sbClipboardUserId = window.__sbClipboardUserId || 'api';
        return true;
      }
      window.__sbClipboardHookInstalled = true;
      window.__sbClipboardUserId = window.__sbClipboardUserId || 'api';

      const captureActiveSelection = () => {
        const active = document.activeElement;
        if (active && (active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'submit', 'file'].includes((active.type || '').toLowerCase())))) {
          const v = String(active.value || '');
          const start = Number.isFinite(active.selectionStart) ? active.selectionStart : 0;
          const end = Number.isFinite(active.selectionEnd) ? active.selectionEnd : start;
          if (end > start) return v.slice(start, end);
        }
        const sel = window.getSelection?.();
        return String(sel?.toString?.() || '');
      };

      window.addEventListener('copy', (e) => {
        try {
          const cd = e.clipboardData;
          const text = (cd && cd.getData('text/plain')) || captureActiveSelection();
          const html = (cd && cd.getData('text/html')) || '';
          update({ text, html, source: 'event_copy' });
        } catch (_) {}
      }, true);

      window.addEventListener('cut', (e) => {
        try {
          const cd = e.clipboardData;
          const text = (cd && cd.getData('text/plain')) || captureActiveSelection();
          const html = (cd && cd.getData('text/html')) || '';
          update({ text, html, source: 'event_cut' });
        } catch (_) {}
      }, true);

      window.addEventListener('paste', (e) => {
        try {
          const cd = e.clipboardData;
          const text = (cd && cd.getData('text/plain')) || '';
          const html = (cd && cd.getData('text/html')) || '';
          const files = [];
          if (cd && cd.files && cd.files.length > 0) {
            for (const f of cd.files) {
              files.push({ name: f.name || '', mimeType: f.type || '' });
            }
          }
          update({ text, html, files, source: 'event_paste' });
        } catch (_) {}
      }, true);

      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && !navigator.clipboard.__sbWrappedWriteText) {
          const origWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
          const wrapped = async (text) => {
            update({ text: String(text || ''), source: 'clipboard_writeText' });
            return origWriteText(text);
          };
          wrapped.__sbWrappedWriteText = true;
          navigator.clipboard.writeText = wrapped;
        }
      } catch (_) {}

      try {
        if (!document.__sbWrappedExecCommand) {
          document.__sbWrappedExecCommand = true;
          const originalExecCommand = document.execCommand ? document.execCommand.bind(document) : null;
          if (originalExecCommand) {
            document.execCommand = function(cmd, ui, value) {
              const lower = String(cmd || '').toLowerCase();
              if (lower === 'copy' || lower === 'cut') {
                const text = captureActiveSelection();
                update({ text, source: lower === 'copy' ? 'execCommand_copy' : 'execCommand_cut' });
              }
              return originalExecCommand(cmd, ui, value);
            };
          }
        }
      } catch (_) {}

      return true;
    };

    try {
      if (!page.__mcpClipboardHookInit) {
        page.__mcpClipboardHookInit = true;
        await page.evaluateOnNewDocument(`(${installScript.toString()})();`).catch(() => {});
      }
      await page.evaluate((uid) => {
        window.__sbClipboardUserId = String(uid || 'api');
      }, String(userId || 'api')).catch(() => {});
      await page.evaluate(`(${installScript.toString()})();`).catch(() => {});
    } catch (_) {}
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
    await page.bringToFront().catch(() => {});
    const mouse = page.mouse;

    const hasTopLevelXY = Number.isFinite(Number(payload.x)) || Number.isFinite(Number(payload.y));
    const hasStartXY = Number.isFinite(Number(payload.startX)) || Number.isFinite(Number(payload.startY));
    const hasTopLevelEndXY = Number.isFinite(Number(payload.endX)) || Number.isFinite(Number(payload.endY));

    const startPoint = payload.start || (
      hasTopLevelXY
        ? { x: Number(payload.x || 0), y: Number(payload.y || 0) }
        : (hasStartXY ? { x: Number(payload.startX || 0), y: Number(payload.startY || 0) } : {})
    );
    const endPoint = payload.end || (
      hasTopLevelEndXY
        ? { x: Number(payload.endX || 0), y: Number(payload.endY || 0) }
        : startPoint
    );

    const start = await this.resolvePoint(page, startPoint, payload.startSelector);
    const end = await this.resolvePoint(page, endPoint, payload.endSelector);
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

      // If caller clicked a selector target (especially canvas), enforce DOM focus for key routing.
      const focusSelector = String(payload.endSelector || payload.startSelector || '').trim();
      if (focusSelector) {
        await this.ensureSelectorFocus(page, focusSelector);
      }
    }

    if (payload.releaseAtEnd) {
      await mouse.up({ button });
    }

    return { ok: true, start, end };
  }

  _normalizeKey(keyRaw) {
    const raw = String(keyRaw || '').trim();
    if (!raw) return '';
    const lowered = raw.toLowerCase();
    const aliases = {
      pgup: 'PageUp',
      pageup: 'PageUp',
      pgdn: 'PageDown',
      pagedown: 'PageDown',
      esc: 'Escape',
      del: 'Delete',
      ins: 'Insert',
      enter: 'Enter',
      tab: 'Tab',
      space: 'Space',
      left: 'ArrowLeft',
      right: 'ArrowRight',
      up: 'ArrowUp',
      down: 'ArrowDown',
      home: 'Home',
      end: 'End',
      ctrl: 'Control',
      control: 'Control',
      alt: 'Alt',
      shift: 'Shift',
      win: 'Meta',
      cmd: 'Meta',
      meta: 'Meta'
    };
    return aliases[lowered] || raw;
  }

  async ensureSelectorFocus(page, selector) {
    const sel = String(selector || '').trim();
    if (!sel) return { ok: false, reason: 'empty-selector' };
    try {
      return await page.$eval(sel, (el) => {
        // Canvas elements are not focusable by default; make them focusable for key routing.
        if (el instanceof HTMLCanvasElement && !el.hasAttribute('tabindex')) {
          el.setAttribute('tabindex', '-1');
        }
        const ae = document.activeElement;
        const alreadyFocused = ae === el;
        if (!alreadyFocused) {
          try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
          try { el.focus({ preventScroll: true }); } catch (_) {}
        }
        const activeAfter = document.activeElement;
        return {
          ok: true,
          activeTag: activeAfter ? activeAfter.tagName : '',
          focused: activeAfter === el,
          alreadyFocused
        };
      });
    } catch (e) {
      return {
        ok: false,
        reason: e?.message || 'focus-failed'
      };
    }
  }

  async keyboardInput(browserId, payload = {}, userId = 'api') {
    const page = await this.getPage(browserId, userId);
    await page.bringToFront().catch(() => {});
    const keyboard = page.keyboard;
    const text = payload.text !== undefined ? String(payload.text) : '';
    if (payload.selector) {
      await this.ensureSelectorFocus(page, payload.selector);
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
    const comboKeys = Array.isArray(payload.keys) && payload.keys.length ? payload.keys : (Array.isArray(payload.combo) ? payload.combo : []);
    const normalizedCombo = comboKeys.map((k) => this._normalizeKey(k)).filter(Boolean);
    const singleKey = this._normalizeKey(payload.key || payload.shortcut || '');
    const shortcuts = Array.isArray(payload.shortcuts) ? payload.shortcuts.map((k) => this._normalizeKey(k)).filter(Boolean) : [];

    const comboSignature = normalizedCombo.map((k) => String(k).toLowerCase()).sort().join('+');

    if (normalizedCombo.length > 0) {
      for (const k of normalizedCombo) {
        await keyboard.down(k);
      }
      for (const k of [...normalizedCombo].reverse()) {
        await keyboard.up(k);
      }
    } else if (singleKey) {
      const repeat = Math.max(1, Number(payload.repeat || 1));
      for (let i = 0; i < repeat; i++) {
        await keyboard.press(singleKey);
      }
    }

    for (const k of shortcuts) {
      await keyboard.press(k);
    }

    if (text) {
      await keyboard.type(text, { delay: payload.delayMs || 0 });
    }
    if (payload.pressEnter) {
      await keyboard.press('Enter');
    }

    // Post-action sync for common clipboard combos.
    if (comboSignature === 'c+control') {
      const copied = await browserManager.copySelection(browserId, userId);
      this._setClipboard(browserId, userId, { text: copied || '', source: 'copy' });
      return { ok: true, action: 'copy', textLength: (copied || '').length };
    }
    if (comboSignature === 'control+x') {
      const cutText = await browserManager.copySelection(browserId, userId);
      this._setClipboard(browserId, userId, { text: cutText || '', source: 'cut' });
      return { ok: true, action: 'cut', textLength: (cutText || '').length };
    }
    if (comboSignature === 'control+v') {
      const clip = this._getClipboard(browserId, userId);
      return { ok: true, action: 'paste', pastedTextLength: String(clip.text || '').length };
    }

    return {
      ok: true,
      typedLength: text.length,
      key: singleKey || null,
      combo: normalizedCombo
    };
  }

  async inputText(browserId, payload = {}, userId = 'api') {
    // Backward compatibility for older "input" tool id.
    return this.keyboardInput(browserId, payload, userId);
  }

  async paste(browserId, payload = {}, userId = 'api') {
    const page = await this.getPage(browserId, userId);
    await page.bringToFront().catch(() => {});
    if (payload.selector) {
      await this.ensureSelectorFocus(page, payload.selector);
    }
    const text = payload.text !== undefined ? String(payload.text || '') : '';
    const html = payload.html !== undefined ? String(payload.html || '') : '';
    const imageBase64 = payload.imageBase64 ? String(payload.imageBase64) : '';
    const imageMimeType = String(payload.imageMimeType || 'image/png');
    const extraFiles = Array.isArray(payload.files) ? payload.files : [];

    if (!html && !imageBase64 && extraFiles.length === 0) {
      if (text) {
        await browserManager.pasteText(browserId, userId, text);
        const clip = this._setClipboard(browserId, userId, { text, source: 'paste_text' });
        return { ok: true, mode: 'insertText', pastedTextLength: text.length, clipboard: clip };
      }
      const clip = this._getClipboard(browserId, userId);
      await browserManager.pasteText(browserId, userId, String(clip.text || ''));
      return { ok: true, mode: 'insertText', pastedTextLength: String(clip.text || '').length, clipboard: clip };
    }

    const files = [];
    if (imageBase64) {
      files.push({
        name: String(payload.imageName || `pasted-${Date.now()}.png`),
        mimeType: imageMimeType,
        contentBase64: imageBase64
      });
    }
    for (const file of extraFiles) {
      if (!file || !file.contentBase64) continue;
      files.push({
        name: String(file.name || `file-${Date.now()}`),
        mimeType: String(file.mimeType || 'application/octet-stream'),
        contentBase64: String(file.contentBase64)
      });
    }

    const evalResult = await page.evaluate(({ pasteText, pasteHtml, pasteFiles }) => {
      const toBytes = (b64) => {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      };
      const dt = new DataTransfer();
      if (pasteText) dt.setData('text/plain', pasteText);
      if (pasteHtml) dt.setData('text/html', pasteHtml);
      for (const f of pasteFiles || []) {
        const file = new File([toBytes(f.contentBase64)], f.name, { type: f.mimeType || 'application/octet-stream' });
        dt.items.add(file);
      }
      const target = document.activeElement || document.body;
      const evt = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(evt, 'clipboardData', { value: dt });
      const dispatched = target.dispatchEvent(evt);

      if (target instanceof HTMLInputElement && target.type === 'file' && dt.files && dt.files.length > 0) {
        target.files = dt.files;
        target.dispatchEvent(new Event('change', { bubbles: true }));
      }

      if ((!dispatched || target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && target.type !== 'file')) && pasteText) {
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
          const start = target.selectionStart ?? target.value.length;
          const end = target.selectionEnd ?? target.value.length;
          target.setRangeText(pasteText, start, end, 'end');
          target.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }

      return {
        ok: true,
        dispatched,
        fileCount: dt.files ? dt.files.length : 0
      };
    }, {
      pasteText: text,
      pasteHtml: html,
      pasteFiles: files
    });

    this._setClipboard(browserId, userId, {
      text,
      html,
      files: files.map((f) => ({ name: f.name, mimeType: f.mimeType })),
      source: 'paste_event'
    });
    return {
      ok: true,
      mode: 'pasteEvent',
      textLength: text.length,
      htmlLength: html.length,
      files: files.map((f) => ({ name: f.name, mimeType: f.mimeType })),
      ...evalResult
    };
  }

  async viewClipboard(browserId, payload = {}, userId = 'api') {
    const preferSystemClipboard = !!payload.preferSystemClipboard;
    const cachedBefore = this._getClipboard(browserId, userId);
    let pageCache = null;
    try {
      const page = await this.getPage(browserId, userId);
      pageCache = await page.evaluate(() => window.__sbVirtualClipboard || null).catch(() => null);

      // Try to read real page clipboard when browser/page permits it.
      try {
        const pageUrl = String(page.url() || '');
        const origin = pageUrl.startsWith('http') ? new URL(pageUrl).origin : '';
        if (origin) {
          const cdp = await page.target().createCDPSession();
          try {
            await cdp.send('Browser.grantPermissions', {
              origin,
              permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite']
            });
          } catch (_) {}
          try {
            const realText = await page.evaluate(async () => {
              try {
                if (navigator.clipboard && navigator.clipboard.readText) {
                  return await navigator.clipboard.readText();
                }
              } catch (_) {}
              return '';
            });
            const shouldUseSystemClipboard = preferSystemClipboard || !String(cachedBefore?.text || '');
            if (realText && shouldUseSystemClipboard) {
              this._setClipboard(browserId, userId, { text: realText, source: 'navigator_clipboard_readText' });
            }
          } finally {
            try { await cdp.detach(); } catch (_) {}
          }
        }
      } catch (_) {}
    } catch (_) {}

    if (payload.captureSelection) {
      const copied = await browserManager.copySelection(browserId, userId);
      this._setClipboard(browserId, userId, { text: copied || '', source: 'captureSelection' });
    }

    const preferPageClipboard = !!payload.preferPageClipboard;
    const cachedBeforeTs = Date.parse(String(cachedBefore?.updatedAt || '')) || 0;
    const pageCacheTs = Date.parse(String(pageCache?.updatedAt || '')) || 0;
    const hasPageClipboard = !!(pageCache && (pageCache.text || pageCache.html || (Array.isArray(pageCache.files) && pageCache.files.length > 0)));
    const shouldUsePageClipboard = hasPageClipboard && (
      preferPageClipboard ||
      !String(cachedBefore?.text || '') ||
      (pageCacheTs > 0 && pageCacheTs >= cachedBeforeTs)
    );
    if (shouldUsePageClipboard) {
      this._setClipboard(browserId, userId, {
        text: pageCache.text || '',
        html: pageCache.html || '',
        files: Array.isArray(pageCache.files) ? pageCache.files : [],
        source: pageCache.source || 'page_hook'
      });
    }

    const clip = this._getClipboard(browserId, userId);
    return {
      ok: true,
      text: String(clip.text || ''),
      html: String(clip.html || ''),
      files: Array.isArray(clip.files) ? clip.files : [],
      textLength: String(clip.text || '').length,
      hasHtml: !!clip.html,
      hasFiles: Array.isArray(clip.files) && clip.files.length > 0,
      updatedAt: clip.updatedAt || null,
      source: clip.source || 'unknown'
    };
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
