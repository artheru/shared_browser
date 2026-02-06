<template>
  <div class="browser-list-page">
    <header class="header">
      <h1>{{ t('browserList.title') }}</h1>
      <div class="header-actions">
        <span class="user-info">{{ authStore.user?.username }}</span>
        <button v-if="authStore.isAdmin" class="btn btn-secondary btn-sm" @click="goToUsers">
          {{ t('browserList.userManagement') }}
        </button>
        <button v-if="authStore.isAdmin" class="btn btn-secondary btn-sm" @click="goToLogs">
          {{ t('browserList.logs') }}
        </button>
        <button v-if="authStore.isAdmin" class="btn btn-secondary btn-sm" @click="goToStatus">
          {{ t('browserList.status') }}
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
          <div class="browser-header">
            <h3 class="browser-name">{{ browser.name }}</h3>
            <span v-if="browser.hasPassword" class="badge badge-lock">{{ t('browserList.needsPassword') }}</span>
          </div>
          <p class="browser-url">{{ browser.url }}</p>
          <div class="browser-actions">
            <button class="btn btn-primary" @click="openBrowser(browser)">
              {{ t('browserList.enterBrowser') }}
            </button>
            <template v-if="authStore.isAdmin">
              <button class="btn btn-secondary btn-sm" @click="editBrowser(browser)">
                {{ t('common.edit') }}
              </button>
              <button class="btn btn-danger btn-sm" @click="confirmDelete(browser)">
                {{ t('common.delete') }}
              </button>
            </template>
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
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import api from '../utils/api'
import { useI18n } from '../i18n'

const { t } = useI18n()
const router = useRouter()
const authStore = useAuthStore()

const browsers = ref([])
const loading = ref(true)

const showPasswordModal = ref(false)
const showAddModal = ref(false)
const showEditModal = ref(false)
const showDeleteModal = ref(false)

const selectedBrowser = ref(null)
const browserPassword = ref('')
const passwordError = ref('')
const browserToDelete = ref(null)

const form = ref({
  id: '',
  name: '',
  url: '',
  password: ''
})
const formError = ref('')

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
    password: ''
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
        password: form.value.password || undefined
      })
    } else {
      await api.post('/api/browsers', form.value)
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
  form.value = { id: '', name: '', url: '', password: '' }
  formError.value = ''
}

function goToUsers() {
  router.push('/admin/users')
}

function goToLogs() {
  router.push('/admin/logs')
}

function goToStatus() {
  router.push('/admin/status')
}

function handleLogout() {
  authStore.logout()
  router.push('/login')
}

onMounted(() => {
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

.browser-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.browser-name {
  font-size: 18px;
  font-weight: 600;
}

.browser-url {
  color: var(--text-secondary);
  font-size: 14px;
  margin-bottom: 16px;
  word-break: break-all;
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
</style>
