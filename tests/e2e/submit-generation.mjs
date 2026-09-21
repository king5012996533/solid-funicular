#!/usr/bin/env node
/**
 * 提交一次真实图片生成并全程轮询
 *
 * 为什么单独写：这条链路要等 80~200 秒，用 shell 拼 curl + case 判断状态
 * 在 zsh 下很容易撞到通配/引号问题（已经撞过一次）。用 Node 写清楚一点。
 *
 * 用法：SESSION_TOKEN=... node tests/e2e/submit-generation.mjs
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)

const API = process.env.API_BASE || 'http://127.0.0.1:5409'
const TOKEN = process.env.SESSION_TOKEN || ''
const PROVIDER_ID = process.env.PROVIDER_ID || 'cmub9tmb500cr96wpql0pwlc3'
const MODEL_KEY = process.env.MODEL_KEY || 'gpt-image-2'
const SIZE = process.env.SIZE || '1024x1024'
const QUALITY = process.env.QUALITY || 'standard'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const headers = {
  'Content-Type': 'application/json',
  Cookie: `canana_session=${TOKEN}`,
}

const prompt = `一只红色苹果放在白色桌面上，电商产品摄影，纯白背景，${Date.now()}`

const payload = {
  source: 'workflow',
  type: 'image',
  requestMode: 'image-generation',
  prompt,
  modelKey: MODEL_KEY,
  ratio: SIZE,
  resolution: QUALITY,
  referenceImages: [],
  requestBody: {
    model: MODEL_KEY,
    prompt,
    n: 1,
    providerId: PROVIDER_ID,
    size: SIZE,
    quality: QUALITY,
  },
}

const main = async () => {
  console.log(`\n【提交真实生成】model=${MODEL_KEY} size=${SIZE} quality=${QUALITY}\n`)

  const created = await fetch(`${API}/api/generation-tasks`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  }).then(r => r.json())

  const taskId = created?.data?.id
  if (!taskId) {
    console.log('  提交失败：', JSON.stringify(created).slice(0, 300))
    process.exit(1)
  }
  console.log(`  taskId = ${taskId}`)

  const started = Date.now()
  const history = []
  for (let i = 0; i < 30; i += 1) {
    await sleep(10_000)
    const detail = await fetch(`${API}/api/generation-tasks/${taskId}`, { headers }).then(r => r.json())
    const d = detail?.data || {}
    const images = Array.isArray(d.images) ? d.images : []
    const line = `  [${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s] done=${d.done} stopped=${d.stopped} images=${images.length}${d.error ? ` error=${String(d.error).slice(0, 80)}` : ''}`
    console.log(line)
    history.push(line)
    if (d.done || d.stopped || images.length || d.error) break
  }

  // 收尾状态
  const final = await fetch(`${API}/api/generation-tasks/${taskId}`, { headers }).then(r => r.json())
  const fd = final?.data || {}
  const images = Array.isArray(fd.images) ? fd.images : []
  console.log(`\n  最终：done=${fd.done} images=${images.length}`)
  if (images[0]) {
    const head = String(images[0]).slice(0, 70)
    console.log(`  图片来源前缀：${head}…`)
    console.log(`  是否 base64 内联：${head.startsWith('data:') ? '是' : '否（是文件地址）'}`)
  }
  if (fd.error) console.log(`  error: ${String(fd.error).slice(0, 300)}`)

  // 同时把这次请求的耗时和结果写进一个文件，供后续脚本引用
  console.log(`\n  TASK_ID=${taskId}`)
}

main().catch((error) => {
  console.error('执行失败：', error)
  process.exit(1)
})
