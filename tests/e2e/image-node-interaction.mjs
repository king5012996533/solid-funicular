#!/usr/bin/env node
/**
 * 图片节点的交互回归：拖拽优先，双击才放大
 *
 * 这一条是被用户反馈逼出来的：早先把「放大预览」绑在**单击**上，图片又占了节点
 * 几乎全部面积，光标还写成 zoom-in —— 结果每次想拖节点都像要弹大图，
 * 用户的原话是「鼠标移动到图片就变成放大镜，导致没法进行拖拽」。
 *
 * 所以这里钉死四件事，任何一条回退都会让手感再次变差：
 *   1. 图片上**不能**是放大镜光标；
 *   2. 单击图片**不能**弹出查看器（否则拖拽的第一步就被抢走）；
 *   3. 从图片上拖动必须能移动节点，且不弹查看器；
 *   4. 双击图片能弹出查看器，Esc 能关；工具栏「放大预览」也要能用。
 *
 * 用法：SESSION_TOKEN=... node tests/e2e/image-node-interaction.mjs
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('/Users/mima1234/.npm/_npx/705bc6b22212b352/node_modules/playwright-core')

const APP_URL = process.env.APP_URL || 'http://localhost:5011'
const SESSION_TOKEN = process.env.SESSION_TOKEN || ''
const CHROME_PATH = '/Users/mima1234/.local/lib/chrome-for-testing/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
const WORKFLOW_URL = process.env.WORKFLOW_URL || `${APP_URL}/workflow`

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
const truthy = (label, value, hint = '') => {
  if (value) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    console.log(`  ❌ ${label}${hint ? `\n     ${hint}` : ''}`)
  }
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const main = async () => {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true })
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  if (SESSION_TOKEN) {
    await context.addCookies([{ name: 'canana_session', value: SESSION_TOKEN, domain: 'localhost', path: '/' }])
  }
  const page = await context.newPage()

  try {
    console.log('\n【图片节点交互：拖拽优先 / 双击放大】\n')
    await page.goto(WORKFLOW_URL, { waitUntil: 'networkidle' })
    await page.waitForSelector('.vue-flow__node')
    await sleep(1200)

    const node = page.locator('.vue-flow__node:has(.image-node-image)').first()
    truthy('画布上存在带图的节点', await node.count() > 0)
    const nodeId = await node.getAttribute('data-id')
    const image = node.locator('.image-node-image')
    const box = await image.boundingBox()
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2

    // ---- 1. 光标不能是放大镜 ----
    await page.mouse.move(cx, cy)
    await sleep(300)
    const cursor = await image.evaluate(el => getComputedStyle(el).cursor)
    truthy(`图片上没有放大镜光标（实际 ${cursor}）`, cursor !== 'zoom-in' && cursor !== 'pointer')

    // ---- 2. 单击不应弹查看器 ----
    await page.mouse.click(cx, cy)
    await sleep(600)
    check('单击图片不弹出查看器', await page.locator('.el-image-viewer__wrapper').count(), 0)

    // ---- 3. 从图片上拖动：节点要动，且不弹查看器 ----
    const before = await node.boundingBox()
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    for (let i = 1; i <= 10; i += 1) {
      await page.mouse.move(cx + i * 8, cy + i * 3)
      await sleep(16)
    }
    await page.mouse.up()
    await sleep(500)
    const after = await node.boundingBox()
    const movedX = Math.round(after.x - before.x)
    const movedY = Math.round(after.y - before.y)
    truthy(`从图片上拖动能移动节点（位移 ${movedX}, ${movedY}）`, Math.abs(movedX) > 20 || Math.abs(movedY) > 20)
    check('拖动过程中没有弹出查看器', await page.locator('.el-image-viewer__wrapper').count(), 0)

    // ---- 4. 双击应弹查看器 ----
    const box2 = await image.boundingBox()
    await page.mouse.dblclick(box2.x + box2.width / 2, box2.y + box2.height / 2)
    await sleep(700)
    const viewerCount = await page.locator('.el-image-viewer__wrapper').count()
    check('双击图片弹出查看器', viewerCount, 1)
    if (viewerCount) {
      const fullscreen = await page.locator('.el-image-viewer__wrapper').evaluate((el) => {
        const r = el.getBoundingClientRect()
        return Math.round(r.width) === window.innerWidth && Math.round(r.height) === window.innerHeight
      })
      check('查看器是铺满视口的（teleported 生效）', fullscreen, true)
      await page.keyboard.press('Escape')
      await sleep(500)
      check('Esc 能关掉查看器', await page.locator('.el-image-viewer__wrapper').count(), 0)
    }

    // ---- 5. 工具栏「放大预览」仍然可用（单击直达） ----
    await node.locator('.image-node-title').click()
    await sleep(600)
    const previewBtn = page.locator('.canvas-node-top-toolbar button[title="放大预览"]')
    check('顶部工具栏有「放大预览」', await previewBtn.count(), 1)
    await previewBtn.click()
    await sleep(700)
    check('工具栏按钮能打开查看器', await page.locator('.el-image-viewer__wrapper').count(), 1)
    await page.keyboard.press('Escape')
    await sleep(400)

    console.log(`\n  （被测节点：${nodeId}）`)
    console.log(`\n${'─'.repeat(52)}`)
    console.log(`  通过 ${passed} / 失败 ${failed}`)
  } finally {
    await browser.close()
  }

  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error('执行失败：', error)
  process.exit(1)
})
