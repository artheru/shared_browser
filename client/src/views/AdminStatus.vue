<template>
  <div class="admin-status-page">
    <header class="header">
      <h1>{{ t('adminStatus.title') }}</h1>
      <div class="header-actions">
        <button class="btn btn-secondary btn-sm" @click="$router.push('/')">
          {{ t('adminStatus.backToHome') }}
        </button>
      </div>
    </header>

    <div class="container">
      <!-- System Overview -->
      <div class="stats-bar">
        <div class="stat-item">
          <span class="stat-value">{{ browserStatus.length }}</span>
          <span class="stat-label">{{ t('adminStatus.totalBrowsers') }}</span>
        </div>
        <div class="stat-item stat-running">
          <span class="stat-value">{{ runningCount }}</span>
          <span class="stat-label">{{ t('adminStatus.runningBrowsers') }}</span>
        </div>
        <div class="stat-item stat-sessions">
          <span class="stat-value">{{ totalSessions }}</span>
          <span class="stat-label">{{ t('adminStatus.totalSessions') }}</span>
        </div>
      </div>

      <!-- Browser Status -->
      <div class="section">
        <h2 class="section-title">{{ t('adminStatus.browserStatus') }}</h2>
        <div class="card">
          <table>
            <thead>
              <tr>
                <th>{{ t('adminStatus.colBrowserId') }}</th>
                <th>{{ t('adminStatus.colStatus') }}</th>
                <th>{{ t('adminStatus.colSessions') }}</th>
                <th>{{ t('adminStatus.colTabs') }}</th>
                <th>{{ t('adminStatus.colRestartCount') }}</th>
                <th>{{ t('adminStatus.colLastCrash') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="browserStatus.length === 0">
                <td colspan="6" class="empty-row">{{ t('adminStatus.noBrowsersRunning') }}</td>
              </tr>
              <tr v-for="b in browserStatus" :key="b.id">
                <td><span class="browser-badge">{{ b.id }}</span></td>
                <td>
                  <span :class="b.isConnected ? 'status-badge status-running' : 'status-badge status-stopped'">
                    {{ b.isConnected ? t('adminStatus.running') : t('adminStatus.stopped') }}
                  </span>
                </td>
                <td>{{ b.sessionCount }}</td>
                <td>
                  <span v-for="(s, i) in b.sessions" :key="i" class="tab-count-badge">
                    {{ s.userId }}: {{ s.tabCount }}
                  </span>
                  <span v-if="b.sessions.length === 0">-</span>
                </td>
                <td>{{ b.restartInfo ? b.restartInfo.retries : 0 }}</td>
                <td class="time-cell">{{ b.restartInfo?.lastCrash ? formatTime(b.restartInfo.lastCrash) : '-' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- User Usage -->
      <div class="section">
        <h2 class="section-title">{{ t('adminStatus.userUsage') }}</h2>
        <div class="card">
          <table>
            <thead>
              <tr>
                <th>{{ t('adminStatus.colUser') }}</th>
                <th>{{ t('adminStatus.colBrowser') }}</th>
                <th>{{ t('adminStatus.colMouseDistance') }}</th>
                <th>{{ t('adminStatus.colInputCount') }}</th>
                <th>{{ t('adminStatus.colPageViews') }}</th>
                <th>{{ t('adminStatus.colDownloads') }}</th>
                <th>{{ t('adminStatus.colUploads') }}</th>
                <th>{{ t('adminStatus.colConnectedTime') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="usageStats.length === 0">
                <td colspan="8" class="empty-row">{{ t('adminStatus.noActiveSessions') }}</td>
              </tr>
              <tr v-for="(u, i) in usageStats" :key="i">
                <td>{{ u.userId }}</td>
                <td><span class="browser-badge">{{ u.browserId }}</span></td>
                <td>{{ formatDistance(u.mouseDistance) }}</td>
                <td>{{ u.inputCount.toLocaleString() }}</td>
                <td>{{ u.pageViews }}</td>
                <td>{{ u.downloadCount }}</td>
                <td>{{ u.uploadCount }}</td>
                <td class="time-cell">{{ formatDuration(u.connectedDuration) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Auto refresh -->
      <div class="auto-refresh">
        <label>
          <input type="checkbox" v-model="autoRefresh" @change="toggleAutoRefresh" />
          {{ t('adminStatus.autoRefresh') }}
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

const browserStatus = ref([])
const usageStats = ref([])
const totalSessions = ref(0)
const autoRefresh = ref(true)
let refreshTimer = null

const runningCount = computed(() => browserStatus.value.filter(b => b.isConnected).length)

async function loadData() {
  try {
    const [statusResp, usageResp] = await Promise.all([
      api.get('/api/status'),
      api.get('/api/usage')
    ])
    browserStatus.value = statusResp.data.browsers || []
    totalSessions.value = statusResp.data.totalSessions || 0
    usageStats.value = usageResp.data || []
  } catch (e) {
    console.error('Failed to load status:', e)
  }
}

function formatTime(ts) {
  if (!ts) return '-'
  const d = new Date(ts)
  const pad = n => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '-'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ${sec % 60}s`
  const hr = Math.floor(min / 60)
  return `${hr}h ${min % 60}m`
}

function formatDistance(px) {
  if (!px || px <= 0) return '0'
  if (px < 1000) return `${px} px`
  return `${(px / 1000).toFixed(1)}k px`
}

function toggleAutoRefresh() {
  if (autoRefresh.value) {
    refreshTimer = setInterval(loadData, 5000)
  } else {
    if (refreshTimer) {
      clearInterval(refreshTimer)
      refreshTimer = null
    }
  }
}

onMounted(() => {
  loadData()
  if (autoRefresh.value) {
    refreshTimer = setInterval(loadData, 5000)
  }
})

onUnmounted(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer)
  }
})
</script>

<style scoped>
.admin-status-page {
  min-height: 100vh;
}

.stats-bar {
  display: flex;
  gap: 16px;
  margin-bottom: 24px;
  flex-wrap: wrap;
}

.stat-item {
  background: var(--card-bg);
  padding: 16px 24px;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 100px;
}

.stat-value {
  font-size: 28px;
  font-weight: 700;
  color: var(--text-primary);
}

.stat-label {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 4px;
}

.stat-running .stat-value { color: #2ecc71; }
.stat-sessions .stat-value { color: #3498db; }

.section {
  margin-bottom: 24px;
}

.section-title {
  font-size: 18px;
  font-weight: 600;
  margin-bottom: 12px;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

th {
  background: var(--card-bg);
  padding: 10px 12px;
  text-align: left;
  font-weight: 600;
  color: var(--text-secondary);
  border-bottom: 2px solid var(--border-color);
  white-space: nowrap;
}

td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-color);
}

.empty-row {
  text-align: center;
  padding: 24px !important;
  color: var(--text-secondary);
}

.browser-badge {
  display: inline-block;
  padding: 2px 8px;
  background: var(--card-bg);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  font-size: 12px;
  font-family: monospace;
}

.status-badge {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
}

.status-running { background: #2ecc7122; color: #2ecc71; }
.status-stopped { background: #e74c3c22; color: #e74c3c; }

.tab-count-badge {
  display: inline-block;
  padding: 1px 6px;
  background: #3498db22;
  color: #3498db;
  border-radius: 4px;
  font-size: 12px;
  margin-right: 4px;
}

.time-cell {
  font-family: monospace;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.auto-refresh {
  margin-top: 16px;
  font-size: 14px;
  color: var(--text-secondary);
}

.auto-refresh input[type="checkbox"] {
  margin-right: 6px;
}
</style>
