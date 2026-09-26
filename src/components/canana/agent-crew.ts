/**
 * AI CREW 占位（纯逻辑，2026-09-26，导演控制台批次 4）
 *
 * 产品方向：以后会有编剧 / 导演 / 摄影 / 美术 / 剪辑几路 Agent，右侧现在先留位置。
 *
 * 两条硬约束（这是这块的全部意义，改前先读）：
 *   ① **只有 Director 是活的**：我们当前的画布 Agent 就是它（唯一 integrated 的角色）；
 *      其余角色一律显示「待接入」—— **不假装它们在干活、不给它们编状态**。
 *   ② **角色与状态是数据驱动的列表**：不只是五行写死的 DOM，将来接入新角色时把
 *      `integrated` 翻开即可，渲染层不用改结构。
 *
 * 整块由界面标注为「AI CREW · 预览」—— 明说这是占位，不是真实的在跑的多 Agent 编排。
 */

export type CanvasAgentCrewRoleKey = 'producer' | 'writer' | 'director' | 'art' | 'editor'

export interface CanvasAgentCrewRoleDefinition {
  key: CanvasAgentCrewRoleKey
  /** 展示图标 */
  icon: string
  /** 英文角色名（产品原话用的是英文名） */
  name: string
  /** 是否已经接入：当前只有 Director（画布 Agent）为 true，其余是占位 */
  integrated: boolean
}

/**
 * 角色清单（展示顺序即列表顺序）。
 *
 * `integrated` 只有 Director 为 true —— 这是「谁真的在干活」的唯一真源；将来某路 Agent 接进来，
 * 只改这里一处，界面（状态词、样式）自动跟着走。
 */
export const CANVAS_AGENT_CREW_ROLES: ReadonlyArray<CanvasAgentCrewRoleDefinition> = [
  { key: 'producer', icon: '🧑‍💼', name: 'Producer', integrated: false },
  { key: 'writer', icon: '✍️', name: 'Writer', integrated: false },
  { key: 'director', icon: '🎬', name: 'Director', integrated: true },
  { key: 'art', icon: '🎨', name: 'Art', integrated: false },
  { key: 'editor', icon: '✂️', name: 'Editor', integrated: false },
]

export type CanvasAgentCrewStatus = 'active' | 'pending'

export interface CanvasAgentCrewMember extends CanvasAgentCrewRoleDefinition {
  /** active = 已接入（当前只有 Director）；pending = 待接入占位 */
  status: CanvasAgentCrewStatus
  /** 展示状态词 */
  label: string
}

/**
 * 组装 CREW 展示列表。
 *
 * `directorRunning`：Director 这一轮是不是真的在跑 —— 已接入角色据此在「执行中 / 待命」之间切换，
 * 不假装它一直在干活。未接入角色**永远是「待接入」**，不根据任何运行时状态编词。
 */
export const buildCanvasAgentCrew = (directorRunning: boolean): CanvasAgentCrewMember[] =>
  CANVAS_AGENT_CREW_ROLES.map((role) => {
    if (!role.integrated) {
      return { ...role, status: 'pending', label: '待接入' }
    }
    return { ...role, status: 'active', label: directorRunning ? '执行中' : '待命' }
  })
