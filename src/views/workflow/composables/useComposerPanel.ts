/**
 * 输入框浮层的尺寸规则（对齐 LibTV 实测，2026-09-22）
 *
 * 实测两件事：
 *  1. **宽度固定 660** —— 文本 / 图片 / 视频三类节点的输入框都是 660 宽，
 *     高度才按内容与类型变（文本 150 / 图片 192 / 视频 255 / 展开高级设置 +157）。
 *  2. **不随画布缩放** —— 画布 40% 与 75% 时它都是 660 宽，而卡片在缩。
 *     我们的输入框挂在节点内部，会跟着 `.vue-flow__viewport` 的 scale 一起缩，
 *     缩小画布时字和按钮就糊了。
 *
 * 所以这里按当前 zoom 反向缩一次把它抵掉：viewport 是 `scale(z)`，浮层再 `scale(1/z)`，
 * 屏幕尺寸就恒等于 660。锚点必须是 `top center` —— 输入框挂在卡片正下方，
 * 锚点跑偏会让它相对卡片左右乱飘。
 *
 * 抽成一处是因为三个节点组件都需要同一套规则；各写一份必然漂移。
 */
import { computed } from 'vue'
import { canvasViewport } from './useWorkflowCanvas'

/** 输入框浮层的固定宽度（LibTV 实测 660） */
export const CANVAS_PROMPT_WIDTH = 660

export const useComposerPanel = () => {
  const scale = computed(() => {
    const zoom = Number(canvasViewport.value?.zoom) || 1
    return zoom > 0 ? 1 / zoom : 1
  })

  const style = computed(() => ({
    width: `${CANVAS_PROMPT_WIDTH}px`,
    transform: `translateX(-50%) scale(${scale.value})`,
    transformOrigin: 'top center',
  }))

  return { style }
}
