<script setup lang="ts">
import { ref } from 'vue'
import { api } from '../lib/api'
import { showToast } from '../lib/toast'
import Modal from './Modal.vue'
import { History, Search, Code, Server } from '@lucide/vue'

const props = defineProps<{
  modelValue: boolean
  defaultPeriod?: string
}>()

defineEmits<{
  (e: 'update:modelValue', val: boolean): void
}>()

const queryPeriod = ref(props.defaultPeriod || new Date().toISOString().slice(0, 7))
const loading = ref(false)
const historyResults = ref<any[] | null>(null)
const viewRawJson = ref(false)

async function queryHistory() {
  const p = queryPeriod.value.trim()
  if (!p) {
    showToast('请输入查询周期', 'warning')
    return
  }
  loading.value = true
  try {
    const res = await api(`usage?period=${encodeURIComponent(p)}`)
    historyResults.value = res
  } catch (e: any) {
    showToast(e.message || '查询历史快照失败', 'error')
    historyResults.value = null
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <Modal
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    title="历史用量快照与归档查询"
    max-width="3xl"
  >
    <div class="space-y-4">
      <div class="flex items-center gap-3">
        <div class="relative flex-1">
          <input
            v-model="queryPeriod"
            type="text"
            placeholder="例如: 2026-09 或 2026-09-30"
            class="w-full px-3.5 py-2 text-sm font-mono rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
            @keyup.enter="queryHistory"
          />
        </div>

        <button
          @click="queryHistory"
          :disabled="loading"
          class="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 active:scale-95 disabled:opacity-50 transition-all cursor-pointer shrink-0"
        >
          <Search class="w-4 h-4" />
          <span>{{ loading ? '查询中...' : '检索' }}</span>
        </button>

        <button
          v-if="historyResults && historyResults.length > 0"
          @click="viewRawJson = !viewRawJson"
          class="p-2 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 transition-colors cursor-pointer"
          :title="viewRawJson ? '查看表格模式' : '查看原始 JSON'"
        >
          <Code class="w-4 h-4" />
        </button>
      </div>

      <!-- Results view -->
      <div v-if="historyResults">
        <div v-if="historyResults.length === 0" class="p-8 text-center text-xs text-slate-400 border border-dashed rounded-xl">
          该周期 ({{ queryPeriod }}) 暂无已归档的历史快照记录。
        </div>

        <div v-else>
          <!-- Raw JSON mode -->
          <pre
            v-if="viewRawJson"
            class="p-4 rounded-xl font-mono text-xs text-slate-200 bg-slate-950 border border-slate-800 max-h-96 overflow-auto leading-relaxed select-all"
          >{{ JSON.stringify(historyResults, null, 2) }}</pre>

          <!-- Structured Cards Mode -->
          <div v-else class="space-y-3 max-h-96 overflow-y-auto pr-1">
            <div
              v-for="r in historyResults"
              :key="r.vps_id"
              class="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 text-xs space-y-2"
            >
              <div class="flex items-center justify-between font-bold text-slate-800 dark:text-slate-200">
                <span class="flex items-center gap-1.5 font-mono">
                  <Server class="w-3.5 h-3.5 text-blue-500" />
                  VPS: {{ r.vps_id }}
                </span>
                <span class="text-slate-400 font-normal">记录时间: {{ r.updated_at }}</span>
              </div>

              <div class="p-2.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 text-[11px] space-y-1">
                <div v-for="u in r.payload?.users || []" :key="u.id" class="flex justify-between text-slate-600 dark:text-slate-400">
                  <span class="font-mono text-slate-800 dark:text-slate-200">{{ u.id }}</span>
                  <span>↑ {{ (u.uplink / 1073741824).toFixed(3) }} GiB / ↓ {{ (u.downlink / 1073741824).toFixed(3) }} GiB</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Modal>
</template>
