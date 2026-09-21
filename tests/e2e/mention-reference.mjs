#!/usr/bin/env node
/**
 * 素材引用（@ 上游）端到端验证。
 *
 * 链路：样本画布上的图片节点先上传一张图 → 它自动长出下游节点（消费方）→
 *       再建一个图片节点并连到消费方 → 消费方上游就有【两张图】→
 *       在提示词里敲 @ → 选面板里的「图片2」 → token 落到输入框（光标复位）→
 *       提交 → 检查 /api/generation-tasks 的载荷：prompt 已解析，
 *       且 referenceImages 只有显式引用的那一张（自动注入的另一张被覆盖）。
 *
 * 为什么必须真鼠标 / 真键盘：
 *   面板的开启由「输入事件后的 selectionStart」驱动，token 插入后还要用
 *   setSelectionRange 复位光标；合成事件（isTrusted=false）既不会更新真实选区，
 *   也驱动不了 Vue 的 v-model 与提交路径。连线同理，靠 PointerEvent 驱动 Vue Flow。
 *   Playwright 走 CDP 发的是真实输入。
 *
 * 用法：node tests/e2e/mention-reference.mjs
 * 前置：前端跑在 127.0.0.1:5011，且已登录（脚本自己灌 session cookie）。
 */

import { createRequire } from 'node:module'
import { assertNoConsoleErrors } from './lib/console-filters.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require('/Users/mima1234/.npm/_npx/705bc6b22212b352/node_modules/playwright-core')

const APP_URL = process.env.APP_URL || 'http://localhost:5011'
const SESSION_TOKEN = process.env.SESSION_TOKEN || ''
const CHROME_PATH = '/Users/mima1234/.local/lib/chrome-for-testing/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

/**
 * 提示词输入框的形态在本轮从 textarea 换成了 contenteditable（内联 chip）。
 * 下面两个读取器把两种形态归一，脚本因此不依赖具体实现 ——
 * 选择器写成并集，实现换成哪一种都还能跑。
 */
const PROMPT_CONTROL = '.image-node-prompt-panel textarea.prompt-textarea, .image-node-prompt-panel .inline-mention-input'

/** 读出输入框里的纯文本（contenteditable 下把 chip 还原成它的 token） */
const readPromptText = (locator) => locator.evaluate((el) => {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value
  return Array.from(el.childNodes)
    .map((node) => (node.nodeType === Node.TEXT_NODE
      ? node.nodeValue
      : (node.getAttribute?.('data-mention-token') ?? node.textContent ?? '')))
    .join('')
})

/**
 * 光标是否停在内容末尾。
 * 不换算成数值偏移 —— contenteditable 里 chip 是原子节点，
 * DOM 偏移与纯文本偏移差一位，换算容易写错且难读。
 * 「光标之后没有内容」这个等价条件更稳。
 */
const isCaretAtEnd = (locator) => locator.evaluate((el) => {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return false
  const range = sel.getRangeAt(0)
  if (!el.contains(range.endContainer)) return false
  const probe = document.createRange()
  probe.selectNodeContents(el)
  probe.setStart(range.endContainer, range.endOffset)
  return probe.toString().length === 0
})

/** 1×1 透明 PNG：只在存储里造一个真实可访问的图片资产 */
const PROBE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let passed = 0
let failed = 0

const check = (label, actual, expected) => {
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

/** 从 handle 拖到目标坐标并松手。必须分多步移动，Vue Flow 才会开始连线 */
const dragFromHandleTo = async (page, handleLocator, target) => {
  const box = await handleLocator.boundingBox()
  if (!box) throw new Error('找不到拖拽起点 handle')

  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  const steps = 12
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(
      startX + ((target.x - startX) * i) / steps,
      startY + ((target.y - startY) * i) / steps,
    )
  }
  await page.waitForTimeout(80)
  await page.mouse.up()
  await page.waitForTimeout(300)
}

const main = async () => {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true })
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })

  if (SESSION_TOKEN) {
    await context.addCookies([{
      name: 'canana_session',
      value: SESSION_TOKEN,
      domain: 'localhost',
      path: '/',
    }])
  }

  const page = await context.newPage()
  const consoleErrors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  await page.goto(`${APP_URL}/workflow`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.vue-flow__node', { timeout: 15000 })

  const imageNodes = page.locator('.vue-flow__node-image')
  const panelNode = page.locator('.vue-flow__node-image').filter({ has: page.locator('.image-node-prompt-panel') })
  const referredItems = page.locator('.image-node-prompt-panel .mentioned-reference-item')

  console.log('\n【1】造链路：样本图片节点上传后自动长出下游节点（消费方）')
  const imageCountBefore = await imageNodes.count()
  // 样本画布的图片节点就是第一张图（它上游连着示例文本节点）
  await imageNodes.first().locator('input[type="file"][accept="image/*"]').setInputFiles({
    name: 'upstream-a.png', mimeType: 'image/png', buffer: Buffer.from(PROBE_PNG_BASE64, 'base64'),
  })
  await page.waitForTimeout(1800)
  check('上传后自动长出下游图片节点', await imageNodes.count(), imageCountBefore + 1)

  const upstreamAUrl = await imageNodes.first().locator('.image-node-image').getAttribute('src')
  check('上游 A 拿到真实图片 url', /^\/uploads\//.test(String(upstreamAUrl || '')), true)

  const panel = page.locator('.image-node-prompt-panel')
  await panel.waitFor({ state: 'visible', timeout: 15000 })
  // 消费方浮层的定位基准要先量下来：一旦取消选中，就再也定位不到这个节点了
  const targetCardBox = await panelNode.boundingBox()
  const targetLeftHandle = await panelNode.locator('.canvas-node-add-handle--left').boundingBox()
  check('消费方节点已选中（下方浮出 composer）', Boolean(targetCardBox), true)

  console.log('\n【2】再建一个图片节点并连成上游 → 消费方有两张自动参考图')
  // 先取消选中：消费方的浮层会盖住后建节点的连线手柄（浮层在自己节点下方居中展开）
  await page.mouse.click(1350, 880)
  await page.waitForTimeout(400)
  check('点击空白后浮层收起', await panel.count(), 0)

  await page.locator("button[title='文生图']").click()
  await page.waitForTimeout(700)
  check('工具栏新增了一个图片节点', await imageNodes.count(), imageCountBefore + 2)
  const newNode = imageNodes.last()
  await dragFromHandleTo(page, newNode.locator('.canvas-node-add-handle--right'), {
    x: targetLeftHandle.x + targetLeftHandle.width / 2,
    y: targetLeftHandle.y + targetLeftHandle.height / 2,
  })

  await newNode.locator('input[type="file"][accept="image/*"]').setInputFiles({
    name: 'upstream-b.png', mimeType: 'image/png', buffer: Buffer.from(PROBE_PNG_BASE64, 'base64'),
  })
  await page.waitForTimeout(1500)
  check('连成上游后新节点自己带图、也不再自动建下游', await imageNodes.count(), imageCountBefore + 2)
  const upstreamBUrl = await newNode.locator('.image-node-image').getAttribute('src')
  check('上游 B 拿到真实图片 url', /^\/uploads\//.test(String(upstreamBUrl || '')), true)

  // 回到消费方：点它卡片下沿选中，浮层重新出现
  await page.mouse.click(targetCardBox.x + targetCardBox.width / 2, targetCardBox.y + targetCardBox.height - 30)
  await page.waitForTimeout(600)
  const textarea = page.locator(PROMPT_CONTROL)
  await textarea.waitFor({ state: 'visible', timeout: 10000 })
  check('消费方重新选中', await panel.count(), 1)
  check('未敲 @ 时面板不出现', await page.locator('.mention-picker').count(), 0)

  const pickerRows = page.locator('.mention-picker__row')

  /** 敲 @ → 一级选种类 → 二级选资产（全部走真实鼠标 / 键盘） */
  const openPicker = async () => {
    try {
      await textarea.click({ timeout: 4000 })
    } catch {
      // 节点叠在一起时命中区可能被压住，退回 DOM 聚焦；后面的输入仍是真实键盘事件
      await textarea.focus()
    }
    // 先清空：上一次移除引用会留下分隔用的空格，不清掉就无法判断 token 插在哪
    await page.keyboard.press('Meta+A')
    await page.keyboard.press('Backspace')
    await page.keyboard.type('@')
    await page.waitForSelector('.mention-picker', { timeout: 5000 })
  }

  console.log('\n【3】敲 @ → 弹出素材引用面板')
  await openPicker()
  check('一级菜单只列出有资产的种类', await page.locator('.mention-picker__row-name').allInnerTexts(), ['图片'])
  check('种类后面的数量是上游图片数', await page.locator('.mention-picker__row-token').allInnerTexts(), ['2'])

  console.log('\n【4】选「图片2」→ token 插到光标处并复位光标')
  await pickerRows.first().click()
  await page.waitForTimeout(300)
  check('二级菜单列出两张资产', await page.locator('.mention-picker__row-token').allInnerTexts(), ['图片1', '图片2'])
  await pickerRows.nth(1).click()
  await page.waitForTimeout(300)

  check('输入框里是 @图片2（不是 @@图片2）', await readPromptText(textarea), '@图片2 ')
  check('面板已自动关闭', await page.locator('.mention-picker').count(), 0)
  check('焦点回到输入框', await textarea.evaluate((el) => el.contains(document.activeElement)), true)
  check('光标落在 token 之后（其后已无内容）', await isCaretAtEnd(textarea), true)

  console.log('\n【5】「已引用」行只露出被引用的那张')
  check('已引用行有 1 张缩略图', await referredItems.count(), 1)
  check('缩略图是显式引用的那张（不是自动注入的另一张）',
    await referredItems.first().locator('img').getAttribute('src'), upstreamBUrl)

  console.log('\n【5b】移除引用 → 文本里的 token 一并删掉')
  await referredItems.first().hover()
  await referredItems.first().locator('.remove-button.generator-reference-clear-btn').click()
  await page.waitForTimeout(250)
  // token 后那个空格是插入时补的分隔符，不属于 token 本身，所以比对 trim 后的结果
  check('输入框里的 token 被删掉', (await readPromptText(textarea)).trim(), '')
  check('已引用行消失', await referredItems.count(), 0)

  console.log('\n【6】提交 → 载荷里 prompt 已解析、referenceImages 是显式引用（覆盖自动注入）')
  await openPicker()
  await pickerRows.first().click()
  await page.waitForTimeout(300)
  await pickerRows.nth(1).click()
  await page.waitForTimeout(300)
  check('重新引用后 token 回到输入框', await readPromptText(textarea), '@图片2 ')

  const requestPromise = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().includes('/api/generation-tasks'),
    { timeout: 20000 },
  )
  await page.keyboard.press('Enter')
  const request = await requestPromise
  const body = request.postDataJSON()

  console.log('\n  捕获的请求体：')
  console.log(JSON.stringify(body, null, 2))

  check('prompt 里的 token 已解析成正文', body.prompt, '【图片2】')
  check('referenceImages 只有显式引用的那张', body.referenceImages, [upstreamBUrl])
  check('自动注入的另一张被覆盖（不在载荷里）', String(body.referenceImages).includes(String(upstreamAUrl)), false)
  check('请求体 image 字段同步', body.requestBody?.image, [upstreamBUrl])
  check('走图生图模式', body.requestMode, 'image-edit')

  console.log('\n【7】全程没有 console error')
  assertNoConsoleErrors(check, consoleErrors)

  await browser.close()

  console.log(`\n${'─'.repeat(52)}`)
  console.log(`  通过 ${passed} / 失败 ${failed}`)
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error('执行失败：', error)
  process.exit(1)
})
