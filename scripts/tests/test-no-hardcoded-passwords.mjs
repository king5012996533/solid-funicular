#!/usr/bin/env node
/**
 * 防回归：扫描仓库里是否又出现「硬编码的密码字面量」。
 *
 * 背景：上线审计发现 scripts/ 里三处把管理员密码当成字面量写进了登录请求体，
 * 而 /api/system-init/status（公开）会返回 admin 用户名 —— 用户名 + 密码两半都在仓库里，
 * 谁拿到仓库谁就能登录。清掉之后必须防止再写回来。
 *
 * 只认「代码里把非空字面量赋给 password/passwd/pwd」这一种形状：
 *   - 读环境变量（process.env.X / import.meta.env）不是字面量，天然放过；
 *   - 值为空串、占位符、含空白的 UI 文案（如 "Show password"）放过，避免误报；
 *   - .env* / *.example / *.md 不在扫描范围：密钥本来就该放那里，文档也一样。
 *
 * 跑法：npx tsx scripts/tests/test-no-hardcoded-passwords.mjs（已接入 npm run test:scripts）
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '../..')

// 参与扫描的目录 / 扩展名：只扫会进仓库的源码。
const SCAN_DIRS = ['scripts', 'server', 'src', 'src-cutia', 'tests', 'prisma']
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.cjs', '.vue', '.json'])
const IGNORE_DIRS = new Set(['node_modules', 'dist', 'dist-service', '.git', 'uploads', 'coverage'])

// 值看起来是占位符 / 非密钥时放过。
const PLACEHOLDER_PATTERNS = [
  /^$/, // 空
  /^(password|passwd|pwd)$/i,
  /^(changeme|change-me|change_me|your-?password|yourpassword)$/i,
  /^(x+|y+|z+|\*+|-+|_+)$/i,
  /^</, // <...>
  /\$\{/, // 模板字符串拼接
  /^(todo|placeholder|example|dummy|fake|test)$/i,
]

// password/passwd/pwd 后跟 : 或 =，再接一个非空、无空白的引号字面量。
const HARDCODED_PASSWORD_PATTERN = /(?:^|[^\w.])(?:password|passwd|pwd)["']?\s*[:=]\s*["']([^"'\s]{4,})["']/gi

const isPlaceholder = (value) => PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value))

const shouldSkipFile = (name) => {
  if (name.endsWith('.example') || name.endsWith('.d.ts')) return true
  return false
}

const walk = async (dir) => {
  const files = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return files
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue
      files.push(...await walk(path.join(dir, entry.name)))
      continue
    }
    if (!entry.isFile()) continue
    if (shouldSkipFile(entry.name)) continue
    if (!SCAN_EXTENSIONS.has(path.extname(entry.name))) continue
    files.push(path.join(dir, entry.name))
  }
  return files
}

const findings = []

for (const dir of SCAN_DIRS) {
  const files = await walk(path.join(rootDir, dir))
  for (const filePath of files) {
    const content = await readFile(filePath, 'utf8')
    const lines = content.split(/\r?\n/)
    lines.forEach((line, index) => {
      HARDCODED_PASSWORD_PATTERN.lastIndex = 0
      let match
      while ((match = HARDCODED_PASSWORD_PATTERN.exec(line)) !== null) {
        const value = match[1]
        if (isPlaceholder(value)) continue
        findings.push({
          file: path.relative(rootDir, filePath),
          line: index + 1,
          snippet: line.trim().slice(0, 160),
        })
      }
    })
  }
}

if (findings.length === 0) {
  console.log('  ok   仓库中未发现硬编码密码字面量')
  process.exit(0)
}

console.log(`  FAIL 发现 ${findings.length} 处疑似硬编码密码（应改为从环境变量读取）：`)
for (const item of findings) {
  console.log(`    - ${item.file}:${item.line}  ${item.snippet}`)
}
process.exit(1)
