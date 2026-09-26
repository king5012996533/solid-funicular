/**
 * 下游一次生成的「素材清单」收敛
 *
 * 背景：上游素材进下游一次生成，曾经有四条通道各行其是 ——
 *   ① 连线自动注入（`externalReferenceImages`）
 *   ② 提示词里的 `@` 显式引用
 *   ③ AutoLink 开关（会往提示词尾部补 token，等于又发明了一套注入）
 *   ④ 手动上传的参考图 / 首尾帧
 * 其中 ① 与 ③ 实际是同一件事的两套代码：同一张上游图可能从三条路进来，
 * 用户看不出谁在起作用，也不知道关掉哪个才有效。
 *
 * 这里把「本次实际会提交哪些素材、按什么顺序、每一项从哪来」算成**单一结果**：
 *   - 顺序：显式 → 手动 → 自动（每组都保持各自原有的先后），用户的显式意图优先；
 *   - 去重：同一 url 只进一次，保留更强的来源（显式 > 手动 > 自动）；
 *   - AutoLink 只是「自动那部分默认填不填」的开关，不再另起一套机制。
 *
 * 纯函数、无外部依赖；规则由 tests/reference-collection.test.ts 逐条钉住。
 */

/** 一条素材的来源。三种取值就是三条真实通道，不再有第四种 */
export type ReferenceSource = 'explicit' | 'manual' | 'auto-from-edge'

/** 视频画面角色：由上游连线（首帧/尾帧/参考图）或手动上传的槽位决定，**不按数组位置猜** */
export type ReferenceFrameRole = 'first-frame' | 'last-frame' | 'reference'

/** 候选素材：调用方把各通道的原始信息归一成这个形状 */
export interface ReferenceCandidate {
  url: string
  /** 该素材在提示词里的 token（显式 / 连线上游资产有），界面用它显示 `@图片1` */
  token?: string
  /** 可跳回的上游节点 id —— 素材库等没有来源节点的资产为空 */
  sourceNodeId?: string
  /** 媒体种类（image / video），仅用于界面展示 */
  kind?: string
  /** 视频画面角色；缺省视为普通参考图 */
  role?: ReferenceFrameRole
}

export interface ReferenceCollectionInput {
  /** `@` 解析出的媒体 url（按出现顺序） */
  explicit: ReferenceCandidate[]
  /** 用户手动上传的参考图（图片 / Agent 模式） */
  manual?: ReferenceCandidate[]
  /** 手动上传的首帧（视频模式）：角色由「用户点了哪个槽位」决定 */
  manualFirstFrame?: string
  /** 手动上传的尾帧（视频模式） */
  manualLastFrame?: string
  /** 连线自动注入的素材（图片节点 = 上游参考图；视频节点 = 已按角色排好的输入画面） */
  edge: ReferenceCandidate[]
  /** AutoLink 开关：关掉时自动那部分一个都不进；显式与手动不受影响 */
  autoLinkEnabled: boolean
  /** 清单上限；<= 0 表示不限 */
  limit?: number
}

export interface ReferenceCollectionItem {
  url: string
  source: ReferenceSource
  token?: string
  sourceNodeId?: string
  kind?: string
  role: ReferenceFrameRole
}

export interface ReferenceCollection {
  /** 提交顺序：显式 → 手动 → 自动；同一 url 只出现一次 */
  items: ReferenceCollectionItem[]
  /** 视频用：同一批素材按画面角色重排（首帧 → 尾帧 → 参考图），组内保持 items 的顺序 */
  frameItems: ReferenceCollectionItem[]
}

/** 角色排序权重：首帧 → 尾帧 → 其余参考图 */
const FRAME_ROLE_RANK: Record<ReferenceFrameRole, number> = {
  'first-frame': 0,
  'last-frame': 1,
  reference: 2,
}

/** 去掉空 url / 归一化字段，避免同一张图因为带空格被当成两条 */
const normalizeCandidates = (raw: ReferenceCandidate[]): ReferenceCandidate[] => {
  const out: ReferenceCandidate[] = []
  for (const item of raw) {
    const url = String(item?.url ?? '').trim()
    if (!url) continue
    out.push({ ...item, url })
  }
  return out
}

/**
 * 计算本次提交的素材清单。
 *
 * 来源优先级靠「按强度从强到弱依次登记归属、再按同一顺序产出」实现：
 * 先出现的来源赢，且赢家决定该项在清单里的位置 —— 所以「同一张图既在手动又在自动」
 * 时它只以「手动」出现一次，不会既排在前面又排在后面。
 */
export const buildReferenceCollection = (input: ReferenceCollectionInput): ReferenceCollection => {
  const firstFrame = String(input.manualFirstFrame ?? '').trim()
  const lastFrame = String(input.manualLastFrame ?? '').trim()
  const manualFrames: ReferenceCandidate[] = []
  if (firstFrame) manualFrames.push({ url: firstFrame, role: 'first-frame' })
  if (lastFrame) manualFrames.push({ url: lastFrame, role: 'last-frame' })

  const groups: Array<{ source: ReferenceSource; candidates: ReferenceCandidate[] }> = [
    { source: 'explicit', candidates: normalizeCandidates(input.explicit) },
    { source: 'manual', candidates: [...manualFrames, ...normalizeCandidates(input.manual ?? [])] },
    // 开关关掉 = 自动那部分整体不存在，而不是换一套逻辑继续注入
    { source: 'auto-from-edge', candidates: input.autoLinkEnabled ? normalizeCandidates(input.edge) : [] },
  ]

  const owner = new Map<string, ReferenceSource>()
  for (const { source, candidates } of groups) {
    for (const candidate of candidates) {
      if (!owner.has(candidate.url)) owner.set(candidate.url, source)
    }
  }

  const items: ReferenceCollectionItem[] = []
  const seen = new Set<string>()
  for (const { source, candidates } of groups) {
    for (const candidate of candidates) {
      if (owner.get(candidate.url) !== source || seen.has(candidate.url)) continue
      seen.add(candidate.url)
      items.push({
        url: candidate.url,
        source,
        token: candidate.token,
        sourceNodeId: candidate.sourceNodeId,
        kind: candidate.kind,
        role: candidate.role ?? 'reference',
      })
    }
  }

  const limit = Number(input.limit ?? 0)
  const limited = limit > 0 ? items.slice(0, limit) : items
  // sort 在现代 V8 是稳定的：同角色的项保持 items 里的先后
  const frameItems = [...limited].sort((a, b) => FRAME_ROLE_RANK[a.role] - FRAME_ROLE_RANK[b.role])
  return { items: limited, frameItems }
}
