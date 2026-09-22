/**
 * 助手面板"模型到底看到了什么"的回归测试
 *
 * 这一类 bug 的讨厌之处：**它不会报错**。历史少发一轮、画布状态没带上，
 * 模型依然会回一段读得通的话 —— typecheck、构建、跑起来的界面全都是绿的，
 * 只有用户会觉得"它好像完全不知道我在干什么"。所以必须用单测钉死。
 *
 * 覆盖两个纯函数：
 *   - assistant-chat-history.ts：把面板消息拼成上游 messages
 *   - canvas-brief.ts：把画布压成一段 system 摘要
 */

import {
  buildAssistantChatMessages,
  HISTORY_CHAR_LIMIT,
  HISTORY_TURN_LIMIT,
} from '../src/composables/assistant-chat-history'
import {
  BRIEF_CHAR_LIMIT,
  BRIEF_NODE_LIMIT,
  buildCanvasBrief,
} from '../src/views/workflow/config/canvas-brief'
import { sortAssistantSessions } from '../src/composables/assistant-session-order'

let passed = 0
let failed = 0
const check = (label: string, actual: unknown, expected: unknown) => {
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

console.log('\n【1】历史必须真的带上（这是"没有上下文记忆"的根因）')
{
  const stored = [
    { type: 'user', content: '帮我写条主图提示词' },
    { type: 'ai-text', content: '一只金毛在草地上奔跑' },
  ]
  const result = buildAssistantChatMessages(stored, '再短一点')
  check('带上了上一轮的用户输入', result[0], { role: 'user', content: '帮我写条主图提示词' })
  check('带上了上一轮的模型回复', result[1], { role: 'assistant', content: '一只金毛在草地上奔跑' })
  check('当前这句在最后', result[result.length - 1], { role: 'user', content: '再短一点' })
  check('一共 3 条', result.length, 3)
}

console.log('\n【2】本轮输入不能被发两遍')
{
  // sendMessage 会先把用户消息 push 进 messages，再调 runChatStream
  const prompt = '只回四个字'
  const stored = [{ type: 'user', content: prompt }]
  const result = buildAssistantChatMessages(stored, prompt)
  check('去重后只剩一条当前输入', result.length, 1)
  check('内容就是当前输入', result[0], { role: 'user', content: prompt })
}

console.log('\n【3】占位与失败轮次绝不能进上下文')
{
  const stored = [
    { type: 'user', content: '第一问' },
    { type: 'ai-text', content: '第一答' },
    { type: 'ai-text', content: '', loading: true },          // 本轮刚插入的空占位
    { type: 'ai-text', content: '半截的错误输出', error: '炸了' }, // 失败那轮
  ]
  const result = buildAssistantChatMessages(stored, '第二问')
  check('没有 loading 轮', result.some(turn => turn.content === ''), false)
  check('没有 error 轮', result.some(turn => turn.content.includes('半截')), false)
  check('角色序列正确', result.map(turn => turn.role), ['user', 'assistant', 'user'])
}

console.log('\n【4】图片轮次留一句说明（否则模型不知道自己刚出过图）')
{
  const stored = [
    { type: 'user', content: '画一只猫' },
    { type: 'ai-images', images: ['a.png'] },
  ]
  const result = buildAssistantChatMessages(stored, '换个背景')
  const assistantTurns = result.filter(turn => turn.role === 'assistant')
  check('图片轮被转成一句说明', assistantTurns.length, 1)
  check('说明里提到图片', /图片/.test(assistantTurns[0].content), true)
}

console.log('\n【5】预算超了只能砍最早的，绝不砍最近的')
{
  const stored: Array<{ type: string; content: string }> = []
  for (let i = 1; i <= HISTORY_TURN_LIMIT * 2; i += 1) {
    stored.push({ type: 'user', content: `第${i}问` })
    stored.push({ type: 'ai-text', content: 'x'.repeat(2000) })
  }
  const result = buildAssistantChatMessages(stored, '最新的一问')
  check('轮数不超上限 + 当前这句', result.length <= HISTORY_TURN_LIMIT + 2, true)
  check('最近一问仍在上下文里', result.some(turn => turn.content === `第${HISTORY_TURN_LIMIT * 2}问`), true)
  check('最早那问被砍掉', result.some(turn => turn.content === '第1问'), false)
  check('当前输入一定在最后', result[result.length - 1].content, '最新的一问')
}

console.log('\n【6】字符预算')
{
  const huge = '很长' .repeat(HISTORY_CHAR_LIMIT)  // 远超预算的一轮
  const stored = [
    { type: 'user', content: huge },
    { type: 'ai-text', content: '旧回复' },
  ]
  const result = buildAssistantChatMessages(stored, '新的问题')
  check('当前输入一定在', result[result.length - 1].content, '新的问题')
  check('总长度被压在预算附近', result.reduce((sum, turn) => sum + turn.content.length, 0) <= HISTORY_CHAR_LIMIT * 2.5, true)
}

console.log('\n【7】画布摘要：模型能看见节点与连线')
{
  const nodes = [
    { id: 'node_0', type: 'text', position: { x: 0, y: 0 }, data: { label: '产品卖点', content: '一只金毛寻回犬在草地上奔跑，摇着尾巴' } },
    { id: 'node_1', type: 'image', position: { x: 400, y: 0 }, data: { label: '文生图', model: 'gpt-image-2', size: '1024x1024', url: '/uploads/a.png' } },
  ]
  const edges = [{ source: 'node_0', target: 'node_1', type: 'promptOrder' }]
  const brief = buildCanvasBrief(nodes, edges, ['node_1'])
  check('提到节点数量', brief.includes('2 个节点'), true)
  check('带上模型名', brief.includes('gpt-image-2'), true)
  check('带上线类型的人话', brief.includes('提示词'), true)
  check('带上选中项', brief.includes('用户当前选中：node_1'), true)
  check('空画布返回空串（不塞空 system）', buildCanvasBrief([], [], []), '')
}

console.log('\n【8】摘要的长度上限')
{
  const many = Array.from({ length: BRIEF_NODE_LIMIT + 20 }, (_, i) => ({
    id: `n${i}`,
    type: 'text',
    data: { label: `节点${i}`, content: '内容很长'.repeat(40) },
  }))
  const brief = buildCanvasBrief(many as never, [], [])
  check('超长摘要被截断', brief.length <= BRIEF_CHAR_LIMIT + 40, true)
  check('明确说了有截断', brief.includes('截断') || brief.includes('略'), true)
  check('不会把超过节点上限的都写进去', brief.includes(`节点${BRIEF_NODE_LIMIT + 19}`), false)
}

console.log('\n【9】会话排序：只认"最近真的用过"')
{
  const mk = (id: string, opt: Record<string, string | boolean>) => ({
    id,
    title: id,
    isDefault: Boolean(opt.def),
    lastRecordAt: opt.rec || null,
    createdAt: opt.created || null,
    updatedAt: opt.updated || null,
  })

  const old = [mk('默认创作', { def: true, created: '2026-01-01T00:00:00Z' })]
  const fresh = [mk('刚聊的', { created: '2026-09-22T00:00:00Z' })]
  const used = [mk('聊过的旧会话', { rec: '2026-09-20T00:00:00Z', created: '2026-01-05T00:00:00Z' })]
  const renamed = [mk('只改过标题', { updated: '2026-09-22T08:00:00Z', created: '2026-01-06T00:00:00Z' })]

  // 毛病一：isDefault 无条件置顶，会把新会话挤到后面
  const withDefaultPinned = sortAssistantSessions([...old, ...fresh])
  check('默认会话不再霸占第一位', withDefaultPinned[0].id, '刚聊的')

  // 毛病二：回落到 updatedAt，会让"只改了个标题"的会话插到中间
  const mixed = sortAssistantSessions([...used, ...renamed, ...fresh])
  check('改标题不会把旧会话顶上来', mixed.map(item => item.id), ['刚聊的', '聊过的旧会话', '只改过标题'])
  check('排序不看 updatedAt', mixed.some((item, index) => index === 1 && item.updatedAt && !item.lastRecordAt), false)

  // 聊过之后必须留在最前（这就是用户说的"刚聊完排到后面去了"）
  const beforeChat = sortAssistantSessions([...fresh, ...used])
  const afterChat = sortAssistantSessions([
    { ...fresh[0], lastRecordAt: '2026-09-22T09:00:00Z' },
    ...used,
  ])
  check('聊之前新会话在最前', beforeChat[0].id, '刚聊的')
  check('聊之后仍在最前', afterChat[0].id, '刚聊的')

  check('空列表不炸', sortAssistantSessions([]), [])
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
