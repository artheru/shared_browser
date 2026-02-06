<template>
  <router-view />
</template>

<script setup>
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from './stores/auth'

const router = useRouter()
const authStore = useAuthStore()

onMounted(async () => {
  // 尝试恢复登录状态
  const token = localStorage.getItem('token')
  if (token) {
    try {
      await authStore.verifyToken()
    } catch (e) {
      localStorage.removeItem('token')
      router.push('/login')
    }
  }
})
</script>
