#!/usr/bin/env node
/**
 * 画布拖拽回归守卫（2026-09-23）
 *
 * 背景：用户反馈「拖拽不跟手」，查下来是两个**静默**问题 —— 都靠人工浏览器实测才发现，
 * 代码本身不报错、类型检查也过：
 *
 *   1. VueFlow 上开着 :snap-to-grid="true" :snap-grid="[20,20]"（Vue Flow 内置网格吸附）。
 *      指针在同一个 20px 格子里移动时节点纹丝不动，跨格才跳一下 —— CDP 实测 59.7% 的帧
 *      「指针动了节点没动」、最长连续 16 帧≈267ms 白走、跳跃 26px（20 × 缩放 1.343）。
 *      去掉后同样的脚本实测：冻结帧 0.0%、抓取偏移漂移 0px。
 *
 *   2. onNodeDrag 把 dragEvent.nodes 当成「全部节点」传给了对齐计算。它的语义其实是
 *      「正在被拖拽的节点」（多选时是那一批），于是 peers 里永远只有被拖的那个自己、
 *      被 `peer.id === dragged.id` 跳过 —— 对齐辅助线**一次都没生效过**（参考线元素恒为 0）。
 *
 * 这两类问题没有编译期信号，所以在这里钉住：文案里说的「跟手」是有明确代码前提的。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (rel) => readFileSync(path.join(rootDir, rel), 'utf8')

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log(`  ok   ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
}

const canvasIndex = read('src/views/workflow/index.vue')
const guides = read('src/views/workflow/composables/useCanvasAlignmentGuides.ts')

// 注释里会解释「为什么关掉」，检查属性时必须先把注释剥掉，否则自己把自己判失败
const canvasIndexWithoutComments = canvasIndex.replace(/<!--[\s\S]*?-->/g, '')

console.log('== 拖拽跟手：不许再开网格吸附 ==')
check(
  'VueFlow 上没有 snap-to-grid / snap-grid（开了就不是跟手，是每格跳一次）',
  !/:snap-to-grid\s*=/.test(canvasIndexWithoutComments) && !/:snap-grid\s*=/.test(canvasIndexWithoutComments),
  '实测 59.7% 的帧「指针动、节点不动」，去掉后 0%',
)
check(
  '注释里保留了「为什么关掉」的说明（避免后人又打开）',
  canvasIndex.includes('拖拽不跟手'),
)

console.log('== 对齐辅助线：peers 必须是「全部节点」 ==')
check(
  'onNodeDrag 用画布全部节点做 peers（nodes.value），而不是 dragEvent.nodes',
  /computeAlignment\(node,\s*nodes\.value/.test(canvasIndex),
  'dragEvent.nodes 是「正在被拖拽的节点」，拿它当 peers 会让参考线永远算不出来',
)
check(
  '对齐计算按需声明最小形状（不直接依赖 Vue Flow 的 GraphNode）',
  guides.includes('AlignmentNodeLike'),
)
check(
  '多选拖拽整组平移（dragEvent.nodes 用于施加对齐量）',
  canvasIndex.includes('draggedNodes?.length ? draggedNodes : [node]'),
)

console.log(failures ? `\n${failures} 项失败` : '\n画布拖拽守卫通过')
process.exit(failures ? 1 : 0)
