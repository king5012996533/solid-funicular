#!/usr/bin/env node
/**
 * 画布拖拽的 CPU 热点分析（为 F9b 找出真正的瓶颈）
 *
 * 为什么需要它：
 *   F9 时我按「去掉边会快 5.6 倍」推断瓶颈在边遍历 —— 错了，索引化后帧率没变。
 *   F9b 时我按「节点卡片内容太重」推断 —— 又错了：把节点全部折叠（卡片内容
 *   几乎不渲染）后帧率仍然一点没变。
 *   猜了两次都不对，所以这里直接抓 V8 的 CPU profile，用采样数据说话。
 *
 * 做法：造 N 节点夹具 → 加载 → 开 CDP Profiler → 真实鼠标拖拽 → 停止 →
 * 按函数聚合采样命中数（近似自耗时）→ 打印热门函数。
 *
 * 用法：node tests/e2e/profile-drag.mjs [节点数]
 */

import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

const require = createRequire(import.meta.url)
const { chromium } = require('/Users/mima1234/.npm/_npx/705bc6b22212b352/node_modules/playwright-core')
const mariadb = require('/Users/mima1234/CanvasMind/node_modules/mariadb')

const APP_URL = process.env.APP_URL || 'http://localhost:5011'
const SESSION_TOKEN = process.env.SESSION_TOKEN || ''
const CHROME_PATH = '/Users/mima1234/.local/lib/chrome-for-testing/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
const DB_URL = 'mariadb://root:password@127.0.0.1:3306/canana_mind'
const USER_ID = 'cmu9zppwt000196wpcxpcd4rk'

const NODE_COUNT = Number(process.argv[2] || 1000)
const COLS = 20

const buildFixture = (count) => {
  const nodes = []
  const edges = []
  const now = Date.now()
  for (let i = 0; i < count; i += 1) {
    const id = `perf_${i}`
    const isText = i % 3 !== 0
    nodes.push({
      id,
      type: isText ? 'text' : 'image',
      position: { x: (i % COLS) * 420 + 100, y: Math.floor(i / COLS) * 360 + 100 },
      data: isText
        ? { label: `文本 ${i}`, content: `第 ${i} 段内容。`, createdAt: now, updatedAt: now }
        : { label: `图片 ${i}`, url: '', prompt: '', createdAt: now, updatedAt: now },
    })
    if (i > 0 && i % COLS !== 0) {
      edges.push({ id: `perf_e_${i}`, source: `perf_${i - 1}`, target: id, sourceHandle: 'right', targetHandle: 'left' })
    }
  }
  return { nodes, edges }
}

const main = async () => {
  const connection = await mariadb.createConnection(DB_URL)
  const { nodes, edges } = buildFixture(NODE_COUNT)
  const workflowId = randomUUID()
  const versionId = randomUUID()

  await connection.query(
    `INSERT INTO workflow_definitions (id, user_id, code, name, description, category, scene, source_type, status, latest_version_no)
     VALUES (?, ?, ?, ?, 'profile-drag.mjs 自动创建', 'basic', 'WORKFLOW_CANVAS', 'VISUAL', 'DRAFT', 1)`,
    [workflowId, USER_ID, `perf-${Date.now()}`, `热点分析 ${NODE_COUNT}`],
  )
  await connection.query(
    `INSERT INTO workflow_definition_versions (id, workflow_id, version_no, nodes_json, edges_json, status)
     VALUES (?, ?, 1, ?, ?, 'DRAFT')`,
    [versionId, workflowId, JSON.stringify(nodes), JSON.stringify(edges)],
  )

  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true })
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  // 劫持 console.warn/error 计数：控制台会把重复消息折叠显示，
  // 但热点分析需要真实调用次数（V8 里 warn 内部的 getComponentTrace 很贵）
  await context.addInitScript(() => {
    window.__warnCount = {}
    const wrap = (orig) => function (...args) {
      const key = String(args[0] || '').slice(0, 140)
      window.__warnCount[key] = (window.__warnCount[key] || 0) + 1
      return orig.apply(this, args)
    }
    console.warn = wrap(console.warn)
    console.error = wrap(console.error)
  })
  if (SESSION_TOKEN) {
    await context.addCookies([{ name: 'canana_session', value: SESSION_TOKEN, domain: 'localhost', path: '/' }])
  }
  const page = await context.newPage()

  try {
    console.log(`\n【拖拽热点分析】${NODE_COUNT} 个节点\n`)
    await page.goto(`${APP_URL}/workflow?workflowId=${workflowId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      (expected) => document.querySelectorAll('.vue-flow__node').length >= expected,
      NODE_COUNT,
      { timeout: 60000 },
    )
    await page.waitForTimeout(2000)

    const client = await context.newCDPSession(page)
    await client.send('Profiler.enable')
    // 采样间隔 200μs，抓得细一点
    await client.send('Profiler.setSamplingInterval', { interval: 200 })
    await client.send('Profiler.start')

    await page.evaluate(() => { window.__warnCount = {} })
    const box = await page.locator('.vue-flow__node').first().boundingBox()
    const startX = box.x + box.width / 2
    const startY = box.y + 20
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    for (let i = 1; i <= 60; i += 1) {
      await page.mouse.move(startX + i * 4, startY + Math.sin(i / 6) * 30)
    }
    await page.mouse.up()

    const { profile } = await client.send('Profiler.stop')

    // 按 (函数名 + 来源文件) 聚合采样命中数 —— 命中数近似该函数的自耗时
    const byFunction = new Map()
    const nodeById = new Map(profile.nodes.map(node => [node.id, node]))
    for (const node of profile.nodes) {
      const frame = node.callFrame || {}
      const url = String(frame.url || '')
      // 只看我们自己的代码 + Vue/Vue Flow，第三方 polyfill 折叠掉
      const shortUrl = url.replace(/^https?:\/\/localhost:\d+\//, '').split('?')[0]
      const key = `${frame.functionName || '(anonymous)'}  @  ${shortUrl || '(native)'}:${(frame.lineNumber ?? -1) + 1}`
      byFunction.set(key, (byFunction.get(key) || 0) + (node.hitCount || 0))
    }

    const total = [...byFunction.values()].reduce((sum, n) => sum + n, 0)
    const ranked = [...byFunction.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22)

    console.log(`  采样总数 ${total}（每样本约 200μs，合计约 ${(total * 0.2).toFixed(0)}ms CPU 时间）`)
    console.log('  ─────────────────────────────────────────────────────────────')
    console.log('   占比      采样   函数')
    for (const [key, hits] of ranked) {
      const pct = ((hits / total) * 100).toFixed(1).padStart(5)
      console.log(`   ${pct}%   ${String(hits).padStart(6)}   ${key}`)
    }
    console.log('  ─────────────────────────────────────────────────────────────')

    // 顺带报出拖拽期间的 console.warn/error 真实调用次数与内容
    const warnCounts = await page.evaluate(() => window.__warnCount || {})
    const warnTotal = Object.values(warnCounts).reduce((sum, n) => sum + n, 0)
    console.log(`\n  拖拽期间 console.warn/error 调用总数：${warnTotal}`)
    for (const [msg, n] of Object.entries(warnCounts).sort((a, b) => b[1] - a[1]).slice(0, 4)) {
      console.log(`    x${String(n).padEnd(6)} ${msg.slice(0, 110)}`)
    }
    console.log('')
  } finally {
    await browser.close()
    await connection.query('DELETE FROM workflow_definition_versions WHERE workflow_id = ?', [workflowId])
    await connection.query('DELETE FROM workflow_definitions WHERE id = ?', [workflowId])
    await connection.end()
    console.log('  夹具已清理\n')
  }
}

main().catch((error) => {
  console.error('热点分析失败：', error)
  process.exit(1)
})
