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
      <div class="card">
        <p class="desc">{{ t('toolsHelp.description') }}</p>
        <h3>{{ t('toolsHelp.quickHelpTitle') }}</h3>
        <p class="desc">{{ t('toolsHelp.quickHelpText') }}</p>
        <div class="hint">
          {{ t('toolsHelp.fullApiHint') }}
        </div>
        <table>
          <thead>
            <tr>
              <th>{{ t('toolsHelp.colId') }}</th>
              <th>{{ t('toolsHelp.colName') }}</th>
              <th>{{ t('toolsHelp.colMethod') }}</th>
              <th>{{ t('toolsHelp.colPath') }}</th>
              <th>{{ t('toolsHelp.colDescription') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="tool in tools" :key="tool.id">
              <td><code>{{ tool.id }}</code></td>
              <td>{{ tool.name }}</td>
              <td>{{ tool.apiMethod }}</td>
              <td><code>{{ fullMcpBaseUrl }}/{{ tool.mcpPath }}</code></td>
              <td>{{ tool.description }}</td>
            </tr>
          </tbody>
        </table>
      </div>

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
            :class="selectedHelpType === 'ai' ? 'btn-primary' : 'btn-secondary'"
            @click="selectedHelpType = 'ai'; generateGuide()"
          >
            {{ t('toolsHelp.aiHelp') }}
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
            <input v-model.trim="guideForm.browserId" class="input" type="text" />
          </label>
          <label>
            <span>{{ t('toolsHelp.username') }}</span>
            <input v-model.trim="guideForm.username" class="input" type="text" />
          </label>
          <label>
            <span>{{ t('toolsHelp.password') }}</span>
            <input v-model="guideForm.password" class="input" type="text" />
          </label>
          <label class="token-field">
            <span>{{ t('toolsHelp.token') }}</span>
            <textarea v-model="guideForm.token" class="input" rows="3"></textarea>
            <small>{{ t('toolsHelp.tokenHint') }}</small>
          </label>
        </div>

        <div class="actions">
          <button class="btn btn-primary btn-sm" @click="generateGuide">
            {{ t('toolsHelp.generateGuide') }}
          </button>
          <button class="btn btn-secondary btn-sm" :disabled="!guideMarkdown" @click="copyGuide">
            {{ t('toolsHelp.copyGuide') }}
          </button>
          <button class="btn btn-secondary btn-sm" :disabled="!guideMarkdown" @click="downloadGuide">
            {{ t('toolsHelp.downloadGuide') }}
          </button>
        </div>

        <h4>{{ t('toolsHelp.guidePreview') }}</h4>
        <pre v-if="guideMarkdown" class="guide-preview">{{ guideMarkdown }}</pre>
        <div v-else class="hint">{{ t('toolsHelp.noGuideYet') }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import api from '../utils/api'
import { useI18n } from '../i18n'

const { t } = useI18n()
const route = useRoute()
const tools = ref([])
const routePrefix = ref('/api/mcp')
const guideMarkdown = ref('')
const selectedHelpType = ref('mcp')
const guideForm = ref({
  serverBaseUrl: window.location.origin || 'http://127.0.0.1:3000',
  browserId: 'test',
  username: '',
  password: '',
  token: localStorage.getItem('token') || ''
})

const normalizedBaseUrl = computed(() => {
  const value = (guideForm.value.serverBaseUrl || window.location.origin || '').trim()
  return value.replace(/\/+$/, '')
})

const currentBrowserId = computed(() => (guideForm.value.browserId || 'test').trim() || 'test')

const fullMcpBaseUrl = computed(() => `${normalizedBaseUrl.value}${routePrefix.value}/${currentBrowserId.value}`)

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

function formatToolsForMarkdown() {
  if (!tools.value.length) return '- (no tools loaded)\n'
  return tools.value.map((tool) => {
    const path = `${fullMcpBaseUrl.value}/${tool.mcpPath}`
    return `- \`${tool.id}\`: \`${tool.apiMethod}\` \`${path}\` - ${tool.description}`
  }).join('\n')
}

function buildGuideMarkdown() {
  const base = guideForm.value.serverBaseUrl || window.location.origin
  const browserId = guideForm.value.browserId || 'test'
  const username = guideForm.value.username || 'admin'
  const password = guideForm.value.password || 'admin123'
  const token = guideForm.value.token || '<paste-token-here>'
  const isMcpHelp = selectedHelpType.value === 'mcp'
  const guideTitle = isMcpHelp ? 'MCP Help Guide' : 'AI Help Guide'
  const modeLabel = isMcpHelp ? 'MCP help' : 'AI help'
  const modeIntro = isMcpHelp
    ? 'Use this guide when configuring AI clients through MCP server JSON.'
    : 'Use this guide when calling HTTP API endpoints directly.'
  const authSection = isMcpHelp
    ? `## MCP Server JSON
\`\`\`json
${mcpServerJsonText.value}
\`\`\`
`
    : `## HTTP Auth Header
Use this header in all API requests:
\`\`\`
Authorization: Bearer ${token}
\`\`\`
`

  return `# Shared Browser ${guideTitle}

## Server Context
- Base URL: \`${base}\`
- Browser ID: \`${browserId}\`
- Username: \`${username}\`
- Password: \`${password}\`
- Token: \`${token}\`
- Help Mode: \`${modeLabel}\`

${modeIntro}

## Login
\`\`\`bash
curl -s -X POST "${base}/api/auth/login" \\
  -H "Content-Type: application/json" \\
  -d '{"username":"${username}","password":"${password}"}'
\`\`\`

## List Browsers
\`\`\`bash
curl -s "${base}/api/browsers" \\
  -H "Authorization: Bearer ${token}"
\`\`\`

${authSection}

## AI Operation Manual
1. Always call \`screenshot\` before action.
2. Use \`dev/html\` or \`dev/eval\` to locate the target.
3. Send exactly one \`pointer\` or \`input\` action.
4. Wait 200ms-1500ms.
5. Call \`screenshot\` again to verify.
6. On failure, retry with updated selector/coordinates.

## API Examples (Full URL)
### Screenshot
\`\`\`bash
curl -s -X POST "${fullMcpBaseUrl.value}/screenshot" \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{}'
\`\`\`

### Click by selector
\`\`\`bash
curl -s -X POST "${fullMcpBaseUrl.value}/pointer" \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{"startSelector":"button[type=\\"submit\\"]","endSelector":"button[type=\\"submit\\"]","clickAtEnd":true,"button":"left"}'
\`\`\`

### Input text
\`\`\`bash
curl -s -X POST "${fullMcpBaseUrl.value}/input" \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{"selector":"input[name=\\"q\\"]","clearBefore":true,"text":"hello","pressEnter":true}'
\`\`\`

### Eval page state
\`\`\`bash
curl -s -X POST "${fullMcpBaseUrl.value}/dev/eval" \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{"script":"({url: location.href, title: document.title})"}'
\`\`\`

## Declared Tools
${formatToolsForMarkdown()}
`
}

function generateGuide() {
  guideMarkdown.value = buildGuideMarkdown()
}

function applyRoutePreset() {
  const modeFromPath = route.params?.mode
  if (modeFromPath === 'mcp' || modeFromPath === 'ai') {
    selectedHelpType.value = modeFromPath
  }
  const queryBrowserId = route.query?.browserId
  if (typeof queryBrowserId === 'string' && queryBrowserId.trim()) {
    guideForm.value.browserId = queryBrowserId.trim()
  }
  const queryHelpType = route.query?.helpType
  if (queryHelpType === 'mcp' || queryHelpType === 'ai' || queryHelpType === 'api') {
    selectedHelpType.value = queryHelpType === 'api' ? 'ai' : queryHelpType
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
    const resp = await api.get('/api/browser-tools/catalog')
    tools.value = resp.data.tools || []
    routePrefix.value = resp.data.routePrefix || '/api/mcp'
    if (tools.value.length > 0 && !guideMarkdown.value) {
      generateGuide()
    }
  } catch (e) {
    console.error('Failed to load tools catalog:', e)
  }
})

watch(
  () => [route.params?.mode, route.query?.browserId, route.query?.helpType],
  () => {
    applyRoutePreset()
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

h4 {
  margin: 12px 0 8px;
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

.actions {
  display: flex;
  gap: 8px;
  margin: 12px 0;
  flex-wrap: wrap;
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

.guide-preview {
  white-space: pre-wrap;
  background: #0d1117;
  color: #e6edf3;
  border-radius: 8px;
  padding: 12px;
  max-height: 420px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.45;
}
</style>
