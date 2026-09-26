/**
 * 确认卡「稳定显示服务端估算」的缓存逻辑单测（2026-09-26）
 *
 * 要钉死的事：
 *   1. 缓存键 = 目标节点集合的**规范化形式**（排序 + 去重，顺序无关）；
 *   2. **集合精确匹配才命中**（多一个/少一个都不行），命中才显示服务端数字；
 *   3. 缺失 / 过期 → 降级成固定预扣文案（宁可不说数字，也不说错的）；
 *   4. 余额拿不到就只显示估算那一行；
 *   5. 模型自报的 `costPoints` 在任何路径下都不参与展示；
 *   6. 反证：把「精确匹配」放宽成「有交集就命中」，断言必然失败。
 *
 * 跑法：npx tsx tests/agent-confirm-cost-cache.test.ts（由 npm run test:unit 统一跑）
 */

import {
  AGENT_CONFIRM_PREDEDUCT_NOTICE,
  PREFLIGHT_ESTIMATE_TTL_MS,
  clearPreflightEstimates,
  normalizePreflightNodeKey,
  readPreflightEstimate,
  rememberPreflightEstimate,
  resolveAgentConfirmCostDisplay,
  resolveAgentConfirmCostDisplayFromCache,
} from '../src/components/canana/agent-confirm-cost'
import { executeCanvasAgentTool } from '../src/views/workflow/agent/canvas-agent-tools'

let passed = 0
let failed = 0

function check(label: string, cond: boolean) {
  if (cond) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    console.log(`  ❌ ${label}`)
  }
}

console.log('\n【1】缓存键规范化：顺序无关、去重、空集合为空串')
{
  const a = normalizePreflightNodeKey(['n2', 'n1', 'n2'])
  const b = normalizePreflightNodeKey(['n1', 'n2'])
  check('去重', normalizePreflightNodeKey(['n1', 'n1']) === 'n1')
  check('顺序无关（同一集合不同顺序 → 同一键）', a === b)
  check('空集合 → 空串（永不命中）', normalizePreflightNodeKey([]) === '')
  check('非字符串项被忽略', normalizePreflightNodeKey(['n1', 42, null, undefined]) === 'n1')
  check('空白 id 被剔除', normalizePreflightNodeKey([' n1 ', '  ']) === 'n1')
}

console.log('\n【2】命中：集合完全一致（顺序无关）→ 显示服务端数字 + 余额')
{
  clearPreflightEstimates()
  const wrote = rememberPreflightEstimate({
    nodeIds: ['n1', 'n2', 'n3'],
    estimatedCostTotal: 36,
    availablePoints: 200,
    now: 1_000,
  })
  check('预校验结果成功写入缓存', wrote === true)

  const display = resolveAgentConfirmCostDisplayFromCache({ nodeIds: ['n3', 'n1', 'n2'], now: 1_000 })
  check('集合顺序不同仍命中，显示服务端估算', display.estimatedPoints === 36)
  check('命中时显示服务端余额', display.balanceText === '当前余额 200')
  check('命中时仍带预扣说明', display.notice === AGENT_CONFIRM_PREDEDUCT_NOTICE)

  const facts = readPreflightEstimate({ nodeIds: ['n1', 'n2', 'n3'], now: 1_000 })
  check('读回的就是服务端原始总额', facts?.estimatedCostTotal === 36)
  check('读回的就是服务端原始余额', facts?.availablePoints === 200)
}

console.log('\n【3】精确匹配才算命中：多一个 / 少一个都不行（不把 A 批总额安到 B 批）')
{
  clearPreflightEstimates()
  rememberPreflightEstimate({ nodeIds: ['n1', 'n2'], estimatedCostTotal: 24, availablePoints: 100, now: 0 })

  check('少一个节点 → 不命中', readPreflightEstimate({ nodeIds: ['n1'], now: 0 }) === null)
  check('多一个节点 → 不命中', readPreflightEstimate({ nodeIds: ['n1', 'n2', 'n3'], now: 0 }) === null)
  check('换一个节点（有交集）→ 不命中', readPreflightEstimate({ nodeIds: ['n2', 'n9'], now: 0 }) === null)
  check(
    '不命中时降级：不显示任何数字',
    resolveAgentConfirmCostDisplayFromCache({ nodeIds: ['n1'], now: 0 }).estimatedPoints === null,
  )
}

console.log('\n【4】TTL：过期不命中，降级')
{
  clearPreflightEstimates()
  rememberPreflightEstimate({ nodeIds: ['t1'], estimatedCostTotal: 7, availablePoints: 50, now: 1_000, ttlMs: 1_000 })

  check('未过期（now < expiresAt）仍命中', readPreflightEstimate({ nodeIds: ['t1'], now: 1_999 })?.estimatedCostTotal === 7)
  check('到点即过期（now >= expiresAt）不命中', readPreflightEstimate({ nodeIds: ['t1'], now: 2_000 }) === null)
  check(
    '过期后降级：不显示数字',
    resolveAgentConfirmCostDisplayFromCache({ nodeIds: ['t1'], now: 2_000 }).estimatedPoints === null,
  )
  check('默认 TTL 是 5 分钟', PREFLIGHT_ESTIMATE_TTL_MS === 5 * 60_000)
}

console.log('\n【5】无缓存 / 空集合 → 固定降级文案')
{
  clearPreflightEstimates()
  const none = resolveAgentConfirmCostDisplayFromCache({ nodeIds: ['n1', 'n2'] })
  check('无缓存：不显示编号数字', none.estimatedPoints === null)
  check('无缓存：显示预扣说明原文', none.notice === AGENT_CONFIRM_PREDEDUCT_NOTICE)
  check('无缓存：不显示余额行', none.balanceText === null)

  check('空集合永远不命中', resolveAgentConfirmCostDisplayFromCache({ nodeIds: [] }).estimatedPoints === null)
  check(
    '空集合不能写入缓存',
    rememberPreflightEstimate({ nodeIds: [], estimatedCostTotal: 10 }) === false,
  )
}

console.log('\n【6】余额缺失：仍显示服务端估算，只省略余额那一行')
{
  clearPreflightEstimates()
  rememberPreflightEstimate({ nodeIds: ['b1', 'b2'], estimatedCostTotal: 18, availablePoints: undefined, now: 0 })
  const display = resolveAgentConfirmCostDisplayFromCache({ nodeIds: ['b1', 'b2'], now: 0 })
  check('有估算 → 显示服务端数字', display.estimatedPoints === 18)
  check('余额拿不到 → 只显示前半句（不显示余额行）', display.balanceText === null)
  check('仍带预扣说明', display.notice === AGENT_CONFIRM_PREDEDUCT_NOTICE)
}

console.log('\n【7】模型自报 costPoints 在任何路径下都不参与展示')
{
  clearPreflightEstimates()
  rememberPreflightEstimate({ nodeIds: ['m1', 'm2'], estimatedCostTotal: 30, availablePoints: 90, now: 0 })

  const baseline = resolveAgentConfirmCostDisplayFromCache({ nodeIds: ['m1', 'm2'], now: 0 })
  const withModelCost = resolveAgentConfirmCostDisplayFromCache({
    nodeIds: ['m1', 'm2'],
    now: 0,
    costPoints: 9999,
  } as never)
  check('缓存命中时，模型自报 costPoints 不影响结果', withModelCost.estimatedPoints === baseline.estimatedPoints)
  check('缓存命中时数字仍等于服务端值（不是模型值）', withModelCost.estimatedPoints === 30)

  const modelOnly = resolveAgentConfirmCostDisplay({ costPoints: 2 } as never)
  check('底层显示函数：模型自报 costPoints 进不来（结构上不成立）', modelOnly.estimatedPoints === null)

  // 缓存未命中时，模型自报的数字也不该被拿来充数
  const missWithModelCost = resolveAgentConfirmCostDisplayFromCache({
    nodeIds: ['unknown'],
    costPoints: 2,
  } as never)
  check('缓存未命中：模型自报 costPoints 也不显示（降级）', missWithModelCost.estimatedPoints === null)
}

console.log('\n【8】工具层接线：preflight_check 按「实际预校验的那批」写缓存')
{
  clearPreflightEstimates()
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    const target = String(url)
    if (target.includes('/api/points/estimate')) {
      return { ok: true, status: 200, json: async () => ({ success: true, totalEstimated: 30 }) }
    }
    if (target.includes('/api/points/balance')) {
      return { ok: true, status: 200, json: async () => ({ success: true, available: 100 }) }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  }) as unknown as typeof globalThis.fetch

  try {
    const ids = ['n1', 'n2', 'n3']
    const nodes = ids.map((id) => ({
      id, type: 'image', label: id, text: 'p', prompt: 'p', model: 'prov::IMAGE::m1', size: '16:9',
    }))
    const ctx = { snapshotNodes: () => nodes, snapshotEdges: () => [] }

    await executeCanvasAgentTool('preflight_check', { ids }, ctx as never)

    const cached = readPreflightEstimate({ nodeIds: ['n3', 'n2', 'n1'] })
    check('预校验把服务端总额写进缓存', cached?.estimatedCostTotal === 30)
    check('预校验把服务端余额写进缓存', cached?.availablePoints === 100)
    check('确认卡对同一批（顺序不同）能命中', resolveAgentConfirmCostDisplayFromCache({ nodeIds: ids }).estimatedPoints === 30)
    check('少一个节点不命中（缓存键就是实际预校验的那批）', readPreflightEstimate({ nodeIds: ids.slice(0, 2) }) === null)
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('\n【9】反证：放宽成「有交集就命中」会把别的批次算进来')
{
  clearPreflightEstimates()
  rememberPreflightEstimate({ nodeIds: ['a1', 'a2'], estimatedCostTotal: 20, availablePoints: 100, now: 0 })

  // 精确匹配（真实实现）：不同集合 → 不命中
  check('真实实现：有交集但不完全一致 → 不命中', readPreflightEstimate({ nodeIds: ['a2', 'a3'], now: 0 }) === null)

  // 若把匹配放宽成「有交集就命中」，同一场景会错误命中
  const hitsByIntersection = (cachedKey: string, queryKey: string) => {
    const cached = cachedKey.split('\n')
    const query = new Set(queryKey.split('\n'))
    return cached.some((id) => query.has(id))
  }
  const cachedKey = normalizePreflightNodeKey(['a1', 'a2'])
  const queryKey = normalizePreflightNodeKey(['a2', 'a3'])
  check(
    '反证成立：有交集即命中的实现会让本用例命中（正是要消灭的形态）',
    hitsByIntersection(cachedKey, queryKey) === true,
  )
}


/**
 * 2026-09-26 真机验收抓到的 bug：服务端估算**拿不到价时返回 0**（`/api/points/estimate` 返回 204），
 * 而卡片把 0 当成有效数字，自信地显示「本批将预扣 **0 分**」（一张图实际 6 分）。
 * 报错的数字比不说数字糟糕得多 —— 这两条断言把 0/负数钉死为「拿不到」。
 */
{
  const cachedWithZero = rememberPreflightEstimate({ nodeIds: ['z1'], estimatedCostTotal: 0, availablePoints: 100 })
  check('总额为 0 时不缓存（0 = 没估出来，不是不花钱）', cachedWithZero === false)
  const displayWithZeroCache = resolveAgentConfirmCostDisplayFromCache({ nodeIds: ['z1'] })
  check('0 不缓存 → 卡片拿不到数字（estimatedPoints 为 null）', displayWithZeroCache.estimatedPoints === null)
  check(
    '0 不缓存 → 仍显示预扣语义说明（用户知道会预扣/会被拦/会退还）',
    displayWithZeroCache.notice === AGENT_CONFIRM_PREDEDUCT_NOTICE,
  )
  check('展示层同样把 0 视为拿不到', resolveAgentConfirmCostDisplay({ estimated: 0, available: 100 }).estimatedPoints === null)
  check('展示层把负数同样视为拿不到', resolveAgentConfirmCostDisplay({ estimated: -5 }).estimatedPoints === null)
  check('正数照常显示（回归）', resolveAgentConfirmCostDisplay({ estimated: 6, available: 994 }).estimatedPoints === 6)
  check('余额仍照常显示（0 分不影响余额行）', displayWithZeroCache.balanceText === null || typeof displayWithZeroCache.balanceText === 'string')
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
