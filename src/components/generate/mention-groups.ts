/**
 * @ 素材引用面板的分组逻辑
 *
 * 单独放一个纯模块（而不是塞进 SFC），是为了不起 Vue 就能测到「哪些种类出现、顺序如何」。
 * 面板组件只负责渲染与键盘，规则全在这里：固定顺序、空种类不显示、同类内保持传入顺序。
 */

import type {
  ReferenceKind,
  ReferenceableAsset,
} from '@/views/workflow/composables/reference-resolver'

// 类型从解析器转出去，消费方（面板）只认这一个入口，避免各处各写一份 kind 联合类型
export type { ReferenceKind, ReferenceableAsset }

export interface ReferenceKindGroup {
  kind: ReferenceKind
  /** 一级菜单显示的种类名，如 '图片' */
  label: string
  items: ReferenceableAsset[]
}

/**
 * 一级菜单的固定顺序：图片 → 文本 → 视频。
 * 顺序本身就是需求（LibTV 的菜单位置稳定），所以不按资产数量排序 ——
 * 那样每连一个上游，用户记住的位置就会跳一次。
 */
export const REFERENCE_KIND_ORDER: ReferenceKind[] = ['image', 'text', 'video']

/** 中文种类名。不依赖资产自带的 kindLabel：菜单文案不该被上游数据质量左右 */
const KIND_LABELS: Record<ReferenceKind, string> = {
  image: '图片',
  text: '文本',
  video: '视频',
}

/**
 * 按种类分组。第一级只显示有资产的种类，全空时返回空数组（面板据此显示空态）。
 * 同类内保持传入顺序：资产序号由上游按连线顺序编好了，这里再排一次会让
 * 「菜单里的顺序」和「token 里的序号」对不上。
 */
export function groupReferenceAssets(assets: ReferenceableAsset[]): ReferenceKindGroup[] {
  const groups: ReferenceKindGroup[] = []
  const grouped = new Set<ReferenceKind>()

  for (const kind of REFERENCE_KIND_ORDER) {
    const items = assets.filter(asset => asset.kind === kind)
    if (items.length === 0) continue
    grouped.add(kind)
    groups.push({ kind, label: KIND_LABELS[kind], items })
  }

  // ReferenceKind 目前是这三个的闭集；这一段是防将来新增种类时，资产被静默吞掉
  // （宁可多显示一类，也不要让用户连了线却在菜单里找不到）
  for (const asset of assets) {
    if (grouped.has(asset.kind)) continue
    grouped.add(asset.kind)
    const items = assets.filter(item => item.kind === asset.kind)
    groups.push({ kind: asset.kind, label: items[0].kindLabel || String(asset.kind), items })
  }

  return groups
}
