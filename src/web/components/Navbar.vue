<script setup lang="ts">
import { isDark, toggleTheme } from '../lib/theme'
import {
  ShieldCheck,
  RefreshCw,
  Sun,
  Moon,
  History,
  KeyRound,
  LogOut,
  UserCheck
} from '@lucide/vue'

defineProps<{
  currentTab: string
  tabs: { id: string; label: string; icon: any; count?: number }[]
  loading?: boolean
  currentMonth?: string
  lastSyncTime?: string
  isAdmin: boolean
}>()

const emit = defineEmits<{
  (e: 'select-tab', id: string): void
  (e: 'refresh'): void
  (e: 'open-history'): void
  (e: 'open-login'): void
  (e: 'logout'): void
}>()
</script>

<template>
  <header class="sticky top-0 z-40 w-full border-b border-slate-200/80 dark:border-slate-800/80 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex items-center justify-between h-16">
        <!-- Logo and Title -->
        <div class="flex items-center gap-3.5">
          <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-blue-600 via-indigo-600 to-violet-500 flex items-center justify-center shadow-md shadow-blue-500/20 text-white shrink-0">
            <ShieldCheck class="w-5 h-5 stroke-[2.2]" />
          </div>
          <div>
            <div class="flex items-center gap-2">
              <span class="text-base sm:text-lg font-bold tracking-tight text-slate-900 dark:text-white">
                Proxysetting
              </span>
              <span
                class="hidden sm:inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold"
                :class="isAdmin ? 'bg-indigo-50 dark:bg-indigo-950/70 text-indigo-700 dark:text-indigo-300 border border-indigo-200/70 dark:border-indigo-800/60' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200/70 dark:border-slate-700'"
              >
                {{ isAdmin ? '管理员模式' : '访客控制台' }}
              </span>
            </div>
            <div class="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1.5 font-medium">
              <span>{{ currentMonth ? '北京时间自然月 ' + currentMonth : '系统运行中' }}</span>
              <span v-if="lastSyncTime" class="hidden md:inline text-slate-400 dark:text-slate-500">• {{ lastSyncTime }}</span>
            </div>
          </div>
        </div>

        <!-- Navigation Tabs (Desktop) -->
        <nav class="hidden lg:flex items-center gap-1 bg-slate-100/80 dark:bg-slate-800/80 p-1 rounded-xl border border-slate-200/60 dark:border-slate-700/60">
          <button
            v-for="t in tabs"
            :key="t.id"
            @click="emit('select-tab', t.id)"
            class="flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all duration-150 relative cursor-pointer"
            :class="[
              currentTab === t.id
                ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-white/40 dark:hover:bg-slate-700/40'
            ]"
          >
            <component :is="t.icon" class="w-4 h-4 shrink-0" />
            <span>{{ t.label }}</span>
            <span
              v-if="typeof t.count === 'number'"
              class="ml-0.5 px-1.5 py-0.2 rounded-full text-[10px] font-bold"
              :class="currentTab === t.id ? 'bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300' : 'bg-slate-200/70 dark:bg-slate-700 text-slate-600 dark:text-slate-400'"
            >
              {{ t.count }}
            </span>
          </button>
        </nav>

        <!-- Right Action Buttons -->
        <div class="flex items-center gap-2 sm:gap-2.5">
          <!-- History Button (Admin only) -->
          <button
            v-if="isAdmin"
            @click="emit('open-history')"
            title="查看历史月用量快照"
            class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white bg-slate-100 dark:bg-slate-800 hover:bg-slate-200/80 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 transition-colors cursor-pointer"
          >
            <History class="w-3.5 h-3.5" />
            <span class="hidden sm:inline">历史快照</span>
          </button>

          <!-- Refresh Button -->
          <button
            @click="emit('refresh')"
            :disabled="loading"
            title="刷新数据"
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 active:scale-95 shadow-sm shadow-blue-500/20 disabled:opacity-50 transition-all cursor-pointer"
          >
            <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': loading }" />
            <span class="hidden sm:inline">刷新</span>
          </button>

          <!-- Admin Login / Logout Controls -->
          <button
            v-if="!isAdmin"
            @click="emit('open-login')"
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 transition-all cursor-pointer"
          >
            <KeyRound class="w-3.5 h-3.5 text-blue-500" />
            <span>管理员登录</span>
          </button>

          <div v-else class="flex items-center gap-1.5">
            <button
              @click="emit('logout')"
              title="退出管理员登录模式"
              class="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 hover:bg-rose-100 dark:hover:bg-rose-900/50 border border-rose-200/80 dark:border-rose-900/60 transition-colors cursor-pointer"
            >
              <LogOut class="w-3.5 h-3.5" />
              <span class="hidden sm:inline">退出</span>
            </button>
          </div>

          <!-- Theme Toggle -->
          <button
            @click="toggleTheme"
            :title="isDark ? '切换浅色模式' : '切换深色模式'"
            class="p-2 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 border border-transparent hover:border-slate-200 dark:hover:border-slate-700 transition-colors cursor-pointer"
          >
            <Sun v-if="isDark" class="w-4 h-4 text-amber-400" />
            <Moon v-else class="w-4 h-4 text-slate-600" />
          </button>
        </div>
      </div>

      <!-- Mobile Navigation Tabs -->
      <div class="lg:hidden flex items-center gap-1 overflow-x-auto py-2.5 -mx-4 px-4 border-t border-slate-100 dark:border-slate-800/60 no-scrollbar">
        <button
          v-for="t in tabs"
          :key="t.id"
          @click="emit('select-tab', t.id)"
          class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap shrink-0 transition-colors cursor-pointer"
          :class="[
            currentTab === t.id
              ? 'bg-blue-600 text-white shadow-sm'
              : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
          ]"
        >
          <component :is="t.icon" class="w-3.5 h-3.5 shrink-0" />
          <span>{{ t.label }}</span>
          <span
            v-if="typeof t.count === 'number'"
            class="px-1.5 py-0.2 rounded-full text-[10px]"
            :class="currentTab === t.id ? 'bg-white/20 text-white' : 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300'"
          >
            {{ t.count }}
          </span>
        </button>
      </div>
    </div>
  </header>
</template>
