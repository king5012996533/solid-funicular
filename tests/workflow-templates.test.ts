/**
 * 工作流模板结构验证
 *
 * 改造的核心承诺之一：模板里不该再出现 imageConfig / videoConfig 这类
 * 「只用来选参数」的中转节点，参数必须挂在生成节点自己身上。
 * 这类断言用脚本跑比点界面更可靠，也能覆盖全部 7 个模板。
 */

import { WORKFLOW_TEMPLATES } from '../src/views/workflow/config/workflows'

const ALLOWED_TYPES = new Set(['text', 'image', 'video', 'llmConfig'])
const GENERATION_TYPES = new Set(['image', 'video'])

let passed = 0
let failed = 0

function check(label: string, condition: boolean, detail = '') {
  if (condition) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    console.log(`  ❌ ${label}${detail ? `\n     ${detail}` : ''}`)
  }
}

console.log('\n【1】每个模板都不含已删除的配置节点类型')
for (const template of WORKFLOW_TEMPLATES) {
  const { nodes } = template.createNodes({ x: 0, y: 0 })
  const types = [...new Set(nodes.map(n => n.type))]
  const illegal = types.filter(t => !ALLOWED_TYPES.has(t as string))
  check(
    `${template.name}：类型 ${types.join('/')}`,
    illegal.length === 0,
    illegal.length ? `出现了不允许的类型：${illegal.join(', ')}` : '',
  )
}

console.log('\n【2】参数自洽：声明了尺寸 / 画质 / 比例，就必须也声明模型')
{
  // 注意：纯素材节点（如「产品图片」「风格参考图」）本来就不带参数，
  // 它们的模型由节点渲染时按目录默认解析，所以这里不能要求每个图片节点都有 model。
  // 真正要守住的是「不能只有半套参数」——有尺寸没模型那种。
  for (const template of WORKFLOW_TEMPLATES) {
    const { nodes } = template.createNodes({ x: 0, y: 0 })
    const generators = nodes.filter(n => GENERATION_TYPES.has(n.type as string))
    const incoherent = generators.filter(n => {
      const data = (n.data || {}) as Record<string, unknown>
      const hasAnyParam = ['size', 'quality', 'ratio', 'resolution'].some(key => data[key])
      return hasAnyParam && !data.model
    })
    check(
      `${template.name}：${generators.length} 个生成节点参数自洽`,
      incoherent.length === 0,
      incoherent.length ? `有参数但没模型：${incoherent.map(n => n.id).join(', ')}` : '',
    )
  }
}

console.log('\n【2b】带提示词输入的生成节点必须声明模型')
for (const template of WORKFLOW_TEMPLATES) {
  const { nodes, edges } = template.createNodes({ x: 0, y: 0 })
  const typeById = new Map(nodes.map(n => [n.id, n.type as string]))
  const promptTargets = new Set(
    edges.filter(e => e.type === 'promptOrder').map(e => e.target),
  )
  const missing = nodes.filter(n =>
    promptTargets.has(n.id)
    && GENERATION_TYPES.has(n.type as string)
    && !(n.data || {}).model,
  )
  check(
    `${template.name}：受提示词驱动的生成节点都有模型`,
    missing.length === 0,
    missing.length ? `缺失：${missing.map(n => n.id).join(', ')}` : '',
  )
}

console.log('\n【3】每条边都指向真实存在的节点（没有悬空连线）')
for (const template of WORKFLOW_TEMPLATES) {
  const { nodes, edges } = template.createNodes({ x: 0, y: 0 })
  const ids = new Set(nodes.map(n => n.id))
  const dangling = edges.filter(e => !ids.has(e.source) || !ids.has(e.target))
  check(
    `${template.name}：${edges.length} 条边都有效`,
    dangling.length === 0,
    dangling.length ? `悬空：${dangling.map(e => `${e.source}->${e.target}`).join(', ')}` : '',
  )
}

console.log('\n【4】显式标了 promptOrder 的连线，目标必须是能消费提示词的节点')
{
  // 只检查显式 promptOrder 的边。模板里「产品信息 → 各提示词」那种文本到文本的
  // 上下文边是不带类型的普通边，不在此列。
  for (const template of WORKFLOW_TEMPLATES) {
    const { nodes, edges } = template.createNodes({ x: 0, y: 0 })
    const typeById = new Map(nodes.map(n => [n.id, n.type as string]))
    const promptEdges = edges.filter(e => e.type === 'promptOrder')
    const badHops = promptEdges.filter(e => {
      const targetType = typeById.get(e.target)
      return targetType !== 'image' && targetType !== 'video' && targetType !== 'llmConfig'
    })
    check(
      `${template.name}：${promptEdges.length} 条 promptOrder 连线目标合法`,
      badHops.length === 0,
      badHops.length ? `异常：${badHops.map(e => `${e.source}(${typeById.get(e.source)})->${e.target}(${typeById.get(e.target)})`).join(', ')}` : '',
    )
  }
}

console.log('\n【5】文生图基础：就是 文本 → 图片 两步')
{
  const template = WORKFLOW_TEMPLATES.find(t => t.id === 'text-to-image-basic')
  const { nodes, edges } = template?.createNodes({ x: 0, y: 0 }) ?? { nodes: [], edges: [] }
  check('只有 2 个节点', nodes.length === 2, `实际 ${nodes.length}：${nodes.map(n => n.type).join(', ')}`)
  check('类型是 text + image', nodes.map(n => n.type).sort().join(',') === 'image,text')
  check('只有 1 条边', edges.length === 1)
  check('边是 promptOrder', edges[0]?.type === 'promptOrder')
}

console.log('\n【6】图生视频：视频节点的输入来自图片（imageRole）')
{
  const template = WORKFLOW_TEMPLATES.find(t => t.id === 'image-to-video')
  const { nodes, edges } = template?.createNodes({ x: 0, y: 0 }) ?? { nodes: [], edges: [] }
  const videoNode = nodes.find(n => n.type === 'video')
  const roleEdge = edges.find(e => e.target === videoNode?.id && e.type === 'imageRole')
  check('存在视频节点', !!videoNode)
  check('视频节点由图片喂入', !!roleEdge, `边：${edges.map(e => `${e.source}->${e.target}(${e.type})`).join(', ')}`)
  check('图片角色是首帧', (roleEdge?.data as { imageRole?: string })?.imageRole === 'first_frame_image')
}

console.log('\n【7】所有模板的 id 唯一')
{
  const ids = WORKFLOW_TEMPLATES.map(t => t.id)
  check(`${ids.length} 个模板 id 不重复`, new Set(ids).size === ids.length)
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
