# 代码鲁棒性与测试覆盖审计（round 2 · 04）

> 审计对象：`/Users/mima1234/CanvasMind`
> 审计时间：2026-09-23
> 审计方式：**只读**。所有结论附**文件路径 + 行号**或**命令 + 原始输出**。
> 命令实测全部在本机执行；`git status --porcelain` 复查后仅剩未跟踪的 `docs/audit-round2/`，
> **无任何被跟踪文件被改动**（`git diff --stat` 输出为空）。`dist/` 已在 `.gitignore:11` 忽略。

---

## 0. 六问直答

| # | 问题 | 结论 |
|---|---|---|
| 1 | 测试盘点 | `tests/` 下 **19 个 `.test.ts` + 12 个 `.mjs` e2e**；单测共 **547 条断言，全绿**。覆盖集中在**前端纯逻辑**（17/19 个文件），**服务端仅 2 个文件被测**（`normalizeInteger`、`normalizeRuntimeLimit`）。会话鉴权、生成任务状态机、幂等、资产发布状态机、计费**零测试** |
| 2 | 可单测但未测的纯逻辑 | 找到 10 个明确候选（含 `buildInitialRecordPayload`、`normalizeGenerationErrorMessage`、`getResearchNextStage`、`classifyError`、`buildTaskSubmissionIdempotencyKey` 等），全部是纯函数/纯状态转移，**无任何测试引用** |
| 3 | 鲁棒性实测 | `type-check` ✅ 8.9s / `test:unit` ✅ 6.4s（19 文件全过）/ `build:client` ✅ 33.4s。吞异常点共 **20 处**（全仓仅 1 处字面 `catch {}`），前 10 条见 §3 |
| 4 | 边界与并发 | 找到 **9 处**具体缺口：请求体无大小上限（3 个入口）、`readJsonBody` 无 try/catch、**SSE 最近事件缓存是非原子读改写**、退点先置位后 await、收藏/浏览/下载计数无去重、唯一确定的监听器泄漏在 `PublishCenter.vue` |
| 5 | 前端健壮性 | **全局错误边界：无**（无 `app.config.errorHandler`、无 `onErrorCaptured`）；**`unhandledrejection` 上报：无**（前端 0 命中，服务端有进程级兜底）；**统一重试：有但不统一**（两套请求层，主层无重试）；**超时：主链路口径上无**（仅 SSE watchdog 30s 与 `reference-validation` 4s） |
| 6 | 性能粗测 | 超 500KB 的包 **3 个**：`vendor` 2013.13 kB、`element-plus` 769.99 kB、`VideoEditorPage` 555.55 kB；另有 `index-*.css` 335.05 kB 与 **21.6 MB 的 `ort-wasm`**。可拆点：`vendor` 拆 React/radix/wavesurfer/transformers 桶 |

---

## 1. 测试覆盖地图（模块 → 有无测试 → 优先级）

### 1.1 现有测试逐文件清点（19 个文件 / 547 条断言）

断言数取自 `npm run test:unit` 实际输出（`通过 N / 失败 0`），非静态 grep 计数。

| # | 测试文件 | 被测模块（import 源） | 断言 | 判定 |
|---|---|---|---|---|
| 1 | `tests/alignment-guides.test.ts` | `src/views/workflow/composables/useCanvasAlignmentGuides` | 15 | ✅ |
| 2 | `tests/assistant-context.test.ts` | `src/composables/assistant-chat-history`、`views/workflow/config/canvas-brief`、`composables/assistant-session-order` | 31 | ✅ |
| 3 | `tests/auto-link.test.ts` | `src/components/generate/auto-link` | 22 | ✅ |
| 4 | `tests/canvas-icons.test.ts` | `src/components/icons/canvas-icons`、`views/workflow/config/node-suggestions` | 23 | ✅ |
| 5 | `tests/canvas-layout.test.ts` | `src/views/workflow/config/canvas-layout` | 25 | ✅ |
| 6 | `tests/crop-geometry.test.ts` | `src/views/workflow/config/crop-geometry` | 29 | ✅ |
| 7 | `tests/image-edit-mask.test.ts` | `src/shared/upstream-request-normalizer` | 18 | ✅ |
| 8 | `tests/legacy-config-migration.test.ts` | `views/workflow/composables/legacy-config-node-migration`、`useWorkflowCanvas` | 30 | ✅ |
| 9 | `tests/mention-groups.test.ts` | `src/components/generate/mention-groups` | 16 | ✅ |
| 10 | `tests/model-params.test.ts` | `src/config/model-params`（+ `config/models` 类型） | 82 | ✅ |
| 11 | `tests/node-input-rules.test.ts` | `src/views/workflow/config/node-input-rules` | 25 | ✅ |
| 12 | `tests/node-size.test.ts` | `src/views/workflow/config/node-size` | 28 | ✅ |
| 13 | `tests/node-suggestions.test.ts` | `src/views/workflow/config/node-suggestions` | 16 | ✅ |
| 14 | `tests/node-toolbar.test.ts` | `views/workflow/composables/useNodeToolbar` | 10 | ✅ |
| 15 | `tests/redis-config.test.ts` | **`server/redis/config`** | 16 | ✅ |
| 16 | `tests/reference-and-presets.test.ts` | `src/config/reference-validation`、`config/prompt-presets` | 43 | ✅ |
| 17 | `tests/reference-resolver.test.ts` | `views/workflow/composables/reference-resolver`、`useWorkflowCanvas` | 58 | ✅ |
| 18 | `tests/system-config-limits.test.ts` | **`server/system-config/service`** | 17 | ✅ |
| 19 | `tests/workflow-templates.test.ts` | `src/views/workflow/config/workflows` | 43 | ✅ |
| | | **合计** | **547** | **全绿** |

**测试框架**：无框架。19 个文件各自内联 `check(label, actual, expected)` 断言助手，靠 `scripts/tests/run-unit.mjs`（`child_process.spawn` + `npx tsx`）串行跑，退出码非 0 即失败。
**无 `vitest` / `jest` / `eslint`**：`ls node_modules/.bin | grep -iE "eslint|vitest|jest"` → 空；`rg -iE "eslint|prettier|vitest|jest" package.json` → 空。

**另一批：`scripts/tests/`** 只有 3 个 `.mjs`（`run-all.mjs` 会跑 2 个，跳过 `test-research-task.mjs`），覆盖 2 个 research 模块：
`test-research-read-target-ranker.mjs`、`test-research-report-writer.mjs`。

**e2e：12 个 `.mjs`（`tests/e2e/`），但不可移植** —— 10 个文件硬编码作者本机绝对路径：
```
$ rg -l '/Users/mima1234' tests scripts | wc -l
10
$ head -22 tests/e2e/canvas-perf.mjs | tail -3
const { chromium } = require('/Users/mima1234/.npm/_npx/705bc6b22212b352/node_modules/playwright-core')
const mariadb = require('/Users/mima1234/CanvasMind/node_modules/mariadb')
```
且 `package.json` **没有 `test:e2e` 脚本**，CI / Dockerfile / `npm test` 都不会跑到它们（`Dockerfile:41` 只有 `npm run build:client`）。

### 1.2 完全无测试的核心模块 —— 优先级最高的 10 个缺口

规模用 `rg --files src server -g '*.ts' -g '*.vue' | wc -l` → **521 个文件 / 约 12.8 万行**（src 95,454 行、server 33,054 行、src-cutia 另有 48,445 行）；测试只有 **2,770 行**。

| 优先级 | 缺口模块 | 规模 | 为什么这是缺口（一句话） |
|---|---|---|---|
| **P0** | `server/auth/`（`session.ts`、`service.ts`、`strategies/*`） | 1,645 行 | 会话与登录鉴权的唯一入口，全部路由都 `requireCurrentSessionUser`，但**无一条越权/过期/伪造用例** |
| **P0** | `server/generation-tasks/task-lifecycle-service.ts` | 539 行 | 生成任务状态机主脑：幂等占用 → 建记录 → 扣点 → 落并发槽 → 后台执行 → 失败释放，**编排分支零覆盖** |
| **P0** | `server/redis/idempotency.ts` | 193 行 | `claim/complete/clear` 三段式 + 三段 Lua CAS，决定"重复点击会不会重复扣点"，全靠人工推演 |
| **P0** | `server/marketing-center/service.ts`（扣点/退点/账本） | 1,096 行 | 计费核心，含 `lockUserBillingRow` 与退点；`docs/billing-and-cost-policy.md` 明写"未交付不计费"，**无测试保证** |
| **P1** | `server/generation-tasks/execution-strategies.ts` | 411 行 | 4 种策略 × `handleStopped/handleFailed` 共 8 条收口路径，每条都是"退点 + 写库 + 发事件"三步，**顺序错了就卡前端** |
| **P1** | `server/generation-tasks/task-runtime-governor.ts` | 252 行 | 分布式锁获取/续租/失锁中断，`renewIntervalMs = max(5000, ttl/3)` 等阈值逻辑无验证 |
| **P1** | `server/redis/`（`lock.ts` 112 行 + `concurrency.ts` 138 行 + `rate-limit.ts` 77 行） | 327 行 | 三套 Lua 计数/锁语义，**只有 `config.ts` 被测** |
| **P1** | `server/asset-items/service.ts`（发布状态机） | 611 行 | `visibility × publishStatus × reviewStatus` 三态组合转移（`service.ts:425-560`），无状态机校验测试 |
| **P1** | `src/api/generation-tasks.ts`（SSE 订阅/退避/watchdog） | 244 行 | 前端重连与 30s 断流判定是"任务卡住"类线上问题的主战场，**零测试** |
| **P2** | `src/stores/auth.ts` + `src/utils/errorHandler.ts` + `src/shared/generation-error.ts` | 136 + 325 + 207 行 | 前端登录态、错误分类与重试、错误文案归一化，全是纯逻辑却无测试 |

补充（同样零测试、按需排期）：`server/generation-tasks/local-runtime.ts`（130 行，SSE 订阅者计数/慢订阅者剔除）、`server/generation-tasks/task-event-replay.ts`（109 行，事件 id 分配与回放）、`server/research/` 其余 6,000+ 行、`src-cutia/` 48,445 行全部无测试。

### 1.3 未被 `npm test` 把关的事实

`npm test` = `type-check && test:unit && test:scripts`，三步全在本地。
`rg -n "npm run|test" .github/workflows/*.yml Dockerfile` 只命中 `Dockerfile:41 RUN npm run build:client` —— **流水线与镜像构建都不跑测试**。即单测只靠人记得手动执行。

---

## 2. 命令实测结果

三条命令均在本机实跑，输出落盘到 `/tmp/cm-*.log`。

### 2.1 `npm run type-check`

```
$ time npm run type-check
> canvasmind@1.0.2 type-check
> vue-tsc --noEmit
npm run type-check  14.55s user 0.80s system 171% cpu 8.928 total
EXIT=0
```
**✅ 通过**，无任何诊断输出。**耗时 8.9s**。

### 2.2 `npm run test:unit`

```
$ time npm run test:unit
> canvasmind@1.0.2 test:unit
> node scripts/tests/run-unit.mjs
[test:unit] 运行 19 个测试文件…
…(略)…
[test:unit] 19 个文件全部通过
npm run test:unit  6.06s user 1.47s system 117% cpu 6.409 total
EXIT=0
```
**✅ 通过**：19/19 文件、**547 条断言、0 失败**。**耗时 6.4s**。
逐文件断言数见 §1.1；失败数全为 0（`awk` 抽取 `通过 N / 失败` 逐行核对，无一条非 0）。

### 2.3 `npm run build:client`

```
$ time npm run build:client
> canvasmind@1.0.2 build:client
> vue-tsc --noEmit && vite build
[unplugin-vue-components] component "TypeSelector"… has naming conflicts with other components, ignored.
vite v7.3.6 building client environment for production...
✓ 5192 modules transformed.
(!) Some chunks are larger than 500 kB after minification. …
✓ built in 23.54s
npm run build:client  79.51s user 6.10s system 256% cpu 33.354 total
EXIT=0
```
**✅ 通过**，仅有 1 条组件命名冲突警告与 1 条 chunk 体积警告。**耗时 33.4s**（其中 `vue-tsc` 约 9s + `vite build` 23.5s）。

### 2.4 吞异常盘点结果

```
$ rg -U --multiline-dotall -n -e 'catch\s*(\([^)]*\))?\s*\{\s*(console\.(log|warn|error|debug)\([^;{]*\);?\s*|//[^\n]*\n\s*|/\*.*?\*/\s*)*\}' src server
$ rg -nE 'catch\s*(\([^)]*\))?\s*\{\s*\}' . --exclude-dir=node_modules --exclude-dir=dist
./src-cutia/core/managers/audio-manager.ts:262:} catch {}
```
全仓 `catch` 命中 263 处（`src` + `server`），其中 224 处是"catch + 仅日志/注释"形态；字面空 `catch {}` 仅 1 处。**前 10 条按危害排序见 §3**。

---

## 3. 鲁棒性问题清单（按严重度）

### 🔴 严重

**S1. 退点失败被吞掉：用户被扣点且无补偿、无重试**
`server/ai-gateway/request-handler.ts:110-118`（multipart 路径）与 `:227-235`（JSON 路径）

```ts
// server/ai-gateway/request-handler.ts:226-235
let refunded = false
const refundConsumedPointsIfNeeded = async (reason: string) => {
  if (!consumedPointLog || refunded) return
  refunded = true
  try {
    await refundGenerationPoints({ ... })
  } catch (error) {
    console.error('[ai-gateway][refund-error]', JSON.stringify({ ... }))
  }
}
```
- **影响**：网关判定上游失败（`beforeProxy` 里 `!upstreamResponse.ok`）或 fetch 抛错时调用退点；退点自身失败只打一条 `console.error`。**`refunded` 已置 true，永不重试**；用户积分被扣、账本无 `REFUND` 记录，且没有任何后台补偿入口。
- **一句话修法**：退点失败改为写入一张 outbox/重试表（或 Redis 待补偿队列）并告警，而不是只 `console.error`；`refunded` 标志延后到退点成功后再置位。

**S2. `refundTaskPointsIfNeeded` 先置位后 await：退点抛错会连带中断整个失败收口**
`server/generation-tasks/service.ts:407-424`

```ts
// server/generation-tasks/service.ts:407-424
const refundTaskPointsIfNeeded = async (task, reason) => {
  if (!task.billedPointCost || task.refundCommitted) return
  task.refundCommitted = true          // ← 412 行：先置位
  await refundGenerationPoints({ ... }) // ← 377 行起，走 prisma.$transaction + 行锁，可抛错
}
```
- **调用点**：`server/generation-tasks/execution-strategies.ts:117`（image `handleFailed`）、`:83`（`handleStopped`）、`165/196/245/275/323/354`（agent / research 同理），且**都在收口第一步**。
- **影响**：退点一抛错 → `handleFailed` 后续的 `markTaskExecutionState` / `updateGenerationRecord` 全部跳过 → **DB 里记录停在 `done:false`**，前端靠 `service.ts:469-479` 的兜底 `emitTaskFailedEvent` 才停止 watchdog；用户刷新页面仍看到"生成中"。同时 `refundCommitted=true` 已写死，同一任务再无退点机会。
- **一句话修法**：`refundCommitted` 改为在 `await refundGenerationPoints(...)` 成功返回后再置位，并把退点包进 `try/catch`（失败只记日志、不阻断收口）。

**S3. SSE「最近事件」缓存是非原子读-改-写，并发下丢事件**
`server/generation-tasks/runtime-store.ts:95-117`

```ts
// server/generation-tasks/runtime-store.ts:95-117
const currentItems = await readJsonCache<SharedTaskRecentEventItem[]>(redisKeys.taskRecentEvents(recordId))
…
const nextItems = [...(Array.isArray(currentItems) ? currentItems : []), nextItem].slice(-20)
await writeJsonCache(redisKeys.taskRecentEvents(recordId), nextItems, …)
```
- **影响**：GET → 拼接 → SET，无 `WATCH/MULTI`/`RPUSH`。而调用方 `task-event-emitter.ts:34` 对**每个流式事件**都 `void appendSharedTaskRecentEvent(...)` —— agent/research 任务每秒可产生多个事件，并发写同一 key 时后写覆盖先写，**后台"任务最近阶段"会丢**。同一文件 `:78-92` 的 `setSharedTaskSnapshot` 是整体覆盖语义（可接受），但 `:95` 这段是明确的累加语义。
- **一句话修法**：改用 `RPUSH + LTRIM`（与 `task-event-replay.ts:61-63` 的写法一致）替代"读 JSON 数组再 SET"。

### 🟠 中等

**S4. 请求体无任何大小上限，且先全量进内存再校验**
- `server/ai-gateway/shared.ts:26-44`：`readRawBody` / `readRawBuffer` 把整个 body 累积到 `Buffer[]` 再 concat，**无 `content-length` 预检、无流式上限**。
- `server/storage/request-handler.ts:20-23`：读完整个 buffer **后**只判空，**全文无大小限制**（`rg -n "MAX|limit|byteLength" server/storage/request-handler.ts` 仅命中 `:23` 判空）。
- `server/asset-items/request-handler.ts:52-60`：同样是"先 `readRawBuffer` 读满内存"，**到第 57 行才比对 `ASSET_ITEMS_MAX_UPLOAD_BYTES`** —— 校验发生在内存已经被消耗之后。
- `server/ai-gateway/forward.ts:60`：网关转发 `payload.request.body` 同样无上限。
- **影响**：一个超大 POST 即可在 413 返回之前把进程内存打满。
- **一句话修法**：在 `readRawBuffer/readRawBody` 内累计时按 `content-length` 与硬上限（如 64MB）提前中断并回 413。

**S5. `readJsonBody` 无 try/catch，坏 JSON 变成 500 而非 400**
`server/ai-gateway/shared.ts:19-24`

```ts
export const readJsonBody = async (req: any): Promise<GatewayForwardBody> => {
  const raw = await readRawBody(req)
  if (!raw) return {}
  return JSON.parse(raw) as GatewayForwardBody   // ← 无守卫
}
```
- 同形态还有 `server/auth/shared.ts:33-40`（认证入口）、`server/system-init/shared.ts:17-24`、`server/admin-users/request-handler.ts:36`。
- **影响**：调用方（如 `server/asset-items/request-handler.ts:125-127`）统一 `catch → 500`，于是"用户发了个坏 JSON"被报成"处理资源请求失败（服务端错误）"，客户端会据此重试，噪声与 500 告警被污染。
- **一句话修法**：`readJsonBody` 内 `try { JSON.parse } catch { throw new RequestBodyError(400) }`，全局 catch 识别该类型返回 400。
- **注**：`server/redis/pubsub.ts:68` 的 `JSON.parse` 虽未守卫，但 `:24-30` 的消息分发层已包 `try/catch`，**不构成漏洞**（已核实）。

**S6. 暂停/失败收口失败被静默吞掉，UI 状态与 DB 不一致**
`src/views/generate/generate.vue:2898-2900` / `2915-2917` / `2939-2941`（三处相同注释）

```ts
} catch {
  // 停止失败时保持当前状态，等待 SSE 或后续同步刷新。
}
```
- **影响**：用户点"停止"失败时既无提示也不回滚乐观态；若 SSE 已断流，任务会一直显示"生成中"。
- **一句话修法**：catch 里补一次显式 `ElMessage.warning` + 主动 `refreshGenerationRecord`，而不是"等 SSE"。

**S7. 生成记录持久化失败静默丢弃（前端数据丢失）**
`src/views/generate/generate.vue:1832-1834`

```ts
} catch {
  // 持久化失败时不影响当前页面的生成流程。
}
```
- **影响**：`create/updateGenerationRecordRequest` 失败后 `recordPersistInflight.delete(record.id)` 仍在 `finally` 执行，**该记录本次不再重试**；用户刷新后记录消失。
- **一句话修法**：失败时把 record 放回待重试集合（限次退避重试一次），并提示"记录可能未保存"。

**S8. 批量发布：失败被吞掉，随后仍弹"完成"**
`src/views/publish/PublishCenter.vue:956-971`

```ts
for (const tab of tabs) {
  try {
    await confirmPublish(tab)
  } catch (error) {
    console.error('批量发布失败:', error)   // ← 964 行
  }
}
batchPublishing.value = false
ElMessage.success('批量发布完成')          // ← 970 行：无条件成功提示
```
- **影响**：N 条全失败时用户看到的是"批量发布完成"，且没有任何失败清单。
- **一句话修法**：累计失败条数，`failed > 0` 时改弹 warning 并列出失败项。

**S9. 审计日志写失败被吞掉 → 后台操作无留痕**
`server/shared/admin-audit.ts:77-79`

```ts
} catch (error) {
  console.error('[admin-audit] failed to record admin audit log', error)
}
```
- **影响**：审计日志是管理端**唯一**的操作溯源，写库失败（DB 抖动/约束冲突）后管理动作照常返回 200，事后无法追溯"谁改了什么"。
- **一句话修法**：审计写失败至少升级为告警日志（`writeScopedLog('error', …)`）并计数暴露，不要只 `console.error`。

**S10. `void markTaskExecutionState(...)` 无 `.catch`：锁丢失状态可能未落库**
`server/generation-tasks/task-runtime-governor.ts:188-194`

```ts
renewTimer = setInterval(() => {
  void renewRedisLock(executionLock).then((renewResult) => {
    …
    void markTaskExecutionState(task, {      // ← 188 行：无 .catch
      lockLost: shouldAbort, …
    })
```
- **影响**：`markTaskExecutionState` 是一次 DB 写入；失败时只被 `server/index.ts:623-625` 的进程级 `unhandledRejection` 记一条日志，**`lockLost=true` 没有落库**，其它实例/后台看不到"该任务的执行锁已丢"。同一文件 `:178` 的 `renewRedisLock(...).then(...)` 也只挂了 `.then`，`.then` 回调内抛错同样落到进程兜底。
- **一句话修法**：两处都补 `.catch((e) => logGenerationTaskError('task_lock_state_persist_failed', e, …))`，并让失败走"保守中断任务"而非静默继续。

### 🟡 较低

**S11. `favorite` / `view` / `download` 计数无幂等或去重**
`server/asset-items/service.ts:496-545`

```ts
case 'favorite': { const result = await prisma.assetItem.updateMany({ where, data: { favoriteCount: { increment: 1 } } }) }
case 'view':     { … viewCount: { increment: 1 } }
case 'download': { … downloadCount: { increment: 1 } }
```
- **影响**：同一用户双击/脚本刷即可把计数刷高；`applyAssetAction` 本身**未校验 `ids` 是否为空**（`server/asset-items/shared.ts:100-108` 允许 `ids: []`，`updateMany` 退化为无匹配，无害但无 400 反馈）。
- **一句话修法**：`favorite` 落一张 `(userId, assetId)` 唯一表并按 upsert 计数；`view/download` 加"用户+资源+小时窗口"去重键。

**S12. 环境变量数字解析未防 `NaN`**
`server/generation-tasks/task-stream-subscription.ts:19`、`server/generation-tasks/local-runtime.ts:30`、`server/research/tools.ts:41-44`

```ts
// task-stream-subscription.ts:19
const SSE_MAX_CONNECTION_MS = Number.parseInt(process.env.SSE_MAX_CONNECTION_MS || '1800000', 10)
```
- **影响**：`.env` 写成 `SSE_MAX_CONNECTION_MS=30m` → `NaN` → 第 143 行 `setTimeout(fn, NaN)` 视为 0ms，**所有 SSE 连接建立即被关闭**（表现为前端无限重连）。同类：`SSE_PER_USER_LIMIT=NaN` 会让 `:47` 的 `(set?.size||0) >= NaN` 恒为 false，**限流失效**。
- **对比**：`server/index.ts:72-78` 的 `readServerPort` 做了 `Number.isFinite` 兜底，`tests/redis-config.test.ts` 也专门钉住了 `normalizeInteger` 的空值路径 —— 说明这是**已知模式，只是没推广开**。
- **一句话修法**：统一走 `normalizeInteger(raw, fallback)`（`server/redis/config.ts` 已有该函数，且已被测试覆盖）。

**S13. `window` 事件监听未移除（唯一确定的一处泄漏）**
`src/views/publish/PublishCenter.vue:612-620`

```ts
onMounted(() => {
  const handleOnlineStatus = () => { isOnline.value = navigator.onLine }
  window.addEventListener('online', handleOnlineStatus)
  window.addEventListener('offline', handleOnlineStatus)
  ErrorHandler.cleanOldLogs(30)
})
```
- **影响**：`grep -n "onMounted|onUnmounted|onBeforeUnmount" src/views/publish/PublishCenter.vue` 只有 `:612` 与 `:972` 两个 `onMounted`，**无任何卸载钩子**；每次进入发布中心都会叠加一对监听器（`handleOnlineStatus` 是每次新建的闭包，`removeEventListener` 也拦不住）。
- **一句话修法**：把 handler 提到组件作用域，加 `onBeforeUnmount(() => { window.removeEventListener('online', h); window.removeEventListener('offline', h) })`。
- **已核实为"可接受"的同类**（不列为问题）：`src/stores/{video-project,marketing-center,theme-preference}.ts` 是模块级单例初始化（应用生命周期内只注册一次）；`src/composables/useShortcuts.ts:49-53` 用 `listenerAttached` 保证只挂一次 `keydown` 且 `:170-175` 按 chord 精确摘除。

**S14. `consumeSseStream` 缺少 `try/finally`：reader 在异常路径不释放**
`src/utils/sse.ts:44-80`

```ts
const reader = response.body?.getReader()
…
while (true) {
  const { done, value } = await reader.read()
  …
}
```
- **影响**：`reader.read()` 因 `innerController.abort()` 抛 `AbortError`（`src/api/generation-tasks.ts:158-160` 的 watchdog 会主动 abort）、或 `onMessage` 抛错时，**不会 `reader.cancel()` / `releaseLock()`**。SSE 重连是常态（`RETRY_DELAYS_MS = [1000,2000,5000,10000,30000]`），高频重连会持续泄漏 reader 与其底层连接。
- **一句话修法**：`consumeSseStream` 内包 `try { … } finally { await reader.cancel().catch(() => {}) }`。

**S15. 字面空 catch 与"只 console"清单（其余项）**
| 位置 | 形态 | 说明 |
|---|---|---|
| `src-cutia/core/managers/audio-manager.ts:262` | `} catch {}` | 全仓唯一字面空 catch；`source.stop()` 失败被完全丢弃 |
| `server/storage-config/service.ts:99-101` | `catch { /* ignore */ }` | URL 解析失败后静默回退字符串拼接，用户拿到可能是错的公开 URL |
| `server/asset-items/shared.ts:144-146` | `catch { /* 空对象兜底 */ }` | `x-media-meta` base64/JSON 解析失败 → **宽高/时长/缩略图被静默丢弃**，前端瀑布流布局退化 |
| `server/generation-tasks/local-runtime.ts:112-114` | `catch { subscribers.delete(res) }` | 慢订阅者剔除，合理但**无任何计数/指标**，线上看不出"多少人被踢" |
| `server/generation-tasks/task-stream-subscription.ts:116-118 / 130-132 / 139-141` | `catch { /* 注释 */ }` | 重放失败、心跳写失败、lifetime end 失败，均为合理降级（心跳失败有 close 事件兜底） |
| `server/generation-tasks/task-event-replay.ts:95-97` | `catch { /* 忽略解析失败 */ }` | 回放条目损坏时静默跳过，会导致 lastEventId 续传出现空洞 |
| `server/research/tools.ts:58-60` | `catch { /* 错误上报不能影响主流程 */ }` | research 阶段的错误上报失败被吞 |
| `src/utils/request.ts:45-49` | `catch { // 无法解析响应体 }` | 保留原始 HTTP 文案，可接受；**但同文件 `:105-115` 的 `upload()` 完全不进错误处理/重试/`response.ok` 校验**，是本文件更该修的点 |
| `src/views/account/AccountManagement.vue:507-510 / 523-526 / 546-548` | `catch + console.warn` | 个人中心资源拉取失败 → `accountFeedItems.value = []`，用户看到空列表且不知为何 |
| `src/views/video-editor/VideoProjectList.vue:117-119` | `catch { // 用户取消 }` | 合理（用户取消文件选择） |

---

## 4. 边界与并发缺口（对应问题 4）

| # | 类型 | 位置 | 证据 / 影响 |
|---|---|---|---|
| B1 | **未校验入参**：prompt / type / referenceImages 全不校验 | `server/generation-tasks/task-lifecycle-service.ts:122-142`（`buildInitialRecordPayload` 一律 `String(x \|\| '').trim()`） | 空 prompt 也能建任务并进入执行链；`payload.type` 直接透传，非法值要到 `execution-strategies.ts:404-410` 抛 `Error('未找到对应的生成任务执行策略')` 才变成 500 |
| B2 | **未校验入参**：`readJsonBody` 无异常包装 | `server/ai-gateway/shared.ts:23` | 坏 JSON → 500 而非 400（见 S5） |
| B3 | **请求体无上限** | `server/ai-gateway/shared.ts:26-44`、`server/storage/request-handler.ts:20-23`、`server/asset-items/request-handler.ts:52-60`、`server/ai-gateway/forward.ts:60` | 校验全部发生在内存已分配之后（见 S4） |
| B4 | **未处理空数组**：`ids` 允许为空、`action` 不做白名单前置校验 | `server/asset-items/shared.ts:100-108`、`server/asset-items/service.ts:552-553`（`default: throw new Error('不支持的资源动作')` 走 500） | `ids: []` → `updateMany` 匹配 0 条，静默返回 `affectedCount: 0`；非法 action → 500 而非 400 |
| B5 | **并发写同一状态**：非原子读-改-写 | `server/generation-tasks/runtime-store.ts:95-117` | 见 S3，流式事件并发追加互相覆盖 |
| B6 | **并发写同一状态（跨调用 `refunded` 标志）** | `server/ai-gateway/request-handler.ts:110`（`try { … }` 前后同一个 `let refunded`） | 进程内标志在异常后仍为 true（见 S1） |
| B7 | **锁/降级 fail-open**：Redis 不可用时并发限流与锁静默失效 | `server/redis/lock.ts:15-35`（`!isRedisEnabled()` 或 `client===null` 返回 `null`）、`server/generation-tasks/task-runtime-governor.ts:157-163`（拿不到锁 → `task_execution_skipped_by_lock` 直接**跳过执行**）、`server/redis/concurrency.ts:12-30`（redis 关闭 → `acquired: true`） | 两个后果方向相反：锁**获取失败**=任务被静默跳过（用户看到任务不跑），并发槽**获取"成功"**=限流形同不存在。阈值类 `REDIS_CONFIG.taskLockTtlMs` 已被测试保护（`tests/redis-config.test.ts`），但"Redis 抖动时的行为"无任何测试 |
| B8 | **定时器/订阅清理** | 已核实**良好**，唯二例外见 S13、S14 | `server/generation-tasks/task-stream-subscription.ts:145-155` 与 `task-runtime-governor.ts:227-235` 都有 `clearInterval/clearTimeout` + `res.on('close'/'error', cleanup)`、`finally`；`src/views/generate/generate.vue:3020-3036` 在 `onUnmounted` 里 abort 所有 `taskStreamControllers`；`ImageNode.vue:412-414`、`RouteProgressBar.vue:87`、`LoginModal.vue:523` 均正确清理 |
| B9 | **事件监听未移除** | `src/views/publish/PublishCenter.vue:612-620` | 见 S13；全仓 `addEventListener` 66 处 vs `removeEventListener` 70 处，除该处与模块级单例外均已配对 |

---

## 5. 前端健壮性（对应问题 5）

| 项 | 当前实际情况 | 缺口 |
|---|---|---|
| **全局错误边界** | **无**。`rg -c "app.config.errorHandler" src` → 0；`rg -c "onErrorCaptured" src` → 0；`src/App.vue`（62 行）通读无任何兜底，只有 `ElConfigProvider` + `router-view` | 任一组件 `setup`/渲染抛错会整棵树卸载 → 白屏，且无上报、无 reload 引导。`src/main.ts` 只有 `createApp→use(router)→mount`，无 `errorHandler` 注册 |
| **`unhandledrejection` 上报** | **无**。`rg -c "unhandledrejection" src server` → 前端 0 命中；服务端**有**兜底：`server/index.ts:623-628`（`process.on('unhandledRejection')` + `uncaughtException`，只记日志不退出） | 前端所有 fire-and-forget 的 `void promise` 拒绝、`defineAsyncComponent` 动态 import 失败、`fetch` 未 catch 的 Promise 全部静默。`src/App.vue:28-29` 等 **14 处 `defineAsyncComponent(` 均无 `errorComponent` / `loadingComponent` / `timeout`**（`rg -n "errorComponent\|loadingComponent" src` → 空），chunk 拉取失败即空白区域且不重试 |
| **统一重试** | **部分**：存在**两套并行请求层**，主层无重试 | ① `src/utils/request.ts`（116 行）自带 `ErrorHandler.retry` + 指数退避 `[1000,2000,4000]`，但**只有 3 个模块 import**（`src/api/material.ts:1`、`api/publish.ts:1`、`api/account.ts:1`）。② 真正的主层 `src/api/request.ts`(104 行) / `src/api/admin-request.ts`(97 行) / `src/api/generation-tasks.ts`(244 行) 等 **25 个文件、约 60 处裸 `fetch(`** 完全不走 `utils/request`，失败只经 `readApiErrorMessage` 变成 `throw new Error(msg)`。**唯一有完整重试的是 SSE**：`src/api/generation-tasks.ts:136`（`RETRY_DELAYS_MS = [1000,2000,5000,10000,30000]`）+ `:158-160` watchdog + `:219-221` 清理，实现质量高 |
| **统一超时** | **主链路口径上无** | `rg -c "AbortSignal.timeout" src server` 全仓仅 **1 处**（`server/research/model-runner.ts`）。`src/api/*` 的 fetch 全部没有超时；`src/utils/request.ts:33-38` 也没有（`RequestOptions` 无 `timeout` 字段）。全仓 `timeout` 只出现在：SSE watchdog 30s（`generation-tasks.ts:135`）、`reference-validation.ts:98` 的 4000ms、`workflow-execution-helpers.ts:37` 的 `EXECUTION_TIMEOUT_MS` | 后端挂起（未响应也未断开）时前端请求会一直挂着，无 `AbortController`/`AbortSignal.timeout` 兜底 |
| **重试逻辑本身的缺陷** | `src/utils/request.ts:60-64` 与 `src/utils/errorHandler.ts:34-79, 84-130` 组合有放大风险 | `classifyError` **每次**都返回 `retryCount: 0`（`:44`），而 `request.ts:62` 的判据是 `context.retryCount === 0` —— 该条件恒为真；`makeRequest` 的 catch 里再次调用 `ErrorHandler.retry(() => makeRequest(), context)`，形成**递归嵌套重试**（`retry` 内部 3 次 × 每层再递归），面对持续 5xx/超时会成倍放大请求量而非"最多 3 次"。**一句话修法**：把 `retryCount` 提到闭包外或直接在 `request()` 层循环重试，不要在 `makeRequest` 内部递归 |
| **错误上报 SDK** | **无** | `package.json` 有 `tianji-client-sdk` 但 `rg -rn "tianji" src server` → **0 命中**（依赖被装了但从未使用）；无 Sentry/OTel。错误只进 `console.*`（前端）与 `writeScopedLog`（服务端） |

补充：`src/utils/errorHandler.ts:100-126` 的 `retry()` 里用 `ElNotification` 展示"第 N 次重试中…"，属于**副作用写在纯工具层**，脱离 Vue 组件上下文时会有连带风险（`src/main.ts` 的 `Promise.allSettled([...])` 之后的请求若重试，通知会在无 UI 上下文时触发）。

---

## 6. 性能粗测（对应问题 6）

### 6.1 构建产物：体积前 10 大的 chunk

取自 `npm run build:client` 原始输出（`vite build` 的 `kB │ gzip` 表），按体积降序：

| # | chunk | 原始 | gzip | >500KB |
|---|---|---|---|---|
| 1 | `vendor-DbfcoAFj.js` | **2,013.13 kB** | 559.73 kB | ⚠️ 是 |
| 2 | `element-plus-D42V3TQn.js` | **769.99 kB** | 235.29 kB | ⚠️ 是 |
| 3 | `VideoEditorPage-remrhyp2.js` | **555.55 kB** | 148.37 kB | ⚠️ 是 |
| 4 | `index-C8T6AkPX.css` | 335.05 kB | — | 否（但 CSS 全场最大） |
| 5 | `generate-Bbc_eVvE.js` | 257.52 kB | 116.01 kB | 否 |
| 6 | `vue-flow-CajgnPKE.js` | 210.96 kB | 67.32 kB | 否 |
| 7 | `index-DfN8DN1w.js` | 165.01 kB | 52.46 kB | 否 |
| 8 | `ContentGenerator.vue_…-C4PNjhV1.js` | 147.86 kB | 37.17 kB | 否 |
| 9 | `element-plus-CvNlyKQx.css` | 146.70 kB | — | 否 |
| 10 | `generate-CclIsMba.css` | 135.59 kB | — | 否 |

（第 11 位起：`index-C7Q8U7Og.css` 107.31 kB、`vue-BEw-0YeE.js` 85.42 kB、`AdminProviders` 68.09 kB、`AdminMarketing` 64.95 kB。）
**超 500KB 的包共 3 个**（JS）；构建器自身也给了警告：
```
(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
- Use build.rollupOptions.output.manualChunks to improve chunking …
```
`dist/assets` 合计 **30 MB**，其中单文件 **`ort-wasm-simd-threaded.jsep-B0T3yYHD.wasm` = 21,596.02 kB（21.6 MB）**，来自 `@huggingface/transformers`（`package.json` 直接依赖），占产物 72%。

### 6.2 可拆分的点

现有配置 `vite.config.ts:159-190` 已按依赖拆了 4 个桶（`@vue-flow`、`@element-plus/icons-vue`、`element-plus`、`vue-router`、`vue`），其余 `node_modules` **全部落进 `vendor`**（`:187 return 'vendor'`）：

1. **`vendor` 是最大问题**：2003 kB 里混着 React 19 + react-dom（`:165` 注释明写"React 相关依赖统一进 vendor"）、`radix-ui`/`lucide-react`/`react-markdown`/`zustand`/`sonner`（`src-cutia` 用）、`wavesurfer.js`、`mediabunny`、`@huggingface/transformers`、`@aws-sdk/client-s3`、`ioredis`、`motion`。**建议**：按"只有 cutia 编辑器才用"（React 全家桶、radix、wavesurfer、mediabunny）与"主站才用"再切两桶，cutia 桶只在进入编辑器路由时加载。
2. **`element-plus` 769.99 kB + `element-plus-*.css` 146.70 kB**：已单独成 chunk，但**没有按需裁剪**——`package.json` 同时装了 `unplugin-vue-components`（用于自动按需注册）、`@element-plus/icons-vue` 与完整 `element-plus`。可核查 `components.d.ts`（10,172 字节）里实际注册的组件数，若远小于全量则说明有组件被静态 import 进了主包。
3. **`ort-wasm-*.wasm` 21.6 MB**：这是 `@huggingface/transformers` 的推理运行时。若该能力只在"局部重绘/抠图"等少数功能使用，应改为**运行时按需 `import()` + 从 CDN/独立静态目录加载**，不要进 `dist/assets` 主产物（当前它会让每次镜像构建与部署都搬运 21.6 MB 的不可缓存静态资源）。
4. **`VideoEditorPage` 555.55 kB**：已是路由级懒加载 chunk，但它聚合了视频编辑器 + `mediabunny` + `wavesurfer` 的整块逻辑，可把"时间轴/波形/导出"三块再拆。
5. **CSS 单文件 335 kB（`index-C8T6AkPX.css`）**：`src/styles/styles.css` 通过 `@import` 引入的 Tailwind v4 全局样式表（见 `src/main.ts:2-5` 注释），全站共享，未按路由切分。

---

## 7. 最小补测清单（先补哪 10 个）

排序原则：**纯函数/纯状态机靠前**（无需 DB/Redis 就能跑，与现有 `tests/*.test.ts` 的 `npx tsx` 模式完全兼容），**涉及钱的靠前**。

| 序 | 目标文件:函数 | 类型 | 为什么值得先补 | 最少用例数 |
|---|---|---|---|---|
| 1 | `server/generation-tasks/task-lifecycle-service.ts:122` `buildInitialRecordPayload` | 纯函数 | 所有生成任务的记录初始态由它决定，`research`/`skill` 两条改写分支（`:125-127`）无验证；输入 `prompt/type/referenceImages` 缺字段时是 `''`/`[]` 而非报错，需要钉住 | 6 |
| 2 | `server/redis/idempotency.ts:46` `buildTaskSubmissionIdempotencyKey` | 纯函数 | 幂等 key 的碰撞面直接等于"会不会重复扣点"。必须钉：字段顺序无关（`:53-64` 固定顺序 JSON）、`referenceImages` 顺序敏感、空值归一（`String(x\|'').trim()`） | 8 |
| 3 | `server/research/state-machine.ts:23,27` `isResearchTerminalStage` / `getResearchNextStage` | 纯函数（38 行） | 全仓最小的纯状态机，`indexOf` 越界 → `'completed'` 的兜底（`:33-35`）与 `terminal` 自反（`:28-30`）都该钉死；research 有 6,000+ 行代码却全靠这 15 个阶段名 | 7 |
| 4 | `server/generation-tasks/task-event-replay.ts:25` `allocateEventId` + `:35` `recordReplayEvent` + `:66` `getReplayEventsAfter` | 纯逻辑（本地 Map，无 Redis 分支可测） | 事件 id 单调性、`REPLAY_CAP=100` 截断（`:52-54`）、`lastEventId` 过滤（`:73-79`）是断线续传正确性的全部依据 | 9 |
| 5 | `src/shared/generation-error.ts:149` `normalizeGenerationErrorMessage` | 纯函数 | 前端所有失败文案的出口，决定用户看到"生成失败"还是上游原始报错；纯字符串处理，零依赖 | 8 |
| 6 | `src/utils/errorHandler.ts:34` `ErrorHandler.classifyError` | 静态纯函数 | 决定"能不能重试"和"要不要拉登录框"。现有 `src/utils/request.ts:62` 的重试放大风险（§5）正是靠它；顺手把 `canRetry` 的分类矩阵钉住 | 10 |
| 7 | `src/config/models.ts:301,306` `resolveRequestModelKey` / `resolveRequestProviderId` | 纯函数 | 提交前厂商/模型解析的唯一入口，`src/api/generation-tasks.ts:57-71` 靠它抛"未匹配到后台模型配置"；别名→规范 key 的映射必须钉 | 8 |
| 8 | `server/generation-tasks/local-runtime.ts:45,50,68,95` | 纯逻辑（Map 操作） | SSE 订阅者上限（`:45-48`）、加入/移除（`:50-86`）、慢订阅者剔除（`:108-125`）全是内存 Map 语义，**无需 Redis**；`userStreamSubscribers` 泄漏与否就靠这几行 | 10 |
| 9 | `server/generation-tasks/execution-strategies.ts:404` `getGenerationTaskExecutionStrategy` + 4 个策略的 `resolveFailureMessage` | 纯函数 + 分支表 | 非法 strategyKey 应抛错（`:406-408`）；4 条失败文案分支决定前端提示，可与 #2 共用 fixture | 7 |
| 10 | `server/redis/concurrency.ts:12` `acquireConcurrencySlot` / `:57` `releaseConcurrencySlot` | 纯逻辑（`isRedisEnabled()=false` 分支） | 现有 `tests/redis-config.test.ts` 已证明"无 Redis 时也能单测"；必须钉死 **Redis 关闭时 `acquired: true`（fail-open）** 这一行为，它是当前设计的隐含前提 | 6 |

**合计约 79 条新断言**，全部可复用现有 `npx tsx` + 内联 `check()` 模式，**不需要引入测试框架、不需要 DB/Redis**。

**紧随其后的第 11-14 条**（需要轻量 stub，但价值高）：
`server/redis/lock.ts` 的 `renewRedisLock` 五分支（`renewed/redis_disabled/client_unavailable/ownership_lost/redis_error`，`:11-13` 已把 reason 定义成可断言枚举）；
`src/utils/sse.ts` 的 `parseSseChunk`（需先 `export`，`:9-41` 的 `event:`/`id:`/多行 `data:`/注释行/空块）；
`src/api/generation-tasks.ts` 的退避序列与 `ALLOWED_STREAM_EVENT_TYPES` 白名单（`:124-134`，常量可直接断言）；
`server/generation-tasks/task-runtime-governor.ts` 的 `renewIntervalMs = Math.max(5000, ttl/3)`（`:175`）。

---

## 8. 未能确认

| 事项 | 原因 |
|---|---|
| 退点失败在生产上实际造成过多少资损 | 需查线上 `REFUND` 账本与 `[ai-gateway][refund-error]` 日志（`server/ai-gateway/request-handler.ts:111`），仓库内无数据库可查；审计仅能确认"失败被吞且不重试"的代码事实 |
| `ort-wasm-simd-threaded.jsep` 21.6 MB 是否被线上真正加载 | 需浏览器实测"局部重绘/抠图"路径的网络面板；本轮只做静态构建产物核对，**未启动应用** |
| `element-plus` 769.99 kB 中可裁剪的比例 | 需逐组件核对 `components.d.ts`（10,172 字节）与 `src/**/*.vue` 的实际使用面，本轮未做全量组件使用统计 |
| `src/utils/request.ts` 重试递归的真实请求放大倍数 | 需要 mock `fetch` 连续抛 5xx 实测计数；本轮仅做代码路径推演（`request.ts:33-70` + `errorHandler.ts:84-130`），**未构造实验**，故未给出具体倍数 |
| 前端是否有 `Sentry`/`OTel` 等**外部注入**的上报脚本 | `index.html` 只有 686 字节、无第三方脚本；但 `server/index.ts:116-125` 会注入运行时配置脚本，生产环境是否另有注入未能确认（无生产环境访问权限） |
| `tests/e2e/` 12 个脚本的实际通过率 | 需要跑起来的应用 + Playwright + MariaDB，且脚本硬编码本机绝对路径；本轮**未运行**（只读审计，且会写测试夹具到库） |
| `src-cutia/`（48,445 行）的测试覆盖 | 整个目录零测试，本轮未逐模块清点，只确认了 `audio-manager.ts:262` 这处空 catch |

---

## 附：证据复现命令

```bash
# 命令实测
npm run type-check      # EXIT=0, 8.9s
npm run test:unit       # EXIT=0, 19 文件 / 547 断言 / 0 失败, 6.4s
npm run build:client    # EXIT=0, 5192 modules, 33.4s

# 测试盘点
rg --files tests -g '*.ts' | wc -l                                   # 19
rg -n "from '\.\./server" tests/*.test.ts                            # 仅 2 个文件引用 server
awk '/^>>> /{f=$2} /通过 [0-9]+ \/ 失败/{print f, $0}' /tmp/cm-testunit.log   # 逐文件断言数

# 吞异常
rg -U --multiline-dotall -n --glob '!node_modules' --glob '*.{ts,vue}' \
  -e 'catch\s*(\([^)]*\))?\s*\{\s*(console\.(log|warn|error|debug)\([^;{]*\);?\s*|//[^\n]*\n\s*|/\*.*?\*/\s*)*\}' server
rg -nE 'catch\s*(\([^)]*\))?\s*\{\s*\}' . --exclude-dir=node_modules --exclude-dir=dist

# 前端健壮性缺口
rg -c "app.config.errorHandler|onErrorCaptured|unhandledrejection" src   # 0 / 0 / 0
rg -c "AbortSignal.timeout" src server                                   # 仅 1 处
rg -c "defineAsyncComponent" src -g '*.vue' -g '*.ts'                    # 14 处，无 errorComponent

# 清理/并发
rg -c "addEventListener" src -g '*.vue' -g '*.ts' | awk -F: '{s+=$2} END{print s}'       # 66
rg -c "removeEventListener" src -g '*.vue' -g '*.ts' | awk -F: '{s+=$2} END{print s}'    # 70
rg -n "onMounted|onUnmounted|onBeforeUnmount" src/views/publish/PublishCenter.vue        # 只有 2 个 onMounted

# 性能
grep -E "kB │ gzip" /tmp/cm-build.log | sort -t│ -k2 -rn | head -12
```

**仓库改动核对**：`git status --porcelain` → 只有 `?? docs/audit-round2/`（本次审计产物目录，另一份报告已存在）；`git diff --stat` → 空。
