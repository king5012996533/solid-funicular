<script setup lang="ts">
/**
 * 系统初始化状态「没问到」时的可重试错误态（App 级兜底）
 *
 * 背景：状态接口失败一度被折成 isInitialized=false，导致 API 抖动的几秒里
 * 已初始化的用户被路由守卫送进 /install 安装向导。现在请求失败保持 unknown、
 * 守卫不跳转，改由这个遮罩兜住：
 *   - 明确告诉用户「无法连接服务」，而不是假装系统没装
 *   - 自动重试（10s）+ 手动重试按钮，拿到明确状态后遮罩自动消失
 *   - 若恢复后发现服务端确实是未初始化，则补跳 /install
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { WarningFilled } from '@element-plus/icons-vue'
import WfButton from './WfButton.vue'
import { useSystemInitStore } from '@/stores/system-init'

const AUTO_RETRY_INTERVAL_MS = 10000

const router = useRouter()
const { systemInitPhase, systemInitError, loadStatus } = useSystemInitStore()

const visible = computed(() => systemInitPhase.value === 'unknown' && Boolean(systemInitError.value))
const retrying = ref(false)
let retryTimer: number | null = null

const retry = async () => {
  if (retrying.value) {
    return
  }

  retrying.value = true
  try {
    await loadStatus(true)
  } finally {
    retrying.value = false
  }

  // 恢复后服务端若其实是「未初始化」，这里补一次跳转（守卫此时已有明确状态，不会再重复请求）。
  if (systemInitPhase.value === 'uninitialized') {
    void router.replace('/install')
  }
}

const stopAutoRetry = () => {
  if (retryTimer !== null) {
    window.clearInterval(retryTimer)
    retryTimer = null
  }
}

watch(visible, (isVisible) => {
  stopAutoRetry()
  if (isVisible) {
    retryTimer = window.setInterval(() => {
      void retry()
    }, AUTO_RETRY_INTERVAL_MS)
  }
}, { immediate: true })

onBeforeUnmount(stopAutoRetry)
</script>

<template>
  <Transition name="sys-init-fade">
    <div
      v-if="visible"
      class="sys-init-unavailable"
      role="alert"
      aria-live="assertive"
      @click.stop
      @wheel.stop
      @touchmove.stop
      @keydown.stop
    >
      <div class="sys-init-unavailable-card">
        <div class="sys-init-unavailable-icon">
          <el-icon><WarningFilled /></el-icon>
        </div>
        <h2 class="sys-init-unavailable-title">无法连接服务</h2>
        <p class="sys-init-unavailable-desc">
          没能获取到系统初始化状态，可能是服务正在重启或网络不稳定。
          正在自动重试，也可以点击下方按钮立即重试。
        </p>
        <p v-if="systemInitError" class="sys-init-unavailable-detail">{{ systemInitError }}</p>
        <WfButton variant="primary" :loading="retrying" @click="retry">
          重试
        </WfButton>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.sys-init-unavailable {
  position: fixed;
  inset: 0;
  /*
   * 与 GlobalLoadingOverlay 同档：高于项目内常规弹窗，低于 ElConfigProvider 的 30000，
   * 保证 element-plus 的 ElMessage 不被遮罩盖住。
   */
  z-index: 29000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 15, 18, 0.72);
  backdrop-filter: blur(4px);
  pointer-events: all;
}

.sys-init-unavailable-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  width: 360px;
  max-width: calc(100vw - 48px);
  padding: 28px 28px 24px;
  border-radius: 12px;
  text-align: center;
  background: var(--canvas-float-block-default, rgba(32, 33, 39, 0.96));
  backdrop-filter: blur(20px);
  border: 0.5px solid var(--stroke-tertiary, rgba(255, 255, 255, 0.12));
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
  color: var(--text-primary, #e0f5ff);
}

.sys-init-unavailable-icon {
  display: inline-flex;
  font-size: 28px;
  color: #f59e0b;
}

.sys-init-unavailable-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.sys-init-unavailable-desc {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary, rgba(224, 245, 255, 0.72));
}

.sys-init-unavailable-detail {
  margin: 0;
  font-size: 12px;
  word-break: break-all;
  color: var(--text-tertiary, rgba(224, 245, 255, 0.5));
}

.sys-init-fade-enter-active,
.sys-init-fade-leave-active {
  transition: opacity 0.18s ease;
}

.sys-init-fade-enter-from,
.sys-init-fade-leave-to {
  opacity: 0;
}
</style>
