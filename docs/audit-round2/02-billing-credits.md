# 计费 / 积分 / 原子扣减 / 支付 专项审计（第二轮）

> 审计范围：`/Users/mima1234/CanvasMind` @ `3345920`（main，工作区干净）
> 审计方式：只读。未修改任何代码。所有结论均附文件路径 + 行号或命令原始输出。
> 审计日期：2026-09-23

---

## 0. 前置纠正：任务背景中的一条「已确认事实」与代码不符

任务背景写「**服务端目前没有按用户扣积分的实现**（检索 power/deduct/consume/balance 只命中营销与 research）」。

**该结论不成立。** 按用户扣积分的完整实现**存在于 `server/marketing-center/`**（这正是被检索判定为「无关」的那个模块），并且在 `server/generation-tasks/` 与 `server/ai-gateway/` 两条链路上被真实调用。证据：

```
$ grep -rn "export const consumeGenerationPoints\|export const refundGenerationPoints" server
server/marketing-center/service.ts:307:export const consumeGenerationPoints = async (input: {
server/marketing-center/service.ts:367:export const refundGenerationPoints = async (input: {

$ grep -rn "consumeGenerationPoints" server
server/ai-gateway/request-handler.ts:10:import { consumeGenerationPoints, refundGenerationPoints, resolveGenerationPointCost } from '../marketing-center/service'
server/ai-gateway/request-handler.ts:79   (multipart 路径扣点)
server/ai-gateway/request-handler.ts:196  (json 路径扣点)
server/generation-tasks/task-lifecycle-service.ts:238   (agent-chat 扣点)
server/generation-tasks/task-lifecycle-service.ts:318   (agent-workspace 扣点)
server/generation-tasks/task-lifecycle-service.ts:406   (image 扣点)
server/generation-tasks/service.ts:8
```

时间线证据（该实现在「无扣费实现」结论之前就已存在）：

```
$ git log -S "consumeGenerationPoints" --oneline
af205af feat(canvas): 画布交互与参数体系重构，对齐 LibTV

$ git merge-base --is-ancestor af205af b570535 && echo "af205af IS ancestor of b570535"
af205af IS ancestor of b570535     # b570535 = docs: 成本归属与计费口径决策（该文档正文声称"我们没有本地积分流水表"）
```

`docs/billing-and-cost-policy.md` 第一节表格中「我们服务端没有『按用户扣积分』的实现」「我们没有本地积分流水表」两行均与代码不符；`prisma/schema.prisma:970` 存在 `model PointAccountLog`，账本表已落库。

**同时确认背景中正确的两条**：界面上「1020」是上游账户余额（非本地账本）；资产由服务端在任务终态落库。

**本报告以代码为准。** 下述「现状」列一律基于实测代码，不采信该背景结论。

---

## 1. 结论摘要表

| # | 能力 | 现状（实测） | 是否可上线 | 证据 |
|---|---|---|---|---|
| 1 | 用户积分账本（流水表） | **已有**。`point_account_logs`，含 `change_type/action/change_amount/balance_after/available_amount/source_type/association_no/meta_json` | ✅ 表结构可用 | `prisma/schema.prisma:970`；DDL `prisma/migrations/202604280003_marketing_center_init/migration.sql:201-227` |
| 2 | 余额字段 | **没有**。余额由「最后一条流水」推导，非独立列 | ⚠️ 可上线但有隐患 | `server/marketing-center/service.ts:172-180`、`server/admin-users/service.ts:214-225` |
| 3 | 行锁原子扣减 | **已有**，但只覆盖 2/6 条写账本路径 | ❌ 不完整 | `server/marketing-center/service.ts:184-188`（`SELECT id FROM app_users WHERE id=? FOR UPDATE`），仅被 `:325`(扣) 与 `:385`(退) 调用 |
| 4 | 生成前预扣积分 | **已有**，三条链路：image / agent-chat / agent-workspace | ✅（但见 #12） | `server/generation-tasks/task-lifecycle-service.ts:238,318,406` |
| 5 | 失败/停止自动退款 | **已有**，策略层统一收口 | ⚠️ 覆盖不完整 | `server/generation-tasks/service.ts:407-427`；`server/generation-tasks/execution-strategies.ts:83,117,165,196,245,275,323,354` |
| 6 | 退款幂等（DB 层） | **没有**。`refundGenerationPoints` 本身不检查已存在退款；账本无唯一约束 | ❌ 可重复退款 | `server/marketing-center/service.ts:367-400`；`prisma/schema.prisma:970-1002`（仅 `account_no` 唯一） |
| 7 | 提交幂等（防重复点击） | **已有**（Redis `SET NX EX` + Lua CAS，TTL 600s） | ⚠️ Redis 不可用即静默失效 | `server/redis/idempotency.ts:69-114`；TTL `server/redis/config.ts`(`DEFAULT_TASK_IDEMPOTENCY_TTL_SECONDS = 10*60`) |
| 8 | SSE 重连重复扣费 | **不存在**。`/{id}/events` 只读、不扣费 | ✅ | `server/generation-tasks/request-handler.ts:83-95` |
| 9 | 支付网关对接（下单/回调/验签） | **完全未实现**。全仓库 0 命中 | ❌ 阻断 | `grep -rni "notify\|callback\|webhook\|signature\|hmac" server` → 无输出 |
| 10 | 充值/会员「下单」接口 | **已有，但直充直开**：接口直接把订单置 `PAID` 并立即入账，**无任何支付** | ❌ **最严重** | `server/marketing-center/service.ts:910-962`(`payChannel:'MANUAL', payStatus:'PAID'`)、`:833-905`(`status:'PAID'` + 立即开通)；路由 `server/marketing-center/constants.ts:17`、`request-handler.ts:67-73` |
| 11 | 限流 / 并发护栏 | **已有**（提交 6 次/分；用户并发 3、厂商 8、技能 4） | ⚠️ Redis 降级即失效 | `server/generation-tasks/request-handler.ts:43-57`；`server/redis/concurrency.ts:16-62`；`server/redis/config.ts` 默认值 |
| 12 | 日限额 / 支出上限 | **没有** | ❌ 阻断 | `grep -rni "dailyLimit\|quota" server` → 仅命中上游错误文案映射 |
| 13 | 异常告警 | **没有** | ❌ | `grep -rni "alert\|告警\|webhook" server` → 无输出；`server/redis/metrics.ts` 只有缓存指标 |
| 14 | 三方对账（上游 ↔ 交付 ↔ 扣减） | **部分的**：扣减↔交付已连（`metaJson.generationRecordId`）；上游↔扣减**未连** | ❌ 不完整 | `server/marketing-center/service.ts:402-460`；`server/ai-gateway/request-handler.ts:88,204`（网关扣费不带 recordId） |
| 15 | 卡密兑换 | **已有**，且有唯一约束防重复兑换 | ✅ | `server/marketing-center/service.ts:969-1068`；`prisma/schema.prisma` `CardRedeemRecord` 的 `@@unique([cardCodeId])` |

**总体判定：不可上线。** 阻断项是 #10（无支付即发积分/会员，任意登录用户可无限铸币）、#12（无支出上限）、#13（无告警），以及 #3/#6 的原子性缺口。

---

## 2. 逐条回答

### Q1 原子扣减：可用基础与缺失项

#### 2.1.1 已具备的工具（可复用的原子原语）

| 工具 | 位置 | 能力 |
|---|---|---|
| Prisma 交互式事务 | `server/marketing-center/service.ts:323,383,642,656,777,834,911,970`（全仓 `$transaction` 共 33 处） | 多写入原子提交 |
| **DB 行锁** | `server/marketing-center/service.ts:184-188` | `SELECT id FROM app_users WHERE id = ${userId} FOR UPDATE`，串行化同一用户的账本写入 |
| Redis 分布式锁 | `server/redis/lock.ts:15,38,62` | `acquireRedisLock / renewRedisLock / releaseRedisLock`（任务执行锁，TTL 5 分钟） |
| Redis Lua 原子计数 | `server/redis/concurrency.ts:16-62,132` | 用户/技能/厂商并发槽位，`INCR + EXPIRE` 单脚本 |
| Redis 幂等 | `server/redis/idempotency.ts:69-114,122-160,163-` | `SET NX EX` 抢占 + Lua 比对 token 的 CAS 完成/清理 |
| Redis 限流 | `server/redis/rate-limit.ts:16-72` | 固定窗口，Lua `INCR + EXPIRE + TTL` |

结论：**做「用户积分原子扣减」的工具是齐的**，且已有一套可用的实现形态（预扣 + 行锁 + 失败退款）。

#### 2.1.2 当前缺少什么

1. **无余额字段**。`AppUser` 无 `balance`/`points` 列（`prisma/schema.prisma:16-70`）。余额靠 `readCurrentPointBalance()` 取「最后一条流水的 `balance_after`」推导：

   ```ts
   // server/marketing-center/service.ts:172-180
   const readCurrentPointBalance = async (userId: string, tx: ... = prisma) => {
     const latestLog = await tx.pointAccountLog.findFirst({
       where: { userId },
       orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
     })
     return latestLog?.balanceAfter || 0
   }
   ```

   风险：`created_at` 是 `DATETIME(3)`（毫秒精度，`migration.sql:219`），同毫秒内两条流水时用 `id` 兜底排序，而 `id` 是 cuid **不保证单调**，可能取错「最后一条」→ 读出错余额 → 多扣或少扣。

2. **无 DB 级扣减幂等键**。`point_account_logs` 只有 `UNIQUE(account_no)`，`sourceType/sourceId` 是普通索引（`prisma/schema.prisma:970-1002`）。因此**同一个 `associationNo` 被扣两次是允许的**，DB 不会拦。

3. **`associationNo` 是随机生成的，不是幂等键**：

   ```ts
   // server/ai-gateway/request-handler.ts:22-24
   const buildGatewayAssociationNo = () => `GWY${Date.now()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`
   ```

   每次请求都新生成 → 重试 = 新单号 = 新扣费（见 Q2）。

4. **行锁覆盖不全**。`lockUserBillingRow` 只在 2 处被调用：

   ```
   $ grep -rn "lockUserBillingRow" server
   server/marketing-center/service.ts:186  (定义)
   server/marketing-center/service.ts:325  (consumeGenerationPoints)
   server/marketing-center/service.ts:385  (refundGenerationPoints)
   ```

   以下**同样写账本**的路径**没有**加行锁：充值入账（`:910`，`:944` 调 `appendPointLog`）、卡密兑换（`:969`）、签到奖励（`:776`）、会员赠送积分（`:878` → `activateMembership:482`）、以及**管理员调账**（`server/admin-users/service.ts:1037-1058` → `appendAdminPointLog:227-265`，其内部 `readCurrentPointBalance` 未加锁）。这些路径与用户扣费并发时会读到相同 `balanceAfter`，产生错账（`server/marketing-center/service.ts:184-186` 的注释正说明作者已识别该问题，但只修了两条路径）。

5. **无冻结/可用额度模型**。「预扣」是把全额直接 `DECREASE` 落账，`available_amount` 被恒等于 `balance_after`（`server/marketing-center/service.ts:213-228`），无法表达「已冻结待结算」。

6. **流水号非碰撞安全**。`buildSerialNo` 用 `时间戳(毫秒) + Math.random().toString(36).slice(2,8)`（`server/marketing-center/service.ts:18-33`），碰撞会撞 `UNIQUE(account_no)` 直接抛错。

7. **无余额非负的 DB 约束**。负数只在应用层校验（`server/admin-users/service.ts:253-256`）。

---

### Q2 重复扣费风险（逐条给位置）

| # | 路径 | 是否重复扣费 | 代码位置 |
|---|---|---|---|
| R1 | **网关链路无幂等** | **会**。`/api/ai/request` 每次调用新生成 `associationNo`，无任何幂等键；客户端重试 = 再扣一次 | `server/ai-gateway/request-handler.ts:22-24,79-91,196-206` |
| R2 | **两个独立扣费域并存** | **当前不触发，但结构上是隐患**。网关按 `isChargeableGenerationRequest`(image/video) 扣费（`:14-21`），任务链路另按 image/chat 扣费（`task-lifecycle-service.ts:238,318,406`），两套单号空间互不感知 | `server/ai-gateway/request-handler.ts:14-21` vs `server/generation-tasks/task-lifecycle-service.ts:238,318,406` |
| R3 | **前端重复点击** | **10 分钟内已被拦**（同 payload 命中幂等键，直接返回旧记录，不扣费）；**Redis 不可用则失效** | 拦截：`server/generation-tasks/task-lifecycle-service.ts:210-216`；失效：`server/redis/idempotency.ts:76-86`（`if (!isRedisEnabled()) return { state:'acquired' }`） |
| R4 | **提交中途失败 → 重试** | **会**。扣费在自己的事务里已提交，其后 `createGenerationRecord`(254) / `attachGenerationPointRecordId`(255) / `completeIdempotencyKey`(260) / `syncSharedTaskRuntime` 都在事务外；`catch` 只释放并发槽 + 清 pending 幂等键，**不退款** | `server/generation-tasks/task-lifecycle-service.ts:238`(扣费) → `:254`(建记录) → `:255,260`；`catch` 在 `:468-474` |
| R5 | **SSE 重连** | **不会**。`GET /{id}/events` 只读 | `server/generation-tasks/request-handler.ts:83-95` |
| R6 | **客户端本地判死 + 重试** | **视 payload 是否相同**：相同 → 幂等键拦住（不扣费，但**也不会重跑**）；不同（如提示词被编辑）→ 新键 → 新扣费，且此时服务端旧任务可能仍在上游跑 → 两次上游成本 | `src/views/workflow/components/nodes/ImageNode.vue:704-772`（本地 failRun）、`:785-810`（`retryLastRun`）、`:629-690`（`runGeneration` 重新 POST） |
| R7 | **任务重跑（execution lock 失效）** | **不会重复扣费**，但会重复调用上游。扣费只在提交阶段发生一次（`task-lifecycle-service.ts:238/318/406`），执行阶段重跑不扣费 | `server/generation-tasks/service.ts` `runTaskWithExecutionLock` + `:428-447` |
| R8 | **网关「上游 200 但没内容」** | **会扣费不退款**。退款只在 `!upstreamResponse.ok` 或 `fetch` 抛错时触发 | 退款触发点：`server/ai-gateway/request-handler.ts:130,139,218`；`forward.ts:71` |

补充：`retryLastRun`（`ImageNode.vue:785`）用**任务记录里的原文**重发，payload 与首次完全一致 → 10 分钟 TTL 内命中的是「已完成」的旧键，服务端返回旧记录而**不新建任务**。所以「重试」在该窗口内是**静默无效**的（既不重跑也不多扣）。这既是重复扣费的安全边界，也是一个真实的功能缺陷。

---

### Q3 失败与退款：现状与缺口

**已有回滚逻辑（不是零）**：

| 场景 | 行为 | 位置 |
|---|---|---|
| 任务失败（image / agent-chat / agent-workspace / research） | `refundTaskPointsIfNeeded(task,'task_failed')` 全额退 | `server/generation-tasks/execution-strategies.ts:117,196,275,354`；实现 `server/generation-tasks/service.ts:407-427` |
| 用户停止 | `refundTaskPointsIfNeeded(task,'task_aborted')` 全额退 | `execution-strategies.ts:83,165,245,323`；`agent-workspace-task-executor.ts:535,546` |
| 网关上游非 2xx / fetch 失败 | 退款 | `server/ai-gateway/request-handler.ts:130,139,218` |
| 管理员人工补偿 | 扫描「已扣未退且任务为 FAILED/STOPPED」并退款，已退的跳过 | `server/admin-marketing/service.ts:585-660`(候选)、`:741-820`(执行) |

**缺口**：

1. **退款非幂等（可双退）**。`refundGenerationPoints` 自身不检查是否已存在同 `associationNo` 的 REFUND（`server/marketing-center/service.ts:367-400`），DB 也没有 `UNIQUE(source_type, association_no, change_type)`。两条可双退路径：
   - 自动退款只看**内存标志** `task.refundCommitted`（`server/generation-tasks/service.ts:407-413`，`refundCommitted = true` 在 `await` **之前**赋值）→ 管理员先人工补偿、随后任务失败自动退款，两边都过 → 同一笔扣减退两次。
   - 两个管理员并发点「补偿」：`refundedAssociationNos` 在循环外一次性查出（`server/admin-marketing/service.ts:763-772`），非原子 → 都判「未退」→ 双退。

2. **进程重启丢退款**。`refundCommitted` 是任务对象上的内存字段（`server/generation-tasks/local-runtime.ts:15`）。进程崩溃/重启后任务不会重放退款；**未发现任何服务端兜底扫描**（`grep -rni "reaper\|stale\|orphan\|sweep\|reconcile\|对账" server` 仅命中注释与前端 UX 文案，无定时任务实现）。`docs/billing-and-cost-policy.md` P1 ③ 要求「定时任务把中断任务标失败并释放额度」——**该定时任务未实现**。

3. **退款失败被静默吞掉**。收口若内部抛错（含退点失败），只记日志并发一次 failed 事件（`server/generation-tasks/service.ts:458-478`），且 `refundCommitted` 已置 true → 本进程内不会再退。

4. **「上游 200 但空/错误体」不退款**（Q2-R8）。

5. **取消/超时语义不完整**：客户端 15 分钟本地兜底判死（`ImageNode.vue:617-624,722-726`）**不会取消服务端任务**；服务端若随后成功，则「客户端显示失败 + 服务端已交付 + 已扣费」三者不一致（不重复扣费，但状态对不上）。

6. **退款粒度是全额，不做按量**：按模型 `billingRule.power` 固定扣一次（`server/marketing-center/service.ts:232-245`），请求 4 张只回 1 张也退 0 或全退。

---

### Q4 支付对接：**未实现**（且存在直充漏洞）

**结论：没有任何支付/充值/订单的支付实现。**

```
$ grep -rni "notify|callback|webhook|signature|verifySign|hmac" server --include=*.ts
(无输出)
```

**但存在订单模型与状态机枚举（未被支付驱动）**：

| 组件 | 位置 |
|---|---|
| `RechargeOrder`（`orderNo` 唯一、`payChannel`、`payStatus`、`refundStatus`、`paidAt`、`refundedAt`、`packageSnapshotJson`） | `prisma/schema.prisma:867-894` |
| `MembershipOrder`（`orderNo` 唯一、`sourceType`、`status`、`totalAmount/paidAmount`、`bonusPoints`） | `prisma/schema.prisma:813-843` |
| `PayChannelType`(ALIPAY/WECHAT/MANUAL/OTHER)、`PaymentStatus`(PENDING/PAID/FAILED/CANCELED)、`RefundStatus`(NONE/PROCESSING/REFUNDED/FAILED) | `prisma/schema.prisma` 枚举区 |

**接口现状（这就是漏洞）**：

| 路由 | 行为 | 位置 |
|---|---|---|
| `POST /api/marketing/recharge-orders` | 建订单时**直接** `payChannel:'MANUAL'`、`payStatus:'PAID'`、`paidAmount: price`、`paidAt: now`，并**立即** `appendPointLog(RECHARGE, INCREASE, points+bonus)` | `server/marketing-center/constants.ts:17`；`request-handler.ts:67-73`；`service.ts:910-962` |
| `POST /api/marketing/membership-orders` | 建订单时**直接** `status:'PAID'`，并**立即** `activateMembership(...)`（含 `bonusPoints` 赠送） | `constants.ts:21`；`request-handler.ts:59-66`；`service.ts:833-905` |
| `POST /api/marketing/card-redeem` | 卡密兑换（有唯一约束保护，可接受） | `constants.ts:13`；`service.ts:969-1068` |
| `POST /api/marketing/checkin` | 每日签到发积分（有 `@@unique([userId,checkinDate])` 保护） | `service.ts:776` |

前端已直连该接口：`src/api/marketing-center.ts:111` `createMarketingRechargeOrder`、`:105` `createMarketingMembershipOrder`，由 `src/components/MarketingModal.vue` 调用。代码注释自认：

```
src/components/MarketingModal.vue:714
// 当前营销下单仍是后端直充直开，这里先复用扫码支付弹窗承接前台支付确认交互。
```

**影响**：任何登录用户（`requireCurrentSessionUser` 之后即进入分支，`request-handler.ts:36-40`）反复调用该接口即可**无限获得积分与会员**；这两条路由**没有任何限流**（`grep -n "consumeFixedWindowRateLimit" server/marketing-center/request-handler.ts` 无命中）。

**接入支付需要的最小面**：

1. **下单**：`POST /recharge-orders` 只创建 `PENDING` 订单 + 向支付渠道要预支付参数；**不得**写入任何积分流水；金额与积分由服务端按 `RechargePackage` 唯一决定，不接受客户端传价/传点数。
2. **回调**：`POST /api/payments/{channel}/notify`——**验签**（用渠道公钥/密钥校验 `sign`）、校验 `out_trade_no` 与 `total_amount` 与本地订单一致、校验 `app_id/mch_id`。
3. **幂等**：回调处理必须在同一 DB 事务内「条件更新」订单 `PENDING → PAID`（`updateMany({where:{orderNo, payStatus:'PENDING'}, data:{...}})` 判断 `count===1` 才入账），并对 `point_account_logs` 增加 `UNIQUE(source_type, association_no, change_type)`；重复回调直接返回成功不重复入账。
4. **状态机**：`PENDING → PAID | FAILED | CANCELED`；退款 `NONE → PROCESSING → REFUNDED | FAILED`（枚举已存在可直接用），且退款需反查并冲销对应入账流水。
5. **对账**：定时拉取渠道账单与本地 `recharge_orders` 比对（金额、状态、时间），差异告警。
6. **关闭直充**：上线前必须移除 `payStatus:'PAID'` 的硬编码（`service.ts:927`、`:862`）。

---

### Q5 对账能力

**能支撑的部分**（扣减 ↔ 交付）：

- 扣费流水通过 `metaJson.generationRecordId` 回写生成记录 id：`server/marketing-center/service.ts:402-460`（`attachGenerationPointRecordId`），提交时调用 `task-lifecycle-service.ts:255,345,422`。
- 管理端据此实现「补偿候选」查询：以 CONSUME 流水反查 `GenerationRecord.status`，筛 FAILED/STOPPED 且无 REFUND：`server/admin-marketing/service.ts:585-660`、`:677-720`。
- 退款流水同样带 `associationNo`，可用于「同一笔是否已退」的关联：`server/marketing-center/service.ts:389-398`。

**不能支撑的部分（缺字段/表）**：

| 缺口 | 说明 | 位置证据 |
|---|---|---|
| **上游调用 ↔ 扣减无关联** | 账本只记我们自己的 `associationNo` 与 `providerId/modelKey/endpointType`，**没有上游请求 id、没有上游计费/用量（token/张数）、没有上游单价与成本币种** | 账本 metaJson 内容：`server/marketing-center/service.ts:352-362,396-399` |
| **网关扣费无法关联交付** | 网关链路扣费的 metaJson 只有 `gatewayPath`，**不写 `generationRecordId`** → 该笔扣费在交付侧无对应物 | `server/ai-gateway/request-handler.ts:88-90,204-206` |
| **`GenerationRecord` 无上游标识** | 只有 `agentTaskId`，无 `upstreamRequestId`/`upstreamCost`/`latency` | `prisma/schema.prisma:510-541` |
| **无金额维度** | 账本只有整数积分（`change_amount/balance_after`），无金额/汇率；「钱 ↔ 积分 ↔ 上游成本」无法换算 | `migration.sql:201-227` |
| **无上游调用日志表** | 无法回答「一次上游调用是否被计费、是否交付、是否扣减」 | 全库无 `upstream_call_logs` 类模型 |
| **无对账作业** | 无日终/定时对账任务 | `grep -rni "reconcile\|对账" server` 仅注释 |

**最小补齐**：新增 `upstream_call_logs(id, providerId, modelKey, endpointType, upstreamRequestId, requestAt, costAmount, costCurrency, httpStatus, elapsedMs, generationRecordId, associationNo)`；在 `PointAccountLog.metaJson` 或新列补 `upstreamCallId`；给 `point_account_logs` 加 `UNIQUE(source_type, association_no, change_type)` 作为对账与幂等的共同锚点。

---

### Q6 额度护栏

**已有**：

| 机制 | 参数 | 位置 |
|---|---|---|
| 提交限流 | 6 次 / 60 秒 / 用户 | `server/generation-tasks/request-handler.ts:43-57`；默认值 `server/redis/config.ts`(`DEFAULT_TASK_SUBMIT_RATE_LIMIT=6`, `WINDOW=60`) |
| 用户级并发 | 3 | `server/redis/config.ts`(`DEFAULT_TASK_USER_CONCURRENCY_LIMIT=3`)，获取 `task-lifecycle-service.ts:224,304,393` |
| 厂商级并发 | 8 | 同上（`..._PROVIDER_CONCURRENCY_LIMIT=8`） |
| 技能级并发 | 4 | 同上（`..._SKILL_CONCURRENCY_LIMIT=4`） |
| 余额校验 | 不足抛 `INSUFFICIENT_POINTS` → 网关返回 **402** | `server/marketing-center/service.ts:329-340`；`server/ai-gateway/request-handler.ts:238-250` |
| 登录/验证码限流 | 10 / 5 | `server/auth/request-handler.ts:117,159` |

**缺口**：

1. **无日/月支出上限**。`grep -rni "dailyLimit|dayLimit|日限额|quota|每日上限" server src` 仅命中前端对**上游** `insufficient_quota` 的文案映射（`src/shared/generation-error.ts:140,189-193`），**没有任何用户级日限额**。单个用户被刷一天，唯一约束只有「6 次/分 × 3 并发」。
2. **所有 Redis 护栏在 Redis 不可用时静默放行**（不是失败关闭）：
   - 幂等：`server/redis/idempotency.ts:76-86` → `state:'acquired'`
   - 并发：`server/redis/concurrency.ts:16-32` → `acquired:true`
   - 限流：`server/redis/rate-limit.ts:33-43` → `allowed:true`
   且 `server/redis/config.ts` 的 `enabled` 默认在解析到 host 时即为 true（`REDIS_ENABLED || (REDIS_URL || REDIS_HOST)`，host 默认 `127.0.0.1`），配置错误时会静默进入「无护栏」状态。
3. **无异常告警**。`grep -rni "alert|告警|webhook" server` 无输出；`server/redis/metrics.ts` 只统计缓存命中。没有「单用户短时高频消耗」「退款率异常」「余额异常」类告警。
4. **营销/充值/兑换接口无任何限流**（`server/marketing-center/request-handler.ts` 无 `consumeFixedWindowRateLimit`）——与 Q4 的直充漏洞叠加即为「无限铸币」。
5. **非锁定写账本路径无并发保护**（见 Q1-4）：管理员调账、会员赠送、签到可与扣费并发错账。
6. **Redis 槽位在进程崩溃后靠 TTL 回收**（30 分钟，`DEFAULT_TASK_CONCURRENCY_TTL_SECONDS`），期间占用并发额度。

---

## 3. 原子扣减的落地方案

> 目标：在不推翻现有 `point_account_logs` 的前提下，补齐「余额列 + 扣减幂等 + 全路径行锁」，使扣减可证明原子、可证明幂等、可对账。

### 3.1 表结构最小集

**① 账本表补两处约束/列（改现有表）**

```sql
-- 1) 扣减/退款幂等锚点：同一业务单号、同一变动类型只允许一条
--    注意：需先清洗历史重复数据，否则建唯一索引会失败
ALTER TABLE point_account_logs
  ADD UNIQUE INDEX uk_point_account_logs_source_assoc_type
  (source_type, association_no, change_type);

-- 2) 上游调用关联（对账用）
ALTER TABLE point_account_logs
  ADD COLUMN upstream_call_id VARCHAR(64) NULL COMMENT '上游调用日志ID' AFTER source_id;
```

**② 用户账户表（余额与冻结分离，替代「扫最后一条流水」）**

```sql
CREATE TABLE point_accounts (
  user_id          VARCHAR(36) NOT NULL,
  balance          INT NOT NULL DEFAULT 0 COMMENT '可用余额',
  frozen           INT NOT NULL DEFAULT 0 COMMENT '冻结/预扣在途',
  version          BIGINT NOT NULL DEFAULT 0 COMMENT '乐观锁版本(可选)',
  updated_at       DATETIME(3) NOT NULL,
  PRIMARY KEY (user_id),
  CONSTRAINT ck_point_accounts_balance_nonneg CHECK (balance >= 0)
);
```

**③ 上游调用日志（三方对账的第三边）**

```sql
CREATE TABLE upstream_call_logs (
  id                 VARCHAR(36) NOT NULL,
  user_id            VARCHAR(36) NULL,
  provider_id        VARCHAR(36) NULL,
  model_key          VARCHAR(191) NULL,
  endpoint_type      VARCHAR(32) NULL,
  upstream_request_id VARCHAR(191) NULL COMMENT '上游返回的 request/task id',
  http_status        INT NULL,
  elapsed_ms         INT NULL,
  cost_amount        DECIMAL(10,4) NULL COMMENT '上游实际计费',
  cost_currency      VARCHAR(8) NULL,
  generation_record_id VARCHAR(36) NULL,
  association_no     VARCHAR(64) NULL,
  created_at         DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_upstream_call_assoc (association_no)
);
```

> 若暂时不想加 `point_accounts`，可先只加 ①（幂等索引）——但余额推导的毫秒并列问题（Q1-1）仍会存在。

### 3.2 锁的选择与理由

**用 DB 行锁（`SELECT ... FOR UPDATE`）而不是 Redis 锁**：

- 扣减与余额列必须在**同一个数据库事务**里原子提交；Redis 锁只能串行化「进入临界区」，一旦 Redis 与 DB 的一致性出问题（锁过期、Redis 重启、网络分区），就会出现「锁在但余额没写」或反之。DB 行锁的持有与事务提交是同一份权威存储，崩溃即自动释放。
- Redis 锁**保留**用于跨进程的任务执行锁与并发槽（现有 `server/redis/lock.ts`、`concurrency.ts` 已足够好），职责分离：Redis 管「同时跑几个任务」，DB 管「钱怎么记」。

**锁定对象**：仍锁 `app_users` 行（沿用现有 `lockUserBillingRow`，避免引入新锁表死锁面），或改为锁 `point_accounts` 行。**必须每个事务第一个语句就锁**，否则会与后续 `SELECT ... FOR UPDATE` 形成死锁。

### 3.3 扣减伪代码（预扣模式，与现有流程一致）

```ts
// 预扣：提交任务前，全额冻结并落 CONSUME 流水
async function consumePoints({ userId, pointCost, associationNo, bill }) {
  if (pointCost <= 0) return null
  return prisma.$transaction(async (tx) => {
    // ① 幂等先行：同单号同类型的扣减只允许一条（依赖唯一索引兜底）
    const existed = await tx.pointAccountLog.findUnique({
      where: { sourceType_associationNo_changeType:
        { sourceType: 'GENERATION_CONSUME', associationNo, changeType: 'CONSUME' } },
    })
    if (existed) return existed            // 重试直接复用，不重复扣

    // ② 行锁：同一用户串行化（必须事务内第一条写相关语句）
    await tx.$queryRaw`SELECT id FROM app_users WHERE id = ${userId} FOR UPDATE`

    // ③ 余额从账户表取（不再扫流水）
    const account = await tx.pointAccounts.findUnique({ where: { userId } })
    const balance = account?.balance ?? 0
    if (balance < pointCost) throw insufficientPoints(balance, pointCost)

    // ④ 扣减 + 落流水（同一事务）
    const next = balance - pointCost
    await tx.pointAccounts.update({ where: { userId }, data: { balance: next } })
    return tx.pointAccountLog.create({ data: {
      userId, associationNo,
      changeType: 'CONSUME', action: 'DECREASE', changeAmount: pointCost,
      balanceAfter: next, availableAmount: next,
      sourceType: 'GENERATION_CONSUME',
      metaJson: { ...bill, upstreamCallId: bill.upstreamCallId ?? null },
    }})
    // 唯一索引冲突（并发同单号）→ 事务回滚 → 上层捕获后按「已扣」处理
  }, { isolationLevel: 'ReadCommitted' })
}
```

### 3.4 回滚伪代码（结算/退款，幂等）

```ts
async function refundPoints({ userId, pointCost, associationNo, reason, generationRecordId }) {
  if (pointCost <= 0) return null
  return prisma.$transaction(async (tx) => {
    // ① 幂等：已退过就不再退（DB 唯一索引兜底，杜绝双退）
    const already = await tx.pointAccountLog.findUnique({
      where: { sourceType_associationNo_changeType:
        { sourceType: 'GENERATION_CONSUME', associationNo, changeType: 'REFUND' } },
    })
    if (already) return already

    // ② 必须存在对应的扣减流水，否则不允许凭空加钱
    const consume = await tx.pointAccountLog.findUnique({
      where: { sourceType_associationNo_changeType:
        { sourceType: 'GENERATION_CONSUME', associationNo, changeType: 'CONSUME' } },
    })
    if (!consume) throw new Error(`无对应扣减流水，拒绝退款: ${associationNo}`)

    // ③ 行锁 + 加回余额 + 落 REFUND 流水
    await tx.$queryRaw`SELECT id FROM app_users WHERE id = ${userId} FOR UPDATE`
    const account = await tx.pointAccounts.findUnique({ where: { userId } })
    const next = (account?.balance ?? 0) + pointCost
    await tx.pointAccounts.upsert({
      where: { userId }, create: { userId, balance: next }, update: { balance: next },
    })
    return tx.pointAccountLog.create({ data: {
      userId, associationNo, changeType: 'REFUND', action: 'INCREASE',
      changeAmount: pointCost, balanceAfter: next, availableAmount: next,
      sourceType: 'GENERATION_CONSUME',
      metaJson: { refundReason: reason, generationRecordId, originalConsumeLogId: consume.id },
    }})
  }, { isolationLevel: 'ReadCommitted' })
}
```

**原子性保证来自三层叠加**：① DB 事务保证「余额列 + 流水」同时生效或同时不生效；② `SELECT ... FOR UPDATE` 保证同一用户的读-改-写串行；③ `UNIQUE(source_type, association_no, change_type)` 保证即使锁失效（误用、绕过）也不可能重复扣或重复退。

### 3.5 必须同步改造的 4 处

1. **所有账本写入路径都加锁**：`server/marketing-center/service.ts:776`(签到)、`:878`(会员赠送)、`:944`(充值)、`:1020`(卡密)、`server/admin-users/service.ts:227-265`(管理员调账)。
2. **提交阶段的「扣费 → 建记录」包进同一事务**，消除 Q2-R4 的裸奔窗口（`task-lifecycle-service.ts:238-263`）。
3. **网关链路补幂等键**（客户端签名/`Idempotency-Key` 头，替代随机的 `buildGatewayAssociationNo`）并把 `generationRecordId` 写进 metaJson（`server/ai-gateway/request-handler.ts:22,88,204`）。
4. **兜底扫描任务**：失败/中断任务定时标失败并退款（补 `docs/billing-and-cost-policy.md` P1 ③）。

---

## 4. 阻塞项（按严重度）

| 级别 | 阻塞项 | 影响 | 位置 |
|---|---|---|---|
| **P0-1** | **充值/会员接口无支付即入账** —— `POST /api/marketing/recharge-orders`、`/membership-orders` 直接置 `PAID` 并立即发积分/开会员，无限流 | 任意登录用户可无限铸币、无限白嫖会员，直接资损 | `server/marketing-center/service.ts:910-962,833-905`；`request-handler.ts:59-73`；`src/components/MarketingModal.vue:714` |
| **P0-2** | **退款非幂等，可重复退款** —— 无 DB 唯一约束；自动退款只看内存标志；管理端并发补偿可双退 | 资损；且与管理端补偿叠加时同一笔可退两次 | `server/marketing-center/service.ts:367-400`；`server/generation-tasks/service.ts:407-413`；`server/admin-marketing/service.ts:763-772` |
| **P0-3** | **无任何支出上限与告警** —— 无日限额，无异常告警，Redis 降级即护栏全失效 | 被刷时无兜底、事后才知 | `grep dailyLimit/quota server` 无命中；`server/redis/idempotency.ts:76-86`、`concurrency.ts:16-32`、`rate-limit.ts:33-43` |
| **P1-1** | **扣费与建记录不同事务，catch 不退款** —— 中间任一环节抛错即「已扣无记录」，重试再扣一次 | 重复扣费 + 无据可查 | `server/generation-tasks/task-lifecycle-service.ts:238-263`、`catch :468-474` |
| **P1-2** | **6 项账本写入中有 4 项未加行锁** —— 管理员调账/签到/充值/卡密/会员赠送与扣费并发可错账 | 余额算错，多扣或少扣 | `server/admin-users/service.ts:227-265`；`server/marketing-center/service.ts:776,878,944,1020` |
| **P1-3** | **余额靠「最后一条流水」推导** —— `DATETIME(3)` 毫秒并列 + cuid 非单调，可能取错最后一条 | 余额读错 | `server/marketing-center/service.ts:172-180`；`migration.sql:219` |
| **P1-4** | **无中断任务兜底（reaper）** —— 进程重启丢 `refundCommitted`，无定时任务收口退款 | 已扣不退，永久挂账 | `server/generation-tasks/local-runtime.ts:15`；`grep reaper/stale server` 无实现 |
| **P2-1** | **网关链路无幂等且不关联交付** —— 随机单号，重试即再扣；metaJson 无 recordId | 重复扣费 + 无法对账 | `server/ai-gateway/request-handler.ts:22-24,88,204` |
| **P2-2** | **上游↔扣减无关联字段** —— 无上游请求 id / 成本 / 用量 | 三方对账不成立 | `prisma/schema.prisma:510-541,970-1002` |
| **P2-3** | **「上游 200 但无内容」不退款** | 付费无交付 | `server/ai-gateway/request-handler.ts:130,139,218` |
| **P2-4** | **重试在 10 分钟 TTL 内静默无效** —— 命中旧幂等键返回旧记录，不重跑 | 功能性缺陷（非资损） | `server/redis/idempotency.ts:99-114`；`task-lifecycle-service.ts:210-216`；`ImageNode.vue:785-810` |
| **P3-1** | **流水号非碰撞安全** —— 毫秒+6 位随机撞 `UNIQUE(account_no)` | 偶发 500 | `server/marketing-center/service.ts:18-33` |
| **P3-2** | **无计费相关测试** —— `grep -rln "consumeGenerationPoints\|pointAccountLog" tests scripts` 无命中 | 改动无回归网 | — |

---

## 5. 未能确认

1. **`billingRule.power` 在生产库的实际取值未能确认**。扣费是否真的发生，取决于后台模型配置里的 `defaultParamsJson.billingRule.power`（`server/marketing-center/service.ts:232-245`，`readModelBillingPower` 在该字段缺失时返回 `0` → `consumeGenerationPoints` 直接 `return null`，不扣费）。代码里无默认值、未 seed（`src/views/admin/providers/AdminProviders.vue:685` 表单默认 `billingPower: 0`）。**未连生产库查询，因此「当前线上是否实际在扣积分」无法确认**——这也可能是「查不到扣费实现」这一错误结论的来源。审计动作：`SELECT name, default_params_json->>'$.billingRule.power' FROM ai_provider_models;`
2. **生产环境 Redis 是否可用未能确认**。所有幂等/并发/限流护栏都是「Redis 不可用则静默放行」，而 `REDIS_ENABLED` 默认趋真（`server/redis/config.ts`）。未连生产 Redis 验证，无法确认当前线上是「有护栏」还是「护栏全部空转」。
3. **`/api/ai/request` 网关的 image/video 扣费路径线上是否被调用未能确认**。前端仅 `src/api/chat.ts`（chat，非可计费类型）与 `src/views/workflow/api/image.ts`、`api/video.ts` 引用网关，而这三者的 `generateImage` / `createVideoTask` / `pollVideoTask` 在本仓库**没有任何调用点**（`grep -rn "generateImage(\|createVideoTask(\|pollVideoTask(" src` 只命中定义处）。因此我判定它是**前端已死代码**，但它作为 HTTP 接口**仍然可达**（服务端已注册，`server/index.ts:371-374`）。是否有外部客户端/脚本在直连，未能确认（需要访问日志）。
4. **`admin-marketing` 的补偿接口是否已在后台 UI 暴露未能确认**（`server/index.ts:507-513` 已注册路由；未追查前端菜单入口）。
5. **`docs/audit-full-chain-2026-09-23.md` 是否已覆盖本报告部分结论未能确认**（本轮未逐字比对第一轮报告）。
6. **卡密批次生成接口的鉴权边界未能确认**（`server/admin-marketing/service.ts` 中批量生成卡密是否仅管理员可达，未逐行核实 `admin` 守卫的位置）。
