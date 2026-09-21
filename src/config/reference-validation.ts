/**
 * 参考图校验
 *
 * 为什么单独一个模块：这套规则原来在**两个地方各写了一遍** ——
 * `nodes/ImageNode.vue` 和 `canana/RightPanel.vue`（工作流页面在用的助手面板），
 * 而且两份行为不一致：RightPanel 那份没有 data-URL 的放行分支，
 * 于是同一张图可能被节点接受、被助手面板拒掉。规则只留一处。
 *
 * 为什么要校验：
 *   上游图生图模型（如 gpt-image-2）只接受栅格格式，SVG / PDF / HEIC 这类
 *   会让服务端的 PIL 在 BytesIO 解码时报 "cannot identify image file"。
 *   与其等上游报错、再浪费一次任务和积分，不如在提交前拦下来。
 */

/** 上游能解码的栅格扩展名 */
export const RASTER_REFERENCE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'])

/**
 * 判断一个参考图 URL 能否被上游接受（**同步可判定的部分**）。
 *
 * 判定顺序：
 *   1. data:image/svg* → 拒。**这一步不能省**：SVG 的 data URL 也以
 *      `data:image/` 开头，先放行再看别的就会把它漏过去，而 SVG 正是
 *      上游 PIL 解不了的那一类
 *   2. 其他 data:image/* → 放行（内容已内嵌，没有扩展名可查）
 *   3. data: 但不是 image → 拒（内嵌的肯定不是图）
 *   4. 没有扩展名 → 放行。**宁可不拦**：扩展名缺失很常见，
 *      拦下来会误伤一批本来能用的图；真正的解码失败交给可访问性探测兜底
 *   5. 其余看扩展名是否在栅格白名单里
 */
export const isRasterReferenceUrl = (url: string): boolean => {
  const value = String(url || '').trim()
  if (!value) return false
  if (value.startsWith('data:image/svg')) return false
  if (value.startsWith('data:image/')) return true
  if (value.startsWith('data:')) return false

  // 截掉 query / hash 再取扩展名，避免 `a.png?token=x` 被误判
  const clean = value.split('?')[0].split('#')[0]
  const dotIndex = clean.lastIndexOf('.')
  if (dotIndex < 0) return true
  return RASTER_REFERENCE_EXTENSIONS.has(clean.slice(dotIndex + 1).toLowerCase())
}

export interface ReferenceIssue {
  url: string
  /** 人话说明哪里不行，直接拿去提示用户 */
  reason: string
}

export interface ReferenceValidationResult {
  valid: string[]
  invalid: ReferenceIssue[]
}

/** 同步校验：只查格式，不发网络请求。提交路径上先跑这一层，成本为零 */
export const validateReferenceUrls = (urls: string[]): ReferenceValidationResult => {
  const valid: string[] = []
  const invalid: ReferenceIssue[] = []
  for (const url of urls) {
    if (isRasterReferenceUrl(url)) {
      valid.push(url)
    } else {
      invalid.push({ url, reason: '格式不是上游支持的栅格图（仅 jpg / png / webp / gif / bmp）' })
    }
  }
  return { valid, invalid }
}

/**
 * 判断某个 URL 是否需要发网络探测。
 * data: 内容已内嵌；blob: 是本地对象 URL —— 都不需要探，也探不了。
 */
export const shouldProbeReferenceUrl = (url: string): boolean => {
  const value = String(url || '').trim()
  if (!value) return false
  return !value.startsWith('data:') && !value.startsWith('blob:')
}

/**
 * 可访问性探测：并发检查每个 URL 能不能真的被加载出来。
 *
 * 为什么用 `new Image()` 而不是 fetch：
 *   1. **判据和界面一致** —— 我们要回答的是"这张参考图拿得到吗"，
 *      而浏览器显示图片走的就是 img 加载路径。
 *   2. **不需要服务端支持 HEAD**。最初我写的是先 HEAD 再回落 GET，
 *      结果撞上一个真实缺陷：本项目的静态文件处理对 HEAD 返回 **404**
 *      （GET 是 200），于是每一张正常的上传图都被判成"取不到"，
 *      把正常提交全拦死了。这个 bug 是被 e2e 抓出来的。
 *   3. **不需要 CORS**。fetch 跨域要 CORS 头，img 不需要 ——
 *      否则会出现"界面能显示、校验说不行"的矛盾。
 *   4. 顺带能发现"URL 返回 200 但内容不是图片"（比如错误页 HTML）。
 *
 * data: 与 blob: 是本地内容，不发请求。
 */
export const probeReferenceUrls = async (
  urls: string[],
  timeoutMs = 4000,
): Promise<ReferenceIssue[]> => {
  const target = urls.filter(shouldProbeReferenceUrl)
  if (!target.length) return []

  const probeOne = (url: string) => new Promise<ReferenceIssue | null>((resolve) => {
    const image = new Image()
    let settled = false

    const finish = (issue: ReferenceIssue | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      image.onload = null
      image.onerror = null
      resolve(issue)
    }

    const timer = setTimeout(() => {
      finish({ url, reason: '素材加载超时' })
    }, timeoutMs)

    image.onload = () => finish(null)
    image.onerror = () => finish({ url, reason: '素材取不到，或不是可解码的图片' })
    image.src = url
  })

  const results = await Promise.all(target.map(probeOne))
  return results.filter((issue): issue is ReferenceIssue => issue !== null)
}
