/**
 * 音频节点单测（工作包 A）
 *
 * 钉死四件事：
 *   1. **产物解析**：完成事件的 record 是外部数据（outputs / url / images 三种形状、
 *      字段可能缺、时长可能是脏值），只有真的拿到地址才算产物；拿不到就给 null，
 *      绝不让卡片显示一个「成功但没有声音」的节点。
 *   2. **格式**：mimeType 优先，其次 data URL，再次地址扩展名；认不出给空串，不瞎猜。
 *   3. **摘要文案**：`30s · mp3`，缺一段就少一段，两段都缺给空串。
 *   4. **连接规则**：文本 → 音频 有意义（音频读提示词）；图片 → 音频 **故意不允许**
 *      （音频请求体不接受图片参考）；音频 → 任何节点 都不允许（终点节点，没有消费方）。
 *      这几条是「不造没人读的边」的底线，写在兼容表里就必须在这里被看见。
 *
 * 跑法：npx tsx tests/audio-node.test.ts
 */

import {
  buildAudioRequestBody,
  formatAudioDuration,
  formatAudioSummary,
  normalizeAudioDuration,
  normalizeAudioFormat,
  readAudioCandidate,
  resolveAudioArtifact,
  resolveAudioCardState,
  resolveAudioFormat,
} from '../src/views/workflow/components/nodes/audio-node-model'
import {
  NODE_TYPE_PRESENTATION,
  getNodeTypePresentation,
  isCoherentConnection,
  suggestNodeTypes,
} from '../src/views/workflow/config/node-suggestions'
import { NODE_INPUT_SPECS } from '../src/views/workflow/config/node-input-rules'
import { resolveCardSize } from '../src/views/workflow/config/node-size'

let passed = 0
let failed = 0

// 输出统一走 process.stdout.write：新增代码里不留调试打印
const write = (line: string) => { process.stdout.write(`${line}\n`) }

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passed++
    write(`  ✅ ${label}`)
  } else {
    failed++
    write(`  ❌ ${label}\n     期望 ${e}\n     实际 ${a}`)
  }
}

write('\n【1】格式：mime 优先 → data URL → 地址扩展名')
{
  check('mimeType 优先于地址扩展名', resolveAudioFormat('https://cdn.example.com/a.mp3', 'audio/wav'), 'wav')
  check('mime 里没有的写法按原样收敛', resolveAudioFormat('u', 'audio/opus'), 'opus')
  check('data URL 的 subtype', resolveAudioFormat('data:audio/wav;base64,QUJD'), 'wav')
  check('data URL 的 audio/mpeg 归一成 mp3', resolveAudioFormat('data:audio/mpeg;base64,QUJD'), 'mp3')
  check('mp3 扩展名', resolveAudioFormat('https://cdn.example.com/a.mp3'), 'mp3')
  check('本站产物路径', resolveAudioFormat('/uploads/generated/audio/1758900000-abcd.wav'), 'wav')
  check('查询串里的点号不算扩展名', resolveAudioFormat('https://cdn.example.com/a.mp3?v=1.2'), 'mp3')
  check('哈希里的点号不算扩展名', resolveAudioFormat('/uploads/generated/audio/a.wav#t=1.5'), 'wav')
  check('没有扩展名就认不出（给空串，不瞎猜）', resolveAudioFormat('https://gateway.example.com/audio/abc123'), '')
  check('空地址给空串', resolveAudioFormat(''), '')
  check('大写扩展名归一', resolveAudioFormat('https://cdn.example.com/A.MP3'), 'mp3')

  check('normalizeAudioFormat：大小写与点', [normalizeAudioFormat('MP3'), normalizeAudioFormat('.WAV')], ['mp3', 'wav'])
  check('normalizeAudioFormat：mime 也认', normalizeAudioFormat('audio/mpeg'), 'mp3')
  check('normalizeAudioFormat：空值给空串', [normalizeAudioFormat(''), normalizeAudioFormat(null)], ['', ''])
}

write('\n【2】时长：只认有限的正数，脏值当「没带」')
{
  check('正常数字', normalizeAudioDuration(30), 30)
  check('数字字符串', normalizeAudioDuration('12.5'), 12.5)
  check('0 不算时长', normalizeAudioDuration(0), 0)
  check('负数不算时长', normalizeAudioDuration(-3), 0)
  check('非数字不算时长', normalizeAudioDuration('abc'), 0)
  check('undefined / null 给 0', [normalizeAudioDuration(undefined), normalizeAudioDuration(null)], [0, 0])
  check('文案：30 → 30s', formatAudioDuration(30), '30s')
  check('文案：没有时长给空串', formatAudioDuration(0), '')
}

write('\n【3】产物解析：outputs / url / images 三种形状')
{
  check('outputs 带 mime 与时长',
    resolveAudioArtifact({
      outputs: [{ outputType: 'audio', url: 'https://cdn.example.com/a.wav', mimeType: 'audio/wav', durationSeconds: 30 }],
    }),
    { url: 'https://cdn.example.com/a.wav', duration: 30, format: 'wav' })

  check('产物没带时长时用节点记的时长',
    resolveAudioArtifact({ outputs: [{ outputType: 'audio', url: '/uploads/generated/audio/a.mp3' }] }, 12),
    { url: '/uploads/generated/audio/a.mp3', duration: 12, format: 'mp3' })

  check('时长是脏值时同样回落到节点时长',
    resolveAudioArtifact({ outputs: [{ outputType: 'audio', url: '/uploads/generated/audio/a.mp3', durationSeconds: 'unknown' }] }, 15),
    { url: '/uploads/generated/audio/a.mp3', duration: 15, format: 'mp3' })

  check('产物自己带的时长优先于节点时长',
    resolveAudioArtifact({ outputs: [{ outputType: 'audio', url: 'a.mp3', durationSeconds: 60 }] }, 5),
    { url: 'a.mp3', duration: 60, format: 'mp3' })

  check('多种产物混合时优先 outputType=audio 的那条',
    resolveAudioArtifact({
      outputs: [
        { outputType: 'image', url: 'https://cdn.example.com/preview.png' },
        { outputType: 'audio', url: 'https://cdn.example.com/real.mp3' },
      ],
    }),
    { url: 'https://cdn.example.com/real.mp3', duration: 0, format: 'mp3' })

  check('没有 outputType 标记时按顺序取第一条有地址的',
    resolveAudioArtifact({ outputs: [{ url: 'https://cdn.example.com/only.mp3' }] }, 8),
    { url: 'https://cdn.example.com/only.mp3', duration: 8, format: 'mp3' })

  check('没有 url 的产物条目被跳过',
    resolveAudioArtifact({ outputs: [{ outputType: 'audio', url: '' }, { url: 'b.wav' }] }),
    { url: 'b.wav', duration: 0, format: 'wav' })

  check('record.url 兜底', resolveAudioArtifact({ url: '/uploads/generated/audio/c.ogg' }),
    { url: '/uploads/generated/audio/c.ogg', duration: 0, format: 'ogg' })

  check('record.images 兜底（老形状）', resolveAudioArtifact({ images: ['/uploads/generated/audio/d.m4a'] }),
    { url: '/uploads/generated/audio/d.m4a', duration: 0, format: 'm4a' })

  check('内联 b64 地址', resolveAudioArtifact({ outputs: [{ outputType: 'audio', url: 'data:audio/wav;base64,QUJD', durationSeconds: 3 }] }),
    { url: 'data:audio/wav;base64,QUJD', duration: 3, format: 'wav' })

  check('空 / 脏 record 一律 null', [
    resolveAudioArtifact(null),
    resolveAudioArtifact(undefined),
    resolveAudioArtifact({}),
    resolveAudioArtifact({ outputs: [] }),
    resolveAudioArtifact('not-an-object'),
    resolveAudioArtifact({ outputs: [{ outputType: 'audio' }] }),
  ], [null, null, null, null, null, null])

  check('readAudioCandidate 只回有地址的那条',
    readAudioCandidate({ outputs: [{ url: '' }, { url: 'ok.mp3', mimeType: 'audio/mpeg' }] }),
    { url: 'ok.mp3', mimeType: 'audio/mpeg', duration: 0 })
}

write('\n【4】卡片状态：生成中 > 失败 > 有产物 > 就绪 > 空态（与视频节点同一优先级）')
{
  check('生成中最优先', resolveAudioCardState({ loading: true, error: '旧错', url: 'a.mp3', hasUpstreamInput: true }), 'loading')
  check('失败次之', resolveAudioCardState({ error: '上游超时', url: '', hasUpstreamInput: true }), 'error')
  check('有产物', resolveAudioCardState({ url: 'a.mp3' }), 'audio')
  check('上游有内容 → 就绪', resolveAudioCardState({ hasUpstreamInput: true }), 'ready')
  check('什么都没有 → 空态', resolveAudioCardState({}), 'empty')
  check('空串地址不算有产物', resolveAudioCardState({ url: '   ' }), 'empty')
}

write('\n【5】摘要文案与请求体')
{
  check('时长 + 格式', formatAudioSummary({ duration: 30, format: 'mp3' }), '30s · mp3')
  check('只有时长', formatAudioSummary({ duration: 30 }), '30s')
  check('只有格式', formatAudioSummary({ format: 'WAV' }), 'wav')
  check('两段都没有给空串', formatAudioSummary({}), '')
  check('0 / 空格式都当没有', formatAudioSummary({ duration: 0, format: '' }), '')

  check('请求体：带时长',
    buildAudioRequestBody({ providerId: 'p1', modelKey: 'audio-1', prompt: '一段旁白', duration: '30' }),
    { providerId: 'p1', model: 'audio-1', prompt: '一段旁白', duration: 30 })
  check('请求体：没有时长就不带这个字段',
    buildAudioRequestBody({ providerId: 'p1', modelKey: 'audio-1', prompt: '一段旁白' }),
    { providerId: 'p1', model: 'audio-1', prompt: '一段旁白' })
  check('请求体：非数字时长原样保留（上游自己决定怎么解析）',
    buildAudioRequestBody({ providerId: 'p1', modelKey: 'audio-1', prompt: 'x', duration: 'auto' }),
    { providerId: 'p1', model: 'audio-1', prompt: 'x', duration: 'auto' })
}

write('\n【6】连接规则：音频是终点节点，绝不造没有消费方的边')
{
  check('文本 → 音频（音频读提示词）', isCoherentConnection('text', 'audio'), true)
  check('图片 → 音频 故意不允许（请求体不接受图片参考）', isCoherentConnection('image', 'audio'), false)
  check('素材 → 音频 同样不允许', isCoherentConnection('asset', 'audio'), false)
  check('音频 → 没有下游候选', suggestNodeTypes('audio', 'downstream'), [])
  check('音频的上游只有文本', suggestNodeTypes('audio', 'upstream'), ['text'])
  check('音频 → 任何类型都连不上（含它自己）',
    ['text', 'image', 'video', 'audio', 'asset'].map(t => isCoherentConnection('audio', t)),
    [false, false, false, false, false])
  check('任何节点 → 音频 只有文本这一条通道',
    ['text', 'image', 'video', 'audio', 'asset'].map(t => isCoherentConnection(t, 'audio')),
    [true, false, false, false, false])
}

write('\n【7】展示信息、输入声明与卡片尺寸')
{
  check('音频有展示信息', getNodeTypePresentation('audio')?.name, '音频生成')
  check('音频图标取自图标模块（非空）', !!getNodeTypePresentation('audio')?.icon, true)
  const colors = NODE_TYPE_PRESENTATION.map(item => item.color)
  check('所有节点的颜色都是 token（不写死色值）', colors.every(c => c.startsWith('var(--')), true)
  check('音频走音频专用 token', getNodeTypePresentation('audio')?.color, 'var(--brand-music)')
  check('音频的上游声明只有文本', NODE_INPUT_SPECS.audio.optional, ['text'])
  check('音频不需要任何必需输入', NODE_INPUT_SPECS.audio.required, [])
  check('音频卡片尺寸复用生成类横版档（与视频同档）',
    resolveCardSize({ type: 'audio' }), resolveCardSize({ type: 'video' }))
  check('音频卡片就是 622 × 350', resolveCardSize({ type: 'audio' }), { width: 622, height: 350 })
}

write(`\n${'─'.repeat(52)}`)
write(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
