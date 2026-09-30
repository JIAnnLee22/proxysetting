<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { initTheme } from './lib/theme'
import { initAuth, isAdmin, clearAdminAuth } from './lib/auth'
import { api } from './lib/api'
import { showToast } from './lib/toast'
import type { PeriodData } from './lib/analytics'

import Navbar from './components/Navbar.vue'
import Toast from './components/Toast.vue'
import OverviewView from './components/OverviewView.vue'
import IdentitiesView from './components/IdentitiesView.vue'
import VpsView from './components/VpsView.vue'
import ExportView from './components/ExportView.vue'
import HistoryModal from './components/HistoryModal.vue'
import LoginModal from './components/LoginModal.vue'

import {
  Activity,
  Server,
  Users,
  FileCode,
  AlertCircle,
  RefreshCw
} from '@lucide/vue'

const currentTab = ref('overview')
const state = ref<any | null>(null)
const loading = ref(false)
const error = ref('')

const dailyData = ref<PeriodData[]>([])
const monthlyData = ref<PeriodData[]>([])
const yearlyData = ref<PeriodData[]>([])
const timeDimension = ref('daily')
const loadingStats = ref(false)

const showHistoryModal = ref(false)
const showLoginModal = ref(false)

// Tabs definition based on auth status:
// Guests only see Overview (流量监控) and Export (订阅导出)
// Admins see all 4 tabs (Overview, Identities & Quotas, VPS Nodes, Export)
const tabs = computed(() => {
  if (!isAdmin.value) {
    return [
      { id: 'overview', label: '总览监控', icon: Activity },
      { id: 'export', label: '订阅导出', icon: FileCode }
    ]
  }

  return [
    { id: 'overview', label: '总览监控', icon: Activity },
    {
      id: 'identities',
      label: '身份与额度',
      icon: Users,
      count: state.value?.identities?.length
    },
    {
      id: 'vps',
      label: 'VPS 节点',
      icon: Server,
      count: state.value?.vps?.length
    },
    { id: 'export', label: '订阅导出', icon: FileCode }
  ]
})

const currentData = computed(() => {
  if (timeDimension.value === 'yearly') return yearlyData.value
  if (timeDimension.value === 'monthly') return monthlyData.value
  return dailyData.value
})

async function fetchStats() {
  loadingStats.value = true
  const todayDate = new Date(Date.now() + 8 * 3600 * 1000)
  const today = todayDate.toISOString().slice(0, 10)
  const thisMonth = today.slice(0, 7)
  const thisYear = today.slice(0, 4)

  try {
    if (timeDimension.value === 'daily') {
      const res = await api<PeriodData[]>(`analytics?type=daily&start=${today}&end=${today}`)
      dailyData.value = Array.isArray(res) ? res : []
    } else if (timeDimension.value === 'monthly') {
      const res = await api<PeriodData[]>(`analytics?type=month&start=${thisMonth}&end=${thisMonth}`)
      monthlyData.value = Array.isArray(res) ? res : []
    } else if (timeDimension.value === 'yearly') {
      const [h1, h2] = await Promise.all([
        api<PeriodData[]>(`analytics?type=month&start=${thisYear}-01&end=${thisYear}-06`).catch(() => []),
        api<PeriodData[]>(`analytics?type=month&start=${thisYear}-07&end=${thisYear}-12`).catch(() => [])
      ])
      yearlyData.value = [...(Array.isArray(h1) ? h1 : []), ...(Array.isArray(h2) ? h2 : [])]
    }
  } catch (e: any) {
    console.error('Fetch stats error:', e)
  } finally {
    loadingStats.value = false
  }
}

async function refreshAll() {
  loading.value = true
  error.value = ''
  try {
    const res = await api('state')
    state.value = res
    if (typeof res?.isAdmin === 'boolean') {
      isAdmin.value = res.isAdmin
    }
    await fetchStats()
  } catch (e: any) {
    error.value = e.message || '获取系统状态失败'
    showToast(error.value, 'error')
  } finally {
    loading.value = false
  }
}

function handleSelectTab(id: string) {
  currentTab.value = id
  window.location.hash = id
}

function handleLogout() {
  clearAdminAuth()
  showToast('已退出管理员模式，切回访客控制台', 'info')
  if (['identities', 'vps'].includes(currentTab.value)) {
    handleSelectTab('overview')
  }
  refreshAll()
}

// Watch admin status change
watch(isAdmin, (val) => {
  if (!val && ['identities', 'vps'].includes(currentTab.value)) {
    handleSelectTab('overview')
  }
})

onMounted(() => {
  initTheme()
  initAuth()
  refreshAll()

  // Hash route
  const hash = window.location.hash.slice(1)
  if (['overview', 'identities', 'vps', 'export'].includes(hash)) {
    // If not admin and requested admin tab, fallback to overview
    if (!isAdmin.value && ['identities', 'vps'].includes(hash)) {
      currentTab.value = 'overview'
    } else {
      currentTab.value = hash
    }
  }

  window.addEventListener('hashchange', () => {
    const newHash = window.location.hash.slice(1)
    if (['overview', 'identities', 'vps', 'export'].includes(newHash)) {
      if (!isAdmin.value && ['identities', 'vps'].includes(newHash)) {
        currentTab.value = 'overview'
      } else {
        currentTab.value = newHash
      }
    }
  })
})
</script>

<template>
  <div class="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 flex flex-col font-sans transition-colors duration-200">
    <!-- Navbar -->
    <Navbar
      :current-tab="currentTab"
      :tabs="tabs"
      :loading="loading"
      :current-month="state?.calendar?.month"
      :is-admin="isAdmin"
      @select-tab="handleSelectTab"
      @refresh="refreshAll"
      @open-history="showHistoryModal = true"
      @open-login="showLoginModal = true"
      @logout="handleLogout"
    />

    <!-- Toast Notification Hub -->
    <Toast />

    <!-- Main Container -->
    <main class="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
      <!-- Global Error State -->
      <div
        v-if="error && !state"
        class="p-6 rounded-2xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 text-rose-900 dark:text-rose-100 flex items-start gap-4 mb-6 shadow-sm"
      >
        <AlertCircle class="w-6 h-6 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
        <div class="flex-1">
          <h3 class="text-base font-bold">连接控制台失败</h3>
          <p class="text-xs text-rose-700 dark:text-rose-300 mt-1">{{ error }}</p>
          <button
            @click="refreshAll"
            class="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-rose-600 text-white hover:bg-rose-700 transition-colors cursor-pointer"
          >
            <RefreshCw class="w-3.5 h-3.5" />
            <span>重新连接</span>
          </button>
        </div>
      </div>

      <!-- Initial Loading Skeleton -->
      <div v-else-if="!state && loading" class="space-y-6 animate-pulse">
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div v-for="i in 4" :key="i" class="h-28 rounded-2xl bg-slate-200 dark:bg-slate-800/60"></div>
        </div>
        <div class="h-64 rounded-2xl bg-slate-200 dark:bg-slate-800/60"></div>
        <div class="h-48 rounded-2xl bg-slate-200 dark:bg-slate-800/60"></div>
      </div>

      <!-- Tab Views -->
      <div v-else>
        <!-- Tab: Overview (流量监控 - 公开) -->
        <OverviewView
          v-if="currentTab === 'overview'"
          :state="state"
          :time-dimension="timeDimension"
          :current-data="currentData"
          :loading-stats="loadingStats"
          @update:time-dimension="timeDimension = $event"
          @refresh-stats="fetchStats"
        />

        <!-- Tab: Identities & Quotas (仅管理员) -->
        <IdentitiesView
          v-else-if="currentTab === 'identities' && isAdmin"
          :state="state"
          @refresh="refreshAll"
        />

        <!-- Tab: VPS Nodes (仅管理员) -->
        <VpsView
          v-else-if="currentTab === 'vps' && isAdmin"
          :state="state"
          @refresh="refreshAll"
        />

        <!-- Tab: Export Verge Script (订阅导出 - 公开) -->
        <ExportView
          v-else-if="currentTab === 'export'"
          :state="state"
        />
      </div>
    </main>

    <!-- History Query Modal (Admin only) -->
    <HistoryModal
      v-if="isAdmin"
      v-model="showHistoryModal"
      :default-period="state?.calendar?.month"
    />

    <!-- Admin Login Modal -->
    <LoginModal
      v-model="showLoginModal"
      @login-success="refreshAll"
    />
  </div>
</template>
