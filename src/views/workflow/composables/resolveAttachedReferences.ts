/**
 * 画布 Agent 的「挂参考图」参数解析（2026-09-25）
 *
 * 模型给的 images 里，每一项可能是**图片地址**，也可能是**已有出图的节点 id**
 * （它心里想的是「把母版 node_1 的成图挂上去」，交上来的却是一个 id）。
 *
 * 为什么必须在这里解析：id 既不是 URL 也没有扩展名，会一路穿到服务端，在 `new URL("node_2")`
 * 上抛 "Failed to parse URL from node_2" —— 实测一整批 8 张分镜图就这么全废了。
 * 解析规则是纯函数，单独放这里以便单测（不依赖画布组件）。
 */
export interface AttachedReferenceResolution {
  /** 可用的参考图地址（节点 id 已翻译成该节点的出图地址） */
  resolved: string[]
  /** 用不了的项，带人话原因（回给模型，让它知道下一步改什么） */
  unresolved: string[]
}

/** 节点查询结果：是否存在、是否已有出图 */
export interface AttachedReferenceNodeLookup {
  exists: boolean
  imageUrl: string
}

/** 看起来像「图片地址」的：http(s) 绝对地址、站内绝对路径、内联 data:image */
const looksLikeImageLocation = (value: string) =>
  /^https?:\/\//i.test(value) || value.startsWith('/') || value.startsWith('data:image/')

/**
 * @param items      模型给的 images 原始项
 * @param lookupNode 按节点 id 查「该节点是否存在 / 是否已有出图」
 */
export const resolveAttachedReferences = (
  items: unknown[],
  lookupNode: (nodeId: string) => AttachedReferenceNodeLookup,
): AttachedReferenceResolution => {
  const resolved: string[] = []
  const unresolved: string[] = []
  const seen = new Set<string>()

  const push = (value: string) => {
    if (seen.has(value)) return
    seen.add(value)
    resolved.push(value)
  }

  for (const item of Array.isArray(items) ? items : []) {
    const value = String(item ?? '').trim()
    if (!value) continue

    const node = lookupNode(value)
    if (node.exists) {
      if (node.imageUrl) push(node.imageUrl)
      else unresolved.push(`${value}（该节点还没有出图）`)
      continue
    }

    if (looksLikeImageLocation(value)) {
      push(value)
      continue
    }

    unresolved.push(`${value}（既不是已出图的节点 id，也不是图片地址）`)
  }

  return { resolved, unresolved }
}
