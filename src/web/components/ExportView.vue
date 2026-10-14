<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { api } from '../lib/api'
import { showToast } from '../lib/toast'
import {
  FileCode,
  Download,
  Copy,
  Check,
  ShieldAlert,
  Sparkles,
  Terminal,
  Server,
  Link,
  ExternalLink,
  Radio,
  FileText,
  HelpCircle,
  Eye,
  Sliders,
  RotateCcw,
  Save
} from '@lucide/vue'
import { bytesToGiB } from '../lib/analytics'

const props = defineProps<{
  state: any
}>()

const activeTab = ref<'sub' | 'template' | 'script'>('sub')
const selectedIdentity = ref(props.state?.identities?.[0]?.id || '')

// Subscription Template Customization States
const templateContent = ref('')
const isCustomTemplate = ref(false)
const loadingTemplate = ref(false)
const savingTemplate = ref(false)
const resetConfirm = ref(false)

async function fetchTemplate() {
  loadingTemplate.value = true
  try {
    const res = await api('sub-template')
    templateContent.value = res.template
    isCustomTemplate.value = res.isCustom
  } catch (e: any) {
    showToast(e.message || '获取配置模板失败', 'error')
  } finally {
    loadingTemplate.value = false
  }
}

async function handleSaveTemplate() {
  if (!templateContent.value.trim()) {
    showToast('模板内容不能为空', 'warning')
    return
  }
  savingTemplate.value = true
  try {
    const res = await api('sub-template', 'PUT', { template: templateContent.value })
    templateContent.value = res.template
    isCustomTemplate.value = res.isCustom
    yamlContent.value = ''
    showToast('自定义订阅模板已保存并生效！', 'success')
  } catch (e: any) {
    showToast(e.message || '保存配置模板失败', 'error')
  } finally {
    savingTemplate.value = false
  }
}

async function handleResetTemplate() {
  savingTemplate.value = true
  try {
    const res = await api('sub-template', 'PUT', { template: null })
    templateContent.value = res.template
    isCustomTemplate.value = false
    resetConfirm.value = false
    yamlContent.value = ''
    showToast('已成功重置为系统默认订阅模板', 'success')
  } catch (e: any) {
    showToast(e.message || '重置配置模板失败', 'error')
  } finally {
    savingTemplate.value = false
  }
}

watch(activeTab, (tab) => {
  if (tab === 'template' && !templateContent.value) {
    fetchTemplate()
  }
})

// Watch if state changes and selectedIdentity is empty
watch(() => props.state?.identities, (ids) => {
  if (!selectedIdentity.value && ids?.length > 0) {
    selectedIdentity.value = ids[0].id
  }
}, { immediate: true })

const selectedIdentityObj = computed(() => {
  return (props.state?.identities || []).find((i: any) => i.id === selectedIdentity.value)
})

// Subscription URL
const subscriptionUrl = computed(() => {
  if (!selectedIdentity.value) return ''
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return `${origin}/api/sub?token=${encodeURIComponent(selectedIdentity.value)}`
})

// Clash One-click Import Scheme
const clashImportUrl = computed(() => {
  if (!subscriptionUrl.value) return ''
  const name = selectedIdentityObj.value?.name || 'Proxysetting'
  return `clash://install-config?url=${encodeURIComponent(subscriptionUrl.value)}&name=${encodeURIComponent('Proxysetting - ' + name)}`
})

// Subscription Copy State
const copiedSub = ref(false)
async function handleCopySub() {
  if (!subscriptionUrl.value) return
  try {
    await navigator.clipboard.writeText(subscriptionUrl.value)
    copiedSub.value = true
    showToast('Clash Verge 订阅链接已复制到剪贴板！', 'success')
    setTimeout(() => {
      copiedSub.value = false
    }, 3000)
  } catch {
    showToast('复制失败，请手动选择复制', 'error')
  }
}

// Subscription YAML Preview / Download
const loadingYaml = ref(false)
const yamlContent = ref('')
const copiedYaml = ref(false)
const showYamlPreview = ref(false)

async function handleFetchYaml() {
  if (!selectedIdentity.value) {
    showToast('请选择目标用户身份', 'warning')
    return
  }
  loadingYaml.value = true
  copiedYaml.value = false
  try {
    const res = await api(`export?identity=${encodeURIComponent(selectedIdentity.value)}&format=clash`)
    yamlContent.value = res
    showYamlPreview.value = true
    showToast('已成功获取 Clash Verge 订阅配置！', 'success')
  } catch (e: any) {
    showToast(parseError(e.message || '获取订阅配置失败'), 'error', 4500)
  } finally {
    loadingYaml.value = false
  }
}

async function handleCopyYaml() {
  if (!yamlContent.value) return
  await navigator.clipboard.writeText(yamlContent.value)
  copiedYaml.value = true
  showToast('Clash 配置全文已复制到剪贴板', 'success')
  setTimeout(() => {
    copiedYaml.value = false
  }, 3000)
}

function handleDownloadYaml() {
  if (!yamlContent.value) return
  const blob = new Blob([yamlContent.value], { type: 'text/yaml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const name = selectedIdentityObj.value?.name || 'config'
  a.download = `clash-verge-${name}.yaml`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
  showToast('已开始下载 clash-verge 配置文件', 'success')
}

// Script Export States
const generatingScript = ref(false)
const scriptContent = ref('')
const copiedScript = ref(false)

async function handleGenerateScript() {
  if (!selectedIdentity.value) {
    showToast('请选择要导出的身份', 'warning')
    return
  }
  generatingScript.value = true
  copiedScript.value = false
  try {
    const res = await api(`export?identity=${encodeURIComponent(selectedIdentity.value)}`)
    scriptContent.value = res
    showToast('脚本生成成功！', 'success')
  } catch (e: any) {
    showToast(parseError(e.message || '导出脚本失败'), 'error', 4500)
  } finally {
    generatingScript.value = false
  }
}

async function handleCopyScript() {
  if (!scriptContent.value) return
  await navigator.clipboard.writeText(scriptContent.value)
  copiedScript.value = true
  showToast('Clash Verge Rev 扩展脚本已复制到剪贴板', 'success')
  setTimeout(() => {
    copiedScript.value = false
  }, 3000)
}

function handleDownloadScript() {
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

function parseError(msg: string) {
  if (msg.includes('is not ready or missing Reality parameters')) {
    return '有节点尚未安装就绪或未完成部署，请检查 VPS 节点状态'
  }
  if (msg.includes('Monthly quota missing')) {
    return '该身份在部分节点上尚未分配月额度，请在“身份与额度”页面设置配额'
  }
  return msg
}

// Nodes overview for selected identity
const selectedIdentityNodes = computed(() => {
  if (!selectedIdentity.value || !props.state?.vps) return []
  return props.state.vps.map((v: any) => {
    const grant = props.state.grants?.find((g: any) => g.vps_id === v.id && g.identity_id === selectedIdentity.value)
    return {
      id: v.id,
      name: v.name,
      address: v.address,
      port: v.port,
      status: v.status,
      quotaGiB: grant ? bytesToGiB(grant.quota_bytes, 1) : null
    }
  })
})
</script>

<template>
  <div class="space-y-6 max-w-4xl mx-auto">
    <div class="p-6 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm">
      <!-- Header -->
      <div class="flex items-start gap-4 mb-6">
        <div class="w-12 h-12 rounded-2xl bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
          <Radio class="w-6 h-6" />
        </div>
        <div>
          <h2 class="text-lg font-bold text-slate-900 dark:text-white tracking-tight">
            订阅与配置导出
          </h2>
          <p class="text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
            为指定用户生成专属 Clash Verge 订阅链接或扩展配置脚本，自动集成其授权的全部 Reality 节点及完整分流策略。
          </p>
        </div>
      </div>

      <!-- Identity Selection & Mode Tabs -->
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
          </div>
        </div>

        <!-- Export Format Toggle -->
        <div class="flex items-center p-1 bg-slate-100 dark:bg-slate-800/80 rounded-xl max-w-lg">
          <button
            @click="activeTab = 'sub'"
            class="flex-1 flex items-center justify-center gap-1.5 py-2 px-3 text-xs font-semibold rounded-lg transition-all cursor-pointer"
            :class="activeTab === 'sub' ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'"
          >
            <Link class="w-3.5 h-3.5" />
            <span>订阅链接</span>
          </button>
          <button
            @click="activeTab = 'template'"
            class="flex-1 flex items-center justify-center gap-1.5 py-2 px-3 text-xs font-semibold rounded-lg transition-all cursor-pointer"
            :class="activeTab === 'template' ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'"
          >
            <Sliders class="w-3.5 h-3.5" />
            <span>自定义模板</span>
          </button>
          <button
            @click="activeTab = 'script'"
            class="flex-1 flex items-center justify-center gap-1.5 py-2 px-3 text-xs font-semibold rounded-lg transition-all cursor-pointer"
            :class="activeTab === 'script' ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'"
          >
            <FileCode class="w-3.5 h-3.5" />
            <span>扩展脚本</span>
          </button>
        </div>

        <!-- Authorized Nodes Status Indicator -->
        <div v-if="selectedIdentityNodes.length > 0" class="p-4 rounded-xl bg-slate-50/70 dark:bg-slate-800/40 border border-slate-200/70 dark:border-slate-800">
          <div class="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2 flex items-center justify-between">
            <span class="flex items-center gap-1.5">
              <Server class="w-3.5 h-3.5 text-blue-500" />
              <span>该身份的节点授权与就绪状态</span>
            </span>
            <span class="text-[11px] text-slate-400 font-normal">共 {{ selectedIdentityNodes.length }} 个节点</span>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div
              v-for="node in selectedIdentityNodes"
              :key="node.id"
              class="px-3 py-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-200/60 dark:border-slate-800 flex items-center justify-between text-xs"
            >
              <div class="flex items-center gap-2">
                <span
                  class="w-2 h-2 rounded-full"
                  :class="[
                    node.status === 'ready' ? 'bg-emerald-500' :
                    node.status === 'syncing' ? 'bg-blue-500 animate-pulse' :
                    node.status === 'pending' ? 'bg-amber-500' :
                    'bg-slate-400'
                  ]"
                ></span>
                <span class="font-medium text-slate-800 dark:text-slate-200">{{ node.name }}</span>
                <span class="text-[11px] font-mono text-slate-400">({{ node.status }})</span>
              </div>

              <div>
                <span
                  v-if="node.quotaGiB !== null"
                  class="text-[11px] font-semibold text-blue-600 dark:text-blue-400"
                >
                  {{ node.quotaGiB }} GiB
                </span>
                <span
                  v-else
                  class="text-[11px] text-rose-500 font-medium"
                >
                  未分配月额度
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- Panel 1: Subscription URL Feature -->
        <div v-if="activeTab === 'sub'" class="space-y-4 pt-2">
          <div class="p-4 rounded-xl border border-blue-100 dark:border-blue-900/50 bg-blue-50/50 dark:bg-blue-950/20 space-y-3">
            <div class="flex items-center justify-between">
              <span class="text-xs font-bold text-blue-900 dark:text-blue-200 flex items-center gap-1.5">
                <Link class="w-4 h-4 text-blue-600 dark:text-blue-400" />
                <span>Clash Verge 专用订阅链接</span>
              </span>
              <span class="text-[11px] text-blue-600 dark:text-blue-400">包含完整国内分流与该用户专属节点</span>
            </div>

            <!-- URL Display & Copy -->
            <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              <div class="flex-1 relative">
                <input
                  type="text"
                  readonly
                  :value="subscriptionUrl"
                  placeholder="请先选择用户身份"
                  class="w-full px-3.5 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 focus:outline-none select-all"
                />
              </div>

              <div class="flex items-center gap-2 shrink-0">
                <button
                  @click="handleCopySub"
                  :disabled="!subscriptionUrl"
                  class="flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 active:scale-95 shadow-sm shadow-blue-500/20 disabled:opacity-50 transition-all cursor-pointer"
                >
                  <Check v-if="copiedSub" class="w-3.5 h-3.5 text-emerald-300" />
                  <Copy v-else class="w-3.5 h-3.5" />
                  <span>{{ copiedSub ? '已复制' : '复制订阅链接' }}</span>
                </button>

                <a
                  v-if="clashImportUrl"
                  :href="clashImportUrl"
                  class="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-blue-700 dark:text-blue-300 bg-blue-100 dark:bg-blue-900/60 hover:bg-blue-200 dark:hover:bg-blue-900 transition-colors cursor-pointer"
                  title="一键调起 Clash Verge 导入"
                >
                  <ExternalLink class="w-3.5 h-3.5" />
                  <span>一键导入</span>
                </a>
              </div>
            </div>

            <!-- Quick Action Buttons -->
            <div class="flex flex-wrap items-center gap-2 pt-1 border-t border-blue-200/50 dark:border-blue-900/40">
              <button
                @click="handleFetchYaml"
                :disabled="!selectedIdentity || loadingYaml"
                class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 transition-colors cursor-pointer disabled:opacity-50"
              >
                <Eye class="w-3.5 h-3.5 text-slate-500" />
                <span>{{ loadingYaml ? '拉取中...' : '预览订阅配置 (YAML)' }}</span>
              </button>

              <button
                v-if="yamlContent"
                @click="handleDownloadYaml"
                class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/50 hover:bg-emerald-100 border border-emerald-200 dark:border-emerald-800 transition-colors cursor-pointer"
              >
                <Download class="w-3.5 h-3.5" />
                <span>下载 .yaml 配置文件</span>
              </button>
            </div>
          </div>

          <!-- Usage Instructions -->
          <div class="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200/80 dark:border-slate-800 text-xs space-y-2 text-slate-600 dark:text-slate-400">
            <div class="font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
              <HelpCircle class="w-4 h-4 text-blue-500" />
              <span>如何在 Clash Verge / Mihomo 中使用？</span>
            </div>
            <ol class="list-decimal list-inside space-y-1 pl-1 leading-relaxed">
              <li>点击 <b>“复制订阅链接”</b> 或直接点击 <b>“一键导入”</b> 唤起客户端。</li>
              <li>若手动添加：打开 Clash Verge 客户端，进入 <b>订阅 (Subscription)</b> 页面，点击 <b>新建</b>，类型选择 <b>URL</b>，将此链接粘贴进 URL 栏并保存。</li>
              <li>点击右键 <b>更新</b> 订阅配置，确保模式选择 <b>“规则 (Rule)”</b>。</li>
              <li>在 <b>“代理选择 (PROXY)”</b> 策略组中选择分配给该用户的节点（直连请选 DIRECT）。</li>
            </ol>
          </div>

          <!-- YAML Preview Window -->
          <div v-if="showYamlPreview && yamlContent" class="space-y-3 pt-2">
            <div class="flex items-center justify-between">
              <span class="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
                <FileText class="w-3.5 h-3.5" />
                <span>Clash Verge YAML 配置预览</span>
              </span>

              <div class="flex items-center gap-2">
                <button
                  @click="handleCopyYaml"
                  class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors cursor-pointer"
                >
                  <Check v-if="copiedYaml" class="w-3.5 h-3.5 text-emerald-500" />
                  <Copy v-else class="w-3.5 h-3.5" />
                  <span>{{ copiedYaml ? '已复制' : '复制 YAML 全文' }}</span>
                </button>

                <button
                  @click="handleDownloadYaml"
                  class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 active:scale-95 shadow-sm shadow-emerald-500/20 transition-all cursor-pointer"
                >
                  <Download class="w-3.5 h-3.5" />
                  <span>下载 YAML 文件</span>
                </button>
              </div>
            </div>

            <div class="relative rounded-xl overflow-hidden border border-slate-800 bg-slate-950">
              <textarea
                readonly
                :value="yamlContent"
                rows="16"
                class="w-full p-4 font-mono text-xs text-slate-200 bg-transparent resize-y outline-none leading-relaxed select-all"
              ></textarea>
            </div>
          </div>
        </div>

        <!-- Panel 2: Subscription Template Customization -->
        <div v-if="activeTab === 'template'" class="space-y-4 pt-2">
          <div class="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/40 space-y-3">
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div class="flex items-center gap-2">
                <Sliders class="w-4 h-4 text-blue-600 dark:text-blue-400" />
                <span class="text-xs font-bold text-slate-800 dark:text-slate-200">
                  订阅基础配置模板 (Clash / Mihomo YAML)
                </span>
                <span
                  class="text-[11px] px-2 py-0.5 rounded-full font-semibold"
                  :class="isCustomTemplate ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300' : 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300'"
                >
                  {{ isCustomTemplate ? '管理员自定义模板' : '系统内置默认模板' }}
                </span>
              </div>

              <div class="flex items-center gap-2">
                <button
                  v-if="isCustomTemplate && !resetConfirm"
                  @click="resetConfirm = true"
                  class="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-rose-600 hover:text-rose-700 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-lg transition-colors cursor-pointer"
                >
                  <RotateCcw class="w-3.5 h-3.5" />
                  <span>恢复默认</span>
                </button>
                <div v-if="resetConfirm" class="flex items-center gap-1.5">
                  <span class="text-[11px] text-rose-600 font-medium">确认重置？</span>
                  <button
                    @click="handleResetTemplate"
                    :disabled="savingTemplate"
                    class="px-2 py-0.5 text-[11px] font-semibold bg-rose-600 hover:bg-rose-700 text-white rounded cursor-pointer"
                  >
                    确定
                  </button>
                  <button
                    @click="resetConfirm = false"
                    class="px-2 py-0.5 text-[11px] text-slate-500 hover:text-slate-700 cursor-pointer"
                  >
                    取消
                  </button>
                </div>
                <button
                  @click="fetchTemplate"
                  :disabled="loadingTemplate"
                  class="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-slate-600 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-slate-700 rounded-lg transition-colors cursor-pointer"
                  title="重新从服务器加载"
                >
                  <RotateCcw class="w-3.5 h-3.5" :class="{ 'animate-spin': loadingTemplate }" />
                  <span>重载</span>
                </button>
                <button
                  @click="handleSaveTemplate"
                  :disabled="savingTemplate || loadingTemplate"
                  class="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 active:scale-95 shadow-sm shadow-blue-500/20 rounded-lg disabled:opacity-50 transition-all cursor-pointer"
                >
                  <Save class="w-3.5 h-3.5" />
                  <span>{{ savingTemplate ? '保存中...' : '保存配置模板' }}</span>
                </button>
              </div>
            </div>

            <!-- Hint Accordion -->
            <div class="text-[11px] leading-relaxed text-slate-600 dark:text-slate-400 bg-white dark:bg-slate-900 p-3 rounded-lg border border-slate-200/80 dark:border-slate-800 space-y-1">
              <p>💡 <b>配置提示：</b> 你可以在此自由修改端口、DNS、分流规则集（rule-providers）与路由分流策略（rules，例如将 REJECT 改为 DIRECT）。修改后需管理员权限保存，所有用户拉取订阅时立即生效。</p>
              <p>📌 <b>占位符说明：</b> 模板支持 <code class="px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800 font-mono text-blue-600 dark:text-blue-400">&#123;&#123;PROXIES&#125;&#125;</code>（节点注入点）与 <code class="px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800 font-mono text-blue-600 dark:text-blue-400">&#123;&#123;PROXY_NAMES&#125;&#125;</code>（策略组节点名称注入点）。导出订阅时，系统会自动将该用户授权的各 Reality 节点注入至此处。</p>
            </div>

            <!-- Textarea Editor -->
            <div class="relative rounded-xl overflow-hidden border border-slate-800 bg-slate-950">
              <textarea
                v-model="templateContent"
                rows="20"
                spellcheck="false"
                class="w-full p-4 font-mono text-xs text-slate-200 bg-transparent resize-y outline-none leading-relaxed select-text"
                placeholder="正在加载订阅模板..."
              ></textarea>
            </div>
          </div>
        </div>

        <!-- Panel 3: Legacy Script Export Feature -->
        <div v-if="activeTab === 'script'" class="space-y-4 pt-2">
          <div class="flex items-center justify-between p-4 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800">
            <div>
              <h4 class="text-xs font-bold text-slate-900 dark:text-white">Clash Verge Rev 扩展脚本 (Script Merge)</h4>
              <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                适用于在已有的通用机场订阅上通过扩展脚本无缝注入自建节点。
              </p>
            </div>
            <button
              @click="handleGenerateScript"
              :disabled="!selectedIdentity || generatingScript"
              class="flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 active:scale-95 shadow-md shadow-blue-500/20 disabled:opacity-50 transition-all cursor-pointer shrink-0"
            >
              <Sparkles class="w-4 h-4" />
              <span>{{ generatingScript ? '生成中...' : '生成扩展脚本' }}</span>
            </button>
          </div>

          <!-- Script Output Window -->
          <div v-if="scriptContent" class="space-y-3">
            <div class="flex items-center justify-between">
              <span class="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
                <Terminal class="w-3.5 h-3.5" />
                <span>proxysetting-verge.js 脚本内容预览</span>
              </span>

              <div class="flex items-center gap-2">
                <button
                  @click="handleCopyScript"
                  class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors cursor-pointer"
                >
                  <Check v-if="copiedScript" class="w-3.5 h-3.5 text-emerald-500" />
                  <Copy v-else class="w-3.5 h-3.5" />
                  <span>{{ copiedScript ? '已复制' : '复制全文' }}</span>
                </button>

                <button
                  @click="handleDownloadScript"
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

        <!-- Security Notice -->
        <div class="p-3.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/60 text-amber-800 dark:text-amber-200 text-xs flex items-start gap-2.5">
          <ShieldAlert class="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div class="leading-relaxed">
            <b>安全提醒：</b> 生成的订阅链接与配置中包含解密后的专有 Reality 节点凭证与短 ID。请妥善保管，切勿在公开网络或不受信任的设备上传播。
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
