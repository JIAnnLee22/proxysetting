<script setup lang="ts">
import { ref, computed } from 'vue'
import { api } from '../lib/api'
import { showToast } from '../lib/toast'
import { formatBytes, bytesToGiB } from '../lib/analytics'
import Modal from './Modal.vue'
import ConfirmModal from './ConfirmModal.vue'
import {
  Users,
  UserPlus,
  Server,
  HardDrive,
  CheckCircle2,
  Trash2,
  Save,
  AlertCircle,
  Search,
  Sliders,
  Shield,
  Activity,
  ArrowUpRight,
  ArrowDownLeft
} from '@lucide/vue'

const props = defineProps<{
  state: any
}>()

const emit = defineEmits<{
  (e: 'refresh'): void
}>()

// Search filter
const searchQuery = ref('')

// Card collapsed state
const collapsedMap = ref<Record<string, boolean>>({})
function toggleCollapse(id: string) {
  collapsedMap.value[id] = !collapsedMap.value[id]
}
function expandAll() {
  collapsedMap.value = {}
}
function collapseAll() {
  for (const i of props.state?.identities || []) {
    collapsedMap.value[i.id] = true
  }
}

// Add Identity Modal
const showAddModal = ref(false)
const newIdentityName = ref('')
const addingIdentity = ref(false)

// Delete Grant Confirm Modal
const showRemoveGrantModal = ref(false)
const pendingRemove = ref<{ vpsId: string; vpsName: string; identityId: string; identityName: string } | null>(null)
const removingGrant = ref(false)

// Local editing inputs state: key is `${identityId}:${vpsId}` -> string of GiB
const editQuotas = ref<Record<string, string>>({})
const savingQuota = ref<Record<string, boolean>>({})

// Identity status toggle loading
const togglingIdentity = ref<Record<string, boolean>>({})

// Filtered identities
const filteredIdentities = computed(() => {
  if (!props.state?.identities) return []
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return props.state.identities
  return props.state.identities.filter((i: any) => i.name.toLowerCase().includes(q))
})

// Summary metrics
const summary = computed(() => {
  const ids = props.state?.identities || []
  const activeCount = ids.filter((i: any) => i.enabled).length
  const totalGrants = props.state?.grants?.length || 0
  
  let totalAllocatedBytes = 0
  for (const g of props.state?.grants || []) {
    totalAllocatedBytes += (g.quota_bytes || 0)
  }

  return {
    total: ids.length,
    active: activeCount,
    grants: totalGrants,
    allocatedGiB: bytesToGiB(totalAllocatedBytes, 1)
  }
})

// Quick quota presets
const presets = [5, 10, 20, 50, 100]

function getGrant(vpsId: string, identityId: string) {
  return props.state?.grants?.find(
    (g: any) => g.vps_id === vpsId && g.identity_id === identityId
  )
}

function getQuotaInputVal(vpsId: string, identityId: string): string {
  const key = `${identityId}:${vpsId}`
  if (editQuotas.value[key] !== undefined) {
    return editQuotas.value[key]
  }
  const grant = getGrant(vpsId, identityId)
  return grant ? String(bytesToGiB(grant.quota_bytes, 3)) : ''
}

function setQuotaInputVal(vpsId: string, identityId: string, val: string | number) {
  const key = `${identityId}:${vpsId}`
  editQuotas.value[key] = String(val)
}

function getUserUsageOnVps(vpsId: string, identityId: string) {
  const snapshot = props.state?.snapshots?.find((s: any) => s.vps_id === vpsId)?.payload
  if (!snapshot || snapshot.month !== props.state?.calendar?.month) return null
  return snapshot.users?.find((u: any) => u.id === identityId) || null
}

function getUserTotalMonthUsage(identityId: string) {
  let up = 0
  let down = 0
  for (const v of props.state?.vps || []) {
    const u = getUserUsageOnVps(v.id, identityId)
    if (u) {
      up += (u.uplink || 0)
      down += (u.downlink || 0)
    }
  }
  return { up, down, total: up + down }
}

async function handleAddIdentity() {
  const name = newIdentityName.value.trim()
  if (!name) {
    showToast('请输入身份名称', 'warning')
    return
  }
  addingIdentity.value = true
  try {
    await api('identities', 'POST', { name })
    showToast(`成功创建身份 “${name}”`, 'success')
    newIdentityName.value = ''
    showAddModal.value = false
    emit('refresh')
  } catch (e: any) {
    showToast(e.message || '添加身份失败', 'error')
  } finally {
    addingIdentity.value = false
  }
}

async function toggleIdentity(identity: any) {
  togglingIdentity.value[identity.id] = true
  const newEnabled = !identity.enabled
  try {
    await api(`identities/${identity.id}`, 'PATCH', {
      name: identity.name,
      enabled: newEnabled
    })
    identity.enabled = newEnabled ? 1 : 0
    showToast(`已${newEnabled ? '启用' : '停用'}身份 “${identity.name}”`, 'success')
    emit('refresh')
  } catch (e: any) {
    showToast(e.message || '修改状态失败', 'error')
  } finally {
    togglingIdentity.value[identity.id] = false
  }
}

async function saveQuota(vps: any, identity: any) {
  const key = `${identity.id}:${vps.id}`
  const rawVal = getQuotaInputVal(vps.id, identity.id)
  const quotaGiB = Number(rawVal)

  if (!rawVal || !Number.isFinite(quotaGiB) || quotaGiB <= 0) {
    showToast('请输入大于 0 的有效月额度 (GiB)', 'warning')
    return
  }

  savingQuota.value[key] = true
  try {
    await api(`vps/${vps.id}/grants`, 'PUT', {
      identityId: identity.id,
      quotaGiB
    })
    showToast(`已更新 “${identity.name}” 在节点 “${vps.name}” 的月额度为 ${quotaGiB} GiB`, 'success')
    emit('refresh')
  } catch (e: any) {
    showToast(e.message || '保存额度失败', 'error')
  } finally {
    savingQuota.value[key] = false
  }
}

function promptRemoveGrant(vps: any, identity: any) {
  pendingRemove.value = {
    vpsId: vps.id,
    vpsName: vps.name,
    identityId: identity.id,
    identityName: identity.name
  }
  showRemoveGrantModal.value = true
}

async function confirmRemoveGrant() {
  if (!pendingRemove.value) return
  const { vpsId, vpsName, identityId, identityName } = pendingRemove.value
  removingGrant.value = true
  try {
    await api(`vps/${vpsId}/grants`, 'DELETE', { identityId })
    showToast(`已移除 “${identityName}” 在节点 “${vpsName}” 的授权`, 'success')
    const key = `${identityId}:${vpsId}`
    delete editQuotas.value[key]
    showRemoveGrantModal.value = false
    emit('refresh')
  } catch (e: any) {
    showToast(e.message || '移除授权失败', 'error')
  } finally {
    removingGrant.value = false
  }
}
</script>

<template>
  <div class="space-y-6">
    <!-- Top Summary Banner -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3.5 sm:gap-4">
      <div class="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm flex items-center gap-3.5">
        <div class="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
          <Users class="w-5 h-5" />
        </div>
        <div>
          <div class="text-xs font-medium text-slate-500 dark:text-slate-400">身份总数</div>
          <div class="text-xl font-bold tracking-tight text-slate-900 dark:text-white">{{ summary.total }} <span class="text-xs font-normal text-slate-400">个</span></div>
        </div>
      </div>

      <div class="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm flex items-center gap-3.5">
        <div class="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
          <CheckCircle2 class="w-5 h-5" />
        </div>
        <div>
          <div class="text-xs font-medium text-slate-500 dark:text-slate-400">已启用身份</div>
          <div class="text-xl font-bold tracking-tight text-slate-900 dark:text-white">{{ summary.active }} <span class="text-xs font-normal text-slate-400">个</span></div>
        </div>
      </div>

      <div class="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm flex items-center gap-3.5">
        <div class="w-10 h-10 rounded-xl bg-violet-50 dark:bg-violet-950/60 text-violet-600 dark:text-violet-400 flex items-center justify-center shrink-0">
          <HardDrive class="w-5 h-5" />
        </div>
        <div>
          <div class="text-xs font-medium text-slate-500 dark:text-slate-400">授权分配</div>
          <div class="text-xl font-bold tracking-tight text-slate-900 dark:text-white">{{ summary.grants }} <span class="text-xs font-normal text-slate-400">项</span></div>
        </div>
      </div>

      <div class="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm flex items-center gap-3.5">
        <div class="w-10 h-10 rounded-xl bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
          <Sliders class="w-5 h-5" />
        </div>
        <div>
          <div class="text-xs font-medium text-slate-500 dark:text-slate-400">总分配月配额</div>
          <div class="text-xl font-bold tracking-tight text-slate-900 dark:text-white">{{ summary.allocatedGiB }} <span class="text-xs font-normal text-slate-400">GiB</span></div>
        </div>
      </div>
    </div>

    <!-- Action Bar -->
    <div class="flex flex-col sm:flex-row gap-3 sm:items-center justify-between">
      <div class="relative flex-1 max-w-md">
        <Search class="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
        <input
          v-model="searchQuery"
          type="text"
          placeholder="搜索身份名称..."
          class="w-full pl-9 pr-4 py-2 text-sm rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
        />
      </div>

      <div class="flex items-center gap-2">
        <button
          @click="Object.keys(collapsedMap).length > 0 ? expandAll() : collapseAll()"
          class="px-3 py-2 rounded-xl text-xs font-medium border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
        >
          {{ Object.keys(collapsedMap).length > 0 ? '全部展开' : '全部折叠' }}
        </button>

        <button
          @click="showAddModal = true"
          class="flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 active:scale-95 shadow-md shadow-blue-500/20 transition-all cursor-pointer"
        >
          <UserPlus class="w-4 h-4" />
          <span>添加新身份</span>
        </button>
      </div>
    </div>

    <!-- Empty State -->
    <div v-if="filteredIdentities.length === 0" class="p-12 text-center rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
      <Users class="w-12 h-12 mx-auto text-slate-300 dark:text-slate-600 mb-3" />
      <h3 class="text-base font-semibold text-slate-900 dark:text-white">暂无身份记录</h3>
      <p class="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-sm mx-auto">
        {{ searchQuery ? '未找到符合条件的身份，请尝试其他关键词。' : '还没有添加任何用户身份，点击上方按钮创建第一个身份。' }}
      </p>
    </div>

    <!-- Identities List with Quota Matrix -->
    <div v-else class="space-y-4">
      <div
        v-for="identity in filteredIdentities"
        :key="identity.id"
        class="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm overflow-hidden transition-all duration-200 hover:shadow-md"
      >
        <!-- Identity Header -->
        <div class="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-100 dark:border-slate-800/80 bg-slate-50/50 dark:bg-slate-900/40">
          <div class="flex items-center gap-3.5 flex-1 cursor-pointer select-none" @click="toggleCollapse(identity.id)">
            <div
              class="w-11 h-11 rounded-2xl flex items-center justify-center text-sm font-bold text-white shadow-sm shrink-0 uppercase"
              :class="identity.enabled ? 'bg-gradient-to-tr from-blue-600 to-indigo-500' : 'bg-slate-400 dark:bg-slate-700'"
            >
              {{ identity.name.slice(0, 2) }}
            </div>
            <div>
              <div class="flex items-center gap-2.5">
                <h3 class="text-base font-bold text-slate-900 dark:text-white tracking-tight">
                  {{ identity.name }}
                </h3>
                <span
                  class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold"
                  :class="identity.enabled ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800' : 'bg-slate-100 dark:bg-slate-800 text-slate-500 border border-slate-200 dark:border-slate-700'"
                >
                  {{ identity.enabled ? '已启用' : '已停用' }}
                </span>
              </div>
              <div class="text-xs text-slate-500 dark:text-slate-400 mt-1 flex flex-wrap items-center gap-3 font-medium">
                <span class="font-mono text-[11px] text-slate-400">ID: {{ identity.id }}</span>
                <span>•</span>
                <span>当月全节点流量: <b class="text-slate-800 dark:text-slate-200 font-semibold">{{ formatBytes(getUserTotalMonthUsage(identity.id).total) }}</b></span>
                <span class="hidden md:inline">(↑ {{ formatBytes(getUserTotalMonthUsage(identity.id).up) }} / ↓ {{ formatBytes(getUserTotalMonthUsage(identity.id).down) }})</span>
              </div>
            </div>
          </div>

          <!-- Enable / Disable Switch & Toggle Collapse -->
          <div class="flex items-center gap-2 self-end sm:self-auto">
            <button
              @click="toggleIdentity(identity)"
              :disabled="togglingIdentity[identity.id]"
              class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all cursor-pointer"
              :class="[
                identity.enabled
                  ? 'border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/50'
                  : 'border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/50'
              ]"
            >
              <Shield class="w-3.5 h-3.5" />
              <span>{{ togglingIdentity[identity.id] ? '更新中...' : (identity.enabled ? '停用身份' : '启用身份') }}</span>
            </button>

            <button
              @click="toggleCollapse(identity.id)"
              class="p-1.5 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 bg-white dark:bg-slate-800 transition-colors cursor-pointer"
              :title="collapsedMap[identity.id] ? '展开节点额度' : '收起节点额度'"
            >
              <Sliders class="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <!-- VPS Quota Settings Matrix -->
        <div v-show="!collapsedMap[identity.id]" class="p-4 sm:p-5">
          <div class="flex items-center justify-between mb-3">
            <div class="text-xs font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 flex items-center gap-1.5">
              <Server class="w-3.5 h-3.5" />
              <span>各 VPS 节点月额度分配</span>
            </div>
            <div class="text-xs text-slate-400">
              共 {{ state?.vps?.length || 0 }} 个节点
            </div>
          </div>

          <div v-if="!state?.vps || state.vps.length === 0" class="text-xs text-slate-400 p-4 text-center border border-dashed rounded-xl">
            暂无 VPS 节点，请先在 “VPS 节点” 标签页添加节点。
          </div>

          <div v-else class="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
            <div
              v-for="vps in state.vps"
              :key="vps.id"
              class="p-4 rounded-xl border border-slate-200/70 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-800/30 flex flex-col justify-between gap-3.5 transition-colors"
            >
              <!-- Node Info & Status -->
              <div class="flex items-start justify-between gap-2">
                <div>
                  <div class="flex items-center gap-2">
                    <span class="text-sm font-bold text-slate-900 dark:text-white">{{ vps.name }}</span>
                    <span
                      class="px-2 py-0.5 text-[10px] font-semibold rounded-md uppercase"
                      :class="[
                        vps.status === 'ready' ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300' :
                        vps.status === 'syncing' ? 'bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300' :
                        vps.status === 'pending' ? 'bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300' :
                        'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-400'
                      ]"
                    >
                      {{ vps.status }}
                    </span>
                  </div>
                  <div class="text-xs font-mono text-slate-500 dark:text-slate-400 mt-0.5">
                    {{ vps.address }}:{{ vps.port }}
                  </div>
                </div>

                <!-- Granted Badge -->
                <div>
                  <span
                    v-if="getGrant(vps.id, identity.id)"
                    class="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/70 px-2 py-0.5 rounded-lg border border-blue-200/80 dark:border-blue-800/60"
                  >
                    已授权 {{ bytesToGiB(getGrant(vps.id, identity.id).quota_bytes, 1) }} GiB
                  </span>
                  <span
                    v-else
                    class="inline-flex items-center text-[11px] font-medium text-slate-400 dark:text-slate-500 bg-slate-100 dark:bg-slate-800/80 px-2 py-0.5 rounded-lg"
                  >
                    未授权
                  </span>
                </div>
              </div>

              <!-- Usage Progress Bar (if granted) -->
              <div v-if="getGrant(vps.id, identity.id)" class="space-y-1.5 bg-white dark:bg-slate-900/60 p-2.5 rounded-xl border border-slate-200/60 dark:border-slate-800">
                <div class="flex items-center justify-between text-xs">
                  <span class="text-slate-500 dark:text-slate-400">
                    本月消耗:
                    <b class="text-slate-800 dark:text-slate-200">
                      {{ formatBytes((getUserUsageOnVps(vps.id, identity.id)?.uplink || 0) + (getUserUsageOnVps(vps.id, identity.id)?.downlink || 0)) }}
                    </b>
                  </span>
                  <span
                    class="font-semibold text-xs"
                    :class="[
                      getUserUsageOnVps(vps.id, identity.id)?.disabled
                        ? 'text-rose-600 dark:text-rose-400 font-bold'
                        : 'text-slate-600 dark:text-slate-300'
                    ]"
                  >
                    {{
                      getUserUsageOnVps(vps.id, identity.id)?.disabled
                        ? '已熔断/额度耗尽'
                        : `${(
                            Math.min(
                              100,
                              (((getUserUsageOnVps(vps.id, identity.id)?.uplink || 0) + (getUserUsageOnVps(vps.id, identity.id)?.downlink || 0)) /
                                getGrant(vps.id, identity.id).quota_bytes) *
                                100
                            ) || 0
                          ).toFixed(1)}%`
                    }}
                  </span>
                </div>

                <!-- Progress track -->
                <div class="w-full h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                  <div
                    class="h-full rounded-full transition-all duration-300"
                    :style="{
                      width: `${Math.min(
                        100,
                        (((getUserUsageOnVps(vps.id, identity.id)?.uplink || 0) + (getUserUsageOnVps(vps.id, identity.id)?.downlink || 0)) /
                          getGrant(vps.id, identity.id).quota_bytes) *
                          100
                      )}%`
                    }"
                    :class="[
                      getUserUsageOnVps(vps.id, identity.id)?.disabled
                        ? 'bg-rose-500'
                        : (((getUserUsageOnVps(vps.id, identity.id)?.uplink || 0) + (getUserUsageOnVps(vps.id, identity.id)?.downlink || 0)) /
                            getGrant(vps.id, identity.id).quota_bytes) > 0.85
                        ? 'bg-amber-500'
                        : 'bg-blue-600 dark:bg-blue-500'
                    ]"
                  ></div>
                </div>

                <!-- Up/Down splits -->
                <div class="flex items-center justify-between text-[11px] text-slate-400 dark:text-slate-500 pt-0.5">
                  <span class="flex items-center gap-1">
                    <ArrowUpRight class="w-3 h-3 text-blue-500" />
                    ↑ {{ formatBytes(getUserUsageOnVps(vps.id, identity.id)?.uplink || 0) }}
                  </span>
                  <span class="flex items-center gap-1">
                    <ArrowDownLeft class="w-3 h-3 text-emerald-500" />
                    ↓ {{ formatBytes(getUserUsageOnVps(vps.id, identity.id)?.downlink || 0) }}
                  </span>
                  <span>上限 {{ bytesToGiB(getGrant(vps.id, identity.id).quota_bytes, 1) }} GiB</span>
                </div>
              </div>

              <!-- Input and Quick Presets & Actions -->
              <div class="pt-1">
                <div class="flex items-center gap-2">
                  <div class="relative flex-1">
                    <input
                      type="number"
                      min="0.001"
                      step="any"
                      placeholder="设置月额度"
                      :value="getQuotaInputVal(vps.id, identity.id)"
                      @input="setQuotaInputVal(vps.id, identity.id, ($event.target as HTMLInputElement).value)"
                      @keyup.enter="saveQuota(vps, identity)"
                      class="w-full px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all pr-12"
                    />
                    <span class="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] font-bold text-slate-400 pointer-events-none">
                      GiB
                    </span>
                  </div>

                  <button
                    @click="saveQuota(vps, identity)"
                    :disabled="savingQuota[`${identity.id}:${vps.id}`]"
                    class="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 active:scale-95 transition-all shadow-sm shadow-blue-500/10 cursor-pointer disabled:opacity-50 shrink-0"
                  >
                    <Save class="w-3.5 h-3.5" />
                    <span>{{ savingQuota[`${identity.id}:${vps.id}`] ? '保存中' : '保存' }}</span>
                  </button>

                  <button
                    v-if="getGrant(vps.id, identity.id)"
                    @click="promptRemoveGrant(vps, identity)"
                    title="移除此节点的额度授权"
                    class="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 border border-transparent hover:border-rose-200 dark:hover:border-rose-900/50 transition-colors cursor-pointer shrink-0"
                  >
                    <Trash2 class="w-3.5 h-3.5" />
                  </button>
                </div>

                <!-- Quick Presets -->
                <div class="flex items-center gap-1.5 mt-2 overflow-x-auto no-scrollbar">
                  <span class="text-[10px] text-slate-400 shrink-0">预设:</span>
                  <button
                    v-for="p in presets"
                    :key="p"
                    @click="setQuotaInputVal(vps.id, identity.id, p)"
                    type="button"
                    class="px-1.5 py-0.5 text-[10px] font-medium rounded-md bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-blue-50 dark:hover:bg-blue-950/40 hover:text-blue-600 dark:hover:text-blue-400 text-slate-600 dark:text-slate-300 transition-colors cursor-pointer shrink-0"
                  >
                    {{ p }}G
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Add Identity Modal -->
    <Modal v-model="showAddModal" title="添加新用户身份" max-width="md">
      <form @submit.prevent="handleAddIdentity" class="space-y-4">
        <div>
          <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
            身份名称 / 备注
          </label>
          <input
            v-model="newIdentityName"
            type="text"
            required
            placeholder="例如: Alice, Phone, MacBook..."
            class="w-full px-3.5 py-2 text-sm rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
          />
          <p class="text-[11px] text-slate-400 dark:text-slate-500 mt-1.5">
            身份创建后将在各 VPS 拥有独立的 Reality 凭据，可在本页面随时分配或修改月额度。系统上限 50 个身份。
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
            :disabled="addingIdentity || !newIdentityName.trim()"
            class="px-4 py-2 text-sm font-semibold rounded-xl text-white bg-blue-600 hover:bg-blue-700 active:scale-95 shadow-md shadow-blue-500/20 disabled:opacity-50 transition-all cursor-pointer"
          >
            {{ addingIdentity ? '创建中...' : '确认创建' }}
          </button>
        </div>
      </form>
    </Modal>

    <!-- Confirm Remove Grant Modal -->
    <ConfirmModal
      v-model="showRemoveGrantModal"
      title="移除节点授权"
      :message="`确定要移除身份 “${pendingRemove?.identityName}” 在节点 “${pendingRemove?.vpsName}” 的授权吗？移除后该设备将无法通过此节点代理，当月已用流量记录将保留。`"
      confirm-text="确认移除"
      :is-destructive="true"
      :loading="removingGrant"
      @confirm="confirmRemoveGrant"
    />
  </div>
</template>
