/**
 * 节点输入需求规则的验证
 *
 * 这段逻辑决定界面上那句「已连接 XX」/「请连接 XX」到底怎么说。
 * 之前的实现是一句写死的「已连接参考图片」，不管上游连的是文本还是图片 ——
 * 用户看不出还差什么才能生成。所以这里要守住的核心不变式是：
 *   **界面说的必须等于上游真实产出的内容**，连了边但上游没出图，不能算已连接。
 */

import {
  NODE_INPUT_SPECS,
  collectUpstreamKinds,
  deriveNodeInputState,
  readUpstreamKind,
} from '../src/views/workflow/config/node-input-rules'

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

const node = (id: string, type: string, data: Record<string, unknown> = {}) => ({ id, type, data })
const edge = (source: string, target: string) => ({ source, target })

console.log('\n【1】上游节点能给什么输入')
{
  check('文本节点有内容 → text', readUpstreamKind(node('t', 'text', { content: '一只猫' })), 'text')
  check('文本节点内容为空 → 不算已连接', readUpstreamKind(node('t', 'text', { content: '   ' })), null)
  check('LLM 节点看 outputContent', readUpstreamKind(node('l', 'llmConfig', { outputContent: '分镜脚本' })), 'text')
  check('LLM 节点只有系统提示词 → 不算已连接', readUpstreamKind(node('l', 'llmConfig', { systemPrompt: '你是导演' })), null)
  check('图片节点有 url → image', readUpstreamKind(node('i', 'image', { url: '/uploads/a.png' })), 'image')
  check('图片节点还没出图 → 不算已连接', readUpstreamKind(node('i', 'image', { url: '' })), null)
  check('视频节点有 url → video', readUpstreamKind(node('v', 'video', { url: '/uploads/a.mp4' })), 'video')
  check('未知类型 → null', readUpstreamKind(node('x', 'mystery', { url: 'a' })), null)
  check('undefined → null', readUpstreamKind(undefined), null)
}

console.log('\n【2】收集实际上游输入（只算真的产出了内容的）')
{
  const nodes = [
    node('t', 'text', { content: '一只猫' }),
    node('i', 'image', { url: '/uploads/a.png' }),
    node('i2', 'image', { url: '' }),
    node('target', 'image', {}),
    node('other', 'image', {}),
  ]
  const edges = [
    edge('t', 'target'),
    edge('i', 'target'),
    edge('i2', 'target'),   // 上游还没出图，不该算
    edge('other', 'i'),     // 与 target 无关
  ]
  check('只收集 target 的上游', collectUpstreamKinds(nodes, edges, 'target'), ['text', 'image'])
  check('多次连同一类只算一次', collectUpstreamKinds(
    [...nodes, node('t2', 'text', { content: '补充' })],
    [...edges, edge('t2', 'target')],
    'target',
  ), ['text', 'image'])
  check('没有上游 → 空', collectUpstreamKinds(nodes, edges, 'other'), [])
}

console.log('\n【3】就绪文案按实际输入拼，不再写死')
{
  const spec = NODE_INPUT_SPECS.image
  check('什么都没有 → 空串', deriveNodeInputState(spec, []).connectedLabel, '')
  check('只有文本 → 已连接提示词', deriveNodeInputState(spec, ['text']).connectedLabel, '已连接提示词')
  check('只有图片 → 已连接参考图', deriveNodeInputState(spec, ['image']).connectedLabel, '已连接参考图')
  check('两者都有 → 用「与」连接', deriveNodeInputState(spec, ['text', 'image']).connectedLabel, '已连接提示词与参考图')
  check('顺序固定为 text → image → video', deriveNodeInputState(spec, ['image', 'text']).connectedLabel, '已连接提示词与参考图')
  check('空态文案按类型给', deriveNodeInputState(spec, []).emptyLabel, NODE_INPUT_SPECS.image.emptyHint)
}

console.log('\n【4】视频节点声明与图片节点不同')
{
  check('视频节点的空态与图片节点不同', NODE_INPUT_SPECS.video.emptyHint !== NODE_INPUT_SPECS.image.emptyHint, true)
  check('视频节点空态提到首帧', /首帧/.test(NODE_INPUT_SPECS.video.emptyHint), true)
  check('文本节点不消费上游', NODE_INPUT_SPECS.text.optional, [])
  check('文本节点空态不提连接', /连接/.test(NODE_INPUT_SPECS.text.emptyHint), false)
}

console.log('\n【5】required 缺失会反映到 ready 上（当前四类都没有必需输入）')
{
  const strict = { required: ['image'] as const, optional: [], emptyHint: '请连接图片节点' }
  check('缺必需输入 → 不 ready', deriveNodeInputState({ ...strict, required: ['image'] }, ['text']).ready, false)
  check('缺必需输入 → missing 有值', deriveNodeInputState({ ...strict, required: ['image'] }, []).missing, ['image'])
  check('必需到齐 → ready', deriveNodeInputState({ ...strict, required: ['image'] }, ['image']).ready, true)
  check('四类节点的 required 都是空（空节点也能直接生成）',
    Object.values(NODE_INPUT_SPECS).every(spec => spec.required.length === 0), true)
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
