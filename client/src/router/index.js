import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('../views/Login.vue'),
    meta: { guest: true }
  },
  {
    path: '/',
    name: 'BrowserList',
    component: () => import('../views/BrowserList.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/browser/:id',
    name: 'BrowserView',
    component: () => import('../views/BrowserView.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/admin/users',
    name: 'AdminUsers',
    component: () => import('../views/AdminUsers.vue'),
    meta: { requiresAuth: true, requiresAdmin: true }
  },
  {
    path: '/admin/logs',
    name: 'AdminLogs',
    component: () => import('../views/AdminLogs.vue'),
    meta: { requiresAuth: true, requiresAdmin: true }
  },
  {
    path: '/admin/status',
    name: 'AdminStatus',
    component: () => import('../views/AdminStatus.vue'),
    meta: { requiresAuth: true, requiresAdmin: true }
  },
  {
    path: '/admin/calllog',
    name: 'AdminCalllog',
    component: () => import('../views/AdminCalllog.vue'),
    meta: { requiresAuth: true, requiresAdmin: true }
  },
  {
    path: '/admin/report',
    name: 'AdminReport',
    component: () => import('../views/AdminReport.vue'),
    meta: { requiresAuth: true, requiresAdmin: true }
  },
  {
    path: '/tools-help',
    redirect: '/tools-help/mcp'
  },
  {
    path: '/tools-help/:mode(mcp|ai)',
    name: 'ToolsHelp',
    component: () => import('../views/ToolsHelp.vue'),
    meta: { requiresAuth: true }
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

router.beforeEach((to, from, next) => {
  const token = localStorage.getItem('token')
  const userStr = localStorage.getItem('user')
  const user = userStr ? JSON.parse(userStr) : null
  
  if (to.meta.requiresAuth && !token) {
    next('/login')
  } else if (to.meta.guest && token) {
    next('/')
  } else if (to.meta.requiresAdmin && (!user || !user.isAdmin)) {
    next('/')
  } else {
    next()
  }
})

export default router
