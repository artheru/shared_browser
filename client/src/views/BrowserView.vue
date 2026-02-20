<template>
  <div class="browser-view-page" @click="focusStream">
    <!-- 顶部工具栏 -->
    <div class="toolbar" @click.stop @mousedown.stop>
      <div class="nav-buttons">
        <button class="nav-btn" @click="browserBack" :title="t('browserView.goBack')" :disabled="!isConnected || !canSendUserOperation">◀</button>
        <button class="nav-btn" @click="browserForward" :title="t('browserView.goForward')" :disabled="!isConnected || !canSendUserOperation">▶</button>
        <button
          class="nav-btn"
          :class="{ 'is-loading': isPageLoading }"
          @click="browserRefresh"
          :title="t('browserView.refresh')"
          :disabled="!isConnected || !canSendUserOperation"
        ><i :class="isPageLoading ? 'fa-solid fa-xmark' : 'fa-solid fa-rotate-right'"></i></button>
      </div>
      <div class="toolbar-center">
        <div class="url-wrapper" :class="{ 'is-loading-url': isPageLoading }">
          <input
            ref="urlInputRef"
            v-model="urlInput"
            type="text"
            class="url-input"
            :placeholder="t('browserView.urlPlaceholder')"
            :disabled="!canSendUserOperation"
            @keydown.enter.prevent="navigateToUrl"
            @focus="urlFocused = true"
            @blur="urlFocused = false"
          />
          <div v-if="isPageLoading" class="url-loading-bar"></div>
        </div>
        <button
          class="tool-icon-btn primary"
          :disabled="!canSendUserOperation"
          :title="t('browserView.go')"
          @click="navigateToUrl"
        ><i class="fa-solid fa-arrow-right"></i></button>
      </div>
      <div class="toolbar-right">
        <span
          class="status-dot"
          :class="{ connected: isConnected }"
          :title="isConnected ? t('browserView.connected') : t('browserView.connecting')"
        ></span>
        <span class="stats compact" :title="tr('browserView.statsTooltip2', 'Latency + decision (server): e.g. Q20x0.6')">
          <i class="fa-regular fa-clock"></i>{{ remoteDecision.latencyMs }}ms | {{ remoteDecision.text }} | SC {{ formatFps(remoteStream.screencastFps) }}
        </span>
        <span v-if="isConnected && bandwidth > 0" class="stats compact" :title="tr('browserView.streamBandwidth', 'Stream downlink bandwidth')">
          <i class="fa-solid fa-arrow-down"></i>{{ formatBandwidth(bandwidth) }}
        </span>
        <span v-if="isConnected && remoteNetwork.bytesPerSec > 0" class="stats remote-net compact" :title="t('browserView.remoteNetworkActivity')">
          <i class="fa-solid fa-network-wired"></i><i class="fa-solid fa-arrow-down"></i>{{ formatBandwidth(remoteNetwork.bytesPerSec) }}
        </span>
        <span v-if="isConnected && remoteNetwork.activeRequests > 0" class="active-badge compact" :title="t('browserView.remoteActiveRequests')">
          {{ remoteNetwork.activeRequests }}
        </span>
        <label v-if="isAiControlledBrowser && authStore.isAdmin" class="ai-override-toggle" :title="t('browserView.overrideAiOperationHint')">
          <input v-model="overrideAiOperation" type="checkbox" />
          <span class="ai-toggle-icon"><i :class="overrideAiOperation ? 'fa-solid fa-gamepad' : 'fa-solid fa-robot'"></i></span>
        </label>
        <span
          v-if="isAiControlledBrowser && !overrideAiOperation"
          class="ai-passive-icon"
          :title="t('browserView.aiReadOnlyMode')"
        ><i class="fa-solid fa-ban"></i></span>
        <button class="tool-icon-btn files-btn" :class="{ 'has-badge': hasFilesBadge }" @click="toggleFiles" :title="tr('browserView.files', 'Files', { count: filesDisplayCount })">
          <i class="fa-solid fa-folder"></i>
          <span class="files-count">{{ filesDisplayCount }}</span>
          <span v-if="hasFilesBadge" class="files-badge-dot"></span>
        </button>
        <span v-if="activeDownloads.length > 0" class="download-live-indicator compact" :title="t('browserView.downloadingHint')">
          <i class="fa-solid fa-download"></i>{{ activeDownloads.length }}
        </span>
        <button class="tool-icon-btn" @click="$router.push('/tools-help')" :title="t('common.help')">
          <i class="fa-solid fa-circle-question"></i>
        </button>
        <button
          v-if="isTouchDevice"
          class="tool-icon-btn mobile-kb-btn"
          :disabled="!isConnected || !canSendUserOperation"
          :title="tr('browserView.showMobileKeyboard', 'Keyboard')"
          @click="openMobileKeyboard"
        >
          <i class="fa-solid fa-keyboard"></i>
        </button>
        <button class="tool-icon-btn" @click="goBackToList" :title="tr('browserView.backToSelection', 'Back')">
          <i class="fa-solid fa-house"></i>
        </button>
        <button v-if="!isAiControlledBrowser || authStore.isAdmin" class="tool-icon-btn danger" @click="shutdownBrowser" :title="tr('browserView.shutdownBrowser', 'Shutdown')">
          <i class="fa-solid fa-power-off"></i>
        </button>
      </div>
    </div>

    <!-- H5 warning (policy / blocked navigation, etc.) -->
    <div v-if="policyNotice" class="policy-toast" @click.stop>
      <div class="policy-toast-left">
        <i class="fa-solid fa-shield-halved"></i>
      </div>
      <div class="policy-toast-body">
        <div class="policy-toast-title">{{ policyNotice.title }}</div>
        <div class="policy-toast-msg">{{ policyNotice.message }}</div>
      </div>
      <button class="policy-toast-close" type="button" @click="clearPolicyNotice" :title="t('common.close')">×</button>
    </div>

    <!-- Tab 栏 -->
    <div class="tab-bar">
      <div class="tab-list" ref="tabListRef">
        <div
          v-for="tab in tabs"
          :key="tab.tab_identifier || tab.tabIdentifier || tab.index"
          class="tab-item"
          :class="{
            active: tab.index === activeTabIndex,
            'has-dialog': tab.hasDialog,
            'not-ready': tab.isReady === false
          }"
          @mousedown.stop="switchTab(tab.index)"
        >
          <span class="tab-title" :title="tab.title + ' - ' + tab.url">
            {{ tab.title || 'New Tab' }}
          </span>
          <span
            v-if="tab.isReady === false"
            class="tab-ready-indicator"
            :title="t('browserView.tabNotReady')"
          ><i class="fa-solid fa-circle"></i></span>
          <span
            v-if="tab.hasDialog"
            class="tab-dialog-indicator"
            @click.stop="switchTab(tab.index)"
            :title="t('browserView.tabHasDialog')"
          ><i class="fa-solid fa-triangle-exclamation"></i></span>
          <button
            class="tab-close"
            @mousedown.stop
            @click.stop="closeTab(tab.index)"
            :disabled="!canSendUserOperation"
            :title="t('browserView.closeTab')"
          ><i class="fa-solid fa-xmark"></i></button>
        </div>
        <button
          class="tab-new-btn inline"
          :class="{ blocked: !canCreateTab || !canSendUserOperation }"
          :disabled="!canCreateTab || !canSendUserOperation"
          @click="createNewTab"
          :title="canSendUserOperation ? (canCreateTab ? t('browserView.newTab') : t('browserView.newTabBlocked')) : t('browserView.aiReadOnlyMode')"
        ><i class="fa-solid fa-plus"></i></button>
      </div>
    </div>

    <!-- 串流画面容器 -->
    <div
      ref="streamContainer"
      class="stream-container"
      tabindex="0"
      @mousedown="handleMouseDown"
      @mouseup="handleMouseUp"
      @mousemove="handleMouseMove"
      @wheel="handleWheel"
      @auxclick.prevent="handleAuxClick"
      @contextmenu.prevent="handleContextMenu"
      @dblclick="handleDoubleClick"
      @dragover.prevent="handleDragOver"
      @dragleave="handleDragLeave"
      @drop.prevent="handleDrop"
    >
      <img
        ref="streamImage"
        class="stream-image"
        :src="frameSrc"
        alt="Browser Stream"
        draggable="false"
      />
      <div v-if="showBlankHint" class="blank-hint-overlay">
        <div class="blank-hint-card">
          <div class="blank-hint-title">{{ t('browserView.blankPageTitle') }}</div>
          <div class="blank-hint-sub">{{ t('browserView.blankPageTip') }}</div>
          <div class="blank-hint-url">{{ currentTabUrl || 'about:blank' }}</div>
        </div>
      </div>
      <div
        class="remote-cursor"
        :class="{ pressing: remoteCursor.button !== 'none' }"
        :style="remoteCursorStyle"
      ></div>
      <div v-if="!isConnected && !streamError" class="connecting-overlay">
        <div class="connecting-spinner"></div>
        <p>{{ t('browserView.connectingToBrowser') }}</p>
      </div>

      <!-- Error overlay -->
      <div v-if="streamError" class="error-overlay">
        <div class="error-content">
          <span class="error-icon"><i class="fa-solid fa-triangle-exclamation"></i></span>
          <p class="error-message">{{ streamError }}</p>
          <button class="btn btn-primary btn-sm" @click="retryConnect">
            {{ t('browserView.reconnect') }}
          </button>
        </div>
      </div>

      <!-- Drag-and-drop overlay -->
      <div v-if="isDragging" class="drag-overlay">
        <div class="drag-content">
          <span class="drag-icon">📁</span>
          <p>{{ t('browserView.dropFilesHere') }}</p>
        </div>
      </div>

      <!-- Dialog overlay -->
      <div v-if="pendingDialog" class="dialog-overlay">
        <div class="dialog-box">
          <div class="dialog-header">
            {{ pendingDialog.dialogType === 'alert' ? t('browserView.dialogAlert') :
               pendingDialog.dialogType === 'confirm' ? t('browserView.dialogConfirm') : t('browserView.dialogPrompt') }}
          </div>
          <div class="dialog-message">{{ pendingDialog.message }}</div>
          <input
            v-if="pendingDialog.dialogType === 'prompt'"
            v-model="dialogPromptInput"
            type="text"
            class="dialog-input"
            :placeholder="pendingDialog.defaultValue || ''"
            @keyup.enter="respondDialog(true)"
          />
          <div class="dialog-actions">
            <button
              v-if="pendingDialog.dialogType !== 'alert'"
              class="btn btn-secondary btn-sm"
              @click="respondDialog(false)"
            >{{ t('common.cancel') }}</button>
            <button
              class="btn btn-primary btn-sm"
              @click="respondDialog(true)"
            >{{ t('common.confirm') }}</button>
          </div>
        </div>
      </div>
    </div>

    <!-- WS Debug panel removed -->

    <!-- Files panel -->
    <div v-if="showFiles" class="files-panel">
      <div class="files-header">
        <h3>{{ t('browserView.downloadedFiles') }}</h3>
        <div class="files-head-actions">
          <button class="btn btn-danger btn-sm" @click="removeAllFiles" :disabled="downloadFiles.length === 0">
            {{ tr('browserView.removeAll', 'Delete All') }}
          </button>
          <button class="modal-close" @click="showFiles = false">&times;</button>
        </div>
      </div>
      <div v-if="downloadNotice" class="download-notice">{{ downloadNotice }}</div>
      <div class="files-list">
        <div v-for="active in activeDownloads" :key="active.guid" class="file-item downloading">
          <div class="file-left">
            <div class="file-name-row">
              <span class="file-status spinner" :title="t('browserView.downloadingUnknown')"></span>
              <span class="file-name">{{ active.filename || t('browserView.downloadingUnknown') }}</span>
            </div>
            <div class="file-meta">
              <span>{{ formatSize(active.receivedBytes || 0) }} / {{ active.totalBytes ? formatSize(active.totalBytes) : '?' }}</span>
              <span>{{ active.progress }}%</span>
            </div>
            <div class="file-progress-wrap">
              <div class="file-progress-bar" :style="{ width: active.progress + '%' }"></div>
            </div>
          </div>
          <div class="file-actions vertical">
            <button class="icon-btn cancel" :title="t('browserView.cancelDownload')" @click="cancelDownload(active.guid)">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>
        </div>
        <div v-if="downloadFiles.length === 0 && activeDownloads.length === 0" class="empty-files">
          {{ t('browserView.noFiles') }}
        </div>
        <div v-for="file in downloadFiles" :key="file.name" class="file-item">
          <div class="file-left">
            <div class="file-name-row">
              <span class="file-name">{{ file.name }}</span>
            </div>
            <div class="file-meta">
              <span class="file-done-meta">✓ {{ formatFileTime(file.mtime) }}</span>
              <span>{{ formatSize(file.size) }}</span>
            </div>
          </div>
          <div class="file-actions vertical">
            <a :href="getDownloadUrl(file.name)" class="icon-btn download" :title="t('common.download')" download>
              <i class="fa-solid fa-download"></i>
            </a>
            <button class="icon-btn delete" :title="t('common.delete')" @click="deleteFile(file.name)">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        </div>
      </div>
      <div class="files-footer">
        <input
          ref="fileInput"
          type="file"
          style="display: none"
          @change="handleFileSelect"
        />
        <button class="btn btn-secondary" @click="$refs.fileInput.click()">
          {{ t('browserView.uploadFile') }}
        </button>
      </div>
    </div>

    <!-- File chooser prompt -->
    <div v-if="showFileChooser" class="modal-overlay">
      <div class="modal">
        <div class="modal-header">
          <h3>{{ t('browserView.selectFileUpload') }}</h3>
        </div>
        <p>{{ t('browserView.remoteRequestsFile') }}</p>
        <div class="modal-footer">
          <button class="btn btn-secondary" @click="cancelFileChooser">{{ t('common.cancel') }}</button>
          <button class="btn btn-primary" @click="triggerFileUpload">{{ t('browserView.selectFile') }}</button>
        </div>
      </div>
    </div>
    <textarea
      ref="mobileKeyboardInputRef"
      class="mobile-keyboard-bridge"
      autocapitalize="off"
      autocomplete="off"
      autocorrect="off"
      spellcheck="false"
      @input="handleMobileKeyboardInput"
      @keydown="handleMobileKeyboardKeyDown"
    ></textarea>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, computed, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../utils/api'
import { useI18n } from '../i18n'
import { useAuthStore } from '../stores/auth'

const { t } = useI18n()
const authStore = useAuthStore()
const tr = (key, fallback = '', params = undefined) => {
  const value = t(key, params)
  if (value === key) return fallback || key
  return value
}

const route = useRoute()
const router = useRouter()

const browserId = computed(() => route.params.id)
const browserConfig = ref(null)
const browserConfigLoaded = ref(false)
const overrideAiOperation = ref(false)
const isAiControlledBrowser = computed(() => !!(browserConfig.value && (browserConfig.value.mcpEnabled || browserConfig.value.webApiEnabled)))
const canSendUserOperation = computed(() => {
  if (!browserConfigLoaded.value) return false
  if (!browserConfig.value) return true
  if (!isAiControlledBrowser.value) return true
  // AI browser: only admin can override, and must toggle the override switch
  if (!authStore.isAdmin) return false
  return overrideAiOperation.value
})

// WebSocket 和连接状态
let ws = null
let manualClose = false
const isConnected = ref(false)
let everConnected = false
let wsConnectFailStreak = 0
let wsHandshakeTimer = null
let wsOpenTimer = null
const streamContainer = ref(null)
const streamImage = ref(null)
const urlInputRef = ref(null)
const urlFocused = ref(false)
const isTouchDevice = ref(false)
const mobileKeyboardInputRef = ref(null)
let mobileKeyboardBuffer = ''
const policyNotice = ref(null)
let policyNoticeTimer = null

// 串流画面
const frameSrc = ref('')
const fps = ref(0)
const quality = ref(80)

// URL 输入
const urlInput = ref('')

// Tab 管理
const tabs = ref([])
const activeTabIndex = ref(0)

// 对话框
const pendingDialog = ref(null)
const dialogPromptInput = ref('')

// 文件相关
const showFiles = ref(false)
const downloadFiles = ref([])
const activeDownloads = ref([])
const downloadNotice = ref('')
const hasFilesBadge = ref(false)
const hasLoadedFilesBaseline = ref(false)
const filesDisplayCount = computed(() => downloadFiles.value.length + activeDownloads.value.length)
const showFileChooser = ref(false)
const fileInput = ref(null)
const pendingFileUpload = ref(false)

// Tab 列表容器
const tabListRef = ref(null)

// 拖拽状态
const isDragging = ref(false)

// 串流/浏览器错误
const streamError = ref('')
const remoteCursor = ref({ visible: false, x: 0, y: 0, button: 'none', updatedAt: 0 })
const remoteCursorStyle = ref({ display: 'none' })

// 页面加载状态
const isPageLoading = ref(false)
const creatingTab = ref(false)
const hasPendingUnreadyTabs = computed(() => tabs.value.some((tab) => tab && tab.isReady === false))
const canCreateTab = computed(() => isConnected.value && !isPageLoading.value && !creatingTab.value && !hasPendingUnreadyTabs.value)
const currentTabUrl = computed(() => tabs.value[activeTabIndex.value]?.url || urlInput.value || '')
const showBlankHint = computed(() => {
  if (!isConnected.value || streamError.value) return false
  const url = String(currentTabUrl.value || '')
  return url === 'about:blank' || url.startsWith('chrome-error://')
})

// 带宽统计
const bandwidth = ref(0)      // bytes per second (stream)
let bytesThisSecond = 0
let lastBandwidthCalc = Date.now()

// 远程浏览器网络统计
const remoteNetwork = ref({
  activeRequests: 0,
  totalBytes: 0,
  requestCount: 0,
  bytesPerSec: 0,
  reqPerSec: 0
})
const remoteStream = ref({
  latencyMs: 0,
  quality: 0,
  scale: 1,
  decision: '',
  screencastFps: 0,
  allowedLatencyMs: 0
})
const remoteDecision = computed(() => {
  const latencyMs = Math.max(0, Number(remoteStream.value.latencyMs || 0))
  const q = Number(remoteStream.value.quality || quality.value || 0)
  const scale = Number(remoteStream.value.scale || 1)
  const text = (remoteStream.value.decision && String(remoteStream.value.decision).trim())
    ? String(remoteStream.value.decision).trim()
    : `Q${q}x${formatScale(scale)}`
  return { latencyMs: latencyMs || Math.max(0, Math.round(streamLatencyMs || 0)), text }
})

// 虚拟剪贴板（HTTP 环境 fallback）
const virtualClipboard = ref('')

// 统计
let frameCount = 0
let lastFpsUpdate = Date.now()
let pendingFrames = 0
let lastFrameAt = 0
let reconnectTimer = null
let reconnectAttempts = 0
let streamWatchTimer = null
let tabSyncTimer = null
let filesSyncTimer = null
let wsDebugTimer = null
let lastMouseMoveSentAt = 0
let lastFrameHealthLogAt = 0
let lastTabSnapshot = ''
let currentFrameServerTs = 0
let streamLatencyMs = 0
let noFrameWarnStreak = 0
let lastRecoverRequestAt = 0
let streamErrorTimer = null
let firstFrameTimer = null

// 反馈计时器
let feedbackTimer = null

const wsDebug = ref({
  readyStateText: 'INIT',
  lastRxAt: 0,
  lastTxAt: 0,
  lastPongAt: 0,
  lastRxType: '',
  lastTxType: '',
  rxCount: 0,
  txCount: 0,
  events: []
})

// 鼠标按下追踪（确保 mouseup 只在 mousedown 来自串流区域时才发送）
let mouseDownInStream = false

// Stream source resolution (server-side virtual coordinates)
const STREAM_W = 1280
const STREAM_H = 720
const STREAM_ASPECT = STREAM_W / STREAM_H

// 聚焦到串流区域（只在点击串流容器内部时触发，不从工具栏/标签栏抢焦点）
function focusStream(event) {
  if (!streamContainer.value) return
  // 只有点击发生在串流容器内时才聚焦
  if (!streamContainer.value.contains(event.target)) return
  if (event.target.tagName !== 'INPUT' && event.target.tagName !== 'BUTTON' &&
      event.target.tagName !== 'A') {
    streamContainer.value.focus()
    // Desktop: keep a hidden textarea focused so IME/composition input works reliably.
    // Touch devices rely on an explicit "Keyboard" button to avoid unwanted OSK popups.
    if (!isTouchDevice.value) {
      focusTextBridge(false)
    }
  }
}

function goBackToList() {
  manualClose = true
  if (ws) {
    ws.close()
  }
  router.push('/')
}

function openMobileKeyboard() {
  if (!isConnected.value) return
  if (!canSendUserOperation.value) return
  focusTextBridge(true)
}

function focusTextBridge(selectEnd = false) {
  const el = mobileKeyboardInputRef.value
  if (!el) return
  // preventScroll is best-effort; older browsers may ignore it.
  try { el.focus({ preventScroll: true }) } catch (_) { el.focus() }
  if (selectEnd && typeof el.setSelectionRange === 'function') {
    const len = el.value.length
    try { el.setSelectionRange(len, len) } catch (_) {}
  }
}

function showPolicyNotice(title, message, { ttlMs = 4500 } = {}) {
  policyNotice.value = { title: String(title || ''), message: String(message || '') }
  if (policyNoticeTimer) clearTimeout(policyNoticeTimer)
  policyNoticeTimer = setTimeout(() => {
    policyNoticeTimer = null
    policyNotice.value = null
  }, ttlMs)
}

function clearPolicyNotice() {
  if (policyNoticeTimer) clearTimeout(policyNoticeTimer)
  policyNoticeTimer = null
  policyNotice.value = null
}

function updateTouchMode() {
  const coarsePointer = !!window.matchMedia?.('(pointer: coarse)').matches
  isTouchDevice.value = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0) || coarsePointer || window.innerWidth <= 900
}

async function loadBrowserConfig() {
  try {
    const response = await api.get(`/api/browsers/${browserId.value}`)
    browserConfig.value = response.data || null
  } catch (e) {
    console.error('Failed to load browser config:', e)
    browserConfig.value = null
  } finally {
    browserConfigLoaded.value = true
  }
}

function shutdownBrowser() {
  manualClose = true
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'shutdown_browser' }))
    setTimeout(() => {
      ws?.close()
      router.push('/')
    }, 250)
    return
  }
  router.push('/')
}

// ==================== 浏览器导航 ====================

function browserBack() {
  if (!canSendUserOperation.value) return
  if (ws && ws.readyState === WebSocket.OPEN) {
    isPageLoading.value = true
    ws.send(JSON.stringify({ type: 'go_back' }))
  }
}

function browserForward() {
  if (!canSendUserOperation.value) return
  if (ws && ws.readyState === WebSocket.OPEN) {
    isPageLoading.value = true
    ws.send(JSON.stringify({ type: 'go_forward' }))
  }
}

function browserRefresh() {
  if (!canSendUserOperation.value) return
  if (ws && ws.readyState === WebSocket.OPEN) {
    if (isPageLoading.value) {
      // 正在加载时点击 → 停止加载
      ws.send(JSON.stringify({ type: 'stop_loading' }))
      isPageLoading.value = false
    } else {
      isPageLoading.value = true
      ws.send(JSON.stringify({ type: 'refresh' }))
    }
  }
}

// ==================== WebSocket 连接 ====================

function connect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = `${protocol}//${window.location.host}/ws`

  ws = new WebSocket(wsUrl)

  // Some environments may keep WS in CONNECTING without firing error/close promptly.
  // Guard this to avoid infinite blank "connecting..." screen.
  if (wsOpenTimer) clearTimeout(wsOpenTimer)
  wsOpenTimer = setTimeout(() => {
    if (manualClose) return
    if (!ws) return
    if (ws.readyState !== WebSocket.CONNECTING) return
    streamError.value = tr('browserView.wsConnectFailed', 'Connection failed. Please refresh or re-login.')
    try { ws.close() } catch (_) {}
  }, 5000)
  const rawSend = ws.send.bind(ws)
  ws.send = (payload) => {
    let type = 'binary'
    if (typeof payload === 'string') {
      try {
        const msg = JSON.parse(payload)
        type = msg?.type || 'json'
      } catch (_) {
        type = 'text'
      }
    }
    pushWsEvent('tx', type)
    return rawSend(payload)
  }

  ws.onopen = () => {
    console.log('WebSocket connected')
    pushWsEvent('state', 'open')
    reconnectAttempts = 0
    streamError.value = ''
    if (wsOpenTimer) {
      clearTimeout(wsOpenTimer)
      wsOpenTimer = null
    }
    const token = localStorage.getItem('token')
    ws.send(JSON.stringify({ type: 'auth', token }))

    // If we cannot complete handshake (auth -> connect -> connected) within a short window,
    // show a visible error and force reconnect instead of endless blank "connecting...".
    if (wsHandshakeTimer) clearTimeout(wsHandshakeTimer)
    wsHandshakeTimer = setTimeout(() => {
      if (manualClose) return
      if (isConnected.value) return
      streamError.value = tr('browserView.wsConnectFailed', 'Connection failed. Please refresh or re-login.')
      try { ws?.close() } catch (_) {}
    }, 7000)
  }

  ws.onmessage = async (event) => {
    if (typeof event.data === 'string') {
      const message = JSON.parse(event.data)
      pushWsEvent('rx', message?.type || 'json')
      handleMessage(message)
    } else {
      pushWsEvent('rx', 'frame-binary')
      handleFrame(event.data)
    }
  }

  ws.onclose = () => {
    console.log('WebSocket closed')
    pushWsEvent('state', 'close')
    isConnected.value = false
    if (wsOpenTimer) {
      clearTimeout(wsOpenTimer)
      wsOpenTimer = null
    }
    if (wsHandshakeTimer) {
      clearTimeout(wsHandshakeTimer)
      wsHandshakeTimer = null
    }
    if (!manualClose) {
      // If we never managed to fully connect to a browser session after several retries,
      // show a visible error instead of endless "connecting..." blank screen.
      wsConnectFailStreak += 1
      if (wsConnectFailStreak >= 3) {
        streamError.value = tr('browserView.wsConnectFailed', 'Connection failed. Please refresh or re-login.')
      }
      scheduleReconnect()
    }
  }

  ws.onerror = (error) => {
    console.error('WebSocket error:', error)
    pushWsEvent('state', 'error', error?.message || '')
  }
}

function scheduleReconnect() {
  if (manualClose || reconnectTimer) return
  reconnectAttempts += 1
  const delay = Math.min(1000 * Math.pow(2, Math.max(0, reconnectAttempts - 1)), 5000)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, delay)
}

function handleMessage(message) {
  switch (message.type) {
    case 'auth_ok':
      ws.send(JSON.stringify({ type: 'connect', browserId: browserId.value }))
      break

    case 'connected':
      isConnected.value = true
      everConnected = true
      wsConnectFailStreak = 0
      if (wsHandshakeTimer) {
        clearTimeout(wsHandshakeTimer)
        wsHandshakeTimer = null
      }
      lastFrameAt = Date.now()
      startFeedback()
      loadFiles()
      loadActiveDownloads()
      sendTabListRequest('connected-init', true)
      // If we don't get the first frame quickly, ask server to recover stream.
      if (firstFrameTimer) clearTimeout(firstFrameTimer)
      firstFrameTimer = setTimeout(() => {
        if (!isConnected.value) return
        if (frameSrc.value) return
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'stream_recover', reason: 'first-frame-timeout', idleMs: Date.now() - lastFrameAt }))
          pushWsEvent('tx', 'stream_recover', 'first-frame-timeout')
        }
      }, 2500)
      break

    case 'ws_ping':
      wsDebug.value.lastPongAt = Date.now()
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'ws_pong',
          serverTs: Number(message.serverTs || 0),
          clientTs: Date.now()
        }))
      }
      break

    case 'frame':
      quality.value = message.quality
      currentFrameServerTs = Number(message.timestamp || 0)
      pendingFrames++
      break

    case 'shutdown_done':
      if (ws) ws.close()
      router.push('/')
      break

    case 'tabs_updated':
      tabs.value = normalizeTabs(message.tabs || [])
      creatingTab.value = !!message.creatingTab
      activeTabIndex.value = Math.min(
        Math.max(0, Number(message.activeIndex || 0)),
        Math.max(0, tabs.value.length - 1)
      )
      // 更新 URL 输入框显示当前 tab 的 URL
      if (tabs.value.length > 0 && tabs.value[activeTabIndex.value]) {
        const currentUrl = tabs.value[activeTabIndex.value].url
        if (currentUrl && currentUrl !== 'about:blank' && !urlFocused.value) {
          urlInput.value = currentUrl
        }
      }
      // 页面导航完成，清除加载状态
      isPageLoading.value = false
      logTabSnapshot('tabs_updated')
      break

    case 'tab_switched':
      activeTabIndex.value = message.activeIndex
      if (tabs.value.length > 0 && tabs.value[activeTabIndex.value]) {
        const currentUrl = tabs.value[activeTabIndex.value].url
        if (currentUrl && !urlFocused.value) {
          urlInput.value = currentUrl
        }
      }
      // 清除对话框（如果切换到的 tab 没有对话框）
      checkDialogState()
      break

    case 'dialog_opened':
      pendingDialog.value = {
        tabIndex: message.tabIndex,
        dialogType: message.dialogType,
        message: message.message,
        defaultValue: message.defaultValue
      }
      dialogPromptInput.value = message.defaultValue || ''
      // 如果对话框在非活跃 tab，自动切换
      if (message.tabIndex !== activeTabIndex.value) {
        switchTab(message.tabIndex)
      }
      break

    case 'clipboard_content':
      // 收到复制的文本，保存到虚拟剪贴板并尝试写入系统剪贴板
      if (message.text) {
        virtualClipboard.value = message.text
        writeToClipboard(message.text)
      }
      break

    case 'file_chooser':
      showFileChooser.value = true
      break

    case 'download_ready':
      // Auto-download: trigger browser download immediately
      autoDownloadFile(message.filename)
      // Keep file list/count in sync even when browser blocks auto-download UI.
      activeDownloads.value = activeDownloads.value.filter((x) => x.filename !== message.filename)
      downloadNotice.value = t('browserView.downloadReadyNotice', { filename: message.filename })
      showFiles.value = true
      hasFilesBadge.value = true
      loadActiveDownloads()
      setTimeout(() => {
        if (downloadNotice.value === t('browserView.downloadReadyNotice', { filename: message.filename })) {
          downloadNotice.value = ''
        }
      }, 2600)
      loadFiles()
      break

    case 'download_progress':
      handleDownloadProgress(message)
      break

    case 'stream_error':
      console.error('[SB][stream] stream_error', {
        reason: message.reason,
        message: message.message,
        detail: message.detail,
        diagnostics: message.diagnostics
      })
      if (message.reason === 'too_many_errors' ||
          message.reason === 'page_closed' ||
          message.reason === 'browser_disconnected') {
        if (streamErrorTimer) clearTimeout(streamErrorTimer)
        streamErrorTimer = setTimeout(() => {
          streamError.value = message.message || t('browserView.streamError')
        }, 1600)
      } else {
        streamError.value = message.message || t('browserView.streamError')
      }
      break

    case 'browser_crashed':
      console.warn('Browser crashed:', message.message)
      streamError.value = message.message || t('browserView.browserCrashed')
      isConnected.value = false
      break

    case 'browser_restarted':
      console.log('Browser restarted:', message.message)
      streamError.value = message.message || t('browserView.browserRestarted')
      // 自动重新连接
      setTimeout(() => {
        window.location.reload()
      }, 2000)
      break

    case 'browser_restart_failed':
      console.error('Browser restart failed:', message.message)
      streamError.value = message.message || t('browserView.browserRestartFailed')
      break

    case 'stream_recovered':
      console.info('[SB][stream] stream_recovered')
      if (streamErrorTimer) {
        clearTimeout(streamErrorTimer)
        streamErrorTimer = null
      }
      streamError.value = ''
      break

    case 'domain_blocked':
      isPageLoading.value = false
      if (message.blockedUrl && !urlFocused.value) {
        urlInput.value = message.blockedUrl
      }
      console.warn('[SB][policy] blocked by domain restrictions', {
        blockedUrl: message.blockedUrl,
        allowedDomains: message.allowedDomains || []
      })
      showPolicyNotice(
        tr('browserView.policyBlockedTitle', 'Blocked'),
        tr('browserView.policyBlockedMessage', 'Blocked navigation: {url}', { url: message.blockedUrl || '' }),
        { ttlMs: 6500 }
      )
      break

    case 'network_stats':
      if (message.network) {
        remoteNetwork.value = message.network
      }
      if (message.stream) {
        remoteStream.value = {
          latencyMs: Number(message.stream.latencyMs || 0),
          quality: Number(message.stream.quality || 0),
          scale: Number(message.stream.scale || 1),
          decision: String(message.stream.decision || ''),
          screencastFps: Number(message.stream.screencastFps || 0),
          allowedLatencyMs: Number(message.stream.allowedLatencyMs || 0)
        }
      }
      break

    case 'remote_cursor':
      remoteCursor.value = {
        visible: true,
        x: Number(message.x || 0),
        y: Number(message.y || 0),
        button: message.button || 'none',
        updatedAt: Date.now()
      }
      updateRemoteCursorOverlay()
      break

    case 'error':
      console.error('Server error:', message.error)
      streamError.value = message.error || streamError.value
      break
  }
}

function normalizeTabs(rawTabs) {
  const unique = new Map()
  for (const tab of rawTabs || []) {
    const id = tab.tab_identifier || tab.tabIdentifier || `${tab.index || 0}_${tab.url || 'about:blank'}`
    if (unique.has(id)) continue
    unique.set(id, {
      ...tab,
      tab_identifier: id,
      tabIdentifier: id,
      isReady: tab.isReady !== false
    })
  }
  return Array.from(unique.values())
}

function checkDialogState() {
  // 检查当前活跃 tab 是否有对话框
  if (pendingDialog.value) {
    const dialogTab = pendingDialog.value.tabIndex
    const currentTab = tabs.value[activeTabIndex.value]
    if (currentTab && !currentTab.hasDialog) {
      // 当前 tab 没有对话框了
      pendingDialog.value = null
    }
  }
}

function handleFrame(data) {
  if (firstFrameTimer) {
    clearTimeout(firstFrameTimer)
    firstFrameTimer = null
  }
  const blob = new Blob([data], { type: 'image/jpeg' })
  const url = URL.createObjectURL(blob)

  if (frameSrc.value) {
    URL.revokeObjectURL(frameSrc.value)
  }

  frameSrc.value = url
  lastFrameAt = Date.now()
  noFrameWarnStreak = 0
  frameCount++
  pendingFrames = Math.max(0, pendingFrames - 1)
  if (streamError.value) streamError.value = ''
  if (isPageLoading.value) isPageLoading.value = false
  updateRemoteCursorOverlay()

  // 带宽统计
  const dataSize = data.size || data.byteLength || 0
  bytesThisSecond += dataSize

  const now = Date.now()
  if (currentFrameServerTs > 0) {
    const sampleLatency = Math.max(0, now - currentFrameServerTs)
    streamLatencyMs = streamLatencyMs <= 0
      ? sampleLatency
      : Math.round(streamLatencyMs * 0.7 + sampleLatency * 0.3)
  }
  if (now - lastFpsUpdate >= 1000) {
    fps.value = frameCount
    frameCount = 0
    lastFpsUpdate = now

    // 更新带宽
    bandwidth.value = bytesThisSecond
    bytesThisSecond = 0
    lastBandwidthCalc = now
  }

  if (now - lastFrameHealthLogAt >= 5000) {
    const idleMs = now - lastFrameAt
    console.info('[SB][stream] frame-health', {
      fps: fps.value,
      quality: quality.value,
      pendingFrames,
      bandwidth: bandwidth.value,
      streamLatencyMs,
      idleMs,
      tabs: tabs.value.length,
      activeTabIndex: activeTabIndex.value
    })
    lastFrameHealthLogAt = now
  }
}

function updateRemoteCursorOverlay() {
  if (!remoteCursor.value.visible || !streamContainer.value || !streamImage.value || !frameSrc.value) {
    remoteCursorStyle.value = { display: 'none' }
    return
  }

  if (Date.now() - remoteCursor.value.updatedAt > 5000) {
    remoteCursorStyle.value = { display: 'none' }
    return
  }

  const containerRect = streamContainer.value.getBoundingClientRect()
  const contentRect = getStreamContentRect()
  if (!contentRect || !contentRect.width || !contentRect.height) {
    remoteCursorStyle.value = { display: 'none' }
    return
  }

  const left = (remoteCursor.value.x / STREAM_W) * contentRect.width + (contentRect.left - containerRect.left)
  const top = (remoteCursor.value.y / STREAM_H) * contentRect.height + (contentRect.top - containerRect.top)
  remoteCursorStyle.value = {
    display: 'block',
    left: `${left}px`,
    top: `${top}px`
  }
}

function startFeedback() {
  feedbackTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'feedback',
        data: {
          fps: fps.value,
          pendingFrames: pendingFrames,
          rtt: streamLatencyMs > 0 ? streamLatencyMs : 0
        }
      }))
    }
  }, 1000)
}

// ==================== 重新连接 ====================

function retryConnect() {
  streamError.value = ''
  manualClose = false
  if (ws) ws.close()
  connect()
}

// ==================== Tab 操作 ====================

function switchTab(index) {
  if (!canSendUserOperation.value) return
  if (index === activeTabIndex.value) return
  if (ws && ws.readyState === WebSocket.OPEN) {
    isPageLoading.value = true
    ws.send(JSON.stringify({ type: 'tab_switch', tabIndex: index }))
    setTimeout(() => sendTabListRequest('tab-switch-immediate', true), 120)
  }
}

function createNewTab() {
  if (!canSendUserOperation.value) return
  if (!canCreateTab.value) return
  if (ws && ws.readyState === WebSocket.OPEN) {
    isPageLoading.value = true
    ws.send(JSON.stringify({ type: 'tab_new' }))
  }
}

function closeTab(index) {
  if (!canSendUserOperation.value) return
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'tab_close', tabIndex: index }))
  }
}

// ==================== 对话框响应 ====================

function respondDialog(accept) {
  if (!canSendUserOperation.value) return
  if (!pendingDialog.value) return
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'tab_dialog_respond',
      tabIndex: pendingDialog.value.tabIndex,
      accept,
      promptText: pendingDialog.value.dialogType === 'prompt' ? dialogPromptInput.value : undefined
    }))
  }
  pendingDialog.value = null
  dialogPromptInput.value = ''
}

// ==================== 鼠标坐标转换 ====================

function getStreamContentRect() {
  const img = streamImage.value
  if (!img) return null
  const rect = img.getBoundingClientRect()
  const boxW = rect.width || 0
  const boxH = rect.height || 0
  if (boxW <= 1 || boxH <= 1) return null

  // Because the <img> box is stretched to 100% of the container while using object-fit: contain,
  // the "real video content" is letterboxed inside the element box. We must compute that content box
  // to map pointer coordinates correctly.
  const boxAspect = boxW / boxH
  let contentW = boxW
  let contentH = boxH
  let offsetX = 0
  let offsetY = 0

  if (boxAspect > STREAM_ASPECT) {
    // Wider than stream: pillarbox (left/right bars)
    contentH = boxH
    contentW = boxH * STREAM_ASPECT
    offsetX = (boxW - contentW) / 2
  } else {
    // Taller than stream: letterbox (top/bottom bars)
    contentW = boxW
    contentH = boxW / STREAM_ASPECT
    offsetY = (boxH - contentH) / 2
  }

  return {
    left: rect.left + offsetX,
    top: rect.top + offsetY,
    width: contentW,
    height: contentH
  }
}

function getRelativeCoords(event, options = {}) {
  const allowOutside = !!options.allowOutside
  const contentRect = getStreamContentRect()
  if (!contentRect) return null

  let localX = event.clientX - contentRect.left
  let localY = event.clientY - contentRect.top

  const outside = localX < 0 || localY < 0 || localX > contentRect.width || localY > contentRect.height
  if (outside && !allowOutside) {
    // Clicking on the black bars should not send input to the remote browser.
    return null
  }

  // When dragging, clamp to the content bounds so mouseup still lands correctly.
  localX = Math.max(0, Math.min(contentRect.width, localX))
  localY = Math.max(0, Math.min(contentRect.height, localY))

  const scaleX = STREAM_W / contentRect.width
  const scaleY = STREAM_H / contentRect.height

  return {
    x: Math.max(0, Math.min(STREAM_W, Math.round(localX * scaleX))),
    y: Math.max(0, Math.min(STREAM_H, Math.round(localY * scaleY)))
  }
}

function sendInput(event) {
  if (!canSendUserOperation.value) return
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input', event }))
  }
}

// ==================== 鼠标事件 ====================

function handleMouseMove(event) {
  if (!isConnected.value) return
  const now = performance.now()
  if (now - lastMouseMoveSentAt < 16) return
  lastMouseMoveSentAt = now
  const coords = getRelativeCoords(event, { allowOutside: mouseDownInStream })
  if (!coords) return
  const { x, y } = coords
  sendInput({ type: 'mousemove', x, y })
}

function handleMouseDown(event) {
  if (!isConnected.value) return
  // Ensure the hidden text bridge is focused before typing (desktop).
  if (!isTouchDevice.value) {
    focusTextBridge(false)
  }
  if (event.button === 1) event.preventDefault()
  mouseDownInStream = true
  const coords = getRelativeCoords(event, { allowOutside: false })
  if (!coords) {
    mouseDownInStream = false
    return
  }
  const { x, y } = coords
  sendInput({ type: 'mousedown', x, y, button: event.button })
}

function handleMouseUp(event) {
  if (!isConnected.value) return
  // 只有当 mousedown 发生在串流区域时才发送 mouseup
  if (!mouseDownInStream) return
  mouseDownInStream = false
  const coords = getRelativeCoords(event, { allowOutside: true })
  if (!coords) return
  const { x, y } = coords
  sendInput({ type: 'mouseup', x, y, button: event.button })
  if (event.button === 1) {
    // 中键打开新标签时主动拉取一次 tab 列表，避免 UI 不刷新
    setTimeout(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        sendTabListRequest('middle-click-up', false)
      }
    }, 250)
  }
}

function handleAuxClick(event) {
  if (!isConnected.value) return
  if (event.button !== 1) return
  event.preventDefault()
}

function handleWheel(event) {
  if (!isConnected.value) return
  event.preventDefault()
  const coords = getRelativeCoords(event, { allowOutside: mouseDownInStream })
  if (!coords) return
  const { x, y } = coords
  sendInput({ type: 'wheel', x, y, deltaX: event.deltaX, deltaY: event.deltaY })
}

function handleContextMenu(event) {
  if (!isConnected.value) return
  const coords = getRelativeCoords(event, { allowOutside: false })
  if (!coords) return
  const { x, y } = coords
  sendInput({ type: 'contextmenu', x, y })
}

function handleDoubleClick(event) {
  if (!isConnected.value) return
  const coords = getRelativeCoords(event, { allowOutside: false })
  if (!coords) return
  const { x, y } = coords
  sendInput({ type: 'dblclick', x, y })
}

// ==================== 键盘事件（含剪贴板拦截） ====================

// 需要拦截的快捷键（防止浏览器默认行为）
const INTERCEPT_KEYS = new Set([
  'Tab', 'F5', 'F11', 'F12'
])

const INTERCEPT_CTRL_KEYS = new Set([
  'a', 'c', 'v', 'x', 'z', 'y', 's', 'f', 'g', 'h', 'j', 'k', 'l',
  'n', 'o', 'p', 'r', 't', 'w', 'u', 'd',
  'ArrowLeft', 'ArrowRight'
])

async function handleKeyDown(event) {
  if (!isConnected.value) return
  if (!canSendUserOperation.value) return

  const isTextBridge = (event.target === mobileKeyboardInputRef.value)

  // URL 输入框聚焦时不拦截（除了 Escape）
  if (urlFocused.value) {
    if (event.key === 'Escape') {
      urlInputRef.value?.blur()
      streamContainer.value?.focus()
    }
    return
  }

  // 其他输入框不拦截
  if ((event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') &&
      !isTextBridge &&
      event.target !== streamContainer.value) return

  // When the hidden text bridge is focused, let it produce actual text (incl. IME).
  // We only forward non-printable keys from keydown/keyup, and rely on @input for text.
  if (isTextBridge && typeof event.key === 'string' && event.key.length === 1 &&
      !event.ctrlKey && !event.altKey && !event.metaKey) {
    return
  }

  // 剪贴板操作特殊处理
  if (event.ctrlKey && !event.altKey && !event.metaKey) {
    if (event.key === 'c' || event.key === 'C') {
      event.preventDefault()
      // 发送复制命令到服务端
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'clipboard_copy' }))
      }
      return
    }

    if (event.key === 'v' || event.key === 'V') {
      // 不阻止默认行为，让浏览器触发 paste 事件
      // paste 事件处理器会捕获剪贴板内容并发送到服务端
      // 这样在 HTTP 环境下也能正常工作
      return
    }

    if (event.key === 'x' || event.key === 'X') {
      event.preventDefault()
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'clipboard_cut' }))
      }
      return
    }

    // Ctrl+T: 新标签页（拦截浏览器默认行为）
    if (event.key === 't' || event.key === 'T') {
      event.preventDefault()
      createNewTab()
      return
    }

    // Ctrl+W: 关闭当前标签页（拦截浏览器默认行为）
    if (event.key === 'w' || event.key === 'W') {
      event.preventDefault()
      closeTab(activeTabIndex.value)
      return
    }
  }

  // 拦截需要阻止默认行为的按键
  if (INTERCEPT_KEYS.has(event.key)) {
    event.preventDefault()
  }
  if (event.ctrlKey && INTERCEPT_CTRL_KEYS.has(event.key)) {
    event.preventDefault()
  }

  // 发送键盘事件到远程
  sendInput({
    type: 'keydown',
    key: event.key,
    code: event.code,
    modifiers: {
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      meta: event.metaKey
    }
  })
}

function handleKeyUp(event) {
  if (!isConnected.value) return
  if (!canSendUserOperation.value) return
  if (urlFocused.value) return

  const isTextBridge = (event.target === mobileKeyboardInputRef.value)
  if ((event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') &&
      !isTextBridge &&
      event.target !== streamContainer.value) return

  if (isTextBridge && typeof event.key === 'string' && event.key.length === 1 &&
      !event.ctrlKey && !event.altKey && !event.metaKey) {
    return
  }

  event.preventDefault()
  sendInput({
    type: 'keyup',
    key: event.key,
    code: event.code,
    modifiers: {
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      meta: event.metaKey
    }
  })
}

function handleMobileKeyboardInput(event) {
  if (!isConnected.value || !canSendUserOperation.value) return
  const el = event.target
  const next = String(el?.value || '')
  const prev = mobileKeyboardBuffer

  if (next.startsWith(prev) && next.length > prev.length) {
    const inserted = next.slice(prev.length)
    if (inserted) sendInput({ type: 'keypress', text: inserted })
  } else if (prev.startsWith(next) && prev.length > next.length) {
    const removed = prev.length - next.length
    for (let i = 0; i < removed; i++) {
      sendInput({ type: 'keydown', key: 'Backspace', code: 'Backspace', modifiers: { ctrl: false, alt: false, shift: false, meta: false } })
      sendInput({ type: 'keyup', key: 'Backspace', code: 'Backspace', modifiers: { ctrl: false, alt: false, shift: false, meta: false } })
    }
  } else if (next) {
    sendInput({ type: 'keypress', text: next })
  }

  mobileKeyboardBuffer = next
  if (mobileKeyboardBuffer.length > 48 && el) {
    mobileKeyboardBuffer = mobileKeyboardBuffer.slice(-24)
    el.value = mobileKeyboardBuffer
  }
}

function handleMobileKeyboardKeyDown(event) {
  if (!isConnected.value || !canSendUserOperation.value) return
  const key = event.key
  if (!key) return
  if (key.length === 1) return

  const specialKeys = new Set([
    'Enter', 'Tab', 'Escape', 'Backspace', 'Delete',
    'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
    'Home', 'End', 'PageUp', 'PageDown'
  ])
  if (!specialKeys.has(key)) return

  event.preventDefault()
  sendInput({ type: 'keydown', key, code: event.code || key, modifiers: { ctrl: false, alt: false, shift: false, meta: false } })
  sendInput({ type: 'keyup', key, code: event.code || key, modifiers: { ctrl: false, alt: false, shift: false, meta: false } })

  if (key === 'Enter' && mobileKeyboardInputRef.value) {
    mobileKeyboardInputRef.value.value = ''
    mobileKeyboardBuffer = ''
  }
}

// ==================== URL 导航 ====================

function navigateToUrl() {
  if (!canSendUserOperation.value) return
  if (!urlInput.value) return

  let url = urlInput.value
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    isPageLoading.value = true
    ws.send(JSON.stringify({ type: 'navigate', url, tabIndex: activeTabIndex.value }))
  }

  // 失焦 URL 输入框
  urlInputRef.value?.blur()
  streamContainer.value?.focus()
}

// ==================== 文件操作 ====================

function toggleFiles() {
  showFiles.value = !showFiles.value
  if (showFiles.value) {
    hasFilesBadge.value = false
    loadFiles()
    loadActiveDownloads()
  }
}

async function loadFiles() {
  try {
    const response = await api.get(`/api/files/${browserId.value}`)
    const next = [...response.data].sort((a, b) => {
      const ta = new Date(a.mtime).getTime()
      const tb = new Date(b.mtime).getTime()
      return tb - ta
    })
    if (!hasLoadedFilesBaseline.value) {
      hasLoadedFilesBaseline.value = true
    } else if (next.length > downloadFiles.value.length) {
      hasFilesBadge.value = true
      showFiles.value = true
    }
    if (!isSameDownloadedFiles(downloadFiles.value, next)) {
      downloadFiles.value = next
    }
  } catch (e) {
    console.error('Failed to load file list:', e)
  }
}

async function loadActiveDownloads() {
  try {
    const response = await api.get(`/api/files/${browserId.value}/active`)
    const next = (response.data || []).map(normalizeActiveDownload)
    if (!isSameActiveDownloads(activeDownloads.value, next)) {
      activeDownloads.value = next
    }
  } catch (e) {
    console.error('Failed to load active downloads:', e)
  }
}

function getDownloadUrl(filename) {
  const token = localStorage.getItem('token')
  return `/api/files/${browserId.value}/${encodeURIComponent(filename)}?token=${token}`
}

async function deleteFile(filename) {
  try {
    await api.delete(`/api/files/${browserId.value}/${encodeURIComponent(filename)}`)
    await loadFiles()
  } catch (e) {
    console.error('Failed to delete file:', e)
  }
}

async function removeAllFiles() {
  try {
    await api.delete(`/api/files/${browserId.value}`)
    await loadFiles()
  } catch (e) {
    console.error('Failed to remove all files:', e)
  }
}

async function cancelDownload(guid) {
  try {
    await api.post(`/api/files/${browserId.value}/cancel/${encodeURIComponent(guid)}`)
    activeDownloads.value = activeDownloads.value.filter((x) => x.guid !== guid)
  } catch (e) {
    console.error('Failed to cancel download:', e)
  }
}

function normalizeActiveDownload(item) {
  return {
    guid: item.guid,
    filename: item.filename || '',
    receivedBytes: Number(item.receivedBytes || 0),
    totalBytes: Number(item.totalBytes || 0),
    progress: Number(item.progress || 0),
    state: item.state || 'inProgress'
  }
}

function isSameDownloadedFiles(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i] || {}
    const y = b[i] || {}
    if (x.name !== y.name) return false
    if (Number(x.size || 0) !== Number(y.size || 0)) return false
    if (new Date(x.mtime).getTime() !== new Date(y.mtime).getTime()) return false
  }
  return true
}

function isSameActiveDownloads(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i] || {}
    const y = b[i] || {}
    if (x.guid !== y.guid) return false
    if (x.filename !== y.filename) return false
    if (Number(x.receivedBytes || 0) !== Number(y.receivedBytes || 0)) return false
    if (Number(x.totalBytes || 0) !== Number(y.totalBytes || 0)) return false
    if (Number(x.progress || 0) !== Number(y.progress || 0)) return false
    if (x.state !== y.state) return false
  }
  return true
}

function handleDownloadProgress(message) {
  const guid = String(message.guid || '')
  if (!guid) return
  const item = normalizeActiveDownload({
    guid,
    filename: message.filename,
    receivedBytes: message.receivedBytes,
    totalBytes: message.totalBytes,
    progress: message.progress,
    state: message.state
  })
  const idx = activeDownloads.value.findIndex((x) => x.guid === guid)
  if (message.state === 'completed' || message.state === 'canceled') {
    if (idx !== -1) {
      activeDownloads.value.splice(idx, 1)
    }
    loadFiles()
    return
  }
  if (idx === -1) {
    activeDownloads.value.unshift(item)
  } else {
    activeDownloads.value[idx] = item
  }
  downloadNotice.value = t('browserView.downloadingNotice', {
    filename: item.filename || t('browserView.downloadingUnknown'),
    progress: item.progress
  })
}

function triggerFileUpload() {
  if (!canSendUserOperation.value) return
  pendingFileUpload.value = true
  fileInput.value.click()
}

function cancelFileChooser() {
  if (!canSendUserOperation.value) return
  showFileChooser.value = false
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'file_response', cancelled: true }))
  }
}

async function handleFileSelect(event) {
  const file = event.target.files[0]
  if (!file) return

  showFileChooser.value = false

  const formData = new FormData()
  formData.append('file', file)

  try {
    await api.post(`/api/files/${browserId.value}/upload`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    })
  } catch (e) {
    console.error('Failed to upload file:', e)
  }

  event.target.value = ''
  pendingFileUpload.value = false
}

function autoDownloadFile(filename) {
  const url = getDownloadUrl(filename)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function formatFileTime(value) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '-'
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${day} ${hh}:${mm}`
}

// ==================== 带宽格式化 ====================

function formatBandwidth(bytesPerSec) {
  if (bytesPerSec === 0) return '0'
  if (bytesPerSec < 1024) return `${bytesPerSec}B/s`
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(0)}KB/s`
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)}MB/s`
}

function formatScale(value) {
  const n = Number(value || 1)
  if (!Number.isFinite(n)) return '1'
  // show like 0.6 instead of 0.60, 1 instead of 1.0
  const s = (Math.round(n * 100) / 100).toFixed(2)
  return s.replace(/\.?0+$/, '')
}

function formatFps(value) {
  const n = Number(value || 0)
  if (!Number.isFinite(n) || n <= 0) return '-fps'
  // show like "14.1fps"
  return `${Math.round(n * 10) / 10}fps`
}

// ==================== 剪贴板辅助函数 ====================

// 写入系统剪贴板（带 fallback）
function writeToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => {
      fallbackCopyToClipboard(text)
    })
  } else {
    fallbackCopyToClipboard(text)
  }
}

// 使用 execCommand 的 fallback 方式写入剪贴板
function fallbackCopyToClipboard(text) {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.cssText = 'position:fixed;opacity:0;left:-9999px;top:-9999px'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  try {
    document.execCommand('copy')
  } catch (e) {
    console.warn('Clipboard fallback failed:', e)
  }
  document.body.removeChild(textarea)
}

// paste 事件处理（在 HTTP 环境下也能可靠地读取剪贴板）
function handlePaste(event) {
  if (!isConnected.value) return
  if (!canSendUserOperation.value) return
  // URL 输入框或对话框输入框聚焦时不拦截
  if (urlFocused.value) return
  const isTextBridge = (event.target === mobileKeyboardInputRef.value)
  if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') {
    if (!isTextBridge && event.target !== streamContainer.value) return
  }

  event.preventDefault()

  let text = event.clipboardData?.getData('text/plain') || ''

  // 如果系统剪贴板为空，使用虚拟剪贴板
  if (!text && virtualClipboard.value) {
    text = virtualClipboard.value
  }

  if (text && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'clipboard_paste', text }))
  }
}

// ==================== 拖拽文件上传 ====================

function handleDragOver(event) {
  if (!isConnected.value) return
  if (!canSendUserOperation.value) return
  isDragging.value = true
  event.dataTransfer.dropEffect = 'copy'
}

function handleDragLeave(event) {
  // 只在真正离开容器时取消拖拽状态
  if (!event.currentTarget.contains(event.relatedTarget)) {
    isDragging.value = false
  }
}

async function handleDrop(event) {
  isDragging.value = false
  if (!isConnected.value) return
  if (!canSendUserOperation.value) return

  const files = event.dataTransfer.files
  if (!files || files.length === 0) return

  // 计算相对于串流画面的坐标
  const { x, y } = getRelativeCoords(event)

  const formData = new FormData()
  for (let i = 0; i < files.length; i++) {
    formData.append('files', files[i])
  }
  formData.append('x', x.toString())
  formData.append('y', y.toString())

  try {
    await api.post(`/api/files/${browserId.value}/drop`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    })
    // 如果有文件选择器弹窗，关闭它
    showFileChooser.value = false
    console.log(`Drag-and-drop upload success: ${files.length} file(s)`)
  } catch (e) {
    console.error('Drag-and-drop upload failed:', e)
  }
}

// ==================== 生命周期 ====================

// 全局 mouseup 重置（防止 mousedown 在串流但 mouseup 在外部时状态卡住）
function handleGlobalMouseUp() {
  mouseDownInStream = false
}

function sendTabListRequest(reason, refreshMeta = false) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  console.info('[SB][tabs] request', { reason, refreshMeta })
  ws.send(JSON.stringify({ type: 'tab_list', reason, refreshMeta }))
}

function logTabSnapshot(source) {
  const compact = (tabs.value || []).map((tab, idx) => {
    const rawId = tab.tab_identifier || tab.tabIdentifier || `idx-${idx}`
    const id = String(rawId).slice(-12)
    const title = String(tab.title || 'New Tab').slice(0, 28)
    return `${idx === activeTabIndex.value ? '*' : ''}${idx}:${id}:${title}:${tab.url || ''}:${tab.isReady === false ? 'NR' : 'R'}`
  }).join(' | ')
  if (compact === lastTabSnapshot) return
  lastTabSnapshot = compact
  console.info('[SB][tabs]', { source, creatingTab: creatingTab.value, tabs: compact })
}

function startWatchdogs() {
  if (streamWatchTimer) clearInterval(streamWatchTimer)
  streamWatchTimer = setInterval(() => {
    if (!isConnected.value) return
    const idleMs = Date.now() - lastFrameAt
    if (idleMs > 8000 && ws && ws.readyState === WebSocket.OPEN) {
      sendTabListRequest('watchdog-idle', false)
    }
    if (idleMs > 15000) {
      noFrameWarnStreak += 1
      const wsState = getWsStateText()
      console.warn('[SB][stream] watchdog no-frame', {
        idleMs,
        noFrameWarnStreak,
        wsState,
        reconnectAttempts
      })
      if (ws && ws.readyState === WebSocket.OPEN) {
        sendTabListRequest('watchdog-no-frame', true)
        const now = Date.now()
        if (now - lastRecoverRequestAt > 5000) {
          lastRecoverRequestAt = now
          ws.send(JSON.stringify({ type: 'stream_recover', reason: 'watchdog-no-frame', idleMs }))
          pushWsEvent('tx', 'stream_recover', `idleMs=${idleMs}`)
        }
      }
      // Only reconnect on persistent no-frame + websocket non-open.
      if (idleMs > 25000 && (!ws || ws.readyState !== WebSocket.OPEN) && noFrameWarnStreak >= 2) {
        streamError.value = t('browserView.streamError')
        scheduleReconnect()
      }
    } else {
      noFrameWarnStreak = 0
    }
  }, 2000)

  if (tabSyncTimer) clearInterval(tabSyncTimer)
  tabSyncTimer = setInterval(() => {
    if (isConnected.value && ws && ws.readyState === WebSocket.OPEN) {
      sendTabListRequest('periodic-sync', true)
    }
  }, 6000)

  if (filesSyncTimer) clearInterval(filesSyncTimer)
  filesSyncTimer = setInterval(() => {
    if (!isConnected.value) return
    loadActiveDownloads()
    loadFiles()
  }, 1200)

  if (wsDebugTimer) clearInterval(wsDebugTimer)
  wsDebugTimer = setInterval(() => {
    wsDebug.value.readyStateText = getWsStateText()
  }, 500)
}

onMounted(() => {
  manualClose = false
  loadBrowserConfig()
  connect()
  startWatchdogs()

  updateTouchMode()
  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener('keyup', handleKeyUp)
  window.addEventListener('paste', handlePaste)
  window.addEventListener('mouseup', handleGlobalMouseUp)
  window.addEventListener('resize', updateRemoteCursorOverlay)
  window.addEventListener('resize', updateTouchMode)

  // 自动聚焦串流容器
  nextTick(() => {
    streamContainer.value?.focus()
  })
})

onUnmounted(() => {
  manualClose = true
  if (ws) {
    ws.close()
  }

  if (feedbackTimer) {
    clearInterval(feedbackTimer)
  }
  if (streamErrorTimer) {
    clearTimeout(streamErrorTimer)
    streamErrorTimer = null
  }
  if (firstFrameTimer) {
    clearTimeout(firstFrameTimer)
    firstFrameTimer = null
  }
  if (wsHandshakeTimer) {
    clearTimeout(wsHandshakeTimer)
    wsHandshakeTimer = null
  }
  if (wsOpenTimer) {
    clearTimeout(wsOpenTimer)
    wsOpenTimer = null
  }
  if (streamWatchTimer) clearInterval(streamWatchTimer)
  if (tabSyncTimer) clearInterval(tabSyncTimer)
  if (filesSyncTimer) clearInterval(filesSyncTimer)
  if (wsDebugTimer) clearInterval(wsDebugTimer)
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (policyNoticeTimer) clearTimeout(policyNoticeTimer)

  if (frameSrc.value) {
    URL.revokeObjectURL(frameSrc.value)
  }

  window.removeEventListener('keydown', handleKeyDown)
  window.removeEventListener('keyup', handleKeyUp)
  window.removeEventListener('paste', handlePaste)
  window.removeEventListener('mouseup', handleGlobalMouseUp)
  window.removeEventListener('resize', updateRemoteCursorOverlay)
  window.removeEventListener('resize', updateTouchMode)
})

function getWsStateText() {
  if (!ws) return 'NULL'
  const stateMap = {
    [WebSocket.CONNECTING]: 'CONNECTING',
    [WebSocket.OPEN]: 'OPEN',
    [WebSocket.CLOSING]: 'CLOSING',
    [WebSocket.CLOSED]: 'CLOSED'
  }
  return stateMap[ws.readyState] || `STATE_${ws.readyState}`
}

function pushWsEvent(dir, type, extra = '') {
  const now = Date.now()
  const item = {
    ts: new Date(now).toISOString().slice(11, 23),
    dir,
    type,
    extra
  }
  const next = [item, ...(wsDebug.value.events || [])].slice(0, 12)
  wsDebug.value.events = next
  if (dir === 'rx') {
    wsDebug.value.lastRxAt = now
    wsDebug.value.lastRxType = type
    wsDebug.value.rxCount += 1
  } else if (dir === 'tx') {
    wsDebug.value.lastTxAt = now
    wsDebug.value.lastTxType = type
    wsDebug.value.txCount += 1
  }
}

function formatAge(ts) {
  const n = Number(ts || 0)
  if (!n) return '-'
  const age = Math.max(0, Date.now() - n)
  return `${age}ms`
}
</script>

<style scoped>
.browser-view-page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #1a1a1a;
  outline: none;
}

/* ==================== 工具栏 ==================== */

.toolbar {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: 8px;
  padding: 6px 12px;
  min-height: 44px;
  background: #2a2a2a;
  border-bottom: 1px solid #3a3a3a;
  flex-shrink: 0;
  overflow-x: auto;
  overflow-y: hidden;
}

.nav-buttons {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}

.nav-btn {
  background: none;
  border: 1px solid transparent;
  color: #bbb;
  font-size: 14px;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s;
}

.nav-btn i {
  font-size: 13px;
}

.nav-btn:hover:not(:disabled) {
  background: #3a3a3a;
  color: white;
}

.nav-btn:active:not(:disabled) {
  background: #444;
}

.nav-btn:disabled {
  color: #555;
  cursor: not-allowed;
}

.nav-btn.is-loading {
  color: #e74c3c;
}

.toolbar-center {
  flex: 1;
  display: flex;
  gap: 8px;
  max-width: 700px;
  min-width: 0;
}

.url-wrapper {
  flex: 1;
  position: relative;
  min-width: 0;
}

.url-wrapper.is-loading-url {
  min-height: 32px;
}

.url-input {
  width: 100%;
  padding: 6px 12px;
  border: 1px solid #3a3a3a;
  border-radius: 6px;
  background: #1a1a1a;
  color: white;
  font-size: 13px;
  box-sizing: border-box;
}

.url-input:focus {
  outline: none;
  border-color: var(--primary-color);
}

.url-loading-bar {
  position: absolute;
  bottom: 0;
  left: 4px;
  right: 4px;
  height: 2px;
  background: linear-gradient(90deg, var(--primary-color), #3498db);
  border-radius: 1px;
  animation: loading-bar 1.5s ease-in-out infinite;
}

@keyframes loading-bar {
  0% { transform: scaleX(0); transform-origin: left; }
  50% { transform: scaleX(1); transform-origin: left; }
  50.01% { transform-origin: right; }
  100% { transform: scaleX(0); transform-origin: right; }
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  margin-left: auto;
  white-space: nowrap;
  min-width: 0;
}

.tool-icon-btn {
  width: 30px;
  height: 30px;
  border: 1px solid #3d3d3d;
  border-radius: 7px;
  background: #313131;
  color: #d8d8d8;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  line-height: 1;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.tool-icon-btn i {
  font-size: 12px;
}

.tool-icon-btn:hover:not(:disabled) {
  background: #3d3d3d;
  color: #fff;
  border-color: #4a4a4a;
}

.tool-icon-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.tool-icon-btn.primary {
  background: #3076d0;
  border-color: #3076d0;
  color: #fff;
}

.tool-icon-btn.primary:hover:not(:disabled) {
  background: #3d8cef;
  border-color: #3d8cef;
}

.tool-icon-btn.danger {
  background: #d44d3f;
  border-color: #d44d3f;
  color: #fff;
}

.tool-icon-btn.danger:hover:not(:disabled) {
  background: #ba3d30;
  border-color: #ba3d30;
}

.mobile-kb-btn {
  color: #ffe39b;
}

.ai-override-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: #f7cb5e;
}

.ai-toggle-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
}

.ai-toggle-icon i {
  font-size: 13px;
}

.ai-passive-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  color: #f39c12;
  font-size: 12px;
}

.status-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #8a8a8a;
  border: 1px solid #7a7a7a;
  display: inline-block;
}

.status-dot.connected {
  background: #2ecc71;
  border-color: #2ecc71;
  box-shadow: 0 0 6px rgba(46, 204, 113, 0.55);
}

.stats {
  font-size: 11px;
  color: #888;
  font-family: monospace;
  white-space: nowrap;
}

.remote-net {
  color: #6cc;
}

.compact {
  flex-shrink: 0;
}

.active-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #f39c12;
  color: #000;
  font-size: 10px;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border-radius: 9px;
  font-weight: 700;
  font-family: monospace;
}

.download-live-indicator {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #e8f3ff;
  color: #1b66d6;
  border: 1px solid #b9d7ff;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

.files-btn {
  position: relative;
  width: auto;
  min-width: 38px;
  padding: 0 8px;
  gap: 4px;
}

.files-count {
  font-size: 10px;
  font-weight: 700;
  color: #dfe7ff;
  font-family: monospace;
}

.files-badge-dot {
  position: absolute;
  top: 1px;
  right: 1px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ff3b30;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
}

/* ==================== Tab 栏 ==================== */

.tab-bar {
  display: flex;
  align-items: stretch;
  background: #252525;
  border-bottom: 1px solid #3a3a3a;
  height: 36px;
  flex-shrink: 0;
  overflow: hidden;
}

.tab-list {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

.tab-list::-webkit-scrollbar {
  display: none;
}

.tab-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 12px;
  min-width: 100px;
  max-width: 200px;
  background: #2a2a2a;
  border-right: 1px solid #1a1a1a;
  cursor: pointer;
  transition: background 0.15s;
  flex-shrink: 0;
  user-select: none;
}

.tab-item:hover {
  background: #353535;
}

.tab-item.active {
  background: #1a1a1a;
  border-bottom: 2px solid var(--primary-color);
}

.tab-item.has-dialog {
  background: #3a2a1a;
}

.tab-item.has-dialog.active {
  background: #2a1a0a;
}

.tab-item.not-ready {
  background: #3f3a1f;
}

.tab-item.not-ready.active {
  background: #4a431f;
  border-bottom-color: #f1c40f;
}

.tab-title {
  flex: 1;
  font-size: 12px;
  color: #ccc;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab-item.active .tab-title {
  color: white;
}

.tab-dialog-indicator {
  font-size: 12px;
  color: #f39c12;
  cursor: pointer;
}

.tab-ready-indicator {
  font-size: 10px;
  color: #f1c40f;
}

.tab-ready-indicator i {
  font-size: 8px;
}

.tab-close {
  background: none;
  border: none;
  color: #666;
  font-size: 14px;
  cursor: pointer;
  padding: 0 2px;
  line-height: 1;
  border-radius: 3px;
}

.tab-close:hover {
  background: rgba(255, 255, 255, 0.1);
  color: white;
}

.tab-new-btn {
  background: #2f2f2f;
  border: 1px solid #3a3a3a;
  color: #888;
  font-size: 18px;
  cursor: pointer;
  height: 28px;
  min-width: 30px;
  margin: 4px 6px;
  border-radius: 6px;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.tab-new-btn:hover {
  background: #353535;
  color: white;
}

.tab-new-btn.inline {
  flex-shrink: 0;
}

@media (max-width: 1200px) {
  .remote-net,
  .active-badge {
    display: none;
  }
}

@media (max-width: 980px) {
  .stats {
    display: none;
  }
}

.tab-new-btn.blocked {
  background: #4d1f1f;
  border-color: #b43b3b;
  color: #ff7b7b;
  cursor: not-allowed;
}

/* ==================== 串流画面 ==================== */

.stream-container {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  position: relative;
  cursor: default;
  outline: none;
}

.stream-image {
  /* Always fit viewport (avoid 1:1 native pixel rendering) */
  width: 100%;
  height: 100%;
  object-fit: contain;
  user-select: none;
  -webkit-user-drag: none;
}

.blank-hint-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  z-index: 30;
}

.blank-hint-card {
  background: rgba(24, 24, 24, 0.75);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 12px;
  padding: 10px 14px;
  color: #f5f7fb;
  max-width: min(580px, 80%);
  text-align: center;
}

.blank-hint-title {
  font-size: 13px;
  font-weight: 700;
}

.blank-hint-sub {
  margin-top: 4px;
  font-size: 11px;
  color: #d0d9e6;
}

.blank-hint-url {
  margin-top: 6px;
  font-size: 11px;
  color: #8ec5ff;
  font-family: monospace;
  word-break: break-all;
}

.remote-cursor {
  position: absolute;
  width: 14px;
  height: 14px;
  margin-left: -7px;
  margin-top: -7px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.95);
  border: 2px solid #ff2d55;
  box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.35);
  pointer-events: none;
  z-index: 60;
}

.remote-cursor.pressing {
  transform: scale(0.8);
  background: #ff2d55;
}

.connecting-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.8);
  color: white;
}

.connecting-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid #333;
  border-top-color: var(--primary-color);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 16px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ==================== 错误覆盖层 ==================== */

.error-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.85);
  color: white;
  z-index: 45;
}

.error-content {
  text-align: center;
  padding: 32px;
}

.error-icon {
  font-size: 48px;
  display: block;
  margin-bottom: 16px;
}

.error-icon i {
  font-size: 44px;
}

.error-message {
  font-size: 16px;
  margin-bottom: 20px;
  max-width: 400px;
  line-height: 1.5;
}

/* ==================== 拖拽覆盖层 ==================== */

.drag-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(74, 144, 217, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 40;
  border: 3px dashed var(--primary-color);
  pointer-events: none;
}

.drag-content {
  text-align: center;
  color: white;
  background: rgba(0, 0, 0, 0.6);
  padding: 24px 48px;
  border-radius: 16px;
}

.drag-icon {
  font-size: 48px;
  display: block;
  margin-bottom: 8px;
}

.drag-content p {
  font-size: 16px;
  margin: 0;
}

/* ==================== 对话框覆盖层 ==================== */

.dialog-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}

.dialog-box {
  background: white;
  border-radius: 12px;
  padding: 24px;
  min-width: 320px;
  max-width: 480px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
}

.dialog-header {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 12px;
  color: #333;
}

.dialog-message {
  font-size: 14px;
  color: #555;
  margin-bottom: 16px;
  word-break: break-word;
  white-space: pre-wrap;
}

.dialog-input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid #ddd;
  border-radius: 6px;
  font-size: 14px;
  margin-bottom: 16px;
}

.dialog-input:focus {
  outline: none;
  border-color: var(--primary-color);
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* ==================== 文件面板 ==================== */

.files-panel {
  position: fixed;
  top: 60px;
  right: 16px;
  width: 360px;
  max-height: calc(100vh - 80px);
  background: white;
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  display: flex;
  flex-direction: column;
  z-index: 100;
}


.files-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
}

.files-header h3 {
  font-size: 16px;
  font-weight: 600;
}

.files-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.download-notice {
  padding: 8px 12px;
  font-size: 12px;
  color: #3b4a00;
  background: #fff8d6;
  border-bottom: 1px solid #f0e0a0;
}

.files-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.empty-files {
  text-align: center;
  padding: 24px;
  color: var(--text-secondary);
}

.file-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 8px;
  border-radius: 8px;
  transition: background 0.2s;
}

.file-item:hover {
  background: #f5f5f5;
}

.file-item.downloading {
  background: #f7fbff;
  border: 1px solid #d7e8ff;
}

.file-left {
  flex: 1;
  min-width: 0;
}

.file-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.file-name {
  flex: 1;
  font-size: 12px;
  line-height: 1.3;
  word-break: break-all;
}

.file-meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 3px;
  font-size: 11px;
  color: var(--text-secondary);
}

.file-actions {
  display: flex;
  gap: 6px;
}

.file-actions.vertical {
  flex-direction: column;
}

.icon-btn {
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 7px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  text-decoration: none;
  font-size: 12px;
  line-height: 1;
  box-shadow: none;
}

.icon-btn.download {
  background: #4a90e2;
  color: #fff;
}

.icon-btn.delete {
  background: #e74c3c;
  color: #fff;
}

.icon-btn.cancel {
  background: #f39c12;
  color: #fff;
}

.file-status {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.file-status.done {
  background: #2ecc71;
  color: #fff;
  font-size: 11px;
}

.file-done-meta {
  color: #24a85e;
  font-weight: 600;
}

.file-status.spinner {
  border: 2px solid #bcd8ff;
  border-top-color: #3d8bff;
  animation: spin 0.9s linear infinite;
}

.file-progress-wrap {
  margin-top: 6px;
  width: 100%;
  height: 6px;
  border-radius: 4px;
  background: #dce6f5;
  overflow: hidden;
}

.file-progress-bar {
  height: 100%;
  border-radius: 4px;
  background: linear-gradient(90deg, #5aa0ff, #2f78f4);
  transition: width 0.2s ease;
}

.files-footer {
  padding: 16px;
  border-top: 1px solid var(--border-color);
}

.files-footer button {
  width: 100%;
}

.mobile-keyboard-bridge {
  position: fixed;
  left: -9999px;
  top: -9999px;
  opacity: 0;
  width: 1px;
  height: 1px;
  pointer-events: none;
}

.policy-toast {
  position: fixed;
  top: 52px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1200;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  max-width: min(720px, calc(100vw - 24px));
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(20, 20, 20, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: #f5f7fb;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(6px);
}

.policy-toast-left {
  color: #ffd089;
  padding-top: 2px;
}

.policy-toast-body {
  flex: 1;
  min-width: 0;
}

.policy-toast-title {
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.1px;
}

.policy-toast-msg {
  margin-top: 2px;
  font-size: 12px;
  color: #d6deea;
  word-break: break-word;
}

.policy-toast-close {
  border: none;
  background: transparent;
  color: #cfd6e2;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 0 4px;
}

.policy-toast-close:hover {
  color: #ffffff;
}
</style>
