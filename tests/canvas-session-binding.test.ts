/**
 * 画布 → 会话映射的读写与隔离（B 的纯逻辑）。
 *
 * 要钉死的三件事：
 *   1. **无映射 → 新建**：首次进一张画布时建一条会话并写回映射；
 *   2. **命中就复用**：再进同一张画布用的是同一条会话（面板才显示得住那次对话，
 *      Agent 记忆的键 sessionId + 画布 id 才命中得到）；
 *   3. **隔离**：A 画布的会话不会被 B 画布复用 —— 这是「切画布 = 切会话、不串台」的底线。
 *
 * 末尾有**反证**：把两张画布喂进同一张映射时，第二次决策必须仍然要求新建，
 * 否则就退化成修复前「全局一个会话」的串台状态。
 */

import {
  decideCanvasSession,
  parseCanvasSessionMap,
  upsertCanvasSessionBinding,
  type CanvasSessionMap,
} from '../src/composables/canvas-session-binding'

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

console.log('\n【1】解析落盘映射：脏数据一律当空表，绝不把会话绑丢')
check('null → {}', parseCanvasSessionMap(null), {})
check('空串 → {}', parseCanvasSessionMap(''), {})
check('坏 JSON → {}', parseCanvasSessionMap('{not json'), {})
check('数组 → {}', parseCanvasSessionMap('[1,2]'), {})
check('合法对象原样解析', parseCanvasSessionMap('{"wf-a":"s-1"}'), { 'wf-a': 's-1' })
check(
  '丢掉空键 / 空值',
  parseCanvasSessionMap({ 'wf-a': 's-1', '': 's-2', 'wf-b': '' } as unknown as string),
  { 'wf-a': 's-1' },
)

console.log('\n【2】决策：无画布 id 时什么都不做（未保存的画布不建会话、不串台）')
check(
  '空 id → 不新建、不绑定、不给会话',
  decideCanvasSession({ canvasId: '', map: {}, existingSessionIds: [] }),
  { sessionId: '', needsCreate: false, shouldBind: false },
)

console.log('\n【3】决策：无映射 → 新建并写回')
check(
  '没有映射 → needsCreate + shouldBind',
  decideCanvasSession({ canvasId: 'wf-a', map: {}, existingSessionIds: ['s-1'] }),
  { sessionId: '', needsCreate: true, shouldBind: true },
)

console.log('\n【4】决策：映射命中且会话还在 → 复用（「回到这张画布那次对话」）')
check(
  '命中 → 复用，且不重复建',
  decideCanvasSession({ canvasId: 'wf-a', map: { 'wf-a': 's-1' }, existingSessionIds: ['s-1', 's-9'] }),
  { sessionId: 's-1', needsCreate: false, shouldBind: false },
)

console.log('\n【5】决策：映射指向已被删的会话 → 重新新建')
check(
  '映射在、会话没了 → needsCreate',
  decideCanvasSession({ canvasId: 'wf-a', map: { 'wf-a': 's-gone' }, existingSessionIds: ['s-1'] }),
  { sessionId: '', needsCreate: true, shouldBind: true },
)

console.log('\n【6】写回与隔离：一张画布动不了另一张画布的绑定')
{
  const base: CanvasSessionMap = {}
  const withA = upsertCanvasSessionBinding(base, 'wf-a', 's-a')
  const withBoth = upsertCanvasSessionBinding(withA, 'wf-b', 's-b')
  check('原表不被就地修改', base, {})
  check('A → s-a', withBoth['wf-a'], 's-a')
  check('B → s-b', withBoth['wf-b'], 's-b')
  const updatedA = upsertCanvasSessionBinding(withBoth, 'wf-a', 's-a2')
  check('更新 A 不影响 B', updatedA['wf-b'], 's-b')
  check('更新 A 生效', updatedA['wf-a'], 's-a2')
  check('空键 / 空值不写入', upsertCanvasSessionBinding(withBoth, '', 's-x'), withBoth)
}

console.log('\n【7】反证：A 已绑的会话不会被 B 复用（否则又是全局一个会话的串台）')
{
  const map: CanvasSessionMap = upsertCanvasSessionBinding({}, 'wf-a', 's-a')
  const forB = decideCanvasSession({ canvasId: 'wf-b', map, existingSessionIds: ['s-a'] })
  check('反证：B 不能拿到 A 的会话', forB.sessionId === 's-a' ? 'reused' : 'isolated', 'isolated')
  check('反证：B 必须要求新建', forB.needsCreate, true)
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
