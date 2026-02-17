<template>
  <div class="admin-calllog-page">
    <header class="header">
      <h1>{{ t('adminCalllog.title') }}</h1>
      <div class="header-actions">
        <button class="btn btn-secondary btn-sm" @click="$router.push('/')">
          {{ t('adminCalllog.backToHome') }}
        </button>
        <button class="btn btn-secondary btn-sm" @click="$router.push('/tools-help')">
          {{ t('common.help') }}
        </button>
      </div>
    </header>

    <div class="container">
      <div class="filters card">
        <div class="filter-row">
          <label>
            {{ t('adminCalllog.filterBrowser') }}
            <input v-model="browserFilter" class="input filter-input" :placeholder="t('adminCalllog.filterBrowserPlaceholder')" />
          </label>
          <label>
            {{ t('adminCalllog.filterSource') }}
            <select v-model="sourceFilter" class="input filter-input">
              <option value="">{{ t('adminCalllog.allSources') }}</option>
              <option value="mcp">MCP</option>
              <option value="api">API</option>
            </select>
          </label>
          <label>
            {{ t('adminCalllog.limit') }}
            <select v-model.number="limit" class="input filter-input">
              <option :value="100">100</option>
              <option :value="200">200</option>
              <option :value="500">500</option>
            </select>
          </label>
          <button class="btn btn-primary btn-sm" @click="loadData">{{ t('common.refresh') }}</button>
        </div>
      </div>

      <div class="auto-refresh">
        <label>
          <input type="checkbox" v-model="autoRefresh" @change="toggleAutoRefresh" />
          {{ t('adminCalllog.autoRefresh') }}
        </label>
      </div>

      <div class="section">
        <h2 class="section-title">
          {{ t('adminCalllog.total', { count: calls.length }) }}
        </h2>
        <div class="card">
          <table>
            <thead>
              <tr>
                <th>{{ t('adminCalllog.colTime') }}</th>
                <th>{{ t('adminCalllog.colSource') }}</th>
                <th>{{ t('adminCalllog.colBrowser') }}</th>
                <th>{{ t('adminCalllog.colTool') }}</th>
                <th>{{ t('adminCalllog.colPath') }}</th>
                <th>{{ t('adminCalllog.colStatus') }}</th>
                <th>{{ t('adminCalllog.colDuration') }}</th>
                <th>{{ t('adminCalllog.colUser') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="calls.length === 0">
                <td colspan="8" class="empty-row">{{ t('adminCalllog.noCalls') }}</td>
              </tr>
              <template v-for="call in calls" :key="call.id">
                <tr class="main-row" @click="toggleExpand(call.id)">
                  <td class="time-cell">{{ formatTime(call.timestamp) }}</td>
                  <td><span class="source-badge">{{ String(call.source || '-').toUpperCase() }}</span></td>
                  <td><span class="browser-badge">{{ call.browserId || '-' }}</span></td>
                  <td>{{ call.tool || '-' }}</td>
                  <td class="path-cell">{{ call.path || '-' }}</td>
                  <td>
                    <span :class="call.status === 'ok' ? 'status-badge status-running' : 'status-badge status-stopped'">
                      {{ call.status || '-' }}
                    </span>
                  </td>
                  <td>{{ call.durationMs || 0 }}ms</td>
                  <td>{{ call.user || '-' }}</td>
                </tr>
                <tr v-if="expandedId === call.id" class="detail-row">
                  <td colspan="8">
                    <div class="detail-grid">
                      <div>
                        <div class="detail-title">{{ t('adminCalllog.requestParams') }}</div>
                        <pre class="json-block">{{ formatJson(call.request) }}</pre>
                      </div>
                      <div>
                        <div class="detail-title">{{ t('adminCalllog.responsePayload') }}</div>
                        <pre class="json-block">{{ formatJson(call.response) }}</pre>
                      </div>
                    </div>
                    <div v-if="call.error" class="error-line">
                      <strong>Error:</strong> {{ call.error }}
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import api from '../utils/api'
import { useI18n } from '../i18n'

const { t } = useI18n()

const calls = ref([])
const expandedId = ref('')
const browserFilter = ref('')
const sourceFilter = ref('')
const limit = ref(200)
const autoRefresh = ref(true)
let refreshTimer = null

async function loadData() {
  try {
    const params = new URLSearchParams()
    params.set('limit', String(limit.value || 200))
    if (browserFilter.value.trim()) params.set('browserId', browserFilter.value.trim())
    if (sourceFilter.value) params.set('source', sourceFilter.value)
    const resp = await api.get(`/api/calllog?${params.toString()}`)
    calls.value = Array.isArray(resp.data) ? resp.data : []
  } catch (e) {
    console.error('Failed to load calllog:', e)
  }
}

function toggleExpand(id) {
  expandedId.value = expandedId.value === id ? '' : id
}

function formatTime(ts) {
  if (!ts) return '-'
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatJson(value) {
  if (value === undefined) return '-'
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function toggleAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
  if (autoRefresh.value) {
    refreshTimer = setInterval(loadData, 5000)
  }
}

onMounted(() => {
  loadData()
  toggleAutoRefresh()
})

onUnmounted(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer)
  }
})
</script>

<style scoped>
.admin-calllog-page {
  min-height: 100vh;
}

.filters {
  margin-bottom: 12px;
}

.filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: end;
}

.filter-row label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  color: var(--text-secondary);
}

.filter-input {
  min-width: 180px;
}

.auto-refresh {
  margin-bottom: 12px;
  font-size: 14px;
  color: var(--text-secondary);
}

.auto-refresh input[type="checkbox"] {
  margin-right: 6px;
}

.section-title {
  margin-bottom: 10px;
  font-size: 16px;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

th {
  background: var(--card-bg);
  padding: 8px 10px;
  text-align: left;
  color: var(--text-secondary);
  border-bottom: 2px solid var(--border-color);
}

td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-color);
  vertical-align: top;
}

.main-row {
  cursor: pointer;
}

.main-row:hover {
  background: rgba(255, 255, 255, 0.03);
}

.detail-row td {
  background: rgba(255, 255, 255, 0.02);
}

.detail-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.detail-title {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 6px;
}

.json-block {
  margin: 0;
  padding: 8px;
  background: #111;
  border: 1px solid #333;
  border-radius: 6px;
  max-height: 240px;
  overflow: auto;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

.error-line {
  margin-top: 8px;
  color: #e74c3c;
  font-size: 12px;
}

.empty-row {
  text-align: center;
  color: var(--text-secondary);
  padding: 20px !important;
}

.browser-badge {
  display: inline-block;
  padding: 1px 6px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  font-family: monospace;
  font-size: 12px;
}

.source-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 4px;
  background: #3498db22;
  color: #3498db;
  font-weight: 600;
  font-size: 12px;
}

.status-badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
}

.status-running { background: #2ecc7122; color: #2ecc71; }
.status-stopped { background: #e74c3c22; color: #e74c3c; }

.time-cell {
  font-family: monospace;
  font-size: 12px;
  white-space: nowrap;
}

.path-cell {
  max-width: 320px;
  word-break: break-all;
}
</style>
