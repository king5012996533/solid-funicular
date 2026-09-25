/**
 * 系统初始化状态的三态判定（纯函数，便于单测）
 *
 * 为什么必须分三态：接口请求失败和「服务端明确说未初始化」是**完全不同的两件事**。
 * 早先两者都被折成 `isInitialized: false`，于是 API 重启的几秒钟里，
 * 任何一次状态请求失败都会把已初始化的系统判成「未安装」，把用户扔进安装向导。
 * 因此这里只承认**明确拿到布尔值**的应答，其余一律是 unknown（没问到）。
 */

export type SystemInitPhase = 'unknown' | 'initialized' | 'uninitialized'

export interface SystemInitStatusSnapshot {
  isInitialized: boolean
  initializedAt: string
  adminUserId: string
  adminUsername: string
  siteName: string
}

export const createDefaultSystemInitStatus = (): SystemInitStatusSnapshot => ({
  isInitialized: false,
  initializedAt: '',
  adminUserId: '',
  adminUsername: '',
  siteName: '',
})

/**
 * 由接口应答推导三态。
 * 只有应答里存在布尔型的 `isInitialized` 才算「问到了」，缺字段/空应答都算 unknown。
 */
export const resolveSystemInitPhase = (status?: { isInitialized?: unknown } | null): SystemInitPhase => {
  if (!status || typeof status !== 'object' || typeof status.isInitialized !== 'boolean') {
    return 'unknown'
  }

  return status.isInitialized ? 'initialized' : 'uninitialized'
}

export interface SystemInitRedirectTarget {
  path: string
  query?: Record<string, string>
}

/**
 * 路由守卫的跳转决策（唯一入口，避免守卫里再散落 isInitialized 判断）。
 *  - 明确未初始化 → 去 /install（带上回跳地址）
 *  - 明确已初始化 → 不该停在 /install
 *  - unknown（含请求失败）→ 一律放行，绝不跳 /install
 */
export const resolveSystemInitRedirect = (
  phase: SystemInitPhase,
  targetPath: string,
  targetFullPath = '',
): SystemInitRedirectTarget | null => {
  if (phase === 'uninitialized' && targetPath !== '/install') {
    const redirect = String(targetFullPath || '').trim()
    return {
      path: '/install',
      query: redirect && redirect !== '/install' ? { redirect } : undefined,
    }
  }

  if (phase === 'initialized' && targetPath === '/install') {
    return { path: '/' }
  }

  return null
}
