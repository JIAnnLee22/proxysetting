<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  Title,
  CategoryScale,
  Tooltip,
  Filler,
  Legend
} from 'chart.js'
import { formatBytes } from '../lib/analytics'
import { isDark } from '../lib/theme'

// Register only needed Chart.js components
Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Title,
  Tooltip,
  Filler,
  Legend
)

const props = defineProps<{
  labels: string[]
  uplinkData: number[]
  downlinkData: number[]
  selectedIndex?: number | null
}>()

const emit = defineEmits<{
  (e: 'select-index', index: number): void
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
let chartInstance: Chart | null = null

function getThemeColors() {
  const dark = isDark.value
  return {
    gridColor: dark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.06)',
    textColor: dark ? '#94a3b8' : '#64748b',
    upLine: '#3b82f6',
    upFill: dark ? 'rgba(59, 130, 246, 0.15)' : 'rgba(59, 130, 246, 0.12)',
    downLine: '#10b981',
    downFill: dark ? 'rgba(16, 185, 129, 0.15)' : 'rgba(16, 185, 129, 0.12)'
  }
}

function initOrUpdateChart() {
  if (!canvasRef.value) return

  const colors = getThemeColors()

  if (chartInstance) {
    chartInstance.data.labels = props.labels
    chartInstance.data.datasets[0].data = props.uplinkData
    chartInstance.data.datasets[1].data = props.downlinkData
    
    // Update colors
    chartInstance.options.scales!.x!.grid!.color = colors.gridColor
    chartInstance.options.scales!.x!.ticks!.color = colors.textColor
    chartInstance.options.scales!.y!.grid!.color = colors.gridColor
    chartInstance.options.scales!.y!.ticks!.color = colors.textColor
    chartInstance.update()
    return
  }

  chartInstance = new Chart(canvasRef.value, {
    type: 'line',
    data: {
      labels: props.labels,
      datasets: [
        {
          label: '上行流量 (Uplink)',
          data: props.uplinkData,
          borderColor: colors.upLine,
          backgroundColor: colors.upFill,
          fill: true,
          tension: 0.35,
          pointRadius: (ctx: any) => {
            return props.selectedIndex !== null && props.selectedIndex !== undefined && ctx.dataIndex === props.selectedIndex ? 6 : 3
          },
          pointHoverRadius: 7,
          pointBorderWidth: (ctx: any) => {
            return props.selectedIndex !== null && props.selectedIndex !== undefined && ctx.dataIndex === props.selectedIndex ? 3 : 1
          },
          borderWidth: 2
        },
        {
          label: '下行流量 (Downlink)',
          data: props.downlinkData,
          borderColor: colors.downLine,
          backgroundColor: colors.downFill,
          fill: true,
          tension: 0.35,
          pointRadius: (ctx: any) => {
            return props.selectedIndex !== null && props.selectedIndex !== undefined && ctx.dataIndex === props.selectedIndex ? 6 : 3
          },
          pointHoverRadius: 7,
          pointBorderWidth: (ctx: any) => {
            return props.selectedIndex !== null && props.selectedIndex !== undefined && ctx.dataIndex === props.selectedIndex ? 3 : 1
          },
          borderWidth: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      onClick: (_event, elements) => {
        if (elements && elements.length > 0) {
          const index = elements[0].index
          emit('select-index', index)
        }
      },
      onHover: (event, chartElement) => {
        if (event.native?.target) {
          (event.native.target as HTMLElement).style.cursor = chartElement.length ? 'pointer' : 'default'
        }
      },
      plugins: {
        legend: {
          position: 'top',
          align: 'end',
          labels: {
            boxWidth: 12,
            boxHeight: 12,
            usePointStyle: true,
            pointStyle: 'circle',
            color: colors.textColor,
            font: { size: 12, family: 'inherit' }
          }
        },
        tooltip: {
          backgroundColor: isDark.value ? '#0f172a' : '#ffffff',
          titleColor: isDark.value ? '#f8fafc' : '#0f172a',
          bodyColor: isDark.value ? '#cbd5e1' : '#334155',
          borderColor: isDark.value ? '#334155' : '#e2e8f0',
          borderWidth: 1,
          padding: 12,
          boxPadding: 6,
          usePointStyle: true,
          callbacks: {
            label(item) {
              const val = Number(item.raw) || 0
              return ` ${item.dataset.label?.split(' ')[0]}: ${formatBytes(val)}`
            }
          }
        }
      },
      scales: {
        x: {
          grid: {
            color: colors.gridColor
          },
          ticks: {
            color: colors.textColor,
            font: { size: 11 }
          }
        },
        y: {
          beginAtZero: true,
          grid: {
            color: colors.gridColor
          },
          ticks: {
            color: colors.textColor,
            font: { size: 11 },
            callback(value) {
              return formatBytes(Number(value))
            }
          }
        }
      }
    }
  })
}

watch(
  () => [props.labels, props.uplinkData, props.downlinkData, props.selectedIndex],
  () => {
    initOrUpdateChart()
  },
  { deep: true }
)

watch(
  () => isDark.value,
  () => {
    if (chartInstance) {
      chartInstance.destroy()
      chartInstance = null
    }
    initOrUpdateChart()
  }
)

onMounted(() => {
  initOrUpdateChart()
})

onUnmounted(() => {
  if (chartInstance) {
    chartInstance.destroy()
    chartInstance = null
  }
})
</script>

<template>
  <div class="relative w-full h-64 sm:h-72">
    <canvas ref="canvasRef"></canvas>
  </div>
</template>
