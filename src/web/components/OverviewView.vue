<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { formatBytes, aggregate, getTrafficUsers, type PeriodData } from '../lib/analytics'
import TrafficChart from './TrafficChart.vue'
import Modal from './Modal.vue'
import {
  Activity,
  ArrowUpRight,
  ArrowDownLeft,
  Server,
  Award,
  Calendar,
  TrendingUp,
  BarChart3,
  ChevronDown,
  ChevronUp,
  Table2,
  LayoutList,
  ArrowUpDown,
  CalendarDays
} from '@lucide/vue'

const props = defineProps<{
  state: any
  timeDimension: string
  currentData: PeriodData[]
  loadingStats?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:timeDimension', val: string): void
  (e: 'refresh-stats'): void
}>()

// Sort column for users in cards: 'total' | 'uplink' | 'downlink'
const sortBy = ref<'total' | 'uplink' | 'downlink'>('total')

// View mode: 'cards' (list of user cards) | 'matrix' (day-by-day table)
const viewMode = ref<'cards' | 'matrix'>('cards')

// Selected sub-period filter: 'all' or specific date string 'YYYY-MM-DD' / 'YYYY-MM'
const selectedSubPeriod = ref<string>('all')
const activePeriodLabel = computed(() => selectedSubPeriod.value === 'all'
  ? (props.timeDimension === 'daily' ? '近 7 天累计' : props.timeDimension === 'monthly' ? '近 6 个月累计' : '本年累计')
  : `${formatPeriodLabel(selectedSubPeriod.value)} ${props.timeDimension === 'daily' ? '当日' : '当月'}`
)

// Keep expanded users open when selecting another date in the chart.
const expandedUsers = ref<Record<string, boolean>>({})

// Matrix sorting
const matrixSortKey = ref<string>('total')
const matrixSortAsc = ref<boolean>(false)

// Node Detail Modal State
const showNodeModal = ref<boolean>(false)
const selectedNodeDetail = ref<{
  userId: string
  userName: string
  periodKey: string
  periodLabel: string
  isToday: boolean
  total: number
  uplink: number
  downlink: number
  vpsList: VpsTrafficStat[]
} | null>(null)

// Reset sub-period and expanded users when main time dimension changes
watch(() => props.timeDimension, () => {
  selectedSubPeriod.value = 'all'
  expandedUsers.value = {}
  matrixSortKey.value = 'total'
  matrixSortAsc.value = false
})

// Current Beijing Date & Month
const todayDateStr = computed(() => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10))
const thisMonthStr = computed(() => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 7))

interface TrafficStat {
  uplink: number
  downlink: number
  total: number
}

export interface VpsTrafficStat {
  vpsId: string
  name: string
  address: string
  port: number
  status?: string
  uplink: number
  downlink: number
  total: number
  percent: number
}

function formatPeriodLabel(key: string): string {
  if (!key) return ''
  if (key.length > 7) {
    return key.slice(5) // '10-15'
  }
  return key.slice(5) + '月'
}

// Available sub-periods in chronological order
const availableSubPeriods = computed(() => {
  const set = new Set<string>()
  for (const row of props.currentData) {
    const key = row.period
    if (key) set.add(key)
  }
  const sorted = Array.from(set).sort()
  return sorted.map((key) => ({
    key,
    label: formatPeriodLabel(key),
    isToday: key === todayDateStr.value,
    isCurrentMonth: key === thisMonthStr.value
  }))
})

// Full multi-dimensional traffic matrix
const trafficMatrix = computed(() => {
  const userPeriodMap = new Map<string, Map<string, TrafficStat>>()
  const userPeriodVpsMap = new Map<string, Map<string, Map<string, TrafficStat>>>()
  const userTotals = new Map<string, TrafficStat>()
  const userVpsTotals = new Map<string, Map<string, TrafficStat>>()
  const periodTotals = new Map<string, TrafficStat>()
  const periodVpsTotals = new Map<string, Map<string, TrafficStat>>()
  let grandUp = 0
  let grandDown = 0

  for (const row of props.currentData) {
    const periodKey = row.period
    const vpsId = row.vps_id
    if (!periodKey || !vpsId) continue

    const pStat = periodTotals.get(periodKey) || { uplink: 0, downlink: 0, total: 0 }

    // Period VPS Totals
    let pVpsMap = periodVpsTotals.get(periodKey)
    if (!pVpsMap) {
      pVpsMap = new Map<string, TrafficStat>()
      periodVpsTotals.set(periodKey, pVpsMap)
    }
    const pvStat = pVpsMap.get(vpsId) || { uplink: 0, downlink: 0, total: 0 }

    const list = getTrafficUsers(row)

    for (const u of list) {
      const up = u.uplink || 0
      const down = u.downlink || 0
      const tot = up + down

      pStat.uplink += up
      pStat.downlink += down
      pStat.total += tot

      pvStat.uplink += up
      pvStat.downlink += down
      pvStat.total += tot

      // Per user per period
      let uPeriods = userPeriodMap.get(u.id)
      if (!uPeriods) {
        uPeriods = new Map<string, TrafficStat>()
        userPeriodMap.set(u.id, uPeriods)
      }
      const uStat = uPeriods.get(periodKey) || { uplink: 0, downlink: 0, total: 0 }
      uStat.uplink += up
      uStat.downlink += down
      uStat.total += tot
      uPeriods.set(periodKey, uStat)

      // Per user per period per VPS
      let uPeriodVps = userPeriodVpsMap.get(u.id)
      if (!uPeriodVps) {
        uPeriodVps = new Map<string, Map<string, TrafficStat>>()
        userPeriodVpsMap.set(u.id, uPeriodVps)
      }
      let uVpsMap = uPeriodVps.get(periodKey)
      if (!uVpsMap) {
        uVpsMap = new Map<string, TrafficStat>()
        uPeriodVps.set(periodKey, uVpsMap)
      }
      const uvStat = uVpsMap.get(vpsId) || { uplink: 0, downlink: 0, total: 0 }
      uvStat.uplink += up
      uvStat.downlink += down
      uvStat.total += tot
      uVpsMap.set(vpsId, uvStat)

      // Per user grand total
      const uTot = userTotals.get(u.id) || { uplink: 0, downlink: 0, total: 0 }
      uTot.uplink += up
      uTot.downlink += down
      uTot.total += tot
      userTotals.set(u.id, uTot)

      // Per user all-VPS grand total
      let uAllVps = userVpsTotals.get(u.id)
      if (!uAllVps) {
        uAllVps = new Map<string, TrafficStat>()
        userVpsTotals.set(u.id, uAllVps)
      }
      const uAllStat = uAllVps.get(vpsId) || { uplink: 0, downlink: 0, total: 0 }
      uAllStat.uplink += up
      uAllStat.downlink += down
      uAllStat.total += tot
      uAllVps.set(vpsId, uAllStat)

      grandUp += up
      grandDown += down
    }

    periodTotals.set(periodKey, pStat)
    pVpsMap.set(vpsId, pvStat)
  }

  return {
    userPeriodMap,
    userPeriodVpsMap,
    userTotals,
    userVpsTotals,
    periodTotals,
    periodVpsTotals,
    grandTotal: { uplink: grandUp, downlink: grandDown, total: grandUp + grandDown }
  }
})

// Global aggregated totals (across all periods)
const aggr = computed(() => aggregate(props.currentData))
const totalBytes = computed(() => aggr.value.totalUp + aggr.value.totalDown)
const hasMissingDailyRecords = computed(() => props.timeDimension === 'daily' && props.currentData.some(row =>
  !row.daily || row.daily.date !== row.period || row.daily.quality === 'missing'
))

// Today or This Month bytes for KPI card
const thisPeriodBytes = computed(() => {
  if (props.timeDimension === 'daily') {
    return trafficMatrix.value.periodTotals.get(todayDateStr.value)?.total ?? 0
  }
  if (props.timeDimension === 'monthly') {
    return trafficMatrix.value.periodTotals.get(thisMonthStr.value)?.total ?? 0
  }
  return null
})

// Active scope total bytes (either 'all' or selected sub-period)
const activeTotalBytes = computed(() => {
  if (selectedSubPeriod.value === 'all') {
    return trafficMatrix.value.grandTotal.total
  }
  return trafficMatrix.value.periodTotals.get(selectedSubPeriod.value)?.total || 0
})

const activeTotalUp = computed(() => {
  if (selectedSubPeriod.value === 'all') {
    return trafficMatrix.value.grandTotal.uplink
  }
  return trafficMatrix.value.periodTotals.get(selectedSubPeriod.value)?.uplink || 0
})

const activeTotalDown = computed(() => {
  if (selectedSubPeriod.value === 'all') {
    return trafficMatrix.value.grandTotal.downlink
  }
  return trafficMatrix.value.periodTotals.get(selectedSubPeriod.value)?.downlink || 0
})

// Sorted users list in Cards view for current active sub-period
const sortedUsers = computed(() => {
  const isAll = selectedSubPeriod.value === 'all'
  const list: Array<{ id: string; uplink: number; downlink: number; total: number }> = []

  if (isAll) {
    for (const [id, stats] of trafficMatrix.value.userTotals.entries()) {
      list.push({ id, ...stats })
    }
  } else {
    const pKey = selectedSubPeriod.value
    for (const [id, periodMap] of trafficMatrix.value.userPeriodMap.entries()) {
      const stats = periodMap.get(pKey)
      if (stats) list.push({ id, ...stats })
    }
  }

  return list.sort((a, b) => {
    if (sortBy.value === 'uplink') return b.uplink - a.uplink || b.total - a.total
    if (sortBy.value === 'downlink') return b.downlink - a.downlink || b.total - a.total
    return b.total - a.total || a.id.localeCompare(b.id)
  })
})

// Chart preparation
const chartKeys = computed(() => {
  const map = trafficMatrix.value.periodTotals
  return Array.from(map.keys()).sort()
})

const chartData = computed(() => {
  const keys = chartKeys.value
  if (keys.length === 0) {
    return { labels: ['暂无数据'], up: [0], down: [0] }
  }

  const labels: string[] = []
  const up: number[] = []
  const down: number[] = []

  for (const k of keys) {
    labels.push(formatPeriodLabel(k))
    const val = trafficMatrix.value.periodTotals.get(k)!
    up.push(val.uplink)
    down.push(val.downlink)
  }

  return { labels, up, down }
})

const selectedChartIndex = computed(() => {
  if (selectedSubPeriod.value === 'all') return null
  const idx = chartKeys.value.indexOf(selectedSubPeriod.value)
  return idx >= 0 ? idx : null
})

function handleChartSelect(index: number) {
  const key = chartKeys.value[index]
  if (key) {
    if (selectedSubPeriod.value === key) {
      selectedSubPeriod.value = 'all'
    } else {
      selectedSubPeriod.value = key
    }
  }
}

function toggleExpandUser(id: string) {
  expandedUsers.value[id] = !expandedUsers.value[id]
}

function getUserName(id: string) {
  const match = props.state?.identities?.find((i: any) => i.id === id)
  return match ? match.name : id
}

function getUserPeriodVpsList(userId: string, periodKey: string = 'all', includeZero = false): VpsTrafficStat[] {
  let targetVpsMap: Map<string, TrafficStat> | undefined
  let totalRef = 0

  if (periodKey === 'all') {
    targetVpsMap = trafficMatrix.value.userVpsTotals.get(userId)
    totalRef = trafficMatrix.value.userTotals.get(userId)?.total || 0
  } else {
    targetVpsMap = trafficMatrix.value.userPeriodVpsMap.get(userId)?.get(periodKey)
    totalRef = trafficMatrix.value.userPeriodMap.get(userId)?.get(periodKey)?.total || 0
  }

  if (!targetVpsMap) return []

  const list: VpsTrafficStat[] = []
  for (const [vpsId, stat] of targetVpsMap.entries()) {
    if (!includeZero && stat.total <= 0 && stat.uplink <= 0 && stat.downlink <= 0) continue
    const v = props.state?.vps?.find((x: any) => x.id === vpsId)
    const pct = totalRef > 0 ? (stat.total / totalRef) * 100 : 0
    list.push({
      vpsId,
      name: v?.name || vpsId.slice(0, 8),
      address: v?.address || '',
      port: v?.port || 0,
      status: v?.status,
      uplink: stat.uplink,
      downlink: stat.downlink,
      total: stat.total,
      percent: Math.round(pct * 10) / 10
    })
  }

  return list.sort((a, b) => b.total - a.total)
}

function openNodeDetail(userId: string, periodKey: string, periodLabel?: string) {
  const stat = periodKey === 'all'
    ? trafficMatrix.value.userTotals.get(userId)
    : trafficMatrix.value.userPeriodMap.get(userId)?.get(periodKey)

  const vpsList = getUserPeriodVpsList(userId, periodKey)
  const label = periodLabel || formatPeriodLabel(periodKey)
  const isToday = periodKey === todayDateStr.value

  selectedNodeDetail.value = {
    userId,
    userName: getUserName(userId),
    periodKey,
    periodLabel: label,
    isToday,
    total: stat?.total || 0,
    uplink: stat?.uplink || 0,
    downlink: stat?.downlink || 0,
    vpsList
  }
  showNodeModal.value = true
}

function getCellTooltip(row: any, cell: any): string {
  if (!cell.total || cell.total <= 0) {
    return `${row.name} 在 ${cell.label}: 暂无流量消耗`
  }
  const vpsList = getUserPeriodVpsList(row.id, cell.key)
  let text = `${row.name} 在 ${cell.label}:\n合计: ${formatBytes(cell.total)} (↑ ${formatBytes(cell.uplink)} / ↓ ${formatBytes(cell.downlink)})`
  if (vpsList.length > 0) {
    text += `\n各节点用量:`
    for (const v of vpsList) {
      text += `\n  • ${v.name}: ${formatBytes(v.total)} (${v.percent}%) [↑ ${formatBytes(v.uplink)} / ↓ ${formatBytes(v.downlink)}]`
    }
  }
  text += '\n(点击查看节点明细弹窗)'
  return text
}

// Matrix (Day-by-Day Pivot Table) computed data
const matrixData = computed(() => {
  const periods = availableSubPeriods.value
  const userMap = trafficMatrix.value.userPeriodMap
  const userTotals = trafficMatrix.value.userTotals

  const userIds = Array.from(new Set([
    ...Array.from(userTotals.keys()),
    ...(props.state?.identities || []).map((i: any) => i.id)
  ]))

  let maxCellBytes = 0
  const rows = userIds.map(id => {
    const periodMap = userMap.get(id)
    const totals = userTotals.get(id) || { uplink: 0, downlink: 0, total: 0 }

    const cells = periods.map(p => {
      const stat = periodMap?.get(p.key) || { uplink: 0, downlink: 0, total: 0 }
      if (stat.total > maxCellBytes) {
        maxCellBytes = stat.total
      }
      return {
        key: p.key,
        label: p.label,
        ...stat
      }
    })

    return {
      id,
      name: getUserName(id),
      cells,
      total: totals.total,
      uplink: totals.uplink,
      downlink: totals.downlink
    }
  }).filter(row => row.total > 0)

  // Sort rows based on matrixSortKey
  const sortKey = matrixSortKey.value
  const sortAsc = matrixSortAsc.value

  rows.sort((a, b) => {
    let valA = 0
    let valB = 0
    if (sortKey === 'total') {
      valA = a.total
      valB = b.total
    } else {
      valA = a.cells.find(c => c.key === sortKey)?.total || 0
      valB = b.cells.find(c => c.key === sortKey)?.total || 0
    }
    const diff = sortAsc ? valA - valB : valB - valA
    return diff || a.name.localeCompare(b.name)
  })

  const colSummaries = periods.map(p => {
    const pStat = trafficMatrix.value.periodTotals.get(p.key) || { uplink: 0, downlink: 0, total: 0 }
    return {
      key: p.key,
      label: p.label,
      ...pStat
    }
  })

  return {
    periods,
    rows,
    colSummaries,
    maxCellBytes,
    grandTotal: trafficMatrix.value.grandTotal
  }
})

function handleMatrixSort(key: string) {
  if (matrixSortKey.value === key) {
    matrixSortAsc.value = !matrixSortAsc.value
  } else {
    matrixSortKey.value = key
    matrixSortAsc.value = false
  }
}

function getCellHeatmapClass(bytes: number, maxBytes: number) {
  if (!bytes || bytes <= 0 || !maxBytes) {
    return 'text-slate-400 dark:text-slate-600 font-normal'
  }
  const ratio = bytes / maxBytes
  if (ratio > 0.6) {
    return 'bg-blue-500/20 text-blue-700 dark:bg-blue-500/30 dark:text-blue-200 font-bold'
  }
  if (ratio > 0.25) {
    return 'bg-blue-500/10 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300 font-semibold'
  }
  return 'text-slate-700 dark:text-slate-300'
}

// VPS breakdown in current data (reactive to selectedSubPeriod)
const vpsBreakdown = computed(() => {
  const isAll = selectedSubPeriod.value === 'all'
  const vpsMap = isAll ? null : trafficMatrix.value.periodVpsTotals.get(selectedSubPeriod.value)

  const allMap = new Map<string, TrafficStat>()
  if (isAll) {
    for (const row of props.currentData) {
      const vId = row.vps_id
      const current = allMap.get(vId) || { uplink: 0, downlink: 0, total: 0 }
      const list = getTrafficUsers(row)
      for (const u of list) {
        const up = u.uplink || 0
        const down = u.downlink || 0
        current.uplink += up
        current.downlink += down
        current.total += up + down
      }
      allMap.set(vId, current)
    }
  }

  return (props.state?.vps || []).map((v: any) => {
    const usage = isAll
      ? (allMap.get(v.id) || { uplink: 0, downlink: 0, total: 0 })
      : (vpsMap?.get(v.id) || { uplink: 0, downlink: 0, total: 0 })
    return {
      id: v.id,
      name: v.name,
      address: v.address,
      port: v.port,
      status: v.status,
      up: usage.uplink,
      down: usage.downlink,
      total: usage.total
    }
  }).sort((a: any, b: any) => b.total - a.total)
})

const activeVpsTotalBytes = computed(() => {
  return vpsBreakdown.value.reduce((acc: number, v: any) => acc + v.total, 0)
})
</script>

<template>
  <div class="space-y-6">
    <!-- Top Filter Bar -->
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div>
        <h2 class="text-base font-bold text-slate-900 dark:text-white tracking-tight flex items-center gap-2">
          <span>用量监控与统计总览</span>
          <span v-if="loadingStats" class="text-xs font-normal text-blue-500 animate-pulse">更新中...</span>
        </h2>
        <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Xray 原始计量流量（上行 + 下行），支持自然日、自然月与年汇总分析</p>
      </div>

      <!-- Time Dimension Selector -->
      <div class="inline-flex p-1 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 self-start sm:self-auto">
        <button
          v-for="d in [
            { id: 'daily', label: '近 7 天 (Daily)' },
            { id: 'monthly', label: '近 6 个月 (Monthly)' },
            { id: 'yearly', label: '本年 (Yearly)' }
          ]"
          :key="d.id"
          @click="$emit('update:timeDimension', d.id); $emit('refresh-stats')"
          class="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer"
          :class="[
            timeDimension === d.id
              ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-sm'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          ]"
        >
          {{ d.label }}
        </button>
      </div>
    </div>

    <p v-if="hasMissingDailyRecords" class="text-xs text-amber-600 dark:text-amber-400">
      部分节点缺少有效日报，图表与排行仅汇总可用日报，不将旧版月累计计为单日流量；缺失日报的节点不计为零用量。
    </p>

    <!-- 4 KPI Cards -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <!-- Total Traffic -->
      <div class="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm hover:shadow-md transition-shadow relative overflow-hidden">
        <div class="flex items-center justify-between mb-3">
          <span class="text-xs font-semibold text-slate-500 dark:text-slate-400">
            {{ timeDimension === 'daily' ? '近 7 天' : timeDimension === 'monthly' ? '近 6 个月' : '本年' }}总量
          </span>
          <div class="w-8 h-8 rounded-lg bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 flex items-center justify-center">
            <Activity class="w-4 h-4" />
          </div>
        </div>
        <div class="text-2xl font-black text-slate-900 dark:text-white tracking-tight">
          {{ formatBytes(totalBytes) }}
        </div>
        <div class="mt-2 flex items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400">
          <span class="text-blue-600 dark:text-blue-400 font-medium">↑ {{ formatBytes(aggr.totalUp) }}</span>
          <span>•</span>
          <span class="text-emerald-600 dark:text-emerald-400 font-medium">↓ {{ formatBytes(aggr.totalDown) }}</span>
          <span v-if="thisPeriodBytes !== null" class="ml-auto text-slate-400 font-normal">
            {{ timeDimension === 'daily' ? '今日' : '当月' }}: {{ formatBytes(thisPeriodBytes) }}
          </span>
        </div>
      </div>

      <!-- Uplink Card -->
      <div class="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm hover:shadow-md transition-shadow">
        <div class="flex items-center justify-between mb-3">
          <span class="text-xs font-semibold text-slate-500 dark:text-slate-400">上行总计 (Uplink)</span>
          <div class="w-8 h-8 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center">
            <ArrowUpRight class="w-4 h-4" />
          </div>
        </div>
        <div class="text-2xl font-black text-slate-900 dark:text-white tracking-tight">
          {{ formatBytes(aggr.totalUp) }}
        </div>
        <div class="mt-2 text-[11px] text-slate-400">
          占比 {{ totalBytes > 0 ? ((aggr.totalUp / totalBytes) * 100).toFixed(1) : 0 }}%
        </div>
      </div>

      <!-- Downlink Card -->
      <div class="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm hover:shadow-md transition-shadow">
        <div class="flex items-center justify-between mb-3">
          <span class="text-xs font-semibold text-slate-500 dark:text-slate-400">下行总计 (Downlink)</span>
          <div class="w-8 h-8 rounded-lg bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
            <ArrowDownLeft class="w-4 h-4" />
          </div>
        </div>
        <div class="text-2xl font-black text-slate-900 dark:text-white tracking-tight">
          {{ formatBytes(aggr.totalDown) }}
        </div>
        <div class="mt-2 text-[11px] text-slate-400">
          占比 {{ totalBytes > 0 ? ((aggr.totalDown / totalBytes) * 100).toFixed(1) : 0 }}%
        </div>
      </div>

      <!-- Health Nodes Card -->
      <div class="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm hover:shadow-md transition-shadow">
        <div class="flex items-center justify-between mb-3">
          <span class="text-xs font-semibold text-slate-500 dark:text-slate-400">节点在线率</span>
          <div class="w-8 h-8 rounded-lg bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
            <Server class="w-4 h-4" />
          </div>
        </div>
        <div class="text-2xl font-black text-slate-900 dark:text-white tracking-tight">
          {{ state?.vps?.filter((v: any) => v.status === 'ready').length || 0 }} <span class="text-sm font-normal text-slate-400">/ {{ state?.vps?.length || 0 }}</span>
        </div>
        <div class="mt-2 text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
          有效身份 {{ state?.identities?.filter((i: any) => i.enabled).length || 0 }} 个
        </div>
      </div>
    </div>

    <!-- Traffic Trend Chart -->
    <div class="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
        <div>
          <h3 class="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <TrendingUp class="w-4 h-4 text-blue-600 dark:text-blue-400" />
            <span>流量走势曲线</span>
          </h3>
          <p class="text-xs text-slate-400 mt-0.5">
            {{ timeDimension === 'daily' ? '近 7 天按日上下行消耗趋势' : timeDimension === 'monthly' ? '近 6 个月按月消耗趋势' : '本年度各月消耗趋势' }}
            <span class="text-blue-500 dark:text-blue-400 ml-1">· 点击数据点筛选{{ timeDimension === 'daily' ? '当天' : '当月' }}排行，再次点击取消；展开用户查看各节点用量</span>
          </p>
        </div>

        <div v-if="selectedSubPeriod !== 'all'" class="flex items-center gap-2">
          <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-blue-50 dark:bg-blue-950/70 text-blue-600 dark:text-blue-300 border border-blue-200 dark:border-blue-900/60">
            <CalendarDays class="w-3.5 h-3.5" />
            <span>已选定: {{ formatPeriodLabel(selectedSubPeriod) }}</span>
          </span>
          <button
            @click="selectedSubPeriod = 'all'"
            class="text-xs text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 underline cursor-pointer"
          >
            清除筛选
          </button>
        </div>
      </div>

      <TrafficChart
        :labels="chartData.labels"
        :uplink-data="chartData.up"
        :downlink-data="chartData.down"
        :selected-index="selectedChartIndex"
        @select-index="handleChartSelect"
      />
    </div>

    <!-- Bottom Layout: User Analytics & VPS Breakdown -->
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <!-- User Rankings & Matrix (2 cols on lg) -->
      <div class="lg:col-span-2 p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm space-y-4">
        <!-- Header Bar with Title, Sub-period filter, View Switcher & Sorting -->
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-100 dark:border-slate-800">
          <div>
            <div class="flex items-center gap-2">
              <Award class="w-4 h-4 text-amber-500" />
              <h3 class="text-sm font-bold text-slate-900 dark:text-white">
                {{ viewMode === 'matrix' ? '用户每日消耗透视矩阵' : '用户用量排行榜' }}
              </h3>
              <span class="text-xs px-2 py-0.5 rounded-full font-medium" :class="selectedSubPeriod === 'all' ? 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400' : 'bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800'">
                {{ activePeriodLabel }}
              </span>
            </div>
            <p class="text-xs text-slate-400 mt-0.5">
              {{ viewMode === 'matrix' ? '横向对比所有用户在各周期的流量使用情况' : '在上方趋势图选择日期，点击用户卡片展开各节点用量' }}
            </p>
          </div>

          <!-- Controls: View Mode Switcher & Sort Buttons -->
          <div class="flex flex-wrap items-center gap-2 self-start sm:self-auto">
            <!-- View Mode Switcher -->
            <div class="inline-flex p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
              <button
                @click="viewMode = 'cards'"
                title="卡片列表视图"
                class="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-all cursor-pointer"
                :class="viewMode === 'cards' ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-sm' : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'"
              >
                <LayoutList class="w-3.5 h-3.5" />
                <span class="hidden sm:inline">排行卡片</span>
              </button>
              <button
                @click="viewMode = 'matrix'"
                title="每日透视矩阵视图"
                class="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-all cursor-pointer"
                :class="viewMode === 'matrix' ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-sm' : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'"
              >
                <Table2 class="w-3.5 h-3.5" />
                <span class="hidden sm:inline">每日透视</span>
              </button>
            </div>

            <!-- Sort buttons (for cards view) -->
            <div v-if="viewMode === 'cards'" class="inline-flex items-center gap-1 text-xs">
              <button
                @click="sortBy = 'total'"
                class="px-2.5 py-1 rounded-lg font-medium transition-colors cursor-pointer"
                :class="sortBy === 'total' ? 'bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400 font-semibold' : 'text-slate-400 hover:text-slate-600'"
              >
                按总计
              </button>
              <button
                @click="sortBy = 'downlink'"
                class="px-2.5 py-1 rounded-lg font-medium transition-colors cursor-pointer"
                :class="sortBy === 'downlink' ? 'bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400 font-semibold' : 'text-slate-400 hover:text-slate-600'"
              >
                按下行
              </button>
              <button
                @click="sortBy = 'uplink'"
                class="px-2.5 py-1 rounded-lg font-medium transition-colors cursor-pointer"
                :class="sortBy === 'uplink' ? 'bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400 font-semibold' : 'text-slate-400 hover:text-slate-600'"
              >
                按上行
              </button>
            </div>
          </div>
        </div>

        <!-- 1. Cards View -->
        <div v-if="viewMode === 'cards'">
          <div v-if="sortedUsers.length === 0" class="py-12 text-center text-xs text-slate-400">
            {{ activePeriodLabel }}暂无可用用户用量记录
          </div>

          <div v-else class="space-y-3">
            <div
              v-for="(user, idx) in sortedUsers"
              :key="user.id"
              class="rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 overflow-hidden transition-all hover:border-slate-200 dark:hover:border-slate-700"
            >
              <!-- Card Main Header -->
              <div
                @click="toggleExpandUser(user.id)"
                class="p-3.5 cursor-pointer hover:bg-slate-100/60 dark:hover:bg-slate-800/60 transition-colors select-none"
              >
                <div class="flex items-center justify-between gap-3 mb-2">
                  <div class="flex items-center gap-3 min-w-0">
                    <!-- Rank Badge -->
                    <div
                      class="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
                      :class="[
                        idx === 0 ? 'bg-amber-400 text-amber-950 shadow-sm shadow-amber-500/20' :
                        idx === 1 ? 'bg-slate-300 dark:bg-slate-600 text-slate-800 dark:text-slate-100' :
                        idx === 2 ? 'bg-amber-700/80 text-amber-100' :
                        'bg-slate-200 dark:bg-slate-800 text-slate-500'
                      ]"
                    >
                      {{ idx + 1 }}
                    </div>

                    <div class="font-bold text-sm text-slate-900 dark:text-white truncate">
                      {{ getUserName(user.id) }}
                    </div>
                  </div>

                  <!-- Total Byte & Expand Icon -->
                  <div class="flex items-center gap-2 shrink-0">
                    <div class="text-sm font-black text-slate-900 dark:text-white">
                      {{ formatBytes(user.total) }}
                    </div>
                    <button
                      class="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
                      :aria-expanded="Boolean(expandedUsers[user.id])"
                      :title="expandedUsers[user.id] ? '收起节点用量' : '展开节点用量'"
                    >
                      <ChevronUp v-if="expandedUsers[user.id]" class="w-4 h-4" />
                      <ChevronDown v-else class="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <!-- Progress bar -->
                <div class="w-full h-1.5 rounded-full bg-slate-200/70 dark:bg-slate-700 overflow-hidden mb-2">
                  <div
                    class="h-full rounded-full bg-gradient-to-r from-blue-500 to-indigo-600 transition-all duration-300"
                    :style="{ width: `${activeTotalBytes > 0 ? (user.total / activeTotalBytes) * 100 : 0}%` }"
                  ></div>
                </div>

                <!-- Detail Splits -->
                <div class="flex items-center justify-between text-[11px] text-slate-400">
                  <span class="flex items-center gap-1">
                    <ArrowUpRight class="w-3 h-3 text-blue-500" />
                    上行: {{ formatBytes(user.uplink) }}
                  </span>
                  <span class="flex items-center gap-1">
                    <ArrowDownLeft class="w-3 h-3 text-emerald-500" />
                    下行: {{ formatBytes(user.downlink) }}
                  </span>
                  <span class="flex items-center gap-2">
                    <span>占比: {{ activeTotalBytes > 0 ? ((user.total / activeTotalBytes) * 100).toFixed(1) : 0 }}%</span>
                    <span class="text-[10px] text-blue-500 dark:text-blue-400 font-medium">
                      {{ expandedUsers[user.id] ? '收起节点用量 ▲' : '查看节点用量 ▼' }}
                    </span>
                  </span>
                </div>

                <!-- Active Nodes Badges Summary (when not expanded) -->
                <div
                  v-if="!expandedUsers[user.id] && getUserPeriodVpsList(user.id, selectedSubPeriod).length > 0"
                  class="flex flex-wrap items-center gap-1.5 mt-2 pt-2 border-t border-slate-200/60 dark:border-slate-700/60 text-[10px]"
                >
                  <span class="text-slate-400 flex items-center gap-0.5">
                    <Server class="w-2.5 h-2.5 text-blue-500" />
                    <span>{{ selectedSubPeriod === 'all' ? '常用节点:' : '节点:' }}</span>
                  </span>
                  <span
                    v-for="v in getUserPeriodVpsList(user.id, selectedSubPeriod)"
                    :key="v.vpsId"
                    class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-white dark:bg-slate-900 border border-slate-200/70 dark:border-slate-700/70 text-slate-600 dark:text-slate-300"
                  >
                    <span class="font-medium">{{ v.name }}:</span>
                    <span class="font-bold text-slate-800 dark:text-slate-100">{{ formatBytes(v.total) }}</span>
                    <span class="text-slate-400">({{ v.percent }}%)</span>
                  </span>
                </div>
              </div>

              <!-- Inline node usage follows the date selected in the trend chart. -->
              <div
                v-if="expandedUsers[user.id]"
                class="px-4 py-3 bg-white/70 dark:bg-slate-900/60 border-t border-slate-100 dark:border-slate-800 text-xs space-y-2.5"
              >
                <div class="flex items-center justify-between gap-2 text-[11px] text-slate-400">
                  <span class="flex items-center gap-1 text-slate-600 dark:text-slate-300 font-bold">
                    <Server class="w-3.5 h-3.5 text-blue-500" />
                    <span>{{ activePeriodLabel }} · 各节点用量</span>
                  </span>
                  <span>共 {{ getUserPeriodVpsList(user.id, selectedSubPeriod, true).length }} 个有记录节点</span>
                </div>
                <div class="overflow-x-auto">
                  <table class="w-full text-left whitespace-nowrap">
                    <thead class="text-[11px] text-slate-400 border-b border-slate-100 dark:border-slate-800">
                      <tr>
                        <th scope="col" class="py-2 pr-3 font-medium">节点</th>
                        <th scope="col" class="py-2 px-2 text-right font-medium">上行</th>
                        <th scope="col" class="py-2 px-2 text-right font-medium">下行</th>
                        <th scope="col" class="py-2 px-2 text-right font-medium">合计</th>
                        <th scope="col" class="py-2 pl-2 text-right font-medium">占比</th>
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
                      <tr v-for="v in getUserPeriodVpsList(user.id, selectedSubPeriod, true)" :key="v.vpsId">
                        <th scope="row" class="py-2.5 pr-3 font-semibold text-slate-800 dark:text-slate-200">
                          <div>{{ v.name }}</div>
                          <div v-if="v.address" class="text-[10px] text-slate-400 font-normal font-mono">{{ v.address }}<template v-if="v.port">:{{ v.port }}</template></div>
                        </th>
                        <td class="py-2.5 px-2 text-right text-blue-600 dark:text-blue-400">{{ formatBytes(v.uplink) }}</td>
                        <td class="py-2.5 px-2 text-right text-emerald-600 dark:text-emerald-400">{{ formatBytes(v.downlink) }}</td>
                        <td class="py-2.5 px-2 text-right font-bold text-slate-900 dark:text-white">{{ formatBytes(v.total) }}</td>
                        <td class="py-2.5 pl-2 text-right text-slate-500 dark:text-slate-400">{{ v.percent }}%</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p class="text-[10px] text-slate-400">仅显示有该用户有效用量记录的节点；缺失记录不代表用量为零。切换日期请点击上方趋势图。</p>
              </div>
            </div>
          </div>
        </div>

        <!-- 2. Matrix (Day-by-Day Pivot Table) View -->
        <div v-else-if="viewMode === 'matrix'" class="overflow-x-auto -mx-2 sm:mx-0">
          <div v-if="matrixData.rows.length === 0" class="py-12 text-center text-xs text-slate-400">
            当期暂无流量记录
          </div>

          <table v-else class="w-full text-xs text-left border-collapse">
            <thead>
              <tr class="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                <th class="py-2.5 px-3 font-semibold sticky left-0 bg-white dark:bg-slate-900 z-10 min-w-28">
                  用户
                </th>
                <th
                  v-for="p in matrixData.periods"
                  :key="p.key"
                  @click="handleMatrixSort(p.key)"
                  class="py-2.5 px-2.5 font-semibold text-center whitespace-nowrap cursor-pointer hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                  :class="{ 'text-blue-600 dark:text-blue-400 font-bold': matrixSortKey === p.key }"
                >
                  <div class="inline-flex items-center gap-1">
                    <span>{{ p.label }}</span>
                    <span v-if="p.isToday" class="text-[9px] px-1 py-0.2 rounded font-bold bg-blue-100 dark:bg-blue-900/60 text-blue-600 dark:text-blue-300">今</span>
                    <ArrowUpDown v-if="matrixSortKey === p.key" class="w-3 h-3 text-blue-500" />
                  </div>
                </th>
                <th
                  @click="handleMatrixSort('total')"
                  class="py-2.5 px-3 font-semibold text-right whitespace-nowrap cursor-pointer hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                  :class="{ 'text-blue-600 dark:text-blue-400 font-bold': matrixSortKey === 'total' }"
                >
                  <div class="inline-flex items-center justify-end gap-1">
                    <span>周期总计</span>
                    <ArrowUpDown v-if="matrixSortKey === 'total'" class="w-3 h-3 text-blue-500" />
                  </div>
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100 dark:divide-slate-800/60">
              <tr
                v-for="row in matrixData.rows"
                :key="row.id"
                class="hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors"
              >
                <!-- User Name Column (Sticky left) -->
                <td class="py-2.5 px-3 font-medium text-slate-900 dark:text-slate-100 sticky left-0 bg-white dark:bg-slate-900 z-10 truncate max-w-36">
                  {{ row.name }}
                </td>

                <!-- Period Cells with Heatmap styling & Clickable Node Breakdown -->
                <td
                  v-for="cell in row.cells"
                  :key="cell.key"
                  @click="cell.total > 0 && openNodeDetail(row.id, cell.key, cell.label)"
                  class="py-2 px-2 text-center whitespace-nowrap rounded transition-all select-none"
                  :class="[
                    getCellHeatmapClass(cell.total, matrixData.maxCellBytes),
                    cell.total > 0 ? 'cursor-pointer hover:ring-2 hover:ring-blue-500/70 hover:shadow-xs' : ''
                  ]"
                  :title="getCellTooltip(row, cell)"
                >
                  <div class="flex flex-col items-center justify-center">
                    <span v-if="cell.total > 0">{{ formatBytes(cell.total) }}</span>
                    <span v-else class="text-slate-300 dark:text-slate-600">-</span>
                    <!-- Node breakdown count badge if multiple nodes -->
                    <span
                      v-if="cell.total > 0 && getUserPeriodVpsList(row.id, cell.key).length > 1"
                      class="text-[9px] text-slate-400 dark:text-slate-500 font-mono scale-90"
                    >
                      {{ getUserPeriodVpsList(row.id, cell.key).length }}节点
                    </span>
                  </div>
                </td>

                <!-- Row Total Column -->
                <td class="py-2.5 px-3 text-right font-bold text-slate-900 dark:text-white whitespace-nowrap">
                  {{ formatBytes(row.total) }}
                </td>
              </tr>
            </tbody>
            <!-- Table Footer: Column Totals -->
            <tfoot>
              <tr class="border-t-2 border-slate-200 dark:border-slate-800 font-semibold text-slate-800 dark:text-slate-200 bg-slate-50/60 dark:bg-slate-800/30">
                <td class="py-2.5 px-3 sticky left-0 bg-slate-50/90 dark:bg-slate-800/90 z-10">
                  全站合计
                </td>
                <td
                  v-for="col in matrixData.colSummaries"
                  :key="col.key"
                  class="py-2.5 px-2 text-center text-blue-600 dark:text-blue-400 whitespace-nowrap font-bold"
                >
                  {{ formatBytes(col.total) }}
                </td>
                <td class="py-2.5 px-3 text-right text-blue-600 dark:text-blue-400 whitespace-nowrap font-black">
                  {{ formatBytes(matrixData.grandTotal.total) }}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <!-- VPS Distribution (1 col on lg) -->
      <div class="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm">
        <div class="flex items-center justify-between mb-4">
          <div>
            <div class="flex items-center gap-2">
              <BarChart3 class="w-4 h-4 text-blue-600 dark:text-blue-400" />
              <h3 class="text-sm font-bold text-slate-900 dark:text-white">
                <span>节点流量贡献</span>
              </h3>
              <span class="text-[10px] px-1.5 py-0.5 rounded font-medium" :class="selectedSubPeriod === 'all' ? 'bg-slate-100 dark:bg-slate-800 text-slate-500' : 'bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-900/50'">
                {{ selectedSubPeriod === 'all' ? '累计' : formatPeriodLabel(selectedSubPeriod) }}
              </span>
            </div>
            <p class="text-xs text-slate-400 mt-0.5">
              {{ selectedSubPeriod === 'all' ? '当期各 VPS 产生总流量统计' : `${formatPeriodLabel(selectedSubPeriod)} 各 VPS 产生流量统计` }}
            </p>
          </div>
        </div>

        <div v-if="vpsBreakdown.length === 0" class="py-12 text-center text-xs text-slate-400">
          暂无节点
        </div>

        <div v-else class="space-y-3">
          <div
            v-for="v in vpsBreakdown"
            :key="v.id"
            class="p-3 rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30"
          >
            <div class="flex items-center justify-between text-xs mb-1.5">
              <span class="font-bold text-slate-800 dark:text-slate-200">{{ v.name }}</span>
              <span class="font-semibold text-slate-900 dark:text-white">{{ formatBytes(v.total) }}</span>
            </div>

            <div class="w-full h-1.5 rounded-full bg-slate-200/70 dark:bg-slate-700 overflow-hidden mb-1.5">
              <div
                class="h-full rounded-full bg-emerald-500 transition-all duration-300"
                :style="{ width: `${activeVpsTotalBytes > 0 ? (v.total / activeVpsTotalBytes) * 100 : 0}%` }"
              ></div>
            </div>

            <div class="flex items-center justify-between text-[10px] text-slate-400">
              <span>{{ v.address }}:{{ v.port }}</span>
              <span>↑ {{ formatBytes(v.up) }} / ↓ {{ formatBytes(v.down) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- User Daily Node Breakdown Modal -->
    <Modal
      v-model="showNodeModal"
      :title="selectedNodeDetail ? `${selectedNodeDetail.userName} · ${selectedNodeDetail.periodLabel} 节点用量明细` : '节点用量明细'"
      max-width="lg"
    >
      <div v-if="selectedNodeDetail" class="space-y-4">
        <!-- Summary Box -->
        <div class="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <div>
            <div class="text-[11px] text-slate-400 flex items-center gap-1.5">
              <Calendar class="w-3.5 h-3.5 text-blue-500" />
              <span>统计周期: {{ selectedNodeDetail.periodLabel }}</span>
              <span v-if="selectedNodeDetail.isToday" class="text-[10px] px-1 py-0.2 rounded font-bold bg-blue-100 dark:bg-blue-900/60 text-blue-600 dark:text-blue-300">今日</span>
            </div>
            <div class="text-xl font-black text-slate-900 dark:text-white mt-0.5">
              {{ formatBytes(selectedNodeDetail.total) }}
            </div>
          </div>
          <div class="text-right text-xs space-y-0.5 text-slate-500 dark:text-slate-400">
            <div>↑ 上行: <span class="font-semibold text-slate-700 dark:text-slate-200">{{ formatBytes(selectedNodeDetail.uplink) }}</span></div>
            <div>↓ 下行: <span class="font-semibold text-slate-700 dark:text-slate-200">{{ formatBytes(selectedNodeDetail.downlink) }}</span></div>
          </div>
        </div>

        <!-- Node List -->
        <div class="space-y-2.5">
          <div class="flex items-center justify-between text-xs font-bold text-slate-800 dark:text-slate-200">
            <span class="flex items-center gap-1.5">
              <Server class="w-3.5 h-3.5 text-blue-500" />
              <span>各节点消耗分布 (共 {{ selectedNodeDetail.vpsList.length }} 个节点)</span>
            </span>
          </div>

          <div v-if="selectedNodeDetail.vpsList.length === 0" class="py-6 text-center text-xs text-slate-400 border border-dashed rounded-xl">
            该用户在此周期无节点用量记录
          </div>

          <div v-else class="space-y-2 max-h-80 overflow-y-auto pr-0.5">
            <div
              v-for="v in selectedNodeDetail.vpsList"
              :key="v.vpsId"
              class="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs space-y-2 shadow-xs"
            >
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2 min-w-0">
                  <span class="w-2 h-2 rounded-full shrink-0" :class="v.status === 'ready' ? 'bg-emerald-500' : 'bg-slate-400'"></span>
                  <span class="font-bold text-slate-900 dark:text-white truncate">{{ v.name }}</span>
                  <span class="text-[10px] text-slate-400 font-mono hidden sm:inline">{{ v.address }}:{{ v.port }}</span>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  <span class="font-bold text-slate-900 dark:text-white">{{ formatBytes(v.total) }}</span>
                  <span class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-900/50">
                    {{ v.percent }}%
                  </span>
                </div>
              </div>

              <!-- Progress bar -->
              <div class="w-full h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                <div
                  class="h-full rounded-full bg-gradient-to-r from-blue-500 to-indigo-500 transition-all duration-300"
                  :style="{ width: `${v.percent}%` }"
                ></div>
              </div>

              <div class="flex items-center justify-between text-[11px] text-slate-400">
                <span>↑ 上行: {{ formatBytes(v.uplink) }}</span>
                <span>↓ 下行: {{ formatBytes(v.downlink) }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Footer Actions -->
        <div class="flex items-center justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
          <button
            @click="showNodeModal = false"
            class="px-3.5 py-1.5 rounded-xl text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            关闭
          </button>
        </div>
      </div>
    </Modal>
  </div>
</template>
