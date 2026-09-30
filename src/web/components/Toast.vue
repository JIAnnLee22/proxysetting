<script setup lang="ts">
import { toasts, removeToast } from '../lib/toast'
import { CheckCircle2, AlertCircle, Info, AlertTriangle, X } from '@lucide/vue'
</script>

<template>
  <div class="fixed top-5 right-5 z-50 flex flex-col gap-2.5 max-w-sm w-full pointer-events-none px-4 sm:px-0">
    <transition-group
      enter-active-class="transform ease-out duration-300 transition"
      enter-from-class="translate-y-2 opacity-0 sm:translate-y-0 sm:translate-x-4 scale-95"
      enter-to-class="translate-y-0 opacity-100 sm:translate-x-0 scale-100"
      leave-active-class="transition ease-in duration-200"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-95"
    >
      <div
        v-for="t in toasts"
        :key="t.id"
        class="pointer-events-auto flex items-start gap-3 p-3.5 rounded-xl border shadow-lg backdrop-blur-md transition-all"
        :class="[
          t.type === 'success' ? 'bg-emerald-50/95 dark:bg-emerald-950/80 border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-100' :
          t.type === 'error' ? 'bg-rose-50/95 dark:bg-rose-950/80 border-rose-200 dark:border-rose-800 text-rose-900 dark:text-rose-100' :
          t.type === 'warning' ? 'bg-amber-50/95 dark:bg-amber-950/80 border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-100' :
          'bg-slate-50/95 dark:bg-slate-900/80 border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100'
        ]"
      >
        <CheckCircle2 v-if="t.type === 'success'" class="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
        <AlertCircle v-else-if="t.type === 'error'" class="w-5 h-5 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
        <AlertTriangle v-else-if="t.type === 'warning'" class="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
        <Info v-else class="w-5 h-5 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />

        <div class="flex-1 text-sm font-medium leading-snug break-words">
          {{ t.message }}
        </div>

        <button
          @click="removeToast(t.id)"
          class="shrink-0 p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
        >
          <X class="w-4 h-4" />
        </button>
      </div>
    </transition-group>
  </div>
</template>
