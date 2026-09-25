/**
 * 首次进入画布页该打开哪张画布 —— 纯决策，有单测。
 *
 * 为什么单独拎出来：这条决策是「用户下次回来还能接着上次画」的入口，
 * 一旦写错（比如无 id 时默认进空白画布），每一次打开都会走到自动保存，
 * 而自动保存对「没有 workflowId 的脏画布」就是 createWorkflowDefinition ——
 * 实测用户名下因此堆了 15 张「未命名工作流」草稿。决策本身不该埋在 onMounted 里，
 * 它得能被断言：有画布 → 载入；一张都没有 → 才新建空白。
 */
export type InitialCanvasEntryDecision =
  | { action: 'load'; workflowId: string }
  | { action: 'seed-blank' }

export const decideInitialCanvasEntry = (input: {
  /** URL 上显式带的画布 id（分享链接 / 直接打开某张画布） */
  routeWorkflowId?: string
  /** 该用户最近更新的一张画布 id；取不到（或没有画布）就是空串 */
  recentCanvasId?: string
}): InitialCanvasEntryDecision => {
  const routeWorkflowId = String(input.routeWorkflowId || '').trim()
  if (routeWorkflowId) {
    return { action: 'load', workflowId: routeWorkflowId }
  }

  const recentCanvasId = String(input.recentCanvasId || '').trim()
  if (recentCanvasId) {
    return { action: 'load', workflowId: recentCanvasId }
  }

  // 到这里才算「一张画布都没有」：只有此时才该播种空白画布
  return { action: 'seed-blank' }
}
