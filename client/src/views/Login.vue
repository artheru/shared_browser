<template>
  <div class="login-page">
    <div class="login-card">
      <h1 class="login-title">{{ t('login.title') }}</h1>
      <p class="login-subtitle">{{ t('login.subtitle') }}</p>
      
      <form @submit.prevent="handleLogin" class="login-form">
        <div v-if="error" class="error-message">
          {{ error }}
        </div>
        
        <div class="form-group">
          <label for="username">{{ t('login.username') }}</label>
          <input
            id="username"
            v-model="username"
            type="text"
            class="input"
            :placeholder="t('login.usernamePlaceholder')"
            required
            autofocus
          />
        </div>
        
        <div class="form-group">
          <label for="password">{{ t('login.password') }}</label>
          <input
            id="password"
            v-model="password"
            type="password"
            class="input"
            :placeholder="t('login.passwordPlaceholder')"
            required
          />
        </div>
        
        <button type="submit" class="btn btn-primary login-btn" :disabled="loading">
          {{ loading ? t('login.loggingIn') : t('login.loginBtn') }}
        </button>
      </form>
      
      <div class="login-footer">
        <p class="login-hint">{{ t('login.hint') }}</p>
        <div class="locale-switcher">
          <button
            v-for="loc in availableLocales"
            :key="loc.code"
            class="locale-btn"
            :class="{ active: locale.value === loc.code }"
            @click="setLocale(loc.code)"
          >{{ loc.label }}</button>
        </div>
        <p v-if="appVersion" class="version-info">v{{ appVersion }}</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useI18n, availableLocales } from '../i18n'
import api from '../utils/api'

const { t, locale, setLocale } = useI18n()
const router = useRouter()
const authStore = useAuthStore()

const username = ref('')
const password = ref('')
const loading = ref(false)
const error = ref('')
const appVersion = ref('')

onMounted(async () => {
  try {
    const res = await api.get('/api/version')
    appVersion.value = res.data.version
  } catch (e) {
    // version API not available
  }
})

async function handleLogin() {
  if (loading.value) return
  
  loading.value = true
  error.value = ''
  
  try {
    await authStore.login(username.value, password.value)
    router.push('/')
  } catch (e) {
    error.value = e.response?.data?.error || t('login.failed')
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
}

.login-card {
  background: white;
  border-radius: 16px;
  padding: 40px;
  width: 100%;
  max-width: 400px;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.2);
}

.login-title {
  font-size: 28px;
  font-weight: 700;
  text-align: center;
  margin-bottom: 8px;
  color: #333;
}

.login-subtitle {
  text-align: center;
  color: #666;
  margin-bottom: 32px;
}

.login-form {
  display: flex;
  flex-direction: column;
}

.login-btn {
  width: 100%;
  padding: 14px;
  font-size: 16px;
  margin-top: 8px;
}

.login-footer {
  margin-top: 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.login-hint {
  text-align: center;
  font-size: 12px;
  color: #999;
}

.locale-switcher {
  display: flex;
  gap: 8px;
}

.locale-btn {
  background: none;
  border: 1px solid #ddd;
  border-radius: 6px;
  padding: 4px 12px;
  font-size: 12px;
  color: #666;
  cursor: pointer;
  transition: all 0.2s;
}

.locale-btn:hover {
  border-color: #999;
  color: #333;
}

.locale-btn.active {
  background: var(--primary-color);
  border-color: var(--primary-color);
  color: white;
}

.version-info {
  font-size: 11px;
  color: #bbb;
  margin-top: 4px;
}
</style>
