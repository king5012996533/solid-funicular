# 工程流程与发布能力审计（round 2 · 03）

> 审计对象：`/Users/mima1234/CanvasMind`
> 审计时间：2026-09-23
> 审计方式：只读。所有结论附**文件路径 + 行号**或**命令 + 原始输出**。仓库未被改动（见 §5 证据）。
> 审计范围：对照标准上线流程的 7 个环节（立项 / 需求 / 开发 / 测试 / 预上线 / 上线 / 上线后）。

---

## 0. 一句话结论

**这套仓库有可运行的构建、可运行的单测、可用的健康检查端点，但没有任何"上线流程"本身** ——
没有 CI 质量闸（单测不在流水线里）、没有灰度、没有回滚（镜像永远拉 `latest`）、没有监控告警、
没有 UAT / 演练 / 值守记录。更关键的是**镜像流水线监听的 `master` 分支在远端不存在**，
当前 76 个提交全部落在 `main`，因此自动化构建链从未被触发过。

---

## 1. 核对表

图例：**有** = 有可核验的实现/产物；**部分** = 有雏形但缺关键环节；**无** = 仓库内查无此项。

| 环节 | 子项 | 结论 | 证据 |
|---|---|---|---|
| **立项** | 目标文档 | **无** | `docs/` 仅 6 个文件（见 §1.1），无立项目标文档。`README.md:47` 有「当前项目定位」章节，但那是项目介绍，不是立项目标（无范围/里程碑/成功标准） |
| | 资源与风险评估 | **无** | `grep -rilE "PRD\|需求文档\|评审记录\|立项\|UAT\|验收记录\|回滚演练\|值守\|复盘" docs/ README.md` → 输出为空 |
| | 立项评审记录 | **无** | 同上；`.github/` 下仅有 2 个 workflow，无评审模板（见 §1.3） |
| **需求** | PRD | **无** | `docs/` 无 PRD；无需求来源、优先级、验收标准文档 |
| | 设计稿 / 交互说明 | **部分** | `docs/libtv-interaction-spec.md`（333 行）定义画布交互契约与该文档第 0 节「当前进度」表；`docs/canvas-theme-mapping.md`（86 行）定义色板 token 映射。但这是**内部对齐规格**（对标 LibTV），非产品设计稿；无原型/Figma 链接 |
| | 技术方案 | **部分** | `docs/libtv-reference-spec.md`（263 行，接口签名冻结）、`docs/libtv-refactor-checklist.md`（1111 行，施工队列，标注「前端/后端/Key」依赖）。属于任务拆解级，无架构决策记录（ADR）、无容量估算、无技术选型对比 |
| | 多方评审记录 | **无** | 无评审会记录、无签字/approve 痕迹。`docs/libtv-interaction-spec.md` 开头写「这份文档是并行开发的**契约**…任何人不许改接口签名」，是单向约定而非评审结论 |
| **开发** | 代码规范与 lint | **无** | 无 `.eslintrc*` / `eslint.config.*` / `.prettierrc*` / `.editorconfig`；`package.json` 无 `lint` 脚本且依赖中无 eslint/prettier（`grep -iE "eslint\|prettier\|lint\|husky\|commitlint" package.json` → `NONE`）。规范只存在于 `docs/canvas-theme-mapping.md` 的文字要求（「组件中禁止硬编码颜色」），无工具强制 |
| | CR 流程 | **无（仓库内）** | 无 `.github/PULL_REQUEST_TEMPLATE*`、无 `.github/ISSUE_TEMPLATE/`、无 `CODEOWNERS`（`.github/` 下只有 `workflows/`，`find .github -type f` 仅返回 2 个 workflow）。git 历史显示直接提交到 `main`（`git branch -a` → 仅 `main` / `remotes/origin/main`）。唯一的 hook 是 `scripts/git-hooks/commit-msg`，只过滤 AI 的 `Co-authored-by` 尾注，**不含任何质量检查**；且未被安装（`.git/hooks/` 除 sample 外为空，`ls -la .git/hooks/` 无 commit-msg） |
| | 单元自测 | **部分** | 有且能跑通：`npm run test:unit` → `[test:unit] 19 个文件全部通过`（实测，见 §1.2）。但**不在任何流水线里**（见 §1.3），只能靠人手动跑 |
| | 联调环境 | **部分** | 本地联调可用：`.env.development`（2813 字节）+ `npm run dev:all` + `docker-compose.yml`。但**无独立 staging/预发环境配置**：`.env.production.example` 只有一个「生产」模板，无 `Dockerfile.staging`、无 compose override、workflow 中无环境区分 |
| | 依赖安全检查接入流水线 | **无** | CI 中无 `npm audit` / 无 SCA 步骤（`grep -rnE "npm (run )?(test\|type-check\|lint\|audit)" .github/workflows/` 输出为空）；`Dockerfile:19` 与 `Dockerfile:68` 均显式 `--no-audit` 关闭审计；无 `.github/dependabot.yml` |
| **测试** | 功能 / 接口 / 性能 / 安全 / 兼容性用例与报告 | **部分** | 有：功能类单测 19 个文件（`tests/*.test.ts`）+ 2 个回归脚本（`scripts/tests/`）；性能类有 `tests/e2e/canvas-perf.mjs`（1000 节点渲染耗时 + 拖拽帧率）。缺：**无接口测试**（服务端 20+ 路由无测试）、**无安全测试**（无鉴权越权/注入用例）、**无兼容性测试**（仅 Chrome for Testing 单浏览器）；**无任何测试报告产物**（跑完只在终端打印，无归档） |
| | bug 闭环记录 | **部分** | `docs/audit-full-chain-2026-09-23.md`（220 行）按 A/B/D 编号记录问题，每条附控制台/网络/DOM 原文，并区分「已修复 / 待办 / 未覆盖」，文末「六、本轮提交」列出对应 commit 与验证命令。git 侧以 `fix(scope):` 前缀可追溯。缺：无 bug 登记簿（无 issue tracker 使用痕迹）、无严重级别/责任人/关闭时间字段、`docs/audit-full-chain-2026-09-23.md` 尾部仍留有「明天第一件事」的未闭环项（D3 字段丢失） |
| **预上线** | UAT 验收记录 | **无** | 无 UAT 用例、无验收签字、无验收环境记录 |
| | 部署与回滚演练记录 | **无** | 无演练记录；`scripts/` 下无 deploy/backup/restore 脚本（`ls scripts/` 仅有 build/seed/start-db-test 等），`grep -rilE "backup\|rollback\|restore\|dump" scripts/` 输出为空 |
| | 监控告警配置 | **无** | 无 Sentry / Prometheus / OpenTelemetry / Datadog / NewRelic（`package.json` 依赖与 `server/`、`src/` 全量检索均无；命中的 `telegram` 在 `server/research/read-target-ranker.ts:222` 是 URL 过滤正则，与告警无关）。唯一相关实现是健康检查端点，但它**是静态的**（见 §1.4）。告警规则、阈值、通知渠道（飞书/钉钉/Slack）一律没有 |
| **上线** | 灰度发布能力 | **无** | `deploy.yml:126-132` 为单容器全量替换：`docker rm -f canana-vue-app` → `docker compose pull` → `docker compose up -d --force-recreate --remove-orphans`。无多副本、无流量切分、无金丝雀/蓝绿、无发布开关 |
| | 监控看板 | **无（运维层）** | 无 Grafana / 外部看板配置。`src/views/admin/redis/AdminRedis.vue:246` 有应用内 Redis 模块健康卡片，属后台管理页，非线上值守看板；无 QPS/错误率/延迟/资源指标采集 |
| | 异常回滚预案 | **无** | 无回滚文档、无回滚脚本；且 `docker-compose.yml:4` 固定 `image: couei/canana-vue:latest`，即使想回滚也**无法指定历史版本**（见 §1.5） |
| **上线后** | 值守安排 | **无** | 无值班表、无 on-call 约定、无升级路径 |
| | 反馈收集渠道 | **无** | `README.md:544-557`「相关链接」只有 Vue/Vite/Vue Flow/Element Plus/Tailwind/Prisma/即梦AI/Dreamina 等第三方文档站，无反馈入口、无 issue 链接、无客服/社群地址 |
| | 复盘归档 | **部分** | 有事后文档雏形：`docs/audit-full-chain-2026-09-23.md`（问题复盘+证据+未覆盖）与 `docs/billing-and-cost-policy.md`（决策记录，含「结论先行，后面给证据」）。缺：无复盘模板、无按版本归档机制、无「上线后 X 天复盘」制度、两者均为一次性文档非流程产物 |

### 环节汇总

| 环节 | 结论 |
|---|---|
| 立项 | **无** |
| 需求 | **部分** |
| 开发 | **部分** |
| 测试 | **部分** |
| 预上线 | **无** |
| 上线 | **无** |
| 上线后 | **无** |

---

## 1.1 `docs/` 逐文件清点（6 个文件，与环节映射）

```
$ find docs -type f | wc -l
6
```

| 文件 | 行数 | 实际内容 | 对应环节 | 缺口 |
|---|---|---|---|---|
| `docs/libtv-interaction-spec.md` | 333 | 画布交互与视觉规格；声明「并行开发契约，接口签名冻结」；第 0 节列已落地项（参数由上游模型决定 / 旧画布迁移 / 拖端口弹候选菜单 / 配色 token） | 需求（设计/交互说明） | 无需求来源、无验收标准、无评审签字 |
| `docs/libtv-reference-spec.md` | 263 | `@` 素材引用的接口签名规格（图片/视频/音频/文本 两级选择器，DOM 标记 `data-script-mention-dropdown`） | 需求（技术方案） | 同上；仅覆盖一个子功能 |
| `docs/canvas-theme-mapping.md` | 86 | infinite-canvas 色板 → `lv-theme` CSS 变量映射表；新增 3 个 token | 需求（设计/技术方案） | 设计规范，非需求文档 |
| `docs/libtv-refactor-checklist.md` | 1111 | 施工队列；每条可独立开工/验收；标注 `前端/后端/Key` 依赖与 `实测/公告/现状` 证据来源；基线写明「单测 9 文件 287 项；浏览器 e2e 4 脚本 84 项」 | 开发（任务拆解） | 是施工清单，明确自称「不是设计文档」；无排期、无责任人 |
| `docs/billing-and-cost-policy.md` | 83 | 计费/成本归属决策：上游已消耗但未交付由平台承担；未交付不计费；结论附事实依据表 | 上线后（决策/复盘） | 单点决策记录，非流程归档 |
| `docs/audit-full-chain-2026-09-23.md` | 220 | 全链路点击审计：A1~A7 已修、D2~D4 待办/未覆盖，每条附浏览器控制台/网络/DB 原文；文末列本轮提交与验证命令 | 测试 + 上线后（复盘） | 一次性审计，无编号追踪、无关闭状态字段 |

**完全没有文档覆盖的环节**：立项（目标/资源风险/评审）、PRD、多方评审记录、测试用例与测试报告归档、bug 登记闭环、UAT 验收、部署与回滚演练、监控告警配置、灰度方案、值守安排、反馈渠道、按版本复盘归档。

> 注：`docs/libtv-refactor-checklist.md` 自称基线为「单测 9 文件 287 项、e2e 4 脚本 84 项」，
> 与实测的 **19 个单测文件** 不一致（见 §1.2），说明该基线数字已过期，未随代码更新。

---

## 1.2 可执行脚本实测（`package.json`）

```
$ cat package.json | sed -n '8,38p'
```

| 用途 | 命令 | 实测结果 |
|---|---|---|
| 类型检查 | `type-check` → `vue-tsc --noEmit` | **✅ 通过**（exit 0，无输出） |
| 单测 | `test:unit` → `node scripts/tests/run-unit.mjs` | **✅ 通过**：`[test:unit] 19 个文件全部通过`（示例末段 `通过 43 / 失败 0`） |
| 回归脚本 | `test:scripts` → `node scripts/tests/run-all.mjs` | **✅ 通过**：运行 2 个脚本，输出 `[test:scripts] 全部通过` |
| 汇总 | `test` → `type-check && test:unit && test:scripts` | 三步均通过（串行，任一步失败即中止） |
| 构建 | `build` → `build:client` → `vue-tsc --noEmit && vite build` | 未执行（会写 `dist/`，本次审计禁改仓库）；命令结构正确，`dist/` 已存在说明曾成功构建 |
| 服务端构建 | `build:service` → `node scripts/build-server-service.mjs` | 未执行（会写 `dist-service/`）；`Dockerfile:44` 调用它 |
| **e2e** | **无此脚本** | `package.json` 中没有 `test:e2e`。`tests/e2e/` 有 13 个 `.mjs`（canvas-perf / drag-to-create / route-sweep / submit-generation / mask-edit / real-generation …），**且无法在 CI 或他人机器上运行**： |
| **lint** | **无此脚本** | `package.json` 无 lint；无 eslint/prettier 依赖或配置 |

**e2e 不可移植的证据**（硬编码作者本人 macOS 绝对路径，共 23 处、涉及 10 个文件）：

```
$ grep -rn "/Users/mima1234" tests/ scripts/ --include="*.mjs" --include="*.ts" | wc -l
23
$ grep -rln "/Users/mima1234" tests/ scripts/
tests/e2e/canvas-perf.mjs
tests/e2e/drag-to-create.mjs
tests/e2e/route-sweep.mjs
tests/e2e/image-node-interaction.mjs
tests/e2e/profile-drag.mjs
tests/e2e/mask-edit.mjs
tests/e2e/real-generation.mjs
tests/e2e/inline-mention.mjs
tests/e2e/double-click-create.mjs
tests/e2e/mention-reference.mjs
```

`tests/e2e/canvas-perf.mjs:21-27` 原文：

```js
const { chromium } = require('/Users/mima1234/.npm/_npx/705bc6b22212b352/node_modules/playwright-core')
const mariadb = require('/Users/mima1234/CanvasMind/node_modules/mariadb')
const APP_URL = process.env.APP_URL || 'http://localhost:5011'
const SESSION_TOKEN = process.env.SESSION_TOKEN || ''
const CHROME_PATH = '/Users/mima1234/.local/lib/chrome-for-testing/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
const DB_URL = 'mariadb://root:password@127.0.0.1:3306/canana_mind'
const USER_ID = 'cmu9zppwt000196wpcxpcd4rk'
```

后果：e2e 依赖 **npx 缓存路径下的 playwright-core**（`playwright` 并非项目依赖，`ls -d node_modules/playwright* node_modules/@playwright` → `playwright NOT installed`）、依赖 macOS 专用 Chrome 可执行文件、依赖本地库的 `root/password`、依赖写死用户 ID。**在 `ubuntu-latest` runner 上 100% 跑不起来**，换个人电脑也一样。

---

## 1.3 CI 实测：两个工作流的事件、内容、目标、质量闸

```
$ ls .github/workflows/
deploy.yml  docker-image.yml
```

### `docker-image.yml`（66 行）— 构建并推送镜像

| 项 | 内容 | 行号 |
|---|---|---|
| **触发条件** | `push` 到分支 `master`；`push` tag `v*`；`workflow_dispatch` | `:3-9` |
| **构建内容** | `docker/build-push-action@v6`，多架构 `linux/amd64,linux/arm64`，`context: .`，`file: ./Dockerfile` | `:51-56` |
| **镜像命名** | `IMAGE_NAME: couei/canana-vue`；tag = `latest` + `v<package.json version>`（当前 `1.0.2`） | `:18, :42-49` |
| **部署目标** | 只推 Docker Hub，不部署 | `:57` `push: true` |
| **跑测试吗** | **不跑**。workflow 内无 `npm test`；唯一的隐式检查是 `Dockerfile:41 RUN npm run build:client`，而 `build:client = vue-tsc --noEmit && vite build`（`package.json:27`），所以**类型错误会阻断镜像构建** | — |
| **有质量闸吗** | 只有**类型检查**（间接）。单测 / lint / 依赖审计 / 安全扫描一律未接入 | — |
| **失败会阻断发布吗** | 会 —— 镜像构建失败则 `push` 不发生；且 `deploy.yml:14` 要求 `conclusion == 'success'` 才部署。但请注意：**这条链的前置条件（`master` 分支）根本不会满足**，见 §1.5 | `deploy.yml:14` |

> `provenance: false` / `sbom: false`（`:58-59`）：主动关闭了构建溯源与 SBOM，供应链可追溯性为零。

### `deploy.yml`（141 行）— 拉取最新镜像并重启容器

| 项 | 内容 | 行号 |
|---|---|---|
| **触发条件** | `workflow_run`：`Docker 镜像发布` 完成后；或 `workflow_dispatch` | `:3-9` |
| **门禁** | `if: github.event_name == 'workflow_dispatch' \|\| github.event.workflow_run.conclusion == 'success'` | `:14` |
| **部署内容** | ① 校验 8 个 Secrets 非空（`SERVER_HOST`/`SERVER_USERNAME`/`SERVER_SSH_KEY`/`DEPLOY_PATH`/`DATABASE_URL`/`PROVIDER_CONFIG_SECRET`/`VITE_API_BASE_URL`/`CORS_ALLOWED_ORIGINS`）② SSH `mkdir -p $DEPLOY_DIR` ③ `scp docker-compose.yml` ④ SSH 写入 `.env` 并执行部署 | `:21-61, :63-84, :86-132` |
| **部署命令原文** | `docker rm -f canana-vue-app \|\| true` → `docker compose pull` → `docker compose up -d --force-recreate --remove-orphans` → `docker image prune -f` → `docker ps` | `:127-132` |
| **部署目标** | 远端主机（`secrets.SERVER_HOST` 指定的单台服务器），端口 `SERVER_PORT=5409` | `:101` |
| **跑测试吗** | **不跑**。SSH 脚本里无任何测试；`actions/checkout` 只为取 `docker-compose.yml` | `:18-19` |
| **部署后验证** | **无**。只有 `docker ps` 打印，不调用 `/api/health`、不做冒烟、失败不回滚 | `:132` |
| **通知** | **是假的**：`if: always()` 的步骤只 `echo "✅ Docker 部署成功！"` / `echo "❌ …"`，无 webhook、无飞书/钉钉/Slack | `:134-141` |

**质量闸结论**：整条链上唯一的自动质量闸是「Docker 构建期 `vue-tsc --noEmit`」。
单测（19 文件）、回归脚本、e2e、lint、依赖审计**全部不在流水线上**。

---

## 1.4 监控 / 告警 / 日志 / 健康检查

| 能力 | 状态 | 证据 |
|---|---|---|
| 健康检查端点 | **有**（但过弱） | 路由注册 `server/index.ts:364`：`match: requestPath => requestPath === '/api/health'` |
| 端点实现 | **静态返回，不探依赖** | `server/index.ts:344-352`：`handleHealthRequest` 直接 `sendJson(res, 200, { message: 'ok', data: { status: 'running' } })`。**不查数据库、不查 Redis** → DB 挂了它也返回 200，属 liveness 而非 readiness |
| Redis 健康探针 | **有实现，但未接线** | `server/redis/health.ts:4-27` `pingRedis()` 返回 `{enabled, ok, message}`；`server/redis/index.ts:9` 导出。但 `/api/health` 未调用它（全仓库除导出外无调用点） |
| 容器健康检查 | **有** | `docker-compose.yml:19-25`：`test: CMD-SHELL node -e "fetch('http://127.0.0.1:.../api/health')..."`，`interval: 30s` / `timeout: 10s` / `retries: 5` / `start_period: 30s`。因上一条，它实际只验进程活着 |
| 监控 SDK | **无** | 无 sentry / prometheus / opentelemetry / datadog / newrelic（依赖与源码全量检索） |
| 告警规则与通知 | **无** | 无阈值配置、无通知渠道 |
| 应用日志 | **仅 console，无库** | 全 `server/` 仅 5 处 `console.error`：`server/generation-sessions/request-handler.ts:10`、`server/ai-gateway/request-handler.ts:111,:228`、`server/shared/admin-audit.ts:78`、`server/generation-tasks/event-bus.ts:22`；启动脚本另有 `console.info`（`scripts/start-production.mjs:98-128`）。无 pino/winston/morgan，无日志分级、无结构化落盘、无采集上报 |
| 日志留存 | **靠 Docker 默认** | 未见 log driver / 轮转 / 外发配置；`.gitignore:1-8` 忽略 `logs` 与 `*.log`，容器日志随容器生命周期存在 |

---

## 1.5 部署分支不一致（重点）

**事实**：

```
$ git ls-remote --heads origin
3345920b3511819a1728671ee14fc27b730ec7d2	refs/heads/main

$ git branch -a
* main
  remotes/origin/main

$ git rev-parse --abbrev-ref HEAD
main

$ git tag -l "v*" | wc -l
0
$ git tag -l
scaffold-before-import
```

**矛盾**：`docker-image.yml:5-6` 要求 `push` 到 **`master`** 才触发，但远端**只有 `main`，没有任何 `master` 分支**；`v*` tag 也一个都没有（`git tag -l "v*"` → `0`）。

**后果（逐条）**：

1. **自动构建链从未被触发**。`docker-image.yml` 的 3 个入口中，`master` push 永不发生、`v*` tag 不存在，只剩手工 `workflow_dispatch`。`deploy.yml` 又依赖 `workflow_run`（`:4-8`）触发，上游不响，它也不会响 → **日常提交到 `main` 不会有任何镜像产出、不会有任何部署**。
2. **量级**：CI 于 `af205af`（2026-09-21 18:21）加入，此后到 `HEAD`（2026-09-23 00:51）共 **75 个提交，占全仓 76 个提交的 98.7%**，全部落在 `main`：

   ```
   $ git rev-list --count HEAD
   76
   $ git log --oneline af205af..HEAD | wc -l
   75
   ```
   即：**近期几乎所有修复都没走过流水线**。这也解释了为何单测/e2e 只能靠人手动跑。
3. **"修复无法上线"**。修复要生效，必须有人记得去 GitHub UI 上手动 `Run workflow`（`docker-image.yml:9` 的 `workflow_dispatch`），且构建用 `Dockerfile:38 COPY . .` 拉取**触发时 `master` 分支**的代码 —— 而 `master` 不存在；手动 dispatch 只能选择既有分支（默认分支 `main`），**依赖"操作者手动选对分支"这一人为条件**，无任何护栏。
4. **回滚点在哪 —— 实际上没有**。理论上版本化产物存在：`docker-image.yml:48-49` 会打 `latest` 和 `v1.0.2`（取自 `package.json:4`）两个 tag。但：
   - `docker-compose.yml:4` 固定 `image: couei/canana-vue:latest`，部署脚本只 `docker compose pull`（`deploy.yml:129`），**永远拉 `latest`**，版本化 tag 从未被消费；
   - 更致命的是 `latest` 的实际来源不可控：由于 `master` 不触发，`latest` 只可能来自**手工 dispatch**，无法从产物推出"线上跑的是哪个 commit"；
   - 环境里也没有 `IMAGE_TAG` 之类可注入的变量（`docker-compose.yml` 无该配置）。**结论：出了事故，无法用"回滚到上一个镜像 tag"解决，只能重新构建 —— 而构建依赖手工操作和当前分支状态，回滚不可重复、不可预期。**
5. **没有 `v*` tag 的上线习惯**。`git tag -l` 只有一个 `scaffold-before-import`（脚手架导入前快照），不是发布 tag → 无法回答"v1.0.1 对应哪个 commit、线上现在是不是它"。

---

## 1.6 回滚能力细查（版本化产物 / tag / 数据库迁移）

| 项 | 状态 | 证据 |
|---|---|---|
| 版本化镜像 tag | **产出但未使用** | 产出：`docker-image.yml:48-49`；未使用：`docker-compose.yml:4` 写死 `:latest` |
| tag 规范 | **无** | 无发布 tag（`git tag -l "v*"` → 0）；无 CHANGELOG、无 release notes。`package.json:4 version: "1.0.2"` 是唯一版本号来源 |
| 部署产物版本可追溯 | **无** | 部署脚本不记录本次部署的 commit/tag（`deploy.yml:86-132` 无 `git rev-parse`、无镜像 digest 记录） |
| 数据库迁移 | **14 个，全部向前** | `ls prisma/migrations/`：`202604260001_init` … `202605270001_add_source_to_generation_sessions`，共 14 个目录，`migration_lock.toml` 锁定 mysql |
| 迁移是否可回滚 | **否** | Prisma 无 down 迁移机制；`grep -rniE "down\|rollback"` 在迁移目录只命中 `202604260001_init/migration.sql:255` 的 `download_count` 字段名（误匹配）。无 `down.sql`、无 rollback 脚本 |
| 迁移是否含破坏性操作 | **无**（好消息） | `grep -rniE "DROP TABLE\|DROP COLUMN\|TRUNCATE" prisma/migrations/` → **无输出**。当前 14 个迁移均为增量 → 代码回滚通常不炸 schema |
| 迁移何时执行 | **每次容器启动自动跑，单向** | `scripts/start-production.mjs:108`：`await runCommand('npx', ['prisma', 'migrate', 'deploy'])`；由 `Dockerfile:78 CMD ["npm", "run", "start"]` 触发。**部署即迁移，且无 dry-run、无人工确认、无备份前置步骤** |
| 备份 / 恢复 | **无** | 无 backup/restore 脚本（`grep -rilE "backup\|rollback\|restore\|dump" scripts/` 空）；`docker-compose.yml` 只持久化 `uploads_data` 卷，**数据库不在 compose 内也无备份策略** |
| 文档化的回滚流程 | **无** | 无文档；`.env.production.example:4` 还引用了**不存在的** `scripts/deploy-manual.sh`（`ls scripts/deploy-manual.sh` → MISSING） |

---

## 2. 上线前必须有、而现在没有的清单

按「没有它会出什么事」从重到轻排序。

| # | 缺失项 | 没有它会出什么事 | 现已具备的基础 |
|---|---|---|---|
| **1** | **修好部署分支**（`docker-image.yml:6` 的 `master` → `main`，或建 `main` 的触发） | 自动化发布链**永久不触发**。所有修复只能停在 git 里；每次上线依赖某人记得手动点 Run workflow 并选对分支。这是"根本发不出去"，优先级高于其他一切 | workflow 已写好，改 1 行即可 |
| **2** | **可回滚的部署方式**（compose 用可变 `IMAGE_TAG`、部署时记录 commit/digest、保留上一版镜像） | 线上出事故时**无法回滚**：只能重新构建，构建结果取决于当时分支状态 → 回滚不可重复。且 `docker image prune -f`（`deploy.yml:131`）会**删掉旧镜像**，把回滚素材一起清掉 | 版本化 tag 已在产出（`docker-image.yml:48-49`），只差被消费 |
| **3** | **单测/类型检查接入流水线做质量闸** | 19 个单测文件、43+ 断言只靠人手动跑；由于它们已 100% 不在 CI，任何一次重构都可能带着红灯上线。当前唯一自动闸是构建期类型检查，测不出逻辑回归 | `npm test` 三步全绿（实测），接进 workflow 即可 |
| **4** | **数据库变更的安全机制**（迁移前备份、破坏性变更评审、回滚预案） | `prisma migrate deploy` 在容器启动时**自动无条件执行**（`start-production.mjs:108`），且无备份、无 down。一旦某次迁移写坏数据（当前虽无 DROP，但后续会加），**没有任何恢复手段** | 现有 14 个迁移均为增量，风险暂未爆 |
| **5** | **监控 + 告警**（至少错误率/5xx/任务失败率 + 通知渠道） | 线上挂了没人知道。用户先于团队发现故障；`docs/billing-and-cost-policy.md` 自己就记录了"上游已消耗但没交付"这类只能靠人肉发现的问题 | 有 `/api/health` 端点位置，可扩成真 readiness |
| **6** | **真实可用的健康检查**（探 DB + Redis） | 现在 `/api/health` 静态返回 200（`server/index.ts:344-352`），**DB 挂了容器仍显示 healthy**，`docker-compose.yml:19-25` 的健康检查形同虚设，编排层不会做出任何反应 | `pingRedis()` 已实现（`server/redis/health.ts`），只差接线 |
| **7** | **部署后验证 / 自动回滚** | `deploy.yml` 部署完只打印 `docker ps`（`:132`），不做冒烟、不验健康。坏版本会"部署成功"并在线上存活到有人发现 | 有 `/api/health` 可做探针 |
| **8** | **灰度发布能力** | `--force-recreate --remove-orphans` 单容器全量替换（`deploy.yml:130`）→ **每次发布 = 一次全量中断**，无灰度、无分批、无开关。风险无法用"先放 1%"稀释 | 无 |
| **9** | **真实可跑、可移植的 e2e** | 13 个 e2e 脚本硬编码作者机器的绝对路径（23 处，含 npx 缓存里的 playwright 与 macOS Chrome 路径）→ **在 CI 与任何他人机器上必然失败**，等于没有端到端回归 | 脚本已写好，需参数化路径 + 加 `playwright` 依赖 |
| **10** | **lint / 代码规范的工具化** | `docs/canvas-theme-mapping.md` 要求"组件中禁止硬编码颜色"，但**无 eslint 规则强制**，纯靠自觉；风格分歧只能靠 CR 人工看，而 CR 也不存在 | 规范文字已有，需补工具 |
| **11** | **CR 流程与分支保护** | 无 PR 模板、无 CODEOWNERS、无要求 PR 的规则 → 直接提交 `main`（当前 76 个提交如此）。无人复核的改动进主干，缺陷只能靠事后审计发现 | 无 |
| **12** | **依赖安全扫描** | Dockerfile 显式 `--no-audit`（`:19`、`:68`），CI 无 SCA，无 dependabot → 供应链漏洞无人得知；叠加 `provenance: false` / `sbom: false`（`docker-image.yml:58-59`），**产物连 SBOM 都没有**，出事无法定位受影响范围 | 无 |
| **13** | **UAT 验收记录 + 部署/回滚演练** | 上线前无人签字确认"该验的都验了"，也没演练过回滚 → **第一次真正回滚会发生在事故现场**，且大概率第一次就失败（因为连 tag 都没在用） | 无 |
| **14** | **日志采集与留存** | 只有 5 处 `console.error` 与启动日志（`server/…`），靠 Docker 默认日志 → 线上排障只能 `docker logs`，容器重建即丢；无检索、无留存、无告警联动 | 启动脚本已有结构化输出风格（`start-production.mjs`），可延用 |
| **15** | **值守安排 / 反馈渠道 / 复盘归档** | 上线后无人负责、用户反馈无入口（`README.md:544-557` 只有第三方文档链接）、复盘无归档机制 → 同样的问题会重复发生，且没人被追责 | 有一次性审计/决策文档，缺制度化存档 |

---

## 3. 最小可上线的发布流程建议

目标：在**不重构**的前提下，用现有资产（workflow、Dockerfile、compose、单测）补齐一条可信、可回滚的发布链。按顺序落地即可，前 3 步是"止血"。

### 步骤 1 — 修分支，让流水线真的会跑（改 1 行）

```yaml
# .github/workflows/docker-image.yml
on:
  push:
    branches:
      - main        # ← 原为 master；远端只有 main（git ls-remote 已证）
    tags:
      - 'v*'
  workflow_dispatch:
```

同时把 `deploy.yml` 的自动触发**改为仅认 tag**，避免每次 push 都上生产：

```yaml
# .github/workflows/deploy.yml
on:
  push:
    tags:
      - 'v*'        # 只允许「打 tag」触发生产部署
  workflow_dispatch:
```

### 步骤 2 — 让部署可回滚（compose 参数化 + 保留旧镜像）

```yaml
# docker-compose.yml
services:
  app:
    image: couei/canana-vue:${IMAGE_TAG:-latest}   # ← 原为写死 :latest
```

`deploy.yml` 的 SSH 步骤补三件事：部署前记录版本、拉取指定 tag、**不要**清理旧镜像。

```bash
# 部署前：记录本次版本，便于事后定位与回滚
echo "IMAGE_TAG=$IMAGE_TAG" >> "$DEPLOY_DIR/.deployed-version"

# 用显式 tag 部署（IMAGE_TAG 来自触发 tag，如 v1.0.3）
IMAGE_TAG="$IMAGE_TAG" docker compose pull
IMAGE_TAG="$IMAGE_TAG" docker compose up -d --force-recreate --remove-orphans

# 部署后：真实验证，失败即退出非零（让 workflow 变红）
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:5409/api/health" >/dev/null; then break; fi
  [ "$i" = 20 ] && { echo "健康检查失败"; exit 1; }
  sleep 3
done
```

**移除** `docker image prune -f`（`deploy.yml:131`）—— 它会把回滚所需的旧镜像删掉。

**回滚命令**（写进 `docs/`，并演练一次）：

```bash
# 回滚到上一版
ssh "$SERVER" "cd $DEPLOY_DIR && IMAGE_TAG=v1.0.2 docker compose up -d --force-recreate"
```

### 步骤 3 — 发布动作规范化（tag 即发布）

```bash
# 1. 在 main 上确认质量全绿（本地即可，后续会进 CI）
npm run type-check && npm run test:unit && npm run test:scripts

# 2. 升版本号（镜像 tag 从 package.json 读，docker-image.yml:33-34）
npm version patch -m "release: v%s"   # 或手动改 package.json 的 version

# 3. 打 tag 并推送 —— 这一步同时触发镜像构建 + 生产部署
git push origin main
git push origin v1.0.3
```

### 步骤 4 — 把质量闸接进流水线

在 `docker-image.yml` 的 `build-and-push` 前插入一个 `quality` job（顺序依赖，红了就不构建）：

```yaml
jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci || npm install        # .gitignore:15 未跟踪 lock，故留兜底
      - run: npm run type-check
      - run: npm run test:unit
      - run: npm run test:scripts
  build-and-push:
    needs: quality
    # …原有内容不变
```

### 步骤 5 — 把健康检查做成真的

`server/index.ts:344` 的 `handleHealthRequest` 改为探真实依赖（复用已就绪的 `pingRedis`）：

```
GET /api/health  →  200 { status: 'running', db: 'ok', redis: 'ok' }
                 →  503 任一依赖失败
```

这样 `docker-compose.yml:19-25` 的健康检查与步骤 2 的部署后探针才有意义。

### 步骤 6 — 补最小监控（先要能看到，再谈告警）

- 给容器加日志驱动或接入宿主日志采集，别只靠 `docker logs`；
- 至少对 `https://<域名>/api/health` 做外部可用性探测（任一免费 uptime 服务即可），异常通知到 IM；
- 在服务端把 5xx 与任务失败率出一个可查的计数（`server/generation-tasks/event-bus.ts`、`server/ai-gateway/request-handler.ts` 已是主要失败点）。

### 步骤 7 — 补齐上线前置文档（模板化，各自 1 页即可）

`docs/release/` 下建 4 个模板并在每次发布时填：`uat-checklist.md`（验收项+签字）、`rollback-drill.md`（演练日期+耗时+结论）、`oncall.md`（值守人与升级路径）、`retro.md`（发布后复盘）。

### 分支策略小结

| 分支/引用 | 作用 | 触发什么 |
|---|---|---|
| `main` | 唯一开发主干，直接合并（现状） | 只跑质量闸（步骤 4） |
| `v1.0.x` tag | **发布单元，唯一的上线入口** | 构建并推送镜像（含版本 tag）→ 生产部署 |
| `hotfix/*`（可选） | 紧急修复，合并回 `main` 后照常打 tag | 同上 |

原则：**开发在 `main`，发布靠 tag，生产只跑 tag 对应的镜像**。这样"线上是什么版本"永远可从 `.deployed-version` + compose 的 `IMAGE_TAG` 回答，回滚就是换一个 tag。

---

## 4. 未能确认

| 项 | 为什么无法确认 | 建议如何确认 |
|---|---|---|
| GitHub 侧的分支保护规则 / required status checks | 需要 GitHub API 或仓库 Settings 权限，本地 `git` 无法读取。仓库内**没有任何**配置痕迹（无 CODEOWNERS、无 PR 模板） | 在 GitHub 仓库 Settings → Branches 查看；或 `gh api repos/:owner/:repo/branches/main/protection` |
| `main` 分支是否由 `master` 改名而来 | `git show-ref` 只有 `refs/heads/main`，本地无 `master` 残留、无相关 reflog。无法从当前克隆判断历史 | 在 GitHub 仓库 Branches 页面看是否曾有 `master`；或查 audit log |
| Docker Hub 上 `couei/canana-vue` 现有 tag 与 `latest` 实际指向的 commit | 需要 Docker Hub 凭据（`secrets.DOCKERHUB_*`）；本审计为只读、不联网拉取私有 registry 元数据 | `docker manifest inspect couei/canana-vue:latest` 或 Docker Hub 页面 |
| 远端服务器（`secrets.SERVER_HOST`）上的实际部署状态、`.deployed-version`、现存容器与镜像 | SSH 凭据在 GitHub Secrets 中，本地不可得；且本次审计限定为只读且不触碰生产 | 在服务器上执行 `docker ps` / `docker images` / `cat $DEPLOY_DIR/.env` |
| GitHub Actions 的实际运行历史（是否有人手工跑过 `workflow_dispatch`、跑过几次、成功与否） | 需要 Actions API/UI 权限。只能确认**代码层面**`master`/`v*` 不可能自动触发 | `gh run list --workflow=docker-image.yml` |
| `npm run build` 与 `build:service` 本次是否通过 | 未执行 —— 二者会写 `dist/` 与 `dist-service/`，违反"禁改仓库"约束。`dist/` 目录存在（9月23日 00:37）说明近期构建成功过 | 在临时 clone 或 CI 中执行 `npm run build && npm run build:service` |
| e2e 13 个脚本的实际通过情况 | 无法运行：依赖作者机器绝对路径（`tests/e2e/canvas-perf.mjs:21-27`）、`playwright` 未安装、需本地 DB 与登录态 `SESSION_TOKEN` | 先参数化路径并加 `playwright` 依赖，再在具备 DB + 登录态的环境跑 |
| `docs/libtv-refactor-checklist.md` 声称的基线「单测 9 文件 287 项」与实测 19 文件不符 | 无法判断是文档过期还是另有计数口径（该文件未说明计数方式） | 向作者确认；或统一以 `npm run test:unit` 输出为准并更新文档 |

---

## 5. 审计只读性证据

```
$ git status --porcelain
(空)
```

审计前后均无改动。本次仅执行只读命令：`git log/branch/tag/show-ref/ls-remote/rev-list`、
`cat/sed/grep/find/ls`、`npm run type-check`、`npm run test:unit`、`npm run test:scripts`
（`vue-tsc --noEmit` 不落盘；两个测试 runner 只读 `tests/` 并以 `stdout: 'inherit'` 输出）。
**未执行** `npm run build` / `build:service` / 任何 `prisma migrate` / 任何 docker 命令，以避免产生 `dist/`、`dist-service/` 或数据库副作用。
