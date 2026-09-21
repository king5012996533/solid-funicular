/**
 * 引用解析器（@ 上游）的逻辑验证
 *
 * 这块逻辑决定两件事：菜单里列出哪些资产、提交时提示词变成什么。
 * 全是纯函数，用脚本跑比点界面更精确 —— 尤其是「一个 token 都不写时
 * text 必须恒等于原 prompt」这条，它是「不引用 = 行为零变化」的唯一保证。
 */

import {
  REFERENCE_TOKEN_PATTERN,
  collectReferenceableAssets,
  insertReferenceToken,
  resolvePromptReferences,
  type ReferenceableAsset,
} from '../src/views/workflow/composables/reference-resolver'
import {
  edges,
  nodes,
  type WorkflowCanvasNode,
} from '../src/views/workflow/composables/useWorkflowCanvas'

const IMG_URL = 'https://cdn.example.com/a.png'
const VIDEO_URL = 'https://cdn.example.com/v.mp4'
const TEXT_BODY = '一只金毛在草地上奔跑'

const IMAGE_NODE = { id: 'n_img', type: 'image', position: { x: 0, y: 0 }, data: { url: IMG_URL, label: '产品图' } }
const TEXT_NODE = { id: 'n_txt', type: 'text', position: { x: 0, y: 0 }, data: { content: TEXT_BODY, label: '文案' } }
const LLM_NODE = { id: 'n_llm', type: 'llmConfig', position: { x: 0, y: 0 }, data: { outputContent: '水彩风格', label: '' } }
const VIDEO_NODE = { id: 'n_vid', type: 'video', position: { x: 0, y: 0 }, data: { url: VIDEO_URL, label: '' } }

/** 直接替换画布 ref 的内容：解析器读的就是这两个 ref */
const setGraph = (graphNodes: object[], wires: Array<[string, string]>) => {
  nodes.value = graphNodes as unknown as WorkflowCanvasNode[]
  edges.value = wires.map(([source, target], i) => ({ id: `e${i}_${source}_${target}`, source, target }))
}

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

// ---------------------------------------------------------------------------

console.log('\n【1】资产收集：种类映射、固定分组顺序、token 与展示名')
{
  setGraph(
    [VIDEO_NODE, TEXT_NODE, IMAGE_NODE, LLM_NODE],
    // 故意让视频排在第一条边：分组顺序必须由种类决定，不受连线顺序影响
    [['n_vid', 'n_gen'], ['n_txt', 'n_gen'], ['n_img', 'n_gen'], ['n_llm', 'n_gen']],
  )
  const assets = collectReferenceableAssets('n_gen')

  check('分组顺序固定为 图片 → 文本 → 视频', assets.map((item) => item.kind), ['image', 'text', 'text', 'video'])
  check('完整清单（含 token 与展示名）', assets, [
    { index: 1, kind: 'image', sourceNodeId: 'n_img', kindLabel: '图片', token: '图片1', displayName: '产品图', value: IMG_URL },
    { index: 1, kind: 'text', sourceNodeId: 'n_txt', kindLabel: '文本', token: '文本1', displayName: '文案', value: TEXT_BODY },
    // llmConfig 的正文来自 outputContent，节点没起名时展示名要能区分出序号
    { index: 2, kind: 'text', sourceNodeId: 'n_llm', kindLabel: '文本', token: '文本2', displayName: '文本 2', value: '水彩风格' },
    { index: 1, kind: 'video', sourceNodeId: 'n_vid', kindLabel: '视频', token: '视频1', displayName: '视频 1', value: VIDEO_URL },
  ])
  check('text 与 llmConfig 共用「文本」这一类的序号', assets.filter((item) => item.kind === 'text').map((item) => item.token), ['文本1', '文本2'])
  check('token 等于 种类名 + 序号', assets.map((item) => item.token), assets.map((item) => `${item.kindLabel}${item.index}`))
  check('同一画布重复收集结果一致', collectReferenceableAssets('n_gen'), assets)
  check('没连线的节点没有资产', collectReferenceableAssets('n_orphan'), [])
}

console.log('\n【2】序号按连线顺序稳定编号')
{
  setGraph([IMAGE_NODE, { ...IMAGE_NODE, id: 'n_img2', data: { url: 'https://cdn.example.com/b.png', label: '参考图' } }], [
    ['n_img2', 'n_gen'],
    ['n_img', 'n_gen'],
  ])
  check('图片序号跟连线顺序走', collectReferenceableAssets('n_gen').map((item) => `${item.token}=${item.displayName}`), ['图片1=参考图', '图片2=产品图'])

  setGraph([TEXT_NODE, LLM_NODE], [['n_llm', 'n_gen'], ['n_txt', 'n_gen']])
  check('同种类内换顺序，序号随之改变', collectReferenceableAssets('n_gen').map((item) => `${item.token}=${item.sourceNodeId}`), ['文本1=n_llm', '文本2=n_txt'])
}

console.log('\n【3】空值资产被过滤、重复值只算一个、悬挂边跳过')
{
  setGraph(
    [
      { id: 'n_img_empty', type: 'image', position: { x: 0, y: 0 }, data: { url: '   ', label: '空的' } },
      { id: 'n_txt_empty', type: 'text', position: { x: 0, y: 0 }, data: { content: '', label: '空的' } },
      { id: 'n_llm_empty', type: 'llmConfig', position: { x: 0, y: 0 }, data: { outputContent: '\n  ', label: '空的' } },
      { id: 'n_img_a', type: 'image', position: { x: 0, y: 0 }, data: { url: 'https://cdn.example.com/a.png', label: '甲' } },
      { id: 'n_img_b', type: 'image', position: { x: 0, y: 0 }, data: { url: 'https://cdn.example.com/a.png', label: '乙' } },
      { id: 'n_img_c', type: 'image', position: { x: 0, y: 0 }, data: { url: 'https://cdn.example.com/c.png', label: '丙' } },
    ],
    [
      ['n_img_empty', 'n_gen'],
      ['n_txt_empty', 'n_gen'],
      ['n_llm_empty', 'n_gen'],
      ['n_img_a', 'n_gen'],
      ['n_img_b', 'n_gen'], // 与 n_img_a 同值：去重后不该占序号
      ['n_img_a', 'n_gen'], // 同一个节点连两条边
      ['n_img_c', 'n_gen'],
      ['missing_node', 'n_gen'], // 悬挂边
      ['n_img_c', 'n_other'], // 连到别的节点，不算这个节点的上游
    ],
  )
  const assets = collectReferenceableAssets('n_gen')

  check('空值资产一个都不出现', assets.length, 2)
  check('重复值只保留最先出现的那个', assets.map((item) => item.displayName), ['甲', '丙'])
  check('去重后序号仍然连续，没有空洞', assets.map((item) => item.token), ['图片1', '图片2'])
  check('悬挂边与别处的连线都不算上游', collectReferenceableAssets('n_gen').map((item) => item.value), ['https://cdn.example.com/a.png', 'https://cdn.example.com/c.png'])
}

console.log('\n【4】§3 语义表：有资产 / 无资产')
{
  const assets: ReferenceableAsset[] = [
    { index: 1, kind: 'image', sourceNodeId: 'n_img', kindLabel: '图片', token: '图片1', displayName: '产品图', value: IMG_URL },
    { index: 1, kind: 'text', sourceNodeId: 'n_txt', kindLabel: '文本', token: '文本1', displayName: '文案', value: TEXT_BODY },
    { index: 1, kind: 'video', sourceNodeId: 'n_vid', kindLabel: '视频', token: '视频1', displayName: '视频 1', value: VIDEO_URL },
  ]
  const resolve = (prompt: string) => resolvePromptReferences(prompt, assets)

  check('@图片1 → 正文【图片1】，url 进 media', resolve('@图片1'), {
    text: '【图片1】', media: [IMG_URL], texts: [], unresolved: [],
  })
  check('@图片1 夹在中文里也能命中', resolve('把@图片1的背景换成海'), {
    text: '把【图片1】的背景换成海', media: [IMG_URL], texts: [], unresolved: [],
  })
  check('@视频1 → 正文【视频1】，url 进 media', resolve('参考@视频1的运镜'), {
    text: '参考【视频1】的运镜', media: [VIDEO_URL], texts: [], unresolved: [],
  })
  check('@文本1 → 正文换成该文本的正文，内容进 texts', resolve('@文本1，请用水彩风格'), {
    text: `${TEXT_BODY}，请用水彩风格`, media: [], texts: [TEXT_BODY], unresolved: [],
  })
  check('文本引用可以整段只有 token', resolve('@文本1'), {
    text: TEXT_BODY, media: [], texts: [TEXT_BODY], unresolved: [],
  })
  check('三种混用：正文、media、texts 各自正确', resolve('@图片1 加上 @视频1，风格参考@文本1'), {
    text: `【图片1】 加上 【视频1】，风格参考${TEXT_BODY}`,
    media: [IMG_URL, VIDEO_URL],
    texts: [TEXT_BODY],
    unresolved: [],
  })
  check('media 的顺序按出现顺序，不按资产顺序', resolve('@视频1 然后 @图片1').media, [VIDEO_URL, IMG_URL])
  check('不存在的序号 → 进 unresolved 且原文保留', resolve('@图片9 不存在'), {
    text: '@图片9 不存在', media: [], texts: [], unresolved: ['@图片9'],
  })
  check('序号越界（只有文本1 却写文本2）', resolve('@文本2'), {
    text: '@文本2', media: [], texts: [], unresolved: ['@文本2'],
  })
  check('媒体 token 越界（只有图片1 却写图片3）', resolve('把@图片3删掉'), {
    text: '把@图片3删掉', media: [], texts: [], unresolved: ['@图片3'],
  })
  check('多处失效各自记录', resolve('@图片9 和 @视频8'), {
    text: '@图片9 和 @视频8', media: [], texts: [], unresolved: ['@图片9', '@视频8'],
  })
  check('资产清单为空时全部落到 unresolved', resolvePromptReferences('@图片1', []), {
    text: '@图片1', media: [], texts: [], unresolved: ['@图片1'],
  })
  check('@图片12 不会被截成 @图片1', resolve('@图片12'), {
    text: '@图片12', media: [], texts: [], unresolved: ['@图片12'],
  })
}

console.log('\n【5】边界：空 prompt、无 token、相邻 token、重复 token')
{
  const assets: ReferenceableAsset[] = [
    { index: 1, kind: 'image', sourceNodeId: 'n_img', kindLabel: '图片', token: '图片1', displayName: '产品图', value: IMG_URL },
    { index: 1, kind: 'text', sourceNodeId: 'n_txt', kindLabel: '文本', token: '文本1', displayName: '文案', value: TEXT_BODY },
    { index: 1, kind: 'video', sourceNodeId: 'n_vid', kindLabel: '视频', token: '视频1', displayName: '视频 1', value: VIDEO_URL },
  ]
  const resolve = (prompt: string) => resolvePromptReferences(prompt, assets)

  check('空 prompt', resolve(''), { text: '', media: [], texts: [], unresolved: [] })

  const plain = '一只猫在窗台上晒太阳，水彩风格'
  check('无 token 时 text 恒等于原 prompt', resolve(plain).text === plain, true)
  check('无 token 时其余三个字段都是空的', resolve(plain), { text: plain, media: [], texts: [], unresolved: [] })
  check('空资产列表 + 无 token 时同样恒等', resolvePromptReferences(plain, []).text === plain, true)
  check('只有 @ 没有序号不算 token', resolve('@图片 后面没有数字'), {
    text: '@图片 后面没有数字', media: [], texts: [], unresolved: [],
  })
  check('我们没有音频种类，@音频1 不是 token', resolve('@音频1'), {
    text: '@音频1', media: [], texts: [], unresolved: [],
  })
  check('乱七八糟的 @ 不影响正文', resolve('邮箱 a@b.com 与 @ 符号'), {
    text: '邮箱 a@b.com 与 @ 符号', media: [], texts: [], unresolved: [],
  })

  check('相邻的不同 token（中间没空格）', resolve('@图片1@视频1'), {
    text: '【图片1】【视频1】', media: [IMG_URL, VIDEO_URL], texts: [], unresolved: [],
  })
  check('相邻的中文与 token', resolve('把@图片1和@视频1合成'), {
    text: '把【图片1】和【视频1】合成', media: [IMG_URL, VIDEO_URL], texts: [], unresolved: [],
  })
  check('重复 token：每处都替换', resolve('@图片1 与 @图片1'), {
    text: '【图片1】 与 【图片1】', media: [IMG_URL], texts: [], unresolved: [],
  })
  check('重复 token：media 只记一次', resolve('@图片1 与 @图片1').media.length, 1)
  check('重复的文本引用：每处都替换成正文', resolve('@文本1 同 @文本1'), {
    text: `${TEXT_BODY} 同 ${TEXT_BODY}`, media: [], texts: [TEXT_BODY], unresolved: [],
  })
  check('重复的失效 token 只记一次', resolve('@图片9 与 @图片9'), {
    text: '@图片9 与 @图片9', media: [], texts: [], unresolved: ['@图片9'],
  })
  check('同一 url 被两个 token 引用时 media 只记一次', resolvePromptReferences('@图片1 @图片2', [
    { index: 1, kind: 'image', sourceNodeId: 'n1', kindLabel: '图片', token: '图片1', displayName: '甲', value: 'https://cdn.example.com/same.png' },
    { index: 2, kind: 'image', sourceNodeId: 'n2', kindLabel: '图片', token: '图片2', displayName: '乙', value: 'https://cdn.example.com/same.png' },
  ]).media, ['https://cdn.example.com/same.png'])

  const nested: ReferenceableAsset[] = [
    { index: 1, kind: 'text', sourceNodeId: 'n_txt', kindLabel: '文本', token: '文本1', displayName: '文案', value: '@图片1' },
  ]
  check('文本正文里出现 token 不会被二次解析', resolvePromptReferences('@文本1', nested), {
    text: '@图片1', media: [], texts: ['@图片1'], unresolved: [],
  })
}

console.log('\n【6】insertReferenceToken：光标位置与补空格')
{
  check('光标在最前', insertReferenceToken('把背景换成海', 0, '图片1'), { prompt: '@图片1 把背景换成海', caret: 5 })
  check('光标在中间', insertReferenceToken('把背景换成海', 1, '图片1'), { prompt: '把@图片1 背景换成海', caret: 6 })
  check('光标在末尾', insertReferenceToken('把背景', 3, '视频1'), { prompt: '把背景@视频1 ', caret: 8 })
  check('空提示词', insertReferenceToken('', 0, '文本1'), { prompt: '@文本1 ', caret: 5 })

  const inserted = insertReferenceToken('把背景换成海', 1, '图片1')
  check('新光标落在补的空格之后', inserted.prompt.slice(inserted.caret - 1, inserted.caret), ' ')
  check('插入处往前是 token 全文', inserted.prompt.slice(inserted.caret - 4, inserted.caret - 1), '图片1')

  check('负数光标夹到 0', insertReferenceToken('把背景', -5, '图片1'), { prompt: '@图片1 把背景', caret: 5 })
  check('超长光标夹到末尾', insertReferenceToken('把背景', 999, '图片1'), { prompt: '把背景@图片1 ', caret: 8 })
  check('非数字光标按末尾处理', insertReferenceToken('把背景', NaN, '图片1'), { prompt: '把背景@图片1 ', caret: 8 })

  const assets: ReferenceableAsset[] = [
    { index: 1, kind: 'image', sourceNodeId: 'n_img', kindLabel: '图片', token: '图片1', displayName: '产品图', value: IMG_URL },
  ]
  const after = insertReferenceToken('把背景换成海', 0, assets[0].token)
  check('插入的 token 能被解析器认出来', resolvePromptReferences(after.prompt, assets), {
    text: '【图片1】 把背景换成海', media: [IMG_URL], texts: [], unresolved: [],
  })
}

console.log('\n【7】token 正则与收集/解析两端一致')
{
  check('匹配图片/文本/视频三种 token', ['@图片1', '@文本12', '@视频3'].map((item) => REFERENCE_TOKEN_PATTERN.test(item)), [true, true, true])
  check('不带 @ 的不算 token', REFERENCE_TOKEN_PATTERN.test('图片1'), false)
  check('没有序号的不算 token', REFERENCE_TOKEN_PATTERN.test('@图片'), false)
  check('没有对应种类的 token 不误判（音频）', REFERENCE_TOKEN_PATTERN.test('@音频1'), false)
  check('中文数字不算序号', REFERENCE_TOKEN_PATTERN.test('@图片一'), false)
  check('捕获组是 种类名 + 序号', REFERENCE_TOKEN_PATTERN.exec('把@文本12 换成')?.slice(1), ['文本', '12'])
  // 带 g 标记的正则会因 lastIndex 变成有状态的，连续调用不能出现真假交替
  check('连续 test 结果稳定（没有 g 标记的副作用）', [0, 1, 2].map(() => REFERENCE_TOKEN_PATTERN.test('@图片1')), [true, true, true])

  setGraph([VIDEO_NODE, TEXT_NODE, IMAGE_NODE, LLM_NODE], [['n_vid', 'n_gen'], ['n_txt', 'n_gen'], ['n_img', 'n_gen'], ['n_llm', 'n_gen']])
  const assets = collectReferenceableAssets('n_gen')
  const resolvable: string[] = []
  for (const asset of assets) {
    const isMatch = REFERENCE_TOKEN_PATTERN.test(`@${asset.token}`)
    const resolved = resolvePromptReferences(`@${asset.token}`, assets)
    if (!isMatch || resolved.unresolved.length) resolvable.push(asset.token)
  }
  check('每个收集出来的 token 都能被解析（两端规则没有漂）', resolvable, [])
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
