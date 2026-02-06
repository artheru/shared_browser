<template>
  <div class="admin-users-page">
    <header class="header">
      <h1>{{ t('adminUsers.title') }}</h1>
      <div class="header-actions">
        <button class="btn btn-secondary btn-sm" @click="goBack">
          {{ t('adminUsers.backToBrowsers') }}
        </button>
      </div>
    </header>
    
    <div class="container">
      <div class="page-header">
        <h2 class="page-title">{{ t('adminUsers.userList') }}</h2>
        <button class="btn btn-primary" @click="showAddModal = true">
          {{ t('adminUsers.addUser') }}
        </button>
      </div>
      
      <div v-if="loading" class="loading">{{ t('common.loading') }}</div>
      
      <div v-else class="card">
        <table>
          <thead>
            <tr>
              <th>{{ t('adminUsers.colId') }}</th>
              <th>{{ t('adminUsers.colUsername') }}</th>
              <th>{{ t('adminUsers.colRole') }}</th>
              <th>{{ t('adminUsers.colActions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="user in users" :key="user.id">
              <td>{{ user.id }}</td>
              <td>{{ user.username }}</td>
              <td>
                <span v-if="user.isAdmin" class="badge badge-admin">{{ t('adminUsers.admin') }}</span>
                <span v-else>{{ t('adminUsers.regularUser') }}</span>
              </td>
              <td>
                <div class="actions">
                  <button class="btn btn-secondary btn-sm" @click="editUser(user)">
                    {{ t('common.edit') }}
                  </button>
                  <button
                    class="btn btn-danger btn-sm"
                    @click="confirmDelete(user)"
                    :disabled="user.id === currentUserId"
                  >
                    {{ t('common.delete') }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        
        <div v-if="users.length === 0" class="empty-state">
          {{ t('adminUsers.noUsers') }}
        </div>
      </div>
    </div>
    
    <!-- Add/Edit user modal -->
    <div v-if="showAddModal || showEditModal" class="modal-overlay" @click.self="closeModal">
      <div class="modal">
        <div class="modal-header">
          <h3>{{ showEditModal ? t('adminUsers.editUser') : t('adminUsers.addUserTitle') }}</h3>
          <button class="modal-close" @click="closeModal">&times;</button>
        </div>
        <form @submit.prevent="saveUser">
          <div class="form-group">
            <label>{{ t('adminUsers.colUsername') }}</label>
            <input
              v-model="form.username"
              type="text"
              class="input"
              :placeholder="t('adminUsers.usernamePlaceholder')"
              required
            />
          </div>
          <div class="form-group">
            <label>{{ showEditModal ? t('adminUsers.newPasswordHint') : t('login.password') }}</label>
            <input
              v-model="form.password"
              type="password"
              class="input"
              :placeholder="showEditModal ? t('adminUsers.leaveEmptyPassword') : t('login.passwordPlaceholder')"
              :required="!showEditModal"
            />
          </div>
          <div class="form-group">
            <label class="checkbox-label">
              <input v-model="form.isAdmin" type="checkbox" />
              <span>{{ t('adminUsers.adminPrivileges') }}</span>
            </label>
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
          <h3>{{ t('adminUsers.confirmDelete') }}</h3>
          <button class="modal-close" @click="showDeleteModal = false">&times;</button>
        </div>
        <p>{{ t('adminUsers.confirmDeleteUser', { username: userToDelete?.username }) }}</p>
        <div class="modal-footer">
          <button class="btn btn-secondary" @click="showDeleteModal = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-danger" @click="deleteUser">{{ t('common.delete') }}</button>
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

const users = ref([])
const loading = ref(true)

const showAddModal = ref(false)
const showEditModal = ref(false)
const showDeleteModal = ref(false)

const userToDelete = ref(null)
const editingUserId = ref(null)

const form = ref({
  username: '',
  password: '',
  isAdmin: false
})
const formError = ref('')

const currentUserId = computed(() => authStore.user?.id)

async function loadUsers() {
  loading.value = true
  try {
    const response = await api.get('/api/users')
    users.value = response.data
  } catch (e) {
    console.error('Failed to load user list:', e)
  } finally {
    loading.value = false
  }
}

function editUser(user) {
  editingUserId.value = user.id
  form.value = {
    username: user.username,
    password: '',
    isAdmin: user.isAdmin
  }
  formError.value = ''
  showEditModal.value = true
}

function confirmDelete(user) {
  userToDelete.value = user
  showDeleteModal.value = true
}

async function saveUser() {
  formError.value = ''
  
  try {
    if (showEditModal.value) {
      const updates = {
        username: form.value.username,
        isAdmin: form.value.isAdmin
      }
      if (form.value.password) {
        updates.password = form.value.password
      }
      await api.put(`/api/users/${editingUserId.value}`, updates)
    } else {
      await api.post('/api/users', form.value)
    }
    
    closeModal()
    await loadUsers()
  } catch (e) {
    formError.value = e.response?.data?.error || t('adminUsers.saveFailed')
  }
}

async function deleteUser() {
  try {
    await api.delete(`/api/users/${userToDelete.value.id}`)
    showDeleteModal.value = false
    await loadUsers()
  } catch (e) {
    console.error('Delete failed:', e.response?.data?.error || e.message)
    alert(e.response?.data?.error || t('adminUsers.deleteFailed'))
  }
}

function closeModal() {
  showAddModal.value = false
  showEditModal.value = false
  editingUserId.value = null
  form.value = { username: '', password: '', isAdmin: false }
  formError.value = ''
}

function goBack() {
  router.push('/')
}

onMounted(() => {
  loadUsers()
})
</script>

<style scoped>
.admin-users-page {
  min-height: 100vh;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.checkbox-label input {
  width: 18px;
  height: 18px;
}

.empty-state {
  text-align: center;
  padding: 40px;
  color: var(--text-secondary);
}
</style>
