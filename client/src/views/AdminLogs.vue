<template>
  <div class="admin-logs-page">
    <header class="header">
      <h1>{{ t('adminLogs.title') }}</h1>
      <div class="header-actions">
        <button class="btn btn-secondary btn-sm" @click="$router.push('/')">
          {{ t('adminLogs.backToHome') }}
        </button>
      </div>
    </header>

    <div class="container">
      <div class="page-header">
        <h2 class="page-title">{{ t('adminLogs.browserLogs') }}</h2>
        <div class="filter-controls">
          <select v-model="selectedBrowser" class="input filter-select" @change="loadLogs">
            <option value="">{{ t('adminLogs.allBrowsers') }}</option>
            <option v-for="id in browserIds" :key="id" :value="id">{{ id }}</option>
          </select>
          <select v-model="selectedLevel" class="input filter-select" @change="loadLogs">
            <option value="">{{ t('adminLogs.allLevels') }}</option>
            <option value="info">INFO</option>
            <option value="warn">WARN</option>
            <option value="error">ERROR</option>
            <option value="crash">CRASH</option>
          </select>
          <button class="btn btn-secondary btn-sm" @click="loadLogs">
            {{ t('common.refresh') }}
          </button>
          <button
            v-if="selectedBrowser"
            class="btn btn-danger btn-sm"
            @click="clearLogs"
          >
            {{ t('adminLogs.clearLogs') }}
          </button>
        </div>
      </div>

      <!-- Stats summary -->
      <div class="stats-bar">
        <div class="stat-item">
          <span class="stat-value">{{ logs.length }}</span>
          <span class="stat-label">{{ t('adminLogs.totalEntries') }}</span>
        </div>
        <div class="stat-item stat-error">
          <span class="stat-value">{{ errorCount }}</span>
          <span class="stat-label">{{ t('adminLogs.errors') }}</span>
        </div>
        <div class="stat-item stat-crash">
          <span class="stat-value">{{ crashCount }}</span>
          <span class="stat-label">{{ t('adminLogs.crashes') }}</span>
        </div>
        <div class="stat-item stat-warn">
          <span class="stat-value">{{ warnCount }}</span>
          <span class="stat-label">{{ t('adminLogs.warnings') }}</span>
        </div>
      </div>

      <!-- Logs table -->
      <div v-if="loading" class="loading">{{ t('common.loading') }}</div>

      <div v-else class="logs-table-wrapper">
        <table class="logs-table">
          <thead>
            <tr>
              <th class="col-time">{{ t('adminLogs.colTime') }}</th>
              <th class="col-browser" v-if="!selectedBrowser">{{ t('adminLogs.colBrowser') }}</th>
              <th class="col-level">{{ t('adminLogs.colLevel') }}</th>
              <th class="col-message">{{ t('adminLogs.colMessage') }}</th>
              <th class="col-details">{{ t('adminLogs.colDetails') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="filteredLogs.length === 0">
              <td :colspan="selectedBrowser ? 4 : 5" class="empty-row">{{ t('adminLogs.noLogs') }}</td>
            </tr>
            <tr
              v-for="(log, index) in filteredLogs"
              :key="index"
              :class="'log-row log-' + log.level"
            >
              <td class="col-time">{{ formatTime(log.timestamp) }}</td>
              <td class="col-browser" v-if="!selectedBrowser">
                <span class="browser-badge">{{ log.browserId || selectedBrowser }}</span>
              </td>
              <td class="col-level">
                <span :class="'level-badge level-' + log.level">
                  {{ log.level.toUpperCase() }}
                </span>
              </td>
              <td class="col-message">{{ log.message }}</td>
              <td class="col-details">
                <span
                  v-if="log.details"
                  class="details-text"
                  :title="log.details"
                >{{ truncateDetails(log.details) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Auto refresh -->
      <div class="auto-refresh">
        <label>
          <input type="checkbox" v-model="autoRefresh" @change="toggleAutoRefresh" />
          {{ t('adminLogs.autoRefresh') }}
        </label>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import api from '../utils/api'
import { useI18n } from '../i18n'

const { t } = useI18n()

const logs = ref([])
const browserIds = ref([])
const loading = ref(true)
const selectedBrowser = ref('')
const selectedLevel = ref('')
const autoRefresh = ref(false)
let refreshTimer = null

const filteredLogs = computed(() => {
  let result = logs.value
  if (selectedLevel.value) {
    result = result.filter(l => l.level === selectedLevel.value)
  }
  return [...result].reverse()
})

const errorCount = computed(() => logs.value.filter(l => l.level === 'error').length)
const crashCount = computed(() => logs.value.filter(l => l.level === 'crash').length)
const warnCount = computed(() => logs.value.filter(l => l.level === 'warn').length)

async function loadBrowserIds() {
  try {
    const resp = await api.get('/api/logs-browsers')
    browserIds.value = resp.data
  } catch (e) {
    console.error('Failed to load browser list:', e)
  }
}

async function loadLogs() {
  loading.value = true
  try {
    let url
    if (selectedBrowser.value) {
      url = `/api/logs/${selectedBrowser.value}?limit=500`
      if (selectedLevel.value) {
        url += `&level=${selectedLevel.value}`
      }
    } else {
      url = `/api/logs?limit=500`
    }
    const resp = await api.get(url)
    logs.value = resp.data
  } catch (e) {
    console.error('Failed to load logs:', e)
  } finally {
    loading.value = false
  }
}

async function clearLogs() {
  if (!selectedBrowser.value) return
  if (!confirm(t('adminLogs.confirmClear', { browser: selectedBrowser.value }))) return
  try {
    await api.delete(`/api/logs/${selectedBrowser.value}`)
    await loadLogs()
  } catch (e) {
    console.error('Failed to clear logs:', e)
  }
}

function formatTime(timestamp) {
  if (!timestamp) return '-'
  const d = new Date(timestamp)
  const pad = n => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function truncateDetails(details) {
  if (!details) return ''
  if (details.length > 120) return details.substring(0, 120) + '...'
  return details
}

function toggleAutoRefresh() {
  if (autoRefresh.value) {
    refreshTimer = setInterval(loadLogs, 5000)
  } else {
    if (refreshTimer) {
      clearInterval(refreshTimer)
      refreshTimer = null
    }
  }
}

onMounted(async () => {
  await loadBrowserIds()
  await loadLogs()
})

onUnmounted(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer)
  }
})
</script>

<style scoped>
.admin-logs-page {
  min-height: 100vh;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  flex-wrap: wrap;
  gap: 12px;
}

.filter-controls {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.filter-select {
  max-width: 180px;
  padding: 6px 10px;
  font-size: 14px;
}

/* Stats summary */
.stats-bar {
  display: flex;
  gap: 16px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.stat-item {
  background: var(--card-bg);
  padding: 12px 20px;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 80px;
}

.stat-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--text-primary);
}

.stat-label {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 2px;
}

.stat-error .stat-value { color: #e74c3c; }
.stat-crash .stat-value { color: #c0392b; }
.stat-warn .stat-value { color: #f39c12; }

/* Logs table */
.logs-table-wrapper {
  overflow-x: auto;
  border-radius: 8px;
  border: 1px solid var(--border-color);
}

.logs-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.logs-table th {
  background: var(--card-bg);
  padding: 10px 12px;
  text-align: left;
  font-weight: 600;
  color: var(--text-secondary);
  border-bottom: 2px solid var(--border-color);
  white-space: nowrap;
}

.logs-table td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
  vertical-align: top;
}

.col-time { width: 120px; white-space: nowrap; font-family: monospace; font-size: 12px; color: var(--text-secondary); }
.col-browser { width: 100px; }
.col-level { width: 70px; }
.col-message { min-width: 200px; }
.col-details { max-width: 300px; }

.empty-row {
  text-align: center;
  padding: 24px !important;
  color: var(--text-secondary);
}

/* Log row colors */
.log-row.log-error { background: rgba(231, 76, 60, 0.05); }
.log-row.log-crash { background: rgba(192, 57, 43, 0.1); }
.log-row.log-warn { background: rgba(243, 156, 18, 0.05); }

/* Level badges */
.level-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
}

.level-info { background: #3498db22; color: #3498db; }
.level-warn { background: #f39c1233; color: #e67e22; }
.level-error { background: #e74c3c22; color: #e74c3c; }
.level-crash { background: #c0392b33; color: #c0392b; font-weight: 700; }

.browser-badge {
  display: inline-block;
  padding: 2px 6px;
  background: var(--card-bg);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  font-size: 12px;
  font-family: monospace;
}

.details-text {
  font-family: monospace;
  font-size: 12px;
  color: var(--text-secondary);
  word-break: break-all;
}

/* Auto refresh */
.auto-refresh {
  margin-top: 16px;
  font-size: 14px;
  color: var(--text-secondary);
}

.auto-refresh input[type="checkbox"] {
  margin-right: 6px;
}
</style>
