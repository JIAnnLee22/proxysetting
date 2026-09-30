<script setup lang="ts">
import { ref, computed } from 'vue'
import { api } from '../lib/api'
import { showToast } from '../lib/toast'
import { formatBytes } from '../lib/analytics'
import Modal from './Modal.vue'
import ConfirmModal from './ConfirmModal.vue'
import {
  Server,
  Plus,
  Terminal,
  RefreshCw,
  Trash2,
  Edit3,
  ArrowUpCircle,
  Copy,
  Check,
  Clock,
  ShieldCheck,
  AlertTriangle,
  ExternalLink,
  Cpu,
  Globe
} from '@lucide/vue'

const props = defineProps<{
  state: any
}>()

const emit = defineEmits<{
  (e: 'refresh'): void
}>()

// Add VPS Modal
const showAddModal = ref(false)
const addingVps = ref(false)
const newVps = ref({
  name: '',
  address: '',
  port: 443,
  serverName: 'gateway.icloud.com'
})

// Edit Unregistered VPS Modal
const showEditModal = ref(false)
const editingVps = ref(false)
const editVpsData = ref({
  id: '',
  name: '',
  address: '',
  port: 443,
  serverName: ''
})

// Install / Enroll Modal
const showEnrollModal = ref(false)
const enrolling = ref(false)
const enrollResult = ref<{ command: string; expiresAt: string; vpsName: string } | null>(null)
const copiedCommand = ref(false)

// Upgrade Modal
const showUpgradeModal = ref(false)
const upgrading = ref(false)
const upgradeTarget = ref<{ id: string; name: string; version: string } | null>(null)
const upgradeVersion = ref('v0.1.1')

// Revoke Confirm Modal
const showRevokeModal = ref(false)
const revoking = ref(false)
const revokeTarget = ref<{ id: string; name: string } | null>(null)

// Nodes stats
const summary = computed(() => {
  const list = props.state?.vps || []
  const ready = list.filter((v: any) => v.status === 'ready').length
  const syncing = list.filter((v: any) => v.status === 'syncing').length
  const pending = list.filter((v: any) => v.status === 'pending').length
  const revoked = list.filter((v: any) => v.status === 'revoked' || v.revoked).length
  return { total: list.length, ready, syncing, pending, revoked }
})

// Copy IP:Port
const copiedIp = ref<string | null>(null)
function copyAddress(vps: any) {
  const text = `${vps.address}:${vps.port}`
  navigator.clipboard.writeText(text)
  copiedIp.value = vps.id
  setTimeout(() => {
    copiedIp.value = null
  }, 2000)
}

// Add VPS
async function handleAddVps() {
  if (!newVps.value.name.trim() || !newVps.value.address.trim()) {
    showToast('请完整填写节点名称和公网地址', 'warning')
    return
  }
  if (newVps.value.port === 10085) {
    showToast('Reality 端口不能为内部 API 端口 10085', 'warning')
    return
  }
  addingVps.value = true
  try {
    await api('vps', 'POST', {
      name: newVps.value.name.trim(),
      address: newVps.value.address.trim(),
      port: Number(newVps.value.port),
      serverName: newVps.value.serverName.trim()
    })
    showToast(`成功添加节点 “${newVps.value.name}”`, 'success')
    showAddModal.value = false
    newVps.value = { name: '', address: '', port: 443, serverName: 'gateway.icloud.com' }
    emit('refresh')
  } catch (e: any) {
    showToast(e.message || '添加节点失败', 'error')
  } finally {
    addingVps.value = false
  }
}

// Open Edit Modal
function openEditModal(vps: any) {
  editVpsData.value = {
    id: vps.id,
    name: vps.name,
    address: vps.address,
    port: vps.port,
    serverName: vps.server_name
  }
  showEditModal.value = true
}

async function handleEditVps() {
  if (editVpsData.value.port === 10085) {
    showToast('Reality 端口不能为内部 API 端口 10085', 'warning')
    return
  }
  editingVps.value = true
  try {
    await api(`vps/${editVpsData.value.id}`, 'PATCH', {
      name: editVpsData.value.name,
      address: editVpsData.value.address,
      port: Number(editVpsData.value.port),
      serverName: editVpsData.value.serverName
    })
    showToast('参数已更新，请重新生成安装注册命令', 'success')
    showEditModal.value = false
    emit('refresh')
  } catch (e: any) {
    showToast(e.message || '修改参数失败', 'error')
  } finally {
    editingVps.value = false
  }
}

// Enroll / Re-register
async function handleEnroll(vps: any) {
  enrolling.value = true
  try {
    const res = await api(`vps/${vps.id}/enroll`, 'POST')
    enrollResult.value = {
      command: res.command,
      expiresAt: res.expiresAt,
      vpsName: vps.name
    }
    showEnrollModal.value = true
    copiedCommand.value = false
  } catch (e: any) {
    showToast(e.message || '生成安装命令失败', 'error')
  } finally {
    enrolling.value = false
  }
}

async function copyEnrollCommand() {
  if (!enrollResult.value?.command) return
  await navigator.clipboard.writeText(enrollResult.value.command)
  copiedCommand.value = true
  showToast('安装命令已复制到剪贴板', 'success')
  setTimeout(() => {
    copiedCommand.value = false
  }, 3000)
}

// Upgrade version
function openUpgradeModal(vps: any) {
  upgradeTarget.value = { id: vps.id, name: vps.name, version: vps.version || 'v0.1.1' }
  upgradeVersion.value = vps.version || 'v0.1.1'
  showUpgradeModal.value = true
}

async function handleUpgrade() {
  if (!upgradeTarget.value || !upgradeVersion.value.trim()) return
  upgrading.value = true
  try {
    await api(`vps/${upgradeTarget.value.id}/upgrade`, 'POST', {
      version: upgradeVersion.value.trim()
    })
    showToast(`已向节点 “${upgradeTarget.value.name}” 发送升级指令 (${upgradeVersion.value})`, 'success')
    showUpgradeModal.value = false
    emit('refresh')
  } catch (e: any) {
    showToast(e.message || '触发升级失败', 'error')
  } finally {
    upgrading.value = false
  }
}

// Revoke credentials
function promptRevoke(vps: any) {
  revokeTarget.value = { id: vps.id, name: vps.name }
  showRevokeModal.value = true
}

async function confirmRevoke() {
  if (!revokeTarget.value) return
  revoking.value = true
  try {
    await api(`vps/${revokeTarget.value.id}/revoke`, 'POST')
    showToast(`已成功撤销节点 “${revokeTarget.value.name}” 的凭据`, 'success')
    showRevokeModal.value = false
    emit('refresh')
  } catch (e: any) {
    showToast(e.message || '撤销凭据失败', 'error')
  } finally {
    revoking.value = false
  }
}
</script>

<template>
  <div class="space-y-6">
    <!-- Top Summary Banner -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3.5 sm:gap-4">
      <div class="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm flex items-center gap-3.5">
        <div class="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
          <Server class="w-5 h-5" />
        </div>
        <div>
          <div class="text-xs font-medium text-slate-500 dark:text-slate-400">总节点数</div>
          <div class="text-xl font-bold tracking-tight text-slate-900 dark:text-white">{{ summary.total }} <span class="text-xs font-normal text-slate-400">/ 10</span></div>
        </div>
      </div>

      <div class="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm flex items-center gap-3.5">
        <div class="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
          <ShieldCheck class="w-5 h-5" />
        </div>
        <div>
          <div class="text-xs font-medium text-slate-500 dark:text-slate-400">就绪在线</div>
          <div class="text-xl font-bold tracking-tight text-slate-900 dark:text-white">{{ summary.ready }} <span class="text-xs font-normal text-slate-400">台</span></div>
        </div>
      </div>

      <div class="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm flex items-center gap-3.5">
        <div class="w-10 h-10 rounded-xl bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
          <Clock class="w-5 h-5" />
        </div>
        <div>
          <div class="text-xs font-medium text-slate-500 dark:text-slate-400">待部署 / 同步</div>
          <div class="text-xl font-bold tracking-tight text-slate-900 dark:text-white">{{ summary.pending + summary.syncing }} <span class="text-xs font-normal text-slate-400">台</span></div>
        </div>
      </div>

      <div class="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm flex items-center gap-3.5">
        <div class="w-10 h-10 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-500 flex items-center justify-center shrink-0">
          <Trash2 class="w-5 h-5" />
        </div>
        <div>
          <div class="text-xs font-medium text-slate-500 dark:text-slate-400">已撤销凭据</div>
          <div class="text-xl font-bold tracking-tight text-slate-900 dark:text-white">{{ summary.revoked }} <span class="text-xs font-normal text-slate-400">台</span></div>
        </div>
      </div>
    </div>

    <!-- Header Actions -->
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-base font-bold text-slate-900 dark:text-white tracking-tight">Reality VPS 节点管理</h2>
        <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">面向多 VPS 分布式部署，支持一键安装引导、在线升级与安全撤销</p>
      </div>

      <button
        @click="showAddModal = true"
        :disabled="summary.total >= 10"
        class="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 active:scale-95 shadow-md shadow-blue-500/20 disabled:opacity-50 transition-all cursor-pointer"
      >
        <Plus class="w-4 h-4" />
        <span>添加 VPS</span>
      </button>
    </div>

    <!-- Nodes List -->
    <div v-if="!state?.vps || state.vps.length === 0" class="p-12 text-center rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
      <Server class="w-12 h-12 mx-auto text-slate-300 dark:text-slate-600 mb-3" />
      <h3 class="text-base font-semibold text-slate-900 dark:text-white">暂无 VPS 节点</h3>
      <p class="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-sm mx-auto">
        点击右上角“添加 VPS”注册新节点并获取安装脚本。
      </p>
    </div>

    <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div
        v-for="v in state.vps"
        :key="v.id"
        class="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm overflow-hidden flex flex-col justify-between transition-all duration-200 hover:shadow-md"
      >
        <!-- Card Header -->
        <div class="p-5 border-b border-slate-100 dark:border-slate-800/80">
          <div class="flex items-start justify-between gap-3">
            <div class="flex items-center gap-3">
              <div
                class="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                :class="[
                  v.status === 'ready' ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400' :
                  v.status === 'syncing' ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400' :
                  v.status === 'pending' ? 'bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400' :
                  'bg-slate-100 dark:bg-slate-800 text-slate-400'
                ]"
              >
                <Server class="w-5 h-5" />
              </div>
              <div>
                <h3 class="text-base font-bold text-slate-900 dark:text-white tracking-tight flex items-center gap-2">
                  {{ v.name }}
                </h3>
                <div class="flex items-center gap-2 mt-0.5">
                  <span class="text-xs font-mono text-slate-500 dark:text-slate-400">{{ v.address }}:{{ v.port }}</span>
                  <button
                    @click="copyAddress(v)"
                    title="复制节点地址"
                    class="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
                  >
                    <Check v-if="copiedIp === v.id" class="w-3.5 h-3.5 text-emerald-500" />
                    <Copy v-else class="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>

            <!-- Status Indicator Badge -->
            <div class="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
              :class="[
                v.status === 'ready' ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800' :
                v.status === 'syncing' ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800' :
                v.status === 'pending' ? 'bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800' :
                'bg-slate-100 dark:bg-slate-800 text-slate-500 border border-slate-200 dark:border-slate-700'
              ]"
            >
              <span
                class="w-2 h-2 rounded-full"
                :class="[
                  v.status === 'ready' ? 'bg-emerald-500 animate-pulse' :
                  v.status === 'syncing' ? 'bg-blue-500 animate-spin' :
                  v.status === 'pending' ? 'bg-amber-500' :
                  'bg-slate-400'
                ]"
              ></span>
              <span class="capitalize">{{ v.status === 'ready' ? '正常运行' : v.status === 'syncing' ? '同步中' : v.status === 'pending' ? '待注册部署' : '已撤销凭据' }}</span>
            </div>
          </div>

          <!-- Error Alert Banner -->
          <div v-if="v.error" class="mt-3 p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 text-rose-800 dark:text-rose-200 text-xs flex items-start gap-2">
            <AlertTriangle class="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
            <div class="font-mono text-[11px] leading-snug break-all">{{ v.error }}</div>
          </div>
        </div>

        <!-- Node Details -->
        <div class="p-5 space-y-2.5 text-xs text-slate-600 dark:text-slate-400 bg-slate-50/30 dark:bg-slate-900/20">
          <div class="flex items-center justify-between">
            <span class="text-slate-400">Reality TLS1.3 目标:</span>
            <span class="font-mono font-medium text-slate-800 dark:text-slate-200">{{ v.server_name }}</span>
          </div>

          <div class="flex items-center justify-between">
            <span class="text-slate-400">Agent 版本:</span>
            <span class="font-medium text-slate-800 dark:text-slate-200">{{ v.version || '未安装' }}</span>
          </div>

          <div class="flex items-center justify-between">
            <span class="text-slate-400">配置修订 (Revision):</span>
            <span class="font-mono text-slate-700 dark:text-slate-300">r{{ v.revision }}</span>
          </div>

          <div class="flex items-center justify-between">
            <span class="text-slate-400">最近通信同步:</span>
            <span class="text-slate-700 dark:text-slate-300">{{ v.last_sync || '尚无同步记录' }}</span>
          </div>
        </div>

        <!-- Card Footer Actions -->
        <div class="p-4 bg-slate-50/70 dark:bg-slate-900/60 border-t border-slate-100 dark:border-slate-800/80 flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-1.5 flex-wrap">
            <!-- Edit params if pending -->
            <button
              v-if="v.status === 'pending' && !v.public_key"
              @click="openEditModal(v)"
              class="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors cursor-pointer"
            >
              <Edit3 class="w-3.5 h-3.5" />
              <span>修改参数</span>
            </button>

            <!-- Upgrade version -->
            <button
              v-if="!v.revoked && v.status !== 'pending'"
              @click="openUpgradeModal(v)"
              class="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-900/60 hover:bg-blue-100 dark:hover:bg-blue-900/60 transition-colors cursor-pointer"
            >
              <ArrowUpCircle class="w-3.5 h-3.5" />
              <span>升级版本</span>
            </button>

            <!-- Revoke -->
            <button
              v-if="!v.revoked && v.status !== 'revoked'"
              @click="promptRevoke(v)"
              class="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 hover:bg-rose-100 dark:hover:bg-rose-900/60 transition-colors cursor-pointer"
            >
              <Trash2 class="w-3.5 h-3.5" />
              <span>撤销凭据</span>
            </button>
          </div>

          <!-- Enroll / Re-register Button -->
          <button
            @click="handleEnroll(v)"
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 active:scale-95 shadow-sm shadow-blue-500/20 transition-all cursor-pointer ml-auto"
          >
            <Terminal class="w-3.5 h-3.5" />
            <span>{{ v.status === 'pending' ? '获取安装命令' : '重新注册' }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Add VPS Modal -->
    <Modal v-model="showAddModal" title="添加新 VPS 节点" max-width="lg">
      <form @submit.prevent="handleAddVps" class="space-y-4">
        <div>
          <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
            节点名称
          </label>
          <input
            v-model="newVps.name"
            type="text"
            required
            placeholder="例如: US-West, Tokyo-01"
            class="w-full px-3.5 py-2 text-sm rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
          />
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <div>
            <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              公网 IPv4 / IPv6
            </label>
            <input
              v-model="newVps.address"
              type="text"
              required
              placeholder="例如: 198.51.100.1"
              class="w-full px-3.5 py-2 text-sm font-mono rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
            />
          </div>

          <div>
            <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              Reality 外部端口
            </label>
            <input
              v-model.number="newVps.port"
              type="number"
              min="1"
              max="65535"
              required
              placeholder="443"
              class="w-full px-3.5 py-2 text-sm font-mono rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
            />
            <p class="text-[10px] text-slate-400 mt-1">请勿使用 10085 (本地 API 端口)</p>
          </div>
        </div>

        <div>
          <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
            Reality TLS 1.3 目标域名 (SNI)
          </label>
          <input
            v-model="newVps.serverName"
            type="text"
            required
            placeholder="例如: gateway.icloud.com, dl.google.com"
            class="w-full px-3.5 py-2 text-sm font-mono rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
          />
          <p class="text-[11px] text-slate-400 dark:text-slate-500 mt-1.5">
            推荐选用支持 TLS 1.3、OCSP Stapling 且地理距离相近的知名 CDN/大厂域名。
          </p>
        </div>

        <div class="pt-2 flex justify-end gap-2.5">
          <button
            type="button"
            @click="showAddModal = false"
            class="px-4 py-2 text-sm font-medium rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition-colors cursor-pointer"
          >
            取消
          </button>
          <button
            type="submit"
            :disabled="addingVps"
            class="px-4 py-2 text-sm font-semibold rounded-xl text-white bg-blue-600 hover:bg-blue-700 active:scale-95 shadow-md shadow-blue-500/20 disabled:opacity-50 transition-all cursor-pointer"
          >
            {{ addingVps ? '添加中...' : '确认添加' }}
          </button>
        </div>
      </form>
    </Modal>

    <!-- Edit Unregistered VPS Modal -->
    <Modal v-model="showEditModal" title="修改未注册 VPS 参数" max-width="lg">
      <form @submit.prevent="handleEditVps" class="space-y-4">
        <div>
          <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">节点名称</label>
          <input
            v-model="editVpsData.name"
            type="text"
            required
            class="w-full px-3.5 py-2 text-sm rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
          />
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <div>
            <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">公网 IP</label>
            <input
              v-model="editVpsData.address"
              type="text"
              required
              class="w-full px-3.5 py-2 text-sm font-mono rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
            />
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">Reality 端口</label>
            <input
              v-model.number="editVpsData.port"
              type="number"
              min="1"
              max="65535"
              required
              class="w-full px-3.5 py-2 text-sm font-mono rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
            />
          </div>
        </div>

        <div>
          <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">TLS 1.3 目标域名 (SNI)</label>
          <input
            v-model="editVpsData.serverName"
            type="text"
            required
            class="w-full px-3.5 py-2 text-sm font-mono rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
          />
        </div>

        <div class="pt-2 flex justify-end gap-2.5">
          <button
            type="button"
            @click="showEditModal = false"
            class="px-4 py-2 text-sm font-medium rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition-colors cursor-pointer"
          >
            取消
          </button>
          <button
            type="submit"
            :disabled="editingVps"
            class="px-4 py-2 text-sm font-semibold rounded-xl text-white bg-blue-600 hover:bg-blue-700 active:scale-95 shadow-md shadow-blue-500/20 disabled:opacity-50 transition-all cursor-pointer"
          >
            {{ editingVps ? '保存中...' : '保存参数' }}
          </button>
        </div>
      </form>
    </Modal>

    <!-- Install / Enroll Command Modal -->
    <Modal v-model="showEnrollModal" title="节点安装与注册命令" max-width="2xl">
      <div class="space-y-4">
        <div class="p-3.5 rounded-xl bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900/60 text-xs text-blue-900 dark:text-blue-200 space-y-1">
          <div class="font-bold flex items-center gap-1.5">
            <Terminal class="w-4 h-4 text-blue-600 dark:text-blue-400" />
            <span>在目标 VPS 以 root 权限执行下方命令</span>
          </div>
          <p class="text-blue-700 dark:text-blue-300">
            节点：<b>{{ enrollResult?.vpsName }}</b> • 令牌有效期 15 分钟，过期前：{{ enrollResult?.expiresAt ? new Date(enrollResult.expiresAt).toLocaleTimeString() : '' }}
          </p>
        </div>

        <!-- Terminal Command Box -->
        <div class="relative group">
          <pre class="p-4 rounded-xl font-mono text-xs text-slate-200 bg-slate-950 border border-slate-800 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed max-h-56 select-all">{{ enrollResult?.command }}</pre>

          <button
            @click="copyEnrollCommand"
            class="absolute top-3 right-3 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 shadow-md transition-all cursor-pointer"
          >
            <Check v-if="copiedCommand" class="w-3.5 h-3.5" />
            <Copy v-else class="w-3.5 h-3.5" />
            <span>{{ copiedCommand ? '已复制' : '一键复制' }}</span>
          </button>
        </div>

        <p class="text-[11px] text-slate-500 dark:text-slate-400">
          注意：如果目标 VPS 之前已运行旧代理，重新注册会撤销旧凭据。安装完成后该节点将自动向本控制台握手并汇报就绪状态。
        </p>

        <div class="pt-2 flex justify-end">
          <button
            type="button"
            @click="showEnrollModal = false"
            class="px-4 py-2 text-sm font-semibold rounded-xl text-white bg-slate-800 hover:bg-slate-700 transition-colors cursor-pointer"
          >
            关闭
          </button>
        </div>
      </div>
    </Modal>

    <!-- Upgrade Version Modal -->
    <Modal v-model="showUpgradeModal" title="在线升级节点 Agent 版本" max-width="md">
      <form @submit.prevent="handleUpgrade" class="space-y-4">
        <div>
          <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
            目标 Release 版本号
          </label>
          <input
            v-model="upgradeVersion"
            type="text"
            required
            placeholder="例如: v0.1.1"
            class="w-full px-3.5 py-2 text-sm font-mono rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
          />
          <p class="text-[11px] text-slate-400 dark:text-slate-500 mt-1.5">
            请输入已在 GitHub Releases 发布的版本号。节点将在下次心跳时自动安全校验 SHA256 并热升级。
          </p>
        </div>

        <div class="pt-2 flex justify-end gap-2.5">
          <button
            type="button"
            @click="showUpgradeModal = false"
            class="px-4 py-2 text-sm font-medium rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition-colors cursor-pointer"
          >
            取消
          </button>
          <button
            type="submit"
            :disabled="upgrading"
            class="px-4 py-2 text-sm font-semibold rounded-xl text-white bg-blue-600 hover:bg-blue-700 active:scale-95 shadow-md shadow-blue-500/20 disabled:opacity-50 transition-all cursor-pointer"
          >
            {{ upgrading ? '下发升级中...' : '确认下发升级' }}
          </button>
        </div>
      </form>
    </Modal>

    <!-- Revoke Confirm Modal -->
    <ConfirmModal
      v-model="showRevokeModal"
      title="撤销节点凭据"
      :message="`确定要撤销节点 “${revokeTarget?.name}” 的凭据吗？撤销后该设备将在下次心跳通信时停止代理服务。已有历史流量记录仍将保留。`"
      confirm-text="确认撤销"
      :is-destructive="true"
      :loading="revoking"
      @confirm="confirmRevoke"
    />
  </div>
</template>
