<script setup lang="ts">
import Modal from './Modal.vue'
import { AlertTriangle } from '@lucide/vue'

defineProps<{
  modelValue: boolean
  title?: string
  message: string
  confirmText?: string
  cancelText?: string
  isDestructive?: boolean
  loading?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'confirm'): void
  (e: 'cancel'): void
}>()

function onCancel() {
  emit('update:modelValue', false)
  emit('cancel')
}

function onConfirm() {
  emit('confirm')
}
</script>

<template>
  <Modal
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    :title="title || '确认操作'"
    max-width="md"
  >
    <div class="flex items-start gap-4">
      <div
        class="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
        :class="isDestructive ? 'bg-rose-100 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400' : 'bg-amber-100 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400'"
      >
        <AlertTriangle class="w-5 h-5" />
      </div>
      <div class="flex-1">
        <p class="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
          {{ message }}
        </p>
      </div>
    </div>

    <template #footer>
      <button
        type="button"
        @click="onCancel"
        :disabled="loading"
        class="px-4 py-2 text-sm font-medium rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition-colors"
      >
        {{ cancelText || '取消' }}
      </button>
      <button
        type="button"
        @click="onConfirm"
        :disabled="loading"
        class="px-4 py-2 text-sm font-medium rounded-xl text-white shadow-sm transition-all"
        :class="isDestructive ? 'bg-rose-600 hover:bg-rose-700 active:scale-95 disabled:opacity-50' : 'bg-blue-600 hover:bg-blue-700 active:scale-95 disabled:opacity-50'"
      >
        <span v-if="loading">处理中...</span>
        <span v-else>{{ confirmText || '确认' }}</span>
      </button>
    </template>
  </Modal>
</template>
