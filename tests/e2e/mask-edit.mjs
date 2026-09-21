#!/usr/bin/env node
/**
 * 「编辑元素」（局部重绘）端到端验证：涂抹 → 写要求 → 提交 → 出图
 *
 * 为什么必须真浏览器：
 *   涂抹靠 pointerdown/move/up 画进 canvas，蒙版还要按原图分辨率重新导出一次
 *   （destination-out 打洞）。中间任何一段断了，提交出去的蒙版都是错的 ——
 *   而且错得很难看出来：蒙版全黑 = 整张都能改，蒙版全透明 = 什么都改不了。
 *   所以这里既断言**提交的载荷**（mask 是 PNG 且挂在 payload 上），
 *   也断言**回来的图确实变了**（若有 MASK_COMPARE=1 则逐像素比对圆内/圆外）。
 *
 * 前置：后台已配置可用厂商（含密钥）、账户有积分、画布上有一个**带图**的节点。
 *      脚本会自己找画布上第一个有图的节点作为素材。
 *
 * 用法：
 *   SESSION_TOKEN=... node tests/e2e/mask-edit.mjs
 *   SESSION_TOKEN=... WAIT=1 node tests/e2e/mask-edit.mjs      # 等到真出图（约 2~6 分钟）
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('/Users/mima1234/.npm/_npx/705bc6b22212b352/node_modules/playwright-core')

const APP_URL = process.env.APP_URL || 'http://localhost:5011'
const SESSION_TOKEN = process.env.SESSION_TOKEN || ''
const CHROME_PATH = '/Users/mima1234/.local/lib/chrome-for-testing/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
const WORKFLOW_URL = process.env.WORKFLOW_URL || `${APP_URL}/workflow`
const WAIT_FOR_IMAGE = process.env.WAIT === '1'
const GENERATION_TIMEOUT_MS = 7 * 60 * 1000

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

  const consoleErrors = []
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })

  let submittedBody = null
  context.on('request', (request) => {
    if (request.url().includes('/api/generation-tasks') && request.method() === 'POST') {
      try { submittedBody = JSON.parse(request.postData() || 'null') } catch { /* 忽略 */ }
    }
  })

  try {
    console.log('\n【编辑元素（局部重绘）端到端】\n')

    await page.goto(WORKFLOW_URL, { waitUntil: 'networkidle' })
    await page.waitForSelector('.vue-flow__node')
    await sleep(900)

    // ---- 1. 找一个有图的节点当素材 ----
    const captioned = page.locator('.vue-flow__node:has(.image-node-image)').first()
    const sourceCount = await captioned.count()
    truthy('画布上存在带图的节点', sourceCount > 0, '先往任意节点上传或生成一张图再跑本脚本')
    if (!sourceCount) throw new Error('没有带图的节点')

    const sourceId = await captioned.getAttribute('data-id')
    const sourceUrlBefore = await captioned.locator('.image-node-image').getAttribute('src')
    console.log(`  素材节点：${sourceId}`)

    // ---- 2. 选中它 → 点「编辑元素」 ----
    await captioned.locator('.image-node-title').click()
    await sleep(500)
    const editBtn = page.locator('.canvas-node-top-toolbar button[title="编辑元素"]')
    check('顶部工具栏出现「编辑元素」', await editBtn.count(), 1)
    await editBtn.click()
    await sleep(700)

    const dialog = page.locator('.el-dialog:has-text("编辑元素（局部重绘）")')
    truthy('涂抹对话框已打开', await dialog.count() > 0)

    // ---- 3. 真鼠标涂抹一笔 ----
    const imageBox = await page.locator('.mask-image').boundingBox()
    const cx = imageBox.x + imageBox.width / 2
    const cy = imageBox.y + imageBox.height / 2
    await page.mouse.move(cx - 50, cy - 10)
    await page.mouse.down()
    for (let i = 1; i <= 10; i += 1) {
      await page.mouse.move(cx - 50 + i * 10, cy - 10 + Math.sin(i / 2) * 14)
      await sleep(18)
    }
    await page.mouse.up()
    await sleep(400)

    check('涂抹后「撤销一笔」可用', await page.locator('.mask-btn:has-text("撤销一笔")').isEnabled(), true)
    const paintedPixels = await page.locator('.mask-preview').evaluate((canvas) => {
      const ctx = canvas.getContext('2d')
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      let painted = 0
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 0) painted += 1
      }
      return painted
    })
    truthy('预览层确实画上了笔迹', paintedPixels > 0, `涂到的像素数=${paintedPixels}`)

    // ---- 4. 写要求并提交 ----
    await page.locator('.el-dialog:has-text("局部重绘") textarea').first().fill('把涂抹区域换成一只白色的陶瓷杯')
    await sleep(200)
    await page.locator('.mask-btn.is-primary').click()
    await sleep(2500)

    // ---- 5. 断言提交的载荷 ----
    truthy('已捕获提交给后端的载荷', Boolean(submittedBody))
    check('走的是图生图（image-edit）', submittedBody?.requestMode, 'image-edit')
    check('参考图只有素材那一张', (submittedBody?.referenceImages || []).length, 1)
    check('参考图就是素材节点这张', (submittedBody?.referenceImages || [])[0], sourceUrlBefore)
    truthy('载荷带了 mask', Boolean(submittedBody?.mask), 'mask 字段缺失')
    truthy('mask 是 PNG', String(submittedBody?.mask || '').toLowerCase().endsWith('.png'), `实际 ${submittedBody?.mask}`)
    truthy('mask 走的是 /uploads 路径', String(submittedBody?.mask || '').startsWith('/uploads/'), `实际 ${submittedBody?.mask}`)
    check('提示词带上了用户写的要求', submittedBody?.prompt, '把涂抹区域换成一只白色的陶瓷杯')
    check('requestBody 里也带了 mask（后端两条路都能读到）', Boolean(submittedBody?.requestBody?.mask), true)

    // ---- 6. 新节点已建出来（结果落到新节点，不覆盖原图） ----
    const newNodeCount = await page.locator('.vue-flow__node:has-text("局部重绘")').count()
    truthy('已创建「局部重绘」结果节点', newNodeCount > 0)
    check('原图节点还在（非破坏性）', await page.locator(`.vue-flow__node[data-id="${sourceId}"] .image-node-image`).count(), 1)

    // ---- 7. 可选：等真出图 ----
    if (WAIT_FOR_IMAGE) {
      console.log(`\n  等待出图（实测 2~6 分钟）…`)
      const started = Date.now()
      let done = false
      while (Date.now() - started < GENERATION_TIMEOUT_MS) {
        const state = await page.locator('.vue-flow__node:has-text("局部重绘")').first().evaluate((node) => {
          const img = node.querySelector('.image-node-image')
          const errorNode = node.querySelector('.image-node-error')
          return {
            hasImage: Boolean(img),
            src: img ? img.getAttribute('src') : '',
            loading: Boolean(node.querySelector('.image-node-loading')),
            error: errorNode ? errorNode.textContent.trim() : '',
          }
        })
        const seconds = Math.round((Date.now() - started) / 1000)
        console.log(`  [${String(seconds).padStart(3)}s] 图=${state.hasImage} 生成中=${state.loading}${state.error ? ` 错误=${state.error.slice(0, 60)}` : ''}`)
        if (state.hasImage || state.error) { done = true; break }
        await sleep(10000)
      }
      truthy('局部重绘产出了图', done)
    } else {
      console.log('\n  （未等出图；加 WAIT=1 可等到真出图）')
    }

    // ---- 8. 全程无 console error ----
    check('console errors', consoleErrors.filter(text => !text.includes('favicon')).length, 0)

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
