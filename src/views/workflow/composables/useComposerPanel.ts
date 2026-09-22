/**
 * 输入框浮层的尺寸与避让规则（对齐 LibTV 实测 + 两处实测修正，2026-09-22）
 *
 * **实测到的固定规格**：
 *  1. **宽度固定 660** —— 文本 / 图片 / 视频三类节点的输入框都是 660 宽，
 *     高度才按内容与类型变（文本 150 / 图片 192 / 视频 255 / 展开高级设置 +157）。
 *  2. **不随画布缩放** —— 画布 40% 与 75% 时它都是 660 宽，而卡片在缩。
 *     我们的输入框挂在节点内部，会跟着 `.vue-flow__viewport` 的 scale 一起缩，
 *     缩小画布时字和按钮就糊了。
 *  3. 锚点必须是 `top center` —— 输入框挂在卡片正下方，锚点跑偏会让它相对卡片左右乱飘。
 *
 * **两处修正（用户实测报上来的）**：
 *  · 输入框长在卡片下方，卡片靠画布底部时它的下半截会被画布底部工具栏（z-index 50）
 *    盖住 —— 高级设置那两个开关点都点不到。所以这里**算出它最低能到哪**，
 *    超出就把整块往上抬（抬到工具栏上方为止；实在放不下才退到靠层级压过工具栏）。
 *  · 开关标签原先会被挤成三行（「自动校验素材」被压进 28px 宽，折成「自动/校验/素材」）——
 *    那是样式问题，在 ContentGenerator 里给标签加 nowrap 解决，不在这个文件。
 *
 * 抽成一处是因为三个节点组件都需要同一套规则；各写一份必然漂移。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { canvasViewport, nodes } from './useWorkflowCanvas'

/** 输入框浮层的固定宽度（LibTV 实测 660） */
export const CANVAS_PROMPT_WIDTH = 660
/** 浮层与卡片底边的间距（LibTV 实测 12） */
const COMPOSER_GAP = 12
/** 抬升后与底部工具栏之间留的缝 */
const DOCK_CLEARANCE = 8
/** 抬升后与画布顶边之间留的缝（实在放不下时会被这个夹住） */
const CANVAS_TOP_CLEARANCE = 8

export const useComposerPanel = (options: {
  /** 浮层元素（组件持有，用来量高度） */
  el?: { value: HTMLElement | null }
  /** 所属节点 id（用来拿它的流坐标） */
  nodeId?: () => string
  /** 卡片布局高度（算卡片底边的屏幕位置） */
  cardHeight?: () => number
} = {}) => {
  const scale = computed(() => {
    const zoom = Number(canvasViewport.value?.zoom) || 1
    return zoom > 0 ? 1 / zoom : 1
  })

  const panelHeight = ref(0)
  const canvasRect = ref<{ top: number; bottom: number; height: number } | null>(null)
  const dockTop = ref<number | null>(null)

  const measureRect = (el: Element | null) => {
    const rect = el?.getBoundingClientRect()
    return rect ? { top: rect.top, bottom: rect.bottom, height: rect.height } : null
  }

  const measure = () => {
    panelHeight.value = options.el?.value?.offsetHeight ?? 0
    const canvas = document.querySelector('.workflow-canvas') || document.querySelector('.vue-flow')
    canvasRect.value = measureRect(canvas)
    // 底部工具栏：它才是真正会盖住输入框的东西，量它的上沿
    const dock = document.querySelector('.canvas-dock-toolbar')
    dockTop.value = dock ? dock.getBoundingClientRect().top : null
  }

  let observer: ResizeObserver | null = null
  let canvasObserver: ResizeObserver | null = null
  let dockObserver: ResizeObserver | null = null
  onMounted(() => {
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      if (options.el?.value) {
        observer = new ResizeObserver(measure)
        observer.observe(options.el.value)
      }
      const canvas = document.querySelector('.workflow-canvas') || document.querySelector('.vue-flow')
      if (canvas) {
        canvasObserver = new ResizeObserver(measure)
        canvasObserver.observe(canvas)
      }
      const dock = document.querySelector('.canvas-dock-toolbar')
      if (dock) {
        dockObserver = new ResizeObserver(measure)
        dockObserver.observe(dock)
      }
    }
    window.addEventListener('resize', measure)
  })
  onBeforeUnmount(() => {
    observer?.disconnect()
    canvasObserver?.disconnect()
    dockObserver?.disconnect()
    observer = null
    canvasObserver = null
    dockObserver = null
    window.removeEventListener('resize', measure)
  })
  // 画布缩放会改变卡片底边的屏幕位置，也就改变了需要抬多少
  watch(() => canvasViewport.value.zoom, () => requestAnimationFrame(measure))

  /**
   * 需要往上抬多少（屏幕像素）。
   *
   * 自然位置 = 卡片底边的屏幕位置 + 间距；它的下沿越过工具栏上沿就得抬。
   * 抬的上限是「不让浮层顶边越过画布顶边」—— 放不下时不再硬抬，
   * 交给 z-index（见下面的 style）压过工具栏，至少保证内容完整可点。
   */
  const liftScreenPx = computed(() => {
    const nodeId = options.nodeId?.()
    const cardH = options.cardHeight?.() ?? 0
    if (!nodeId || !cardH || !panelHeight.value) return 0
    const viewport = canvasViewport.value
    const zoom = Number(viewport?.zoom) > 0 ? Number(viewport.zoom) : 1
    const node = nodes.value.find(item => item.id === nodeId)
    if (!node) return 0

    const naturalTop = Number(viewport?.y || 0) + (node.position.y + cardH) * zoom + COMPOSER_GAP * zoom
    const naturalBottom = naturalTop + panelHeight.value
    const limitBottom = (dockTop.value ?? canvasRect.value?.bottom ?? naturalBottom) - DOCK_CLEARANCE
    if (naturalBottom <= limitBottom) return 0

    const wanted = naturalBottom - limitBottom
    const maxLift = canvasRect.value
      ? Math.max(0, naturalTop - (canvasRect.value.top + CANVAS_TOP_CLEARANCE))
      : wanted
    return Math.min(wanted, maxLift)
  })

  const style = computed(() => {
    const zoom = Number(canvasViewport.value?.zoom) > 0 ? Number(canvasViewport.value.zoom) : 1
    const lift = liftScreenPx.value
    const translateY = lift > 0 ? ` translateY(${-lift / zoom}px)` : ''
    return {
      width: `${CANVAS_PROMPT_WIDTH}px`,
      transform: `translateX(-50%)${translateY} scale(${scale.value})`,
      transformOrigin: 'top center',
      // 抬不动时（浮层比可用高度还高）靠层级压过工具栏，宁可盖住工具栏也不能被它盖住
      zIndex: '60',
    }
  })

  return { style }
}
