<script setup lang="ts">
import { ref, computed } from 'vue'
import { api } from '../lib/api'
import { showToast } from '../lib/toast'
import {
  FileCode,
  Download,
  Copy,
  Check,
  ShieldAlert,
  Sparkles,
  Terminal
} from '@lucide/vue'

const props = defineProps<{
  state: any
}>()

const selectedIdentity = ref(props.state?.identities?.[0]?.id || '')
const generating = ref(false)
const scriptContent = ref('')
const copied = ref(false)

const enabledIdentities = computed(() => {
  return (props.state?.identities || []).filter((i: any) => i.enabled)
})

async function handleGenerate() {
  if (!selectedIdentity.value) {
    showToast('请选择要导出的身份', 'warning')
    return
  }
  generating.value = true
  copied.value = false
  try {
    const res = await api(`export?identity=${encodeURIComponent(selectedIdentity.value)}`)
    scriptContent.value = res
    showToast('脚本生成成功！', 'success')
  } catch (e: any) {
    showToast(e.message || '导出脚本失败', 'error')
  } finally {
    generating.value = false
  }
}

async function handleCopy() {
  if (!scriptContent.value) return
  await navigator.clipboard.writeText(scriptContent.value)
  copied.value = true
  showToast('Clash Verge Rev 扩展脚本已复制到剪贴板', 'success')
  setTimeout(() => {
    copied.value = false
  }, 3000)
}

function handleDownload() {
  if (!scriptContent.value) return
  const blob = new Blob([scriptContent.value], { type: 'application/javascript;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'proxysetting-verge.js'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
  showToast('已开始下载 proxysetting-verge.js', 'success')
}
</script>

<template>
  <div class="space-y-6 max-w-4xl mx-auto">
    <div class="p-6 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm">
      <div class="flex items-start gap-4 mb-6">
        <div class="w-12 h-12 rounded-2xl bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
          <FileCode class="w-6 h-6" />
        </div>
        <div>
          <h2 class="text-lg font-bold text-slate-900 dark:text-white tracking-tight">
            导出 Clash Verge Rev 扩展配置脚本
          </h2>
          <p class="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
            生成针对 Clash Verge Rev 的 Script 扩展配置，自动注入当前身份已授权的所有 Reality 节点及密钥，实现一键无感接入。
          </p>
        </div>
      </div>

      <!-- Generator Controls -->
      <div class="space-y-4">
        <div>
          <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
            选择目标用户身份
          </label>
          <div class="flex flex-col sm:flex-row gap-3">
            <select
              v-model="selectedIdentity"
              class="flex-1 px-3.5 py-2.5 text-sm rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all cursor-pointer"
            >
              <option value="" disabled>-- 请选择身份 --</option>
              <option
                v-for="id in state?.identities || []"
                :key="id.id"
                :value="id.id"
              >
                {{ id.name }} {{ id.enabled ? '(已启用)' : '(已停用 - 无法联网)' }}
              </option>
            </select>

            <button
              @click="handleGenerate"
              :disabled="!selectedIdentity || generating"
              class="flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 active:scale-95 shadow-md shadow-blue-500/20 disabled:opacity-50 transition-all cursor-pointer shrink-0"
            >
              <Sparkles class="w-4 h-4" />
              <span>{{ generating ? '生成中...' : '生成扩展脚本' }}</span>
            </button>
          </div>
        </div>

        <!-- Security Notice -->
        <div class="p-3.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/60 text-amber-800 dark:text-amber-200 text-xs flex items-start gap-2.5">
          <ShieldAlert class="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div class="leading-relaxed">
            <b>安全提醒：</b> 生成的脚本中包含解密后的专有 Reality 私有凭证与短 ID。请妥善保管，切勿在公开网络或不受信任的设备上传播。
          </div>
        </div>
      </div>

      <!-- Script Output Window -->
      <div v-if="scriptContent" class="mt-6 space-y-3">
        <div class="flex items-center justify-between">
          <span class="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
            <Terminal class="w-3.5 h-3.5" />
            <span>proxysetting-verge.js 脚本内容预览</span>
          </span>

          <div class="flex items-center gap-2">
            <button
              @click="handleCopy"
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors cursor-pointer"
            >
              <Check v-if="copied" class="w-3.5 h-3.5 text-emerald-500" />
              <Copy v-else class="w-3.5 h-3.5" />
              <span>{{ copied ? '已复制' : '复制全文' }}</span>
            </button>

            <button
              @click="handleDownload"
              class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 active:scale-95 shadow-sm shadow-emerald-500/20 transition-all cursor-pointer"
            >
              <Download class="w-3.5 h-3.5" />
              <span>下载脚本文件</span>
            </button>
          </div>
        </div>

        <div class="relative rounded-xl overflow-hidden border border-slate-800 bg-slate-950">
          <textarea
            readonly
            :value="scriptContent"
            rows="14"
            class="w-full p-4 font-mono text-xs text-slate-200 bg-transparent resize-y outline-none leading-relaxed select-all"
          ></textarea>
        </div>
      </div>
    </div>
  </div>
</template>
