#!/usr/bin/env node
/**
 * 用真实鼠标事件验证「拖线落空弹节点菜单」。
 *
 * 为什么必须用真浏览器而不是合成事件：
 *   Vue Flow 的连线靠 handle 上的 setPointerCapture + 真实指针事件驱动，
 *   JS 里 dispatchEvent 造的假事件会被浏览器忽略（isTrusted=false），
 *   拖拽根本不会开始。Playwright 走 CDP 发的是真实输入，能驱动它。
 *
 * 用法：node tests/e2e/drag-to-create.mjs
 * 前置：前端跑在 127.0.0.1:5011，且已登录（脚本自己灌 session cookie）。
 */

import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const { chromium } = require('/Users/mima1234/.npm/_npx/705bc6b22212b352/node_modules/playwright-core')

const APP_URL = process.env.APP_URL || 'http://localhost:5011'
const SESSION_TOKEN = process.env.SESSION_TOKEN || ''
const CHROME_PATH = '/Users/mima1234/.local/lib/chrome-for-testing/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

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
const dragFromHandleTo = async (page, handleSelector, target) => {
  const box = await page.locator(handleSelector).first().boundingBox()
  if (!box) throw new Error(`找不到 handle: ${handleSelector}`)

  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  // 分步移动：一步到位的话 Vue Flow 收不到中间的 mousemove，连线不会建立
  const steps = 12
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(
      startX + ((target.x - startX) * i) / steps,
      startY + ((target.y - startY) * i) / steps,
    )
  }
  await page.waitForTimeout(80)
  await page.mouse.up()
  await page.waitForTimeout(250)
}

const readCanvas = (page) => page.evaluate(() => ({
  nodeCount: document.querySelectorAll('.vue-flow__node').length,
  nodes: [...document.querySelectorAll('.vue-flow__node')].map(n => ({
    id: n.getAttribute('data-id'),
    type: n.className.match(/vue-flow__node-(\w+)/)?.[1],
    selected: n.classList.contains('selected'),
  })),
  edges: [...document.querySelectorAll('.vue-flow__edge')].map(e => e.getAttribute('data-testid') || e.className),
  menuVisible: !!document.querySelector('.canvas-context-menu, [class*=context-menu]'),
  menuItems: [...document.querySelectorAll('[class*=context-menu] [role=menuitem], [class*=context-menu] button')]
    .map(i => i.innerText.trim()).filter(Boolean),
  menuTitles: [...document.querySelectorAll('[class*=context-menu] button')].map(b => b.getAttribute('title')).filter(Boolean),
}))

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

  const initial = await readCanvas(page)
  console.log(`\n起始画布：${initial.nodeCount} 个节点 (${initial.nodes.map(n => n.type).join(', ')})`)

  console.log('\n【1】从文本节点右侧拖到空白处 → 应弹出候选菜单')
  {
    await page.mouse.click(1200, 850) // 先点空白处取消选中
    await page.waitForTimeout(150)

    // 从文本节点右侧 handle 拖到一个远离所有节点的空白位置
    await dragFromHandleTo(page, '.vue-flow__node-text .canvas-node-add-handle--right', { x: 1150, y: 820 })
    const after = await readCanvas(page)

    check('没有凭空多出节点（菜单还没选类型）', after.nodeCount, initial.nodeCount)
    check('菜单可见', after.menuVisible, true)
    // 文本节点的下游候选：图片生成 / 视频生成 / LLM 文本生成
    check('候选是文本的下游消费者', after.menuItems.sort(), ['图片生成', '视频生成', 'LLM 文本生成'].sort())
  }

  console.log('\n【2】选「图片生成」→ 建节点在落点 + 自动连 promptOrder 边')
  {
    const before = await readCanvas(page)
    await page.locator('[class*=context-menu] button', { hasText: '图片生成' }).first().click()
    await page.waitForTimeout(400)
    const after = await readCanvas(page)

    check('节点数 +1', after.nodeCount, before.nodeCount + 1)
    check('新节点是 image', after.nodes.filter(n => n.type === 'image').length, before.nodes.filter(n => n.type === 'image').length + 1)
    check('新节点被选中（可以接着写提示词）', after.nodes.filter(n => n.selected).length, 1)
    check('边数 +1', after.edges.length, before.edges.length + 1)
    check('菜单已关闭', after.menuVisible, false)

    // 落在鼠标附近，而不是视口中心
    const box = await page.locator('.vue-flow__node-image').last().boundingBox()
    const nearDrop = box && Math.abs(box.x + box.width / 2 - 1150) < 260 && Math.abs(box.y + box.height / 2 - 820) < 260
    check('新节点落在鼠标松手的位置附近', nearDrop, true)
  }

  console.log('\n【3】落点若在已有节点上 → 不该弹菜单')
  {
    // 3a：正好落在目标节点的左侧 handle 上 = 正常连线，不能弹菜单
    const beforeEdge = await readCanvas(page)
    const leftHandle = await page.locator('.vue-flow__node-image').first()
      .locator('.canvas-node-add-handle--left').boundingBox()
    await dragFromHandleTo(page, '.vue-flow__node-text .canvas-node-add-handle--right', {
      x: leftHandle.x + leftHandle.width / 2,
      y: leftHandle.y + leftHandle.height / 2,
    })
    const afterHandleDrop = await readCanvas(page)
    check('落在 handle 上：菜单没有弹出', afterHandleDrop.menuVisible, false)
    check('落在 handle 上：正常连出一条边', afterHandleDrop.edges.length, beforeEdge.edges.length + 1)

    // 3b：落在节点卡片中间（不是 handle）= 什么都不该发生
    const beforeBody = await readCanvas(page)
    const bodyBox = await page.locator('.vue-flow__node-image').first().boundingBox()
    await dragFromHandleTo(page, '.vue-flow__node-text .canvas-node-add-handle--right', {
      x: bodyBox.x + bodyBox.width / 2,
      y: bodyBox.y + bodyBox.height / 2,
    })
    const afterBodyDrop = await readCanvas(page)
    check('落在卡片中间：菜单没有弹出', afterBodyDrop.menuVisible, false)
    check('落在卡片中间：不会凭空建节点', afterBodyDrop.nodeCount, beforeBody.nodeCount)
  }

  console.log('\n【4】视频节点右侧 → 没有下游消费者，不该弹菜单')
  {
    const before = await readCanvas(page)
    // 先建一个视频节点（用左侧工具栏），再从它右侧拖
    await page.locator("button[title='视频生成']").click()
    await page.waitForTimeout(400)
    const videoBox = await page.locator('.vue-flow__node-video').first().boundingBox()
    const nodeCountBeforeDrag = (await readCanvas(page)).nodeCount

    await dragFromHandleTo(page, '.vue-flow__node-video .canvas-node-add-handle--right', { x: 1250, y: 700 })
    const after = await readCanvas(page)
    check('菜单没有弹出（视频没有能接的下游）', after.menuVisible, false)
    check('没有多出节点', after.nodeCount, nodeCountBeforeDrag)
    void before
  }

  console.log('\n【5】从图片节点左侧拖出（上游）→ 候选是提示词类节点')
  {
    await page.mouse.click(1300, 880)
    await page.waitForTimeout(150)
    await dragFromHandleTo(page, '.vue-flow__node-image .canvas-node-add-handle--left', { x: 700, y: 880 })
    const after = await readCanvas(page)
    check('菜单可见', after.menuVisible, true)
    check('候选是上游提示词来源', after.menuItems.sort(), ['图片生成', '文本节点', 'LLM 文本生成'].sort())
  }

  console.log('\n【6】全程没有 console error')
  check('console errors', consoleErrors, [])

  await browser.close()

  console.log(`\n${'─'.repeat(52)}`)
  console.log(`  通过 ${passed} / 失败 ${failed}`)
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error('执行失败：', error)
  process.exit(1)
})
