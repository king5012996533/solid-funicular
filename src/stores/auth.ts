import { computed, ref } from 'vue'
import type { AuthMethodType, AuthUserProfile, PublicAuthMethod } from '@/api/auth'
import { getAuthSession, listEnabledAuthMethods, loginByVerificationCode, logoutAuthSession } from '@/api/auth'

// 登录成功后通知页面刷新接口数据。
export const AUTH_LOGIN_SUCCESS_EVENT = 'auth:login-success'

// 广播登录成功事件，供各页面按需重拉接口。
const dispatchAuthLoginSuccess = () => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(AUTH_LOGIN_SUCCESS_EVENT))
}

// 当前登录用户。
const currentUser = ref<AuthUserProfile | null>(null)

// 当前启用的登录方式列表。
const enabledMethods = ref<PublicAuthMethod[]>([])

// 是否正在拉取登录态。
const sessionLoading = ref(false)

// 登录态是否已完成至少一次初始化。
const sessionInitialized = ref(false)

// 是否正在拉取登录方式。
const methodsLoading = ref(false)

// 首次登录态加载任务。
let loadSessionPromise: Promise<AuthUserProfile | null> | null = null

// 首次登录方式加载任务。
let loadMethodsPromise: Promise<PublicAuthMethod[]> | null = null

// 统一应用当前登录用户。
const applySessionUser = (user: AuthUserProfile | null) => {
  currentUser.value = user
  return currentUser.value
}

// 统一应用当前可用登录方式。
const applyEnabledMethods = (methods: PublicAuthMethod[]) => {
  enabledMethods.value = Array.isArray(methods) ? methods : []
  return enabledMethods.value
}

// 认证状态单例。
export const useAuthStore = () => {
  // 当前是否已登录。
  const isLoggedIn = computed(() => Boolean(currentUser.value?.id))

  /**
   * 后端连不上（不是未登录）。界面据此显示「连接中」而不是登录页。
   * 见 loadSession 里的注释：这两种情况以前被混成了一种。
   */
  const sessionUnreachable = ref(false)

  // 当前是否具备后台管理员权限。
  const isAdmin = computed(() => currentUser.value?.role === 'ADMIN')

  // 当前用户按钮文案。
  const loginButtonText = computed(() => {
    return currentUser.value?.maskedPhone || currentUser.value?.maskedEmail || '登录'
  })

  /**
   * 「后端连不上」与「确实未登录」是两件事，不能混为一谈。
   *
   * 踩过的坑（真机上表现为「重启电脑后打开页面又要我登录」）：
   * 原来是 `getAuthSession().catch(() => applySessionUser(null))` —— **任何**失败都当未登录，
   * 而后端刚重启时 getAuthSession 会因为连不上而抛错（不是 401），于是界面直接判定未登录并弹登录框，
   * 且 `sessionInitialized` 被置真、不会自动重试。用户看到的就是「明明登过，又要我登」。
   */
  const isNetworkFailure = (error: unknown): boolean => {
    if (error instanceof TypeError) return true
    const message = String((error as { message?: unknown })?.message || error || '')
    return /failed to fetch|networkerror|network error|fetch failed|load failed/i.test(message)
  }

  // 拉取当前会话。
  const loadSession = async (force = false) => {
    if (loadSessionPromise && !force) {
      return loadSessionPromise
    }

    sessionLoading.value = true

    loadSessionPromise = (async () => {
      // 后端可能正在启动（dev 下要跑迁移 + 生成 client，约半分钟）：退避重试几次再下结论
      const MAX_ATTEMPTS = 4
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          const result = await getAuthSession()
          const user = applySessionUser(result?.user || null)
          sessionUnreachable.value = false
          sessionInitialized.value = true
          return user
        } catch (error) {
          const lastAttempt = attempt >= MAX_ATTEMPTS
          if (isNetworkFailure(error) && !lastAttempt) {
            await new Promise((resolve) => setTimeout(resolve, 800 * attempt))
            continue
          }
          if (isNetworkFailure(error)) {
            /*
             * 重试完还是连不上：**保持「未初始化」**并记下连不上，
             * 绝不把「问不到」当成「没登录」—— 否则后端一慢就变成一次误报的登录弹窗。
             */
            sessionUnreachable.value = true
            return null
          }
          // 拿到明确答复（401 等）才是真的未登录 / 会话失效
          const user = applySessionUser(null)
          sessionUnreachable.value = false
          sessionInitialized.value = true
          return user
        }
      }
      return null
    })().finally(() => {
      sessionLoading.value = false
      loadSessionPromise = null
    })

    return loadSessionPromise
  }

  // 拉取当前启用的登录方式。
  const loadMethods = async (force = false) => {
    if (loadMethodsPromise && !force) {
      return loadMethodsPromise
    }

    methodsLoading.value = true

    loadMethodsPromise = listEnabledAuthMethods()
      .then((result) => applyEnabledMethods(result || []))
      .catch(() => applyEnabledMethods([]))
      .finally(() => {
        methodsLoading.value = false
        loadMethodsPromise = null
      })

    return loadMethodsPromise
  }

  // 使用验证码方式登录。
  const login = async (payload: {
    methodType: AuthMethodType
    target: string
    code?: string
    password?: string
  }) => {
    const result = await loginByVerificationCode(payload)
    sessionInitialized.value = true
    const user = applySessionUser(result?.user || null)
    if (user?.id) {
      dispatchAuthLoginSuccess()
    }
    return user
  }

  // 退出登录。
  const logout = async () => {
    await logoutAuthSession().catch(() => null)
    sessionInitialized.value = true
    applySessionUser(null)
  }

  return {
    currentUser,
    enabledMethods,
    isLoggedIn,
    sessionUnreachable,
    isAdmin,
    loginButtonText,
    sessionLoading,
    sessionInitialized,
    methodsLoading,
    loadSession,
    loadMethods,
    login,
    logout,
  }
}
