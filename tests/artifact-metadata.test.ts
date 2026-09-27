/**
 * 产物元数据解析单测（纯函数，零 IO，2026-09-27）
 *
 * 为什么值得单独钉死：`GenerationOutputPayload` 的 width/height/durationSeconds 字段一直
 * 没人填（记录里永远是空），这次要把真实值填进去。解析器一旦「编数字」，比留空更糟 ——
 * 用户会看到「明明是 30 秒的视频，记录写成 20 秒」。所以这里钉死两条：
 *   1. 各种真实格式的最小字节头都能读出正确的宽高/时长；
 *   2. **解析不出来就不许编**：垃圾字节、截断字节一律不产生任何尺寸/时长。
 *
 * 夹具全部在测试里**手拼字节**（不依赖网络文件、不读磁盘）：
 *   · PNG —— 8 字节签名 + IHDR
 *   · JPEG —— FF D8 + SOF0 段
 *   · GIF —— GIF89a + 逻辑屏幕宽高
 *   · WAV —— RIFF/WAVE + fmt /data
 *   · MP4 —— ftyp + moov(mvhd + trak/tkhd)，并单独喂「只有尾部 moov」的片段验证尾部重试路径
 *
 * 跑法：npx tsx tests/artifact-metadata.test.ts（由 npm run test:unit 统一跑）
 */

import { parseArtifactMetadata } from '../server/media/artifact-metadata'

let passed = 0
let failed = 0

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    console.log(`  ❌ ${label}\n     期望 ${e}\n     实际 ${a}`)
  }
}

console.log('产物元数据解析：')

// ---------------------------------------------------------------------------
// 字节拼装工具
// ---------------------------------------------------------------------------
const u16be = (v: number) => [(v >> 8) & 0xff, v & 0xff]
const u32be = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
const u16le = (v: number) => [v & 0xff, (v >> 8) & 0xff]
const u32le = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0))

// PNG：签名 + 长度(13) + IHDR + 宽(4) + 高(4)
const buildPng = (width: number, height: number) =>
  new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...u32be(13), ...ascii('IHDR'), ...u32be(width), ...u32be(height),
    0x08, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ])

// JPEG：FF D8 + SOF0（段长 17，精度 08，高 2，宽 2，分量 3）+ SOS 截断
const buildJpeg = (width: number, height: number) =>
  new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08, ...u16be(height), ...u16be(width), 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xda, 0x00, 0x0c,
  ])

const buildGif = (width: number, height: number) =>
  new Uint8Array([...ascii('GIF89a'), ...u16le(width), ...u16le(height), 0x00, 0x00, 0x00])

// WEBP：RIFF + VP8X（canvas 宽-1、高-1 各 3 字节小端）
const buildWebp = (width: number, height: number) => {
  const u24le = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff]
  const payload = [0x00, 0x00, 0x00, 0x00, ...u24le(width - 1), ...u24le(height - 1)]
  return new Uint8Array([...ascii('RIFF'), ...u32le(4 + 8 + payload.length), ...ascii('WEBP'), ...ascii('VP8X'), ...u32le(payload.length), ...payload])
}

// WAV：RIFF/WAVE + fmt (byteRate @ 载荷偏移 8) + data(size)
const buildWav = (byteRate: number, dataSize: number) =>
  new Uint8Array([
    ...ascii('RIFF'), ...u32le(36 + dataSize), ...ascii('WAVE'),
    ...ascii('fmt '), ...u32le(16),
    ...u16le(1), ...u16le(1), ...u32le(byteRate / 2), ...u32le(byteRate), ...u16le(2), ...u16le(16),
    ...ascii('data'), ...u32le(dataSize),
    ...new Array(64).fill(0),
  ])

// MP4 盒：size(4) + type(4) + payload
const box = (type: string, payload: number[]) => [...u32be(8 + payload.length), ...ascii(type), ...payload]

const buildMvhd = (timescale: number, duration: number) =>
  box('mvhd', [0, 0, 0, 0, ...u32be(0), ...u32be(0), ...u32be(timescale), ...u32be(duration), ...new Array(80).fill(0)])

const buildTkhd = (width: number, height: number) => {
  const payload = new Array(84).fill(0)
  const fixedW = Math.round(width * 65536)
  const fixedH = Math.round(height * 65536)
  payload.splice(76, 4, ...u32be(fixedW))
  payload.splice(80, 4, ...u32be(fixedH))
  return box('tkhd', payload)
}

const buildMoov = (timescale: number, duration: number, width: number, height: number) =>
  box('moov', [...buildMvhd(timescale, duration), ...box('trak', buildTkhd(width, height))])

// fast-start：ftyp 在前、moov 紧随
const buildFastStartMp4 = (timescale: number, duration: number, width: number, height: number) =>
  new Uint8Array([...box('ftyp', [...ascii('isom'), 0, 0, 0, 0]), ...buildMoov(timescale, duration, width, height)])

// ---------------------------------------------------------------------------
// PNG / JPEG / GIF / WEBP
// ---------------------------------------------------------------------------
const png = parseArtifactMetadata(buildPng(512, 256))
check('PNG：IHDR 读出宽高', [png.width, png.height], [512, 256])
check('PNG：魔数识别出 mime', png.mimeType, 'image/png')
check('PNG：byteSize 是入参字节长度', png.byteSize, buildPng(512, 256).length)

const jpeg = parseArtifactMetadata(buildJpeg(96, 64))
check('JPEG：扫 SOF0 读出宽高', [jpeg.width, jpeg.height], [96, 64])
check('JPEG：魔数识别出 mime', jpeg.mimeType, 'image/jpeg')

const gif = parseArtifactMetadata(buildGif(320, 240))
check('GIF：逻辑屏幕读出宽高', [gif.width, gif.height], [320, 240])
check('GIF：mime', gif.mimeType, 'image/gif')

const webp = parseArtifactMetadata(buildWebp(1024, 768))
check('WEBP：VP8X 读出宽高', [webp.width, webp.height], [1024, 768])
check('WEBP：mime', webp.mimeType, 'image/webp')

check('只给 mime（字节不含魔数时按 mime 认格式）', parseArtifactMetadata(buildPng(8, 9), 'image/png').height, 9)

// ---------------------------------------------------------------------------
// WAV / MP3
// ---------------------------------------------------------------------------
const wav = parseArtifactMetadata(buildWav(16000, 16000))
check('WAV：data 大小 / byteRate 算出时长', wav.durationSeconds, 1)
check('WAV：mime', wav.mimeType, 'audio/wav')

// MPEG1 Layer3 128kbps 44.1kHz 帧头；总大小 16000 字节 → 估算 1 秒
const mp3 = parseArtifactMetadata(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), 'audio/mpeg', { totalByteSize: 16000 })
check('MP3：首帧头 + 总大小估算时长', mp3.durationSeconds, 1)
check('MP3：时长标注为估算', mp3.durationEstimated, true)
check('MP3：mime', mp3.mimeType, 'audio/mpeg')

// ---------------------------------------------------------------------------
// MP4 / MOV
// ---------------------------------------------------------------------------
const mp4 = parseArtifactMetadata(buildFastStartMp4(1000, 30000, 1920, 1080))
check('MP4：mvhd 的 timescale+duration 算出 30 秒（不是被夹小的 20）', mp4.durationSeconds, 30)
check('MP4：tkhd 读出画面宽高（16.16 定点取整数部分）', [mp4.width, mp4.height], [1920, 1080])
check('MP4：mime', mp4.mimeType, 'video/mp4')

// 尾部 moov（非 fast-start）：只给 moov 那一段，走四字码扫描重试路径
const tailOnly = parseArtifactMetadata(new Uint8Array(buildMoov(600, 18000, 720, 1280)), 'video/mp4')
check('MP4 尾部：只给 moov 片段也能读出（尾部重试路径）', [tailOnly.durationSeconds, tailOnly.width, tailOnly.height], [30, 720, 1280])

check('byteSize 用 totalByteSize（远程只取了一段时的真实大小）',
  parseArtifactMetadata(new Uint8Array(buildMoov(600, 18000, 720, 1280)), 'video/mp4', { totalByteSize: 45678901 }).byteSize,
  45678901)

// ---------------------------------------------------------------------------
// 反证：解析不出来就不许编
// ---------------------------------------------------------------------------
console.log('\n反证（这些断言必须成立，证明解析器不是「怎么读都编一个数字」）：')
let reverseFailed = 0
const reverseAssert = (label: string, condition: boolean) => {
  if (condition) {
    reverseFailed++
    console.log(`  ❌ 反证未生效：${label}`)
  } else {
    passed++
    console.log(`  ✅ 反证成立：${label}`)
  }
}

const garbage = parseArtifactMetadata(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
reverseAssert('垃圾字节不会凭空造出宽高', garbage.width !== undefined || garbage.height !== undefined)
reverseAssert('垃圾字节不会凭空造出时长', garbage.durationSeconds !== undefined)

const truncatedPng = parseArtifactMetadata(buildPng(512, 256).subarray(0, 14))
reverseAssert('截断的 PNG 不会拿残缺字节硬凑宽高', truncatedPng.width !== undefined || truncatedPng.height !== undefined)

// mime 说是视频但字节是垃圾：不许编时长/宽高
const fakeVideo = parseArtifactMetadata(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]), 'video/mp4')
reverseAssert('声称是视频但没有 moov → 不编时长', fakeVideo.durationSeconds !== undefined)
reverseAssert('声称是视频但没有 moov → 不编宽高', fakeVideo.width !== undefined || fakeVideo.height !== undefined)

// 反证成立还不够：得保证「正常输入确实读出了值」，否则上面这些靠「全都不给」也能过
reverseAssert('如果 30 秒 MP4 读不出 30，说明解析器其实没在工作',
  parseArtifactMetadata(buildFastStartMp4(1000, 30000, 1920, 1080)).durationSeconds !== 30)
check('反证组本身没有意外失败（应为 0）', reverseFailed, 0)

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
