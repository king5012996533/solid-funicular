/**
 * 视频任务轮询节奏（2026-09-25）。
 *
 * 单独一个文件的原因：这里全是**纯计算**（下一次等待多久、是否还在预算内），
 * 单测要能直接跑（tests/video-poll-schedule.test.ts）—— 混在 video-upstream.ts 里的话，
 * 一 import 就会连带拉起 prisma 与厂商配置，测试跑不动。
 */

/**
 * 轮询节奏（对齐上游文档，2026-09-25 改）。
 *
 * 文档原文：**首次查询在建单 5 分钟后**；之后 10~30 秒间隔 + 指数退避；
 * 频繁轮询只会更早触发 429 RATE_LIMIT_EXCEEDED；建单满 2 小时未完成服务端判 timeout 并全额退分。
 *
 * 旧参数是 3 秒 × 400 次（20 分钟就放弃）：既在上游刚接单时就猛打（最容易被限流），
 * 又比上游自己的超时上限早 100 分钟放弃 —— 批量建单时这些空转请求还会叠成惊群。
 */
export const VIDEO_POLL_FIRST_DELAY_MS = 300_000; // 首查：建单后 5 分钟
export const VIDEO_POLL_MIN_DELAY_MS = 15_000; // 之后从 15 秒起步
export const VIDEO_POLL_MAX_DELAY_MS = 30_000; // 指数退避封顶 30 秒
export const VIDEO_POLL_TOTAL_BUDGET_MS = 7_200_000; // 总上限 2 小时（= 上游 timeout 口径）

/**
 * 第 attempt 次查询前的等待时长。
 * attempt=1 → 5 分钟；2 → 15 秒；3 → 30 秒；之后封顶 30 秒。
 * 纯函数，单测直接覆盖（tests/video-poll-schedule.test.ts）。
 */
export const computeVideoPollDelayMs = (attempt: number): number => {
  const normalizedAttempt = Math.max(1, Math.floor(Number(attempt) || 1));
  if (normalizedAttempt === 1) return VIDEO_POLL_FIRST_DELAY_MS;
  const backoff = VIDEO_POLL_MIN_DELAY_MS * 2 ** (normalizedAttempt - 2);
  return Math.min(
    VIDEO_POLL_MAX_DELAY_MS,
    Math.max(VIDEO_POLL_MIN_DELAY_MS, backoff),
  );
};

/** 是否还在 2 小时等待预算内（超出就按超时收口，与上游 timeout 同步） */
export const shouldContinueVideoPolling = (elapsedMs: number): boolean =>
  Number(elapsedMs) < VIDEO_POLL_TOTAL_BUDGET_MS;

/** 可中断的等待：用户点停止时不必等满 5 分钟才响应 */
export const sleepWithAbort = (
  ms: number,
  signal: AbortSignal,
): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("任务已取消"));
      return;
    }
    const timer = setTimeout(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("任务已取消"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
