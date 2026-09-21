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
    type: 'llmConfig',
    name: 'LLM 文本生成',
    color: 'var(--brand-llm)',
    icon: getCanvasIcon('llm'),
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
 *   text      产出 content      → 图片 / 视频（当提示词）、LLM（当输入）
 *   llmConfig 产出 outputContent → 图片 / 视频（当提示词）、LLM（链式）
 *   image     产出图片           → 图片（当参考图）、视频（当首帧）
 *   video     产出成片           → 没有任何节点读视频，所以目前接不下去
 *
 * 故意不包含的两种组合，理由是「连了也没人读，等于静默空操作」：
 *   · 任何节点 → text   文本节点的内容由用户输入或导入文件决定，不读上游
 *   · 任何节点 → video  已经由 image 覆盖（视频唯一能读的素材就是图片）
 */
const COHERENT_DOWNSTREAM: Record<WorkflowNodeType, WorkflowNodeType[]> = {
  text: ['image', 'video', 'llmConfig'],
  llmConfig: ['image', 'video', 'llmConfig'],
  image: ['image', 'video'],
  video: [],
}

export type ConnectDirection = 'downstream' | 'upstream'

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
