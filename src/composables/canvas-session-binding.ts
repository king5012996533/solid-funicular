/**
 * 画布 id → 助手会话 id 的绑定（B：会话绑到画布，纯逻辑 + localStorage）。
 *
 * 背景：助手会话在浏览器里一直是**全局一个**（只持久化 active session id），
 * 于是同一会话把不同画布的对话混在一起；而 Agent 跨轮记忆的键是
 * **sessionId + 画布 id**（见 server/generation-tasks/canvas-agent-executor.ts 的会话恢复），
 * 会话一变就命中不到。要「切画布 = 切会话、不串台」，就得在浏览器这侧维护一张映射。
 *
 * 为什么不做库表迁移：Agent 转录存在 GenerationRecord.metaJson.canvasAgentSession.canvasId 上，
 * 但没有索引，按画布反查会话代价大。这里先用 localStorage 做最小可用；
 * 跨设备续写需要服务端按 canvasId 建索引，另案处理（见本次报告）。
 *
 * 本文件里能纯逻辑化的部分（解析 / 决策 / 写回）刻意不碰 localStorage，方便在 node 里单测。
 */

/** localStorage 键：{ [canvasId]: sessionId } 的 JSON */
export const CANVAS_SESSION_MAP_STORAGE_KEY = 'canvas-assistant_canvas_session_map'

export type CanvasSessionMap = Record<string, string>

/** 解析落盘的映射；损坏 / 非对象一律当空表，绝不因脏数据把会话绑丢 */
export const parseCanvasSessionMap = (raw: unknown): CanvasSessionMap => {
  if (!raw) return {}
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return {}
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const map: CanvasSessionMap = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const canvasId = String(key || '').trim()
    const sessionId = String(item || '').trim()
    if (canvasId && sessionId) map[canvasId] = sessionId
  }
  return map
}

/** 写回一条绑定，返回新表（不改原对象，便于比较与测试） */
export const upsertCanvasSessionBinding = (
  map: CanvasSessionMap,
  canvasId: string,
  sessionId: string,
): CanvasSessionMap => {
  const normalizedCanvasId = String(canvasId || '').trim()
  const normalizedSessionId = String(sessionId || '').trim()
  if (!normalizedCanvasId || !normalizedSessionId) return { ...map }
  return { ...map, [normalizedCanvasId]: normalizedSessionId }
}

/**
 * 这张画布该用哪个会话 —— 纯决策。
 *
 * 规则（最小可用）：
 *   - 无画布 id（未保存的新画布 / 没拿到 id）→ 不动会话（返回空），Agent 记忆也刻意不启用，防串台；
 *   - 映射命中且该会话在服务端**仍存在** → 复用它（这就是「回到这张画布那次对话」）；
 *   - 无映射 / 映射指向已删除的会话 → 需要新建一条，并写回映射。
 */
export interface CanvasSessionDecision {
  /** 可复用的会话 id；空串表示需要新建 */
  sessionId: string
  needsCreate: boolean
  /** 新建后是否要写回映射 */
  shouldBind: boolean
}

export const decideCanvasSession = (input: {
  canvasId?: string
  map?: CanvasSessionMap
  existingSessionIds?: string[]
}): CanvasSessionDecision => {
  const canvasId = String(input.canvasId || '').trim()
  if (!canvasId) {
    return { sessionId: '', needsCreate: false, shouldBind: false }
  }

  const existing = new Set((input.existingSessionIds || []).map((id) => String(id || '').trim()).filter(Boolean))
  const mapped = String((input.map || {})[canvasId] || '').trim()
  if (mapped && existing.has(mapped)) {
    return { sessionId: mapped, needsCreate: false, shouldBind: false }
  }

  return { sessionId: '', needsCreate: true, shouldBind: true }
}

/** 从 localStorage 读映射（浏览器不可用时返回空表） */
export const readCanvasSessionMap = (): CanvasSessionMap => {
  try {
    if (typeof localStorage === 'undefined') return {}
    return parseCanvasSessionMap(localStorage.getItem(CANVAS_SESSION_MAP_STORAGE_KEY))
  } catch {
    return {}
  }
}

/** 把映射写回 localStorage */
export const writeCanvasSessionMap = (map: CanvasSessionMap): void => {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(CANVAS_SESSION_MAP_STORAGE_KEY, JSON.stringify(parseCanvasSessionMap(map)))
  } catch {
    // ignore（隐私模式 / quota 等）：绑定丢了下一次会重走「新建会话」，不影响画布本身
  }
}
