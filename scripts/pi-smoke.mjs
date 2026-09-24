/**
 * M1：Pi Agent + 我们的网关 + 工具调用 —— 独立冒烟脚本
 *
 * 目的：在**不动产品代码**的前提下，先用一个脚本验证这条组合能跑通：
 *   登录本地应用（拿会话 cookie）
 *     → 用「我们的网关」实现 Pi 需要的 StreamFn（模型层走我们现成的 provider/计费/限流）
 *       → 给 Agent 一个工具（下面先返回假画布，M2 会换成真的画布桥）
 *         → 期待：Agent **自己决定调工具** → 拿到结果 → 用中文回答
 *
 * 跑法：node scripts/pi-smoke.mjs
 *
 * 为什么先做这一步：Pi 的接口很多（StreamFn / AgentTool / 事件流），先把不匹配的地方在这里撞出来，
 * 比直接改产品代码再调试快得多。
 */
import { Agent } from '@earendil-works/pi-agent-core'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import {
  Type,
  // 这三个助手是官方自定义 provider 示例里用的：把「Pi 的转录」翻成「上游要的那套」
  collapseSystemMessages,
  getCurrentSystemPrompt,
  getCurrentTools,
} from '@earendil-works/pi-ai'

const API = 'http://localhost:5409'
// 通道随便选：M2 实测 deepseek-flash 与 gpt-5.6-terra 都支持工具结果往返。
// （M1 时曾以为 ggwk1「每轮重吐 tool_call」，后来查明那是消息没转成上游形状导致的，与通道无关。）
const PROVIDER_ID = 'p-sceneflow-deepseek'
const MODEL_KEY = 'deepseek-flash'

// 管理员密码从环境变量读：写进仓库等于把「用户名 + 密码」两半一起交出去。
const adminPassword = String(process.env.DEV_ADMIN_PASSWORD || '').trim()
if (!adminPassword) {
  console.error('缺少 DEV_ADMIN_PASSWORD 环境变量：本脚本要用管理员密码登录本地服务，请先设置（不要把密码写进仓库）。')
  process.exit(1)
}

// ---------- 1) 登录拿会话（本地这套用服务端会话表，不是纯 JWT） ----------
const loginRes = await fetch(`${API}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ methodType: 'ADMIN_PASSWORD', target: 'admin', password: adminPassword }),
})
const cookie = (loginRes.headers.getSetCookie?.() ?? []).map((item) => item.split(';')[0]).join('; ')
console.log(`登录：HTTP ${loginRes.status}｜cookie ${cookie ? '已拿到' : '没拿到'}`)
if (!cookie) process.exit(1)

/**
 * Pi 的内部消息 → OpenAI 形状。
 *
 * 这是第一次跑挂住的原因：我把 Pi 的转录原样发给了上游，工具结果在 Pi 里是
 * `role: "toolResult"`（带 toolCallId），而上游只认 `role: "tool"` + `tool_call_id` ——
 * 模型看不到工具结果，于是把同一个工具一遍遍重调（消息数 2→4→6→8…）。
 * 官方自定义 provider 示例就是这么转的（见 examples/extensions/custom-provider-anthropic）。
 */
const textOf = (content) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part?.type === 'text' ? part.text : part?.type === 'thinking' ? '' : ''))
    .filter(Boolean)
    .join('\n')
}

const toOpenAiMessages = (messages) => {
  const out = []
  for (const message of messages) {
    if (message.role === 'system') {
      out.push({ role: 'system', content: textOf(message.content) })
      continue
    }
    if (message.role === 'user') {
      out.push({ role: 'user', content: textOf(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      const content = Array.isArray(message.content) ? message.content : []
      const text = textOf(content)
      const toolCalls = content
        .filter((part) => part?.type === 'toolCall')
        .map((part) => ({
          id: String(part.id),
          type: 'function',
          function: { name: String(part.name), arguments: JSON.stringify(part.arguments ?? {}) },
        }))
      out.push({
        role: 'assistant',
        ...(text ? { content: text } : { content: null }),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      })
      continue
    }
    if (message.role === 'toolResult') {
      out.push({
        role: 'tool',
        tool_call_id: String(message.toolCallId || message.toolCallID || ''),
        content: textOf(message.content) || '(空结果)',
      })
      continue
    }
  }
  return out
}

// ---------- 2) 把「我们的网关」包成 Pi 的 StreamFn ----------
// Pi 要的是 AssistantMessageEventStream（它自己解析事件）；我们网关返回的是 OpenAI 形状的 JSON，
// 所以这里做一次翻译：start → text/toolcall → done。
const gatewayStreamFn = (model, context) => {
  const stream = createAssistantMessageEventStream()
  void (async () => {
    try {
      // Pi 交给我们的上下文已经是 provider 消息数组（含 system）
      /**
       * 工具要**从转录里拿**（不是 context.tools）。
       * Pi 的两层设计：context.tools 是「运行时能执行的集合」，而「模型可以调用什么」
       * 声明在转录的 system 消息上（toolsAdded）——provider 也是从那里取的。
       * 第一次写的时候读了 context.tools，于是工具一个都没发出去，模型只能说「我看不到画布」。
       */
      const transcript = collapseSystemMessages(context)
      const systemPrompt = getCurrentSystemPrompt(transcript.messages)
      const declaredTools = getCurrentTools(transcript.messages)
      const openAiMessages = [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...toOpenAiMessages(transcript.messages.filter((message) => message.role !== 'system')),
      ]
      const body = {
        model: MODEL_KEY,
        messages: openAiMessages,
        ...(declaredTools.length
          ? {
              tools: declaredTools.map((tool) => ({
                type: 'function',
                function: { name: tool.name, description: tool.description, parameters: tool.parameters },
              })),
              tool_choice: 'auto',
            }
          : {}),
      }
      console.log(`  ↳ [网关] 发出请求：消息 ${body.messages.length} 条、工具 ${declaredTools.length} 个 …`)
      // 前两次请求把尾部三条消息打出来：要看清 assistant(tool_calls) 与 tool 结果是否成对、形状对不对
      if (body.messages.length <= 4) {
        console.log('  ↳ [网关] 尾部消息：' + JSON.stringify(body.messages.slice(-3)).slice(0, 700))
      }
      const startedAt = Date.now()
      const res = await fetch(`${API}/api/ai/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        signal: AbortSignal.timeout(90_000),
        body: JSON.stringify({
          upstream: { providerId: PROVIDER_ID, endpointType: 'chat', modelKey: MODEL_KEY },
          request: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
        }),
      })
      const text = await res.text()
      console.log(`  ↳ [网关] 用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
      
      if (!res.ok) throw new Error(`网关 HTTP ${res.status}：${text.slice(0, 200)}`)
      const parsed = JSON.parse(text)
      const raw = parsed?.choices?.[0]?.message || {}
      console.log(`  ↳ [网关] 请求消息 ${context.messages.length} 条、工具 ${declaredTools.length} 个 → 回 tool_calls ${raw.tool_calls?.length ?? 0} 个｜文本 ${JSON.stringify(String(raw.content || '').slice(0, 40))}｜stop=${parsed?.choices?.[0]?.finish_reason}`)
      const toolCalls = Array.isArray(raw.tool_calls) ? raw.tool_calls : []

      const content = []
      if (raw.content) content.push({ type: 'text', text: String(raw.content) })
      for (const call of toolCalls) {
        let args = {}
        try { args = JSON.parse(call.function?.arguments || '{}') } catch { args = {} }
        content.push({ type: 'toolCall', id: String(call.id), name: String(call.function?.name || ''), arguments: args })
      }
      const message = {
        role: 'assistant',
        content,
        api: 'openai-completions',
        provider: 'sceneflow-gateway',
        model: MODEL_KEY,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        stopReason: toolCalls.length ? 'toolUse' : 'stop',
      }

      stream.push({ type: 'start', partial: message })
      content.forEach((part, index) => {
        if (part.type === 'text') {
          stream.push({ type: 'text_start', contentIndex: index, partial: message })
          stream.push({ type: 'text_delta', contentIndex: index, delta: part.text, partial: message })
          stream.push({ type: 'text_end', contentIndex: index, content: part.text, partial: message })
        }
        if (part.type === 'toolCall') {
          stream.push({ type: 'toolcall_start', contentIndex: index, partial: message })
          stream.push({ type: 'toolcall_end', contentIndex: index, toolCall: part, partial: message })
        }
      })
      stream.push({ type: 'done', reason: toolCalls.length ? 'toolUse' : 'stop', message })
      stream.end(message)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      console.error('[gatewayStreamFn] 失败：' + reason)
      stream.push({
        type: 'error',
        reason: 'error',
        error: {
          role: 'assistant',
          content: [],
          api: 'openai-completions',
          provider: 'sceneflow-gateway',
          model: MODEL_KEY,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          stopReason: 'error',
          errorMessage: reason,
        },
      })
      stream.end()
    }
  })()
  return stream
}

// ---------- 3) 一个工具（M1 先返回假画布；M2 换成「发事件给前端执行」） ----------
const FAKE_CANVAS = {
  nodes: [
    { id: 'node_1', type: 'image', prompt: '雪夜里的便利店', model: 'gpt-image-2' },
    { id: 'node_2', type: 'text', text: '这是一段描述文本' },
  ],
  edges: [{ source: 'node_1', target: 'node_2' }],
}

const getCanvasStateTool = {
  name: 'get_canvas_state',
  label: '读取画布',
  description: '读取当前画布上的节点与连线。需要了解画布现状时先调用它。',
  parameters: Type.Object({}),
  execute: async () => {
    console.log('  ↳ [工具被执行] get_canvas_state')
    return { content: [{ type: 'text', text: JSON.stringify(FAKE_CANVAS) }] }
  },
}

// ---------- 4) 跑一轮 ----------
const agent = new Agent({
  initialState: {
    systemPrompt: '你是画布助手。回答关于画布的问题前，必须先调用 get_canvas_state 看清现状，然后用简短中文回答。',
    tools: [getCanvasStateTool],
  },
  streamFn: gatewayStreamFn,
})

agent.subscribe((event) => {
  if (event.type === 'tool_execution_start') console.log(`  ↳ 模型要求调用工具：${event.toolName} ${JSON.stringify(event.args)}`)
  if (event.type === 'agent_end') console.log('  ↳ agent_end')
})

setTimeout(() => { console.error('\n[保险丝] 240 秒仍未结束，主动退出（说明某处还在等）'); process.exit(2) }, 240_000)
console.log('\n提问：画布上现在有哪些节点？')
await agent.prompt('画布上现在有哪些节点？')
await agent.waitForIdle?.()

const messages = agent.state?.messages ?? []
const lastAssistant = [...messages].reverse().find((item) => item.role === 'assistant')
const finalText = (lastAssistant?.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')
console.log(`\n最终回答：${finalText || '(空)'}`)
const toolResults = messages.filter((item) => item.role === 'toolResult')
console.log(`工具结果条数：${toolResults.length}`)
console.log(finalText && toolResults.length ? '\n✅ M1 通过：Agent 自己调了工具、拿到结果、给出了回答' : '\n⚠️ M1 未通过（看上面的失败原因）')
