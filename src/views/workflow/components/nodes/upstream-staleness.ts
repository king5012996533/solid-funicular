/**
 * 「上游已变 / 需重跑」标记的纯逻辑（2026-09-26，两端项目都没有的能力）
 *
 * 要解决的问题：下游节点用上游某张图生成之后，上游又被重跑、换了一张图。
 * 下游卡片上还挂着旧结果，但没有任何痕迹告诉用户「它已经不是用现在这张图生成的了」。
 *
 * 做法刻意保持最小：**指纹就是上游产出的 `url`**，不引入 hash、不新增依赖。
 *   · 提交时：把本次用到的每个上游产出（节点 id → url）记进自己的 `data.upstreamFingerprint`；
 *   · 渲染时：拿指纹和当前画布上上游的 url 比一遍，变了就在卡片上出角标。
 * url 变了就是「产出换了」——因为我们的产物一入库就是一个新的 /uploads 地址，不会原地覆盖。
 *
 * 三个边界（都是刻意定的）：
 *   1. **只认有 url 的产出**。文本节点没有 url，不参与指纹（文本变化是另一回事，
 *      用 url 指纹抓不到，这里不假装能抓到）。
 *   2. 画布上新连进来、指纹里没有的上游**不算「已变」** —— 本次生成本来就没用它。
 *   3. **上游被删（指纹里有、画布里没了）静默清掉，不出角标**。理由：删除是用户主动做的动作，
 *      且此时没有任何「重跑」能把它变回正常，挂一个只有重跑才消的角标只会变成噪音。
 *      `removed` 仍然从比较结果里返回，需要时可另行展示。
 *
 * 节点 data 上的 `upstreamFingerprint` 字段声明放在 ./node-data-fields.ts（模块声明合并，
 * 本轮不修改 useWorkflowCanvas.ts —— 那个文件有并行改动）。
 */

/** 上游产出的指纹：上游节点 id → 该产出的 url */
export type UpstreamFingerprint = Record<string, string>

/** 一个上游节点当前暴露出来的产出 */
export interface UpstreamOutput {
  id: string
  /** 产出地址；空串 / undefined 表示它现在还没有产出 */
  url?: string | null
}

export interface UpstreamStaleDiff {
  /** 指纹里有、现在 url 变了的上游 id（需要重跑的那一类） */
  updated: string[]
  /** 指纹里有、但现在画布上已经取不到产出的上游 id（被删 / 产出被清空） */
  removed: string[]
}

export type UpstreamStaleKind = 'updated' | 'removed'

export interface UpstreamStaleBadge {
  kind: UpstreamStaleKind
  text: string
  count: number
}

/** 角标文案（产品要求原话） */
export const UPSTREAM_UPDATED_BADGE_TEXT = '上游已更新，建议重跑'

const normalizeUrl = (value: unknown): string => String(value ?? '').trim()

/** 把一个 url 列表收敛成指纹：丢掉空 url、按 id 去重（后者覆盖前者） */
export const captureUpstreamFingerprint = (
  outputs: readonly UpstreamOutput[],
): UpstreamFingerprint => {
  const fingerprint: UpstreamFingerprint = {}
  for (const output of outputs) {
    const id = String(output?.id ?? '').trim()
    const url = normalizeUrl(output?.url)
    if (!id || !url) continue
    fingerprint[id] = url
  }
  return fingerprint
}

/**
 * 读节点 data 上的指纹。持久化数据可能是脏的（不是对象、值是数字、空串），
 * 这里统一收敛成干净对象 —— 脏数据不该让卡片凭空出现角标。
 */
export const readUpstreamFingerprint = (raw: unknown): UpstreamFingerprint => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const fingerprint: UpstreamFingerprint = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const url = normalizeUrl(value)
    if (!id || !url) continue
    fingerprint[id] = url
  }
  return fingerprint
}

/**
 * 指纹 vs 当前上游：谁变了、谁没了。
 * 返回 null 之外的语义都只是「列表」，角标要怎么显示交给 resolveUpstreamStaleBadge。
 */
export const compareUpstreamFingerprint = (
  fingerprint: UpstreamFingerprint,
  current: readonly UpstreamOutput[],
): UpstreamStaleDiff => {
  const currentUrls = new Map<string, string>()
  for (const output of current) {
    const id = String(output?.id ?? '').trim()
    const url = normalizeUrl(output?.url)
    if (!id || !url) continue
    currentUrls.set(id, url)
  }

  const updated: string[] = []
  const removed: string[] = []
  for (const [id, url] of Object.entries(fingerprint)) {
    const currentUrl = currentUrls.get(id)
    if (currentUrl === undefined) removed.push(id)
    else if (currentUrl !== url) updated.push(id)
  }
  return { updated, removed }
}

/**
 * 角标判定：只有「上游已更新」才出角标（上游被删静默清掉，理由见文件头）。
 * 指纹为空（从没跑过 / 老数据没有这个字段）时同样不出角标。
 */
export const resolveUpstreamStaleBadge = (
  diff: UpstreamStaleDiff,
): UpstreamStaleBadge | null => {
  if (diff.updated.length === 0) return null
  return {
    kind: 'updated',
    text: UPSTREAM_UPDATED_BADGE_TEXT,
    count: diff.updated.length,
  }
}
