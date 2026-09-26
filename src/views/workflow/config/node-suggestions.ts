/**
 * 节点类型的展示信息 + 「谁可以接在谁后面」的规则
 *
 * 为什么把这两件事放一起：
 *   拖线落空弹出的候选节点菜单，和连线时的边类型推断，
 *   必须用同一套规则。否则会出现「菜单里选了某个节点，连出来的边却没有意义」——
 *   比如从视频节点往右拖，菜单里却给了个「图片生成」，连上之后谁也不知道
 *   这张图该拿视频里的哪一帧。
 *
 * 所以这里只写一张「有意义的上下游组合」表，菜单和连线推断都从它推导。
 */

import { getCanvasIcon } from '../../../components/icons/canvas-icons'
import type { WorkflowNodeType } from '../composables/useWorkflowCanvas'

export interface NodeTypePresentation {
  type: WorkflowNodeType
  name: string
  /**
   * 图标描边颜色。值是**完整的 CSS 颜色表达式**（这里直接是 var() 引用 token）。
   *
   * 注意：必须绑到 style 上，不能绑到 SVG 表现属性上 ——
   * 表现属性（`stroke="var(--x)"`）不解析 var()，写上去会直接失效变成不描边。
   * 所以消费方要写 `:style="{ stroke: opt.color }"`，不要写 `:stroke="opt.color"`。
   */
  color: string
  /** SVG path 的 d 属性。保持字符串，不要把图标换成组件 —— 图标模块要能独立演进 */
  icon: string
}

/**
 * 四类节点的展示信息。
 * 左侧工具栏、「+」菜单、拖线菜单都读这一份，避免同一个节点在三处有三套名字和图标。
 * 图标来自画布图标模块（24×24 的 path `d`，按 stroke 1.5 设计），
 * 保持字符串是为了让调用方继续用 `<path :d="opt.icon" />` 渲染。
 *
 * 颜色一律走 token，不再写死色值：
 *   text  → brand-main（品牌主色）
 *   image → brand-image
 *   video → brand-video
 *   llm   → brand-llm（画布内专用，见 libtv-tokens.css；不用 brand-bright 是因为
 *           那个 token 会被运行时主题接管，会导致节点颜色跟着后台品牌色漂移）
 */
export const NODE_TYPE_PRESENTATION: NodeTypePresentation[] = [
  {
    type: 'text',
    name: '文本节点',
    color: 'var(--brand-main-default)',
    icon: getCanvasIcon('text'),
  },
  {
    type: 'image',
    name: '图片生成',
    color: 'var(--brand-image)',
    icon: getCanvasIcon('image'),
  },
  {
    type: 'video',
    name: '视频生成',
    color: 'var(--brand-video)',
    icon: getCanvasIcon('video'),
  },
  {
    type: 'asset',
    name: '素材',
    color: 'var(--text-secondary)',
    icon: getCanvasIcon('folder'),
  },
]

const PRESENTATION_BY_TYPE = new Map(NODE_TYPE_PRESENTATION.map(item => [item.type, item]))

export const getNodeTypePresentation = (type: WorkflowNodeType): NodeTypePresentation | null =>
  PRESENTATION_BY_TYPE.get(type) || null

/**
 * 有意义的「上游 → 下游」组合。
 *
 * 判据是**下游节点真的会读这个输入**，不是「技术上能不能连」。
 * 表里的每一项都能在代码里找到对应读取逻辑（composables/upstream-inputs.ts）：
 *   text      产出 content      → 图片 / 视频（当提示词）、文本（当输入）（当创意）
 *   文本节点产出 content → 图片 / 视频（当提示词）
 *   image     产出图片           → 图片（当参考图）、视频（当首帧）
 *   video     产出成片           → 没有任何节点读视频，所以目前接不下去
 *
 * 故意不包含的两种组合，理由是「连了也没人读，等于静默空操作」：
 *   · 任何节点 → text   文本节点的内容由用户输入或导入文件决定，不读上游
 *   · 任何节点 → video  已经由 image 覆盖（视频唯一能读的素材就是图片）
 */
const COHERENT_DOWNSTREAM: Record<WorkflowNodeType, WorkflowNodeType[]> = {
  text: ['image', 'video'],
  image: ['image', 'video'],
  // 素材给下游当参考图 / 首帧，和图片节点的下游一致
  asset: ['image', 'video'],
  video: [],
  // 编组框不产内容、也不消费内容 —— 它只是把其它节点框在一起，不参加连线
  group: [],
}

export type ConnectDirection = 'downstream' | 'upstream'

/**
 * 这两类节点能不能连。
 *
 * 复用上面那张表 —— 判断标准只有一条：**下游真的有代码读上游的产出吗**。
 * 为什么需要它：把连线的落点从「手柄」放宽到「整张卡片」之后（对齐 SceneFlow 的手感），
 * 用户可以把任意两张卡片连起来；如果不在这里拦一道，就会造出一堆没人消费的边 ——
 * `imageRole`（首帧/尾帧）就是这么变成假交互的。
 */
export const isCoherentConnection = (
  sourceType: WorkflowNodeType,
  targetType: WorkflowNodeType,
): boolean => (COHERENT_DOWNSTREAM[sourceType] || []).includes(targetType)

/**
 * 不能连时给一句人话。
 *
 * 为什么要文案而不是静默：静默是这一批假交互的共同病根 ——
 * 用户拖了半天松手，什么都没发生，只会以为功能坏了。
 */
export const describeCoherentRefusal = (
  sourceType: WorkflowNodeType,
  targetType: WorkflowNodeType,
): string => {
  if (sourceType === targetType && sourceType === 'video') {
    return '视频节点的成片目前没有任何节点会读取，连过去不会生效'
  }
  if (sourceType === 'video') return '视频节点产出的成片目前没有任何节点会读取，连过去不会生效'
  if (targetType === 'text') return '文本节点的内容由你自己输入或导入文件决定，它不读上游'
  return '这两类节点之间没有可用的数据流向'
}

/**
 * 在 A→B 这条边上插入中间节点 N 时，**哪些类型能插**。
 *
 * 判据是「插完两条边都仍然有人消费」：
 *   插入前 A→B 有意义；插入后变成 A→N→B，就必须同时满足
 *   `A→N` 与 `N→B` 都合规（`isCoherentConnection`）。
 * 只满足一条的组合不能给入口 —— 否则会造出一条没人读的边，
 * 正是我们要削掉的那类假交互（见文件头「菜单和连线必须用同一套规则」）。
 *
 * 只从 NODE_TYPE_PRESENTATION 里挑（不含 group）：编组框不参加连线。
 * 输出顺序与菜单里的节点顺序一致，方便形成肌肉记忆。
 */
export const resolveInsertableNodeTypes = (
  sourceType: WorkflowNodeType,
  targetType: WorkflowNodeType,
): WorkflowNodeType[] => NODE_TYPE_PRESENTATION
  .map(item => item.type)
  .filter(candidate => isCoherentConnection(sourceType, candidate)
    && isCoherentConnection(candidate, targetType))

/** 一条边上没有任何可插入类型时给一句人话（而不是给一个点了没反应的入口） */
export const describeInsertionRefusal = (
  sourceType: WorkflowNodeType,
  targetType: WorkflowNodeType,
): string => {
  const filterable = resolveInsertableNodeTypes(sourceType, targetType)
  if (filterable.length) return ''
  return `${getNodeTypePresentation(sourceType)?.name || sourceType} → ${getNodeTypePresentation(targetType)?.name || targetType} 之间没有可插入的节点`
}

/**
 * 从某类节点拖线落空时，候选的新节点类型。
 *
 * @param originType 拖线的起点节点类型
 * @param direction  downstream = 从右侧（source）拖出，新节点在下游
 *                   upstream   = 从左侧（target）拖出，新节点在上游
 */
export const suggestNodeTypes = (
  originType: WorkflowNodeType,
  direction: ConnectDirection,
): WorkflowNodeType[] => {
  const matched = direction === 'downstream'
    ? COHERENT_DOWNSTREAM[originType] || []
    // 反查：新节点会变成上游，所以要找「它的下游列表里包含起点类型」的那些
    : NODE_TYPE_PRESENTATION
      .map(item => item.type)
      .filter(candidate => (COHERENT_DOWNSTREAM[candidate] || []).includes(originType))

  // 统一按展示顺序输出，菜单里四类节点的相对位置永远一致，方便形成肌肉记忆
  const order = new Map(NODE_TYPE_PRESENTATION.map((item, index) => [item.type, index]))
  return [...matched].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
}
