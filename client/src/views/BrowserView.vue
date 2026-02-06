<template>
  <div class="browser-view-page" @click="focusStream">
    <!-- 顶部工具栏 -->
    <div class="toolbar" @click.stop @mousedown.stop>
      <div class="nav-buttons">
        <button class="nav-btn" @click="browserBack" :title="t('browserView.goBack')" :disabled="!isConnected">◀</button>
        <button class="nav-btn" @click="browserForward" :title="t('browserView.goForward')" :disabled="!isConnected">▶</button>
        <button
          class="nav-btn"
          :class="{ 'is-loading': isPageLoading }"
          @click="browserRefresh"
          :title="t('browserView.refresh')"
          :disabled="!isConnected"
        >{{ isPageLoading ? '✕' : '↻' }}</button>
      </div>
      <div class="toolbar-center">
        <div class="url-wrapper" :class="{ loading: isPageLoading }">
          <input
            ref="urlInputRef"
            v-model="urlInput"
            type="text"
            class="url-input"
            :placeholder="t('browserView.urlPlaceholder')"
            @keyup.enter="navigateToUrl"
            @focus="urlFocused = true"
            @blur="urlFocused = false"
          />
          <div v-if="isPageLoading" class="url-loading-bar"></div>
        </div>
        <button class="btn btn-primary btn-sm" @click="navigateToUrl">{{ t('browserView.go') }}</button>
      </div>
      <div class="toolbar-right">
        <span class="status" :class="{ connected: isConnected }">
          {{ isConnected ? t('browserView.connected') : t('browserView.connecting') }}
        </span>
        <span class="stats">
          {{ fps }} FPS | {{ quality }}% | ↓{{ formatBandwidth(bandwidth) }}
        </span>
        <span v-if="isConnected && remoteNetwork.bytesPerSec > 0" class="stats remote-net" :title="t('browserView.remoteNetworkActivity')">
          🌐↓{{ formatBandwidth(remoteNetwork.bytesPerSec) }}
        </span>
        <span v-if="isConnected && remoteNetwork.activeRequests > 0" class="active-badge" :title="t('browserView.remoteActiveRequests')">
          {{ remoteNetwork.activeRequests }}
        </span>
        <button class="btn btn-secondary btn-sm" @click="toggleFiles">
          {{ t('browserView.files', { count: downloadFiles.length }) }}
        </button>
        <button class="btn btn-exit btn-sm" @click="goBackToList" :title="t('browserView.exitBrowser')">
          {{ t('browserView.exitBrowser') }}
        </button>
      </div>
    </div>

    <!-- Tab 栏 -->
    <div class="tab-bar">
      <div class="tab-list" ref="tabListRef">
        <div
          v-for="tab in tabs"
          :key="tab.index"
          class="tab-item"
          :class="{
            active: tab.index === activeTabIndex,
            'has-dialog': tab.hasDialog
          }"
          @mousedown.stop="switchTab(tab.index)"
        >
          <span class="tab-title" :title="tab.title + ' - ' + tab.url">
            {{ tab.title || 'New Tab' }}
          </span>
          <span
            v-if="tab.hasDialog"
            class="tab-dialog-indicator"
            @click.stop="switchTab(tab.index)"
            :title="t('browserView.tabHasDialog')"
          >⚠</span>
          <button
            class="tab-close"
            @mousedown.stop
            @click.stop="closeTab(tab.index)"
            :title="t('browserView.closeTab')"
          >&times;</button>
        </div>
      </div>
      <button class="tab-new-btn" @click="createNewTab" :title="t('browserView.newTab')">+</button>
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
      <div v-if="!isConnected && !streamError" class="connecting-overlay">
        <div class="connecting-spinner"></div>
        <p>{{ t('browserView.connectingToBrowser') }}</p>
      </div>

      <!-- Error overlay -->
      <div v-if="streamError" class="error-overlay">
        <div class="error-content">
          <span class="error-icon">⚠️</span>
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

    <!-- Files panel -->
    <div v-if="showFiles" class="files-panel">
      <div class="files-header">
        <h3>{{ t('browserView.downloadedFiles') }}</h3>
        <button class="modal-close" @click="showFiles = false">&times;</button>
      </div>
      <div class="files-list">
        <div v-if="downloadFiles.length === 0" class="empty-files">
          {{ t('browserView.noFiles') }}
        </div>
        <div v-for="file in downloadFiles" :key="file.name" class="file-item">
          <span class="file-name">{{ file.name }}</span>
          <span class="file-size">{{ formatSize(file.size) }}</span>
          <div class="file-actions">
            <a :href="getDownloadUrl(file.name)" class="btn btn-primary btn-sm" download>
              {{ t('common.download') }}
            </a>
            <button class="btn btn-danger btn-sm" @click="deleteFile(file.name)">
              {{ t('common.delete') }}
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
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, computed, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import api from '../utils/api'
import { useI18n } from '../i18n'

const { t } = useI18n()

const route = useRoute()
const router = useRouter()

const browserId = computed(() => route.params.id)

// WebSocket 和连接状态
let ws = null
const isConnected = ref(false)
const streamContainer = ref(null)
const streamImage = ref(null)
const urlInputRef = ref(null)
const urlFocused = ref(false)

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
const showFileChooser = ref(false)
const fileInput = ref(null)
const pendingFileUpload = ref(false)

// Tab 列表容器
const tabListRef = ref(null)

// 拖拽状态
const isDragging = ref(false)

// 串流/浏览器错误
const streamError = ref('')

// 页面加载状态
const isPageLoading = ref(false)

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

// 虚拟剪贴板（HTTP 环境 fallback）
const virtualClipboard = ref('')

// 统计
let frameCount = 0
let lastFpsUpdate = Date.now()
let pendingFrames = 0

// 反馈计时器
let feedbackTimer = null

// 鼠标按下追踪（确保 mouseup 只在 mousedown 来自串流区域时才发送）
let mouseDownInStream = false

// 聚焦到串流区域（只在点击串流容器内部时触发，不从工具栏/标签栏抢焦点）
function focusStream(event) {
  if (!streamContainer.value) return
  // 只有点击发生在串流容器内时才聚焦
  if (!streamContainer.value.contains(event.target)) return
  if (event.target.tagName !== 'INPUT' && event.target.tagName !== 'BUTTON' &&
      event.target.tagName !== 'A') {
    streamContainer.value.focus()
  }
}

function goBackToList() {
  if (ws) {
    ws.close()
  }
  router.push('/')
}

// ==================== 浏览器导航 ====================

function browserBack() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    isPageLoading.value = true
    ws.send(JSON.stringify({ type: 'go_back' }))
  }
}

function browserForward() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    isPageLoading.value = true
    ws.send(JSON.stringify({ type: 'go_forward' }))
  }
}

function browserRefresh() {
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
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = `${protocol}//${window.location.host}/ws`

  ws = new WebSocket(wsUrl)

  ws.onopen = () => {
    console.log('WebSocket connected')
    const token = localStorage.getItem('token')
    ws.send(JSON.stringify({ type: 'auth', token }))
  }

  ws.onmessage = async (event) => {
    if (typeof event.data === 'string') {
      const message = JSON.parse(event.data)
      handleMessage(message)
    } else {
      handleFrame(event.data)
    }
  }

  ws.onclose = () => {
    console.log('WebSocket closed')
    isConnected.value = false
  }

  ws.onerror = (error) => {
    console.error('WebSocket error:', error)
  }
}

function handleMessage(message) {
  switch (message.type) {
    case 'auth_ok':
      ws.send(JSON.stringify({ type: 'connect', browserId: browserId.value }))
      break

    case 'connected':
      isConnected.value = true
      startFeedback()
      loadFiles()
      break

    case 'frame':
      quality.value = message.quality
      pendingFrames++
      break

    case 'tabs_updated':
      tabs.value = message.tabs || []
      activeTabIndex.value = message.activeIndex || 0
      // 更新 URL 输入框显示当前 tab 的 URL
      if (tabs.value.length > 0 && tabs.value[activeTabIndex.value]) {
        const currentUrl = tabs.value[activeTabIndex.value].url
        if (currentUrl && currentUrl !== 'about:blank' && !urlFocused.value) {
          urlInput.value = currentUrl
        }
      }
      // 页面导航完成，清除加载状态
      isPageLoading.value = false
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
      break

    case 'download_progress':
      if (message.state === 'completed') {
        loadFiles()
      }
      break

    case 'stream_error':
      console.error('Stream error:', message.reason, message.message)
      streamError.value = message.message || t('browserView.streamError')
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

    case 'network_stats':
      if (message.network) {
        remoteNetwork.value = message.network
      }
      break

    case 'error':
      console.error('Server error:', message.error)
      break
  }
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
  const blob = new Blob([data], { type: 'image/jpeg' })
  const url = URL.createObjectURL(blob)

  if (frameSrc.value) {
    URL.revokeObjectURL(frameSrc.value)
  }

  frameSrc.value = url
  frameCount++
  pendingFrames = Math.max(0, pendingFrames - 1)

  // 带宽统计
  const dataSize = data.size || data.byteLength || 0
  bytesThisSecond += dataSize

  const now = Date.now()
  if (now - lastFpsUpdate >= 1000) {
    fps.value = frameCount
    frameCount = 0
    lastFpsUpdate = now

    // 更新带宽
    bandwidth.value = bytesThisSecond
    bytesThisSecond = 0
    lastBandwidthCalc = now
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
          rtt: 50
        }
      }))
    }
  }, 1000)
}

// ==================== 重新连接 ====================

function retryConnect() {
  streamError.value = ''
  window.location.reload()
}

// ==================== Tab 操作 ====================

function switchTab(index) {
  if (index === activeTabIndex.value) return
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'tab_switch', tabIndex: index }))
  }
}

function createNewTab() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'tab_new' }))
  }
}

function closeTab(index) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'tab_close', tabIndex: index }))
  }
}

// ==================== 对话框响应 ====================

function respondDialog(accept) {
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

function getRelativeCoords(event) {
  const img = streamImage.value
  if (!img) return { x: 0, y: 0 }

  const imgRect = img.getBoundingClientRect()

  const x = event.clientX - imgRect.left
  const y = event.clientY - imgRect.top

  const scaleX = 1280 / imgRect.width
  const scaleY = 720 / imgRect.height

  return {
    x: Math.max(0, Math.min(1280, Math.round(x * scaleX))),
    y: Math.max(0, Math.min(720, Math.round(y * scaleY)))
  }
}

function sendInput(event) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input', event }))
  }
}

// ==================== 鼠标事件 ====================

function handleMouseMove(event) {
  if (!isConnected.value) return
  const { x, y } = getRelativeCoords(event)
  sendInput({ type: 'mousemove', x, y })
}

function handleMouseDown(event) {
  if (!isConnected.value) return
  mouseDownInStream = true
  const { x, y } = getRelativeCoords(event)
  sendInput({ type: 'mousedown', x, y, button: event.button })
}

function handleMouseUp(event) {
  if (!isConnected.value) return
  // 只有当 mousedown 发生在串流区域时才发送 mouseup
  if (!mouseDownInStream) return
  mouseDownInStream = false
  const { x, y } = getRelativeCoords(event)
  sendInput({ type: 'mouseup', x, y, button: event.button })
}

function handleWheel(event) {
  if (!isConnected.value) return
  event.preventDefault()
  const { x, y } = getRelativeCoords(event)
  sendInput({ type: 'wheel', x, y, deltaX: event.deltaX, deltaY: event.deltaY })
}

function handleContextMenu(event) {
  if (!isConnected.value) return
  const { x, y } = getRelativeCoords(event)
  sendInput({ type: 'contextmenu', x, y })
}

function handleDoubleClick(event) {
  if (!isConnected.value) return
  const { x, y } = getRelativeCoords(event)
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

  // URL 输入框聚焦时不拦截（除了 Escape）
  if (urlFocused.value) {
    if (event.key === 'Escape') {
      urlInputRef.value?.blur()
      streamContainer.value?.focus()
    }
    return
  }

  // 其他输入框不拦截
  if (event.target.tagName === 'INPUT' && event.target !== streamContainer.value) return

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
  if (urlFocused.value) return
  if (event.target.tagName === 'INPUT' && event.target !== streamContainer.value) return

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

// ==================== URL 导航 ====================

function navigateToUrl() {
  if (!urlInput.value) return

  let url = urlInput.value
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    isPageLoading.value = true
    ws.send(JSON.stringify({ type: 'navigate', url }))
  }

  // 失焦 URL 输入框
  urlInputRef.value?.blur()
  streamContainer.value?.focus()
}

// ==================== 文件操作 ====================

function toggleFiles() {
  showFiles.value = !showFiles.value
  if (showFiles.value) {
    loadFiles()
  }
}

async function loadFiles() {
  try {
    const response = await api.get(`/api/files/${browserId.value}`)
    downloadFiles.value = response.data
  } catch (e) {
    console.error('Failed to load file list:', e)
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

function triggerFileUpload() {
  pendingFileUpload.value = true
  fileInput.value.click()
}

function cancelFileChooser() {
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

// ==================== 带宽格式化 ====================

function formatBandwidth(bytesPerSec) {
  if (bytesPerSec === 0) return '0'
  if (bytesPerSec < 1024) return `${bytesPerSec}B/s`
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(0)}KB/s`
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)}MB/s`
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
  // URL 输入框或对话框输入框聚焦时不拦截
  if (urlFocused.value) return
  if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') {
    if (event.target !== streamContainer.value) return
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

onMounted(() => {
  connect()

  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener('keyup', handleKeyUp)
  window.addEventListener('paste', handlePaste)
  window.addEventListener('mouseup', handleGlobalMouseUp)

  // 自动聚焦串流容器
  nextTick(() => {
    streamContainer.value?.focus()
  })
})

onUnmounted(() => {
  if (ws) {
    ws.close()
  }

  if (feedbackTimer) {
    clearInterval(feedbackTimer)
  }

  if (frameSrc.value) {
    URL.revokeObjectURL(frameSrc.value)
  }

  window.removeEventListener('keydown', handleKeyDown)
  window.removeEventListener('keyup', handleKeyUp)
  window.removeEventListener('paste', handlePaste)
  window.removeEventListener('mouseup', handleGlobalMouseUp)
})
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
  gap: 8px;
  padding: 6px 12px;
  background: #2a2a2a;
  border-bottom: 1px solid #3a3a3a;
  flex-shrink: 0;
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
  max-width: 600px;
  min-width: 0;
}

.url-wrapper {
  flex: 1;
  position: relative;
  min-width: 0;
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
  gap: 10px;
  flex-shrink: 0;
  margin-left: auto;
}

.btn-exit {
  background: #e74c3c;
  color: white;
  font-weight: 600;
  white-space: nowrap;
}

.btn-exit:hover {
  background: #c0392b;
}

.status {
  font-size: 12px;
  color: #888;
  white-space: nowrap;
}

.status.connected {
  color: var(--success-color);
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
  flex: 1;
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
  background: none;
  border: none;
  border-left: 1px solid #3a3a3a;
  color: #888;
  font-size: 18px;
  cursor: pointer;
  padding: 0 12px;
  transition: background 0.15s, color 0.15s;
}

.tab-new-btn:hover {
  background: #353535;
  color: white;
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
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  user-select: none;
  -webkit-user-drag: none;
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
  align-items: center;
  gap: 8px;
  padding: 12px;
  border-radius: 8px;
  transition: background 0.2s;
}

.file-item:hover {
  background: #f5f5f5;
}

.file-name {
  flex: 1;
  font-size: 14px;
  word-break: break-all;
}

.file-size {
  font-size: 12px;
  color: var(--text-secondary);
}

.file-actions {
  display: flex;
  gap: 4px;
}

.files-footer {
  padding: 16px;
  border-top: 1px solid var(--border-color);
}

.files-footer button {
  width: 100%;
}
</style>
