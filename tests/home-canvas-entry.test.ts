/**
 * 首页「说一句 → 新建画布 → 自动交给 Agent」的纯逻辑单测。
 *
 * 这段逻辑决定三件容易出错的事：画布名怎么取、那句一次性标记什么时候该被清掉、
 * 以及在什么状态下才允许自动发送（未就绪不发、占用不发、已消费不发）。
 * 全是纯函数 + 可注入存储，不需要浏览器，直接跑 Node。
 */

import {
  FALLBACK_CANVAS_NAME,
  HOME_CANVAS_AGENT_PENDING_KEY,
  consumeHomeCanvasAgentPending,
  readHomeCanvasAgentPending,
  resolveAutoSendBlockReason,
  resolveHomeCanvasName,
  shouldAutoSendToAgent,
  writeHomeCanvasAgentPending,
  type HomeCanvasPendingStorage,
} from '../src/shared/home-canvas-entry'

interface MemoryStorage extends HomeCanvasPendingStorage {
  size: () => number
}

const createMemoryStorage = (): MemoryStorage => {
  const map = new Map<string, string>()
  return {
    getItem: (key) => (map.has(key) ? String(map.get(key)) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
    size: () => map.size,
  }
}

const autoSendState = (overrides: Partial<Parameters<typeof shouldAutoSendToAgent>[0]> = {}) => ({
  hasFlag: true,
  canvasReady: true,
  running: false,
  locked: false,
  consumed: false,
  ...overrides,
})

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

console.log('\n【1】画布命名：取自用户那句话')
{
  check('普通一句话原样使用', resolveHomeCanvasName('帮我做一只会飞的小猫'), '帮我做一只会飞的小猫')
  check('空串 → 未命名项目', resolveHomeCanvasName(''), FALLBACK_CANVAS_NAME)
  check('只有空白 → 未命名项目', resolveHomeCanvasName('  \n\t  '), FALLBACK_CANVAS_NAME)
  check(
    '折叠换行/连续空白并去首尾空格',
    resolveHomeCanvasName('  做\n一只  猫  '),
    '做 一只 猫',
  )
  check(
    '超过 14 字截断并加省略号',
    resolveHomeCanvasName('一二三四五六七八九十一二三四五'),
    '一二三四五六七八九十一二三四…',
  )
  check(
    '恰好 14 字不截断',
    resolveHomeCanvasName('一二三四五六七八九十一二三四'),
    '一二三四五六七八九十一二三四',
  )
  // 按码点截断：emoji 不能被从中间切开（否则名字里会出现半个字符）
  check(
    'emoji 按码点计数不切坏',
    resolveHomeCanvasName('😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀'),
    '😀😀😀😀😀😀😀😀😀😀😀😀😀😀…',
  )
}

console.log('\n【2】自动发送判定：就绪才发')
{
  check('全部就绪 → 发', shouldAutoSendToAgent(autoSendState()), true)
  check('没有标记 → 不发', shouldAutoSendToAgent(autoSendState({ hasFlag: false })), false)
  check('画布未就绪 → 不发', shouldAutoSendToAgent(autoSendState({ canvasReady: false })), false)
  check('正在跑一轮 → 不发', shouldAutoSendToAgent(autoSendState({ running: true })), false)
  check('画布被占用 → 不发', shouldAutoSendToAgent(autoSendState({ locked: true })), false)
  check('标记已消费 → 不发', shouldAutoSendToAgent(autoSendState({ consumed: true })), false)

  check('未就绪的原因 = wait（等状态变化再判）', resolveAutoSendBlockReason(autoSendState({ canvasReady: false })), 'wait')
  check('运行中的原因 = wait', resolveAutoSendBlockReason(autoSendState({ running: true })), 'wait')
  check('占用的原因 = occupied（填输入框，不发送）', resolveAutoSendBlockReason(autoSendState({ locked: true })), 'occupied')
  check('没有标记的原因 = none', resolveAutoSendBlockReason(autoSendState({ hasFlag: false })), 'none')
  check('已消费的原因 = none', resolveAutoSendBlockReason(autoSendState({ consumed: true })), 'none')
}

console.log('\n【3】一次性标记：先清再发，消费一次')
{
  const storage = createMemoryStorage()
  writeHomeCanvasAgentPending({ workflowId: 'w1', message: '做一只猫' }, storage)

  check('写入后能读到', readHomeCanvasAgentPending('w1', storage)?.message, '做一只猫')

  const first = consumeHomeCanvasAgentPending('w1', storage)
  const second = consumeHomeCanvasAgentPending('w1', storage)

  check('第一次消费拿到那句话', first?.message, '做一只猫')
  check('第二次消费拿不到（标记已被清）', second, null)
  check('消费后存储里不留标记', storage.size(), 0)
  check(
    '第二次判定必须是 false（同一标记不会二次发送）',
    shouldAutoSendToAgent(autoSendState({ hasFlag: Boolean(second), consumed: Boolean(first) })),
    false,
  )
}

console.log('\n【4】画布不匹配的标记：不误发，并清理干净')
{
  const storage = createMemoryStorage()
  writeHomeCanvasAgentPending({ workflowId: 'canvas-A', message: '给 A 的话' }, storage)

  check('拿 A 的标记问 B → 读不到', readHomeCanvasAgentPending('canvas-B', storage), null)
  check('问 B 时顺手把残留标记清掉', consumeHomeCanvasAgentPending('canvas-B', storage), null)
  check('清掉后 A 的标记也不再存在（避免飘到别的画布上误发）', storage.size(), 0)
}

console.log('\n【5】反证：去掉「先清标记再发送」，重复挂载会二次发送')
{
  const storage = createMemoryStorage()
  writeHomeCanvasAgentPending({ workflowId: 'w1', message: '做一只猫' }, storage)

  // 反证实现：只读不删（相当于去掉「先清标记」这一步）
  const naiveMount = () => readHomeCanvasAgentPending('w1', storage)
  const naiveMountA = naiveMount()
  const naiveMountB = naiveMount()
  check(
    '反证：只读不清时两次挂载都拿到标记 → 会二次发送',
    [naiveMountA?.message, naiveMountB?.message],
    ['做一只猫', '做一只猫'],
  )
  check(
    '反证：这种实现下第二次判定仍然为 true（提示二次发送）',
    shouldAutoSendToAgent(autoSendState({ hasFlag: Boolean(naiveMountB) })),
    true,
  )

  // 正确实现：同一枚标记，第一次挂载消费掉，第二次挂载什么也读不到
  const storage2 = createMemoryStorage()
  writeHomeCanvasAgentPending({ workflowId: 'w1', message: '做一只猫' }, storage2)
  const firstMount = consumeHomeCanvasAgentPending('w1', storage2)
  const secondMount = readHomeCanvasAgentPending('w1', storage2)
  check('正确实现：第一次挂载消费成功', firstMount?.message, '做一只猫')
  check('正确实现：第二次挂载读不到（不会二次发送）', secondMount, null)
  check(
    '正确实现：第二次判定为 false',
    shouldAutoSendToAgent(autoSendState({ hasFlag: Boolean(secondMount) })),
    false,
  )
}

console.log('\n【6】坏载荷：宁可不发，也不要在画布上乱发')
{
  const storage = createMemoryStorage()
  storage.setItem(HOME_CANVAS_AGENT_PENDING_KEY, 'not-json')
  check('无法解析的标记 → 读不到', readHomeCanvasAgentPending('w1', storage), null)

  const storage2 = createMemoryStorage()
  writeHomeCanvasAgentPending({ workflowId: 'w1', message: '   ' }, storage2)
  check('空白话不写入', storage2.size(), 0)

  const storage3 = createMemoryStorage()
  writeHomeCanvasAgentPending({ workflowId: '', message: '有话说' } as never, storage3)
  check('没有画布 id 不写入', storage3.size(), 0)
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
