<template>
  <div class="admin-report-page">
    <header class="header">
      <h1>{{ t('adminReport.title') }}</h1>
      <div class="header-actions">
        <button class="btn btn-secondary btn-sm" @click="$router.push('/')">
          {{ t('adminReport.backToHome') }}
        </button>
        <button class="btn btn-secondary btn-sm" @click="$router.push('/tools-help')">
          {{ t('common.help') }}
        </button>
      </div>
    </header>

    <div class="container">
      <div class="top-actions">
        <button class="btn btn-secondary btn-sm" @click="loadReport">{{ t('common.refresh') }}</button>
        <label class="auto-refresh">
          <input type="checkbox" v-model="autoRefresh" @change="toggleAutoRefresh" />
          {{ t('adminReport.autoRefresh') }}
        </label>
        <label class="refresh-interval">
          <span>{{ t('adminReport.refreshInterval') }}</span>
          <select v-model.number="refreshIntervalMs" @change="toggleAutoRefresh">
            <option :value="5000">5s</option>
            <option :value="1000">1s</option>
            <option :value="500">0.5s</option>
            <option :value="100">0.1s</option>
          </select>
        </label>
      </div>

      <div class="stats-bar" v-if="report">
        <div class="stat-item">
          <span class="stat-value">{{ report.totalBrowsers || 0 }}</span>
          <span class="stat-label">{{ t('adminReport.totalBrowsers') }}</span>
        </div>
        <div class="stat-item">
          <span class="stat-value">{{ report.totalSessions || 0 }}</span>
          <span class="stat-label">{{ t('adminReport.totalSessions') }}</span>
        </div>
        <div class="stat-item">
          <span class="stat-value">{{ totalTabs }}</span>
          <span class="stat-label">{{ t('adminReport.totalTabs') }}</span>
        </div>
      </div>

      <div v-if="loading && !hasLoadedOnce" class="loading">{{ t('common.loading') }}</div>

      <div v-else class="sections">
        <div v-for="browser in (report?.byBrowser || [])" :key="browser.browserId" class="section card">
          <div class="section-head">
            <div>
              <div class="browser-name">{{ browser.browserName || browser.browserId }}</div>
              <div class="browser-meta">
                <code>{{ browser.browserId }}</code>
                <span>MCP: {{ browser.mcpEnabled ? 'ON' : 'OFF' }}</span>
                <span>API: {{ browser.webApiEnabled ? 'ON' : 'OFF' }}</span>
              </div>
              <div class="process-meta">
                <span class="k">{{ t('adminReport.browserProcess') }}:</span>
                <code>PID {{ browser.process?.pid || '-' }}</code>
                <span :class="browser.process?.alive ? 'ok' : 'warn'">
                  {{ browser.process?.alive ? t('adminReport.browserAlive') : t('adminReport.browserDead') }}
                </span>
              </div>
            </div>
            <div class="endpoints">
              <div><span class="k">{{ t('adminReport.mcpEndpoint') }}:</span> <code>{{ browser.mcpEndpoint }}</code></div>
              <div><span class="k">{{ t('adminReport.wsEndpoint') }}:</span> <code>{{ browser.wsEndpoint }}</code></div>
            </div>
          </div>

          <!-- ===== Tab Info Table ===== -->
          <div class="sub-section-title">Tab Info</div>
          <table class="report-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Tab ID</th>
                <th>Title / URL</th>
                <th>Owner</th>
                <th>Health</th>
                <th>Recent Commands (last 2)</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!browser.tabs || browser.tabs.length === 0">
                <td colspan="6" class="empty-row">No tabs</td>
              </tr>
              <tr v-for="tab in (browser.tabs || [])" :key="tab.targetId || tab.tabIdentifier" :class="{ 'active-row': tab.isActive }">
                <td class="mono">{{ tab.index }}</td>
                <td class="mono">
                  <div class="line-wrap full-id">{{ tab.targetId || '-' }}</div>
                  <div class="muted line-wrap full-id">tabKey={{ tab.tabIdentifier || '-' }}</div>
                </td>
                <td class="tab-info-cell">
                  <div class="line-wrap">{{ tab.title || 'New Tab' }}</div>
                  <div class="muted line-wrap text-ellipsis">{{ tab.url || 'about:blank' }}</div>
                </td>
                <td>
                  <span class="user-badge">{{ tab.ownerName || tab.owner }}</span>
                </td>
                <td>
                  <span :class="tab.pageAlive ? 'ok' : 'danger'">{{ tab.pageAlive ? 'alive' : 'dead' }}</span>
                  <span class="muted"> | {{ tab.pageAlive ? 'ready' : 'loading' }}</span>
                  <div class="muted" v-if="tab.chromeFps !== null">FPS: {{ Number(tab.chromeFps || 0).toFixed(1) }}</div>
                  <div class="muted" v-if="tab.streamRunning">
                    <span class="ok">streaming</span>
                  </div>
                </td>
                <td class="cmd-cell">
                  <div v-if="!tab.commandLog || !tab.commandLog.length" class="muted">-</div>
                  <div v-for="(cmd, ci) in (tab.commandLog || [])" :key="`tc_${ci}`" class="cmd-line">
                    <span class="cmd-ts">{{ formatCmdTs(cmd.ts) }}</span>
                    <span class="cmd-who">{{ cmd.whoName || cmd.who }}</span>
                    <span class="cmd-type">{{ cmd.type }}</span>
                    <span class="cmd-detail">{{ cmd.detail }}</span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>

          <!-- ===== User List ===== -->
          <div class="sub-section-title">Users</div>
          <table class="report-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Tabs</th>
                <th>Active Tab</th>
                <th>WS Status</th>
                <th>Stream</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!browser.users || browser.users.length === 0">
                <td colspan="5" class="empty-row">No connected users</td>
              </tr>
              <tr v-for="u in (browser.users || [])" :key="u.userId">
                <td>
                  <div class="user-badge">{{ u.username || u.userId }}</div>
                  <div class="muted">ID: {{ u.userId }}</div>
                </td>
                <td class="mono">{{ u.tabCount }}</td>
                <td>
                  <div>{{ u.activeTabTitle || '-' }}</div>
                  <div class="muted line-wrap text-ellipsis">{{ u.activeTabUrl || '-' }}</div>
                </td>
                <td>
                  <span :class="u.wsHealthy ? 'ok' : (u.wsConnected ? 'warn' : 'danger')">
                    {{ u.wsHealthy ? 'Healthy' : (u.wsConnected ? 'Degraded' : 'Disconnected') }}
                  </span>
                  <div class="muted" v-if="u.wsRttMs">RTT: {{ u.wsRttMs }}ms</div>
                  <div class="muted" v-if="u.connectedAt">Since: {{ formatCmdTs(u.connectedAt) }}</div>
                </td>
                <td>
                  <span :class="u.streamRunning ? 'ok' : 'muted'">
                    {{ u.streamRunning ? 'Running' : 'Stopped' }}
                  </span>
                  <div class="muted" v-if="u.chromeFps">FPS: {{ Number(u.chromeFps).toFixed(1) }}</div>
                </td>
              </tr>
            </tbody>
          </table>

          <!-- ===== Session Details (collapsible) ===== -->
          <details class="session-details">
            <summary class="sub-section-title clickable">Session Details ({{ (browser.sessions || []).length }})</summary>
            <table class="report-table">
              <thead>
                <tr>
                  <th>{{ t('adminReport.colUser') }}</th>
                  <th>{{ t('adminReport.colTabInfo') }}</th>
                  <th>{{ t('adminReport.colEndpointStatus') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="!browser.sessions || browser.sessions.length === 0">
                  <td colspan="3" class="empty-row">{{ t('adminReport.noSessions') }}</td>
                </tr>
                <tr v-for="session in (browser.sessions || [])" :key="session.sessionKey">
                  <td>
                    <div>{{ session.userId }}</div>
                    <div class="muted">{{ t('adminReport.tabsCount') }}: {{ session.tabCount }}</div>
                  </td>
                  <td class="tab-info-cell">
                    <div class="line-label">{{ t('adminReport.activeTab') }}</div>
                    <div class="line-wrap">{{ session.activeTab?.title || '-' }}</div>
                    <div class="muted line-wrap">{{ session.activeTab?.url || '-' }}</div>
                    <div class="muted">
                      <div class="line-label">{{ t('adminReport.tabChain') }}</div>
                      <div v-if="!buildTabChain(session).length">-</div>
                      <div v-for="(line, idx) in buildTabChain(session)" :key="`${session.sessionKey}_${idx}`" class="mono-line">{{ line }}</div>
                    </div>
                  </td>
                  <td class="endpoint-cell">
                    <div :class="statusClass(session.endpointStatus?.status)">
                      {{ formatEndpointStatus(session.endpointStatus?.status) }}
                    </div>
                    <div class="muted">
                      WS: {{ session.endpointStatus?.wsConnected ? 'ON' : 'OFF' }} |
                      WS RTT: {{ formatLatency(session.endpointStatus?.wsRttMs) }} |
                      {{ t('adminReport.gatewayChrome') }}: {{ session.endpointStatus?.gatewayToChromeOk ? 'OK' : 'ERR' }}
                    </div>
                    <div class="muted">
                      {{ t('adminReport.streamState') }}: {{ session.stream?.running ? t('adminReport.streamRunning') : t('adminReport.streamStopped') }}
                      | {{ t('adminReport.speed') }}: {{ formatBandwidth(session.endpointStatus?.speedBps || 0) }}
                      | {{ t('adminReport.latency') }}: {{ formatLatency(session.endpointStatus?.clientRttMs) }}
                      | Frame Delay: {{ formatLatency(session.endpointStatus?.frameDelayMs) }}
                    </div>
                    <div class="muted">
                      Frames: {{ session.stream?.framesSent || 0 }}
                      | Errors: {{ session.stream?.totalErrors || 0 }} (consec: {{ session.stream?.consecutiveErrors || 0 }})
                      | Timeouts: {{ session.stream?.captureTimeouts || 0 }}
                      | LastSuccess: {{ formatAge(session.stream?.lastSuccessAgeMs) }}
                    </div>
                    <div class="muted line-wrap">
                      {{ session.connection?.clientAddress || '-' }} / {{ session.connection?.endpoint || '-' }}
                    </div>
                    <div class="muted" v-if="session.endpointStatus?.reasons?.length">
                      reason: {{ session.endpointStatus.reasons.join(', ') }}
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </details>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { nextTick } from 'vue'
import api from '../utils/api'
import { useI18n } from '../i18n'

const { t } = useI18n()
const loading = ref(true)
const report = ref(null)
const autoRefresh = ref(true)
const refreshIntervalMs = ref(1000)
const hasLoadedOnce = ref(false)
let timer = null

const totalTabs = computed(() => {
  const list = report.value?.byBrowser || []
  return list.reduce((sum, item) => sum + Number(item.tabCount || 0), 0)
})

async function loadReport() {
  const scrollY = window.scrollY
  if (!hasLoadedOnce.value) loading.value = true
  try {
    const resp = await api.get('/api/admin/report')
    report.value = resp.data || null
    hasLoadedOnce.value = true
    await nextTick()
    window.scrollTo(0, scrollY)
  } catch (e) {
    console.error('Failed to load admin report:', e)
  } finally {
    loading.value = false
  }
}

function buildTabChain(session) {
  const list = session?.tabs || []
  if (!list.length) return []
  return list.map((tab) => {
    const ready = tab?.pageAlive ? 'ready' : 'not-ready'
    const alive = tab?.pageAlive ? 'alive' : 'dead'
    const title = String(tab?.title || 'New Tab')
    return `#${tab.index}: ${title}; targetId=${tab.targetId || '-'}; ${ready}; ${alive}`
  })
}

function resolveStreamingTab(session) {
  const streamTargetId = session?.stream?.streamTargetId || ''
  if (!streamTargetId) return '-'
  const tab = (session?.tabs || []).find((item) => item.targetId === streamTargetId)
  if (!tab) return `targetId=${streamTargetId}`
  return `#${tab.index} targetId=${streamTargetId}`
}

function statusClass(status) {
  if (status === 'ok') return 'ok'
  if (status === 'degraded') return 'warn'
  return 'danger'
}

function formatEndpointStatus(status) {
  if (status === 'ok') return t('adminReport.endpointOk')
  if (status === 'degraded') return t('adminReport.endpointDegraded')
  return t('adminReport.endpointDown')
}

function formatLatency(ms) {
  const n = Number(ms || 0)
  if (!n) return '-'
  return `${n} ms`
}

function toggleAutoRefresh() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (autoRefresh.value) {
    timer = setInterval(loadReport, Math.max(100, Number(refreshIntervalMs.value || 1000)))
  }
}

function formatBandwidth(bytesPerSec) {
  if (!bytesPerSec) return '0 B/s'
  if (bytesPerSec < 1024) return `${bytesPerSec} B/s`
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`
  return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`
}

function formatAge(ms) {
  const n = Number(ms || 0)
  if (!n) return '-'
  if (n < 1000) return `${n}ms`
  if (n < 60000) return `${(n / 1000).toFixed(1)}s`
  return `${(n / 60000).toFixed(1)}min`
}

function formatCmdTs(ts) {
  if (!ts) return '-'
  try {
    return ts.slice(11, 23) // HH:MM:SS.mmm
  } catch (_) {
    return ts
  }
}

onMounted(async () => {
  await loadReport()
  if (autoRefresh.value) timer = setInterval(loadReport, Math.max(100, Number(refreshIntervalMs.value || 1000)))
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<style scoped>
.admin-report-page { min-height: 100vh; }
.top-actions { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.auto-refresh { font-size: 13px; color: var(--text-secondary); }
.refresh-interval { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary); }
.refresh-interval select { border: 1px solid var(--border-color); border-radius: 6px; background: var(--card-bg); color: var(--text-primary); padding: 2px 6px; }
.stats-bar { display: flex; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.stat-item { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; padding: 10px 16px; min-width: 120px; text-align: center; }
.stat-value { font-size: 22px; font-weight: 700; }
.stat-label { color: var(--text-secondary); font-size: 12px; }
.sections { display: flex; flex-direction: column; gap: 12px; }
.section { padding: 12px; }
.section-head { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
.browser-name { font-size: 17px; font-weight: 700; }
.browser-meta { display: flex; gap: 8px; font-size: 12px; color: var(--text-secondary); margin-top: 4px; flex-wrap: wrap; }
.process-meta { display: flex; gap: 8px; font-size: 12px; margin-top: 6px; align-items: center; flex-wrap: wrap; }
.endpoints { font-size: 12px; color: var(--text-secondary); max-width: 60%; min-width: 320px; }
.endpoints code { word-break: break-all; }
.k { color: var(--text-primary); font-weight: 600; }
.report-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.report-table th, .report-table td { border-bottom: 1px solid var(--border-color); padding: 8px; text-align: left; vertical-align: top; }
.empty-row { text-align: center; color: var(--text-secondary); padding: 16px !important; }
.muted { color: var(--text-secondary); font-size: 12px; }
.ok { color: #2ecc71; font-weight: 600; }
.warn { color: #e67e22; font-weight: 600; }
.danger { color: #e74c3c; font-weight: 600; }
.ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 360px; }
.tab-info-cell { min-width: 360px; max-width: 520px; }
.endpoint-cell { min-width: 320px; }
.endpoint-cell .ellipsis { max-width: 420px; }
.line-label { color: var(--text-primary); font-weight: 600; margin-top: 2px; }
.line-wrap { white-space: normal; word-break: break-word; overflow-wrap: anywhere; }
.mono-line { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; white-space: normal; word-break: break-all; }
.full-id { white-space: normal; word-break: break-all; overflow-wrap: anywhere; }
.cmd-section { margin-top: 6px; padding: 4px 0; border-top: 1px dashed var(--border-color); }
.cmd-label { font-weight: 600; font-size: 11px; color: var(--text-primary); margin-bottom: 2px; }
.cmd-line { display: flex; gap: 6px; font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; line-height: 1.6; }
.cmd-ts { color: #888; flex-shrink: 0; min-width: 80px; }
.cmd-who { color: #9b59b6; font-weight: 600; flex-shrink: 0; min-width: 60px; }
.cmd-type { color: #4a9eff; font-weight: 600; flex-shrink: 0; min-width: 80px; }
.cmd-detail { color: var(--text-secondary); word-break: break-all; }
.cmd-cell { min-width: 260px; max-width: 400px; }
.sub-section-title { font-size: 14px; font-weight: 700; color: var(--text-primary); margin: 14px 0 6px; border-bottom: 1px solid var(--border-color); padding-bottom: 4px; }
.sub-section-title.clickable { cursor: pointer; user-select: none; }
.active-row { background: rgba(46, 204, 113, 0.06); }
.user-badge { display: inline-block; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 4px; padding: 1px 6px; font-size: 12px; font-weight: 600; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.text-ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 300px; }
.session-details { margin-top: 4px; }
.session-details summary { list-style: none; cursor: pointer; }
.session-details summary::-webkit-details-marker { display: none; }
.session-details summary::before { content: '▶ '; font-size: 10px; }
.session-details[open] summary::before { content: '▼ '; }
</style>
