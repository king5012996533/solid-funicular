/**
 * 产物真实元数据解析（**纯函数，零 IO**，2026-09-27）。
 *
 * 为什么单独一个纯函数文件：`GenerationOutputPayload` 的 width/height/durationSeconds/mimeType
 * 字段早就有了，但从来没人填过 —— 记录里永远是空，用户看不到 30 秒视频的真实时长。
 * 把解析做成「入参 Uint8Array → 出参元数据」的纯函数，才能拿拼出来的最小字节头直接单测，
 * 不必起服务、连数据库、也不依赖网络文件。文件/网络的读取全在 `probe-artifact.ts`。
 *
 * 最强约束：**解析不出来就不要编**。字段一律「读到才算」，时长必须是有限正数才给；
 * 宁可留空让调用方跳过，也不能写 0 或一个假数字 —— 假元数据比没有元数据更糟（会误导用户与运营）。
 *
 * 覆盖格式与各自从哪几个字节读出来（都只读文件头部；MP4 见下方说明）：
 *   · PNG   —— 8 字节签名 + IHDR（偏移 16 宽、20 高，大端 uint32）
 *   · JPEG  —— 扫 SOF0/1/2… 段：段头 FFxx + 段长，段内 精度(1) 高(2) 宽(2)
 *   · GIF   —— `GIF87a`/`GIF89a` + 逻辑屏幕宽高（偏移 6/8，小端 uint16）
 *   · WEBP  —— RIFF/WEBP 之下的 VP8X（24 位 canvas 减一）/ VP8（14 位宽高）/ VP8L（14+14 位打包）
 *   · MP4/MOV —— 找 `moov` → `mvhd`（timescale + duration 算时长）/ `trak` → `tkhd`（16.16 定点宽高取整数部分）
 *   · WAV   —— `RIFF`/`WAVE` 之下 `fmt ` 的 byteRate 与 `data` 的 size 算时长
 *   · MP3   —— 首帧头解析采样率/比特率，按文件总大小估算时长并**标注为估算**
 */

export interface ArtifactMetadata {
  width?: number
  height?: number
  durationSeconds?: number
  /** 时长是估算值（MP3 无绝对总长，只能按首帧比特率 × 文件大小推断），调用方据此决定怎么展示 */
  durationEstimated?: boolean
  /** 产物字节数（远程只取了头部若干字节时用响应里的真实总大小） */
  byteSize: number
  mimeType?: string
}

export interface ParseArtifactMetadataOptions {
  /** 文件真实总字节数（远程 Range 只取了头部一段时传入）；缺省用 `bytes.byteLength` */
  totalByteSize?: number
}

const isPositiveFinite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

/** 按字节偏移读 ASCII；越界返回 null（调用方据此判定「读不到」） */
const asciiAt = (bytes: Uint8Array, offset: number, length: number): string | null => {
  if (offset < 0 || offset + length > bytes.length) return null
  let text = ''
  for (let i = 0; i < length; i += 1) text += String.fromCharCode(bytes[offset + i])
  return text
}

const matchSignature = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean => {
  if (offset + signature.length > bytes.length) return false
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) return false
  }
  return true
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

const toView = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

const readUint16BE = (view: DataView, offset: number): number | null =>
  offset >= 0 && offset + 2 <= view.byteLength ? view.getUint16(offset, false) : null

const readUint32BE = (view: DataView, offset: number): number | null =>
  offset >= 0 && offset + 4 <= view.byteLength ? view.getUint32(offset, false) : null

const readUint16LE = (view: DataView, offset: number): number | null =>
  offset >= 0 && offset + 2 <= view.byteLength ? view.getUint16(offset, true) : null

const readUint32LE = (view: DataView, offset: number): number | null =>
  offset >= 0 && offset + 4 <= view.byteLength ? view.getUint32(offset, true) : null

/** 24 位小端（WebP 的 canvas 尺寸用） */
const readUint24LE = (bytes: Uint8Array, offset: number): number | null => {
  if (offset < 0 || offset + 3 > bytes.length) return null
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

/** 64 位大端（MP4 v1 的 duration 用）；超过安全整数就返回 null（宁缺毋滥） */
const readUint64BE = (view: DataView, offset: number): number | null => {
  if (offset < 0 || offset + 8 > view.byteLength) return null
  const high = view.getUint32(offset, false)
  const low = view.getUint32(offset + 4, false)
  const value = high * 2 ** 32 + low
  return Number.isSafeInteger(value) ? value : null
}

type Dimensions = { width: number; height: number }

const pickDimensions = (width: number | null, height: number | null): Dimensions | null =>
  isPositiveFinite(width) && isPositiveFinite(height) ? { width, height } : null

// ---------------------------------------------------------------------------
// 图片
// ---------------------------------------------------------------------------

/** PNG：签名(8) + 长度(4) + `IHDR`(4) + 宽(4 大端) + 高(4 大端) */
const parsePng = (bytes: Uint8Array, view: DataView): Dimensions | null => {
  if (!matchSignature(bytes, PNG_SIGNATURE)) return null
  if (asciiAt(bytes, 12, 4) !== 'IHDR') return null
  return pickDimensions(readUint32BE(view, 16), readUint32BE(view, 20))
}

/** JPEG：顺段扫到 SOF（FFC0~FFCF，排除 C4/C8/CC 这三个非 SOF），段内 精度(1)+高(2)+宽(2) */
const parseJpeg = (bytes: Uint8Array, view: DataView): Dimensions | null => {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    // 填充 FF 与无长度的标记（SOI/EOI/RSTn/TEM）直接跳过
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2
      continue
    }
    // SOS 之后是压缩数据，不会再有 SOF
    if (marker === 0xda) return null
    const segmentLength = readUint16BE(view, offset + 2)
    if (!isPositiveFinite(segmentLength) || segmentLength < 2) return null
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isStartOfFrame) {
      return pickDimensions(readUint16BE(view, offset + 7), readUint16BE(view, offset + 5))
    }
    offset += 2 + segmentLength
  }
  return null
}

/** GIF：`GIF87a`/`GIF89a` + 逻辑屏幕宽(小端 uint16 @6) / 高(@8) */
const parseGif = (bytes: Uint8Array, view: DataView): Dimensions | null => {
  const signature = asciiAt(bytes, 0, 6)
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return null
  return pickDimensions(readUint16LE(view, 6), readUint16LE(view, 8))
}

/**
 * WEBP：RIFF 容器逐个 chunk 看。
 *   VP8X —— 1 字节标志 + 3 字节保留 + canvas 宽-1(3 字节小端) + 高-1(3 字节小端)
 *   VP8  —— 3 字节帧标签 + 起始码 9d 01 2a + 宽(14 位) + 高(14 位)
 *   VP8L —— 1 字节签名 2f + 宽-1(14 位) 与 高-1(14 位) 打包成一个 32 位小端
 */
const parseWebp = (bytes: Uint8Array, view: DataView): Dimensions | null => {
  if (asciiAt(bytes, 0, 4) !== 'RIFF' || asciiAt(bytes, 8, 4) !== 'WEBP') return null
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const fourcc = asciiAt(bytes, offset, 4)
    const size = readUint32LE(view, offset + 4)
    if (!isPositiveFinite(size)) return null
    const payload = offset + 8
    if (fourcc === 'VP8X') {
      const width = readUint24LE(bytes, payload + 4)
      const height = readUint24LE(bytes, payload + 7)
      if (isPositiveFinite(width) && isPositiveFinite(height)) {
        return { width: width + 1, height: height + 1 }
      }
      return null
    }
    if (fourcc === 'VP8 ') {
      if (asciiAt(bytes, payload + 3, 1) === null) return null
      const hasStartCode =
        bytes[payload + 3] === 0x9d && bytes[payload + 4] === 0x01 && bytes[payload + 5] === 0x2a
      if (!hasStartCode) return null
      const width = readUint16LE(view, payload + 6)
      const height = readUint16LE(view, payload + 8)
      if (!isPositiveFinite(width) || !isPositiveFinite(height)) return null
      return { width: width & 0x3fff, height: height & 0x3fff }
    }
    if (fourcc === 'VP8L') {
      if (bytes[payload] !== 0x2f) return null
      const packed = readUint32LE(view, payload + 1)
      if (!isPositiveFinite(packed)) return null
      return { width: (packed & 0x3fff) + 1, height: ((packed >> 14) & 0x3fff) + 1 }
    }
    // 未知 chunk：跳过（chunk 之间按偶数对齐）
    offset = payload + size + (size % 2)
  }
  return null
}

const parseImageDimensions = (bytes: Uint8Array, mimeType: string | null): Dimensions | null => {
  const view = toView(bytes)
  if (mimeType === 'image/png' || matchSignature(bytes, PNG_SIGNATURE)) return parsePng(bytes, view)
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') return parseJpeg(bytes, view)
  if (mimeType === 'image/gif') return parseGif(bytes, view)
  if (mimeType === 'image/webp') return parseWebp(bytes, view)
  return parsePng(bytes, view) || parseJpeg(bytes, view) || parseGif(bytes, view) || parseWebp(bytes, view)
}

// ---------------------------------------------------------------------------
// 视频（MP4 / MOV）
// ---------------------------------------------------------------------------

interface BoxRange {
  /** 载荷（box header 之后）起点 */
  start: number
  /** box 结束位置（不含） */
  end: number
  type: string
}

const readBoxHeader = (bytes: Uint8Array, view: DataView, offset: number, limit: number): BoxRange | null => {
  if (offset + 8 > limit) return null
  const type = asciiAt(bytes, offset + 4, 4)
  if (!type) return null
  let size = readUint32BE(view, offset)
  let headerSize = 8
  if (size === 1) {
    size = readUint64BE(view, offset + 8)
    headerSize = 16
  }
  if (!isPositiveFinite(size)) return null
  const end = offset + size
  if (end > limit || end < offset + headerSize) return null
  return { start: offset + headerSize, end, type }
}

/** 顺序遍历 [start, end) 内的同级 box（不做递归） */
const walkBoxes = (bytes: Uint8Array, view: DataView, start: number, end: number, visit: (box: BoxRange) => void) => {
  let offset = start
  while (offset + 8 <= end) {
    const box = readBoxHeader(bytes, view, offset, end)
    if (!box) return
    visit(box)
    offset = box.end
  }
}

/**
 * 找 `moov` 载荷区间。
 *
 * 两条路都要走：
 *   1. 从第一个 box 顺序找（`ftyp` 在前、`moov` 在头部时的 fast-start 文件，即「从 ftyp 起找 moov」）；
 *   2. 尾部片段没有 `ftyp`、开头就是 `mdat` 中段时，顺序遍历第一步就会断 —— 改为直接扫 `moov` 四字码，
 *      用其前面 4 字节当 box 大小校验（moov 在文件尾部是绝大多数录制/转码产物的形态）。
 */
const findMoov = (bytes: Uint8Array, view: DataView): BoxRange | null => {
  let walked: BoxRange | null = null
  walkBoxes(bytes, view, 0, bytes.length, (box) => {
    if (!walked && box.type === 'moov') walked = box
  })
  if (walked) return walked

  for (let offset = 4; offset + 8 <= bytes.length; offset += 1) {
    if (asciiAt(bytes, offset, 4) !== 'moov') continue
    const box = readBoxHeader(bytes, view, offset - 4, bytes.length)
    if (box?.type === 'moov') return box
  }
  return null
}

const readMvhdDuration = (bytes: Uint8Array, view: DataView, moov: BoxRange): number | undefined => {
  let found: number | undefined
  walkBoxes(bytes, view, moov.start, moov.end, (box) => {
    if (found !== undefined || box.type !== 'mvhd') return
    const version = bytes[box.start]
    const timescale = version === 1 ? readUint32BE(view, box.start + 20) : readUint32BE(view, box.start + 12)
    const duration = version === 1 ? readUint64BE(view, box.start + 24) : readUint32BE(view, box.start + 16)
    if (!isPositiveFinite(timescale) || !isPositiveFinite(duration)) return
    const seconds = duration / timescale
    if (isPositiveFinite(seconds)) found = seconds
  })
  return found
}

/** 从 tkhd 取画面尺寸：宽高是 16.16 定点，整数部分才是像素数（比 mvhd 里那个比例值准） */
const readTkhdDimensions = (bytes: Uint8Array, view: DataView, moov: BoxRange): Dimensions | null => {
  let dimensions: Dimensions | null = null
  walkBoxes(bytes, view, moov.start, moov.end, (trak) => {
    if (dimensions || trak.type !== 'trak') return
    walkBoxes(bytes, view, trak.start, trak.end, (child) => {
      if (dimensions || child.type !== 'tkhd') return
      const version = bytes[child.start]
      const widthOffset = version === 1 ? 88 : 76
      const rawWidth = readUint32BE(view, child.start + widthOffset)
      const rawHeight = readUint32BE(view, child.start + widthOffset + 4)
      if (rawWidth === null || rawHeight === null) return
      const width = Math.round(rawWidth / 65536)
      const height = Math.round(rawHeight / 65536)
      // 纯音频轨的 tkhd 宽高为 0，跳过它去找视频轨
      if (width > 0 && height > 0) dimensions = { width, height }
    })
  })
  return dimensions
}

const parseMp4 = (bytes: Uint8Array): { dimensions: Dimensions | null; durationSeconds?: number } | null => {
  const view = toView(bytes)
  const moov = findMoov(bytes, view)
  if (!moov) return null
  return { dimensions: readTkhdDimensions(bytes, view, moov), durationSeconds: readMvhdDuration(bytes, view, moov) }
}

// ---------------------------------------------------------------------------
// 音频
// ---------------------------------------------------------------------------

const parseWavDuration = (bytes: Uint8Array, view: DataView): number | undefined => {
  if (asciiAt(bytes, 0, 4) !== 'RIFF' || asciiAt(bytes, 8, 4) !== 'WAVE') return undefined
  let byteRate: number | null = null
  let dataSize: number | null = null
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const fourcc = asciiAt(bytes, offset, 4)
    const size = readUint32LE(view, offset + 4)
    if (!isPositiveFinite(size)) return undefined
    const payload = offset + 8
    if (fourcc === 'fmt ') {
      // audioFormat(2) 声道(2) 采样率(4) byteRate(4) —— byteRate 在载荷偏移 8
      byteRate = readUint32LE(view, payload + 8)
    } else if (fourcc === 'data') {
      dataSize = size
      break
    }
    offset = payload + size + (size % 2)
  }
  if (!isPositiveFinite(byteRate) || !isPositiveFinite(dataSize)) return undefined
  const seconds = dataSize / byteRate
  return isPositiveFinite(seconds) ? seconds : undefined
}

const MP3_BITRATES: Record<string, readonly number[]> = {
  // 索引 0 是 free，占位 0
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}
const MP3_SAMPLE_RATES: Record<string, readonly number[]> = {
  '1': [44100, 48000, 32000],
  '2': [22050, 24000, 16000],
  '25': [11025, 12000, 8000],
}

interface Mp3Frame {
  offset: number
  versionKey: '1' | '2' | '25'
  layer: 1 | 2 | 3
  bitrate: number
  sampleRate: number
  padding: number
}

/** 在头部字节里找第一个合法 MP3 帧头（FF Ex），返回帧起始偏移与参数 */
const findMp3Frame = (bytes: Uint8Array, start: number): Mp3Frame | null => {
  for (let offset = Math.max(0, start); offset + 4 <= bytes.length; offset += 1) {
    if (bytes[offset] !== 0xff) continue
    const b1 = bytes[offset + 1]
    if ((b1 & 0xe0) !== 0xe0) continue
    const versionBits = (b1 >> 3) & 0x3
    const layerBits = (b1 >> 1) & 0x3
    if (versionBits === 1 || layerBits === 0) continue
    const b2 = bytes[offset + 2]
    const bitrateIndex = (b2 >> 4) & 0xf
    const sampleRateIndex = (b2 >> 2) & 0x3
    if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) continue
    const versionKey = versionBits === 3 ? '1' : versionBits === 2 ? '2' : '25'
    const layer = (4 - layerBits) as 1 | 2 | 3
    const rateKey = `${versionKey}-${layer}`
    const bitrateTable = MP3_BITRATES[rateKey] ?? MP3_BITRATES['1-3']
    const sampleRateTable = MP3_SAMPLE_RATES[versionKey]
    const bitrate = bitrateTable[bitrateIndex] * 1000
    const sampleRate = sampleRateTable[sampleRateIndex]
    if (!isPositiveFinite(bitrate) || !isPositiveFinite(sampleRate)) continue
    return { offset, versionKey, layer, bitrate, sampleRate, padding: (b2 >> 1) & 1 }
  }
  return null
}

const parseMp3Duration = (bytes: Uint8Array, view: DataView, totalByteSize: number): number | undefined => {
  let searchFrom = 0
  // 跳过 ID3v2 标签（`ID3` + 版本(2) + 标志(1) + 同步安全大小(4)）
  if (asciiAt(bytes, 0, 3) === 'ID3') {
    const size =
      ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f)
    const hasFooter = (bytes[5] & 0x10) !== 0
    searchFrom = 10 + size + (hasFooter ? 10 : 0)
  }
  const frame = findMp3Frame(bytes, searchFrom)
  if (!frame) return undefined

  const samplesPerFrame = frame.layer === 1 ? 384 : frame.layer === 2 ? 1152 : frame.versionKey === '1' ? 1152 : 576
  // Xing/Info 头（VBR）：侧信息之后紧跟 `Xing`/`Info`，能拿到精确帧数
  const xingOffset = frame.offset + (frame.versionKey === '1' && frame.layer === 3 ? 36 : frame.layer === 1 ? 17 : 21)
  const tag = asciiAt(bytes, xingOffset, 4)
  if (tag === 'Xing' || tag === 'Info') {
    const flags = readUint32BE(view, xingOffset + 4)
    if (flags !== null && (flags & 0x1) !== 0) {
      const frameCount = readUint32BE(view, xingOffset + 8)
      if (isPositiveFinite(frameCount)) {
        const seconds = (frameCount * samplesPerFrame) / frame.sampleRate
        if (isPositiveFinite(seconds)) return seconds
      }
    }
  }

  // 回退：CBR 估算（总大小 × 8 / 比特率），去掉 ID3v2 与可能的 ID3v1 尾标签（128 字节）
  const id3v1 = asciiAt(bytes, totalByteSize - 128, 3) === 'TAG' ? 128 : 0
  const audioBytes = totalByteSize - searchFrom - id3v1
  if (!isPositiveFinite(audioBytes)) return undefined
  const seconds = (audioBytes * 8) / frame.bitrate
  return isPositiveFinite(seconds) ? seconds : undefined
}

// ---------------------------------------------------------------------------
// MIME 识别与入口
// ---------------------------------------------------------------------------

const normalizeMimeType = (value: string | null | undefined): string | null => {
  const normalized = String(value ?? '').trim().toLowerCase().split(';')[0].trim()
  if (!normalized) return null
  if (normalized === 'image/jpg') return 'image/jpeg'
  if (normalized === 'audio/mp3' || normalized === 'audio/x-mpeg') return 'audio/mpeg'
  return normalized
}

const detectMimeType = (bytes: Uint8Array): string | null => {
  if (matchSignature(bytes, PNG_SIGNATURE)) return 'image/png'
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  const gif = asciiAt(bytes, 0, 6)
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif'
  if (asciiAt(bytes, 0, 4) === 'RIFF') {
    const format = asciiAt(bytes, 8, 4)
    if (format === 'WEBP') return 'image/webp'
    if (format === 'WAVE') return 'audio/wav'
  }
  if (asciiAt(bytes, 4, 4) === 'ftyp') {
    const brand = asciiAt(bytes, 8, 4)
    if (brand === 'qt  ') return 'video/quicktime'
    return 'video/mp4'
  }
  /*
   * 只认 ID3 头，**不再对任意字节扫描帧同步**（2026-09-27 收紧）。
   * 原因同上：帧同步只有 11 位，在随机字节里误命中率不低，而一旦误判就会用
   * 「比特率 × 文件大小」编出一个看似合理的假时长 —— 这比"量不到"危险得多。
   * 没有 ID3 的 MP3 由调用方按扩展名给出 `audio/mpeg` 提示即可（见上面的优先级）。
   */
  if (asciiAt(bytes, 0, 3) === 'ID3') return 'audio/mpeg'
  return null
}

const isImageMime = (mimeType: string | null) => Boolean(mimeType?.startsWith('image/'))
const isVideoMime = (mimeType: string | null) =>
  mimeType === 'video/mp4' || mimeType === 'video/quicktime' || mimeType === 'video/mov'

/**
 * 把一段字节解析成产物元数据。**不抛异常**：读不到的字段直接不出现。
 *
 * @param bytes 文件字节（可以是整份，也可以是 Remote Range 取来的头部/尾部件）
 * @param mimeType 已知 MIME（可空；会与字节魔数交叉判断）
 * @param options.totalByteSize 文件真实总大小（远程只取了一段时必传，否则 MP3 估算会按片段大小算）
 */
export const parseArtifactMetadata = (
  bytes: Uint8Array,
  mimeType?: string | null,
  options?: ParseArtifactMetadataOptions,
): ArtifactMetadata => {
  const byteSize = isPositiveFinite(options?.totalByteSize) ? Math.trunc(options.totalByteSize) : bytes.byteLength
  const detected = detectMimeType(bytes)
  /*
   * **已知 MIME 优先，嗅探只作兜底**（2026-09-27 修）。
   *
   * 反过来的写法（`detected || hint`）踩过一个真坑：探测层读 MP4 的**尾部**片段时明明传了
   * `video/mp4`，却被字节嗅探盖成了 `audio/mpeg` —— 尾部是随机字节，MP3 的帧同步扫描在其中
   * 误命中了一个假同步头，于是走 MP3 估算，把 45MB 的 MP4 算成 **5673 秒（94 分钟）**。
   * 调用方是从扩展名/响应头知道类型的，比"拿一段字节猜"可靠得多。
   * 只有未知或通用类型（octet-stream）才交给嗅探。
   */
  const hinted = normalizeMimeType(mimeType)
  const hintIsGeneric = !hinted || hinted === 'application/octet-stream' || hinted === 'binary/octet-stream'
  const effective = hintIsGeneric ? (detected || hinted) : hinted
  const result: ArtifactMetadata = { byteSize }
  if (effective) result.mimeType = effective

  if (isImageMime(effective)) {
    const dimensions = parseImageDimensions(bytes, effective)
    if (dimensions) {
      result.width = dimensions.width
      result.height = dimensions.height
    }
    return result
  }

  if (isVideoMime(effective)) {
    const video = parseMp4(bytes)
    if (video?.dimensions) {
      result.width = video.dimensions.width
      result.height = video.dimensions.height
    }
    if (isPositiveFinite(video?.durationSeconds)) result.durationSeconds = video.durationSeconds
    return result
  }

  if (effective === 'audio/wav') {
    const durationSeconds = parseWavDuration(bytes, toView(bytes))
    if (isPositiveFinite(durationSeconds)) result.durationSeconds = durationSeconds
    return result
  }

  if (effective === 'audio/mpeg') {
    const durationSeconds = parseMp3Duration(bytes, toView(bytes), byteSize)
    if (isPositiveFinite(durationSeconds)) {
      result.durationSeconds = durationSeconds
      // MP3 拿不到绝对总长（除非有 Xing 帧数），一律标注为估算
      result.durationEstimated = true
    }
    return result
  }

  return result
}
