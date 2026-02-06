import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import api from '../utils/api'

export const useAuthStore = defineStore('auth', () => {
  const user = ref(null)
  const token = ref(localStorage.getItem('token'))
  
  const isLoggedIn = computed(() => !!token.value)
  const isAdmin = computed(() => user.value?.isAdmin ?? false)
  
  async function login(username, password) {
    const response = await api.post('/api/auth/login', { username, password })
    token.value = response.data.token
    user.value = response.data.user
    
    localStorage.setItem('token', response.data.token)
    localStorage.setItem('user', JSON.stringify(response.data.user))
    
    return response.data
  }
  
  async function verifyToken() {
    if (!token.value) {
      throw new Error('No token')
    }
    
    const response = await api.get('/api/auth/verify')
    user.value = response.data.user
    localStorage.setItem('user', JSON.stringify(response.data.user))
    
    return response.data
  }
  
  function logout() {
    token.value = null
    user.value = null
    localStorage.removeItem('token')
    localStorage.removeItem('user')
  }
  
  // 初始化时恢复用户信息
  const savedUser = localStorage.getItem('user')
  if (savedUser) {
    user.value = JSON.parse(savedUser)
  }
  
  return {
    user,
    token,
    isLoggedIn,
    isAdmin,
    login,
    verifyToken,
    logout
  }
})
