/**
 * 助手会话列表的排序（纯函数，可单测）
 *
 * 为什么单独抽出来：排序是渲染期行为，手上会话不够多时**在浏览器里根本演示不出来**
 * （我试过：本地只有 1 个 default 会话，看不出任何顺序）。而用户明确反馈过
 * "刚聊完的排在后面、以前使用的浮在最上面、只是改了个标题就跑到中间"。
 * 所以把规则抽成纯函数，用造出来的数据钉死。
 *
 * 规则（对应被修掉的两个毛病）：
 *   1. **不再把 isDefault 无条件置顶** —— 那个默认会话可能几个月没用过，
 *      却永远压在新会话上面，新对话因此被挤到后面。
 *   2. **不再回落到 updatedAt** —— 重命名也会改 updatedAt，于是"只是改了个标题"
 *      就能让会话跳到列表中间；改标题不是"使用"。
 *   只认 `lastRecordAt`（真正产生过内容的时间），没有就用 `createdAt`
 *   —— 这样新建的会话一出现就在最前，聊过就一直留在最前。
 */

export interface SortableAssistantSession {
  id: string
  title?: string
  isDefault?: boolean
  lastRecordAt?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

/** 会话的"最近使用"时刻：只认真正产生过内容的时间，其次才是创建时间 */
export const sessionUsedTime = (session: SortableAssistantSession): number => {
  const raw = session.lastRecordAt || session.createdAt || ''
  const time = new Date(raw).getTime()
  return Number.isFinite(time) ? time : 0
}

export const sortAssistantSessions = <T extends SortableAssistantSession>(sessions: T[]): T[] =>
  [...(sessions || [])].sort((a, b) => sessionUsedTime(b) - sessionUsedTime(a))
