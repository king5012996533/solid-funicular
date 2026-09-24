/**
 * 发布/运维配置的回归测试（防止再次出现"跑不通的上线路径"）。
 *
 * 覆盖审计发现的具体问题：
 *   · CI 触发分支写成 master（仓库实际是 main）→ 流水线永不触发；
 *   · deploy.yml 写 .env 而 compose 读 .env.production → 变量全缺；
 *   · 部署时 docker image prune 删掉回滚素材；
 *   · 容器 PID 1 是 npm，SIGTERM 到不了 node；
 *   · 打包服务漏带生产启动脚本/环境变量校验模块。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relativePath) => readFileSync(path.join(rootDir, relativePath), 'utf8')

let passed = 0
let failed = 0

function check(label, actual, expected) {
  if (actual === expected) {
    passed += 1
    console.log(`  ✅ ${label}`)
  } else {
    failed += 1
    console.log(`  ❌ ${label}\n     期望 ${JSON.stringify(expected)}\n     实际 ${JSON.stringify(actual)}`)
  }
}

console.log('\n【A】CI 触发分支必须存在（main），全仓库不能残留 master 触发')
{
  const workflowDir = path.join(rootDir, '.github/workflows')
  const workflowFiles = readdirSync(workflowDir).filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))

  const dockerImage = read('.github/workflows/docker-image.yml')
  check('docker-image.yml 触发 main', /branches:\s*\n\s*-\s*main\b/.test(dockerImage), true)
  check('docker-image.yml 不再触发 master', /-\s*master\b/.test(dockerImage), false)

  const offenders = workflowFiles.filter((name) => {
    const content = read(`.github/workflows/${name}`)
    // 只关心触发分支声明里的 master（注释/说明文字不算）。
    return /^\s*-\s*master\s*$/m.test(content)
  })
  check('没有任何 workflow 把 master 当作触发分支', offenders.join(','), '')
}

console.log('\n【B】compose 与环境文件名必须一致')
{
  const compose = read('docker-compose.yml')
  const deploy = read('.github/workflows/deploy.yml')
  check('compose env_file 读 .env.production', compose.includes('${APP_ENV_FILE:-./.env.production}'), true)
  check('deploy 写 .env.production', deploy.includes('cat > .env.production'), true)
  check('deploy 不再写裸 .env', /cat > \.env\b\s*<</.test(deploy), false)
}

console.log('\n【F】容器 PID 1 直接是 node，且启动脚本会转发信号')
{
  const dockerfile = read('Dockerfile')
  check('Dockerfile CMD 用 node 直启 start-production.mjs', dockerfile.includes('CMD ["node", "start-production.mjs"]'), true)
  check('Dockerfile 不再用 npm run start 作为 CMD', /CMD \["npm"/.test(dockerfile), false)
  check('声明 STOPSIGNAL SIGTERM', dockerfile.includes('STOPSIGNAL SIGTERM'), true)

  const startScript = read('scripts/start-production.mjs')
  check('启动脚本会转发 SIGTERM', startScript.includes('SIGTERM'), true)
}

console.log('\n【D】生产变量校验已接线到启动链路')
{
  check('start-production.mjs 调用 assertProductionEnv', read('scripts/start-production.mjs').includes('assertProductionEnv'), true)
  check('service 启动脚本调用 assertProductionEnv', read('scripts/service-start-production.mjs').includes('assertProductionEnv'), true)
  check('server/index.ts 调用 assertProductionEnv', read('server/index.ts').includes('assertProductionEnv'), true)
  check('打包脚本带上校验模块', read('scripts/build-server-service.mjs').includes('startup-env-validation.mjs'), true)
  check('打包脚本带上服务启动脚本', read('scripts/build-server-service.mjs').includes('service-start-production.mjs'), true)
}

console.log('\n【G】readiness 探依赖并接到编排健康检查')
{
  check('server/index.ts 注册 /api/ready', read('server/index.ts').includes('"/api/ready"'), true)
  check('compose 健康检查用 /api/ready', read('docker-compose.yml').includes('/api/ready'), true)
}

console.log('\n【H】回滚素材：不 prune + 可注入 tag')
{
  const deploy = read('.github/workflows/deploy.yml')
  // 只匹配真正会被执行的命令行，注释里提到 "docker image prune" 不算。
  check('deploy 不再执行 docker image prune', /^\s*docker image prune/m.test(deploy), false)
  check('deploy 记录 .deployed-version', deploy.includes('.deployed-version'), true)
  check('deploy 用 IMAGE_TAG 部署', deploy.includes('IMAGE_TAG="$IMAGE_TAG"'), true)
  check('compose 镜像 tag 可由 IMAGE_TAG 注入', read('docker-compose.yml').includes('${IMAGE_TAG:-latest}'), true)
  check('镜像流水线产出 sha tag', read('.github/workflows/docker-image.yml').includes('type=sha'), true)
}

console.log('\n【I】打包服务的运行时依赖必须覆盖后端源码的全部裸导入')
{
  // 打包用的是 `packages: 'external'`：源码里的裸导入会原样留在产物顶层。
  // 清单少写一个，容器里 `node server/index.js` 就在 module link 阶段
  // ERR_MODULE_NOT_FOUND 退出（2026-09-25 实测：漏 @earendil-works/pi-* 时镜像起不来）。
  const buildScript = read('scripts/build-server-service.mjs')
  const listBody = buildScript.match(/RUNTIME_DEPENDENCY_NAMES = \[([\s\S]*?)\]/)?.[1] || ''
  const declared = new Set([...listBody.matchAll(/'([^']+)'/g)].map((match) => match[1]))

  const serverDir = path.join(rootDir, 'server')
  const bareImports = new Set()
  for (const relativePath of readdirSync(serverDir, { recursive: true })) {
    if (!String(relativePath).endsWith('.ts')) {
      continue
    }
    const content = readFileSync(path.join(serverDir, relativePath), 'utf8')
    const specs = [
      ...content.matchAll(/from\s+['"]([^'"]+)['"]/g),
      ...content.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
    ].map((match) => match[1])
    for (const spec of specs) {
      if (spec.startsWith('.') || spec.startsWith('node:')) {
        continue
      }
      bareImports.add(
        spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0],
      )
    }
  }

  const missing = [...bareImports].filter((name) => !declared.has(name)).sort()
  check(
    `运行时依赖清单覆盖后端裸导入${missing.length ? `（缺 ${missing.join(', ')}）` : ''}`,
    missing.length,
    0,
  )
}

console.log('\n【J】后端接管的信号必须覆盖启动脚本转发的信号')
{
  // 启动脚本转发什么信号，后端就得注册什么信号；漏一个，默认处置是直接杀掉进程
  // （SIGHUP 默认退出码 129），等于绕开优雅停机把在途任务切断。
  const forwardList =
    read('scripts/service-start-production.mjs').match(/FORWARD_SIGNALS = \[([^\]]*)\]/)?.[1] || ''
  const forwarded = [...forwardList.matchAll(/'([A-Z]+)'/g)].map((match) => match[1])
  const indexTs = read('server/index.ts')

  check('启动脚本转发 SIGTERM', forwarded.includes('SIGTERM'), true)
  for (const signal of forwarded) {
    check(
      `server/index.ts 注册 ${signal}`,
      new RegExp(`process\\.on\\("${signal}"`).test(indexTs),
      true,
    )
  }
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
