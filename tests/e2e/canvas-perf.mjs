#!/usr/bin/env node
/**
 * 画布性能压测（清单 F9）
 *
 * 为什么要有这个脚本：
 *   LibTV 的公开更新记录里专门提过两条 —— 「优化大量节点的画布（数千节点）卡顿体验」
 *   和「修复画布偶尔丢失节点」。我们从来没量过自己的数字，
 *   一直只是"感觉还行"。手感这种事必须有数字，否则优化没有依据、回归也发现不了。
 *
 * 做什么：往库里塞一份 N 个节点 + N-1 条边的真实画布，加载它，量两个数：
 *   1. 首屏渲染耗时（从 goto 到所有节点进入 DOM 且渲染稳定）
 *   2. 拖拽帧率（用真实鼠标拖动一个节点，统计期间的 rAF 帧数）
 * 量完自动清理夹具。
 *
 * 用法：node tests/e2e/canvas-perf.mjs [节点数，默认 1000]
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
// 第三参数传 no-edges 可做对照组：用来判断瓶颈是否来自「每个节点都遍历全部边」
const SKIP_EDGES = process.argv[3] === 'no-edges'
const COLS = 20
/** 夹具实际会生成的边数（每行首除外，各连一条）*/
const EDGE_TOTAL = SKIP_EDGES ? 0 : Math.max(0, NODE_COUNT - Math.ceil(NODE_COUNT / COLS))

/** 造一份形状与真实画布一致的节点（Vue Flow 会自己补 dimensions/handleBounds 等运行时字段） */
const buildFixture = (count) => {
  const nodes = []
  const edges = []
  const now = Date.now()

  for (let i = 0; i < count; i += 1) {
    const id = `perf_${i}`
    // 交替文本/图片节点，贴近真实画布的混合形态
    const isText = i % 3 !== 0
    nodes.push({
      id,
      type: isText ? 'text' : 'image',
      position: { x: (i % COLS) * 420 + 100, y: Math.floor(i / COLS) * 360 + 100 },
      data: isText
        ? { label: `文本 ${i}`, content: `第 ${i} 段内容，用于压测的占位文本。`, createdAt: now, updatedAt: now }
        : { label: `图片 ${i}`, url: '', prompt: '', createdAt: now, updatedAt: now },
    })

    // 每条边把第 i 个连到第 i+1 个（隔列时跳过，避免大量交叉线）
    if (!SKIP_EDGES && i > 0 && i % COLS !== 0) {
      edges.push({
        id: `perf_e_${i}`,
        source: `perf_${i - 1}`,
        target: id,
        sourceHandle: 'right',
        targetHandle: 'left',
      })
    }
  }

  return { nodes, edges }
}

const createFixture = async (connection, nodes, edges) => {
  const workflowId = randomUUID()
  const versionId = randomUUID()

  await connection.query(
    `INSERT INTO workflow_definitions
       (id, user_id, code, name, description, category, scene, source_type, status, latest_version_no)
     VALUES (?, ?, ?, ?, ?, 'basic', 'WORKFLOW_CANVAS', 'VISUAL', 'DRAFT', 1)`,
    [workflowId, USER_ID, `perf-${Date.now()}`, `压测夹具 ${nodes.length} 节点`, 'canvas-perf.mjs 自动创建，跑完即删'],
  )
  await connection.query(
    `INSERT INTO workflow_definition_versions
       (id, workflow_id, version_no, nodes_json, edges_json, status)
     VALUES (?, ?, 1, ?, ?, 'DRAFT')`,
    [versionId, workflowId, JSON.stringify(nodes), JSON.stringify(edges)],
  )

  return workflowId
}

const removeFixture = async (connection, workflowId) => {
  await connection.query('DELETE FROM workflow_definition_versions WHERE workflow_id = ?', [workflowId])
  await connection.query('DELETE FROM workflow_definitions WHERE id = ?', [workflowId])
}

const main = async () => {
  console.log(`\n【画布性能压测】${NODE_COUNT} 个节点 / ${NODE_COUNT - Math.ceil(NODE_COUNT / COLS)} 条边\n`)

  const connection = await mariadb.createConnection(DB_URL)
  const { nodes, edges } = buildFixture(NODE_COUNT)
  const workflowId = await createFixture(connection, nodes, edges)
  console.log(`  夹具已写入：workflowId=${workflowId}`)

  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true })
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  if (SESSION_TOKEN) {
    await context.addCookies([{ name: 'canana_session', value: SESSION_TOKEN, domain: 'localhost', path: '/' }])
  }
  const page = await context.newPage()

  try {
    // ---- 1. 首屏渲染 ----
    const started = Date.now()
    await page.goto(`${APP_URL}/workflow?workflowId=${workflowId}`, { waitUntil: 'domcontentloaded' })
    // 判据：画布上出现节点，且数量在 600ms 内不再变化。
    // 不用「节点数 == N」—— 开启视口虚拟化后，DOM 里只有可见的那部分节点，
    // 那个判据会永远等不到。
    await page.waitForFunction(() => document.querySelectorAll('.vue-flow__node').length > 0, null, { timeout: 60000 })
    await page.waitForFunction(() => {
      const n = document.querySelectorAll('.vue-flow__node').length
      const stable = window.__perfStableCount === n
      window.__perfStableCount = n
      window.__perfStableSince = stable ? (window.__perfStableSince || Date.now()) : null
      return stable && window.__perfStableSince && Date.now() - window.__perfStableSince > 600
    }, null, { timeout: 60000, polling: 100 })
    const firstPaintMs = Date.now() - started

    // 再等两帧渲染稳定，避免把测量落在中间态
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const settledMs = Date.now() - started

    // ---- 2. 拖拽帧率 ----
    const target = await page.locator('.vue-flow__node').first().boundingBox()
    const startX = target.x + target.width / 2
    const startY = target.y + 20

    await page.evaluate(() => {
      window.__perfFrames = 0
      window.__perfStopped = false
      const tick = () => {
        if (window.__perfStopped) return
        window.__perfFrames += 1
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })

    await page.mouse.move(startX, startY)
    await page.mouse.down()
    const dragStart = Date.now()
    const steps = 60
    for (let i = 1; i <= steps; i += 1) {
      await page.mouse.move(startX + i * 4, startY + Math.sin(i / 6) * 30)
    }
    const dragMs = Date.now() - dragStart
    await page.mouse.up()
    const frames = await page.evaluate(() => {
      window.__perfStopped = true
      return window.__perfFrames
    })
    const fps = dragMs > 0 ? (frames / dragMs) * 1000 : 0

    // ---- 3. DOM 规模（虚拟化生效时远小于总节点数；也用来确认没丢节点）----
    const domStats = await page.evaluate(() => ({
      nodes: document.querySelectorAll('.vue-flow__node').length,
      edges: document.querySelectorAll('.vue-flow__edge').length,
    }))

    console.log('  ─────────────────────────────────────────')
    console.log(`  首屏渲染到全部节点进 DOM   ${firstPaintMs} ms`)
    console.log(`  渲染稳定（+2 帧）          ${settledMs} ms`)
    console.log(`  拖拽 ${steps} 步 / ${dragMs} ms 下   ${frames} 帧  →  ${fps.toFixed(1)} FPS`)
    console.log(`  DOM 实际节点 / 连线        ${domStats.nodes} / ${domStats.edges}`)
    console.log('  ─────────────────────────────────────────\n')

    if (domStats.edges === 0 && EDGE_TOTAL > 0) {
      console.log(`  ⚠️ 有 ${EDGE_TOTAL} 条边但 DOM 里 0 条 —— 需要排查\n`)
    }
    console.log(`  DOM 节点数 ${domStats.nodes} / 总节点数 ${NODE_COUNT}  →  ${domStats.nodes < NODE_COUNT ? '视口虚拟化生效' : '全部渲染'}\n`)
  } finally {
    await browser.close()
    await removeFixture(connection, workflowId)
    await connection.end()
    console.log('  夹具已清理\n')
  }
}

main().catch((error) => {
  console.error('压测执行失败：', error)
  process.exit(1)
})
