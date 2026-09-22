/**
 * 助手对话的历史拼装（纯函数，单独可测）
 *
 * 为什么要抽出来：这段逻辑出 bug 时**没有任何报错** —— 少发一轮历史，模型照样
 * 给出一段读得通的话，只是它不知道上文。typecheck、构建、e2e 全都是绿的，
 * 用户只会说"它完全没有上下文记忆"。这正是必须用单测钉死的那类代码。
 *
 * 背景：RightPanel 原本写死 `messages: [{role:'user', content: prompt}]`，
 * 也就是面板上有历史、模型侧一句都没收到。
 */

export interface AssistantChatTurn {
  /** system 只用于放画布摘要，且一定在数组最前 */
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 面板里的消息条目（RightPanel 的 messages 数组，只声明这里用到的字段） */
export interface AssistantPanelMessage {
  type?: string
  content?: unknown
  loading?: boolean
  error?: unknown
}

/** 轮数上限：qwen 系是思考型模型，上下文越长首字越慢、也越贵 */
export const HISTORY_TURN_LIMIT = 20
/** 字符预算（从最近往回累加，超了就停） */
export const HISTORY_CHAR_LIMIT = 12000

/** 面板里的消息类型 → 该不该进上下文、进的时候当谁说的 */
const roleOfType = (type?: string): 'user' | 'assistant' | 'note' | 'skip' => {
  switch (type) {
    case 'user':
    case 'user-with-ref':
      return 'user'
    case 'ai-text':
      return 'assistant'
    // 图片轮次没有文本，但完全丢掉会让模型不知道自己刚出过图，接不上话
    case 'ai-images':
    case 'generated-images':
      return 'note'
    default:
      return 'skip'
  }
}

const IMAGE_TURN_NOTE = '（这一轮我为该请求生成了图片）'

/**
 * 把面板消息拼成发给上游的对话数组。
 *
 * @param stored   面板里已有的消息（**包含本轮刚 push 进去的那句用户输入**）
 * @param prompt   本轮要发送的内容
 * @param canvasBrief 画布状态摘要，有就作为 system 消息放在最前
 */
export const buildAssistantChatMessages = (
  stored: AssistantPanelMessage[],
  prompt: string,
  canvasBrief = '',
): AssistantChatTurn[] => {
  const current = String(prompt || '').trim()
  const turns: AssistantChatTurn[] = []

  for (const msg of stored || []) {
    // 本轮刚插入的空占位（loading）与失败的那轮都不能进上下文
    if (!msg || msg.loading || msg.error) continue
    const content = String(msg.content ?? '').trim()
    const role = roleOfType(msg.type)
    if (role === 'note') {
      turns.push({ role: 'assistant', content: IMAGE_TURN_NOTE })
      continue
    }
    if (role === 'skip' || !content) continue
    turns.push({ role, content })
  }

  // 本轮的用户消息通常已经在 stored 里了，去掉尾部重复，避免同一句发两遍
  while (turns.length && turns[turns.length - 1].role === 'user'
    && turns[turns.length - 1].content === current) {
    turns.pop()
  }

  // 从最近往回收：预算不够时砍掉最早的，绝不砍最新的
  const picked: AssistantChatTurn[] = []
  let chars = 0
  for (let index = turns.length - 1; index >= 0 && picked.length < HISTORY_TURN_LIMIT; index -= 1) {
    const turn = turns[index]
    if (picked.length && chars + turn.content.length > HISTORY_CHAR_LIMIT) break
    chars += turn.content.length
    picked.unshift(turn)
  }

  const messages: AssistantChatTurn[] = []
  const brief = String(canvasBrief || '').trim()
  if (brief) messages.push({ role: 'system', content: brief })
  messages.push(...picked)
  // 当前这句永远在最后，且只出现一次
  messages.push({ role: 'user', content: current })
  return messages
}
