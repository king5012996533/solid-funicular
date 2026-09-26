/**
 * 一轮内插话（steer / follow-up）纯逻辑验证，2026-09-26
 *
 * 要钉死三件最容易静默出错的事：
 *   ① **插话不建新单**：运行中的发送路由必须落到 interject，绝不落 new-turn ——
 *      否则就是两个任务抢同一把画布锁（当初把它判为「高风险」的原因）；
 *   ② 投递走 Pi 原生队列：steer 进 steer 队列、follow-up 进 followUp 队列，
 *      且消息是 role=user（Pi 会把它注入转录 → 参与记忆/压缩，用户插的话留痕）；
 *   ③ 投递失败必须**如实回执**（这一轮已结束就 accepted=false），绝不假装已送达。
 *
 * 文件末尾有反证：把运行中的路由「误」改成 new-turn，插话不建单的断言必然失败。
 */

import { readFileSync } from 'node:fs'
import {
  buildCanvasAgentInterjectionMessage,
  getCanvasAgentSteeringTargetCount,
  isCanvasAgentSteeringActive,
  normalizeCanvasAgentInterjectionMode,
  registerCanvasAgentSteering,
  steerCanvasAgent,
  unregisterCanvasAgentSteering,
  type CanvasAgentSteeringMessage,
} from '../server/generation-tasks/canvas-agent-steering'
import {
  describeAgentInterjectionNotice,
  normalizeAgentInterjectionMode,
  resolveAgentSendRoute,
} from '../src/components/canana/agent-send-routing'

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

function assert(cond: unknown, message: string) {
  if (!cond) throw new Error(message)
}

/** 记录投递的假 Agent：只关心「谁被塞进了哪个队列、塞了什么」 */
const createFakeTarget = () => {
  const steered: CanvasAgentSteeringMessage[] = []
  const followedUp: CanvasAgentSteeringMessage[] = []
  return {
    steered,
    followedUp,
    target: {
      steer: (message: CanvasAgentSteeringMessage) => { steered.push(message) },
      followUp: (message: CanvasAgentSteeringMessage) => { followedUp.push(message) },
    },
  }
}

/** 只扫代码、不扫注释：注释里提到「旧路径是 createGenerationTask」是说明，不是调用 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

console.log('\n【1】运行中发送 → 插话（不建新单）')
{
  check('运行中 → interject', resolveAgentSendRoute({ running: true }), { kind: 'interject', mode: 'steer' })
  check('运行中 + 排队模式 → interject/follow-up', resolveAgentSendRoute({ running: true, mode: 'follow-up' }), {
    kind: 'interject', mode: 'follow-up',
  })
  check('空闲 → new-turn', resolveAgentSendRoute({ running: false }), { kind: 'new-turn' })
  check('空闲时忽略插话方式，仍然 new-turn', resolveAgentSendRoute({ running: false, mode: 'follow-up' }), {
    kind: 'new-turn',
  })
  check('默认（无方式）按插入当前轮', normalizeAgentInterjectionMode(undefined), 'steer')
  check('只认 follow-up', normalizeAgentInterjectionMode('follow-up'), 'follow-up')

  // 红线：插话模块自身不得出现任何「建任务」路径（只看代码，不把注释里的说明算进去）
  const steeringSource = stripComments(readFileSync(
    new URL('../server/generation-tasks/canvas-agent-steering.ts', import.meta.url),
    'utf8',
  ))
  assert(!/createGenerationTask|startGenerationTask/.test(steeringSource), '插话模块不得引用建单路径')
  assert(!/from\s+['"][^'"]*generation-tasks['"]/.test(steeringSource), '插话模块不得 import 建单所在模块')

  const routingSource = stripComments(readFileSync(
    new URL('../src/components/canana/agent-send-routing.ts', import.meta.url),
    'utf8',
  ))
  assert(!/createGenerationTask|startGenerationTask/.test(routingSource), '发送路由模块不得引用建单路径')

  // 反证：把运行中「误」判成 new-turn，核心断言必失败
  const wrongRoute = { kind: 'new-turn' } // 旧形态：运行中也走新建
  assert(
    JSON.stringify(wrongRoute) !== JSON.stringify(resolveAgentSendRoute({ running: true })),
    '反证成立：运行中若判成 new-turn，就会与正确路由不同（那正是「两个任务抢锁」的旧病）',
  )
}

console.log('\n【2】投递走 Pi 原生队列，且消息是 user（进转录 → 参与记忆/压缩）')
{
  const fake = createFakeTarget()
  registerCanvasAgentSteering('rec-steer', fake.target)
  check('注册后窗口打开', isCanvasAgentSteeringActive('rec-steer'), true)

  const result = steerCanvasAgent('rec-steer', { content: '  第三张换个角度  ', mode: 'steer' })
  check('steer 投递成功', { accepted: result.accepted, mode: result.mode }, { accepted: true, mode: 'steer' })
  check('进了 steer 队列（不是 followUp）', fake.followedUp.length, 0)
  check('内容去掉首尾空白', fake.steered[0]?.content, '第三张换个角度')
  check('消息是 role=user（Pi 会注入转录并落库）', fake.steered[0]?.role, 'user')
  check('带 timestamp', typeof fake.steered[0]?.timestamp, 'number')

  steerCanvasAgent('rec-steer', { content: '顺带把封面也做了', mode: 'follow-up' })
  check('follow-up 模式进 followUp 队列', fake.followedUp.length, 1)
  check('follow-up 消息同样是 user', fake.followedUp[0]?.role, 'user')

  unregisterCanvasAgentSteering('rec-steer')
  check('窗口关闭后不再登记', isCanvasAgentSteeringActive('rec-steer'), false)
  check('窗口关闭后插话如实失败', steerCanvasAgent('rec-steer', { content: '还在吗' }), {
    accepted: false, mode: 'steer', reason: '这一轮 Agent 已结束（或不在当前实例上运行），插话没有送达；请重新发起。',
  })
}

console.log('\n【3】失败/非法输入如实回执，绝不假装送达')
{
  const before = getCanvasAgentSteeringTargetCount()
  check('没有登记的任务 → accepted=false', steerCanvasAgent('rec-none', { content: '你好' }).accepted, false)
  check('  原因点明「已结束」', /已结束/.test(steerCanvasAgent('rec-none', { content: '你好' }).reason || ''), true)

  const fake = createFakeTarget()
  registerCanvasAgentSteering('rec-empty', fake.target)
  check('空内容 → accepted=false', steerCanvasAgent('rec-empty', { content: '   ' }).accepted, false)
  check('  空内容不投递', fake.steered.length + fake.followedUp.length, 0)
  unregisterCanvasAgentSteering('rec-empty')
  check('清理后登记数回到起点', getCanvasAgentSteeringTargetCount(), before)

  check('消息构造就是一条普通用户消息', buildCanvasAgentInterjectionMessage('  hi  ', 123), {
    role: 'user', content: 'hi', timestamp: 123,
  })
  check('提示文案区分插入/排队', [
    describeAgentInterjectionNotice('steer').includes('插入当前轮'),
    describeAgentInterjectionNotice('follow-up').includes('排队'),
  ], [true, true])
}

console.log(failed ? `\n${failed} 项失败（通过 ${passed}）` : `\n全部通过（${passed} 项）`)
process.exit(failed ? 1 : 0)
