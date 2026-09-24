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

console.log(`\n${'─'.repeat(52)}`)
console.log(`  通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
