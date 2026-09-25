/**
 * 制片 Agent 的「思考预算」策略（2026-09-26）
 *
 * 要解决的问题（实测）：画布 Agent 连「只回复一个数字」这类请求也要 15~31 秒。
 * 根因是**思考预算一刀切**：Pi 的 Agent 默认 `thinkingLevel: "off"` 之外的档位从没被设置过
 * （全仓库此前 0 命中 thinkingLevel / thinkingBudgets），模型对闲聊与成片用同一套思考时长。
 *
 * Pi 原生支持这件事：`initialState.thinkingLevel` 按轮定档，运行中还能改
 * `agent.state.thinkingLevel`（同一轮里升档），`thinkingBudgets` 给按 token 计费的 provider。
 * 这个文件只负责第一件、也是唯一需要判断力的事：**按本轮用户输入判「这轮该想多少」**。
 *
 * 判据刻意写成纯函数而不是提示词：提示词是建议，模型会被带偏；开关必须由代码定。
 * 判据也刻意只依赖「句子形状」（疑问 / 委托 / 成片名词 / 小活动词），不引入模型调用 ——
 * 分类本身要是磨蹭的，就等于没省。
 *
 * 档位（Pi ThinkingLevel 的子集，只用三档，越高越慢）：
 *   · minimal —— 寒暄 / 自我介绍 / 能力询问等纯闲聊：最快出字；
 *   · low     —— 默认档：问答、看图、小活（改一张图、加个节点）：够用且不磨蹭；
 *   · medium  —— 成片生产（剧本 → 分镜 → 母版 → 分镜图 / 视频）：要真的想，质量优先。
 * 刻意不设 high/xhigh/max：成片生产用 medium 已足够，档位越高越慢，与「对着磨蹭」相悖。
 */

import {
  applyCapabilityFlags,
  parseModelCapabilitySpec,
} from "../../src/shared/provider-capability";

/** 依次递增的档位序。升档只能沿这个方向走（见 escalateCanvasAgentThinkingLevel），不允许来回抖动。 */
export const CANVAS_AGENT_THINKING_LEVELS = ["minimal", "low", "medium"] as const

/** 本策略可用的档位（是 Pi ThinkingLevel 的子集）。 */
export type CanvasAgentThinkingLevel = (typeof CANVAS_AGENT_THINKING_LEVELS)[number]

/** 纯闲聊 / 寒暄 / 能力询问：最快档。 */
export const CANVAS_AGENT_THINKING_LEVEL_CHITCHAT: CanvasAgentThinkingLevel = "minimal"

/** 默认档：问答与小活（改一张图、加个节点）。 */
export const CANVAS_AGENT_THINKING_LEVEL_DEFAULT: CanvasAgentThinkingLevel = "low"

/** 成片生产：唯一允许「认真想」的档。 */
export const CANVAS_AGENT_THINKING_LEVEL_PRODUCTION: CanvasAgentThinkingLevel = "medium"

/**
 * 意图 → 档位。刻意集中成一张表：调档位时改这里一处，不用在分类逻辑里找散落的魔法值。
 */
export const CANVAS_AGENT_THINKING_LEVEL_BY_INTENT: Record<CanvasAgentThinkingIntent, CanvasAgentThinkingLevel> = {
  chitchat: CANVAS_AGENT_THINKING_LEVEL_CHITCHAT,
  qa: CANVAS_AGENT_THINKING_LEVEL_DEFAULT,
  small_op: CANVAS_AGENT_THINKING_LEVEL_DEFAULT,
  production: CANVAS_AGENT_THINKING_LEVEL_PRODUCTION,
}

/**
 * 按 token 计费的 provider 用的思考预算（透传给 Pi 的 `thinkingBudgets`，单位 token）。
 * 与 Pi README 的默认值一致。
 *
 * **诚实说明**：当前上游是 OpenAI 兼容的 chat 接口，我们把档位映射成了**厂商能力声明里**
 * 配置的字段（见 resolveCanvasAgentReasoningFields，通常是 `reasoning_effort`），
 * 并没有映射成 token 预算字段（vLLM 的 `thinking_token_budget`、Qwen 的 `thinking_budget` 等
 * 名字各不相同、不能瞎猜）。所以这份预算对当前网关**暂不生效**，保留它是为了：
 *   ① 不丢 Pi 的原生语义；② 将来接 token 预算型上游时不用改代码。
 */
export const CANVAS_AGENT_THINKING_BUDGETS = {
  minimal: 128,
  low: 512,
  medium: 1024,
  high: 2048,
} as const

/** 本轮的意图分类（比档位更细，便于日志与测试；档位只是它的映射）。 */
export type CanvasAgentThinkingIntent = "chitchat" | "qa" | "small_op" | "production"

/**
 * 寒暄 / 礼貌语：整句只有这些才算闲聊（锚定 `^...$`，避免「你好，帮我做个广告」被误判成闲聊）。
 */
export const CANVAS_AGENT_CHITCHAT_PATTERN =
  /^(你好|您好|哈喽|哈罗|嗨|hi|hello|hey|在吗|在么|早上好|中午好|下午好|晚上好|晚安|谢谢|多谢|感谢|辛苦了|好的|好嘞|嗯+|ok|好吧|收到|明白)[!！。~～,，、\s]*$/i

/**
 * 「关于你 / 怎么用」类询问：也当闲聊走最快档。
 * 这类问题的答案在 system 提示里现成，不需要模型花思考预算去推。
 */
export const CANVAS_AGENT_ABOUT_PATTERN =
  /(你能做什么|你会做什么|你能干什么|你能干嘛|你会什么|有什么功能|有哪些功能|你是谁|介绍一下你|你能帮我做什么|怎么用|怎么使用|使用说明)/

/**
 * 「极短输入」上限：不超过这个字符数、且不含任何动作词 → 当闲聊处理（「你好」「谢谢」「在吗」）。
 * 6 字是刻意取的：覆盖常见寒暄，又短到不可能是一句成片委托。
 */
export const CANVAS_AGENT_CHITCHAT_MAX_CHARS = 6

/**
 * 疑问句判据。
 *
 * 为什么它排在「成片意图」之前生效：**问过去做过的东西**不是委托。
 * 反例：「你刚才做的那条广告片是什么风格？」含成片名词「广告片」，但它是问句、要的是回答，
 * 判成 medium 就白花思考预算（正是这个反例钉死了「只按关键词匹配」的做法）。
 */
export const CANVAS_AGENT_QUESTION_PATTERN =
  /[？?]|什么|为什么|怎么|怎样|如何|吗|呢|哪|几个|多少|是不是|能否|可不可以|可以吗|有没有|是什么|谁/

/**
 * 成片类名词：出现即倾向成片意图（仍会被疑问句 / 小活动词拦下）。
 * 这些词天然指向「从剧本到成片」的多步链路（分镜 / 母版 / 剧本 / 整条片子）。
 */
export const CANVAS_AGENT_PRODUCTION_NOUN_PATTERN =
  /(成片|短片|广告片|宣传片|漫剧|分镜|母版|剧本|故事板|TVC|整条片|一整条片|一条片|一支片|一条视频|一支视频)/

/**
 * 泛生产名词：「视频 / 广告」单说可能只是问或改（「把视频节点改一下」），
 * 必须配一个**委托动词**才升级成成片意图。
 */
export const CANVAS_AGENT_GENERIC_PRODUCTION_NOUN_PATTERN = /(视频|广告|影片|片子)/

/** 委托动词：用户在「让我做一件完整的事」，而不是在提问或改一个点。 */
export const CANVAS_AGENT_COMMISSION_VERB_PATTERN =
  /(帮我|给我|替我|制作|生成|做一个|做个|做一|做支|做条|剪一|剪条|剪个|拍一|拍条|来一版|来一个|整一个|出一版|设计一|写一个|写个|做一段)/

/**
 * 小活动词：明确指向「改一处 / 加一个 / 重跑一个」的局部操作。
 * 命中它就把意图压到 small_op（低档），即使句子里同时含成片名词 —— 「把分镜图重新生成一下」
 * 是改一个点，不该套整条成片链路的思考预算。
 */
export const CANVAS_AGENT_SMALL_OP_PATTERN =
  /(改一下|改改|修改|调整一下|调整|换一个|换个|重做这|这个节点|这张图|这一张|加个|加一个节点|删掉|删除|重命名|挪一下|移动一下|连一下|连上|出一张图|生成一张图|重新生成|重跑|再生成一张|单独来一张)/

/** 分类里去重用的「声明式」判据：出现任一即视为「在指挥 Agent 做事」。 */
const looksLikeCommand = (text: string): boolean =>
  CANVAS_AGENT_COMMISSION_VERB_PATTERN.test(text) || CANVAS_AGENT_SMALL_OP_PATTERN.test(text)

/**
 * 判本轮的意图类型（纯函数，可单测）。
 *
 * 判定顺序是有意的，每一步都在挡一类误判：
 *   1. 空输入 → qa（默认低档）：空句子没有可做的活；
 *   2. 寒暄 / 关于你 → chitchat：最快档，别让「你好」也思考；
 *   3. 疑问句 → qa：问句要的是回答，不是委托（挡住「你刚才做的广告片是什么风格？」）；
 *   4. 小活动词 → small_op：改一个点不该套成片链路（挡住「把分镜图重新生成一下」）；
 *   5. 成片名词，或泛生产名词 + 委托动词 → production：唯一认真想的档；
 *   6. 其余（一般问答、看图、闲聊式短句）→ qa：默认低档。
 */
export const classifyCanvasAgentThinkingIntent = (prompt: string): CanvasAgentThinkingIntent => {
  const text = String(prompt || "").trim()
  if (!text) return "qa"
  if (CANVAS_AGENT_CHITCHAT_PATTERN.test(text) || CANVAS_AGENT_ABOUT_PATTERN.test(text)) {
    return "chitchat"
  }
  if (CANVAS_AGENT_QUESTION_PATTERN.test(text)) return "qa"
  if (CANVAS_AGENT_SMALL_OP_PATTERN.test(text)) return "small_op"
  if (CANVAS_AGENT_PRODUCTION_NOUN_PATTERN.test(text)) return "production"
  if (
    CANVAS_AGENT_GENERIC_PRODUCTION_NOUN_PATTERN.test(text)
    && CANVAS_AGENT_COMMISSION_VERB_PATTERN.test(text)
  ) {
    return "production"
  }
  // 极短且没有任何动作词 → 当闲聊，避免「嗯」「在？」这类碎片也走默认档
  if (text.length <= CANVAS_AGENT_CHITCHAT_MAX_CHARS && !looksLikeCommand(text)) return "chitchat"
  return "qa"
}

/** 意图 → 档位。 */
export const resolveCanvasAgentThinkingLevel = (prompt: string): CanvasAgentThinkingLevel =>
  CANVAS_AGENT_THINKING_LEVEL_BY_INTENT[classifyCanvasAgentThinkingIntent(prompt)]

/**
 * 运行中升档：本轮一旦出现工具调用，说明模型真的决定动手了 —— 这不再是闲聊。
 *
 * 只升**一档**（minimal → low、low → medium），且已到 medium 就封顶：
 * 反复升档会让同一轮里思考开销来回抖，与省时间的目标相悖（Pi 支持中途改，但改得多不等于改得对）。
 * 返回的是「升档后该停在哪个档」；调用方只需在首次工具调用时应用一次，之后不必再调。
 */
export const escalateCanvasAgentThinkingLevel = (
  level: CanvasAgentThinkingLevel,
  hasToolCall: boolean,
): CanvasAgentThinkingLevel => {
  if (!hasToolCall) return level
  const index = CANVAS_AGENT_THINKING_LEVELS.indexOf(level)
  if (index < 0) return level
  const next = Math.min(index + 1, CANVAS_AGENT_THINKING_LEVELS.length - 1)
  return CANVAS_AGENT_THINKING_LEVELS[next]
}

/**
 * 传给 Pi `sessionId` 的键（用于 **provider 缓存**）。
 *
 * 键必须是 **会话 id + 画布 id**：助手会话在浏览器里是全局的（不随画布切换），只用会话 id
 * 会让 A 画布与 B 画布的请求命中同一份前缀缓存（与 canvas-agent-session.ts 恢复转录同一套键法）。
 * 画布 id 拿不到时退回会话 id（宁可少一点缓存命中，也不串台）。
 */
export const buildCanvasAgentProviderSessionId = (
  sessionId: string,
  canvasId: string,
): string => {
  const session = String(sessionId || "").trim()
  const canvas = String(canvasId || "").trim()
  if (!session) return canvas
  if (!canvas) return session
  return `${session}:${canvas}`
}

/**
 * 每个意图档位优先匹配的能力声明档位 key。
 *
 * 为什么要有偏好序而不是要求 key 完全同名：后台的「模型能力声明」里档位 key 由运营配置，
 * 有的写 low/medium/high、有的写 standard/extended。**没有完全同名档位就不能干脆不注入** ——
 * 那等于把「闲聊也走模型默认（往往在长思考）」这个最该省的地方放走了。
 * 所以这里按语义就近挑：minimal/low 尽量落到最省的一档，medium 尽量落到最强的一档。
 */
export const CANVAS_AGENT_REASONING_OPTION_PREFERENCES: Record<CanvasAgentThinkingLevel, string[]> = {
  minimal: ["minimal", "off", "none", "low"],
  low: ["low", "minimal", "medium", "off"],
  medium: ["medium", "high", "xhigh", "max", "low"],
}

/**
 * 把「意图档位」翻译成要写进上游请求体的思考字段。
 *
 * 为什么不直接发 `reasoning_effort`：不同上游认的字段与方法不同（OpenAI 用 reasoning_effort，
 * 另一些用 thinking / enable_thinking / 嵌套对象）。这些差异**已经由后台的「模型能力声明」**
 * （AiModel.capabilityJson 的 reasoning.options）逐档配置好了，这里直接复用那份配置，
 * 而不是自己发明一套字段 —— 发明出来的字段打给不认识它的上游就是 400。
 *
 * 返回 `{ 档位: 上游字段 }`：模型**声明了 reasoning 能力**时，每个档位都会就近落到一个已配置的
 * 档位上（偏好序见 CANVAS_AGENT_REASONING_OPTION_PREFERENCES）；模型完全没声明 reasoning
 * 能力时返回 `{}`，此时本改动对它不改变任何行为（不会误发字段、也不会报错）。
 *
 * 这一条是真机验收要看的第一件事：**目标模型的能力声明里必须配了 reasoning 档位**，
 * 否则省时效果落不到它身上（见报告里的验证点）。
 */
export const resolveCanvasAgentReasoningFields = (
  capabilityJson: unknown,
): Record<string, Record<string, unknown>> => {
  const spec = parseModelCapabilitySpec(capabilityJson)
  const options = spec?.reasoning?.supported && Array.isArray(spec.reasoning.options)
    ? spec.reasoning.options
    : []
  if (options.length === 0) return {}

  const optionKeys = options.map((option) => String(option?.key || ""))
  // 用 string 索引（而不是档位联合）是为了能原样传给网关的记录类型；键仍然只会有档位那几个。
  const fields: Record<string, Record<string, unknown>> = {}

  for (const level of CANVAS_AGENT_THINKING_LEVELS) {
    const preferred = CANVAS_AGENT_REASONING_OPTION_PREFERENCES[level]
      .find((key) => optionKeys.includes(key))
    // 没有可识别的 key：minimal/low 落到声明里的第一档（最省），medium 落到最后一档（最强）
    const fallback = level === "medium" ? optionKeys[optionKeys.length - 1] : optionKeys[0]
    const chosenKey = preferred || fallback
    if (!chosenKey) continue

    // 用命中的 key 走通用注入算子：字段名/形状完全由能力声明决定，这里不发明字段，
    // 也不会因为 key 不匹配触发 disabledInjection 这类副作用（key 必来自 options）。
    const applied = applyCapabilityFlags({ reasoning: chosenKey }, spec)
    if (Object.keys(applied.upstreamFields).length > 0) {
      fields[level] = applied.upstreamFields
    }
  }
  return fields
}
