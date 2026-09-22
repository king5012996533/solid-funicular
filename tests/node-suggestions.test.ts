/**
 * 拖线落空候选节点的验证
 *
 * 这张规则表同时决定了两件事：菜单里列出哪些节点、连出来的边是什么类型。
 * 所以测试要守住的核心不变式是「菜单里不会出现连不上的选项」——
 * 对每一类起点、每个方向，候选出来的类型都必须在 COHERENT 表里成立。
 */

import {
  NODE_TYPE_PRESENTATION,
  getNodeTypePresentation,
  suggestNodeTypes,
} from '../src/views/workflow/config/node-suggestions'
import type { WorkflowNodeType } from '../src/views/workflow/composables/useWorkflowCanvas'

const ALL_TYPES: WorkflowNodeType[] = ['text', 'image', 'video', 'llmConfig', 'asset']

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

console.log('\n【1】展示信息覆盖全部节点类型，且展示顺序稳定')
{
  const types = NODE_TYPE_PRESENTATION.map(item => item.type)
  // 用对象字面量做全量校验：以后新增节点类型忘了补展示信息，这里会直接编译报错
  const coverage: Record<WorkflowNodeType, boolean> = {
    text: types.includes('text'),
    image: types.includes('image'),
    video: types.includes('video'),
    llmConfig: types.includes('llmConfig'),
    script: types.includes('script'),
  }
  check('五类节点都有展示信息', coverage, { text: true, image: true, video: true, llmConfig: true, script: true })
  check('展示顺序固定为 文本/图片/视频/LLM/剧本/素材', types, ['text', 'image', 'video', 'llmConfig', 'script', 'asset'])
  check('每项都有名字和图标', NODE_TYPE_PRESENTATION.every(i => !!i.name && !!i.icon && !!i.color), true)
  check('能按类型取到展示信息', getNodeTypePresentation('image')?.name, '图片生成')
}

console.log('\n【2】从右侧拖出（下游）：只给「下游真的会读这个输入」的类型')
{
  check('文本 → 图片/视频/LLM/剧本', suggestNodeTypes('text', 'downstream'), ['image', 'video', 'llmConfig', 'script'])
  check('LLM → 图片/视频/LLM（可链式）', suggestNodeTypes('llmConfig', 'downstream'), ['image', 'video', 'llmConfig'])
  check('图片 → 图片/视频', suggestNodeTypes('image', 'downstream'), ['image', 'video'])
  // 视频产出的成片目前没有任何节点会读，所以不该给出候选，也不该弹菜单
  check('视频 → 没有候选', suggestNodeTypes('video', 'downstream'), [])
}

console.log('\n【3】从左侧拖出（上游）：新节点会变成上游，候选要反查')
{
  // 会读上游文本与参考图的：图片、视频、剧本
  check('图片的上游 → 文本/LLM/剧本/图片/素材', suggestNodeTypes('image', 'upstream'), ['text', 'image', 'llmConfig', 'script', 'asset'])
  check('视频的上游 → 文本/LLM/剧本/图片/素材', suggestNodeTypes('video', 'upstream'), ['text', 'image', 'llmConfig', 'script', 'asset'])
  // 会读上游文本的：LLM（链式）。剧本只吃文本创意，所以文本可以接在剧本前面
  check('LLM 的上游 → 文本/LLM', suggestNodeTypes('llmConfig', 'upstream'), ['text', 'llmConfig'])
  check('剧本的上游 → 文本', suggestNodeTypes('script', 'upstream'), ['text'])
  // 剧本产出剧本文本 → 它自己可以往下接图片/视频（这是 B3 要串起的主流程）
  check('剧本的下游 → 图片/视频', suggestNodeTypes('script', 'downstream'), ['image', 'video'])
  // 文本节点不读上游，所以它没有上游候选
  check('文本没有上游候选', suggestNodeTypes('text', 'upstream'), [])
  // 没有任何节点以视频为输入：所以任何起点都不该给出「视频在上游」的候选
  check(
    '视频永远不出现在上游候选里',
    ALL_TYPES.every(origin => !suggestNodeTypes(origin, 'upstream').includes('video')),
    true,
  )
}

console.log('\n【4】核心不变式：候选一定连得上')
{
  // 下游方向：候选的 upstream 候选里必须包含起点
  const downstreamBroken: string[] = []
  const upstreamBroken: string[] = []
  for (const origin of ALL_TYPES) {
    for (const candidate of suggestNodeTypes(origin, 'downstream')) {
      const reverse = suggestNodeTypes(candidate, 'upstream')
      if (!reverse.includes(origin)) downstreamBroken.push(`${origin} → ${candidate}（反查 ${candidate} 的上游里没有 ${origin}）`)
    }
    for (const candidate of suggestNodeTypes(origin, 'upstream')) {
      const forward = suggestNodeTypes(candidate, 'downstream')
      if (!forward.includes(origin)) upstreamBroken.push(`${candidate} → ${origin}（${candidate} 的下游里没有 ${origin}）`)
    }
  }
  check('下游候选与上游候选互为逆关系', downstreamBroken, [])
  check('上游候选与下游候选互为逆关系', upstreamBroken, [])
}

console.log('\n【5】边界：未知类型不给候选，也不会抛错')
{
  const unknown = 'mysteryNode' as WorkflowNodeType
  check('未知类型下游为空', suggestNodeTypes(unknown, 'downstream'), [])
  check('未知类型上游为空', suggestNodeTypes(unknown, 'upstream'), [])
  check('未知类型取展示信息为 null', getNodeTypePresentation(unknown), null)
}

console.log('\n【6】候选结果不再有重复项')
{
  const duplicated: string[] = []
  for (const origin of ALL_TYPES) {
    for (const direction of ['downstream', 'upstream'] as const) {
      const result = suggestNodeTypes(origin, direction)
      if (new Set(result).size !== result.length) duplicated.push(`${origin}/${direction}`)
    }
  }
  check('没有重复候选', duplicated, [])
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
