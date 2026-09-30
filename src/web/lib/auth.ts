import { ref } from 'vue'

const AUTH_STORAGE_KEY = 'proxysetting_admin_auth'

export const isAdmin = ref(false)
export const adminAuthHeader = ref<string | null>(null)

export function initAuth() {
  const saved = sessionStorage.getItem(AUTH_STORAGE_KEY)
  if (saved) {
    adminAuthHeader.value = saved
    isAdmin.value = true
  } else {
    adminAuthHeader.value = null
    isAdmin.value = false
  }
}

export function setAdminAuth(password: string) {
  // Use UTF-8 safe base64 encoding
  const credentials = `admin:${password}`
  const encoded = btoa(
    encodeURIComponent(credentials).replace(/%([0-9A-F]{2})/g, (_, p1) =>
      String.fromCharCode(parseInt(p1, 16))
    )
  )
  const header = `Basic ${encoded}`
  adminAuthHeader.value = header
  isAdmin.value = true
  sessionStorage.setItem(AUTH_STORAGE_KEY, header)
}

export function clearAdminAuth() {
  adminAuthHeader.value = null
  isAdmin.value = false
  sessionStorage.removeItem(AUTH_STORAGE_KEY)
}
