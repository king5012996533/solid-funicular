/**
 * 上游请求归一化工具
 * 统一处理图片生成请求体清洗、图生图表单组装与参考图格式归一化。
 */

const normalizeStringValue = (value: unknown) => String(value || '').trim()

const resolveImageMimeType = (value: string) => {
  const dataMatch = value.match(/^data:([^;,]+)[;,]/i)
  if (dataMatch?.[1]) return dataMatch[1]

  const lowerValue = value.toLowerCase()
  if (lowerValue.includes('.webp')) return 'image/webp'
  if (lowerValue.includes('.gif')) return 'image/gif'
  if (lowerValue.includes('.bmp')) return 'image/bmp'
  if (lowerValue.includes('.svg')) return 'image/svg+xml'
  if (lowerValue.includes('.jpg') || lowerValue.includes('.jpeg')) return 'image/jpeg'
  return 'image/png'
}

const resolveImageFileExtension = (mimeType: string) => {
  if (mimeType === 'image/webp') return 'webp'
  if (mimeType === 'image/gif') return 'gif'
  if (mimeType === 'image/bmp') return 'bmp'
  if (mimeType === 'image/svg+xml') return 'svg'
  if (mimeType === 'image/jpeg') return 'jpg'
  return 'png'
}

export const normalizeReferenceImageList = (items: unknown) => {
  return Array.isArray(items)
    ? items.map(item => normalizeStringValue(item)).filter(Boolean)
    : []
}

// 清洗图片生成请求体，避免把内部字段与空值直接透传给上游。
export const normalizeImageGenerationRequestBody = (input: {
  requestBody: Record<string, unknown>
  modelKey: string
}) => {
  const normalizedBody: Record<string, unknown> = {
    ...input.requestBody,
    model: normalizeStringValue(input.modelKey),
  }

  // 把 n / count 归一为单一字段 n，并保证为正整数下限 1。
  // 上限不在此层 clamp，由 image-task-executor 根据模型 capabilityJson.maxImagesPerRequest 做可信兜底，
  // 否则在 normalize 层硬编码上限会绑死一个上游的特性。
  const rawN = Number(normalizedBody.n)
  const rawCount = Number((normalizedBody as Record<string, unknown>).count)
  const desiredCount = Number.isFinite(rawN) && rawN > 0
    ? rawN
    : (Number.isFinite(rawCount) && rawCount > 0 ? rawCount : 1)
  normalizedBody.n = Math.max(1, Math.floor(desiredCount))
  delete (normalizedBody as Record<string, unknown>).count

  delete normalizedBody.providerId

  // 剥离所有 _ 前缀的客户端内部字段（项目约定：调试/追踪/幂等等内部字段统一用 _ 前缀承载）。
  // 这里作为通用清洗的安全网，避免内部字段意外透传到上游。
  for (const key of Object.keys(normalizedBody)) {
    if (key.startsWith('_')) {
      delete normalizedBody[key]
    }
  }

  const prompt = normalizeStringValue(normalizedBody.prompt)
  if (prompt) {
    normalizedBody.prompt = prompt
  } else {
    delete normalizedBody.prompt
  }

  const size = normalizeStringValue(normalizedBody.size)
  if (size) {
    normalizedBody.size = size
  } else {
    delete normalizedBody.size
  }

  const quality = normalizeStringValue(normalizedBody.quality)
  if (quality) {
    normalizedBody.quality = quality
  } else {
    delete normalizedBody.quality
  }

  const normalizedImages = normalizeReferenceImageList(normalizedBody.image)
  if (normalizedImages.length) {
    normalizedBody.image = normalizedImages
  } else {
    delete normalizedBody.image
  }

  return normalizedBody
}

// 清洗音频生成请求体：只保留上游认识的字段，内部字段与空值一律不透传。
export const normalizeAudioGenerationRequestBody = (input: {
  requestBody: Record<string, unknown>
  modelKey: string
}) => {
  const normalizedBody: Record<string, unknown> = {
    ...input.requestBody,
    model: normalizeStringValue(input.modelKey),
  }

  delete normalizedBody.providerId

  // 与图片同一套安全网：剥离所有 _ 前缀的客户端内部字段。
  for (const key of Object.keys(normalizedBody)) {
    if (key.startsWith('_')) {
      delete normalizedBody[key]
    }
  }

  const prompt = normalizeStringValue(normalizedBody.prompt)
  if (prompt) {
    normalizedBody.prompt = prompt
  } else {
    delete normalizedBody.prompt
  }

  // 时长字段保留 duration / seconds 两种写法：不同厂商认的键不同，原样交给上游，
  // 不在这里二选一（选错就是上游静默按默认时长出片，账对不上）。
  const duration = normalizeStringValue(normalizedBody.duration)
  if (duration) {
    normalizedBody.duration = duration
  } else {
    delete normalizedBody.duration
  }

  const seconds = normalizeStringValue(normalizedBody.seconds)
  if (seconds) {
    normalizedBody.seconds = seconds
  } else {
    delete normalizedBody.seconds
  }

  const voice = normalizeStringValue(normalizedBody.voice)
  if (voice) {
    normalizedBody.voice = voice
  } else {
    delete normalizedBody.voice
  }

  const format = normalizeStringValue(normalizedBody.format)
  if (format) {
    normalizedBody.format = format
  } else {
    delete normalizedBody.format
  }

  return normalizedBody
}

// 将参考图统一转换为上游可消费的 multipart/form-data。
export const buildImageEditRequestFormData = async (input: {
  modelKey: string
  prompt: string
  size?: string
  quality?: string
  count?: number
  referenceImages: string[]
  /** 局部重绘蒙版：透明处 = 允许重绘的区域。必须是带透明通道的 PNG */
  mask?: string
  fileNamePrefix?: string
  resolveReferenceImageBlob?: (imageValue: string) => Promise<Blob>
}) => {
  const formData = new FormData()
  const modelKey = normalizeStringValue(input.modelKey)
  const prompt = normalizeStringValue(input.prompt)
  const size = normalizeStringValue(input.size)
  const quality = normalizeStringValue(input.quality)
  const referenceImages = normalizeReferenceImageList(input.referenceImages)
  const fileNamePrefix = normalizeStringValue(input.fileNamePrefix) || 'reference-image'
  const resolveReferenceImageBlob = input.resolveReferenceImageBlob

  const readBlob = async (imageValue: string) => {
    if (resolveReferenceImageBlob) {
      return resolveReferenceImageBlob(imageValue)
    }

    const response = await fetch(imageValue)
    if (!response.ok) {
      throw new Error(`参考图读取失败 (${response.status})`)
    }

    return response.blob()
  }

  if (modelKey) formData.append('model', modelKey)
  if (prompt) formData.append('prompt', prompt)
  // 仅保证下限：上限由 image-task-executor 按模型 capabilityJson.maxImagesPerRequest 兜底。
  const desiredCount = Math.max(1, Math.floor(Number(input.count) > 0 ? Number(input.count) : 1))
  formData.append('n', String(desiredCount))
  if (size) formData.append('size', size)
  if (quality) formData.append('quality', quality)

  for (let index = 0; index < referenceImages.length; index += 1) {
    const imageValue = referenceImages[index]
    const blob = await readBlob(imageValue)
    const mimeType = blob.type || resolveImageMimeType(imageValue)
    const extension = resolveImageFileExtension(mimeType)
    formData.append('image', blob, `${fileNamePrefix}-${index + 1}.${extension}`)
  }

  // 蒙版单独收口：不带透明通道的图当蒙版传上去，等于整张都可重绘（或者被上游含糊拒绝），
  // 所以这里先判死 —— 蒙版必须是 PNG。
  const mask = normalizeStringValue(input.mask)
  if (mask) {
    const blob = await readBlob(mask)
    if (blob.type && blob.type !== 'image/png') {
      throw new Error('局部重绘的蒙版必须是带透明通道的 PNG')
    }

    formData.append('mask', blob, 'mask.png')
  }

  return formData
}
