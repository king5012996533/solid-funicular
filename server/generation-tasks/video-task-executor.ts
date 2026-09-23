import type {
  GenerationTaskStartPayload,
  GenerationTaskStreamEvent,
} from "./shared";
import type { GenerationRecordPayload } from "../generation-records/shared";
import type { RuntimeManagedTask } from "./task-runtime-governor";

/**
 * 视频任务执行器（2026-09-23）
 *
 * 形状照 image-task-executor 来（同一套上下文注入、同一套进度事件与收尾），
 * 差别只在「上游是异步任务制」这一段：
 *
 *   建单（拿任务 id）→ 轮询到终态（把上游状态/进度透传给前端）→ 取回成品地址 → 写记录 + 收尾
 *
 * 之前画布上的视频节点只会提示「视频生成尚未接通：服务端还没有 video 执行策略」——
 * 因为策略表里确实没有 video（见 strategy.ts）。这个执行器补上的就是那条策略。
 */

type VideoExecutionTask = RuntimeManagedTask;

type VideoTaskRetryState = {
  attempt: number;
  waitDurationMs: number;
  status: number;
  errorPreview: string;
  stage: string;
};

export interface VideoTaskExecutorContext {
  syncSharedTaskRuntime: (
    task: VideoExecutionTask,
    status: "running" | "completed",
  ) => Promise<void>;
  ensureTaskNotAborted: (task: VideoExecutionTask) => Promise<void>;
  emitTaskProgressEvent: (
    recordId: string,
    input: {
      stage: string;
      stopped?: boolean;
      message?: string;
    },
  ) => void;
  markTaskRetryState: (
    task: VideoExecutionTask,
    input: VideoTaskRetryState,
  ) => Promise<void>;
  /** 建单：返回上游任务 id（少数网关建单即出片，immediateUrl 直接用） */
  createVideoTask: (input: {
    signal: AbortSignal;
    providerId: string;
    modelKey: string;
    requestBody: Record<string, unknown>;
    onRetry?: (retryState: VideoTaskRetryState) => Promise<void> | void;
  }) => Promise<{ upstreamUrl: string; taskId: string; immediateUrl?: string }>;
  /** 轮询到终态：成功返回成品地址，失败抛错（错误信息来自上游） */
  pollVideoTask: (input: {
    signal: AbortSignal;
    providerId: string;
    modelKey: string;
    taskId: string;
    /** 每轮把上游状态回给执行器，用于向前端展示「正在生成（xx%）」 */
    onProgress?: (state: {
      rawStatus: string;
      progress?: number;
      attempt: number;
    }) => Promise<void> | void;
  }) => Promise<{ upstreamUrl: string; videoUrl: string }>;
  buildInitialRecordPayload: (
    payload: GenerationTaskStartPayload,
  ) => GenerationRecordPayload;
  updateGenerationRecord: (
    recordId: string,
    payload: GenerationRecordPayload,
    currentUserId: string,
  ) => Promise<unknown>;
  getGenerationRecordById: (
    recordId: string,
    currentUserId: string,
  ) => Promise<Record<string, unknown>>;
  emitTaskStreamEvent: (
    recordId: string,
    event: GenerationTaskStreamEvent,
  ) => void;
  logGenerationTask: (stage: string, detail: Record<string, unknown>) => void;
}

export const executeVideoTask = async (
  task: VideoExecutionTask,
  payload: GenerationTaskStartPayload,
  context: VideoTaskExecutorContext,
) => {
  await context.syncSharedTaskRuntime(task, "running");
  await context.ensureTaskNotAborted(task);

  const modelKey = String(payload.modelKey || "").trim();
  if (!modelKey) throw new Error("缺少视频模型标识");

  const providerId = String(
    (payload.requestBody || {}).providerId || "",
  ).trim();
  if (!providerId) throw new Error("缺少视频厂商配置");

  const requestBody: Record<string, unknown> = {
    ...(payload.requestBody || {}),
    model: modelKey,
    prompt: String(
      payload.prompt || (payload.requestBody || {}).prompt || "",
    ).trim(),
  };
  if (!requestBody.prompt) throw new Error("缺少视频提示词");

  context.emitTaskProgressEvent(task.recordId, {
    stage: "resolved_provider",
    message: "已解析厂商与模型配置，准备向视频上游建单",
  });

  const created = await context.createVideoTask({
    signal: task.abortController.signal,
    providerId,
    modelKey,
    requestBody,
    onRetry: (retryState) => context.markTaskRetryState(task, retryState),
  });
  context.logGenerationTask("video_task:created", {
    recordId: task.recordId,
    userId: task.userId,
    upstreamUrl: created.upstreamUrl,
    taskId: created.taskId,
    modelKey,
  });
  context.emitTaskProgressEvent(task.recordId, {
    stage: "video_queued",
    message: `上游已接单（任务 ${created.taskId.slice(0, 12)}…），开始等待生成`,
  });

  // 建单即出片的网关（少数）跳过轮询
  let videoUrl = String(created.immediateUrl || "").trim();
  if (!videoUrl) {
    const polled = await context.pollVideoTask({
      signal: task.abortController.signal,
      providerId,
      modelKey,
      taskId: created.taskId,
      onProgress: ({ rawStatus, progress, attempt }) => {
        context.emitTaskProgressEvent(task.recordId, {
          stage: "video_generating",
          message:
            progress === undefined
              ? `视频生成中（上游状态 ${rawStatus || "处理中"}，第 ${attempt} 次查询）`
              : `视频生成中（${progress}%，第 ${attempt} 次查询）`,
        });
      },
    });
    videoUrl = polled.videoUrl;
  }
  await context.ensureTaskNotAborted(task);

  if (!videoUrl) throw new Error("上游没有返回视频地址");

  context.emitTaskProgressEvent(task.recordId, {
    stage: "syncing_record",
    message: "视频已生成，正在写入记录",
  });
  await context.updateGenerationRecord(
    task.recordId,
    {
      ...context.buildInitialRecordPayload(payload),
      done: true,
      stopped: false,
      // 与图片链路保持一致：产物统一放 outputs，画布节点从记录里取
      outputs: [{ outputType: "video", url: videoUrl }],
    },
    task.userId,
  );

  const completedRecord = await context.getGenerationRecordById(
    task.recordId,
    task.userId,
  );
  await context.syncSharedTaskRuntime(task, "completed");
  context.emitTaskStreamEvent(task.recordId, {
    type: "completed",
    recordId: task.recordId,
    done: true,
    stopped: false,
    record: completedRecord,
    stage: "completed",
    message: "视频生成完成，结果已写入记录",
  });
  context.logGenerationTask("video_task:request_success", {
    recordId: task.recordId,
    userId: task.userId,
    videoUrl,
  });
};
