#!/usr/bin/env node
/**
 * 路由巡检：所有共享了本次改动组件的页面都要过一遍
 *
 * 为什么需要这个：
 *   这次改动集中在「画布」相关的组件上，但其中两个是跨页面的公共件 ——
 *   ContentGenerator（首页/生成页/画布/资产画布都在用）和两个生成工具栏。
 *   单个页面的自测绿了，不代表其它引用方没被牵连。
 *   所以每改一次公共件，就要把所有引用它的路由都跑一遍，看 console 有没有报错、
 *   关键 UI 有没有掉。
 *
 * 用法：node tests/e2e/route-sweep.mjs
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('/Users/mima1234/.npm/_npx/705bc6b22212b352/node_modules/playwright-core')

const APP_URL = process.env.APP_URL || 'http://localhost:5011'
const SESSION_TOKEN = process.env.SESSION_TOKEN || ''
const CHROME_PATH = '/Users/mima1234/.local/lib/chrome-for-testing/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

/** 期望出现的关键 UI 选择器，用来判断页面没白屏 */
const ROUTES = [
  { path: '/', name: '首页', expect: ['#app'] },
  { path: '/generate', name: '生成页', expect: ['#app'] },
  // /canvas 已随废弃的 canana 原型一起删除（2026-09-21），路由与导航项都已移除
  { path: '/workflow', name: '工作流画布', expect: ['.vue-flow__pane'] },
  { path: '/agentic-assets-canvas', name: '资产画布', expect: ['#app'] },
]

let passed = 0
let failed = 0
/** 第三方资源失败汇总：不计入失败，但要在结尾报出来 */
const thirdPartyIssues = []
const check = (label, ok, detail = '') => {
  if (ok) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    console.log(`  ❌ ${label}${detail ? `\n     ${detail}` : ''}`)
  }
}

/** 这些 401 是未登录时的正常响应，不算回归 */
const IGNORABLE = [/401/, /Unauthorized/, /当前未登录/]

/**
 * 把「我们自己的报错」与「第三方资源的报错」分开。
 *
 * 为什么需要这个：首页/生成页引用了大量**热链的第三方素材**
 * （qwe-oss 的个人 OSS bucket、字节的 byteimg 与 vlabstatic），
 * 依赖代理或外网解析。代理一开、或对方 bucket 一关，这些图就全裂，
 * 于是巡检在每个路由上都会因为 ERR_NAME_NOT_RESOLVED 判失败 ——
 * 但那是环境与对方服务的问题，不是我们代码的回归。
 *
 * 判据：报错文本里出现 ERR_NAME_NOT_RESOLVED / ERR_CONNECTION / ERR_INTERNET
 * 且 URL 不是我们自己的 origin。这类只统计、不计入失败 —— **但不隐藏**，
 * 会在结果里单独报出来（它们本身是真实的产品风险，见清单 §5）。
 */
const isThirdPartyResourceError = (text) => {
  const isNetworkFailure = /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_INTERNET_DISCONNECTED|ERR_TIMED_OUT/.test(text)
  if (!isNetworkFailure) return false
  // 报错文本里带我们自己的地址就不算第三方
  return !/localhost:5011|127\.0\.0\.1:5011|localhost:5409/.test(text)
}

const main = async () => {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true })
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })

  if (SESSION_TOKEN) {
    await context.addCookies([{
      name: 'canana_session', value: SESSION_TOKEN, domain: 'localhost', path: '/',
    }])
  }

  for (const route of ROUTES) {
    console.log(`\n【${route.name}】${route.path}`)
    const page = await context.newPage()
    const errors = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))

    try {
      await page.goto(`${APP_URL}${route.path}`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(2500)

      for (const selector of route.expect) {
        const found = await page.locator(selector).count()
        check(`渲染了 ${selector}`, found > 0, `找不到 ${selector}`)
      }

      const notIgnorable = errors.filter(text => !IGNORABLE.some(re => re.test(text)))
      const thirdParty = notIgnorable.filter(isThirdPartyResourceError)
      const realErrors = notIgnorable.filter(text => !isThirdPartyResourceError(text))
      check('没有 console error（不含第三方资源）', realErrors.length === 0, realErrors.slice(0, 4).join('\n     '))
      if (thirdParty.length) {
        thirdPartyIssues.push(`${route.name}: ${thirdParty.length} 项`)
        console.log(`     ⚠️ 第三方热链资源失败 ${thirdParty.length} 项（不计入失败，但是真实风险）`)
      }

      // 记录了页面实际尺寸，避免"没报错但整页塌成 0 高"
      const size = await page.evaluate(() => ({
        h: document.body.scrollHeight,
        appChildren: document.querySelector('#app')?.children.length ?? 0,
      }))
      check('页面有实际内容', size.h > 200 && size.appChildren > 0, JSON.stringify(size))
    } catch (error) {
      check(`访问 ${route.path} 未抛异常`, false, String(error))
    } finally {
      await page.close()
    }
  }

  await browser.close()
  console.log(`\n${'─'.repeat(52)}`)
  if (thirdPartyIssues.length) {
    console.log(`  第三方热链资源失败（不计入失败）：${thirdPartyIssues.join('，')}`)
  }
  console.log(`  通过 ${passed} / 失败 ${failed}`)
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error('巡检执行失败：', error)
  process.exit(1)
})
