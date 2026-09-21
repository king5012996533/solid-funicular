/**
 * 旧画布兼容迁移的验证
 *
 * 库里确实存着带 imageConfig 节点的画布（已确认过一条版本是
 * ["text", "imageConfig", "imageConfig", "text"]），类型没注册就会渲染成空壳、
 * 链路断掉。这个迁移在读取画布时把配置节点折叠掉，所以必须验证它
 * 不会把上游提示词连线弄丢、也不会把旧的 autoExecute 带进来重新触发一次生成。
 */

import { migrateLegacyConfigNodes } from '../src/views/workflow/composables/legacy-config-node-migration'
import type {
  WorkflowCanvasEdge,
  WorkflowCanvasNode,
} from '../src/views/workflow/composables/useWorkflowCanvas'

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

const node = (id: string, type: string, data: Record<string, unknown> = {}): WorkflowCanvasNode =>
  ({ id, type, position: { x: 0, y: 0 }, data }) as unknown as WorkflowCanvasNode

const edge = (id: string, source: string, target: string, extra: Partial<WorkflowCanvasEdge> = {}): WorkflowCanvasEdge =>
  ({ id, source, target, sourceHandle: 'right', targetHandle: 'left', ...extra }) as WorkflowCanvasEdge

const typeOf = (nodes: WorkflowCanvasNode[], id: string) => nodes.find(n => n.id === id)?.type
const dataOf = (nodes: WorkflowCanvasNode[], id: string) => nodes.find(n => n.id === id)?.data as Record<string, unknown>

console.log('\n【1】新形态画布：不做任何改动')
{
  const nodes = [node('t', 'text'), node('i', 'image')]
  const edges = [edge('e1', 't', 'i', { type: 'promptOrder' }) as WorkflowCanvasEdge]
  const out = migrateLegacyConfigNodes(nodes, edges)
  check('节点数不变', out.nodes.length, 2)
  check('边数不变', out.edges.length, 1)
  check('迁移计数为 0', out.migratedCount, 0)
}

console.log('\n【2】标准旧链路：文本 → 配置 → 图片，折叠成文本 → 图片')
{
  const nodes = [
    node('t', 'text', { content: '一只猫' }),
    node('cfg', 'imageConfig', { model: 'doubao-seedream-4-5-251128', size: '2048x2048', quality: 'standard' }),
    node('img', 'image', { url: '', label: '生成结果' }),
  ]
  const edges = [
    edge('e1', 't', 'cfg', { type: 'promptOrder', data: { promptOrder: 1 } }) as WorkflowCanvasEdge,
    edge('e2', 'cfg', 'img'),
  ]
  const out = migrateLegacyConfigNodes(nodes, edges)

  check('配置节点被删除', out.nodes.map(n => n.id), ['t', 'img'])
  check('上游连线改指到图片节点', out.edges.map(e => `${e.source}->${e.target}`), ['t->img'])
  check('连线类型保持 promptOrder', out.edges[0].type, 'promptOrder')
  check('提示词序号保持', (out.edges[0].data as { promptOrder: number }).promptOrder, 1)
  check('参数合并到图片节点', [dataOf(out.nodes, 'img').model, dataOf(out.nodes, 'img').size, dataOf(out.nodes, 'img').quality], ['doubao-seedream-4-5-251128', '2048x2048', 'standard'])
  check('迁移计数为 1', out.migratedCount, 1)
}

console.log('\n【3】裸配置节点（模板里的「文生图」没有下游输出节点）：原地改类型')
{
  const nodes = [
    node('t', 'text'),
    node('cfg', 'imageConfig', { model: 'm1', size: '1024x1024', autoExecute: true }),
  ]
  const edges = [edge('e1', 't', 'cfg', { type: 'promptOrder' }) as WorkflowCanvasEdge]
  const out = migrateLegacyConfigNodes(nodes, edges)

  check('节点保留', out.nodes.map(n => n.id), ['t', 'cfg'])
  check('类型变成 image', typeOf(out.nodes, 'cfg'), 'image')
  check('参数保留', dataOf(out.nodes, 'cfg').model, 'm1')
  // 关键：旧的 autoExecute / executed / outputNodeId 必须清掉，
  // 否则打开老项目会立刻自动重跑一次生成
  check('autoExecute 被清除', dataOf(out.nodes, 'cfg').autoExecute, undefined)
  check('outputNodeId 被清除', dataOf(out.nodes, 'cfg').outputNodeId, undefined)
  check('连线保持', out.edges.length, 1)
}

console.log('\n【4】图片 → 配置 → 视频：参数落到视频节点')
{
  const nodes = [
    node('img', 'image', { url: 'https://x/a.png' }),
    node('cfg', 'videoConfig', { model: 'kling-v2-master', ratio: '16x9', duration: 5 }),
    node('vid', 'video', { url: '', label: '图生视频' }),
  ]
  const edges = [
    edge('e1', 'img', 'cfg', { type: 'imageRole', data: { imageRole: 'first_frame_image' } }) as WorkflowCanvasEdge,
    edge('e2', 'cfg', 'vid'),
  ]
  const out = migrateLegacyConfigNodes(nodes, edges)

  check('配置节点被删除', out.nodes.map(n => n.id), ['img', 'vid'])
  check('图片改指视频节点', out.edges.map(e => `${e.source}->${e.target}`), ['img->vid'])
  check('imageRole 保持', (out.edges[0].data as { imageRole: string }).imageRole, 'first_frame_image')
  check('比例合并到视频节点', dataOf(out.nodes, 'vid').ratio, '16x9')
  check('时长合并到视频节点', dataOf(out.nodes, 'vid').duration, 5)
}

console.log('\n【5】下游已有参数的优先，不被上游配置覆盖')
{
  const nodes = [
    node('t', 'text'),
    node('cfg', 'imageConfig', { model: 'old-model', size: '1024x1024' }),
    node('img', 'image', { model: 'newer-model', url: 'https://x/b.png' }),
  ]
  const edges = [edge('e2', 'cfg', 'img')]
  const out = migrateLegacyConfigNodes(nodes, edges)

  check('保留下游自己的模型', dataOf(out.nodes, 'img').model, 'newer-model')
  check('补齐下游缺的尺寸', dataOf(out.nodes, 'img').size, '1024x1024')
  check('已生成的图不丢', dataOf(out.nodes, 'img').url, 'https://x/b.png')
}

console.log('\n【6】幂等：迁移后的结果再跑一遍不变')
{
  const nodes = [
    node('t', 'text'),
    node('cfg', 'imageConfig', { model: 'm1', size: '2048x2048' }),
    node('img', 'image', {}),
  ]
  const edges = [edge('e1', 't', 'cfg'), edge('e2', 'cfg', 'img')]
  const once = migrateLegacyConfigNodes(nodes, edges)
  const twice = migrateLegacyConfigNodes(once.nodes, once.edges)

  check('第二遍节点不变', twice.nodes.map(n => n.id), once.nodes.map(n => n.id))
  check('第二遍边不变', twice.edges.map(e => `${e.source}->${e.target}`), once.edges.map(e => `${e.source}->${e.target}`))
  check('第二遍迁移计数为 0', twice.migratedCount, 0)
}

console.log('\n【7】多个配置节点并存（真实库里的那条 text/imageConfig×2 画布）')
{
  const nodes = [
    node('t1', 'text', { content: 'A' }),
    node('c1', 'imageConfig', { model: 'm1', size: '2048x2048' }),
    node('i1', 'image', {}),
    node('c2', 'imageConfig', { model: 'm1', size: '1440x2560' }),
    node('i2', 'image', {}),
    node('t2', 'text', { content: 'B' }),
  ]
  const edges = [
    edge('e1', 't1', 'c1', { type: 'promptOrder' }) as WorkflowCanvasEdge,
    edge('e2', 'c1', 'i1'),
    edge('e3', 't2', 'c2', { type: 'promptOrder' }) as WorkflowCanvasEdge,
    edge('e4', 'c2', 'i2'),
  ]
  const out = migrateLegacyConfigNodes(nodes, edges)

  check('两个配置节点都消失', out.nodes.some(n => n.type === 'imageConfig'), false)
  check('剩下的节点', out.nodes.map(n => n.id), ['t1', 'i1', 'i2', 't2'])
  check('两条链路都接上', out.edges.map(e => `${e.source}->${e.target}`).sort(), ['t1->i1', 't2->i2'])
  check('迁移计数为 2', out.migratedCount, 2)
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
