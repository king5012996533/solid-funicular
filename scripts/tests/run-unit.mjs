#!/usr/bin/env node
/**
 * 运行 tests/ 下的纯逻辑单测（`*.test.ts`）
 *
 * 为什么单独一个 runner：
 *   这批测试是 tsx 直接跑的 .ts（import 的是 src/ 里的纯函数），跟
 *   scripts/tests 下那批 .mjs 回归脚本不是一套，一直没有入口 ——
 *   文件在仓库里躺着，但没人会记得手动 `npx tsx tests/xxx.test.ts`，
 *   等于没跑。这里给它一个固定入口，并接进 `npm test`。
 *
 * 用法：npm run test:unit
 * 单个：npx tsx tests/model-params.test.ts
 */

import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '../..')
const testsDir = path.join(rootDir, 'tests')

const runScript = (filePath) => new Promise((resolve, reject) => {
  const child = spawn('npx', ['tsx', filePath], {
    cwd: rootDir,
    stdio: 'inherit',
    env: { ...process.env },
    shell: process.platform === 'win32',
  })

  child.on('error', reject)
  child.on('close', (code) => {
    if (code === 0) {
      resolve()
      return
    }
    reject(new Error(`${path.basename(filePath)} 退出码 ${code}`))
  })
})

const main = async () => {
  const files = (await readdir(testsDir))
    .filter((name) => name.endsWith('.test.ts'))
    .sort()

  if (files.length === 0) {
    console.log('[test:unit] 未找到 tests/*.test.ts')
    return
  }

  console.log(`[test:unit] 运行 ${files.length} 个测试文件…`)

  for (const file of files) {
    console.log(`\n>>> ${file}`)
    await runScript(path.join(testsDir, file))
  }

  console.log(`\n[test:unit] ${files.length} 个文件全部通过`)
}

main().catch((error) => {
  console.error('\n[test:unit] 失败:', error.message)
  process.exit(1)
})
