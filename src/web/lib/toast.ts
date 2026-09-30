import { ref } from 'vue'

export interface ToastItem {
  id: number
  message: string
  type: 'success' | 'error' | 'info' | 'warning'
}

export const toasts = ref<ToastItem[]>([])

let toastId = 0

export function showToast(message: string, type: 'success' | 'error' | 'info' | 'warning' = 'info', duration = 3500) {
  const id = ++toastId
  toasts.value.push({ id, message, type })
  setTimeout(() => {
    removeToast(id)
  }, duration)
}

export function removeToast(id: number) {
  toasts.value = toasts.value.filter(t => t.id !== id)
}
