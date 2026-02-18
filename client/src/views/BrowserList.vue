<template>
  <div class="browser-list-page">
    <header class="header">
      <div class="header-title">
        <h1>{{ t('browserList.title') }}</h1>
        <div class="version-info">
          <span>{{ t('browserList.version') }}: <code>{{ versionTag }}</code></span>
          <span v-if="buildTimeTag"> | {{ t('browserList.buildTime') }}: <code>{{ buildTimeTag }}</code></span>
        </div>
      </div>
      <div class="header-actions">
        <span class="user-info">{{ authStore.user?.username }}</span>
        <button v-if="authStore.isAdmin" class="btn btn-secondary btn-sm" @click="goToUsers">
          {{ t('browserList.userManagement') }}
        </button>
        <button v-if="authStore.isAdmin" class="btn btn-secondary btn-sm" @click="goToLogs">
          {{ t('browserList.logs') }}
        </button>
        <button v-if="authStore.isAdmin" class="btn btn-secondary btn-sm" @click="goToCalllog">
          {{ t('browserList.calllog') }}
        </button>
        <button v-if="authStore.isAdmin" class="btn btn-secondary btn-sm" @click="goToReport">
          {{ t('browserList.report') }}
        </button>
        <button class="btn btn-secondary btn-sm" @click="handleLogout">
          {{ t('browserList.logout') }}
        </button>
      </div>
    </header>
    
    <div class="container">
      <div class="page-header">
        <h2 class="page-title">{{ t('browserList.selectBrowser') }}</h2>
        <button v-if="authStore.isAdmin" class="btn btn-primary" @click="showAddModal = true">
          {{ t('browserList.addBrowser') }}
        </button>
      </div>
      
      <div v-if="loading" class="loading">{{ t('common.loading') }}</div>
      
      <div v-else class="grid grid-2">
        <div v-for="browser in browsers" :key="browser.id" class="browser-card card">
          <div class="browser-headline">
            <h3 class="browser-name">{{ browser.name }}</h3>
          </div>
          <p class="browser-status-line">
            <span class="status-with-help">
              <span :class="browser.mcpEnabled ? 'status-on' : 'status-off'">
                MCP: {{ browser.mcpEnabled ? 'ON' : 'OFF' }}
              </span>
              <button
                class="inline-help-btn"
                type="button"
                :title="t('browserList.mcpHelp')"
                @click.stop="openBrowserHelp(browser, 'mcp')"
              >?</button>
            </span>
            <span class="dot-sep">•</span>
            <span class="status-with-help">
              <span :class="browser.webApiEnabled ? 'status-on' : 'status-off'">
                API: {{ browser.webApiEnabled ? 'ON' : 'OFF' }}
              </span>
              <button
                class="inline-help-btn"
                type="button"
                :title="t('browserList.apiHelp')"
                @click.stop="openBrowserHelp(browser, 'api')"
              >?</button>
            </span>
            <span v-if="browser.hasPassword" class="dot-sep">•</span>
            <span v-if="browser.hasPassword" class="status-warn">
              {{ t('browserList.needsPassword') }}
            </span>
            <span v-if="browser.domainRestrictions && browser.domainRestrictions.length" class="dot-sep">•</span>
            <span v-if="browser.domainRestrictions && browser.domainRestrictions.length" class="status-warn">
              {{ t('browserList.domainRestricted') }}
            </span>
          </p>

          <div class="browser-tools">
            <button
              v-if="authStore.isAdmin"
              class="icon-tool-btn"
              :title="t('browserList.viewToolsStatus')"
              @click="openToolsStatus(browser)"
            >
              <i class="fa-solid fa-sliders"></i>
            </button>
            <button
              v-if="authStore.isAdmin"
              class="icon-tool-btn"
              :title="t('common.edit')"
              @click="editBrowser(browser)"
            >
              <i class="fa-solid fa-pen-to-square"></i>
            </button>
            <button
              v-if="authStore.isAdmin"
              class="icon-tool-btn danger"
              :title="t('common.delete')"
              @click="confirmDelete(browser)"
            >
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>

          <div class="browser-actions">
            <button class="btn btn-primary" @click="openBrowser(browser)">
              {{ t('browserList.enterBrowser') }}
            </button>
          </div>
        </div>
      </div>
      
      <div v-if="!loading && browsers.length === 0" class="empty-state">
        <p>{{ t('browserList.noBrowsers') }}</p>
        <button v-if="authStore.isAdmin" class="btn btn-primary" @click="showAddModal = true">
          {{ t('browserList.createFirst') }}
        </button>
      </div>
    </div>

    <!-- Browser tools status modal -->
    <div v-if="showToolsModal" class="modal-overlay" @click.self="closeToolsModal">
      <div class="modal tools-modal">
        <div class="modal-header">
          <h3>{{ t('browserList.viewToolsStatus') }} - {{ selectedToolsBrowser?.name }}</h3>
          <button class="modal-close" @click="closeToolsModal">&times;</button>
        </div>

        <div class="form-group">
          <label>{{ t('browserList.mcpEndpoint') }}</label>
          <div class="mcp-endpoint">
            <code>{{ toolsStatus.endpoint || '-' }}</code>
            <button class="btn btn-secondary btn-sm" @click="copyText(toolsStatus.endpoint)">
              {{ t('browserList.copyMcpEndpoint') }}
            </button>
          </div>
        </div>

        <div class="form-group">
          <label>{{ t('browserList.mcpServerJson') }}</label>
          <div class="mcp-endpoint">
            <code>{{ mcpServerJsonPreview }}</code>
            <button class="btn btn-secondary btn-sm" @click="copyText(mcpServerJsonText)">
              {{ t('browserList.copyMcpServerJson') }}
            </button>
          </div>
        </div>

        <div class="form-group checkbox-group">
          <label>
            <input v-model="toolsStatus.mcpEnabled" type="checkbox" />
            {{ t('browserList.enableMcp') }}
          </label>
        </div>
        <div class="form-group checkbox-group">
          <label>
            <input v-model="toolsStatus.webApiEnabled" type="checkbox" />
            {{ t('browserList.enableWebApi') }}
          </label>
        </div>

        <table class="tools-table">
          <thead>
            <tr>
              <th>{{ t('browserList.toolName') }}</th>
              <th>{{ t('browserList.toolDescription') }}</th>
              <th>{{ t('browserList.mcpOpen') }}</th>
              <th>{{ t('browserList.apiOpen') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="tool in toolsStatus.tools" :key="tool.id">
              <td>{{ tool.name }}</td>
              <td>{{ tool.description }}</td>
              <td><input v-model="tool.access.mcpEnabled" type="checkbox" /></td>
              <td><input v-model="tool.access.apiEnabled" type="checkbox" /></td>
            </tr>
          </tbody>
        </table>

        <div class="modal-footer">
          <button class="btn btn-secondary" @click="goToToolsHelp">
            {{ t('browserList.openToolsHelp') }}
          </button>
          <button class="btn btn-secondary" @click="closeToolsModal">{{ t('common.cancel') }}</button>
          <button class="btn btn-primary" @click="saveToolsStatus">{{ t('common.save') }}</button>
        </div>
      </div>
    </div>
    
    <!-- Password modal -->
    <div v-if="showPasswordModal" class="modal-overlay" @click.self="showPasswordModal = false">
      <div class="modal">
        <div class="modal-header">
          <h3>{{ t('browserList.enterPassword') }}</h3>
          <button class="modal-close" @click="showPasswordModal = false">&times;</button>
        </div>
        <p>{{ t('browserList.accessNeedsPassword', { name: selectedBrowser?.name }) }}</p>
        <div class="form-group" style="margin-top: 16px;">
          <input
            v-model="browserPassword"
            type="password"
            class="input"
            :placeholder="t('browserList.browserPasswordPlaceholder')"
            @keyup.enter="verifyPassword"
          />
        </div>
        <div v-if="passwordError" class="error-message">{{ passwordError }}</div>
        <div class="modal-footer">
          <button class="btn btn-secondary" @click="showPasswordModal = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-primary" @click="verifyPassword">{{ t('common.confirm') }}</button>
        </div>
      </div>
    </div>
    
    <!-- Add/Edit browser modal -->
    <div v-if="showAddModal || showEditModal" class="modal-overlay" @click.self="closeModal">
      <div class="modal">
        <div class="modal-header">
          <h3>{{ showEditModal ? t('browserList.editBrowser') : t('browserList.addBrowserTitle') }}</h3>
          <button class="modal-close" @click="closeModal">&times;</button>
        </div>
        <form @submit.prevent="saveBrowser">
          <div class="form-group">
            <label>{{ t('browserList.browserId') }}</label>
            <input
              v-model="form.id"
              type="text"
              class="input"
              :placeholder="t('browserList.browserIdPlaceholder')"
              :disabled="showEditModal"
              required
            />
          </div>
          <div class="form-group">
            <label>{{ t('browserList.name') }}</label>
            <input
              v-model="form.name"
              type="text"
              class="input"
              :placeholder="t('browserList.namePlaceholder')"
              required
            />
          </div>
          <div class="form-group">
            <label>{{ t('browserList.defaultUrl') }}</label>
            <input
              v-model="form.url"
              type="url"
              class="input"
              placeholder="https://..."
              required
            />
          </div>
          <div class="form-group">
            <label>{{ t('browserList.accessPassword') }}</label>
            <input
              v-model="form.password"
              type="password"
              class="input"
              :placeholder="t('browserList.noPasswordHint')"
            />
          </div>
          <div class="form-group checkbox-group">
            <label>
              <input v-model="form.mcpEnabled" type="checkbox" />
              {{ t('browserList.enableMcp') }}
            </label>
          </div>
          <div class="form-group checkbox-group">
            <label>
              <input v-model="form.webApiEnabled" type="checkbox" />
              {{ t('browserList.enableWebApi') }}
            </label>
          </div>
          <div class="form-group">
            <label>{{ t('browserList.domainRestrictions') }}</label>
            <textarea
              v-model="form.domainRestrictionsText"
              class="input"
              rows="3"
              :placeholder="t('browserList.domainRestrictionsPlaceholder')"
            ></textarea>
            <small>{{ t('browserList.domainRestrictionsHint') }}</small>
          </div>
          <div v-if="formError" class="error-message">{{ formError }}</div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" @click="closeModal">{{ t('common.cancel') }}</button>
            <button type="submit" class="btn btn-primary">{{ t('common.save') }}</button>
          </div>
        </form>
      </div>
    </div>
    
    <!-- Delete confirmation modal -->
    <div v-if="showDeleteModal" class="modal-overlay" @click.self="showDeleteModal = false">
      <div class="modal">
        <div class="modal-header">
          <h3>{{ t('browserList.confirmDelete') }}</h3>
          <button class="modal-close" @click="showDeleteModal = false">&times;</button>
        </div>
        <p>{{ t('browserList.confirmDeleteBrowser', { name: browserToDelete?.name }) }}</p>
        <p style="color: #e74c3c; margin-top: 8px; font-size: 14px;">
          {{ t('browserList.deleteWarning') }}
        </p>
        <div class="modal-footer">
          <button class="btn btn-secondary" @click="showDeleteModal = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-danger" @click="deleteBrowser">{{ t('common.delete') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import api from '../utils/api'
import { useI18n } from '../i18n'

const { t } = useI18n()
const router = useRouter()
const authStore = useAuthStore()

const browsers = ref([])
const loading = ref(true)
const versionInfo = ref({ version: 'unknown', buildTime: '' })

const showPasswordModal = ref(false)
const showAddModal = ref(false)
const showEditModal = ref(false)
const showDeleteModal = ref(false)
const showToolsModal = ref(false)

const selectedBrowser = ref(null)
const browserPassword = ref('')
const passwordError = ref('')
const browserToDelete = ref(null)
const selectedToolsBrowser = ref(null)
const toolsStatus = ref({
  mcpEnabled: false,
  webApiEnabled: false,
  endpoint: '',
  mcpServerJson: {},
  tools: []
})

const form = ref({
  id: '',
  name: '',
  url: '',
  password: '',
  mcpEnabled: false,
  webApiEnabled: false,
  domainRestrictionsText: ''
})
const formError = ref('')

const mcpServerJsonText = computed(() => {
  if (!toolsStatus.value.mcpServerJson) return ''
  const clone = JSON.parse(JSON.stringify(toolsStatus.value.mcpServerJson))
  const token = localStorage.getItem('token') || '<token>'
  const browserKey = Object.keys(clone.mcpServers || {})[0]
  if (browserKey) {
    clone.mcpServers[browserKey].headers.Authorization = `Bearer ${token}`
  }
  return JSON.stringify(clone, null, 2)
})

const mcpServerJsonPreview = computed(() => {
  const text = mcpServerJsonText.value
  return text.length > 160 ? `${text.slice(0, 160)}...` : text
})

const versionTag = computed(() => versionInfo.value.version || 'unknown')
const buildTimeTag = computed(() => {
  const value = versionInfo.value.buildTime || ''
  return value && value !== 'unknown' ? value : ''
})

async function loadBrowsers() {
  loading.value = true
  try {
    const response = await api.get('/api/browsers')
    browsers.value = response.data
  } catch (e) {
    console.error('Failed to load browser list:', e)
  } finally {
    loading.value = false
  }
}

async function loadVersion() {
  try {
    const response = await api.get('/api/version')
    versionInfo.value = {
      version: response.data?.version || 'unknown',
      buildTime: response.data?.buildTime || ''
    }
  } catch (e) {
    versionInfo.value = { version: 'unknown', buildTime: '' }
    console.warn('Failed to load version info:', e)
  }
}

function openBrowser(browser) {
  if (browser.hasPassword) {
    selectedBrowser.value = browser
    browserPassword.value = ''
    passwordError.value = ''
    showPasswordModal.value = true
  } else {
    router.push(`/browser/${browser.id}`)
  }
}

async function verifyPassword() {
  if (!browserPassword.value) {
    passwordError.value = t('browserList.passwordRequired')
    return
  }
  
  try {
    const response = await api.post(`/api/browsers/${selectedBrowser.value.id}/verify`, {
      password: browserPassword.value
    })
    
    if (response.data.valid) {
      showPasswordModal.value = false
      router.push(`/browser/${selectedBrowser.value.id}`)
    } else {
      passwordError.value = t('browserList.wrongPassword')
    }
  } catch (e) {
    passwordError.value = e.response?.data?.error || t('browserList.verifyFailed')
  }
}

function editBrowser(browser) {
  form.value = {
    id: browser.id,
    name: browser.name,
    url: browser.url,
    password: '',
    mcpEnabled: !!browser.mcpEnabled,
    webApiEnabled: !!browser.webApiEnabled,
    domainRestrictionsText: Array.isArray(browser.domainRestrictions)
      ? browser.domainRestrictions.join('\n')
      : ''
  }
  formError.value = ''
  showEditModal.value = true
}

function confirmDelete(browser) {
  browserToDelete.value = browser
  showDeleteModal.value = true
}

async function saveBrowser() {
  formError.value = ''
  
  try {
    if (showEditModal.value) {
      await api.put(`/api/browsers/${form.value.id}`, {
        name: form.value.name,
        url: form.value.url,
        password: form.value.password || undefined,
        mcpEnabled: !!form.value.mcpEnabled,
        webApiEnabled: !!form.value.webApiEnabled,
        domainRestrictions: parseDomainRestrictions(form.value.domainRestrictionsText)
      })
    } else {
      await api.post('/api/browsers', {
        ...form.value,
        domainRestrictions: parseDomainRestrictions(form.value.domainRestrictionsText)
      })
    }
    
    closeModal()
    await loadBrowsers()
  } catch (e) {
    formError.value = e.response?.data?.error || t('browserList.saveFailed')
  }
}

async function deleteBrowser() {
  try {
    await api.delete(`/api/browsers/${browserToDelete.value.id}`)
    showDeleteModal.value = false
    await loadBrowsers()
  } catch (e) {
    console.error('Delete failed:', e)
  }
}

function closeModal() {
  showAddModal.value = false
  showEditModal.value = false
  form.value = {
    id: '',
    name: '',
    url: '',
    password: '',
    mcpEnabled: false,
    webApiEnabled: false,
    domainRestrictionsText: ''
  }
  formError.value = ''
}

function parseDomainRestrictions(text) {
  return String(text || '')
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

async function openToolsStatus(browser) {
  selectedToolsBrowser.value = browser
  showToolsModal.value = true
  try {
    const resp = await api.get(`/api/browsers/${browser.id}/tools-status`)
    toolsStatus.value = resp.data
  } catch (e) {
    console.error('Failed to load tools status:', e)
  }
}

async function saveToolsStatus() {
  if (!selectedToolsBrowser.value) return
  const toolAccess = {}
  for (const tool of toolsStatus.value.tools || []) {
    toolAccess[tool.id] = {
      mcpEnabled: !!tool.access?.mcpEnabled,
      apiEnabled: !!tool.access?.apiEnabled
    }
  }
  try {
    await api.put(`/api/browsers/${selectedToolsBrowser.value.id}/tools-status`, {
      mcpEnabled: !!toolsStatus.value.mcpEnabled,
      webApiEnabled: !!toolsStatus.value.webApiEnabled,
      toolAccess
    })
    closeToolsModal()
    await loadBrowsers()
  } catch (e) {
    console.error('Failed to save tools status:', e)
  }
}

function closeToolsModal() {
  showToolsModal.value = false
  selectedToolsBrowser.value = null
}

function goToToolsHelp() {
  router.push('/tools-help/mcp')
}

function openBrowserHelp(browser, helpType) {
  const mode = helpType === 'api' ? 'api' : 'mcp'
  router.push({
    path: `/tools-help/${mode}`,
    query: {
      browserId: String(browser?.id || ''),
      helpType: mode
    }
  })
}

function copyText(text) {
  if (!text) return
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text))
  } else {
    fallbackCopy(text)
  }
}

function fallbackCopy(text) {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.cssText = 'position:fixed;opacity:0;left:-9999px;top:-9999px'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  try {
    document.execCommand('copy')
  } catch (e) {
    console.warn('Copy failed:', e)
  }
  document.body.removeChild(textarea)
}

function goToUsers() {
  router.push('/admin/users')
}

function goToLogs() {
  router.push('/admin/logs')
}

function goToCalllog() {
  router.push('/admin/calllog')
}

function goToReport() {
  router.push('/admin/report')
}

function handleLogout() {
  authStore.logout()
  router.push('/login')
}

onMounted(() => {
  loadVersion()
  loadBrowsers()
})
</script>

<style scoped>
.browser-list-page {
  min-height: 100vh;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}

.header-title {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.version-info {
  font-size: 12px;
  color: var(--text-secondary);
}

.version-info code {
  font-size: 12px;
}

.user-info {
  color: var(--text-secondary);
  margin-right: 8px;
}

.browser-card {
  transition: transform 0.2s, box-shadow 0.2s;
}

.browser-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
}

.browser-headline {
  margin-bottom: 10px;
}

.browser-name {
  font-size: 18px;
  font-weight: 600;
}

.browser-status-line {
  font-size: 12px;
  margin-bottom: 12px;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.dot-sep {
  color: #97a3af;
}

.status-on {
  color: #24a85e;
  font-weight: 600;
}

.status-off {
  color: #a1a7b0;
}

.status-warn {
  color: #d98f2b;
  font-weight: 600;
}

.status-with-help {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.inline-help-btn {
  width: 16px;
  height: 16px;
  border: 1px solid #c7ced8;
  border-radius: 50%;
  background: #f4f6f9;
  color: #5c6674;
  font-size: 11px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
}

.inline-help-btn:hover {
  background: #e9edf3;
  color: #1f2937;
}

.browser-tools {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
}

.icon-tool-btn {
  width: 28px;
  height: 28px;
  border: 1px solid #d7dbe3;
  border-radius: 7px;
  background: #f8fafc;
  color: #4b5563;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
}

.icon-tool-btn:hover {
  border-color: #9aa6b2;
  color: #1f2937;
  background: #eef2f7;
}

.icon-tool-btn.danger {
  color: #b42318;
  border-color: #f2c6c2;
  background: #fff5f4;
}

.icon-tool-btn.danger:hover {
  border-color: #e08f89;
  background: #ffecea;
}

.checkbox-group input[type="checkbox"] {
  margin-right: 6px;
}

.browser-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.empty-state {
  text-align: center;
  padding: 60px 20px;
  color: var(--text-secondary);
}

.empty-state p {
  margin-bottom: 16px;
}

.tools-modal {
  width: min(960px, 90vw);
  max-height: 80vh;
  overflow: auto;
}

.tools-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 12px;
}

.tools-table th,
.tools-table td {
  border-bottom: 1px solid var(--border-color);
  padding: 8px;
  text-align: left;
  font-size: 13px;
}
</style>
