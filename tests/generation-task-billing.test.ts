/**
 * 生成任务「扣费一致性」单测（2026-09-25）。
 *
 * 用假 context 驱动真实的 startGenerationTask，把几条容易出错的边界钉死：
 *   1. 扣费已提交、建单却失败 → **必须原路退款**（否则分数白扣、任务不存在）；
 *   2. 视频任务的流水 endpointType 必须是 video（之前写死 image，后台按视频筛不出来）；
 *   3. 余额不足（INSUFFICIENT_POINTS）要映射成 402，而不是 500；
 *   4. 定价不可用（未配价/未标定/匹配失败）→ **在扣费之前**拒绝并映射 400，积分一分不扣。
 *
 * 跑法：npx tsx tests/generation-task-billing.test.ts
 */

import { startGenerationTask, type TaskLifecycleContext } from '../server/generation-tasks/task-lifecycle-service'
import { resolveGenerationTaskStrategy } from '../server/generation-tasks/strategy'
import { GenerationTaskRequestError, resolveGenerationTaskErrorStatus } from '../server/generation-tasks/shared'
import type { GenerationTaskStartPayload } from '../server/generation-tasks/shared'
import { ModelPricingRefusedError } from '../src/shared/model-pricing-rules'

let passed = 0
let failed = 0

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message)
}

const check = (name: string, fn: () => void) => {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

interface ConsumeCall {
  associationNo: string
  pointCost: number
  endpointType: string
  metaJson: Record<string, unknown>
}

interface RefundCall {
  associationNo: string
  pointCost: number
  endpointType: string
  metaJson: Record<string, unknown>
}

const buildHarness = (options: {
  createRecordError?: Error
  consumeError?: Error
  imageCost?: number
  videoCost?: number
  /** 模拟「定价不可用」：解析器返回 refuse，建单路径应在扣费前拒绝 */
  refuse?: boolean
  refuseReason?: string
}) => {
  const consumeCalls: ConsumeCall[] = []
  const refundCalls: RefundCall[] = []
  const startedTasks: Array<Record<string, unknown>> = []
  let associationSeq = 0

  const context = {
    resolveGenerationTaskStrategy,
    buildTaskSubmissionIdempotencyKey: () => 'idem-key',
    claimIdempotencyKey: async () => ({
      state: 'acquired' as const,
      token: 'token-1',
    }),
    completeIdempotencyKey: async () => {},
    clearPendingIdempotencyKey: async () => {},
    getGenerationRecordById: async () => ({ id: 'record-1' }),
    createGenerationRecord: async () => {
      if (options.createRecordError) throw options.createRecordError
      return { id: 'record-1' }
    },
    updateGenerationRecord: async () => ({}),
    attachGenerationPointRecordId: async () => null,
    resolveGenerationPointCost: async () => ({
      pointCost: 3,
      modelName: 'chat-model',
    }),
    resolveModelPricingCost: async (input: { endpointType: 'image' | 'video' }) => ({
      pointCost: options.refuse ? 0 : (input.endpointType === 'video' ? (options.videoCost ?? 60) : (options.imageCost ?? 6)),
      usingDraft: false,
      refuse: Boolean(options.refuse),
      refuseReason: options.refuseReason,
      detail: options.refuse ? '该模型未配置定价，暂时无法生成。请联系运营为该模型补录定价后重试。' : '',
      modelName: 'priced-model',
    }),
    consumeGenerationPoints: async (input: any) => {
      if (options.consumeError) throw options.consumeError
      consumeCalls.push({
        associationNo: input.associationNo,
        pointCost: input.pointCost,
        endpointType: input.endpointType,
        metaJson: input.metaJson,
      })
      return { id: 'point-log-1' }
    },
    refundGenerationPoints: async (input: any) => {
      refundCalls.push({
        associationNo: input.associationNo,
        pointCost: input.pointCost,
        endpointType: input.endpointType,
        metaJson: input.metaJson,
      })
      return { id: 'refund-log-1' }
    },
    acquireTaskConcurrencySlots: async () => [],
    releaseTaskConcurrencySlots: async () => {},
    buildAgentPendingRun: () => ({}),
    buildGatewayAssociationNo: () => `ASSOC${(associationSeq += 1)}`,
    setLocalRunningTask: (task: Record<string, unknown>) => {
      startedTasks.push(task)
    },
    syncSharedTaskRuntime: async () => {},
    emitTaskStreamEvent: () => {},
    logGenerationTask: () => {},
    runTaskInBackground: () => {},
    resolveTaskRecordSnapshot: async () => null,
    getLocalRunningTask: () => undefined,
    getSharedTaskRuntime: async () => null,
    markSharedTaskAbortRequested: async () => {},
    abortTaskWithReason: () => {},
  } as unknown as TaskLifecycleContext

  return { context, consumeCalls, refundCalls, startedTasks }
}

const imagePayload = (): GenerationTaskStartPayload => ({
  type: 'image',
  prompt: 'test',
  modelKey: 'gpt-image-2',
  requestBody: { providerId: 'p-sceneflow-ggk', size: '1024x1024', count: 1 },
})

const videoPayload = (): GenerationTaskStartPayload => ({
  type: 'video',
  prompt: 'test',
  modelKey: 'seedance2.5',
  requestBody: { providerId: 'p-sceneflow-genvideo-2-5', seconds: 5 },
})

console.log('== A. 扣费与建单不在同一事务 → 建单失败必须退款 ==')

// A/B 两组需要 await startGenerationTask，统一放到下面的异步段执行。
const asyncChecks: Array<{ name: string; run: () => Promise<void> }> = []

asyncChecks.push({
  name: '图片任务建单失败 → 按原单号/金额/端点退款（积分没有被白扣）',
  run: async () => {
    const harness = buildHarness({
      createRecordError: new Error('模拟建单失败'),
    })
    let thrown = false
    try {
      await startGenerationTask(imagePayload(), 'user-1', harness.context)
    } catch {
      thrown = true
    }
    assert(thrown, '建单失败应把异常抛给调用方')
    assert(harness.consumeCalls.length === 1, `应扣费 1 次，实际 ${harness.consumeCalls.length}`)
    assert(harness.refundCalls.length === 1, `应退款 1 次，实际 ${harness.refundCalls.length}`)
    const consumed = harness.consumeCalls[0]
    const refunded = harness.refundCalls[0]
    assert(refunded.associationNo === consumed.associationNo, '退款应使用与扣费相同的单号')
    assert(refunded.pointCost === consumed.pointCost && refunded.pointCost === 6, '退款金额应与扣费一致（6 分）')
    assert(refunded.endpointType === 'image', '退款端点应为 image')
    assert(refunded.metaJson.refundReason === 'task_create_failed', '退款应标注原因 task_create_failed')
    const net = refunded.pointCost - consumed.pointCost
    assert(net === 0, `净变化应为 0（未被白扣），实际 ${net}`)
  },
})

asyncChecks.push({
  name: '建单成功 → 不产生退款，任务被交接给后台执行',
  run: async () => {
    const harness = buildHarness({})
    const record = await startGenerationTask(imagePayload(), 'user-1', harness.context)
    assert(record.id === 'record-1', '应返回建好的记录')
    assert(harness.refundCalls.length === 0, '成功路径不应退款')
    assert(harness.startedTasks.length === 1, '任务应被提交后台执行')
  },
})

asyncChecks.push({
  name: '对话任务建单失败 → 同样退款（chat 端点）',
  run: async () => {
    const harness = buildHarness({
      createRecordError: new Error('模拟建单失败'),
    })
    const payload: GenerationTaskStartPayload = {
      type: 'agent',
      prompt: 'hi',
      modelKey: 'chat-model',
      skill: 'general',
      requestBody: { providerId: 'p-x' },
    }
    try {
      await startGenerationTask(payload, 'user-1', harness.context)
      throw new Error('应当抛错')
    } catch {
      // 忽略预期异常
    }
    assert(harness.refundCalls.length === 1, 'chat 分支建单失败也应退款')
    assert(harness.refundCalls[0].endpointType === 'chat', '退款端点应为 chat')
  },
})

console.log('== B. 视频流水不能被记成 image ==')

asyncChecks.push({
  name: '视频任务落流水：endpointType=video（备注/筛选随之正确）',
  run: async () => {
    const harness = buildHarness({})
    await startGenerationTask(videoPayload(), 'user-1', harness.context)
    assert(harness.consumeCalls.length === 1, '应扣费 1 次')
    assert(
      harness.consumeCalls[0].endpointType === 'video',
      `视频扣费 endpointType 应为 video，实际 ${harness.consumeCalls[0].endpointType}`,
    )
    assert(harness.consumeCalls[0].pointCost === 60, '视频应扣 60 分')
    assert(
      harness.startedTasks[0].billedEndpointType === 'video',
      '任务的 billedEndpointType 应为 video（失败退款也随之正确）',
    )
  },
})

asyncChecks.push({
  name: '图片任务落流水仍为 endpointType=image（未被误改）',
  run: async () => {
    const harness = buildHarness({})
    await startGenerationTask(imagePayload(), 'user-1', harness.context)
    assert(harness.consumeCalls[0].endpointType === 'image', '图片扣费 endpointType 应为 image')
    assert(harness.startedTasks[0].billedEndpointType === 'image', '任务 billedEndpointType 应为 image')
  },
})

console.log('== C. 余额不足 → 402（不是 500）==')

check('INSUFFICIENT_POINTS 映射为 402', () => {
  const error: any = new Error('积分不足，当前剩余 0，需要 6')
  error.code = 'INSUFFICIENT_POINTS'
  assert(resolveGenerationTaskErrorStatus(error) === 402, '应返回 402')
})

check('GenerationTaskRequestError 保留自身状态码', () => {
  assert(resolveGenerationTaskErrorStatus(new GenerationTaskRequestError(409, 'busy')) === 409, '应返回 409')
  assert(resolveGenerationTaskErrorStatus(new GenerationTaskRequestError(400, 'bad')) === 400, '应返回 400')
})

check('普通异常仍是 500（不把服务器错误伪装成 402）', () => {
  assert(resolveGenerationTaskErrorStatus(new Error('boom')) === 500, '应返回 500')
})

asyncChecks.push({
  name: '扣费阶段余额不足 → 不退款（没有成功扣费）且异常上抛',
  run: async () => {
    const error: any = new Error('积分不足，当前剩余 0，需要 6')
    error.code = 'INSUFFICIENT_POINTS'
    const harness = buildHarness({ consumeError: error })
    try {
      await startGenerationTask(imagePayload(), 'user-1', harness.context)
      throw new Error('应当抛错')
    } catch (thrown: any) {
      assert(thrown?.code === 'INSUFFICIENT_POINTS', '应原样上抛余额不足错误')
      assert(resolveGenerationTaskErrorStatus(thrown) === 402, '接口层应转成 402')
    }
    assert(harness.refundCalls.length === 0, '没有成功扣费就不该退款（避免凭空加积分）')
  },
})

console.log('== D. 定价不可用 → 在扣费之前拒绝（4xx，积分不被扣）==')

asyncChecks.push({
  name: '未配价模型建图任务 → 抛 ModelPricingRefusedError，完全没有扣费/退款/执行',
  run: async () => {
    const harness = buildHarness({ refuse: true, refuseReason: 'pricing_model_not_configured' })
    let thrown: any = null
    try {
      await startGenerationTask(imagePayload(), 'user-1', harness.context)
    } catch (error) {
      thrown = error
    }
    assert(thrown instanceof ModelPricingRefusedError, `应抛 ModelPricingRefusedError，实际 ${thrown}`)
    assert(thrown.reason === 'pricing_model_not_configured', '拒绝原因应为未配价')
    assert(resolveGenerationTaskErrorStatus(thrown) === 400, '接口层应转成 400')
    assert(harness.consumeCalls.length === 0, '拒绝必须发生在扣费之前（不能扣了再退）')
    assert(harness.refundCalls.length === 0, '没有扣费就不该有退款')
    assert(harness.startedTasks.length === 0, '被拒绝的任务不应进入后台执行')
  },
})

asyncChecks.push({
  name: '未配价模型建视频任务 → 同样拒绝（不是只挡图片）',
  run: async () => {
    const harness = buildHarness({ refuse: true, refuseReason: 'pricing_model_not_configured' })
    let thrown: any = null
    try {
      await startGenerationTask(videoPayload(), 'user-1', harness.context)
    } catch (error) {
      thrown = error
    }
    assert(thrown instanceof ModelPricingRefusedError, '视频同样应被拒绝')
    assert(harness.consumeCalls.length === 0, '视频拒绝也不得扣费')
  },
})

asyncChecks.push({
  name: '已配价模型建单 → 正常扣费 6 分（拒绝逻辑没误伤正常路径）',
  run: async () => {
    const harness = buildHarness({})
    const record = await startGenerationTask(imagePayload(), 'user-1', harness.context)
    assert(record.id === 'record-1', '应正常返回记录')
    assert(harness.consumeCalls.length === 1 && harness.consumeCalls[0].pointCost === 6, '应按定价扣 6 分')
  },
})

check('ModelPricingRefusedError 映射为 400（不是 500）', () => {
  const error = new ModelPricingRefusedError('pricing_model_not_configured', '未配置定价')
  assert(resolveGenerationTaskErrorStatus(error) === 400, '应返回 400')
})

const main = async () => {
  for (const item of asyncChecks) {
    try {
      await item.run()
      passed += 1
      console.log(`  ok   ${item.name}`)
    } catch (error) {
      failed += 1
      console.error(`  FAIL ${item.name} — ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  console.log(`\n通过 ${passed}，失败 ${failed}`)
  if (failed > 0) process.exit(1)
}

void main()
