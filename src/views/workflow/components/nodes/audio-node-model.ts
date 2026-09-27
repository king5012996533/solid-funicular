/**
 * 音频节点的纯逻辑（无 Vue、无 `@/` 别名依赖，可在 Node 里直接单测）
 *
 * 抽出来的是三类必须钉死的判断：
 *   1. **产物**：从生成任务完成事件的 record 里取出「地址 / 时长 / 格式」。
 *      服务端落库的是 `outputs[{ outputType:'audio', url, mimeType, durationSeconds }]`
 *      （见 server/generation-tasks/audio-task-executor.ts），但 record 是**外部数据**：
 *      可能缺字段、可能是旧形状、也可能只有 b64 内联地址。所以这里全程按 unknown 收。
 *   2. **格式**：优先信 mimeType，其次从地址反推（`data:audio/wav;base64,...`、
 *      `/uploads/generated/audio/x.mp3`）；一条都认不出就返回空串 —— 卡片不显示，
 *      而不是瞎写一个 'mp3'。
 *   3. **状态**：卡片该显示哪一态（空态 / ready / 生成中 / 失败 / 有音频）。
 *      优先级与视频节点完全一致（生成中 > 失败 > 有产物 > 就绪 > 空态）。
 */

/** 写回节点的音频产物 */
export interface AudioArtifact {
  url: string
  /** 时长（秒）；产物没带、节点也没记时给 0（界面据此不显示时长段） */
  duration: number
  /** 格式（mp3 / wav …）；认不出时给空串（界面据此不显示格式段） */
  format: string
}

/** mime → 扩展名。上游内联 b64 时 record 上的 mimeType 比地址更可信 */
const FORMAT_BY_MIME: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

const asText = (value: unknown): string => String(value ?? '').trim()

/** 收敛一个格式串：小写、去点、只留字母数字；mime（'audio/mpeg'）与带点后缀（'.WAV'）都认 */
export const normalizeAudioFormat = (value: unknown): string => {
  const raw = asText(value).toLowerCase()
  if (!raw) return ''
  const byMime = FORMAT_BY_MIME[raw]
  if (byMime) return byMime
  const tail = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw
  return tail.replace(/^\./, '').replace(/[^a-z0-9]/g, '')
}

/**
 * 音频地址 → 格式。
 * 依次尝试：mimeType → `data:audio/<sub>;base64,` → 路径扩展名；都认不出返回空串。
 */
export const resolveAudioFormat = (url: string, mimeType?: unknown): string => {
  const mime = asText(mimeType).toLowerCase()
  if (mime) {
    const byMime = FORMAT_BY_MIME[mime]
    if (byMime) return byMime
    // 表里没有的写法（audio/opus…）也按子类型收下：声明了 mime 就比地址可信
    const subtype = mime.match(/^audio\/([a-z0-9.+-]+)$/)
    if (subtype) return normalizeAudioFormat(subtype[1])
  }

  const value = asText(url)
  if (!value) return ''

  const inline = value.match(/^data:audio\/([a-z0-9.+-]+)/i)
  if (inline) {
    const subtype = inline[1].toLowerCase()
    return FORMAT_BY_MIME[`audio/${subtype}`] || normalizeAudioFormat(subtype)
  }

  // 只看路径里的扩展名：查询串 / 哈希（`?v=1`、`#t=3`）里常有点号，不能算进扩展名
  const path = value.split(/[?#]/)[0]
  const matched = path.match(/\.([a-z0-9]+)$/i)
  return matched ? normalizeAudioFormat(matched[1]) : ''
}

/** 时长：只认有限的正数（脏数据按「没带时长」处理，不显示成 0s） */
export const normalizeAudioDuration = (value: unknown): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/** record 里一条候选产物 */
export interface AudioCandidate {
  url: string
  mimeType: string
  duration: number
}

const readCandidate = (value: unknown): AudioCandidate | null => {
  const entry = asRecord(value)
  if (!entry) return null
  const url = asText(entry.url)
  if (!url) return null
  return {
    url,
    mimeType: asText(entry.mimeType),
    duration: normalizeAudioDuration(entry.durationSeconds),
  }
}

/**
 * 从完成事件的 record 里取第一条可用的音频产物。
 * 找不到返回 null（调用方据此如实报「完成但没拿到音频」，而不是写一条空成功）。
 */
export const readAudioCandidate = (record: unknown): AudioCandidate | null => {
  const source = asRecord(record)
  if (!source) return null

  const outputs = Array.isArray(source.outputs) ? source.outputs : []
  const fromOutputs = outputs.map(readCandidate).filter((item): item is AudioCandidate => !!item)
  if (fromOutputs.length) {
    // outputType 是服务端声明的产物种类；有 audio 标记时优先它，其余按顺序兜底
    const typed = outputs
      .filter(entry => asText(asRecord(entry)?.outputType).toLowerCase() === 'audio')
      .map(readCandidate)
      .filter((item): item is AudioCandidate => !!item)
    return typed[0] || fromOutputs[0]
  }

  const direct = readCandidate({ url: source.url })
  if (direct) return direct

  const images = Array.isArray(source.images) ? source.images : []
  for (const item of images) {
    const candidate = readCandidate({ url: item })
    if (candidate) return candidate
  }

  return null
}

/**
 * 产物 → 要写回节点 data 的 `{ url, duration, format }`。
 *
 * @param fallbackDuration 节点上记的本次提交时长（秒）。产物自己没带时长时用它，
 *   保证「卡片摘要」与用户选的档位一致，而不是一片空白。
 */
export const resolveAudioArtifact = (
  record: unknown,
  fallbackDuration = 0,
): AudioArtifact | null => {
  const candidate = readAudioCandidate(record)
  if (!candidate) return null
  return {
    url: candidate.url,
    duration: candidate.duration || normalizeAudioDuration(fallbackDuration),
    format: resolveAudioFormat(candidate.url, candidate.mimeType),
  }
}

/** 时长段文案：`30s`；没有有效时长时返回空串 */
export const formatAudioDuration = (seconds: unknown): string => {
  const value = normalizeAudioDuration(seconds)
  return value ? `${value}s` : ''
}

/** 标题行右侧的摘要：`30s · mp3`；两段都没有时返回空串（不显示，不瞎猜） */
export const formatAudioSummary = (input: { duration?: unknown; format?: unknown }): string => {
  const parts: string[] = []
  const duration = formatAudioDuration(input?.duration)
  if (duration) parts.push(duration)
  const format = normalizeAudioFormat(input?.format)
  if (format) parts.push(format)
  return parts.join(' · ')
}

export type AudioCardState = 'loading' | 'error' | 'audio' | 'ready' | 'empty'

/**
 * 卡片该显示哪一态。优先级与视频节点一致：
 * 生成中 > 失败 > 有产物 > 就绪（上游真的有输入）> 空态。
 *
 * `ready` 用「上游真的产出了内容」判定，而不是「有一条边」——
 * 连了一个还没写内容的文本节点不算已连接，否则界面会说谎。
 */
export const resolveAudioCardState = (input: {
  loading?: boolean
  error?: unknown
  url?: unknown
  hasUpstreamInput?: boolean
}): AudioCardState => {
  if (input?.loading) return 'loading'
  if (asText(input?.error)) return 'error'
  if (asText(input?.url)) return 'audio'
  if (input?.hasUpstreamInput) return 'ready'
  return 'empty'
}

/** 提交给服务端音频策略的请求体（providerId / model / prompt / duration，与请求体归一化对齐） */
export const buildAudioRequestBody = (input: {
  providerId: string
  modelKey: string
  prompt: string
  duration?: string
}): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    providerId: input.providerId,
    model: input.modelKey,
    prompt: input.prompt,
  }
  const duration = asText(input.duration)
  if (duration) body.duration = Number(duration) || duration
  return body
}
