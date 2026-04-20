function nowIso() {
  return new Date().toISOString();
}

function toPositiveInt(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
}

function toDisplayLine(value) {
  return Number.isFinite(Number(value)) ? Number(value) + 1 : null;
}

function trimString(value, max = 4000) {
  const text = String(value || '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return value;
  }
}

function safeTargetId(page) {
  try {
    const target = page && page.target ? page.target() : null;
    return (target && (target._targetId || target?._targetInfo?.targetId)) || '';
  } catch (_) {
    return '';
  }
}

class DevToolsService {
  constructor() {
    this.browserStates = new Map();
    this.maxConsoleEntries = 1000;
    this.maxNetworkEntries = 300;
    this.maxDebuggerEvents = 100;
    this.actions = [
      'snapshot',
      'console.clear',
      'network.clear',
      'debugger.pause',
      'debugger.resume',
      'debugger.stepInto',
      'debugger.stepOver',
      'debugger.stepOut',
      'debugger.evaluate'
    ];
  }

  _getBrowserState(browserId) {
    const key = String(browserId || '');
    let state = this.browserStates.get(key);
    if (!state) {
      state = {
        pages: new Map()
      };
      this.browserStates.set(key, state);
    }
    return state;
  }

  _getOrCreatePageState(browserId, page) {
    const browserState = this._getBrowserState(browserId);
    const targetId = safeTargetId(page) || `target-${Date.now()}`;
    let pageState = browserState.pages.get(targetId);
    if (!pageState) {
      pageState = {
        browserId: String(browserId || ''),
        targetId,
        page,
        client: null,
        attachPromise: null,
        consoleEntries: [],
        consoleDedup: new Map(),
        networkRequests: new Map(),
        debuggerEvents: [],
        waiters: [],
        scripts: new Map(),
        meta: {
          attachedAt: null,
          lastSeenAt: nowIso()
        },
        debuggerState: {
          enabled: false,
          paused: false,
          reason: null,
          data: null,
          lastPausedAt: null,
          lastResumedAt: null,
          callFrames: [],
          hitBreakpoints: [],
          asyncStackTrace: null
        }
      };
      browserState.pages.set(targetId, pageState);
    } else {
      pageState.page = page;
      pageState.meta.lastSeenAt = nowIso();
    }
    return pageState;
  }

  async ensurePageSession(browserId, page) {
    if (!page) throw new Error('No page available for DevTools');
    const pageState = this._getOrCreatePageState(browserId, page);
    if (pageState.client && !pageState.attachPromise) {
      return pageState;
    }
    if (pageState.attachPromise) {
      return pageState.attachPromise;
    }
    pageState.attachPromise = this._attachPage(browserId, page, pageState)
      .catch((err) => {
        pageState.client = null;
        throw err;
      })
      .finally(() => {
        pageState.attachPromise = null;
      });
    return pageState.attachPromise;
  }

  async _attachPage(browserId, page, pageState) {
    const client = await page.target().createCDPSession();
    pageState.client = client;
    pageState.meta.attachedAt = nowIso();
    pageState.debuggerState.enabled = true;

    client.on('Runtime.consoleAPICalled', (event) => {
      this._handleConsoleApi(pageState, event);
    });
    client.on('Runtime.exceptionThrown', (event) => {
      this._handleRuntimeException(pageState, event);
    });
    client.on('Log.entryAdded', (event) => {
      this._handleLogEntry(pageState, event);
    });
    client.on('Debugger.scriptParsed', (event) => {
      this._handleScriptParsed(pageState, event);
    });
    client.on('Debugger.paused', (event) => {
      this._handleDebuggerPaused(pageState, event);
    });
    client.on('Debugger.resumed', () => {
      this._handleDebuggerResumed(pageState);
    });
    client.on('Network.requestWillBeSent', (event) => {
      this._handleNetworkRequest(pageState, event);
    });
    client.on('Network.responseReceived', (event) => {
      this._handleNetworkResponse(pageState, event);
    });
    client.on('Network.loadingFinished', (event) => {
      this._handleNetworkFinished(pageState, event);
    });
    client.on('Network.loadingFailed', (event) => {
      this._handleNetworkFailed(pageState, event);
    });

    await client.send('Runtime.enable');
    await client.send('Runtime.setAsyncCallStackDepth', { maxDepth: 32 }).catch(() => {});
    await client.send('Log.enable');
    await client.send('Debugger.enable');
    await client.send('Network.enable').catch(() => {});

    if (!page.__sbDevtoolsCloseHooked) {
      page.__sbDevtoolsCloseHooked = true;
      page.on('close', () => {
        try {
          page.__sbDevtoolsCloseHooked = false;
        } catch (_) {}
        this._cleanupPage(browserId, safeTargetId(page) || pageState.targetId);
      });
    }

    return pageState;
  }

  _cleanupPage(browserId, targetId) {
    const browserState = this.browserStates.get(String(browserId || ''));
    if (!browserState) return;
    const pageState = browserState.pages.get(String(targetId || ''));
    if (!pageState) return;
    browserState.pages.delete(String(targetId || ''));
    if (pageState.client && typeof pageState.client.detach === 'function') {
      pageState.client.detach().catch(() => {});
    }
  }

  clearBrowser(browserId) {
    const browserState = this.browserStates.get(String(browserId || ''));
    if (!browserState) return;
    for (const [targetId] of browserState.pages.entries()) {
      this._cleanupPage(browserId, targetId);
    }
    this.browserStates.delete(String(browserId || ''));
  }

  _pushConsoleEntry(pageState, entry) {
    const next = {
      timestamp: nowIso(),
      category: String(entry.category || 'console'),
      type: String(entry.type || 'log'),
      source: String(entry.source || 'console-api'),
      text: trimString(entry.text || ''),
      url: entry.url ? String(entry.url) : '',
      lineNumber: entry.lineNumber ?? null,
      columnNumber: entry.columnNumber ?? null,
      stackTrace: Array.isArray(entry.stackTrace) ? entry.stackTrace : [],
      args: Array.isArray(entry.args) ? entry.args : [],
      requestId: entry.requestId ? String(entry.requestId) : '',
      request: entry.request ? cloneJson(entry.request) : null,
      details: entry.details ? cloneJson(entry.details) : null
    };
    const dedupKey = [
      next.category,
      next.type,
      next.source,
      next.text,
      next.url,
      next.lineNumber,
      next.columnNumber,
      next.requestId
    ].join('|');
    const dedupTs = pageState.consoleDedup.get(dedupKey) || 0;
    const now = Date.now();
    if ((now - dedupTs) < 800) {
      return next;
    }
    pageState.consoleDedup.set(dedupKey, now);
    pageState.consoleEntries.push(next);
    if (pageState.consoleEntries.length > this.maxConsoleEntries) {
      pageState.consoleEntries.splice(0, pageState.consoleEntries.length - this.maxConsoleEntries);
    }
    if (pageState.consoleDedup.size > 600) {
      const cutoff = now - 5000;
      for (const [key, ts] of pageState.consoleDedup.entries()) {
        if (ts < cutoff) pageState.consoleDedup.delete(key);
      }
    }
    return next;
  }

  _pushDebuggerEvent(pageState, event) {
    pageState.debuggerEvents.push({
      timestamp: nowIso(),
      ...cloneJson(event)
    });
    if (pageState.debuggerEvents.length > this.maxDebuggerEvents) {
      pageState.debuggerEvents.splice(0, pageState.debuggerEvents.length - this.maxDebuggerEvents);
    }
    if (pageState.waiters.length === 0) return;
    const waiters = [...pageState.waiters];
    pageState.waiters = [];
    for (const waiter of waiters) {
      if (!waiter.types.has(String(event.type || ''))) {
        pageState.waiters.push(waiter);
        continue;
      }
      clearTimeout(waiter.timer);
      waiter.resolve(cloneJson(event));
    }
  }

  _waitForDebuggerEvent(pageState, types, timeoutMs = 1200) {
    return new Promise((resolve) => {
      const waiter = {
        types: new Set(types.map((x) => String(x))),
        resolve,
        timer: null
      };
      waiter.timer = setTimeout(() => {
        pageState.waiters = pageState.waiters.filter((item) => item !== waiter);
        resolve(null);
      }, timeoutMs);
      pageState.waiters.push(waiter);
    });
  }

  _normalizeStackFrames(callFrames) {
    if (!Array.isArray(callFrames)) return [];
    return callFrames.slice(0, 20).map((frame) => ({
      functionName: String(frame.functionName || '(anonymous)'),
      url: String(frame.url || ''),
      lineNumber: toDisplayLine(frame.lineNumber),
      columnNumber: toDisplayLine(frame.columnNumber)
    }));
  }

  _normalizeRuntimeStackTrace(stackTrace, depth = 0) {
    if (!stackTrace || depth > 3) return [];
    const direct = this._normalizeStackFrames(stackTrace.callFrames);
    if (stackTrace.parent) {
      return direct.concat(this._normalizeRuntimeStackTrace(stackTrace.parent, depth + 1));
    }
    return direct;
  }

  _normalizeRemoteObject(remoteObject) {
    if (!remoteObject || typeof remoteObject !== 'object') return null;
    const out = {
      type: remoteObject.type || null,
      subtype: remoteObject.subtype || null,
      className: remoteObject.className || null,
      description: remoteObject.description || null
    };
    if (Object.prototype.hasOwnProperty.call(remoteObject, 'value')) {
      out.value = cloneJson(remoteObject.value);
    }
    if (remoteObject.unserializableValue !== undefined) {
      out.unserializableValue = String(remoteObject.unserializableValue);
    }
    const previewProps = Array.isArray(remoteObject.preview?.properties)
      ? remoteObject.preview.properties.slice(0, 8).map((prop) => ({
        name: String(prop.name || ''),
        type: prop.type || null,
        subtype: prop.subtype || null,
        value: prop.value !== undefined ? String(prop.value) : null
      }))
      : [];
    if (previewProps.length > 0) {
      out.preview = previewProps;
    }
    return out;
  }

  _remoteObjectText(remoteObject) {
    if (!remoteObject || typeof remoteObject !== 'object') return '';
    if (remoteObject.type === 'string') {
      if (Object.prototype.hasOwnProperty.call(remoteObject, 'value')) return String(remoteObject.value || '');
      return String(remoteObject.description || '');
    }
    if (Object.prototype.hasOwnProperty.call(remoteObject, 'value')) {
      return String(remoteObject.value);
    }
    if (remoteObject.unserializableValue !== undefined) {
      return String(remoteObject.unserializableValue);
    }
    if (remoteObject.description) return String(remoteObject.description);
    if (Array.isArray(remoteObject.preview?.properties) && remoteObject.preview.properties.length > 0) {
      const compact = remoteObject.preview.properties
        .slice(0, 5)
        .map((prop) => `${prop.name}:${prop.value !== undefined ? prop.value : prop.type}`)
        .join(', ');
      return compact ? `{${compact}}` : String(remoteObject.type || '');
    }
    return String(remoteObject.type || '');
  }

  _normalizeLocation(location) {
    if (!location || typeof location !== 'object') {
      return { url: '', lineNumber: null, columnNumber: null };
    }
    return {
      url: String(location.url || ''),
      lineNumber: toDisplayLine(location.lineNumber),
      columnNumber: toDisplayLine(location.columnNumber)
    };
  }

  _normalizeExceptionDetails(details) {
    if (!details || typeof details !== 'object') return null;
    const text = trimString(
      details.exception?.description ||
      details.exception?.value ||
      details.text ||
      'Uncaught exception'
    );
    return {
      text,
      url: String(details.url || ''),
      lineNumber: toDisplayLine(details.lineNumber),
      columnNumber: toDisplayLine(details.columnNumber),
      stackTrace: this._normalizeRuntimeStackTrace(details.stackTrace),
      exception: this._normalizeRemoteObject(details.exception)
    };
  }

  _handleConsoleApi(pageState, event) {
    const args = Array.isArray(event.args) ? event.args.map((arg) => this._normalizeRemoteObject(arg)).filter(Boolean) : [];
    const text = trimString(args.map((arg) => this._remoteObjectText(arg)).filter(Boolean).join(' '));
    const topFrame = Array.isArray(event.stackTrace?.callFrames) ? event.stackTrace.callFrames[0] : null;
    const location = this._normalizeLocation(topFrame || {});
    this._pushConsoleEntry(pageState, {
      category: 'console',
      type: event.type === 'warning' ? 'warn' : String(event.type || 'log'),
      source: 'console-api',
      text: text || String(event.type || 'console'),
      url: location.url,
      lineNumber: location.lineNumber,
      columnNumber: location.columnNumber,
      stackTrace: this._normalizeRuntimeStackTrace(event.stackTrace),
      args
    });
  }

  _handleRuntimeException(pageState, event) {
    const details = this._normalizeExceptionDetails(event.exceptionDetails);
    if (!details) return;
    this._pushConsoleEntry(pageState, {
      category: 'exception',
      type: 'error',
      source: 'runtime',
      text: details.text,
      url: details.url,
      lineNumber: details.lineNumber,
      columnNumber: details.columnNumber,
      stackTrace: details.stackTrace,
      details
    });
  }

  _handleLogEntry(pageState, event) {
    const entry = event?.entry || {};
    const stackTrace = this._normalizeRuntimeStackTrace(entry.stackTrace);
    this._pushConsoleEntry(pageState, {
      category: 'log',
      type: entry.level === 'warning' ? 'warn' : String(entry.level || 'info'),
      source: String(entry.source || 'log'),
      text: trimString(entry.text || `${entry.source || 'log'} entry`),
      url: String(entry.url || ''),
      lineNumber: toDisplayLine(entry.lineNumber),
      columnNumber: null,
      stackTrace,
      details: {
        networkRequestId: entry.networkRequestId || null,
        workerId: entry.workerId || null
      }
    });
  }

  _handleScriptParsed(pageState, event) {
    if (!event?.scriptId) return;
    pageState.scripts.set(String(event.scriptId), {
      url: String(event.url || ''),
      hash: String(event.hash || ''),
      startLine: toDisplayLine(event.startLine),
      startColumn: toDisplayLine(event.startColumn)
    });
    if (pageState.scripts.size > 2000) {
      const firstKey = pageState.scripts.keys().next().value;
      if (firstKey) pageState.scripts.delete(firstKey);
    }
  }

  _normalizeDebuggerCallFrames(pageState, callFrames) {
    if (!Array.isArray(callFrames)) return [];
    return callFrames.slice(0, 20).map((frame) => {
      const scriptInfo = pageState.scripts.get(String(frame.location?.scriptId || '')) || {};
      return {
        callFrameId: String(frame.callFrameId || ''),
        functionName: String(frame.functionName || '(anonymous)'),
        url: String(scriptInfo.url || ''),
        lineNumber: toDisplayLine(frame.location?.lineNumber),
        columnNumber: toDisplayLine(frame.location?.columnNumber),
        thisObject: this._normalizeRemoteObject(frame.this),
        scopeChain: Array.isArray(frame.scopeChain)
          ? frame.scopeChain.slice(0, 6).map((scope) => ({
            type: String(scope.type || ''),
            name: scope.name ? String(scope.name) : '',
            object: this._normalizeRemoteObject(scope.object)
          }))
          : []
      };
    });
  }

  _handleDebuggerPaused(pageState, event) {
    const callFrames = this._normalizeDebuggerCallFrames(pageState, event.callFrames);
    pageState.debuggerState.paused = true;
    pageState.debuggerState.reason = String(event.reason || 'other');
    pageState.debuggerState.lastPausedAt = nowIso();
    pageState.debuggerState.callFrames = callFrames;
    pageState.debuggerState.hitBreakpoints = Array.isArray(event.hitBreakpoints)
      ? event.hitBreakpoints.map((item) => String(item))
      : [];
    pageState.debuggerState.asyncStackTrace = {
      description: String(event.asyncStackTrace?.description || ''),
      callFrames: this._normalizeRuntimeStackTrace(event.asyncStackTrace)
    };
    pageState.debuggerState.data = cloneJson(event.data);
    this._pushDebuggerEvent(pageState, {
      type: 'paused',
      reason: pageState.debuggerState.reason,
      callFramesCount: callFrames.length,
      hitBreakpoints: pageState.debuggerState.hitBreakpoints
    });
  }

  _handleDebuggerResumed(pageState) {
    pageState.debuggerState.paused = false;
    pageState.debuggerState.reason = null;
    pageState.debuggerState.lastResumedAt = nowIso();
    pageState.debuggerState.callFrames = [];
    pageState.debuggerState.hitBreakpoints = [];
    pageState.debuggerState.asyncStackTrace = null;
    pageState.debuggerState.data = null;
    this._pushDebuggerEvent(pageState, { type: 'resumed' });
  }

  _networkRecord(pageState, requestId) {
    const key = String(requestId || '');
    let record = pageState.networkRequests.get(key);
    if (!record) {
      record = {
        requestId: key,
        url: '',
        method: '',
        resourceType: '',
        frameId: '',
        documentURL: '',
        startedAt: null,
        updatedAt: null,
        finishedAt: null,
        status: null,
        statusText: '',
        mimeType: '',
        protocol: '',
        remoteIPAddress: '',
        remotePort: null,
        fromDiskCache: false,
        fromServiceWorker: false,
        fromPrefetchCache: false,
        encodedDataLength: null,
        failed: false,
        failureText: '',
        blockedReason: '',
        canceled: false,
        initiator: null,
        responseHeaders: null
      };
      pageState.networkRequests.set(key, record);
    }
    return record;
  }

  _trimNetworkRecords(pageState) {
    if (pageState.networkRequests.size <= this.maxNetworkEntries) return;
    const records = Array.from(pageState.networkRequests.values())
      .sort((a, b) => (Date.parse(b.updatedAt || 0) || 0) - (Date.parse(a.updatedAt || 0) || 0));
    const keepIds = new Set(records.slice(0, this.maxNetworkEntries).map((item) => item.requestId));
    for (const key of pageState.networkRequests.keys()) {
      if (!keepIds.has(key)) pageState.networkRequests.delete(key);
    }
  }

  _normalizeInitiator(initiator) {
    if (!initiator || typeof initiator !== 'object') return null;
    const topFrame = Array.isArray(initiator.stack?.callFrames) ? initiator.stack.callFrames[0] : null;
    return {
      type: String(initiator.type || ''),
      url: String(topFrame?.url || initiator.url || ''),
      lineNumber: toDisplayLine(topFrame?.lineNumber),
      columnNumber: toDisplayLine(topFrame?.columnNumber)
    };
  }

  _handleNetworkRequest(pageState, event) {
    const record = this._networkRecord(pageState, event.requestId);
    record.url = String(event.request?.url || record.url || '');
    record.method = String(event.request?.method || record.method || '');
    record.resourceType = String(event.type || record.resourceType || '');
    record.frameId = String(event.frameId || record.frameId || '');
    record.documentURL = String(event.documentURL || record.documentURL || '');
    record.startedAt = record.startedAt || (Number.isFinite(Number(event.wallTime)) ? new Date(Number(event.wallTime) * 1000).toISOString() : nowIso());
    record.updatedAt = nowIso();
    record.initiator = this._normalizeInitiator(event.initiator) || record.initiator;
    this._trimNetworkRecords(pageState);
  }

  _handleNetworkResponse(pageState, event) {
    const record = this._networkRecord(pageState, event.requestId);
    const response = event.response || {};
    record.url = String(response.url || record.url || '');
    record.status = Number.isFinite(Number(response.status)) ? Number(response.status) : record.status;
    record.statusText = String(response.statusText || record.statusText || '');
    record.mimeType = String(response.mimeType || record.mimeType || '');
    record.protocol = String(response.protocol || record.protocol || '');
    record.remoteIPAddress = String(response.remoteIPAddress || record.remoteIPAddress || '');
    record.remotePort = Number.isFinite(Number(response.remotePort)) ? Number(response.remotePort) : record.remotePort;
    record.fromDiskCache = !!response.fromDiskCache;
    record.fromServiceWorker = !!response.fromServiceWorker;
    record.fromPrefetchCache = !!response.fromPrefetchCache;
    record.updatedAt = nowIso();
    if (response.headers && typeof response.headers === 'object') {
      const headerPairs = Object.entries(response.headers).slice(0, 20).map(([key, value]) => [String(key), String(value)]);
      record.responseHeaders = Object.fromEntries(headerPairs);
    }
    this._trimNetworkRecords(pageState);
  }

  _handleNetworkFinished(pageState, event) {
    const record = this._networkRecord(pageState, event.requestId);
    record.encodedDataLength = Number.isFinite(Number(event.encodedDataLength)) ? Number(event.encodedDataLength) : record.encodedDataLength;
    record.updatedAt = nowIso();
    record.finishedAt = nowIso();
    this._trimNetworkRecords(pageState);
  }

  _handleNetworkFailed(pageState, event) {
    const record = this._networkRecord(pageState, event.requestId);
    record.failed = true;
    record.failureText = String(event.errorText || 'Request failed');
    record.blockedReason = String(event.blockedReason || '');
    record.canceled = !!event.canceled;
    record.updatedAt = nowIso();
    record.finishedAt = nowIso();
    this._pushConsoleEntry(pageState, {
      category: 'network',
      type: 'error',
      source: 'network',
      text: `${record.method || 'GET'} ${record.url || event.requestId} failed: ${record.failureText}`,
      requestId: record.requestId,
      request: this._normalizeNetworkRecord(record)
    });
    this._trimNetworkRecords(pageState);
  }

  _normalizeNetworkRecord(record) {
    const started = Date.parse(record.startedAt || '') || 0;
    const finished = Date.parse(record.finishedAt || '') || 0;
    return {
      requestId: String(record.requestId || ''),
      url: String(record.url || ''),
      method: String(record.method || ''),
      resourceType: String(record.resourceType || ''),
      status: Number.isFinite(Number(record.status)) ? Number(record.status) : null,
      statusText: String(record.statusText || ''),
      mimeType: String(record.mimeType || ''),
      protocol: String(record.protocol || ''),
      remoteIPAddress: String(record.remoteIPAddress || ''),
      remotePort: Number.isFinite(Number(record.remotePort)) ? Number(record.remotePort) : null,
      startedAt: record.startedAt || null,
      updatedAt: record.updatedAt || null,
      finishedAt: record.finishedAt || null,
      durationMs: started && finished ? Math.max(0, finished - started) : null,
      encodedDataLength: Number.isFinite(Number(record.encodedDataLength)) ? Number(record.encodedDataLength) : null,
      failed: !!record.failed,
      failureText: String(record.failureText || ''),
      blockedReason: String(record.blockedReason || ''),
      canceled: !!record.canceled,
      fromDiskCache: !!record.fromDiskCache,
      fromServiceWorker: !!record.fromServiceWorker,
      fromPrefetchCache: !!record.fromPrefetchCache,
      initiator: cloneJson(record.initiator),
      responseHeaders: cloneJson(record.responseHeaders)
    };
  }

  _buildConsoleSummary(entries) {
    const summary = {
      total: entries.length,
      byType: {},
      byCategory: {}
    };
    for (const entry of entries) {
      summary.byType[entry.type] = (summary.byType[entry.type] || 0) + 1;
      summary.byCategory[entry.category] = (summary.byCategory[entry.category] || 0) + 1;
    }
    return summary;
  }

  _buildNetworkSummary(records) {
    return {
      total: records.length,
      failed: records.filter((item) => item.failed).length,
      inflight: records.filter((item) => item.startedAt && !item.finishedAt).length,
      completed: records.filter((item) => item.finishedAt && !item.failed).length
    };
  }

  _buildDebuggerSnapshot(pageState) {
    return {
      enabled: !!pageState.debuggerState.enabled,
      paused: !!pageState.debuggerState.paused,
      reason: pageState.debuggerState.reason || null,
      lastPausedAt: pageState.debuggerState.lastPausedAt || null,
      lastResumedAt: pageState.debuggerState.lastResumedAt || null,
      callFrames: cloneJson(pageState.debuggerState.callFrames),
      hitBreakpoints: cloneJson(pageState.debuggerState.hitBreakpoints),
      asyncStackTrace: cloneJson(pageState.debuggerState.asyncStackTrace),
      data: cloneJson(pageState.debuggerState.data),
      recentEvents: cloneJson(pageState.debuggerEvents.slice(-20).reverse())
    };
  }

  async _buildPageInfo(pageState) {
    let title = '';
    try {
      title = await pageState.page.title();
    } catch (_) {}
    return {
      targetId: pageState.targetId,
      url: String(pageState.page?.url?.() || ''),
      title: String(title || ''),
      attachedAt: pageState.meta.attachedAt,
      lastSeenAt: pageState.meta.lastSeenAt
    };
  }

  async getConsole(browserId, page, options = {}) {
    const pageState = await this.ensurePageSession(browserId, page);
    const limit = toPositiveInt(options.limit, 200);
    const entries = pageState.consoleEntries.slice(-limit).reverse().map((item) => cloneJson(item));
    return entries;
  }

  async snapshot(browserId, page, options = {}) {
    const pageState = await this.ensurePageSession(browserId, page);
    const consoleLimit = toPositiveInt(options.consoleLimit || options.limit, 200);
    const networkLimit = toPositiveInt(options.networkLimit, 100);
    const pageInfo = await this._buildPageInfo(pageState);
    const consoleEntries = pageState.consoleEntries.slice(-consoleLimit).reverse().map((item) => cloneJson(item));
    const networkEntries = Array.from(pageState.networkRequests.values())
      .sort((a, b) => (Date.parse(b.updatedAt || 0) || 0) - (Date.parse(a.updatedAt || 0) || 0))
      .slice(0, networkLimit)
      .map((item) => this._normalizeNetworkRecord(item));
    return {
      action: 'snapshot',
      actions: [...this.actions],
      page: pageInfo,
      console: {
        summary: this._buildConsoleSummary(consoleEntries),
        entries: consoleEntries
      },
      network: {
        summary: this._buildNetworkSummary(networkEntries),
        entries: networkEntries
      },
      debugger: this._buildDebuggerSnapshot(pageState)
    };
  }

  async execute(browserId, page, options = {}) {
    const pageState = await this.ensurePageSession(browserId, page);
    const action = String(options.action || 'snapshot').trim() || 'snapshot';

    if (action === 'snapshot') {
      return this.snapshot(browserId, page, options);
    }

    if (action === 'console.clear') {
      pageState.consoleEntries = [];
      pageState.consoleDedup.clear();
      return {
        ...(await this.snapshot(browserId, page, options)),
        action,
        ok: true
      };
    }

    if (action === 'network.clear') {
      pageState.networkRequests.clear();
      return {
        ...(await this.snapshot(browserId, page, options)),
        action,
        ok: true
      };
    }

    if (action === 'debugger.pause') {
      if (!pageState.debuggerState.paused) {
        const waiter = this._waitForDebuggerEvent(pageState, ['paused'], 1500);
        await pageState.client.send('Debugger.pause');
        await waiter;
      }
      return {
        ...(await this.snapshot(browserId, page, options)),
        action,
        ok: true
      };
    }

    if (action === 'debugger.resume') {
      if (pageState.debuggerState.paused) {
        const waiter = this._waitForDebuggerEvent(pageState, ['resumed', 'paused'], 1500);
        await pageState.client.send('Debugger.resume');
        await waiter;
      }
      return {
        ...(await this.snapshot(browserId, page, options)),
        action,
        ok: true
      };
    }

    if (action === 'debugger.stepInto' || action === 'debugger.stepOver' || action === 'debugger.stepOut') {
      if (!pageState.debuggerState.paused) {
        throw new Error(`${action} requires the debugger to be paused`);
      }
      const command = action === 'debugger.stepInto'
        ? 'Debugger.stepInto'
        : action === 'debugger.stepOver'
          ? 'Debugger.stepOver'
          : 'Debugger.stepOut';
      const waiter = this._waitForDebuggerEvent(pageState, ['paused', 'resumed'], 1500);
      await pageState.client.send(command);
      const transition = await waiter;
      return {
        ...(await this.snapshot(browserId, page, options)),
        action,
        ok: true,
        transition
      };
    }

    if (action === 'debugger.evaluate') {
      if (!pageState.debuggerState.paused) {
        throw new Error('debugger.evaluate requires the debugger to be paused');
      }
      const expression = String(options.expression || '').trim();
      if (!expression) throw new Error('expression is required for debugger.evaluate');
      const callFrameId = String(options.callFrameId || pageState.debuggerState.callFrames[0]?.callFrameId || '');
      if (!callFrameId) throw new Error('No paused call frame available');
      const result = await pageState.client.send('Debugger.evaluateOnCallFrame', {
        callFrameId,
        expression,
        silent: true,
        returnByValue: false
      });
      return {
        ...(await this.snapshot(browserId, page, options)),
        action,
        ok: true,
        evaluation: {
          expression,
          callFrameId,
          result: this._normalizeRemoteObject(result.result),
          exceptionDetails: this._normalizeExceptionDetails(result.exceptionDetails)
        }
      };
    }

    throw new Error(`Unsupported devtools action: ${action}`);
  }
}

module.exports = DevToolsService;
