/**
 * 画布图标模块的静态校验
 *
 * 图标是一堆手写 path 数据，编译器只能保证「名字齐全」，保证不了 path 本身能用。
 * 一个手误的坐标（NaN）、一段没写完的 `d`、或者 `undefined` 被拼进字符串，
 * 在浏览器里表现为「图标不显示但也不报错」，非常难查。所以这里把几条硬规则钉死：
 * 每个图标非空、以 M/m 起笔、只含合法命令与数字、数值量级不能超出画布、
 * 并且两两不重复（防复制粘贴后忘了改）。
 *
 * 顺带守住 node-suggestions 的展示顺序（菜单顺序依赖它），以及
 * `icon` 字段确实取自图标模块 —— 而不是某处又写死了一个 path。
 */

import {
  CANVAS_ICON_NAMES,
  CANVAS_ICONS,
  getCanvasIcon,
} from '../src/components/icons/canvas-icons'
import { NODE_TYPE_PRESENTATION } from '../src/views/workflow/config/node-suggestions'

let passed = 0
let failed = 0

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    console.log(`  ❌ ${label}\n     期望 ${e}\n     实际 ${a}`)
  }
}

const ICON_ENTRIES = CANVAS_ICON_NAMES.map(name => [name, getCanvasIcon(name)] as const)

interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

/**
 * 极简 path 解析：本模块只用 M/m、L/l、H/h、V/v、A/a、Z/z，
 * 圆弧的极值点正好落在它的端点上（圆角和半圆都是），所以只跟踪折点就够算包围盒。
 * 出现别的命令或参数数量不对，返回 null 表示「这个 path 我们没读懂」。
 */
function pathBounds(d: string): Bounds | null {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || []
  const arity: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, a: 7, z: 0 }

  const bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  const touch = (x: number, y: number) => {
    bounds.minX = Math.min(bounds.minX, x)
    bounds.minY = Math.min(bounds.minY, y)
    bounds.maxX = Math.max(bounds.maxX, x)
    bounds.maxY = Math.max(bounds.maxY, y)
  }

  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  let cmd = ''
  let i = 0

  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) {
      cmd = tokens[i]
      i++
      if (cmd.toLowerCase() === 'z') {
        x = startX
        y = startY
        continue
      }
    }
    const key = cmd.toLowerCase()
    const n = arity[key]
    if (n === undefined || i + n > tokens.length) return null
    const args = tokens.slice(i, i + n).map(Number)
    if (args.some(v => !Number.isFinite(v))) return null
    i += n

    const relative = cmd === key
    switch (key) {
      case 'm':
        x = relative ? x + args[0] : args[0]
        y = relative ? y + args[1] : args[1]
        startX = x
        startY = y
        break
      case 'l':
        x = relative ? x + args[0] : args[0]
        y = relative ? y + args[1] : args[1]
        break
      case 'h':
        x = relative ? x + args[0] : args[0]
        break
      case 'v':
        y = relative ? y + args[0] : args[0]
        break
      case 'a':
        x = relative ? x + args[5] : args[5]
        y = relative ? y + args[6] : args[6]
        break
    }
    touch(x, y)
  }

  if (!Number.isFinite(bounds.minX) || !Number.isFinite(bounds.maxX)) return null
  return bounds
}

const BOUNDS = new Map(ICON_ENTRIES.map(([name, d]) => [name, pathBounds(d)] as const))

console.log('\n【1】每个名字都能取到图标')
{
  check('全部图标名都能取到路径', ICON_ENTRIES.filter(([, d]) => !d).map(([name]) => name), [])
  check('图标数量与名字表一致', ICON_ENTRIES.length, CANVAS_ICON_NAMES.length)
  // 名字表是联合类型的唯一来源，这里确认运行时的 key 没多也没少
  check('CANVAS_ICONS 的 key 与名字表一致', Object.keys(CANVAS_ICONS).sort(), [...CANVAS_ICON_NAMES].sort())
  check('名字表里没有重复项', new Set(CANVAS_ICON_NAMES).size, CANVAS_ICON_NAMES.length)
  check('传入未收录的名字返回空串而不是 undefined', getCanvasIcon('' as never), '')
}

console.log('\n【2】path 数据本身可用')
{
  check('每个 path 都以 M/m 起笔', ICON_ENTRIES.filter(([, d]) => !/^[Mm]/.test(d)).map(([n]) => n), [])
  check('每个 path 都是完整的一段（非空且不含首尾空白）',
    ICON_ENTRIES.filter(([, d]) => d.length < 8 || d.trim() !== d).map(([n]) => n), [])
  check('path 里没有 NaN / undefined / null',
    ICON_ENTRIES.filter(([, d]) => /NaN|undefined|null|\[object/.test(d)).map(([n]) => n), [])

  // 字面量 `<` 意味着有人把标签或组件字符串塞进来了
  check('path 里没有标记字符',
    ICON_ENTRIES.filter(([, d]) => /[<>]/.test(d)).map(([n]) => n), [])
  check('path 只含合法命令与数字',
    ICON_ENTRIES.filter(([, d]) => !/^[MmLlHhVvCcSsQqTtAaZz0-9.,+\-eE\s]+$/.test(d)).map(([n]) => n), [])
  check('没有孤立的点号（漏写数字）',
    ICON_ENTRIES.filter(([, d]) => /(^|[^\d])\.([^\d]|$)/.test(d)).map(([n]) => n), [])

  // 光学尺寸守卫：所有折点都要落在 3.5–20.5 的视觉边距里，
  // 并且图形本身不能太小 —— 否则某个图标会比同屏的其它图标明显偏大或偏小
  check('每个 path 都能被解析出折点', [...BOUNDS].filter(([, b]) => !b).map(([n]) => n), [])
  const oversized = [...BOUNDS]
    .filter(([, b]) => !!b && (b.minX < 3.5 || b.minY < 3.5 || b.maxX > 20.5 || b.maxY > 20.5))
    .map(([n]) => n)
  check('所有坐标都在 3.5–20.5 的视觉边距内', oversized, [])
  const undersized = [...BOUNDS]
    .filter(([, b]) => !!b && (b.maxX - b.minX < 6 || b.maxY - b.minY < 6))
    .map(([n]) => n)
  check('每个图标都有足够的可视尺寸', undersized, [])
  // 数值量级守卫：本模块的绝对坐标和相对偏移都小于画布边长 24
  const runaway = ICON_ENTRIES
    .filter(([, d]) => (d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []).some(token => !Number.isFinite(Number(token)) || Math.abs(Number(token)) > 24))
    .map(([n]) => n)
  check('路径里的数值都在画布量级内', runaway, [])
  check('没有两个图标用同一段 path',
    Object.values(CANVAS_ICONS).length - new Set(Object.values(CANVAS_ICONS)).size, 0)
  // 图标只画形状，颜色与描边参数必须由使用方决定
  check('path 里不含样式与色值',
    ICON_ENTRIES.filter(([, d]) => /(stroke|fill|currentColor|#[0-9a-f]{3,8})/i.test(d)).map(([n]) => n), [])
}

console.log('\n【3】需要的基础图标都在')
{
  const required = [
    'text', 'image', 'video', 'llm', 'upload', 'duplicate',
    'delete', 'download', 'settings', 'plus', 'folder', 'magic', 'layers',
  ]
  check('语义图标一个都不少', required.filter(name => !CANVAS_ICON_NAMES.includes(name as never)), [])
}

console.log('\n【4】node-suggestions 的展示信息接上了图标模块')
{
  // 顺序是菜单稳定性的依赖，所以逐个列出来断言；新增类型必须显式改这一行
  check('展示顺序固定为 文本/图片/视频/LLM/剧本/素材',
    NODE_TYPE_PRESENTATION.map(item => item.type), ['text', 'image', 'video', 'llmConfig', 'script', 'asset'])
  check('恰好六类节点', NODE_TYPE_PRESENTATION.length, 6)

  const iconPool = new Set<string>(Object.values(CANVAS_ICONS))
  check('每个 icon 都是图标模块里的真实路径',
    NODE_TYPE_PRESENTATION.filter(item => !iconPool.has(item.icon)).map(item => item.type), [])
  check('五类节点各自对上语义图标',
    Object.fromEntries(NODE_TYPE_PRESENTATION.map(item => [item.type, item.icon])),
    {
      text: getCanvasIcon('text'),
      image: getCanvasIcon('image'),
      video: getCanvasIcon('video'),
      llmConfig: getCanvasIcon('llm'),
      script: getCanvasIcon('llm'),
      asset: getCanvasIcon('folder'),
    })
  check('icon 与 color 仍然是字符串',
    NODE_TYPE_PRESENTATION.every(i => typeof i.icon === 'string' && typeof i.color === 'string'), true)
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
