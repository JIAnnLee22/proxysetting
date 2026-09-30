<script setup lang="ts">
import { ref, computed } from 'vue'
import { formatBytes, aggregate, type PeriodData } from '../lib/analytics'
import TrafficChart from './TrafficChart.vue'
import {
  Activity,
  ArrowUpRight,
  ArrowDownLeft,
  Server,
  Users,
  Award,
  Calendar,
  Layers,
  TrendingUp,
  BarChart3
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

// Sort column for users: 'total' | 'uplink' | 'downlink'
const sortBy = ref<'total' | 'uplink' | 'downlink'>('total')

// Aggregated totals
const aggr = computed(() => {
  return aggregate(props.currentData)
})

const totalBytes = computed(() => aggr.value.totalUp + aggr.value.totalDown)

// Sorted users list
const sortedUsers = computed(() => {
  const list = Array.from(aggr.value.users.entries()).map(([id, stats]) => ({
    id,
    uplink: stats.uplink,
    downlink: stats.downlink,
    total: stats.uplink + stats.downlink
  }))

  return list.sort((a, b) => {
    if (sortBy.value === 'uplink') return b.uplink - a.uplink || b.total - a.total
    if (sortBy.value === 'downlink') return b.downlink - a.downlink || b.total - a.total
    return b.total - a.total || a.id.localeCompare(b.id)
  })
})

// Prepare chart data
const chartData = computed(() => {
  if (props.currentData.length === 0) {
    return { labels: ['暂无数据'], up: [0], down: [0] }
  }

  // Group by period/date
  const map = new Map<string, { up: number; down: number }>()
  for (const row of props.currentData) {
    const key = row.daily ? row.daily.date : row.period
    const current = map.get(key) || { up: 0, down: 0 }
    const list = row.daily ? row.daily.users : row.users
    for (const u of list) {
      current.up += u.uplink
      current.down += u.downlink
    }
    map.set(key, current)
  }

  const sortedKeys = Array.from(map.keys()).sort()
  const labels: string[] = []
  const up: number[] = []
  const down: number[] = []

  for (const k of sortedKeys) {
    labels.push(k.length > 7 ? k.slice(5) : k) // '09-30' or '2026-09'
    const val = map.get(k)!
    up.push(val.up)
    down.push(val.down)
  }

  return { labels, up, down }
})

// VPS breakdown in current data
const vpsBreakdown = computed(() => {
  const map = new Map<string, { up: number; down: number }>()
  for (const row of props.currentData) {
    const vId = row.vps_id
    const current = map.get(vId) || { up: 0, down: 0 }
    const list = row.daily ? row.daily.users : row.users
    for (const u of list) {
      current.up += u.uplink
      current.down += u.downlink
    }
    map.set(vId, current)
  }

  return (props.state?.vps || []).map((v: any) => {
    const usage = map.get(v.id) || { up: 0, down: 0 }
    return {
      id: v.id,
      name: v.name,
      address: v.address,
      port: v.port,
      status: v.status,
      up: usage.up,
      down: usage.down,
      total: usage.up + usage.down
    }
  }).sort((a: any, b: any) => b.total - a.total)
})

function getUserName(id: string) {
  const match = props.state?.identities?.find((i: any) => i.id === id)
  return match ? match.name : id
}
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
            { id: 'daily', label: '今日 (Daily)' },
            { id: 'monthly', label: '本月 (Monthly)' },
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

    <!-- 4 KPI Cards -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <!-- Total Traffic -->
      <div class="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm hover:shadow-md transition-shadow relative overflow-hidden">
        <div class="flex items-center justify-between mb-3">
          <span class="text-xs font-semibold text-slate-500 dark:text-slate-400">
            {{ timeDimension === 'daily' ? '今日' : timeDimension === 'monthly' ? '本月' : '本年' }}总量
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
      <div class="flex items-center justify-between mb-4">
        <div>
          <h3 class="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <TrendingUp class="w-4 h-4 text-blue-600 dark:text-blue-400" />
            <span>流量走势曲线</span>
          </h3>
          <p class="text-xs text-slate-400 mt-0.5">按时间周期划分的上下行带宽消耗趋势</p>
        </div>
      </div>

      <TrafficChart
        :labels="chartData.labels"
        :uplink-data="chartData.up"
        :downlink-data="chartData.down"
      />
    </div>

    <!-- Bottom Layout: User Rankings & VPS Breakdown -->
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <!-- User Rankings (2 cols on lg) -->
      <div class="lg:col-span-2 p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm">
        <div class="flex items-center justify-between mb-4">
          <div>
            <h3 class="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Award class="w-4 h-4 text-amber-500" />
              <span>用户用量排行榜</span>
            </h3>
            <p class="text-xs text-slate-400 mt-0.5">按实际产生流量的消耗排名</p>
          </div>

          <!-- Sort buttons -->
          <div class="flex items-center gap-1 text-xs">
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

        <div v-if="sortedUsers.length === 0" class="py-12 text-center text-xs text-slate-400">
          当期暂无流量记录
        </div>

        <div v-else class="space-y-3">
          <div
            v-for="(user, idx) in sortedUsers"
            :key="user.id"
            class="p-3.5 rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors"
          >
            <div class="flex items-center justify-between gap-3 mb-2">
              <div class="flex items-center gap-3">
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

                <div class="font-bold text-sm text-slate-900 dark:text-white">
                  {{ getUserName(user.id) }}
                </div>
              </div>

              <!-- Total Byte Number -->
              <div class="text-sm font-black text-slate-900 dark:text-white">
                {{ formatBytes(user.total) }}
              </div>
            </div>

            <!-- Progress bar -->
            <div class="w-full h-1.5 rounded-full bg-slate-200/70 dark:bg-slate-700 overflow-hidden mb-2">
              <div
                class="h-full rounded-full bg-gradient-to-r from-blue-500 to-indigo-600"
                :style="{ width: `${totalBytes > 0 ? (user.total / totalBytes) * 100 : 0}%` }"
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
              <span>
                占比: {{ totalBytes > 0 ? ((user.total / totalBytes) * 100).toFixed(1) : 0 }}%
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- VPS Distribution (1 col on lg) -->
      <div class="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 shadow-sm">
        <div class="flex items-center justify-between mb-4">
          <div>
            <h3 class="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <BarChart3 class="w-4 h-4 text-blue-600 dark:text-blue-400" />
              <span>节点流量贡献</span>
            </h3>
            <p class="text-xs text-slate-400 mt-0.5">当期各 VPS 产生总流量统计</p>
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
                class="h-full rounded-full bg-emerald-500"
                :style="{ width: `${totalBytes > 0 ? (v.total / totalBytes) * 100 : 0}%` }"
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
  </div>
</template>
