#!/usr/bin/env node
/**
 * 用真实鼠标事件验证「双击画布空白 → 弹节点类型菜单 → 在双击点建节点」。
 *
 * 为什么必须用真浏览器而不是合成事件：
 *   双击要同时穿过 vue-flow 的 pane 处理器和页面的 dblclick 监听，
 *   JS 里 dispatchEvent 造的假事件（isTrusted=false）不能代表用户手势，
 *   也驱动不了 vue-flow 的缩放/pane 逻辑。Playwright 走 CDP 发的是真实输入。
 *
 * 用法：node tests/e2e/double-click-create.mjs
 * 前置：前端跑在 127.0.0.1:5011，且已登录（脚本自己灌 session cookie）。
 */

import { createRequire } from 'node:module'
import { assertNoConsoleErrors } from './lib/console-filters.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require('/Users/mima1234/.npm/_npx/705bc6b22212b352/node_modules/playwright-core')

const APP_URL = process.env.APP_URL || 'http://localhost:5011'
const SESSION_TOKEN = process.env.SESSION_TOKEN || ''
const CHROME_PATH = '/Users/mima1234/.local/lib/chrome-for-testing/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

// 双击空白给的是全局调色板：全部节点类型（含素材节点）
const ALL_NODE_TYPES = ['文本节点', '图片生成', '视频生成', 'LLM 文本生成', '素材']

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

const readCanvas = (page) => page.evaluate(() => ({
  nodeCount: document.querySelectorAll('.vue-flow__node').length,
  nodes: [...document.querySelectorAll('.vue-flow__node')].map(n => ({
    id: n.getAttribute('data-id'),
    type: n.className.match(/vue-flow__node-(\w+)/)?.[1],
    selected: n.classList.contains('selected'),
    zIndex: Number(getComputedStyle(n).zIndex) || 0,
  })),
  edgeCount: document.querySelectorAll('.vue-flow__edge').length,
  menuVisible: !!document.querySelector('.canvas-context-menu'),
  menuItems: [...document.querySelectorAll('.canvas-context-menu button')]
    .map(i => i.innerText.trim()).filter(Boolean),
}))

/** 直接读菜单包围盒：不走 locator，避免开发服务器热更新时卡在自动等待上 */
const readMenuBox = (page) => page.evaluate(() => {
  const el = document.querySelector('.canvas-context-menu')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
})

/**
 * 找一个真正空白的点：落在 pane 上，且不属于任何节点（含选中的 prompt 浮层）、
 * 连线、画布控件或已打开的菜单；同时离视口右下角足够远，菜单不会被贴边挪位置。
 * 每次都重新扫描，因为上一步建出来的节点/浮层可能已经盖住上一次的点。
 */
const findEmptyPoint = (page) => page.evaluate(() => {
  const pane = document.querySelector('.vue-flow__pane')
  if (!pane) return null
  const rect = pane.getBoundingClientRect()
  for (let yRatio = 0.2; yRatio <= 0.8; yRatio += 0.1) {
    for (let xRatio = 0.4; xRatio <= 0.9; xRatio += 0.06) {
      const x = rect.x + rect.width * xRatio
      const y = rect.y + rect.height * yRatio
      if (x > window.innerWidth - 240 || y > window.innerHeight - 220) continue
      const el = document.elementFromPoint(x, y)
      if (!el) continue
      if (!el.closest('.vue-flow__pane')) continue
      if (el.closest('.vue-flow__node, .vue-flow__edge, .vue-flow__panel, .canvas-context-menu')) continue
      return { x, y }
    }
  }
  return null
})

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
  await page.waitForTimeout(400)

  const initial = await readCanvas(page)
  console.log(`\n起始画布：${initial.nodeCount} 个节点 (${initial.nodes.map(n => n.type).join(', ')})，${initial.edgeCount} 条边`)

  const point = await findEmptyPoint(page)
  check('找到一个空白落点', !!point, true)
  // 最近一次双击的位置：菜单就是在它上面弹出来的
  let other = point

  console.log('\n【1】双击画布空白 → 弹出全部节点类型的菜单')
  {
    await page.mouse.click(1250, 930) // 先点空白处取消选中，避免点到节点
    await page.waitForTimeout(150)

    await page.mouse.dblclick(point.x, point.y)
    await page.waitForTimeout(300)
    const after = await readCanvas(page)

    check('菜单可见', after.menuVisible, true)
    check('候选是全部五类节点', after.menuItems.sort(), [...ALL_NODE_TYPES].sort())
    check('选类型之前不会凭空多出节点', after.nodeCount, initial.nodeCount)
    check('不会凭空多出边', after.edgeCount, initial.edgeCount)

    const menuBox = await readMenuBox(page)
    check('菜单位于双击点', !!menuBox && Math.abs(menuBox.x - point.x) < 12 && Math.abs(menuBox.y - point.y) < 12, true)
  }

  console.log('\n【2】菜单已经打开时再双击另一处空白 → 只保留一个菜单')
  {
    other = await findEmptyPoint(page)
    check('找到第二个空白落点', !!other, true)
    await page.mouse.dblclick(other.x, other.y)
    await page.waitForTimeout(300)
    const after = await readCanvas(page)
    check('菜单仍然只有一个', await page.locator('.canvas-context-menu').count(), 1)
    check('菜单依然可见', after.menuVisible, true)

    const menuBox = await readMenuBox(page)
    check('跟随第二次双击挪到新位置', !!menuBox && Math.abs(menuBox.x - other.x) < 12 && Math.abs(menuBox.y - other.y) < 12, true)
  }

  console.log('\n【3】选「视频生成」→ 在双击点建节点，不带边，并选中')
  {
    const before = await readCanvas(page)
    await page.locator('.canvas-context-menu button', { hasText: '视频生成' }).first().click({ timeout: 5000 })
    await page.waitForTimeout(400)
    const after = await readCanvas(page)

    check('节点数 +1', after.nodeCount, before.nodeCount + 1)
    check('新节点是 video', after.nodes.filter(n => n.type === 'video').length, before.nodes.filter(n => n.type === 'video').length + 1)
    check('新边数为 0 增量（空白处没有起点，不连边）', after.edgeCount, before.edgeCount)
    check('菜单已关闭', after.menuVisible, false)
    check('新节点被选中', after.nodes.filter(n => n.selected).length, 1)

    const newId = after.nodes.map(n => n.id).find(id => !before.nodes.some(n => n.id === id))
    const newNode = after.nodes.find(n => n.id === newId)
    check('新节点是刚建出来的那一个', !!newNode, true)
    check('新节点被置顶（z-index 最大）', newNode.zIndex >= Math.max(...before.nodes.map(n => n.zIndex)), true)

    const box = await page.locator(`.vue-flow__node[data-id="${newId}"]`).boundingBox()
    const nearDoubleClick = box
      && Math.abs(box.x + box.width / 2 - other.x) < 260
      && Math.abs(box.y + box.height / 2 - other.y) < 260
    check('新节点落在双击点附近', nearDoubleClick, true)
  }

  console.log('\n【4】双击节点卡片 → 不该弹菜单')
  {
    const before = await readCanvas(page)
    const nodeBox = await page.locator('.vue-flow__node').first().boundingBox()
    await page.mouse.dblclick(nodeBox.x + nodeBox.width / 2, nodeBox.y + nodeBox.height / 2)
    await page.waitForTimeout(300)
    const after = await readCanvas(page)
    check('菜单没有弹出', after.menuVisible, false)
    check('没有多出节点', after.nodeCount, before.nodeCount)
  }

  console.log('\n【5】双击空白后点菜单外部 → 菜单关闭，不建节点')
  {
    // 重新找点：上一步选中节点的 prompt 浮层可能已经盖住旧位置
    const fresh = await findEmptyPoint(page)
    check('找到新的空白落点', !!fresh, true)
    await page.mouse.click(1250, 930)
    await page.waitForTimeout(150)
    await page.mouse.dblclick(fresh.x, fresh.y)
    await page.waitForTimeout(300)
    check('菜单可见', (await readCanvas(page)).menuVisible, true)

    const before = await readCanvas(page)
    // 再找一个空白点：findEmptyPoint 会避开菜单占的区域，所以它一定在菜单外
    const away = await findEmptyPoint(page)
    check('找到菜单外的空白点', !!away, true)
    await page.mouse.click(away.x, away.y)
    await page.waitForTimeout(250)
    const after = await readCanvas(page)
    check('菜单已关闭', after.menuVisible, false)
    check('没有多出节点', after.nodeCount, before.nodeCount)
    check('没有多出边', after.edgeCount, before.edgeCount)
  }

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
