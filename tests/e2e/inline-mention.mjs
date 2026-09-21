#!/usr/bin/env node
/**
 * 内联 @ 引用 chip（清单 F8）端到端验证。
 *
 * 链路：样本画布的图片节点先上传一张图 → 它自动长出下游节点（消费方）→
 *       消费方的 composer 换成 contenteditable 的 chip 输入框（原先的 textarea 不再渲染）→
 *       敲 @ → 选「图片1」→ token 落成**内联 chip**（不是纯文本）→ 继续打字 →
 *       用 CDP 驱动一次真实的中文组字 → 提交 → 检查 /api/generation-tasks 的载荷
 *       与 textarea 时代逐字段一致（prompt 已解析、referenceImages 只有显式引用那张）。
 *
 * 为什么必须真鼠标 / 真键盘 + 真 IME：
 *   面板开启由「输入事件后的纯文本光标」驱动，chip 插入后还要按纯文本偏移还原光标；
 *   合成事件（isTrusted=false）既不更新真实选区，也不驱动 Vue 的 v-model 与提交路径。
 *   中文组字更是只有真实输入法行为才认 —— 这里用 CDP 的 Input.imeSetComposition。
 *
 * 用法：node tests/e2e/inline-mention.mjs
 * 前置：前端跑在 127.0.0.1:5011，且已登录（脚本自己灌 session cookie）。
 */

import { createRequire } from 'node:module'
import { assertNoConsoleErrors } from './lib/console-filters.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require('/Users/mima1234/.npm/_npx/705bc6b22212b352/node_modules/playwright-core')

const APP_URL = process.env.APP_URL || 'http://localhost:5011'
const API_BASE = process.env.API_BASE_URL || 'http://localhost:5409'
const SESSION_TOKEN = process.env.SESSION_TOKEN || ''
const CHROME_PATH = '/Users/mima1234/.local/lib/chrome-for-testing/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

/** 1×1 透明 PNG：只在存储里造一个真实可访问的图片资产 */
const PROBE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const EDITOR_SELECTOR = '.image-node-prompt-panel .inline-mention-input'

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

/** 提供的 session 是否还有效。失效时整条链路会被登录浮层挡住、提交也会被拦下 */
const probeSession = async (context) => {
  try {
    const response = await context.request.get(`${API_BASE}/api/auth/session`)
    const body = await response.json()
    return Boolean(body?.data?.user?.id)
  } catch {
    return false
  }
}

/**
 * 登录态桩：只顶替 /api/auth/session 一个接口。
 *
 * 这个环境里的 session 已经失效（/api/auth/session 返回 user:null），
 * 失效时首页会弹登录浮层盖住整页（pointer-events 全被它吃掉），
 * 而且 handleSubmit 会在「未登录」处直接 return —— 那样 chip 与 IME 根本无从验证。
 * 桩只影响登录态判断，不碰生成链路；有有效 session 时不会走这条分支。
 */
const stubAuthSession = () => {
  const original = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    if (url.includes('/api/auth/session')) {
      return new Response(JSON.stringify({
        data: {
          user: {
            id: 'e2e-inline-mention', name: 'e2e', phone: '', email: '',
            maskedPhone: 'e2e', maskedEmail: 'e2e', avatarUrl: '',
            role: 'USER', loginMethodType: 'ADMIN_PASSWORD',
          },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return original(input, init)
  }
}

/** 读编辑器里序列化出来的纯文本（文本节点 + chip 上存的 token 原文） */
const readPlainValue = (page) => page.evaluate((selector) => {
  const el = document.querySelector(selector)
  if (!el) return null
  let text = ''
  el.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) text += node.nodeValue || ''
    else text += node.getAttribute('data-mention-token') || node.textContent || ''
  })
  return text
}, EDITOR_SELECTOR)

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
  const sessionValid = SESSION_TOKEN ? await probeSession(context) : false
  if (!sessionValid) {
    console.log('\n  ⚠️ session 无效（/api/auth/session 返回 user:null）：用桩顶替登录态，仅为了让 chip 链路可跑')
    await page.addInitScript(stubAuthSession)
  }

  const cdp = await context.newCDPSession(page)
  const consoleErrors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  await page.goto(`${APP_URL}/workflow`, { waitUntil: 'networkidle' })
  if (!sessionValid) {
    // 登录浮层是全屏遮罩，会吃掉所有指针事件（连画布点击都收不到）
    await page.addStyleTag({ content: '.login-modal-host { display: none !important }' })
  }
  await page.waitForSelector('.vue-flow__node', { timeout: 15000 })

  const imageNodes = page.locator('.vue-flow__node-image')
  const panel = page.locator('.image-node-prompt-panel')
  const editor = page.locator(EDITOR_SELECTOR)
  const chips = page.locator(`${EDITOR_SELECTOR} .inline-mention-chip`)

  /** 聚焦编辑框：浮层场景里定位点击可能被其它层挡住，退回 DOM 聚焦（后续输入仍是真实键盘） */
  const focusEditor = async () => {
    try {
      await editor.click({ timeout: 3000 })
    } catch {
      await editor.focus()
    }
  }

  console.log('\n【1】造链路：样本图片节点上传后自动长出下游节点（消费方）')
  const imageCountBefore = await imageNodes.count()
  await imageNodes.first().locator('input[type="file"][accept="image/*"]').setInputFiles({
    name: 'upstream-a.png', mimeType: 'image/png', buffer: Buffer.from(PROBE_PNG_BASE64, 'base64'),
  })
  await page.waitForTimeout(1800)
  check('上传后自动长出下游图片节点', await imageNodes.count(), imageCountBefore + 1)

  const upstreamUrl = await imageNodes.first().locator('.image-node-image').getAttribute('src')
  check('上游拿到真实图片 url', /^\/uploads\//.test(String(upstreamUrl || '')), true)

  await panel.waitFor({ state: 'visible', timeout: 15000 })
  check('消费方节点已选中（下方浮出 composer）', await panel.count(), 1)

  console.log('\n【2】输入框已换成 contenteditable 的 chip 输入框')
  await editor.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {})
  check('chip 输入框可见', await editor.count(), 1)
  check('同位置不再渲染 textarea', await page.locator('.image-node-prompt-panel textarea.prompt-textarea').count(), 0)
  const editableAttr = await editor.getAttribute('contenteditable')
  check('是 contenteditable', editableAttr, 'true')
  check('空态显示 placeholder 文字', await page.locator(`${EDITOR_SELECTOR} ~ .inline-mention-placeholder`).count(), 1)

  console.log('\n【3】敲 @ → 弹出素材引用面板')
  await focusEditor()
  await page.keyboard.press('Meta+A')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(200)
  await page.keyboard.type('@')
  await page.waitForSelector('.mention-picker', { timeout: 5000 })
  const pickerRows = page.locator('.mention-picker__row')
  check('一级菜单只列出有资产的种类', await page.locator('.mention-picker__row-name').allInnerTexts(), ['图片'])
  check('种类后面的数量是上游图片数', await page.locator('.mention-picker__row-token').allInnerTexts(), ['1'])

  console.log('\n【4】选「图片1」→ token 渲染成内联 chip（不是纯文本）')
  await pickerRows.first().click()
  await page.waitForTimeout(250)
  await pickerRows.first().click()
  await page.waitForTimeout(350)

  check('面板已自动关闭', await page.locator('.mention-picker').count(), 0)
  check('插入后是一个 chip 元素', await chips.count(), 1)
  check('chip 文本是 @图片1', (await chips.first().innerText()).trim(), '@图片1')
  check('chip 不可编辑（整体作为一个引用）', await chips.first().getAttribute('contenteditable'), 'false')
  check('chip 上存了 token 原文', await chips.first().getAttribute('data-mention-token'), '@图片1')
  check('底层纯文本与 textarea 时代逐字符一致', await readPlainValue(page), '@图片1 ')
  check('没有多余的裸 token 文本', await page.evaluate((selector) => {
    const el = document.querySelector(selector)
    return el ? el.textContent : null
  }, EDITOR_SELECTOR), '@图片1 ')
  const focusedAfterInsert = await page.evaluate((selector) =>
    document.activeElement === document.querySelector(selector), EDITOR_SELECTOR)
  check('插入后焦点仍在输入框', focusedAfterInsert, true)

  // 序列化出来的纯文本必须能直接喂给既有的解析层：「已引用」行是解析结果的消费者，
  // 它出现即说明 chip 没有把 token 弄丢，也没有多出 DOM 特有的字符
  const referredItems = page.locator('.image-node-prompt-panel .mentioned-reference-item')
  check('「已引用」行认出这张图', await referredItems.count(), 1)
  check('缩略图就是被引用的那张',
    await referredItems.first().locator('img').getAttribute('src'), upstreamUrl)

  console.log('\n【5】继续打字：普通文本与 chip 可以混排，底层仍是纯文本')
  await page.keyboard.type('一只金毛，水彩风格')
  await page.waitForTimeout(300)
  check('chip 数量不变', await chips.count(), 1)
  check('纯文本 = token + 正文', await readPlainValue(page), '@图片1 一只金毛，水彩风格')
  check('正文没有被 chip 化', await page.locator(`${EDITOR_SELECTOR} .inline-mention-chip`).count(), 1)

  console.log('\n【6】中文 IME：CDP 驱动真实组字，组字中不得重建 chip')
  // 组字前把 chip 的节点身份存到 window，组字结束后比对是不是同一个 DOM 节点 ——
  // 只要组件在 composition 期间重渲染，这个引用就会失效。
  await page.evaluate((selector) => {
    const el = document.querySelector(selector)
    window.__chipProbe = el ? el.querySelector('.inline-mention-chip') : null
    window.__chipMutations = 0
    window.__chipObserver = new MutationObserver((records) => {
      records.forEach((record) => { window.__chipMutations += record.removedNodes.length })
    })
    window.__chipObserver.observe(el, { childList: true, subtree: true })
  }, EDITOR_SELECTOR)

  // 光标放到末尾，然后开始一次真实的组字（composing）
  await page.evaluate((selector) => {
    const el = document.querySelector(selector)
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    el.focus()
  }, EDITOR_SELECTOR)
  await page.keyboard.type('，')
  await page.waitForTimeout(200)

  let imeDriven = true
  try {
    await cdp.send('Input.imeSetComposition', { text: '水彩', selectionStart: 2, selectionEnd: 2 })
  } catch (error) {
    imeDriven = false
    console.log(`  ⚠️ CDP Input.imeSetComposition 不可用：${error.message}`)
  }
  await page.waitForTimeout(250)

  const duringComposition = await page.evaluate((selector) => {
    const el = document.querySelector(selector)
    return {
      sameChipNode: !!window.__chipProbe && window.__chipProbe === el.querySelector('.inline-mention-chip'),
      chipConnected: !!window.__chipProbe && window.__chipProbe.isConnected,
      chipCount: el.querySelectorAll('.inline-mention-chip').length,
      chipRemovals: window.__chipMutations,
      composingText: el.textContent,
    }
  }, EDITOR_SELECTOR)

  check('IME 由 CDP 真实驱动（组字中）', imeDriven, true)
  check('组字中 chip 还是同一个 DOM 节点', duringComposition.sameChipNode, true)
  check('组字中 chip 没有被摘掉', duringComposition.chipConnected, true)
  check('组字中 chip 数量不变', duringComposition.chipCount, 1)
  check('组字中没有任何 chip 节点被移除', duringComposition.chipRemovals, 0)
  check('组字文本已进入编辑器', duringComposition.composingText.includes('水彩'), true)

  // 上屏：把候选词提交为正文
  if (imeDriven) {
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
    await cdp.send('Input.insertText', { text: '水彩' })
  } else {
    await page.keyboard.insertText('水彩')
  }
  await page.waitForTimeout(300)

  const finalPlain = await readPlainValue(page)
  check('上屏后纯文本正确', finalPlain, '@图片1 一只金毛，水彩风格，水彩')
  check('上屏后 chip 未被打断', await chips.count(), 1)
  check('上屏后没有 console error 级异常', consoleErrors.filter(t => /composit|mention/i.test(t)), [])

  console.log('\n【7】提交 → 载荷与 textarea 时代一致')
  const requestPromise = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().includes('/api/generation-tasks'),
    { timeout: 20000 },
  )
  await focusEditor()
  await page.keyboard.press('Enter')
  const request = await requestPromise
  const body = request.postDataJSON()

  console.log('\n  捕获的请求体：')
  console.log(JSON.stringify(body, null, 2))

  check('prompt 里的 token 已解析成正文', body.prompt, '【图片1】 一只金毛，水彩风格，水彩')
  check('referenceImages 是显式引用那张', body.referenceImages, [upstreamUrl])
  check('请求体 image 字段同步', body.requestBody?.image, [upstreamUrl])
  check('走图生图模式', body.requestMode, 'image-edit')
  check('载荷里没有 chip 的 DOM 残留', String(body.prompt).includes('<span'), false)

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
