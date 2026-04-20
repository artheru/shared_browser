function normalizeBrowserId(browserId) {
  const raw = String(browserId || '').trim();
  return raw || 'YOUR_BROWSER_ID';
}

function renderFieldTable(fields) {
  if (!Array.isArray(fields) || fields.length === 0) {
    return '_None_';
  }
  return [
    '| Name | Type | Optional? | Notes |',
    '| --- | --- | --- | --- |',
    ...fields.map((field) => `| \`${field.name}\` | \`${field.type}\` | ${field.optional ? 'Yes' : 'No'} | ${field.notes} |`)
  ].join('\n');
}

function renderReturnTable(fields) {
  if (!Array.isArray(fields) || fields.length === 0) {
    return '_None_';
  }
  return [
    '| Field | Type | Meaning |',
    '| --- | --- | --- |',
    ...fields.map((field) => `| \`${field.name}\` | \`${field.type}\` | ${field.meaning} |`)
  ].join('\n');
}

function buildEndpointSection(base, token, browserId, endpoint) {
  const url = endpoint.url(base, token, browserId);
  return [
    `## ${endpoint.name}`,
    '',
    `${endpoint.summary}`,
    '',
    `- Method: \`${endpoint.method}\``,
    `- URL: \`${url}\``,
    '',
    'Parameters',
    '',
    renderFieldTable(endpoint.params),
    '',
    'Returns',
    '',
    renderReturnTable(endpoint.returns)
  ].join('\n');
}

function buildSkillsText(base, token, browserId = '') {
  const safeBase = String(base || '').replace(/\/+$/, '');
  const safeToken = String(token || '').trim();
  const safeBrowserId = normalizeBrowserId(browserId);
  const browserBase = `${safeBase}/api/mcp/${safeBrowserId}`;
  const endpoints = [
    {
      name: 'Screenshot',
      summary: 'Best first inspection call. Use it before and after actions to verify page state.',
      method: 'POST',
      url: (_root, authToken, bid) => `${browserBase.replace(safeBrowserId, bid)}/screenshot?token=${authToken}`,
      params: [
        { name: 'fullPage', type: 'boolean', optional: true, notes: 'Capture the full scrollable page. Default `false`.' },
        { name: 'useLiveFrame', type: 'boolean', optional: true, notes: 'Prefer latest cached stream frame when available. Default `true` for normal viewport capture.' },
        { name: 'includeBase64', type: 'boolean', optional: true, notes: 'Include inline base64 image in the JSON response.' }
      ],
      returns: [
        { name: 'fileId', type: 'string', meaning: 'Saved screenshot file ID.' },
        { name: 'filename', type: 'string', meaning: 'Saved filename.' },
        { name: 'mimeType', type: 'string', meaning: 'Usually `image/png`.' },
        { name: 'size', type: 'number', meaning: 'Image size in bytes.' },
        { name: 'createdAt', type: 'string|null', meaning: 'Creation time in ISO format.' },
        { name: 'title', type: 'string', meaning: 'Current page title.' },
        { name: 'url', type: 'string', meaning: 'Current page URL.' },
        { name: 'dialogs', type: 'array<object>', meaning: 'Pending browser dialogs, if any.' },
        { name: 'source', type: 'string', meaning: 'Image source such as `page_capture` or `stream_latest_frame`.' },
        { name: 'resourceUrl', type: 'string', meaning: 'Temporary download URL for the binary image.' },
        { name: 'resourceToken', type: 'string', meaning: 'Short-lived token embedded in `resourceUrl`.' }
      ]
    },
    {
      name: 'Tab List',
      summary: 'Use this to understand tab state before navigation or tab switching.',
      method: 'GET',
      url: (_root, authToken, bid) => `${safeBase}/api/mcp/${bid}/tablist?token=${authToken}`,
      params: [],
      returns: [
        { name: 'tabs', type: 'array<object>', meaning: 'All open tabs.' },
        { name: 'tabs[].index', type: 'number', meaning: 'Zero-based tab index.' },
        { name: 'tabs[].title', type: 'string', meaning: 'Tab title.' },
        { name: 'tabs[].url', type: 'string', meaning: 'Tab URL.' },
        { name: 'tabs[].isReady', type: 'boolean', meaning: 'Whether the tab is ready for interaction.' },
        { name: 'tabs[].lastNavigationError', type: 'string|null', meaning: 'Last navigation error, if any.' },
        { name: 'activeIndex', type: 'number', meaning: 'Current active tab index.' },
        { name: 'creatingTab', type: 'boolean', meaning: 'Whether a new tab is currently being created.' }
      ]
    },
    {
      name: 'Navigate',
      summary: 'Navigate the active tab to a new URL.',
      method: 'POST',
      url: (_root, authToken, bid) => `${safeBase}/api/mcp/${bid}/navigate?token=${authToken}`,
      params: [
        { name: 'url', type: 'string', optional: false, notes: 'Absolute URL such as `https://example.com`.' }
      ],
      returns: [
        { name: 'tabs', type: 'array<object>', meaning: 'Same tab list shape as `tablist`.' },
        { name: 'activeIndex', type: 'number', meaning: 'Current active tab index after navigation.' },
        { name: 'navigationError', type: 'object|string|null', meaning: 'Present when navigation is blocked or fails.' }
      ]
    },
    {
      name: 'Tabs Select',
      summary: 'Switch the active tab.',
      method: 'POST',
      url: (_root, authToken, bid) => `${safeBase}/api/mcp/${bid}/tabs/select?token=${authToken}`,
      params: [
        { name: 'tabIndex', type: 'number', optional: false, notes: 'Zero-based tab index from `tablist`.' }
      ],
      returns: [
        { name: 'tabs', type: 'array<object>', meaning: 'Updated tab list.' },
        { name: 'activeIndex', type: 'number', meaning: 'New active tab index.' }
      ]
    },
    {
      name: 'Tabs New',
      summary: 'Open a new tab, optionally with an initial URL.',
      method: 'POST',
      url: (_root, authToken, bid) => `${safeBase}/api/mcp/${bid}/tabs/new?token=${authToken}`,
      params: [
        { name: 'url', type: 'string', optional: true, notes: 'Initial URL. Omit to open the browser default page.' }
      ],
      returns: [
        { name: 'tabs', type: 'array<object>', meaning: 'Updated tab list.' },
        { name: 'activeIndex', type: 'number', meaning: 'New active tab index.' }
      ]
    },
    {
      name: 'Tabs Close',
      summary: 'Close a tab by index.',
      method: 'POST',
      url: (_root, authToken, bid) => `${safeBase}/api/mcp/${bid}/tabs/close?token=${authToken}`,
      params: [
        { name: 'tabIndex', type: 'number', optional: false, notes: 'Zero-based tab index to close.' }
      ],
      returns: [
        { name: 'tabs', type: 'array<object>', meaning: 'Updated tab list after closing.' },
        { name: 'activeIndex', type: 'number', meaning: 'Current active tab index after closing.' }
      ]
    },
    {
      name: 'Pointer',
      summary: 'Move, click, drag, or scroll the mouse.',
      method: 'POST',
      url: (_root, authToken, bid) => `${safeBase}/api/mcp/${bid}/pointer?token=${authToken}`,
      params: [
        { name: 'start', type: 'object', optional: true, notes: 'Start point `{x, y}`.' },
        { name: 'end', type: 'object', optional: true, notes: 'End point `{x, y}`.' },
        { name: 'startSelector', type: 'string', optional: true, notes: 'Resolve start point from a CSS selector.' },
        { name: 'endSelector', type: 'string', optional: true, notes: 'Resolve end point from a CSS selector.' },
        { name: 'button', type: 'string', optional: true, notes: '`left`, `right`, or `middle`. Default `left`.' },
        { name: 'clickAtEnd', type: 'boolean', optional: true, notes: 'Click after moving to the end point.' },
        { name: 'clickCount', type: 'number', optional: true, notes: 'Click count when `clickAtEnd=true`.' },
        { name: 'pressAtStart', type: 'boolean', optional: true, notes: 'Press mouse button down at start.' },
        { name: 'releaseAtEnd', type: 'boolean', optional: true, notes: 'Release mouse button at end.' },
        { name: 'wheelDeltaX', type: 'number', optional: true, notes: 'Horizontal scroll delta.' },
        { name: 'wheelDeltaY', type: 'number', optional: true, notes: 'Vertical scroll delta.' },
        { name: 'steps', type: 'number', optional: true, notes: 'Move interpolation steps.' }
      ],
      returns: [
        { name: 'ok', type: 'boolean', meaning: 'Whether the action succeeded.' },
        { name: 'start', type: 'object', meaning: 'Resolved start point.' },
        { name: 'end', type: 'object', meaning: 'Resolved end point.' }
      ]
    },
    {
      name: 'Keyboard',
      summary: 'Type text, press keys, or send key combos.',
      method: 'POST',
      url: (_root, authToken, bid) => `${safeBase}/api/mcp/${bid}/keyboard?token=${authToken}`,
      params: [
        { name: 'text', type: 'string', optional: true, notes: 'Text to type.' },
        { name: 'selector', type: 'string', optional: true, notes: 'Focus this CSS selector before typing.' },
        { name: 'clearBefore', type: 'boolean', optional: true, notes: 'Clear target content before typing.' },
        { name: 'delayMs', type: 'number', optional: true, notes: 'Delay between typed characters.' },
        { name: 'pressEnter', type: 'boolean', optional: true, notes: 'Press Enter after typing.' },
        { name: 'key', type: 'string', optional: true, notes: 'Single key such as `Enter` or `Tab`.' },
        { name: 'shortcut', type: 'string', optional: true, notes: 'Alias of `key`, e.g. `pgdn` or `esc`.' },
        { name: 'keys', type: 'array<string>', optional: true, notes: 'Press keys together as a combo.' },
        { name: 'combo', type: 'array<string>', optional: true, notes: 'Alias of `keys`.' },
        { name: 'shortcuts', type: 'array<string>', optional: true, notes: 'Press keys one by one in sequence.' },
        { name: 'repeat', type: 'number', optional: true, notes: 'Repeat count for a single key press.' }
      ],
      returns: [
        { name: 'ok', type: 'boolean', meaning: 'Whether the action succeeded.' },
        { name: 'typedLength', type: 'number', meaning: 'Typed text length when text mode is used.' },
        { name: 'key', type: 'string|null', meaning: 'Normalized single key when key mode is used.' },
        { name: 'combo', type: 'array<string>', meaning: 'Normalized combo keys when combo mode is used.' },
        { name: 'action', type: 'string|undefined', meaning: 'Special action name for clipboard combos such as copy/cut/paste.' },
        { name: 'textLength', type: 'number|undefined', meaning: 'Clipboard text length for copy/cut actions.' }
      ]
    },
    {
      name: 'Paste',
      summary: 'Paste large plain text or HTML into the focused element.',
      method: 'POST',
      url: (_root, authToken, bid) => `${safeBase}/api/mcp/${bid}/paste?token=${authToken}`,
      params: [
        { name: 'text', type: 'string', optional: true, notes: 'Plain text to paste.' },
        { name: 'html', type: 'string', optional: true, notes: 'Optional HTML clipboard payload.' },
        { name: 'selector', type: 'string', optional: true, notes: 'Focus this CSS selector before paste.' }
      ],
      returns: [
        { name: 'ok', type: 'boolean', meaning: 'Whether paste succeeded.' },
        { name: 'mode', type: 'string', meaning: '`insertText` or `pasteEvent`.' },
        { name: 'pastedTextLength', type: 'number|undefined', meaning: 'Text length for insert-text mode.' },
        { name: 'textLength', type: 'number|undefined', meaning: 'Plain text length for paste-event mode.' },
        { name: 'htmlLength', type: 'number|undefined', meaning: 'HTML length when HTML is supplied.' },
        { name: 'clipboard', type: 'object|undefined', meaning: 'Latest clipboard cache after paste.' }
      ]
    },
    {
      name: 'Paste Files',
      summary: 'Upload/paste files into a focused file input or drop target.',
      method: 'POST',
      url: (_root, authToken, bid) => `${safeBase}/api/mcp/${bid}/pasteFiles?token=${authToken}`,
      params: [
        { name: 'selector', type: 'string', optional: true, notes: 'Focus this CSS selector before paste.' },
        { name: 'files', type: 'multipart file[]', optional: false, notes: 'One or more uploaded files.' }
      ],
      returns: [
        { name: 'ok', type: 'boolean', meaning: 'Whether file paste succeeded.' },
        { name: 'mode', type: 'string', meaning: 'Always `pasteFiles`.' },
        { name: 'fileCount', type: 'number', meaning: 'How many files were pasted.' },
        { name: 'files', type: 'array<object>', meaning: 'Uploaded file metadata (`name`, `mimeType`, `size`).' }
      ]
    },
    {
      name: 'View Clipboard',
      summary: 'Read the browser-side virtual clipboard cache.',
      method: 'GET',
      url: (_root, authToken, bid) => `${safeBase}/api/mcp/${bid}/clipboard/view?token=${authToken}`,
      params: [
        { name: 'captureSelection', type: 'boolean', optional: true, notes: 'Copy the current selection before reading clipboard state.' }
      ],
      returns: [
        { name: 'ok', type: 'boolean', meaning: 'Whether clipboard read succeeded.' },
        { name: 'text', type: 'string', meaning: 'Clipboard plain text.' },
        { name: 'html', type: 'string', meaning: 'Clipboard HTML if present.' },
        { name: 'files', type: 'array<object>', meaning: 'Clipboard file metadata.' },
        { name: 'textLength', type: 'number', meaning: 'Plain text length.' },
        { name: 'hasHtml', type: 'boolean', meaning: 'Whether HTML exists.' },
        { name: 'hasFiles', type: 'boolean', meaning: 'Whether files exist.' },
        { name: 'updatedAt', type: 'string|null', meaning: 'Last clipboard update time.' },
        { name: 'source', type: 'string', meaning: 'Clipboard source such as `copy`, `paste_text`, or `page_hook`.' }
      ]
    },
    {
      name: 'Downloads',
      summary: 'Inspect files downloaded by the browser. Use returned `resourceUrl` to fetch binaries.',
      method: 'GET',
      url: (_root, authToken, bid) => `${safeBase}/api/mcp/${bid}/downloads?token=${authToken}`,
      params: [],
      returns: [
        { name: 'files', type: 'array<object>', meaning: 'Completed downloads with `name`, `size`, `mtime`, `resourceUrl`, `resourceToken`.' },
        { name: 'active', type: 'array<object>', meaning: 'In-progress downloads with `guid`, `filename`, `state`, `progress`, `resourceUrl`.' }
      ]
    },
    {
      name: 'Dev HTML',
      summary: 'Read current page HTML. Useful for deterministic inspection when screenshots are not enough.',
      method: 'GET',
      url: (_root, authToken, bid) => `${safeBase}/api/mcp/${bid}/dev/html?token=${authToken}`,
      params: [],
      returns: [
        { name: 'url', type: 'string', meaning: 'Current page URL.' },
        { name: 'html', type: 'string', meaning: 'Current page HTML source.' }
      ]
    },
    {
      name: 'Dev Console',
      summary: 'Read captured DevTools console messages, including runtime exceptions, failed requests, and stack traces when available.',
      method: 'GET',
      url: (_root, authToken, bid) => `${safeBase}/api/mcp/${bid}/dev/console?token=${authToken}`,
      params: [
        { name: 'limit', type: 'number', optional: true, notes: 'Maximum number of entries. Default `200`.' }
      ],
      returns: [
        { name: '[]', type: 'array<object>', meaning: 'Most recent DevTools-style entries.' },
        { name: 'category', type: 'string', meaning: '`console`, `exception`, `network`, or `log`.' },
        { name: 'type', type: 'string', meaning: 'Log level such as `log`, `warn`, `error`, `info`, or `debug`.' },
        { name: 'text', type: 'string', meaning: 'Console message text.' },
        { name: 'stackTrace', type: 'array<object>', meaning: 'Resolved call frames when DevTools provides them.' },
        { name: 'timestamp', type: 'string', meaning: 'Timestamp for the log entry.' }
      ]
    },
    {
      name: 'DevTools',
      summary: 'Preferred diagnostics endpoint. GET returns a snapshot; POST can also control the debugger and clear console/network state.',
      method: 'GET | POST',
      url: (_root, authToken, bid) => `${safeBase}/api/mcp/${bid}/devtools?token=${authToken}`,
      params: [
        { name: 'action', type: 'string', optional: true, notes: 'Default `snapshot`. Other values: `console.clear`, `network.clear`, `debugger.pause`, `debugger.resume`, `debugger.stepInto`, `debugger.stepOver`, `debugger.stepOut`, `debugger.evaluate`.' },
        { name: 'consoleLimit', type: 'number', optional: true, notes: 'Snapshot console entry count. `limit` is accepted as an alias.' },
        { name: 'networkLimit', type: 'number', optional: true, notes: 'Snapshot network entry count.' },
        { name: 'expression', type: 'string', optional: true, notes: 'Used by `debugger.evaluate` while paused.' },
        { name: 'callFrameId', type: 'string', optional: true, notes: 'Optional paused call frame id for `debugger.evaluate`.' }
      ],
      returns: [
        { name: 'action', type: 'string', meaning: 'Executed action name.' },
        { name: 'page', type: 'object', meaning: 'Current page metadata (`targetId`, `url`, `title`).' },
        { name: 'console', type: 'object', meaning: 'Console summary plus recent entries, including runtime errors and stack traces.' },
        { name: 'network', type: 'object', meaning: 'Recent network requests with failed/completed state.' },
        { name: 'debugger', type: 'object', meaning: 'Paused state, reason, call frames, async stack, and recent debugger events.' },
        { name: 'evaluation', type: 'object|undefined', meaning: 'Expression result for `debugger.evaluate`.' }
      ]
    },
    {
      name: 'Dev Eval',
      summary: 'Execute JavaScript inside the current page context.',
      method: 'POST',
      url: (_root, authToken, bid) => `${safeBase}/api/mcp/${bid}/dev/eval?token=${authToken}`,
      params: [
        { name: 'script', type: 'string', optional: false, notes: 'JavaScript source code evaluated inside the page.' }
      ],
      returns: [
        { name: 'value', type: 'any', meaning: 'Serialized return value from the evaluated code.' }
      ]
    }
  ];

  return [
    '# Shared Browser ReadSkills',
    '',
    'MUST READ FIRST.',
    '',
    '## Connection',
    '',
    `- Base URL: \`${safeBase}\``,
    `- Browser ID: \`${safeBrowserId}\``,
    `- Token: \`${safeToken}\``,
    `- Read-skills URL: \`${safeBase}/api/ai/help/read-skills?token=${safeToken}&browserId=${safeBrowserId}\``,
    `- Browser API base: \`${browserBase}\``,
    `- Authorization header: \`Authorization: Bearer ${safeToken}\``,
    '',
    `Current token (plain text): \`${safeToken}\``,
    `Current browserId: \`${safeBrowserId}\``,
    '',
    '## AI Action Loop',
    '',
    '1. Inspect with `Screenshot` first; use `DevTools` for console/runtime/network/debugger state, and `Tab List` or `Dev HTML` when you need structure.',
    '2. Act with `Navigate`, `Pointer`, `Keyboard`, `Paste`, or `Paste Files`.',
    '3. Verify again with `Screenshot` or `Tab List`.',
    '4. When a response includes `resourceUrl`, download the binary from that URL directly. Do not reconstruct it manually.',
    '',
    'Single curl example',
    '',
    `curl -s "${safeBase}/api/mcp/${safeBrowserId}/screenshot?token=${safeToken}" -X POST -H "Content-Type: application/json" -d "{}"`,
    '',
    'Every request may authenticate in either of these ways:',
    '',
    `- Query string: \`?token=${safeToken}\``,
    `- Header: \`Authorization: Bearer ${safeToken}\``,
    '',
    'API reference',
    '',
    endpoints.map((endpoint) => buildEndpointSection(safeBase, safeToken, safeBrowserId, endpoint)).join('\n\n')
  ].join('\n');
}

module.exports = {
  buildSkillsText
};
