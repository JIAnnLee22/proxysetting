import { ref } from 'vue'

export const isDark = ref(false)

export function initTheme() {
  const saved = localStorage.getItem('proxysetting_theme')
  if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    isDark.value = true
    document.documentElement.classList.add('dark')
  } else {
    isDark.value = false
    document.documentElement.classList.remove('dark')
  }
}

export function toggleTheme() {
  isDark.value = !isDark.value
  if (isDark.value) {
    document.documentElement.classList.add('dark')
    localStorage.setItem('proxysetting_theme', 'dark')
  } else {
    document.documentElement.classList.remove('dark')
    localStorage.setItem('proxysetting_theme', 'light')
  }
}
