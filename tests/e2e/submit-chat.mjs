#!/usr/bin/env node
/**
 * 对话（chat / LLM）链路的端到端验证：提交一条对话任务 → 看它是否真的出文
 *
 * 为什么需要单独一个脚本：
 *   `type: 'agent'` 走的是 agent-chat 策略，跟图片完全不同的执行器与上游形态
 *   （流式 chat/completions）。这条链路以前是**没有任何可用对话模型**的
 *   （中转站的 Key 分组里只有图像模型），所以从来没验证过；
 *   接上 qwen-maas 之后它是"能用了"，但"能用"必须有证据。
 *
 * 它验证的是「应用后端 → 上游对话模型」整条路，包括：
 *   模型解析（catalog 的 defaults.chat）、厂商密钥解密、流式响应聚合、落库。
 *
 * 用法：
 *   SESSION_TOKEN=... node tests/e2e/submit-chat.mjs
 *   SESSION_TOKEN=... MODEL_KEY=qwen3.8-max node tests/e2e/submit-chat.mjs
 */

const API = process.env.API_BASE || 'http://127.0.0.1:5409'
const TOKEN = process.env.SESSION_TOKEN || ''
const MODEL_KEY = process.env.MODEL_KEY || 'qwen3.8-flash'
const PROMPT = process.env.PROMPT || '只回四个字：链路正常'

if (!TOKEN) {
  console.error('缺少 SESSION_TOKEN')
  process.exit(1)
}

const headers = {
  'Content-Type': 'application/json',
  Cookie: `canana_session=${TOKEN}`,
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 从公开目录里解析出 providerId。
 * 后端**必须**收到 requestBody.providerId（缺了就报"未匹配到后台模型配置"），
 * 所以这一步不能省 —— 顺便也验证了"目录 → 提交"这条路是通的。
 * selectionKey 形如 `providerId::CHAT::modelKey`，前缀就是 providerId。
 */
const resolveProviderId = async (modelKey) => {
  const catalog = await fetch(`${API}/api/provider-config/catalog`).then(response => response.json())
  const chatModels = catalog?.data?.models?.chat || []
  const matched = chatModels.find(item => item.modelKey === modelKey)
  if (!matched) {
    throw new Error(`目录里没有对话模型 ${modelKey}（现有：${chatModels.map(m => m.modelKey).join(', ') || '无'}）`)
  }
  const providerId = String(matched.selectionKey || '').split('::')[0]
  if (!providerId) throw new Error(`无法从 selectionKey 解析 providerId：${matched.selectionKey}`)
  console.log(`  目录解析：${matched.label} → providerId=${providerId}（默认对话模型：${catalog.data.defaults.chat === matched.selectionKey}）`)
  return providerId
}

const main = async () => {
  console.log(`\n【真实对话】model=${MODEL_KEY}`)
  console.log(`  提示词：${PROMPT}\n`)

  const providerId = await resolveProviderId(MODEL_KEY)

  const created = await fetch(`${API}/api/generation-tasks`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      source: 'workflow',
      type: 'agent',
      prompt: PROMPT,
      model: MODEL_KEY,
      modelKey: MODEL_KEY,
      skill: 'general',
      requestBody: {
        providerId,
        model: MODEL_KEY,
        messages: [{ role: 'user', content: PROMPT }],
        stream: true,
      },
    }),
  }).then(response => response.json()).catch(error => ({ error: String(error) }))

  const taskId = String(created?.data?.id || created?.id || '').trim()
  if (!taskId) {
    console.error('  创建任务失败：', JSON.stringify(created).slice(0, 300))
    process.exit(1)
  }
  console.log(`  taskId = ${taskId}`)

  const started = Date.now()
  let detail = null
  for (let i = 0; i < 36; i += 1) {
    const response = await fetch(`${API}/api/generation-tasks/${taskId}`, { headers })
    detail = await response.json().catch(() => null)
    const record = detail?.data || detail || {}
    const content = String(record.content || '')
    const seconds = String(Math.round((Date.now() - started) / 1000)).padStart(3)
    console.log(`  [${seconds}s] done=${record.done} stopped=${record.stopped} 已出字数=${content.length}${record.error ? ` error=${String(record.error).slice(0, 80)}` : ''}`)
    if (record.done || record.stopped || record.error) break
    await sleep(3000)
  }

  const record = detail?.data || detail || {}
  const content = String(record.content || '')
  console.log(`\n  最终：done=${record.done} 字数=${content.length}`)
  if (content) console.log(`  模型回复：${content.trim().slice(0, 120)}`)

  const ok = Boolean(record.done) && content.trim().length > 0 && !record.error
  console.log(`\n${'─'.repeat(52)}`)
  console.log(`  ${ok ? '✅ 对话链路通过' : '❌ 对话链路失败'}`)
  process.exit(ok ? 0 : 1)
}

main().catch((error) => {
  console.error('执行失败：', error)
  process.exit(1)
})
