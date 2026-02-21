const TOOL_DEFINITIONS = [
  {
    id: 'screenshot',
    name: 'Screenshot',
    description: 'Capture current browser frame and dialog states',
    mcpPath: 'screenshot',
    apiMethod: 'POST'
  },
  {
    id: 'pointer',
    name: 'Pointer',
    description: 'Move/click/release/scroll pointer with coordinates or selectors',
    mcpPath: 'pointer',
    apiMethod: 'POST'
  },
  {
    id: 'input',
    name: 'Input',
    description: 'Type text into focused element or selector',
    mcpPath: 'input',
    apiMethod: 'POST'
  },
  {
    id: 'tabs_list',
    name: 'Tabs List',
    description: 'List tabs and current active tab index',
    mcpPath: 'tabs',
    apiMethod: 'GET'
  },
  {
    id: 'tabs_select',
    name: 'Tabs Select',
    description: 'Switch active tab by index',
    mcpPath: 'tabs/select',
    apiMethod: 'POST'
  },
  {
    id: 'tabs_new',
    name: 'Tabs New',
    description: 'Create a new tab (default URL when omitted)',
    mcpPath: 'tabs/new',
    apiMethod: 'POST'
  },
  {
    id: 'tabs_close',
    name: 'Tabs Close',
    description: 'Close tab by index (last tab falls back to default URL)',
    mcpPath: 'tabs/close',
    apiMethod: 'POST'
  },
  {
    id: 'downloads',
    name: 'Downloads',
    description: 'List files downloaded by remote browser sessions',
    mcpPath: 'downloads',
    apiMethod: 'GET'
  },
  {
    id: 'downloads_state',
    name: 'Downloads State',
    description: 'List downloaded files and in-progress downloads with progress',
    mcpPath: 'downloads/state',
    apiMethod: 'GET'
  },
  {
    id: 'dev_html',
    name: 'Dev HTML',
    description: 'Read current page HTML source',
    mcpPath: 'dev/html',
    apiMethod: 'GET'
  },
  {
    id: 'dev_console',
    name: 'Dev Console',
    description: 'Read captured console output',
    mcpPath: 'dev/console',
    apiMethod: 'GET'
  },
  {
    id: 'dev_eval',
    name: 'Dev Eval',
    description: 'Execute JavaScript in current page context',
    mcpPath: 'dev/eval',
    apiMethod: 'POST'
  }
];

function buildDefaultToolAccess() {
  const out = {};
  for (const tool of TOOL_DEFINITIONS) {
    out[tool.id] = {
      mcpEnabled: true,
      apiEnabled: true
    };
  }
  return out;
}

function normalizeToolAccess(input) {
  const defaults = buildDefaultToolAccess();
  if (!input || typeof input !== 'object') return defaults;

  const merged = {};
  for (const tool of TOOL_DEFINITIONS) {
    const current = input[tool.id] || {};
    merged[tool.id] = {
      mcpEnabled: typeof current.mcpEnabled === 'boolean' ? current.mcpEnabled : defaults[tool.id].mcpEnabled,
      apiEnabled: typeof current.apiEnabled === 'boolean' ? current.apiEnabled : defaults[tool.id].apiEnabled
    };
  }
  return merged;
}

function getToolDefinition(toolId) {
  return TOOL_DEFINITIONS.find((x) => x.id === toolId) || null;
}

module.exports = {
  TOOL_DEFINITIONS,
  buildDefaultToolAccess,
  normalizeToolAccess,
  getToolDefinition
};
