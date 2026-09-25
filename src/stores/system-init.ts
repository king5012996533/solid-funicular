import { computed, ref } from 'vue'
import { ApiResponseError } from '@/api/response'
import { getSystemInitStatus, initializeSystem, type SystemInitPayload, type SystemInitStatus } from '@/api/system-init'
import {
  createDefaultSystemInitStatus,
  resolveSystemInitPhase,
  type SystemInitPhase,
} from '@/shared/system-init-state'

const systemInitStatus = ref<SystemInitStatus>(createDefaultSystemInitStatus())
const systemInitLoading = ref(false)
// 三态：unknown 表示「没问到」（含请求失败），绝不能被当成「未初始化」。
const systemInitPhase = ref<SystemInitPhase>('unknown')
const systemInitError = ref('')
let loadSystemInitPromise: Promise<SystemInitStatus> | null = null

// 失败只落到 unknown + 错误文案，绝不据此判成「未初始化」。
const applySystemInitFailure = (message: string) => {
  systemInitPhase.value = 'unknown'
  systemInitError.value = message
  return systemInitStatus.value
}

const readLoadErrorMessage = (error: unknown) => {
  // 接口返回的错误（如 5xx）走 ApiResponseError；网络层失败（连接被拒/超时）没有可读文案，给中文兜底。
  if (error instanceof ApiResponseError && error.message) {
    return error.message
  }

  return '无法连接服务'
}

const applySystemInitStatus = (status?: SystemInitStatus | null) => {
  const phase = resolveSystemInitPhase(status)
  if (phase === 'unknown') {
    // 200 但应答里没有布尔型 isInitialized —— 同样按「没问到」处理。
    return applySystemInitFailure('服务返回的初始化状态异常')
  }

  systemInitStatus.value = status as SystemInitStatus
  systemInitPhase.value = phase
  systemInitError.value = ''
  return systemInitStatus.value
}

// 首次安装初始化状态单例。
export const useSystemInitStore = () => {
  const hasDefiniteStatus = computed(() => systemInitPhase.value !== 'unknown')

  const loadStatus = async (force = false) => {
    if (loadSystemInitPromise && !force) {
      return loadSystemInitPromise
    }

    systemInitLoading.value = true
    loadSystemInitPromise = getSystemInitStatus()
      .then(result => applySystemInitStatus(result))
      .catch(error => applySystemInitFailure(readLoadErrorMessage(error)))
      .finally(() => {
        systemInitLoading.value = false
        loadSystemInitPromise = null
      })

    return loadSystemInitPromise
  }

  const runInitialize = async (payload: SystemInitPayload) => {
    const result = await initializeSystem(payload)
    applySystemInitStatus({
      isInitialized: result.isInitialized,
      initializedAt: new Date().toISOString(),
      adminUserId: result.user.id,
      adminUsername: payload.username,
      siteName: payload.siteName,
    })
    return result
  }

  return {
    systemInitStatus,
    systemInitLoading,
    // 语义：是否已经拿到「明确」的初始化状态（initialized / uninitialized）。
    // 请求失败时保持 false，守卫因此会在下一次跳转时重新询问，不会永久卡死。
    systemInitInitialized: hasDefiniteStatus,
    systemInitPhase,
    systemInitError,
    loadStatus,
    runInitialize,
    applySystemInitStatus,
  }
}
