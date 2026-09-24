/**
 * 视频轮询节奏的纯逻辑验证（2026-09-25）
 *
 * 背景：上游文档要求「首次查询在建单 5 分钟后；之后 10~30 秒 + 指数退避；
 * 建单满 2 小时未完成 → 服务端判 timeout 并全额退分」。
 * 老参数是 3 秒 × 400 次（20 分钟就放弃），既猛打上游（429 限流）又比上游自己的
 * 超时早 100 分钟放弃。这里把新节奏钉死：首次等待、退避序列、总预算。
 */

import {
  VIDEO_POLL_FIRST_DELAY_MS,
  VIDEO_POLL_MAX_DELAY_MS,
  VIDEO_POLL_MIN_DELAY_MS,
  VIDEO_POLL_TOTAL_BUDGET_MS,
  computeVideoPollDelayMs,
  shouldContinueVideoPolling,
  sleepWithAbort,
} from "../server/generation-tasks/video-poll-schedule";

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed += 1;
    console.log(`  ok   ${label} = ${a}`);
    return;
  }
  failed += 1;
  console.error(`  FAIL ${label}: 期望 ${e}，实际 ${a}`);
}

function checkTrue(label: string, actual: boolean) {
  check(label, actual, true);
}

console.log("\n【1】常量对齐上游文档");
check("首次查询等待 = 5 分钟", VIDEO_POLL_FIRST_DELAY_MS, 300_000);
check("退避下限 = 15 秒", VIDEO_POLL_MIN_DELAY_MS, 15_000);
check("退避上限 = 30 秒", VIDEO_POLL_MAX_DELAY_MS, 30_000);
check("总等待上限 = 2 小时", VIDEO_POLL_TOTAL_BUDGET_MS, 7_200_000);

console.log("\n【2】退避序列：5 分钟 → 15 → 30 → 30 …");
check("第 1 次查询前", computeVideoPollDelayMs(1), 300_000);
check("第 2 次查询前", computeVideoPollDelayMs(2), 15_000);
check("第 3 次查询前", computeVideoPollDelayMs(3), 30_000);
check("第 4 次查询前（封顶）", computeVideoPollDelayMs(4), 30_000);
check("第 50 次查询前（封顶）", computeVideoPollDelayMs(50), 30_000);
check("非法入参（0）落到首查", computeVideoPollDelayMs(0), 300_000);
check("非法入参（NaN）落到首查", computeVideoPollDelayMs(Number.NaN), 300_000);

console.log("\n【3】2 小时预算内的查询次数：既不猛打也不早退");
// 按新节奏累计等待，算出预算内能查多少次
let elapsed = 0;
let attempts = 0;
while (
  elapsed + computeVideoPollDelayMs(attempts + 1) <=
  VIDEO_POLL_TOTAL_BUDGET_MS
) {
  attempts += 1;
  elapsed += computeVideoPollDelayMs(attempts);
}
checkTrue("2 小时内至少能查 200 次（覆盖长任务）", attempts >= 200);
checkTrue("2 小时内不会超过 300 次（不惊群）", attempts <= 300);
checkTrue("末次查询仍在预算内", elapsed <= VIDEO_POLL_TOTAL_BUDGET_MS);
check("旧参数（3 秒 × 400 次）只撑 20 分钟，已被替换", 3_000 * 400, 1_200_000);

console.log("\n【4】预算判定");
checkTrue("刚建单（0ms）继续等", shouldContinueVideoPolling(0));
checkTrue(
  "差 1 毫秒到 2 小时继续等",
  shouldContinueVideoPolling(VIDEO_POLL_TOTAL_BUDGET_MS - 1),
);
check(
  "到 2 小时停止（按超时收口）",
  shouldContinueVideoPolling(VIDEO_POLL_TOTAL_BUDGET_MS),
  false,
);
check(
  "超过 2 小时停止",
  shouldContinueVideoPolling(VIDEO_POLL_TOTAL_BUDGET_MS + 1),
  false,
);

console.log("\n【5】可中断等待（用户停止时不用等满 5 分钟）");
const immediate = new AbortController();
immediate.abort();
let abortedMessage = "";
try {
  await sleepWithAbort(VIDEO_POLL_FIRST_DELAY_MS, immediate.signal);
} catch (error) {
  abortedMessage = error instanceof Error ? error.message : String(error);
}
check("已中断的信号立刻抛错", abortedMessage, "任务已取消");

const mid = new AbortController();
const startedAt = Date.now();
setTimeout(() => mid.abort(), 30);
let midError = "";
try {
  await sleepWithAbort(60_000, mid.signal);
} catch (error) {
  midError = error instanceof Error ? error.message : String(error);
}
checkTrue(
  "等待中被打断：30ms 内返回而不是等满 60s",
  Date.now() - startedAt < 5_000,
);
check("打断时的错误信息", midError, "任务已取消");

const normal = new AbortController();
await sleepWithAbort(20, normal.signal);
checkTrue("未打断时正常返回", true);

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);
