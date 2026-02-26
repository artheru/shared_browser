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
    id: 'keyboard',
    name: 'Keyboard',
    description: 'Type text, send key press/combo shortcuts (e.g. pgup/pgdn), or press Enter',
    mcpPath: 'keyboard',
    apiMethod: 'POST'
  },
  {
    id: 'paste',
    name: 'Paste',
    description: 'Paste large text/html into current focused element',
    mcpPath: 'paste',
    apiMethod: 'POST'
  },
  {
    id: 'pasteFiles',
    name: 'Paste Files',
    description: 'Paste/upload files into current focused element',
    mcpPath: 'pasteFiles',
    apiMethod: 'POST'
  },
  {
    id: 'viewClipboard',
    name: 'View Clipboard',
    description: 'Read virtual browser clipboard content captured by tools',
    mcpPath: 'clipboard/view',
    apiMethod: 'GET'
  },
  {
    id: 'tabs_list',
    name: 'Tabs List',
    description: 'List tabs and current active tab index',
    mcpPath: 'tabs',
    apiMethod: 'GET'
  },
  {
    id: 'tablist',
    name: 'Tab List',
    description: 'List all tabs with url/title and indicate current active tab',
    mcpPath: 'tablist',
    apiMethod: 'GET'
  },
  {
    id: 'navigate',
    name: 'Navigate',
    description: 'Navigate current active tab to a target URL',
    mcpPath: 'navigate',
    apiMethod: 'POST'
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
    id: 'start_video_recording',
    name: 'Start Video Recording',
    description: 'Record browser screen to MP4 for a fixed duration (max 15s cap)',
    mcpPath: 'video/start',
    apiMethod: 'POST'
  },
  {
    id: 'list_recorded_videos',
    name: 'List Recorded Videos',
    description: 'List available recorded MP4 files with download resource URLs',
    mcpPath: 'video/list',
    apiMethod: 'GET'
  },
  {
    id: 'downloads',
    name: 'Downloads',
    description: 'List downloaded files and in-progress downloads with resource URLs',
    mcpPath: 'downloads',
    apiMethod: 'GET'
  },
  {
    id: 'ImportandReadSkillsFirst',
    name: 'Import and Read Skills First',
    description: 'Return capability markdown for VehicleHelper/MCP usage',
    mcpPath: 'ImportandReadSkillsFirst',
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

  const legacyInput = input.input && typeof input.input === 'object' ? input.input : null;
  const merged = {};
  for (const tool of TOOL_DEFINITIONS) {
    let current = input[tool.id] || {};
    // Backward compatibility: migrate old "input" access setting to new "keyboard" tool.
    if (tool.id === 'keyboard' && (!current || typeof current !== 'object' || Object.keys(current).length === 0) && legacyInput) {
      current = legacyInput;
    }
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
