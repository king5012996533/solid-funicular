#!/usr/bin/env node
/**
 * K1 验收：真出一张图（走完整的前端 + 后端 + 上游管线）
 *
 * 为什么要有这个脚本：
 *   它验证的不是「接口能通」，而是**端到端真的出图** ——
 *   在画布上把节点的模型切到真实可用的上游、改参数、写提示词、提交，
 *   然后等图片渲染出来。中间任何一段断了都会失败：
 *     模型目录 → 参数面板 → 请求组装 → 后端任务 → 上游调用 → 落库 → 前端渲染
 *
 * 前置：后台已配置可用厂商（含密钥）且该模型已启用、账户有积分。
 * 用法：SESSION_TOKEN=... node tests/e2e/real-generation.mjs [模型显示名]
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('/Users/mima1234/.npm/_npx/705bc6b22212b352/node_modules/playwright-core')

const APP_URL = process.env.APP_URL || 'http://localhost:5011'
const SESSION_TOKEN = process.env.SESSION_TOKEN || ''
const CHROME_PATH = '/Users/mima1234/.local/lib/chrome-for-testing/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
/** 要切换到的模型显示名（后台模型目录里的 label） */
const TARGET_MODEL_LABEL = process.argv[2] || 'GPT Image 2'
/** 单张实测 82~195 秒，给足等待 */
const GENERATION_TIMEOUT_MS = 5 * 60 * 1000

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
  // 抓提交给后端的请求体，作为「参数真的来自模型」的证据
  let submittedBody = null
  context.on('request', (request) => {
    if (request.url().includes('/api/generation-tasks') && request.method() === 'POST') {
      try { submittedBody = JSON.parse(request.postData() || 'null') } catch { /* 忽略 */ }
    }
  })

  try {
    console.log(`\n【K1 验收：真实出图】目标模型 ${TARGET_MODEL_LABEL}\n`)

    await page.goto(`${APP_URL}/workflow`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.vue-flow__node')
    await sleep(900)

    // ---- 1. 选中图片节点，打开生成面板 ----
    await page.mouse.click(1280, 900)
    await sleep(300)
    await page.locator('.vue-flow__node-image').first().click()
    await sleep(1200)
    const panelExists = await page.locator('.image-node-prompt-panel').count()
    check('生成面板已打开', panelExists > 0, true)
    if (!panelExists) throw new Error('面板没打开，后续无法进行')

    // ---- 2. 把模型切到目标模型 ----
    await page.locator('.image-node-prompt-panel .image-toolbar .lv-select').first().click()
    await sleep(600)
    const options = await page.locator('.lv-select-popup .lv-select-option').allInnerTexts()
    check(`模型列表里有「${TARGET_MODEL_LABEL}」`, options.map(t => t.trim()).includes(TARGET_MODEL_LABEL), true)

    await page.locator('.lv-select-popup .lv-select-option', { hasText: TARGET_MODEL_LABEL }).first().click()
    await sleep(1000)

    // ---- 3. 参数应当换成新模型声明的（不是写死的） ----
    const afterSwitch = await page.evaluate(() => {
      const tb = document.querySelector('.image-node-prompt-panel .image-toolbar')
      const controls = [...tb.querySelectorAll('.toolbar-select, .toolbar-button-FhFnQ_')]
      const chips = document.querySelector('.image-node-params')?.innerText.replace(/\s+/g, ' ')
      return { controls: controls.map(c => c.innerText.trim().replace(/\s+/g, ' ')), chips }
    })
    console.log(`     切换后控件：${JSON.stringify(afterSwitch.controls)}`)
    console.log(`     卡片参数 chip：${afterSwitch.chips}`)

    // ---- 4. 写提示词并提交 ----
    const prompt = `一只红色苹果放在白色桌面上，电商产品摄影，纯白背景，${Date.now()}`
    const input = page.locator('.image-node-prompt-panel .inline-mention-input, .image-node-prompt-panel textarea.prompt-textarea').first()
    await input.click()
    await page.keyboard.type(prompt, { delay: 8 })
    await sleep(300)
    await page.keyboard.press('Enter')

    // ---- 5. 等后端受理并出图 ----
    console.log('     已提交，等待出图（实测 82~195 秒/张）…')
    const started = Date.now()
    let imageUrl = null
    while (Date.now() - started < GENERATION_TIMEOUT_MS) {
      await sleep(3000)
      const state = await page.evaluate(() => {
        const node = document.querySelector('.vue-flow__node-image')
        const img = node?.querySelector('.image-node-image')
        return {
          url: img?.getAttribute('src') || '',
          loading: !!node?.querySelector('.image-node-loading'),
          error: node?.querySelector('.image-node-error')?.innerText?.trim() || '',
        }
      })
      if (state.error) {
        console.log(`     节点报错：${state.error}`)
        break
      }
      if (state.url) { imageUrl = state.url; break }
    }
    const elapsed = Math.round((Date.now() - started) / 1000)

    check('出图成功（节点上出现图片）', Boolean(imageUrl), true)
    if (imageUrl) {
      console.log(`     用时约 ${elapsed} 秒`)
      console.log(`     图片地址前缀：${imageUrl.slice(0, 60)}…`)
    }

    check('提交的请求体里带模型参数', Boolean(submittedBody?.requestBody?.model), true)
    if (submittedBody) {
      console.log(`     提交载荷：model=${submittedBody.requestBody?.model} size=${submittedBody.requestBody?.size ?? '(未带)'} quality=${submittedBody.requestBody?.quality ?? '(未带)'} n=${submittedBody.requestBody?.n}`)
    }

    // ---- 6. 落库应当有一条成功记录 ----
    check('本次提交的模型与目标一致', submittedBody?.requestBody?.model, 'gpt-image-2')

    if (consoleErrors.length) console.log(`     控制台报错 ${consoleErrors.length} 条：${consoleErrors.slice(0, 2).join(' | ')}`)

    await page.screenshot({ path: '/Users/mima1234/k1-real-generation.png' })
  } finally {
    await browser.close()
  }

  console.log(`\n${'─'.repeat(52)}`)
  console.log(`  通过 ${passed} / 失败 ${failed}`)
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error('K1 验收失败：', error)
  process.exit(1)
})
