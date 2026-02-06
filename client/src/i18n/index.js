import { ref } from 'vue'
import zhCN from './zh-CN'
import en from './en'

const messages = { 'zh-CN': zhCN, en }

// Detect browser language
function detectLanguage() {
  const saved = localStorage.getItem('locale')
  if (saved && messages[saved]) return saved

  const browserLang = navigator.language || navigator.languages?.[0] || 'en'
  if (browserLang.startsWith('zh')) return 'zh-CN'
  return 'en'
}

export const currentLocale = ref(detectLanguage())

export function setLocale(lang) {
  if (messages[lang]) {
    currentLocale.value = lang
    localStorage.setItem('locale', lang)
  }
}

export function t(key, params) {
  const keys = key.split('.')
  let val = messages[currentLocale.value]
  for (const k of keys) {
    val = val?.[k]
  }
  // Fallback to English
  if (val === undefined) {
    val = messages.en
    for (const k of keys) {
      val = val?.[k]
    }
  }
  // Fallback to key
  if (val === undefined) return key

  // Template substitution: {name} -> params.name
  if (params && typeof val === 'string') {
    return val.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? '')
  }
  return val
}

export function useI18n() {
  return { t, locale: currentLocale, setLocale }
}

export const availableLocales = [
  { code: 'zh-CN', label: '中文' },
  { code: 'en', label: 'English' },
]
