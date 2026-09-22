# 鉴权与安全专项审计（round 2 · 01）

> 审计对象：`/Users/mima1234/CanvasMind`
> 审计时间：2026-09-23
> 审计方式：**只读**。所有结论附**文件路径 + 行号**或**命令 + 原始输出**。
> 为验证「未鉴权可访问」，另起了一个隔离实例（`SERVER_PORT=5499 UPLOADS_DIR=/tmp/audit-uploads STATIC_DIST_DIR=/tmp/audit-static`），
> 探针结束后已 kill 进程并删除 `/tmp/audit-*`；仓库未被改动（`git status --short` 仅剩未跟踪的 `docs/audit-round2/`）。
> 涉及真实上游额度的端到端调用**没有执行**（见 §4）。

---

## 1. 结论摘要

图例：**做了** = 有可核验的实现；**部分做了** = 有实现但缺关键环节；**没做** = 查无此项或形同虚设。

| # | 项目 | 状态 | 严重度 | 证据位置 |
|---|---|---|---|---|
| 1 | AI 网关对非计费端点（`chat`）**完全不鉴权**，匿名即可用平台已配置的厂商密钥 | 没做 | **严重（P0）** | `server/ai-gateway/request-handler.ts:15-24,55-66,174-184`；实测 §3.1-B |
| 2 | AI 网关 **SSRF**（客户端可指定上游 URL，未鉴权、回显响应体） | 没做 | **严重（P0）** | `server/ai-gateway/request-handler.ts:145-157`、`server/ai-gateway/shared.ts:74-81`；实测 §3.1-A |
| 3 | `/api/storage/upload` **无鉴权、无类型/大小校验、扩展名取自请求头**，`/uploads` 按扩展名回 `text/html` → 未授权写盘 + 存储型 XSS | 没做 | **严重（P0）** | `server/storage/request-handler.ts:5-55`、`server/storage/service.ts:45-56`、`server/index.ts:140-176,185-186`；实测 §3.2-D |
| 4 | 充值 / 会员下单**无支付校验**（直接 `PAID` 并加积分）、无幂等 | 没做 | **严重（P0）** | `server/marketing-center/service.ts:910-966`、`server/marketing-center/request-handler.ts:36-74` |
| 5 | 验证码登录把验证码**回显给请求方**（`debugCode`），且无真实短信/邮件下发通道 | 部分做了 | **高（P1）** | `server/auth/strategies/phone-code.ts:26-32`、`email-code.ts:26-32`、`prisma/migrations/202604260001_init/migration.sql:53`、`src/components/LoginModal.vue:437` |
| 6 | `DISABLED` 用户仍可登录、已有会话继续有效（无 `status` 校验） | 部分做了 | **高（P1）** | `server/auth/service.ts:710-742`、`server/auth/strategies/admin-password.ts:33-41`、`prisma/schema.prisma:1075-1079` |
| 7 | 厂商 Key / 对象存储凭据加密**密钥有硬编码默认值** | 部分做了 | **高（P1）** | `server/provider-config/crypto.ts:3,7`、`server/storage-config/crypto.ts:4,12-14` |
| 8 | 上传目录 / 静态目录防穿越用**字符串前缀**判定 → 可读同前缀兄弟目录 | 部分做了 | **高（P1）** | `server/index.ts:158-163`、`server/index.ts:248-252`、`server/generation-tasks/upstream-helpers.ts:120-124`；实测 §3.5-J |
| 9 | 依赖可复现性与漏洞：**无锁文件入库** + Dockerfile `npm install --no-audit` + 线上 7 项高危 | 没做 | **高（P1）** | `.gitignore`（`package-lock.json`）、`Dockerfile:10,19,68`；实测 §3.4 |
| 10 | 安全响应头（CSP / HSTS / X-Content-Type-Options / X-Frame-Options）全缺 | 没做 | 中（P2） | 全仓库检索无命中（§3.5 原文） |
| 11 | 已登录用户的第二处 SSRF：生成记录把用户给的 `url` 拉下来转存并回显公网地址 | 没做 | 中（P2） | `server/generation-records/service.ts:250-256,325-350`、`server/generation-tasks/upstream-helpers.ts:141` |
| 12 | 公开资产列表**匿名返回 owner.email** | 部分做了 | 中（P2） | `server/asset-items/service.ts:70-80,238-244`、`server/asset-items/request-handler.ts:98-100` |
| 13 | 密码哈希（scrypt + 随机盐 + 定长比较） | 做了 | — | `server/auth/service.ts:158-184` |
| 14 | 会话令牌哈希存储（DB 只有 sha256 摘要）+ 有效期 + 吊销 | 做了 | — | `server/auth/service.ts:153-156,655-700,710-742,757-772`、`prisma/schema.prisma:149-167` |
| 15 | 后台接口服务端角色校验（`requireAdminSessionUser` 逐接口调用） | 做了 | — | 8 个 admin 模块逐条命中（§3.3 清单） |
| 16 | 普通用户越权读/改他人数据（生成记录 / 会话 / 资产 / 视频项目） | 做了 | — | `server/generation-records/service.ts:840-854,1141-1157` 等（§2-Q1.4） |
| 17 | 生成任务提交幂等（Redis + SET NX + token） | 做了 | — | `server/redis/idempotency.ts:41-67,69-119`、`server/generation-tasks/task-lifecycle-service.ts:202-218` |
| 18 | **AI 网关直连路径无幂等** → 重复提交重复扣费 | 没做 | 中（P2） | `server/ai-gateway/request-handler.ts:77-92,194-209`、`src/views/workflow/api/request.ts:5` |
| 19 | 幂等键漏字段（`mask` / `researchConfig` / `sessionId` 不入键）→ 不同请求被误判为重试 | 部分做了 | 中（P2） | `server/generation-tasks/shared.ts:12-30` vs `task-lifecycle-service.ts:144-163` |
| 20 | SQL 注入面（Prisma ORM + 2 处 raw 全参数化） | 做了 | — | `server/system-config/service.ts:761-763,784-792`、`server/marketing-center/service.ts:187` |
| 21 | XSS 面（Vue 侧 3 处 `v-html` 全部自建转义；`src-cutia` 无 `dangerouslySetInnerHTML`） | 做了 | — | `src/composables/research/report-markdown-utils.ts:4-11`、`src/composables/research/useCitationRenderer.ts:198-213`、`src/components/generate/common/AgentLoadingRecord.vue:132-141,173-179` |
| 22 | 密钥入库 / 前端打包混入密钥 | 做了 | — | `.gitignore`、`git ls-files \| grep -i env`、`dist/` 扫描（§3.5） |
| 23 | CORS（白名单 + credentials，非 `*`） | 做了 | — | `server/index.ts:282-329` |
| 24 | CSRF（无 token，仅靠 `SameSite=Lax`） | 部分做了 | 低 | `server/auth/request-handler.ts:30-45` |
| 25 | 请求体大小上限 / 网关与上传限流 | 没做 | 低 | `server/ai-gateway/shared.ts:26-44`（无限读） |

---

## 2. 逐条回答必答问题

### Q1 鉴权

**1.1 登录/会话实现 —— 做了（自研会话，非 JWT）**

- 会话表 `AppSession`：`tokenHash` 唯一索引 + `expiresAt` / `revokedAt`（`prisma/schema.prisma:149-167`）。
- 登录成功后由服务端写 `HttpOnly` Cookie（`Path=/; SameSite=Lax; Max-Age=<30天>`，生产环境追加 `Secure`）：`server/auth/request-handler.ts:30-45`；Cookie 名 `canana_session`：`server/auth/service.ts:14`。
- 请求侧从 Cookie 取令牌 → 查 `AppSession`（要求 `revokedAt IS NULL AND expiresAt > now`）→ 回填 `lastActiveAt`：`server/auth/service.ts:710-742`。
- 登录方式：`ADMIN_PASSWORD` 为可用主路径；`PHONE_CODE` / `EMAIL_CODE` / 三种 OAuth 有策略实现但**无真实下发/回调通道**（见 Q1.5）。

**1.2 密码哈希 —— 做了（算法与比较方式正确，强度策略偏弱）**

```
server/auth/service.ts:161-166   hashUserPassword：salt = randomBytes(16).hex，scrypt(password, salt, 64)，存为 `scrypt:<salt>:<hex>`
server/auth/service.ts:168-184   verifyUserPassword：仅接受 `scrypt:` 前缀，按 64 字节重算，先比长度再 crypto.timingSafeEqual
```
- 正向：随机盐 16 字节、定长比较、明文不落库、`scripts/set-admin-password.ts` 复用同一函数避免格式错位。
- 偏弱：未显式传 scrypt 参数，走 Node 默认（N=16384, r=8, p=1, maxmem 32MB）——属当前可接受下限，不是阻断项；密码策略只有长度 8–64（`server/auth/service.ts:147`），无复杂度/字典校验。
- **无任何改密接口**（仓库内检索 `change.?password|reset.?password` 为空，仅在部署机用 CLI 重设，脚本自述见 `scripts/set-admin-password.ts:5-9`）。

**1.3 会话令牌是否哈希存储 / 有效期 / 吊销 —— 做了；异常态处理部分做了**

| 子项 | 结论 | 证据 |
|---|---|---|
| 令牌哈希存储 | 做了 | 令牌 `randomBytes(24).toString('base64url')`（192 bit）；入库只存 `sha256(token)`：`server/auth/service.ts:153-156,655-668` |
| 有效期 | 做了 | 默认 30 天（`AUTH_SESSION_EXPIRE_DAYS`），**绝对过期不滑动**，`lastActiveAt` 仅记录不延长：`server/auth/service.ts:193-196,660-661` |
| 吊销 | 部分做了 | 登出吊销当前令牌（`service.ts:757-772`）；后台「重置登录态」吊销该用户全部会话（`server/admin-users/service.ts:1254-1261`）；CLI 改密吊销全部（`scripts/set-admin-password.ts:61-64`）。**缺**：用户被禁用（`DISABLED`）既不吊销也不拦截（见下） |

**1.4 越权风险（普通用户读/改他人数据）—— 做了（按用户隔离 + 显式属主校验）**

- 生成记录：列表/详情按 `userId` 过滤（`server/generation-records/service.ts:840-854`），更新时显式比对属主（`server/generation-records/service.ts:1154-1156` → `无权修改当前生成记录`）。
- 生成会话（`server/generation-sessions/request-handler.ts:44-69` 全部传 `currentUser.id`）、视频项目（`server/video-projects/request-handler.ts:41-107`，`scope=all` 需 ADMIN，跨用户返回 403）、资产（`server/asset-items/request-handler.ts:76-123`，`scope=all` 需 ADMIN）。
- 角色是**每次请求从库里读**（`server/auth/service.ts:710-742` 的 `select` 含 `role`），因此降权立即生效，无「旧 JWT 里带旧角色」问题。
- 唯一实测到的信息泄露：匿名可读公开资产列表里的 `owner.email`（见 §3.5-K）。

**1.5 验证码登录链路的真实状态（重要）**

- 发送验证码接口只做「生成记录 + 写库 + 限流」，**没有任何短信/邮件发送集成**：`server/auth/request-handler.ts:113-153` → `server/auth/strategies/phone-code.ts:11-33`（`sendCode` 内只有 `createVerificationCodeRecord`）。
- 验证码通过 `debugCode` 字段**回显给调用方**，条件是登录方式配置里的 `allow_auto_fill` 为真：
  `phone-code.ts:31` / `email-code.ts:31` → `debugCode: context.methodConfig.allowAutoFill ? record.code : undefined`；前端拿到就自动填入（`src/components/LoginModal.vue:437-441`）。
- 该字段的库默认值是 **1（真）**：`prisma/migrations/202604260001_init/migration.sql:53`。
- `resolveUserByIdentifier` 在登录时按手机号/邮箱找到**已存在用户**并把新身份绑上去（`server/auth/service.ts:543-600`），所以一旦开启这两种登录方式，知道某人手机号/邮箱即可直接登入其账号（含管理员账号的邮箱，如果后台填了邮箱）。
- 当前开发库实测**只有 `ADMIN_PASSWORD` 一行**（输出见 §4），即该洞现在关着；**但只要后台把手机/邮箱登录打开，它就立刻成为账号接管通道**。

### Q2 授权 / 角色

**2.1 权限边界实现位置 —— 服务端校验为主，前端仅做体验**

- 服务端统一入口：`requireAdminSessionUser`（未登录 401、非 ADMIN 403）：`server/auth/session.ts:64-87`。
- 逐模块调用清单（`grep -rn "requireAdminSessionUser\|requireCurrentSessionUser" server/`）：

| 模块 | 校验点行号 |
|---|---|
| auth（登录方式配置读写） | `server/auth/request-handler.ts:91,102` |
| admin-dashboard | `server/admin-dashboard/request-handler.ts:33` |
| admin-users | `server/admin-users/request-handler.ts:177`（在全部路由分支之前） |
| admin-generation-sessions | `:26` |
| admin-generation-records | `:16` |
| admin-audit-logs | `:15` |
| admin-marketing（20+ 分支） | `:86`（分支之前） |
| admin-conversation-settings | `:17` |
| provider-config（13 个分支） | `:117,128,139,161,187,209,220,246,257,282,307,332` |
| skill-config（6 个分支） | `:56,67,78,100,122,144` |
| storage-config | `:23` |
| system-config（全部含 redis 管理） | `:42,53,64,75,97,126,153,179` |
| asset-items（`scope=all`） | `:88` |
| 用户侧（生成记录/会话/任务/工作流/视频项目/营销中心） | 各自 `requireCurrentSessionUser`（任一登录用户即可） |

结论：**做了**。我逐文件读过这些 handler，**没有发现任何 admin 功能只在客户端做限制**（`src/router/index.ts:329` 的 `requiresAdmin` 只是把用户挡在页面外，是 UX 层）。

**2.2 反过来的问题：该有校验却完全没有校验的服务端接口**

这两处不是「前端隐藏」，而是**服务端根本不校验**：

| 接口 | 实测（未登录） | 位置 |
|---|---|---|
| `POST /api/storage/upload` | **200 上传成功** | `server/storage/request-handler.ts:5-55`（无任何 `require*`） |
| `POST /api/ai/request`（`endpointType=chat`，或 `x-upstream-base-url` 分支） | **通过鉴权闸门，直达厂商查询/出网请求** | `server/ai-gateway/request-handler.ts:55-59,145-157,181-184` |

对照实验（同一实例、同一时刻、未带任何 Cookie）：

```
### B) 未登录 + providerId + endpoint-type=chat（非计费）
{"message":"厂商不可用或未启用","error":{"type":"gateway_error",...}}
### C) 对照：未登录 + providerId + endpoint-type=image（计费）
HTTP/1.1 401 Unauthorized
### F) 对照：未登录 POST /api/generation-tasks
HTTP/1.1 401 Unauthorized
### G) 对照：未登录 GET /api/admin/users
HTTP/1.1 401 Unauthorized
```
即：**鉴权闸门只覆盖 `image`/`video` 两类计费端点**（`isChargeableGenerationRequest`，`request-handler.ts:15-24`），`chat` 与 header/JSON 自定义上游路径全部裸奔。

### Q3 幂等

**3.1 生成任务提交 —— 做了（设计与实现都是对的）**

- 幂等键：`sha1(JSON{userId, strategyKey, providerId, modelKey, skill, prompt, requestMode, referenceImages, requestBody})` → Redis 键 `task:idempotency:<hash>`：`server/redis/idempotency.ts:41-67`、`server/redis/keys.ts:22`。
- 存在哪：Redis（默认 `127.0.0.1:6379`，`REDIS_ENABLED` 默认真，见 `server/redis/config.ts:104-140`）。
- 窗口：`REDIS_TASK_IDEMPOTENCY_TTL_SECONDS`，默认 **600 秒**（`server/redis/config.ts:26,128`）。
- 流程：`SET key payload EX 600 NX` 抢锁 → 抢到才创建记录/扣分；`completed` 直接返回原 `recordId`；`in_progress` 返回 409：`server/generation-tasks/task-lifecycle-service.ts:202-218`。
- 计费位置在 claim **之后**（`:214-240` 等分支），因此窗口内重复提交**不会重复计费**，`catch` 里回滚并发槽并 `clearPendingIdempotencyKey`（`:472`）。

**3.2 幂等失效场景（4 条，均有据）**

1. **Redis 未启用或不可达时完全失效（fail-open）**：`claimIdempotencyKey` 在 `!isRedisEnabled()` 或客户端为 `null` 时**直接返回 `acquired`**（`server/redis/idempotency.ts:73-88`）→ 无任何去重，重复提交重复创建 + 重复扣分。
2. **窗口外的重复提交**：10 分钟后同参数再提交会重新建任务并重新扣分（设计如此，但意味着「用户以为没成功又点一次」在 10 分钟后照样双扣）。
3. **pending 卡死**：进程在 claim 成功后、`complete`/`clear` 之前崩溃 → 该键 10 分钟内一直 `pending`，同一请求这段时间内被 409 挡住（可用性问题，`task-lifecycle-service.ts:216-218`）。
4. **AI 网关直连路径没有幂等**（这才是「重复提交重复计费」的真实路径）：`/api/ai/request` 每次 POST 都用 `Date.now()+random` 现场生成新的 `associationNo` 并直接 `consumeGenerationPoints`（`server/ai-gateway/request-handler.ts:26-28,77-92,194-209`），无任何去重键；只有上游返回非 2xx 时才退款（`beforeProxy`/`onError`）。前端 **workflow 的图/视频生成就走这条**（`src/views/workflow/api/request.ts:5` 转出 `@/api/request`，其 `fetch` 指向 `AI_GATEWAY_REQUEST_PATH`）。

**3.3 幂等键漏字段（误判为重复）**

键里只放了 `skill / prompt / requestMode / referenceImages / requestBody`（`server/generation-tasks/task-lifecycle-service.ts:144-163`），而请求体还有 `mask`（局部重绘蒙版）、`researchConfig`、`sessionId`、`duration`、`feature`（`server/generation-tasks/shared.ts:12-30`）。
→ 同样提示词+参考图、**只换了蒙版**的两次图生图（或只换了研究配置）在 10 分钟内会命中同一个 `completed` 键，第二次**不会重新生成**，直接返回第一次的记录。

### Q4 依赖安全

**4.1 锁文件与可复现安装 —— 没做**

- `package-lock.json` **被 git 忽略、未入库**：`.gitignore` 末段注释写明「不维护 npm lock，CI 使用 npm install」，`git ls-files | grep -iE "lock|npmrc"` 只返回 `pnpm-lock.yaml` 与 `prisma/migrations/migration_lock.toml`。
- 镜像构建只 `COPY package.json` 后 `npm install`（**没有锁文件可用**，且显式关掉审计）：
  ```
  Dockerfile:10  COPY package.json ./
  Dockerfile:19  npm install --include=dev --no-fund --no-audit
  Dockerfile:68  && npm install --omit=dev --no-fund --no-audit
  ```
- 结论：`npm ci` 无从执行，同一份源码不同时间构建会装到不同版本，供应链可复现性为 0；`pnpm-lock.yaml` 虽入库，但 CI 与 Dockerfile 都不使用 pnpm（`grep -n "pnpm" .github/workflows/*.yml` 无命中；`package.json` 无 `packageManager` 字段）。
- CI 也不跑任何 `npm audit` / 测试（`.github/workflows/docker-image.yml:24-53` 只有 checkout/buildx/login/build-push）。

**4.2 漏洞扫描实测 —— 命令与原始结果**

首次按仓库配置的 registry 直接跑**失败**：

```
$ npm audit --omit=dev
npm warn audit 404 Not Found - POST https://registry.npmmirror.com/-/npm/v1/security/advisories/bulk - [NOT_IMPLEMENTED] /-/npm/v1/security/* not implemented yet
npm error audit endpoint returned an error
```
（原因：`~/.npmrc` 指向 npmmirror 镜像，该镜像未实现 audit 端点。这也意味着**照现状在开发机上跑不出漏洞报告**。）

改用官方 registry：

```
$ npm audit --omit=dev --registry=https://registry.npmjs.org --json
meta: {"info":0,"low":0,"moderate":1,"high":7,"critical":0,"total":8}
- high     @huggingface/transformers  direct=True  | via sharp
- moderate @prisma/adapter-mariadb    direct=True  | via mariadb
- high     @prisma/config             direct=False | via deepmerge-ts
- high     deepmerge-ts               direct=False | DeepmergeTS has stack exhaustion when merging recursive object graphs
- high     mariadb                    direct=False | MariaDB's connector leaks the cleartext password to an MitM despite `ssl: true` ...
- high     mysql2                     direct=False | MySQL2: Auth Plugin Downgrade to mysql_clear_password Leaks Plaintext Credentials ...
- high     prisma                     direct=True  | via @prisma/config, mysql2
- high     sharp                      direct=False | sharp inherited vulnerabilities in libvips: CVE-2026-33327/33328/35590/35591 ...
```

**高危 7 项、严重 0 项、中危 1 项，合计 8 项。** 生产依赖（`--omit=dev`）全量口径，含 `sharp`(libvips/libheif)、`mysql2`/`mariadb` 连接器、`deepmerge-ts`。
没有 `--omit=dev` 的全量口径未再跑（生产侧 8 项已覆盖运行时依赖）。

### Q5 常见漏洞面

| 面 | 结论 | 证据 |
|---|---|---|
| SQL 注入 | **做了** | 全量走 Prisma ORM/model API；仅 2 个文件用 raw SQL，且都参数化：`server/system-config/service.ts:761-763`（常量串）、`:784-792`（`?` 占位 + `code` 参数）、`server/marketing-center/service.ts:187`（模板参数化）。未发现字符串拼 SQL |
| SSRF | **没做** | 三处：① 匿名可用的网关上游 URL（`ai-gateway/request-handler.ts:145-157`；且 `shared.ts:74-81` 允许 `endpoint` 本身就是绝对 URL）；② 已登录用户可通过生成记录的 `outputs[].url` 让服务端拉取任意地址（`generation-records/service.ts:250-256`，拉下来后转存为可访问资产 `:325-341`）；③ 参考图字段非 `/uploads` 前缀时直接 `fetch`（`generation-tasks/upstream-helpers.ts:141`）。**全链路无内网/协议白名单、无重定向限制** |
| 路径穿越 | **部分做了** | 有校验但是**字符串前缀**判定，可越到同前缀兄弟目录（实测见 §3.5-J）：`server/index.ts:158-163`、`server/index.ts:248-252`、`server/generation-tasks/upstream-helpers.ts:120-124`。上传**写入**侧安全：`category` 走白名单清洗（`server/storage/service.ts:59-69`） |
| XSS | **部分做了** | Vue 主应用 3 处 `v-html` 全部自建转义（`report-markdown-utils.ts:4-11` + `useCitationRenderer.ts:198-213` 每个插值都 `escapeHtml`；`AgentLoadingRecord.vue:132-141,173-179` 先转义 `&<>` 再替换 markdown 标记），`src-cutia` 无 `dangerouslySetInnerHTML`、全仓库无 `innerHTML`/`eval` 业务用法。**但上传链路给出存储型 XSS**（实测 §3.2-D）：`/uploads` 按扩展名回 `text/html`（`server/index.ts:185-186`），扩展名完全由请求头决定（`server/storage/service.ts:45-56`） |
| 密钥泄露 | **部分做了** | `.env`/`.env.development`/`.env.production` 均 gitignore 且未跟踪（`git ls-files \| grep -i env` → 仅两个 `.example`）；示例文件是占位值（`.env.production.example:32-33`）；前端产物扫描未发现密钥（`grep -rE "sk-[A-Za-z0-9]{20,}\|AKIA[0-9A-Z]{16}" dist/` 无命中，唯一命中是一句错误提示文案）。**问题**：加密密钥有硬编码默认值（`provider-config/crypto.ts:3,7` = `canana-vue-provider-config-secret`；`storage-config/crypto.ts:4,12-14` = `canana-vue-storage-config-secret`）——生产漏配环境变量时，厂商 API Key（AES-256-GCM 密文）与对象存储 SecretKey 等于用公开常量加密 |
| CORS | **做了** | 白名单 + `Access-Control-Allow-Credentials: true`，**非白名单 Origin 不回显**（回落 `allowedOrigins[0]`），无 `*` 组合：`server/index.ts:282-302,324-329`。次要问题：`Allow-Headers` 会反射客户端声明的任意头（`:311-322`，低危） |

### Q6 上传安全

| 检查项 | 结论 | 证据 |
|---|---|---|
| `/api/storage/upload` 鉴权 | **没做** | `server/storage/request-handler.ts:5-55` 全函数无 `require*`；实测未登录 200 |
| `/api/storage/upload` 类型 / 大小 / 文件名校验 | **没做** | 只判非空；文件名、MIME、分类分别取自 `x-upload-filename` / `content-type` / `x-upload-category`（`:35-41`）；扩展名优先取用户文件名后缀且**无白名单**（`server/storage/service.ts:45-56`）；无大小上限、无限流 |
| `/api/asset-items/upload` 校验 | **部分做了** | 需登录（`request-handler.ts:37-40`）+ MIME 前缀白名单 `image/ video/ audio/`（`constants.ts:6,9`）+ 100MB 上限（`:57-60`）；但**先整块读进内存再判大小**（`:52-57`，`readRawBuffer` 本身无上限），扩展名同样取用户文件名（无白名单） |
| 上传目录是否可执行 | **否** | Node 侧只按扩展名回 `Content-Type` 后 `res.end(fileBuffer)`，不做任何解释执行（`server/index.ts:171-175`）。**但 `.html`/`.svg` 会以可执行上下文在应用同源下渲染 → 存储型 XSS** |
| 上传文件是否可被路径穿越访问 | **是（受限）** | 前缀绕过实测可读同前缀兄弟目录；另 `/uploads/*` **不校验登录**，任何拿到 URL 的人都能读用户上传的参考图与生成结果（`server/index.ts:140-176,547-550`；URL 里的 `Date.now()-uuid` 不易爆破，但公开列表会直接给出 URL） |

---

## 3. 上线阻塞项（必须上线前修，按严重度排序）

> 每条给一句「怎么修」。前 4 条建议视为**发布闸门**。

### P0（严重）

1. **AI 网关对 `chat` 端点零鉴权 → 匿名白嫖平台厂商密钥**
   证据：`server/ai-gateway/request-handler.ts:15-24,55-59,174-184`（鉴权只在 image/video 计费分支里做）+ `:61-66,121-141`（用 `upstream.apiKey` 转发）+ `server/provider-config/service.ts:652-659`（`apiKey: decryptProviderApiKey(...)`）；实测 §2-Q2.2-B。活跃库里 `ai_providers` 有 2 个启用且带真实密文密钥（`sk-R...Lvqs` / `sk-s...eXTY`），并有 1 个启用的 `CHAT` 模型 `qwen3.8-flash`。
   **怎么修**：把 `requireCurrentSessionUser` 提到 `handleAiGatewayRequest` 函数最前面（对 `/api/ai/request` 的**所有**分支生效），只有显式引用服务端配置厂商时才注入 `upstream.apiKey`。

2. **AI 网关未鉴权 SSRF（可读内网并回显响应体）**
   证据：`server/ai-gateway/request-handler.ts:145-157` + `server/ai-gateway/shared.ts:74-81`；实测 §3.1-A 返回 200 且把 `http://127.0.0.1:5499/api/health` 的响应体原样回给匿名调用方。
   **怎么修**：删除 `x-upstream-base-url`/`x-upstream-endpoint` 与 body `upstream.baseUrl/apiKey` 三条客户端指定上游的入口，上游地址只能来自后台厂商配置。

3. **`/api/storage/upload` 未鉴权 + 扩展名可控 → 未授权写盘与同源存储型 XSS**
   证据：`server/storage/request-handler.ts:5-55`、`server/storage/service.ts:45-56`、`server/index.ts:140-176,185-186`；实测 §3.2-D（未登录上传 `.html` 成功，取回时 `Content-Type: text/html; charset=utf-8`）。
   **怎么修**：给该接口加 `requireCurrentSessionUser`、加大小上限与 MIME/扩展名白名单（拒绝 `html/js/svg`），并让 `/uploads` 响应强制 `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`（或把上传域名拆到独立 origin）。

4. **充值/会员下单无支付校验、无幂等（人人可自造积分与会员）**
   证据：`server/marketing-center/service.ts:921-940`（建单即 `payStatus: 'PAID'`）、`:942-956`（立即 `appendPointLog` 加积分）、`:853-876`（会员单 `status: 'PAID'` 并 `activateMembership`）；端点只要求登录（`request-handler.ts:36-74`）；前端注释自认「后端直充直开」（`src/components/MarketingModal.vue:714`）。
   **怎么修**：改为「下单 → 待支付(PENDING) → 支付回调/管理员确认后才入账」，回调侧校验签名与订单号幂等键。

### P1（高）

5. **验证码登录会把验证码回给调用方，且无真实下发通道**
   证据：`phone-code.ts:26-32`、`email-code.ts:26-32`、库默认 `allow_auto_fill=1`（`prisma/migrations/202604260001_init/migration.sql:53`）、前端自动填充并提示（`src/components/LoginModal.vue:437-441`）、`resolveUserByIdentifier` 会绑到既有用户（`server/auth/service.ts:543-600`）。
   **怎么修**：默认关闭并物理删除 `debugCode` 出参；接入真实短信/邮件通道前，把 `PHONE_CODE`/`EMAIL_CODE` 的 `isEnabled` 在迁移里锁死为 0（仅由显式后台开关打开）。

6. **`DISABLED` 用户仍可登录、会话继续有效**
   证据：会话查询 `select` 无 `status`（`server/auth/service.ts:710-742`）；密码登录只判 `role`（`server/auth/strategies/admin-password.ts:33-41`）；验证码登录也不判状态（`phone-code.ts:53-59`）；`UserStatus` 确有 `DISABLED`（`prisma/schema.prisma:1075-1079`）且后台可设置（`server/admin-users/service.ts:975-989`）。
   **怎么修**：在 `getUserBySessionToken` 与三条登录策略里统一加 `status !== 'DISABLED'` 判定，并在后台改为 DISABLED 时同事务吊销其全部会话。

7. **加密密钥硬编码默认值**
   证据：`server/provider-config/crypto.ts:3,7`、`server/storage-config/crypto.ts:4,12-14`；示例文件也只是「please-change-this-...」（`.env.production.example:32-33`）。
   **怎么修**：两个 `DEFAULT_SECRET` 常量的兜底改为启动即失败（生产缺少 `PROVIDER_CONFIG_SECRET` / `STORAGE_CONFIG_SECRET` 时拒绝启动）。

8. **路径穿越前缀绕过（上传目录与静态目录）**
   证据：`server/index.ts:158-163`、`server/index.ts:248-252`、`server/generation-tasks/upstream-helpers.ts:120-124`；实测 §3.5-J 读到 `UPLOADS_DIR` 之外的 `/tmp/audit-uploads-evil/x.txt`（200 + 文件内容）。
   **怎么修**：把 `startsWith(dir)` 换成 `path.relative(dir, target)` 后校验不以 `..` 开头且非绝对路径（或统一 `realpath` 后比较）。

9. **依赖不可复现 + 线上 7 项高危 + 镜像内无审计**
   证据：`.gitignore`（忽略 `package-lock.json`）、`Dockerfile:10,19,68`（`npm install --no-audit`）、§4.2 的 audit 原始输出（7 high / 1 moderate）、`.github/workflows/docker-image.yml` 无 audit/测试步骤。
   **怎么修**：提交并启用锁文件（`npm ci` 或统一到 pnpm），Dockerfile 恢复审计、CI 增补 `npm audit --omit=dev --audit-level=high` 门禁，本轮先升级 `sharp` / `mysql2` / `prisma`。

### P2（中）

10. **缺全部安全响应头**
    证据：全仓库对 `Content-Security-Policy|X-Frame-Options|X-Content-Type-Options|Strict-Transport-Security|Referrer-Policy` 检索**无命中**；`server/index.ts:589-616` 只写 CORS 头。
    **怎么修**：在 `applyCorsHeaders` 旁统一补 `CSP`（含 `frame-ancestors`）、`X-Content-Type-Options: nosniff`、生产环境 `Strict-Transport-Security`。

11. **已登录用户的第二处 SSRF（生成记录 `outputs[].url`）**
    证据：`server/generation-records/service.ts:250-256`（`fetch(url)`）+ `:325-341`（转存并返回 `publicUrl`，响应体可被攻击者取回）；`server/generation-tasks/upstream-helpers.ts:141`（参考图 URL 直接 fetch）。
    **怎么修**：对这两处出网加白名单（仅允许 https + 解析后禁止私网/环回/链路本地地址，禁止跟随重定向到私网）。

12. **公开资产列表匿名返回 `owner.email`**
    证据：`server/asset-items/service.ts:70-80`（序列化 email）、`:238-244`（`select: { email: true }`）、`server/asset-items/request-handler.ts:98-100`（默认分支无鉴权）；实测 §3.5-K 未登录可见 `owner` 字段（本库 owner 邮箱为空，故暂未泄露真实值）。
    **怎么修**：公开列表的 owner 只返回 `id/name/avatarSrc`，去掉 `email`（或脱敏）。

13. **AI 网关无幂等 + 幂等键漏字段 + 无请求体上限/限流**
    证据：`server/ai-gateway/request-handler.ts:26-28,77-92,194-209`（每次新 `associationNo`、直扣分）；`server/generation-tasks/shared.ts:12-30` vs `task-lifecycle-service.ts:144-163`（`mask`/`researchConfig` 未入键）；`server/ai-gateway/shared.ts:26-44`（整块读，无上限）。
    **怎么修**：给网关直连路径加基于（用户+模型+请求体）的幂等键与限流；幂等键补齐 `mask`/`researchConfig`；对上传与网关统一设请求体上限与超时。

---

## 4. 详细发现（实测原始输出）

隔离实例启动方式（上传与静态目录指向 `/tmp`，避免污染仓库）：

```
$ mkdir -p /tmp/audit-uploads /tmp/audit-static
$ cd /Users/mima1234/CanvasMind && SERVER_PORT=5499 UPLOADS_DIR=/tmp/audit-uploads STATIC_DIST_DIR=/tmp/audit-static \
    nohup npx tsx --env-file=.env.development server/index.ts > /tmp/audit-server.log 2>&1 &
[2026-09-23 00:59:55] [服务端] 启动完成
[2026-09-23 00:59:55] [服务端] 服务地址: http://0.0.0.0:5499
[2026-09-23 00:59:55] [服务端] 上传目录: /tmp/audit-uploads
$ curl -sS http://127.0.0.1:5499/api/health
{"message":"ok","data":{"status":"running"}}
```

### 3.1-A 未登录 SSRF（header 分支，响应体回显）

```
$ curl -sS -i -X POST http://127.0.0.1:5499/api/ai/request \
    -H 'x-upstream-base-url: http://127.0.0.1:5499' -H 'x-upstream-endpoint: /api/health' -H 'x-upstream-method: GET'
HTTP/1.1 200 OK
content-type: application/json; charset=utf-8
{"message":"ok","data":{"status":"running"}}
```
服务端把 `http://127.0.0.1:5499/api/health` 的响应体当作上游响应原样返回给匿名调用方 → 任意内网地址探测（`http://127.0.0.1:3306/`、`http://127.0.0.1:6379/` 均实测到达 fetch 层，返回 `{"message":"fetch failed"}`）。

### 3.1-B 未登录使用平台厂商密钥（鉴权闸门缺失）

```
### B) providerId + endpoint-type=chat（非计费）
{"message":"厂商不可用或未启用","error":{"type":"gateway_error","message":"厂商不可用或未启用"}}
### C) 对照：providerId + endpoint-type=image（计费）
HTTP/1.1 401 Unauthorized
### C2) JSON body + providerId + endpointType=chat
{"message":"厂商不可用或未启用","error":{"type":"gateway_error","message":"厂商不可用或未启用"}}
```
B/C 的差异证明「是否要求登录」只取决于 `endpointType`。B 已经走到 `resolveGatewayProviderUpstream`（否则会是 401），该函数返回 `decryptProviderApiKey(...)`，随后 `forwardGatewayPayload` 会带着它出网。活跃库确认具备可利用条件：

```
SELECT id,name,is_enabled,LENGTH(api_key_encrypted) len, api_key_hint FROM ai_providers WHERE api_key_encrypted IS NOT NULL
[ { id:'cmub9tmb500cr96wpql0pwlc3', name:'ggwk1 图像中转', is_enabled:1, len:110, api_key_hint:'sk-R...Lvqs' },
  { id:'cmuc382d500005ywpqih56k3o', name:'通义千问 MaaS', is_enabled:1, len:198, api_key_hint:'sk-s...eXTY' } ]
SELECT provider_id,model_key,category,is_enabled FROM ai_models WHERE category='CHAT' AND is_enabled=1
[ { provider_id:'cmuc382d500005ywpqih56k3o', model_key:'qwen3.8-flash', category:'CHAT', is_enabled:1 } ]
```
（**端到端匿名调用未执行**——那会真实消耗上游额度，见 §5。）

### 3.2-D 未登录上传 + 同源存储型 XSS

```
$ curl -sS -i -X POST http://127.0.0.1:5499/api/storage/upload \
    -H 'x-upload-filename: probe.html' -H 'content-type: text/html' -H 'x-upload-category: probe' \
    --data-binary '<script>document.title="pwned"</script>'
HTTP/1.1 200 OK
{"data":{"filePath":"/tmp/audit-uploads/probe/20260922/1790096413364-....html",
 "publicUrl":"/uploads/probe/20260922/1790096413364-....html","mimeType":"text/html",...,"storageType":"local"},"message":"上传成功"}

$ curl -sS -i "http://127.0.0.1:5499/uploads/probe/20260922/1790096413364-....html"
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
```
无 Cookie、无任何凭据。浏览器访问该 URL 即在应用同源下执行脚本 → 可代登录用户（含管理员）发起任意同源请求（接口无 CSRF token，Cookie 会自动带上）。

### 3.5-J 路径穿越（前缀绕过）

```
$ echo "OUTSIDE-UPLOADS-DIR-SECRET" > /tmp/audit-uploads-evil/x.txt
$ curl -sS -i --path-as-is "http://127.0.0.1:5499/uploads/..%2Faudit-uploads-evil/x.txt"
HTTP/1.1 200 OK
Content-Type: text/plain; charset=utf-8
Content-Length: 27
OUTSIDE-UPLOADS-DIR-SECRET
$ curl -sS -i --path-as-is "http://127.0.0.1:5499/uploads/..%2Faudit-static-other/x.txt"
HTTP/1.1 404 Not Found
```
`UPLOADS_DIR=/tmp/audit-uploads`，但读到了 `/tmp/audit-uploads-evil/x.txt` —— 因为校验是 `filePath.startsWith(uploadsDir)` 的**字符串前缀**比较。生产默认 `UPLOADS_DIR=/app/uploads`，则可读 `/app/uploads*` 下的兄弟目录。

### 3.5-K 匿名可读公开资产（含 owner 字段）

```
$ curl -sS "http://127.0.0.1:5499/api/asset-items?scope=feed&page=1&pageSize=3"
{"data":{"items":[{"id":"cmucucuig00m35ywpv0b1euxk","assetType":"image","fileUrl":"/uploads/generated/image/20260922/....png",
  "promptText":"极简电影摄影，一个空荡荡的旧房间...","source":"generated",...,"owner":{"id":"cmu9zppwt000196wpcxpcd4rk",
  "name":"超级管理员","email":"","avatarSrc":""}}...]}}
```
`owner.email` 在响应对列里明确定义（`server/asset-items/service.ts:78`），本库该用户邮箱为空故为空串；任何填了邮箱的用户，其邮箱会公开给匿名访问者。

### 3.6 开发库当前登录方式状态（只读查询）

```
SELECT method_type,is_enabled,is_visible,allow_auto_fill,allow_sign_up FROM auth_method_configs
[ { method_type:'ADMIN_PASSWORD', is_enabled:1, is_visible:1, allow_auto_fill:0, allow_sign_up:0 } ]
SELECT COUNT(*) c, SUM(revoked_at IS NULL) active FROM app_sessions  →  { c: 23, active: '10' }
```
即：当前实例只开了管理员账号密码登录，`allow_auto_fill=0`，所以 Q1.5 的验证码回显洞**现在关着**；一旦后台把手机/邮箱登录打开（策略已就绪、代码路径完整），它会立即变成可登录任意已知手机号/邮箱账号的通道。同时 23 条会话里仍有 10 条未吊销（30 天有效期，属预期）。

---

## 5. 未能确认的事项

1. **匿名使用平台 `chat` 模型额度的端到端效果未实测**：闸门缺失（§3.1-B）与密钥注入路径（`ai-gateway/forward.ts:113-115` + `provider-config/service.ts:656`）均已确认，但真正发一次请求会消耗上游真实额度，本轮按「只审计」原则未执行。影响判断：只要厂商配置存在启用密钥，匿名即可消耗。
2. **生产部署形态未知**：仓库内没有 nginx/反代配置（`find . -name "*.conf"` 只返回 `scripts/` 下的构建脚本，无 server 段），因此「线上是否由反代补了 CSP/HSTS、是否禁止 `/uploads` 执行、是否把上传域名分离」无法确认；本文所有响应头结论都基于 Node 服务自身的输出。
3. **生产 `.env.production` 是否真的设置了两个 `SECRET`**：仓库未跟踪该文件（仅 `.example`），无法确认线上是否落在硬编码默认值上。
4. **生产/线上库的 `auth_method_configs` 实际状态未知**（本文只读到本地开发库，仅 `ADMIN_PASSWORD`）。若生产开启了手机/邮箱登录，Q1.5 的验证码回显立刻升级为「任意账号接管」，严重度需按 P0 处理。
5. **`npm audit` 的 8 项未逐项验证可达性**：`audit` 只按版本区间判定，例如 `sharp`/libvips 的 CVE 是否在本项目实际调用路径（图片解码）上触发未验证；`mysql2`/`mariadb` 的明文口令问题是否因未启用 TLS 而实际命中也未验证。
6. **Redis 不可达时的幂等 fail-open 未在运行态实测**：需要登录会话并提交真实任务，会写入生成记录与积分，故仅以读码为据（`server/redis/idempotency.ts:73-88`）。
7. **`pnpm-lock.yaml` 与 `package.json` 是否同步未验证**：CI 与 Dockerfile 都用 `npm install`（不用该锁文件），因此无法确认它是否还有效；也就无法把「可复现安装」的修复方案直接定为「切回 pnpm」。
8. **对象存储启用时的上传域名归属未确认**：`saveUploadedBuffer` 在启用对象存储时返回的是对象存储 `publicUrl`（`server/storage/service.ts:110-128`），此时存储型 XSS 是否与主站同源取决于所用 OSS/CDN 域名，仓库内无法判定。
