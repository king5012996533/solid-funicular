/**
 * 批量生图前的预校验（M3 风险③ 第一步）
 *
 * 只回答一个问题：**这批节点能不能跑**。不回答「图对不对」—— 那是风险②（多模态读图）的事。
 *
 * 为什么必须做成「可插拔校验器」而不是一堆写死的 if：
 * ③ 的预校验是纯参数判断（提示词、参考图可达性、API 参数、继承链、配额），零多模态；
 * ② 的母版图校验要「看图判崩坏/黑图/主体缺失」，依赖多模态基建。两件事的**触发时机相同**
 * （都在批量执行前），只是判据不同。所以这里定义一个 `CanvasPipelineValidator` 接口：
 * ③ 内置的是参数类校验器，② 上线时新增一个 `requiresVision: true` 的实现挂进同一个注册表即可，
 * **流程代码一行都不用改** —— 这正是「别在③里开洞」的落点。
 *
 * 另一个刻意约束：校验器本身是**纯函数**（不读文件、不发请求、不连库）。
 * 需要外部数据（参考图能不能访问、用户有多少积分）由调用方先探好、经由 context 传进来。
 * 这样校验逻辑可以被单测完整覆盖，而 IO 留在调用方那一层。
 */

export type CanvasValidationLevel = 'error' | 'warn'

export interface CanvasValidationFinding {
  level: CanvasValidationLevel
  /** 稳定标识（测试与前端按它分类，不依赖文案） */
  code: string
  /** 给人看的话 */
  message: string
  /** 怎么修（模型据此改参数/补节点） */
  hint?: string
  nodeId?: string
}

/** 校验器看到的节点视图：只包含判断「能不能跑」需要的字段 */
export interface CanvasValidationNode {
  id: string
  type: string
  label?: string
  prompt?: string
  content?: string
  model?: string
  size?: string
  quality?: string
  referenceImages?: string[]
  /** 已生成出来的图（母版是否出图，靠它判断） */
  imageUrl?: string
  status?: string
}

export interface CanvasValidationEdge {
  source: string
  target: string
}

/** 调用方探好的外部事实（校验器不自己发请求） */
export interface CanvasValidationContext {
  /** 参考图可达性：url → 是否可访问 */
  referenceReachability?: Record<string, boolean>
  /** 用户可用积分（拿不到就不做配额判断，别假装知道） */
  availablePoints?: number
  /** 单张（条）生成的预估积分 */
  estimatedCostPerUnit?: number
  /** 一次批量执行的上限（与工具层保持一致） */
  maxBatchSize?: number
}

export interface CanvasPipelineValidator {
  key: string
  label: string
  /**
   * 这个校验器是否需要「看图」。
   *
   * 现在内置的全是 false（纯参数）。② 的母版图校验会注册一个 true 的实现：
   * 调度方据此决定要不要把图片字节取来 —— 这就是给②预留的扩展位。
   */
  requiresVision?: boolean
  validate: (node: CanvasValidationNode, context: CanvasValidationContext) => CanvasValidationFinding[]
}

export interface CanvasValidationReport {
  /** 有一处 error 就不能开跑（warn 不拦） */
  runnable: boolean
  checkedNodes: number
  findings: CanvasValidationFinding[]
  /** 有 error 的节点（据此只重跑没问题的那些，而不是整批重来） */
  blockedNodeIds: string[]
  /** 参与本次校验的校验器（便于日志里说清「这批是怎么判的」） */
  validators: string[]
}

/** 提示词长度上限：够写一段完整镜头描述，又不至于把上游冲爆 */
const PROMPT_MAX_LENGTH = 4000
const PROMPT_MIN_LENGTH = 2

const error = (code: string, message: string, hint: string, nodeId?: string): CanvasValidationFinding => ({
  level: 'error', code, message, hint, nodeId,
})
const warn = (code: string, message: string, hint: string, nodeId?: string): CanvasValidationFinding => ({
  level: 'warn', code, message, hint, nodeId,
})

/** 1) 提示词：非空、长度、非法标记 */
export const promptValidator: CanvasPipelineValidator = {
  key: 'prompt',
  label: '提示词',
  validate(node) {
    const findings: CanvasValidationFinding[] = []
    const isVisual = node.type === 'image' || node.type === 'video'
    const text = String((isVisual ? node.prompt : node.content) || '').trim()

    if (node.type === 'text' || node.type === 'asset') {
      if (!text) findings.push(error('prompt.empty_text', '文本节点内容为空', '先写好内容，或在批量执行时把它排除掉', node.id))
      return findings
    }
    if (!isVisual) return findings

    if (!text) {
      findings.push(error('prompt.empty', `${node.type === 'image' ? '图片' : '视频'}节点没有提示词`, '补上提示词再执行；空提示词会白白消耗一次生成', node.id))
      return findings
    }
    if (text.length < PROMPT_MIN_LENGTH) {
      findings.push(error('prompt.too_short', '提示词太短，几乎一定会得到无关结果', '写清画面主体、景别与风格', node.id))
    }
    if (text.length > PROMPT_MAX_LENGTH) {
      findings.push(error('prompt.too_long', `提示词超长（${text.length} 字，上限 ${PROMPT_MAX_LENGTH}）`, '拆成母版 + 镜头两级描述，别把整段剧本塞进一条提示词', node.id))
    }
    // 未替换的模板标记：说明上游提示词是拼接出来的但漏了填充，跑出来一定不对
    const placeholder = text.match(/\{\{[^}]{0,40}\}\}|\$\{[^}]{0,40}\}/)
    if (placeholder) {
      findings.push(error('prompt.unresolved_placeholder', `提示词里有没被替换的占位符：${placeholder[0]}`, '先把占位符填上真实内容', node.id))
    }
    if (/<script|javascript:/i.test(text)) {
      findings.push(warn('prompt.suspicious_markup', '提示词里含可疑标记（script/javascript:）', '确认这不是误粘贴进来的内容', node.id))
    }
    return findings
  },
}

/** 2) API 参数：模型与画幅/画质得是画布认识的取值 */
export const apiParamsValidator = (options: { knownModels?: string[]; knownSizes?: string[]; knownQualities?: string[] } = {}): CanvasPipelineValidator => ({
  key: 'api_params',
  label: 'API 参数',
  validate(node) {
    if (node.type !== 'image' && node.type !== 'video') return []
    const findings: CanvasValidationFinding[] = []
    if (!node.model) {
      findings.push(warn('params.model_missing', '没有指定模型，将使用画布默认模型', '若这一批要用特定模型（例如统一用便宜通道试跑），请显式指定', node.id))
    } else if (options.knownModels?.length && !options.knownModels.includes(node.model)) {
      findings.push(error('params.model_unknown', `模型不在可用列表里：${node.model}`, '从画布模型的 key 或名称里选一个', node.id))
    }
    if (node.size && options.knownSizes?.length && !options.knownSizes.includes(node.size)) {
      findings.push(error('params.size_unknown', `画幅不在该模型支持的取值里：${node.size}`, `可用画幅：${options.knownSizes.join('、')}`, node.id))
    }
    if (node.quality && options.knownQualities?.length && !options.knownQualities.includes(node.quality)) {
      findings.push(error('params.quality_unknown', `画质不在该模型支持的取值里：${node.quality}`, `可用画质：${options.knownQualities.join('、')}`, node.id))
    }
    return findings
  },
})

/**
 * 3) 继承链：分镜必须真的继承了母版。
 *
 * 这是「人物崩坏」在**参数层面**能提前抓到的信号：分镜挂着母版连线、但母版还没出图，
 * 或者压根没有挂参考图 —— 这两种情况跑出来的就是「每张脸都不一样」，而用户要为此付钱。
 */
export const inheritanceValidator: CanvasPipelineValidator = {
  key: 'inheritance',
  label: '继承链',
  validate(node, context) {
    if (node.type !== 'image') return []
    const incoming = (context as CanvasValidationContext & { incomingEdges?: CanvasValidationEdge[] }).incomingEdges || []
    const isShot = incoming.length > 0
    const hasRefs = Array.isArray(node.referenceImages) && node.referenceImages.length > 0

    if (!isShot) return []
    if (!hasRefs) {
      return [error('inheritance.no_reference', '这个分镜连了母版，但没有挂母版图作参考', '先让母版出图，再用 attach_reference_images 把母版图挂到这个节点上', node.id)]
    }
    return []
  },
}

/** 4) 参考图可达性：挂着的图必须真的能取到（母版图丢了/链接过期都会在这里暴露） */
export const referenceImageValidator: CanvasPipelineValidator = {
  key: 'reference_images',
  label: '参考图',
  validate(node, context) {
    const refs = Array.isArray(node.referenceImages) ? node.referenceImages : []
    if (!refs.length || !context.referenceReachability) return []
    const broken = refs.filter((url) => context.referenceReachability?.[url] === false)
    if (!broken.length) return []
    return [error(
      'reference.unreachable',
      `${broken.length} 张参考图取不到（母版图可能已丢失或链接过期）`,
      '重新生成母版并重新挂图，再执行这批分镜；带着失效参考图跑出来的人物会跑偏',
      node.id,
    )]
  },
}

/** 5) 配额：够不够跑完这一批（拿不到余额就跳过，不假装知道） */
export const quotaValidator: CanvasPipelineValidator = {
  key: 'quota',
  label: '配额',
  validate(_node, context) {
    const { availablePoints, estimatedCostPerUnit } = context
    if (typeof availablePoints !== 'number' || typeof estimatedCostPerUnit !== 'number') return []
    if (estimatedCostPerUnit <= 0) return []
    // 单节点视角看不出总数，真正的批量判断在 runCanvasPipelineValidation 里按整批算
    if (availablePoints < estimatedCostPerUnit) {
      return [error('quota.insufficient', '可用积分不足以完成一次生成', '先充值，或把这一批拆小一点', undefined)]
    }
    return []
  },
}

/** ③ 的默认校验器集合（全是纯参数校验，requiresVision 一律 false） */
export const DEFAULT_CANVAS_VALIDATORS: CanvasPipelineValidator[] = [
  promptValidator,
  apiParamsValidator(),
  inheritanceValidator,
  referenceImageValidator,
  quotaValidator,
]

/**
 * 跑一次预校验。
 *
 * @param targets 要校验的节点（一般是这一批准备执行的那些）
 * @param allNodes 画布上的全部节点（继承链判断需要看连线两端的节点）
 */
export const runCanvasPipelineValidation = (input: {
  targets: CanvasValidationNode[]
  allNodes: CanvasValidationNode[]
  edges: CanvasValidationEdge[]
  context: CanvasValidationContext
  validators?: CanvasPipelineValidator[]
}): CanvasValidationReport => {
  const { targets, allNodes, edges, context } = input
  const validators = input.validators?.length ? input.validators : DEFAULT_CANVAS_VALIDATORS
  const findings: CanvasValidationFinding[] = []

  const nodeById = new Map(allNodes.map((node) => [node.id, node]))

  // 整批的配额判断（单节点校验器看不到总数）
  const visualCount = targets.filter((node) => node.type === 'image' || node.type === 'video').length
  const { availablePoints, estimatedCostPerUnit } = context
  if (typeof availablePoints === 'number' && typeof estimatedCostPerUnit === 'number' && estimatedCostPerUnit > 0 && visualCount > 0) {
    const estimatedTotal = estimatedCostPerUnit * visualCount
    if (availablePoints < estimatedTotal) {
      findings.push(error(
        'quota.insufficient_for_batch',
        `可用积分 ${availablePoints}，这一批预计需要 ${estimatedTotal}（${visualCount} 个节点）`,
        '先充值，或减少这一批的节点数',
      ))
    }
  }

  if (typeof context.maxBatchSize === 'number' && targets.length > context.maxBatchSize) {
    findings.push(error('batch.too_large', `这一批 ${targets.length} 个节点，超过单次上限 ${context.maxBatchSize}`, `拆成每批不超过 ${context.maxBatchSize} 个`))
  }

  for (const node of targets) {
    // 继承链判断需要「谁的连线指向它」，在调用方那层组装好传进来
    const incoming = edges.filter((edge) => edge.target === node.id)
    const enrichedContext: CanvasValidationContext & { incomingEdges?: CanvasValidationEdge[] } = {
      ...context,
      incomingEdges: incoming,
    }
    // 母版没出图 → 分镜的参考图必然挂不上，这里直接点明，避免「跑了但人物崩」
    for (const edge of incoming) {
      const source = nodeById.get(edge.source)
      if (source && source.type === 'image' && !source.imageUrl && (node.referenceImages || []).some((url) => url.includes(source.id))) {
        findings.push(error('inheritance.master_not_generated', '挂的参考图来自一个还没出图的母版', '先让母版出图，再重挂参考图', node.id))
      }
    }
    for (const validator of validators) {
      findings.push(...validator.validate(node, enrichedContext))
    }
  }

  const blockedNodeIds = [...new Set(findings.filter((item) => item.level === 'error' && item.nodeId).map((item) => String(item.nodeId)))]
  const hasGlobalError = findings.some((item) => item.level === 'error' && !item.nodeId)

  return {
    runnable: !hasGlobalError && blockedNodeIds.length === 0,
    checkedNodes: targets.length,
    findings,
    blockedNodeIds,
    validators: validators.map((validator) => validator.key),
  }
}
