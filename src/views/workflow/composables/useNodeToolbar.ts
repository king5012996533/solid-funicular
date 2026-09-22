/**
 * 节点悬浮工具栏的定位规则（对齐 LibTV 实测 + 一处修正）
 *
 * **LibTV 实测（2026-09-22）**：
 *   · 工具栏浮在卡片**上方居中**，距卡片顶边 **29px**；
 *   · 按钮高 **32px**，整条工具栏**不随画布缩放** —— 40% 与 75% 两档缩放下，
 *     每个按钮的像素宽高完全一致（人像质感调节 178×32、全景 62×32、多角度 75×32…）；
 *   · **只在节点有产出时出现**：空图片节点被选中时不显示工具栏（那时卡片里给的是「尝试」列表）。
 *
 * **一处修正**：LibTV 是死板地按卡片中心对齐，节点贴左/右边时整条会被裁出屏幕
 * （实测：节点中心在 x=183，工具栏第一项却跑到 x=-355）。这里在屏幕空间做水平收敛，
 * 让它贴边时整体留在画布可视区域内 —— 抄行为，不抄缺陷。
 *
 * 反缩放的做法与输入框同一套（见 useComposerPanel）：viewport 是 `scale(z)`，
 * 浮层再 `scale(1/z)` 抵消，屏幕尺寸就恒定。差别是锚点在**卡片上方**，
 * 所以 `transform-origin` 取 `bottom center`、间距要写成 `29/zoom`（否则间距会跟着缩放）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { canvasViewport, nodes } from './useWorkflowCanvas'

/** 工具栏与卡片顶边的间距（屏幕像素，LibTV 实测 29） */
const TOOLBAR_GAP = 29
/** 贴边收敛时留的边距 */
const EDGE_PADDING = 12
/** 首次渲染还没量到宽度时的估值，只影响一帧 */
const WIDTH_FALLBACK = 420

export interface CanvasSpan {
  left: number
  right: number
  width: number
}

/**
 * 贴边收敛：算出工具栏中心相对「卡片中心」需要在屏幕上平移多少像素。
 *
 * 抽成纯函数是为了能测 —— 这段是整条工具栏定位里唯一容易算错的部分，
 * 而它在浏览器里只表现为「看着有点偏」，不会报错。验证过的那组真实数字
 * 已经写进 tests/node-toolbar.test.ts。
 */
export const resolveToolbarShift = (params: {
  /** 卡片中心在屏幕上的横坐标 */
  cardCenterScreenX: number
  /** 工具栏的屏幕宽度 */
  toolbarWidth: number
  /** 画布可视区的横向边界；拿不到时不收敛 */
  canvas: CanvasSpan | null
}): number => {
  const { cardCenterScreenX, toolbarWidth, canvas } = params
  if (!canvas || canvas.width <= toolbarWidth + EDGE_PADDING * 2) return 0
  const minCenter = canvas.left + EDGE_PADDING + toolbarWidth / 2
  const maxCenter = canvas.right - EDGE_PADDING - toolbarWidth / 2
  const clamped = Math.max(minCenter, Math.min(maxCenter, cardCenterScreenX))
  return clamped - cardCenterScreenX
}

export const useNodeToolbar = (options: {
  nodeId: () => string
  /** 卡片的布局宽度（用来算卡片中心的屏幕位置） */
  cardWidth: () => number
  /** 组件持有的锚点元素 ref（由调用方声明，模板 ref 只用在模板里会被 noUnusedLocals 判为未使用） */
  el: Ref<HTMLElement | null>
}) => {
  const toolbarWidth = ref(0)
  /**
   * 画布可视区的横向边界。
   *
   * 必须做成可观察的状态：收敛是在**屏幕空间**算的，而画布尺寸会随窗口变化。
   * 早先直接在 computed 里 `querySelector` 量一次，窗口变窄后样式还是旧值 ——
   * 表现就是工具栏看着还在原位、贴着屏幕右边被裁掉（实测复现过）。
   */
  const canvasSpan = ref<{ left: number; right: number; width: number } | null>(null)

  const measureCanvas = () => {
    const canvas = document.querySelector('.workflow-canvas') || document.querySelector('.vue-flow')
    const rect = canvas?.getBoundingClientRect()
    canvasSpan.value = rect
      ? { left: rect.left, right: rect.right, width: rect.width }
      : null
  }

  // 量宽度：反缩放后元素的 offsetWidth 就是它的屏幕宽度（scale 与 viewport 的 zoom 相抵）
  let observer: ResizeObserver | null = null
  let canvasObserver: ResizeObserver | null = null
  const measure = () => {
    const node = options.el.value
    if (node) toolbarWidth.value = node.offsetWidth
    measureCanvas()
  }
  onMounted(() => {
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      if (options.el.value) {
        observer = new ResizeObserver(measure)
        observer.observe(options.el.value)
      }
      const canvas = document.querySelector('.workflow-canvas') || document.querySelector('.vue-flow')
      if (canvas) {
        canvasObserver = new ResizeObserver(measureCanvas)
        canvasObserver.observe(canvas)
      }
    }
    window.addEventListener('resize', measure)
  })
  onBeforeUnmount(() => {
    observer?.disconnect()
    canvasObserver?.disconnect()
    observer = null
    canvasObserver = null
    window.removeEventListener('resize', measure)
  })
  // 条目变化（如下拉项增减）会改变宽度，视口变化时至少重新量一次
  watch(() => canvasViewport.value.zoom, () => requestAnimationFrame(measure))

  const style = computed(() => {
    const viewport = canvasViewport.value
    const zoom = Number(viewport?.zoom) > 0 ? Number(viewport.zoom) : 1
    const node = nodes.value.find(item => item.id === options.nodeId())
    const width = toolbarWidth.value || WIDTH_FALLBACK

    // 卡片中心在屏幕上的横坐标：画布位移 + 流坐标 × 缩放
    const cardCenterFlowX = (node?.position?.x || 0) + options.cardWidth() / 2
    const centerScreenX = Number(viewport?.x || 0) + cardCenterFlowX * zoom

    const shiftScreenX = resolveToolbarShift({
      cardCenterScreenX: centerScreenX,
      toolbarWidth: width,
      canvas: canvasSpan.value,
    })

    return {
      bottom: `calc(100% + ${TOOLBAR_GAP / zoom}px)`,
      left: '50%',
      transform: `translateX(calc(-50% + ${shiftScreenX / zoom}px)) scale(${1 / zoom})`,
      transformOrigin: 'bottom center',
    }
  })

  return { style }
}
