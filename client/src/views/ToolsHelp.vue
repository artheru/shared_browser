<template>
  <div class="tools-help-page">
    <header class="header">
      <h1>{{ t('toolsHelp.title') }}</h1>
      <div class="header-actions">
        <button class="btn btn-secondary btn-sm" @click="$router.push('/')">
          {{ t('toolsHelp.backToHome') }}
        </button>
      </div>
    </header>

    <div class="container">
      <div class="card ai-guide-card">
        <h3>{{ t('toolsHelp.aiGuideTitle') }}</h3>
        <p class="desc">{{ t('toolsHelp.aiGuideDesc') }}</p>
        <div class="help-type-switch">
          <button
            class="btn btn-sm"
            :class="selectedHelpType === 'mcp' ? 'btn-primary' : 'btn-secondary'"
            @click="selectedHelpType = 'mcp'; generateGuide()"
          >
            {{ t('toolsHelp.mcpHelp') }}
          </button>
          <button
            class="btn btn-sm"
            :class="selectedHelpType === 'api' ? 'btn-primary' : 'btn-secondary'"
            @click="selectedHelpType = 'api'; generateGuide()"
          >
            {{ t('toolsHelp.apiHelp') }}
          </button>
        </div>
        <div v-if="selectedHelpType === 'mcp'" class="hint">
          <strong>{{ t('toolsHelp.mcpJsonTitle') }}</strong>
          <pre class="json-preview">{{ mcpServerJsonText }}</pre>
          <button class="btn btn-secondary btn-sm" @click="copyText(mcpServerJsonText)">
            {{ t('toolsHelp.copyMcpJson') }}
          </button>
        </div>

        <div class="form-grid">
          <label>
            <span>{{ t('toolsHelp.serverBaseUrl') }}</span>
            <input v-model.trim="guideForm.serverBaseUrl" class="input" type="text" />
          </label>
          <label>
            <span>{{ t('toolsHelp.browserId') }}</span>
            <input v-model.trim="guideForm.browserId" class="input" type="text" disabled />
          </label>
          <label class="token-field">
            <span>{{ t('toolsHelp.token') }}</span>
            <textarea v-model="guideForm.token" class="input" rows="3" disabled></textarea>
            <small>{{ t('toolsHelp.tokenHint') }}</small>
            <div class="token-actions">
              <button class="btn btn-secondary btn-sm" type="button" @click="reloadTokenFromSession">
                {{ t('toolsHelp.reloadToken') }}
              </button>
              <button class="btn btn-secondary btn-sm" type="button" @click="showNewTokenModal = true">
                {{ t('toolsHelp.newToken') }}
              </button>
              <button class="btn btn-secondary btn-sm" type="button" :disabled="!guideForm.token" @click="copyText(guideForm.token)">
                {{ t('toolsHelp.copyToken') }}
              </button>
            </div>
          </label>
        </div>

        <div v-if="selectedHelpType === 'api' && guideForm.token" class="skills-url-box">
          <strong>Read Full API Skills:</strong>
          <div class="skills-url-row">
            <a :href="readSkillsUrl" target="_blank" rel="noopener" class="skills-url-link">{{ readSkillsUrl }}</a>
            <button class="btn btn-secondary btn-sm" @click="copyText(readSkillsUrl)">Copy</button>
          </div>
        </div>
      </div>

      <!-- New token modal -->
      <div v-if="showNewTokenModal" class="modal-overlay" @click.self="closeNewTokenModal">
        <div class="modal">
          <div class="modal-header">
            <h3>{{ t('toolsHelp.newTokenTitle') }}</h3>
            <button class="modal-close" @click="closeNewTokenModal">&times;</button>
          </div>
          <p class="desc">{{ t('toolsHelp.newTokenDesc') }}</p>
          <div v-if="newTokenError" class="error-message">{{ newTokenError }}</div>
          <div class="modal-footer">
            <button class="btn btn-secondary" @click="closeNewTokenModal">{{ t('common.cancel') }}</button>
            <button class="btn btn-primary" @click="requestNewToken">{{ t('common.confirm') }}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import api from '../utils/api'
import { useI18n } from '../i18n'
import { buildReadSkillsUrl } from './tools-help-links'

const { t } = useI18n()
const route = useRoute()
const tools = ref([])
const routePrefix = ref('/api/mcp')
const guideMarkdown = ref('')
const selectedHelpType = ref('mcp')
const guideForm = ref({
  serverBaseUrl: window.location.origin || 'http://127.0.0.1:3000',
  browserId: 'test',
  token: ''
})
const showNewTokenModal = ref(false)
const newTokenError = ref('')

const normalizedBaseUrl = computed(() => {
  const value = (guideForm.value.serverBaseUrl || window.location.origin || '').trim()
  return value.replace(/\/+$/, '')
})

const currentBrowserId = computed(() => (guideForm.value.browserId || 'test').trim() || 'test')

const fullMcpBaseUrl = computed(() => `${normalizedBaseUrl.value}${routePrefix.value}/${currentBrowserId.value}`)

const readSkillsUrl = computed(() => buildReadSkillsUrl({
  baseUrl: normalizedBaseUrl.value,
  browserId: currentBrowserId.value,
  token: guideForm.value.token
}))

const mcpServerJsonText = computed(() => JSON.stringify({
  mcpServers: {
    [`shared-browser-${currentBrowserId.value}`]: {
      url: fullMcpBaseUrl.value,
      headers: {
        Authorization: `Bearer ${guideForm.value.token || '<paste-token-here>'}`
      }
    }
  }
}, null, 2))

function buildGuideMarkdown() {
  const base = normalizedBaseUrl.value
  const browserId = currentBrowserId.value
  const token = guideForm.value.token || 'TOKEN'
  const mcpBase = fullMcpBaseUrl.value
  const skillsUrl = readSkillsUrl.value
  const isMcpHelp = selectedHelpType.value === 'mcp'

  if (isMcpHelp) {
    return `# Shared Browser MCP Help Guide

## Connection
- MCP Base URL: \`${mcpBase}\`
- Browser ID: \`${browserId}\`

## MCP Server JSON
\`\`\`json
${mcpServerJsonText.value}
\`\`\`

## AI Action Loop
1. screenshot → observe current state
2. dev/html or dev/eval → locate element
3. pointer or keyboard → act
4. screenshot → verify
`
  }

  // API help guide
  return `# Shared Browser API Help Guide

Full skills reference: ${skillsUrl}

## Connection
- Base URL: \`${base}\`  Browser ID: \`${browserId}\`  Token: \`${token}\`
- Auth: append \`?token=${token}\` to every request

## AI Action Loop
1. screenshot → observe state
2. dev/html or dev/eval → locate element
3. pointer or keyboard → act
4. screenshot → verify

---

## screenshot — Capture viewport
POST ${mcpBase}/screenshot?token=${token}
Params: none
Returns: resourceUrl (string, fetch as application/octet-stream), width (number), height (number)

\`\`\`bash
curl -s -X POST "${mcpBase}/screenshot?token=${token}" -H "Content-Type: application/json" -d '{}'
# Fetch image: curl -L "<resourceUrl>" -o screenshot.jpg
\`\`\`

---

## pointer — Mouse click or drag
POST ${mcpBase}/pointer?token=${token}
  startSelector  string   optional*  CSS selector for start
  startX/startY  number   optional*  coordinates (if no selector)
  endSelector    string   optional   drag end selector
  endX/endY      number   optional   drag end coordinates
  clickAtEnd     boolean  optional   click at end (default: true)
  button         string   optional   "left"|"right"|"middle" (default: "left")
  dblclick       boolean  optional   double-click (default: false)
  * one of startSelector or startX+startY required
Returns: ok (boolean)

## keyboard — Type or shortcut
POST ${mcpBase}/keyboard?token=${token}
  selector    string   optional*  CSS selector to focus
  text        string   optional*  text to type
  clearBefore boolean  optional   clear before typing (default: false)
  pressEnter  boolean  optional   press Enter after (default: false)
  shortcut    string   optional*  e.g. "ctrl+a", "pgdn", "escape"
  * one of text or shortcut required
Returns: ok (boolean)

## paste — Paste large text
POST ${mcpBase}/paste?token=${token}
  text      string  required  content to paste
  selector  string  optional  CSS selector to focus first
Returns: ok (boolean)

## navigate — Navigate to URL
POST ${mcpBase}/navigate?token=${token}
  url        string  required  target URL (include protocol)
  waitUntil  string  optional  "load"|"domcontentloaded"|"networkidle0" (default: "load")
Returns: ok (boolean), url (string)

## tablist — List open tabs
GET ${mcpBase}/tablist?token=${token}
Returns: tabs (array of {id, url, title, active})

## tabs/select — Switch active tab
POST ${mcpBase}/tabs/select?token=${token}
  tabId  string  required  tab ID from tablist
Returns: ok (boolean)

## tabs/new — Open new tab
POST ${mcpBase}/tabs/new?token=${token}
  url  string  optional  initial URL
Returns: ok (boolean), tabId (string)

## tabs/close — Close a tab
POST ${mcpBase}/tabs/close?token=${token}
  tabId  string  required  tab ID from tablist
Returns: ok (boolean)

## dev/html — Page HTML source
GET ${mcpBase}/dev/html?token=${token}
Returns: plain-text HTML (document.documentElement.outerHTML)

## dev/console — Browser console log
GET ${mcpBase}/dev/console?token=${token}
Returns: entries (array of {category, type, text, stackTrace, timestamp})

## devtools — Unified DevTools diagnostics
GET ${mcpBase}/devtools?token=${token}
POST ${mcpBase}/devtools?token=${token}
  action        string  optional  snapshot | console.clear | network.clear | debugger.pause | debugger.resume | debugger.stepInto | debugger.stepOver | debugger.stepOut | debugger.evaluate
  consoleLimit  number  optional  number of console entries in snapshot
  networkLimit  number  optional  number of network entries in snapshot
  expression    string  optional  JS expression for debugger.evaluate while paused
  callFrameId   string  optional  paused frame id for debugger.evaluate
Returns: page, console, network, debugger, evaluation

## dev/eval — Execute JavaScript
POST ${mcpBase}/dev/eval?token=${token}
  script  string  required  JS expression to evaluate
Returns: result (any)

## clipboard/view — Read clipboard
GET ${mcpBase}/clipboard/view?token=${token}
Returns: text (string)

## video/start — Record viewport (blocking, max 15s)
POST ${mcpBase}/video/start?token=${token}
  durationSec  number  required  duration in seconds (max: 15)
Returns: resourceUrl (string, MP4 as application/octet-stream), fileId (string)
Download: curl -L "<resourceUrl>" -o recording.mp4

## video/list — List recordings
GET ${mcpBase}/video/list?token=${token}
Returns: videos (array of {fileId, filename, createdAt, resourceUrl})
  resourceUrl downloads as application/octet-stream

## downloads — List browser downloads
GET ${mcpBase}/downloads?token=${token}
Returns: downloads (array of {filename, size, mimeType, resourceUrl})
  resourceUrl downloads as application/octet-stream
`
}

function generateGuide() {
  guideMarkdown.value = buildGuideMarkdown()
}

function applyRoutePreset() {
  const modeFromPath = route.params?.mode
  if (modeFromPath === 'mcp' || modeFromPath === 'api') {
    selectedHelpType.value = modeFromPath
  }
  const queryBrowserId = route.query?.browserId
  if (typeof queryBrowserId === 'string' && queryBrowserId.trim()) {
    guideForm.value.browserId = queryBrowserId.trim()
  }
  const queryHelpType = route.query?.helpType
  if (queryHelpType === 'mcp' || queryHelpType === 'api') {
    selectedHelpType.value = queryHelpType
  }
}

function reloadTokenFromSession() {
  loadBrowserAccessToken()
}

function closeNewTokenModal() {
  showNewTokenModal.value = false
  newTokenError.value = ''
}

async function loadBrowserAccessToken() {
  newTokenError.value = ''
  try {
    const browserId = currentBrowserId.value
    const resp = await api.get(`/api/browsers/${encodeURIComponent(browserId)}/access-token`)
    const token = String(resp.data?.apiToken || '')
    guideForm.value.token = token
    generateGuide()
  } catch (e) {
    newTokenError.value = e.response?.data?.error || e.message || t('toolsHelp.newTokenFailed')
  }
}

async function requestNewToken() {
  newTokenError.value = ''
  try {
    const browserId = currentBrowserId.value
    const resp = await api.post(`/api/browsers/${encodeURIComponent(browserId)}/access-token/rotate`)
    const token = String(resp.data?.apiToken || '')
    if (!token) throw new Error('No token returned')
    guideForm.value.token = token
    closeNewTokenModal()
    generateGuide()
  } catch (e) {
    newTokenError.value = e.response?.data?.error || e.message || t('toolsHelp.newTokenFailed')
  }
}

function fallbackCopy(text) {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.cssText = 'position:fixed;opacity:0;left:-9999px;top:-9999px'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  try { document.execCommand('copy') } catch (_) {}
  document.body.removeChild(textarea)
}

function copyText(text) {
  if (!text) return
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text))
  } else {
    fallbackCopy(text)
  }
}

function copyGuide() {
  if (!guideMarkdown.value) return
  copyText(guideMarkdown.value)
}

function downloadGuide() {
  if (!guideMarkdown.value) return
  const blob = new Blob([guideMarkdown.value], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `shared-browser-ai-guide-${guideForm.value.browserId || 'browser'}.md`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

onMounted(async () => {
  applyRoutePreset()
  try {
    const [catalogResp] = await Promise.allSettled([
      api.get('/api/browser-tools/catalog')
    ])
    if (catalogResp.status === 'fulfilled') {
      tools.value = catalogResp.value.data.tools || []
      routePrefix.value = catalogResp.value.data.routePrefix || '/api/mcp'
    }
    await loadBrowserAccessToken()
    generateGuide()
  } catch (e) {
    console.error('Failed to load tools catalog:', e)
  }
})

watch(
  () => [route.params?.mode, route.query?.browserId, route.query?.helpType],
  () => {
    applyRoutePreset()
    loadBrowserAccessToken()
    generateGuide()
  }
)
</script>

<style scoped>
.tools-help-page {
  min-height: 100vh;
}

.desc {
  margin-bottom: 16px;
  color: var(--text-secondary);
}

.hint {
  margin-bottom: 12px;
  padding: 8px 10px;
  border-radius: 8px;
  background: #f7f7f7;
  color: #444;
  font-size: 13px;
}

h3 {
  margin: 6px 0 8px;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th, td {
  border-bottom: 1px solid var(--border-color);
  padding: 10px;
  text-align: left;
}

.ai-guide-card {
  margin-top: 16px;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.form-grid label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}

.token-field {
  grid-column: 1 / -1;
}

.token-actions {
  margin-top: 8px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.token-modal-grid {
  margin-top: 10px;
}

.help-type-switch {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.json-preview {
  margin: 8px 0;
  padding: 10px;
  border-radius: 8px;
  background: #0d1117;
  color: #e6edf3;
  white-space: pre-wrap;
  font-size: 12px;
}

.skills-url-box {
  margin-top: 14px;
  margin-bottom: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: #eef6ff;
  border: 1px solid #b3d8ff;
  font-size: 13px;
}

.skills-url-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  flex-wrap: wrap;
}

.skills-url-link {
  font-family: monospace;
  font-size: 12px;
  color: #0969da;
  word-break: break-all;
}
</style>
