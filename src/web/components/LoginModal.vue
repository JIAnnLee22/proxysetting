<script setup lang="ts">
import { ref } from 'vue'
import { api } from '../lib/api'
import { setAdminAuth } from '../lib/auth'
import { showToast } from '../lib/toast'
import Modal from './Modal.vue'
import { KeyRound, Lock, Eye, EyeOff } from '@lucide/vue'

defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', val: boolean): void
  (e: 'login-success'): void
}>()

const password = ref('')
const showPassword = ref(false)
const loading = ref(false)
const error = ref('')

function encodeCredentials(pwd: string) {
  const credentials = `admin:${pwd}`
  const encoded = btoa(
    encodeURIComponent(credentials).replace(/%([0-9A-F]{2})/g, (_, p1) =>
      String.fromCharCode(parseInt(p1, 16))
    )
  )
  return `Basic ${encoded}`
}

async function handleLogin() {
  const pwd = password.value.trim()
  if (!pwd) {
    error.value = '请输入管理员密码'
    return
  }
  loading.value = true
  error.value = ''

  try {
    const tempHeader = encodeCredentials(pwd)
    await api('login', 'POST', {}, tempHeader)
    setAdminAuth(pwd)
    showToast('管理员身份验证成功！已解锁全部管理功能', 'success')
    password.value = ''
    emit('update:modelValue', false)
    emit('login-success')
  } catch (e: any) {
    error.value = e.message || '密码错误或管理员验证失败'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <Modal
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    title="管理员身份验证"
    max-width="md"
  >
    <form @submit.prevent="handleLogin" class="space-y-4">
      <div class="flex items-center gap-3 p-3 rounded-xl bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900/60 text-xs text-blue-800 dark:text-blue-300">
        <KeyRound class="w-4 h-4 shrink-0 text-blue-600 dark:text-blue-400" />
        <div>输入控制台管理员密码即可解锁 VPS 节点管理与用户额度配置权限。</div>
      </div>

      <div>
        <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
          管理员密码
        </label>
        <div class="relative">
          <input
            v-model="password"
            :type="showPassword ? 'text' : 'password'"
            required
            autofocus
            placeholder="请输入管理员密码..."
            class="w-full pl-9 pr-10 py-2.5 text-sm rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
          />
          <Lock class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <button
            type="button"
            @click="showPassword = !showPassword"
            class="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
          >
            <EyeOff v-if="showPassword" class="w-4 h-4" />
            <Eye v-else class="w-4 h-4" />
          </button>
        </div>
        <p v-if="error" class="text-xs text-rose-500 font-medium mt-1.5">
          {{ error }}
        </p>
      </div>

      <div class="pt-2 flex justify-end gap-2.5">
        <button
          type="button"
          @click="$emit('update:modelValue', false)"
          class="px-4 py-2 text-sm font-medium rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition-colors cursor-pointer"
        >
          取消
        </button>
        <button
          type="submit"
          :disabled="loading || !password.trim()"
          class="px-5 py-2 text-sm font-semibold rounded-xl text-white bg-blue-600 hover:bg-blue-700 active:scale-95 shadow-md shadow-blue-500/20 disabled:opacity-50 transition-all cursor-pointer"
        >
          {{ loading ? '验证中...' : '确认登录' }}
        </button>
      </div>
    </form>
  </Modal>
</template>
