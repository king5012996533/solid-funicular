/**
 * 视频上游接口适配层（2026-09-23 从 SceneFlow 搬过来）
 *
 * 背景：新项目原先只有 image / agent-chat / agent-workspace / research-report 四条执行策略，
 * **没有 video** —— 画布上的视频节点只能如实提示「视频生成尚未接通」。SceneFlow 那边是跑通的，
 * 支持六种通道（openai 兼容 `/videos`、火山 Ark `/contents/generations/tasks`、
 * replicate `/v1/predictions`、以及 minimax / aigccc / genvideo 这类「建单拿 task_id → 轮询」的网关）。
 *
 * 搬过来的原则：
 *   1. **只搬接口形状，不搬 SceneFlow 的启发式**。那边靠「模型名里有没有 seedance」猜通道，
 *      这里改成显式配置（厂商 extraJson.videoDialect），猜错就是打错上游，太贵。
 *   2. 视频是**异步任务制**：建单拿 id → 轮询到终态 → 取回成品地址。所以适配层只做这三件事，
 *      计费/归档/收尾仍然走新项目自己的任务治理链路。
 *   3. 状态与成品地址的**提取要宽**：不同网关字段名各不相同（见 extractVideoUrl / normalizeTaskStatus），
 *      这是 SceneFlow 那边踩出来的经验，照搬。
 */

import { resolveGatewayProviderUpstream } from "../provider-config/service";
import type { FetchWithBurstRateRetryInput } from "./upstream-helpers";

export type VideoDialect = "openai-videos" | "ark-seedance" | "task-generic";

export interface VideoUpstreamConfig {
  providerId: string;
  baseUrl: string;
  /** 建单路径（来自厂商配置的 videoEndpoint） */
  createEndpoint: string;
  /** 查询路径模板：不配则用 `${createEndpoint}/{id}` */
  statusPath?: string;
  /** 成品下载路径模板（openai 风格才有：`/videos/{id}/content`） */
  contentPath?: string;
  dialect: VideoDialect;
  apiKey?: string;
}

export interface VideoTaskCreated {
  id: string;
  /** 上游可能直接在建单响应里就带回成品（少数网关如此），有就直接用 */
  immediateUrl?: string;
}

export interface VideoTaskStatus {
  state: "processing" | "succeeded" | "failed";
  /** 上游原始状态字符串，用于日志与进度展示 */
  rawStatus: string;
  url?: string;
  error?: string;
  /** 上游自报的进度（0-100），有就透传给前端 */
  progress?: number;
}

const trimSlashes = (value: string) => value.replace(/^\/+|\/+$/g, "");

export const joinUpstreamUrl = (baseUrl: string, path: string) => {
  const base = baseUrl.replace(/\/+$/, "");
  if (!path) return base;
  if (/^https?:\/\//i.test(path)) return path;
  return `${base}/${trimSlashes(path)}`;
};

/** 按配置挑通道；没配就按路径特征推断（推断结果写进日志，便于发现配错） */
export const resolveVideoDialect = (input: {
  videoEndpoint: string;
  explicit?: unknown;
}): VideoDialect => {
  const explicitValue = String(input.explicit || "").trim();
  if (
    explicitValue === "openai-videos" ||
    explicitValue === "ark-seedance" ||
    explicitValue === "task-generic"
  ) {
    return explicitValue;
  }
  const endpoint = String(input.videoEndpoint || "").toLowerCase();
  if (endpoint.includes("contents/generations/tasks")) return "ark-seedance";
  if (/(^|\/)videos\/?$/.test(endpoint) || endpoint.endsWith("/videos"))
    return "openai-videos";
  return "task-generic";
};

/**
 * 上游状态串 → 我们的三态。
 *
 * 各家的词：succeeded / success / completed / done / finished / SUCCESS / PROCESSING / queued /
 * failed / error / canceled / cancelled / timeout …（SceneFlow 那边逐个踩过）
 */
export const normalizeTaskStatus = (
  raw: unknown,
): "processing" | "succeeded" | "failed" => {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!value) return "processing";
  if (
    [
      "succeeded",
      "success",
      "completed",
      "complete",
      "done",
      "finished",
      "ok",
    ].includes(value)
  )
    return "succeeded";
  if (
    ["failed", "error", "canceled", "cancelled", "timeout", "expired"].includes(
      value,
    )
  )
    return "failed";
  return "processing";
};

/**
 * 明确的成品字段优先：这些字段的值本身就是成品地址，**不要求带 `.mp4` 这类扩展名**。
 *
 * 为什么要先走这一遍：GenVideo（ai-genvideo.com）成功响应把成品放在 `outputUrl`，
 * 但它指向 doubao 的 TOS，路径里没有 `.mp4`（只有查询串 `mime_type=video_mp4`），
 * 下面按扩展名筛的那一遍会把这种地址判成「不是视频」→ 状态成功却取不到地址、一直轮询到超时。
 */
const EXPLICIT_VIDEO_URL_KEYS = [
  "outputUrl",
  "output_url",
  "video_url",
  "videoUrl",
  "file_url",
  "download_url",
] as const;

const pickExplicitVideoUrl = (payload: unknown): string => {
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): string => {
    if (depth > 6 || node === null || node === undefined) return "";
    if (typeof node !== "object" || seen.has(node)) return "";
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = walk(item, depth + 1);
        if (hit) return hit;
      }
      return "";
    }
    const record = node as Record<string, unknown>;
    for (const key of EXPLICIT_VIDEO_URL_KEYS) {
      const value = record[key];
      if (typeof value === "string" && /^https?:\/\//i.test(value.trim()))
        return value.trim();
    }
    for (const key of ["data", "result", "output"]) {
      if (key in record) {
        const hit = walk(record[key], depth + 1);
        if (hit) return hit;
      }
    }
    return "";
  };
  return walk(payload, 0);
};

/** 从五花八门的响应里把成品地址捞出来（同一个网关不同模型字段都不一样） */
export const extractVideoUrl = (payload: unknown): string => {
  const explicit = pickExplicitVideoUrl(payload);
  if (explicit) return explicit;

  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): string => {
    if (depth > 6 || node === null || node === undefined) return "";
    if (typeof node === "string") {
      return /^https?:\/\//i.test(node) &&
        /\.(mp4|webm|mov|m4v)(\?|$)/i.test(node)
        ? node
        : "";
    }
    if (typeof node !== "object" || seen.has(node)) return "";
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = walk(item, depth + 1);
        if (hit) return hit;
      }
      return "";
    }
    const record = node as Record<string, unknown>;
    // 常见字段优先（顺序即优先级，避免误取封面图）
    for (const key of [
      "video_url",
      "videoUrl",
      // GenVideo（ai-genvideo.com）成功响应把成品放在 outputUrl（旧项目实测字段）
      "outputUrl",
      "output_url",
      "url",
      "content",
      "output",
      "outputs",
      "videos",
      "result",
      "data",
      "file_url",
      "download_url",
    ]) {
      if (!(key in record)) continue;
      const hit = walk(record[key], depth + 1);
      if (hit) return hit;
    }
    return "";
  };
  return walk(payload, 0);
};

/** 上游自报进度（0-100），没有就返回 undefined */
export const extractProgress = (payload: unknown): number | undefined => {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  for (const key of ["progress", "percent", "percentage"]) {
    const value = Number(record[key]);
    if (Number.isFinite(value) && value >= 0 && value <= 100)
      return Math.round(value);
  }
  const data = record.data;
  if (data && typeof data === "object") return extractProgress(data);
  return undefined;
};

/** 上游报错信息 */
export const extractErrorMessage = (payload: unknown): string => {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  for (const key of [
    "error",
    "message",
    "msg",
    "error_message",
    "status_msg",
    "fail_reason",
  ]) {
    const value = record[key];
    if (typeof value === "string" && value.trim())
      return value.trim().slice(0, 200);
    if (value && typeof value === "object") {
      const nested = (value as Record<string, unknown>).message;
      if (typeof nested === "string" && nested.trim())
        return nested.trim().slice(0, 200);
    }
  }
  const data = record.data;
  if (data && typeof data === "object") return extractErrorMessage(data);
  return "";
};

/** 建单：把请求体发给上游，拿回任务 id（或直接拿回成品） */
export const buildVideoCreateRequest = (
  config: VideoUpstreamConfig,
  body: Record<string, unknown>,
) => {
  const url = joinUpstreamUrl(config.baseUrl, config.createEndpoint);
  if (config.dialect === "ark-seedance") {
    // 火山 Ark：内容生成任务。prompt 走 content 数组（SceneFlow 里也是这么拼的）
    const prompt = String(body.prompt || "");
    return {
      url,
      body: {
        model: body.model,
        content: [{ type: "text", text: prompt }],
        ...(body.ratio ? { ratio: body.ratio } : {}),
        ...(body.duration ? { duration: Number(body.duration) } : {}),
        ...(body.resolution ? { resolution: body.resolution } : {}),
        ...(Array.isArray(body.referenceImages) && body.referenceImages.length
          ? { image_urls: body.referenceImages }
          : {}),
      },
    };
  }
  // openai 兼容与 task 网关都吃「把参数平铺进去」的形状
  return { url, body };
};


// ---------------------------------------------------------------------------
// 真正的 HTTP 动作：建单 + 轮询（由执行器注入 fetchWithBurstRateRetry，与图片链路同一套重试/日志）
// ---------------------------------------------------------------------------

const VIDEO_POLL_INTERVAL_MS = 3_000
/** 轮询上限：SceneFlow 那边按 5s × 240 ≈ 20 分钟；这里 3s × 400 ≈ 20 分钟，覆盖 veo/sora/seedance 这类长任务 */
const VIDEO_POLL_MAX_ATTEMPTS = 400

const resolveConfig = async (input: { providerId: string; modelKey: string }): Promise<VideoUpstreamConfig> => {
    const upstream = await resolveGatewayProviderUpstream({
        providerId: input.providerId,
        endpointType: 'video',
        modelKey: input.modelKey,
    })
    const explicitDialect = (upstream as unknown as { extraJson?: { videoDialect?: unknown } }).extraJson?.videoDialect
    const videoEndpoint = upstream.endpoint || '/videos'
    return {
        providerId: input.providerId,
        baseUrl: upstream.baseUrl,
        createEndpoint: videoEndpoint,
        statusPath: (upstream as unknown as { extraJson?: { videoStatusPath?: string } }).extraJson?.videoStatusPath,
        contentPath: (upstream as unknown as { extraJson?: { videoContentPath?: string } }).extraJson?.videoContentPath,
        dialect: resolveVideoDialect({ videoEndpoint, explicit: explicitDialect }),
        apiKey: upstream.apiKey,
    }
}

const authHeaders = (config: VideoUpstreamConfig) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
    return headers
}

export interface VideoRequestDeps {
    /** 与图片链路同一套（logGenerationTask 由调用方注入） */
    fetchWithBurstRateRetry: (input: Omit<FetchWithBurstRateRetryInput, "logGenerationTask">) => Promise<Response>
    onRetry?: (retryState: { attempt: number; waitDurationMs: number; status: number; errorPreview: string; stage: string }) => Promise<void> | void
    log?: (stage: string, detail: Record<string, unknown>) => void
}

/** 建单：把请求体发出去，拿回任务 id */
export const createVideoTaskRequest = async (
    input: { providerId: string; modelKey: string; requestBody: Record<string, unknown>; signal: AbortSignal },
    deps: VideoRequestDeps,
): Promise<{ upstreamUrl: string; taskId: string; immediateUrl?: string }> => {
    const config = await resolveConfig(input)
    const { url, body } = buildVideoCreateRequest(config, input.requestBody)
    deps.log?.('video_upstream:create', {
        providerId: input.providerId,
        modelKey: input.modelKey,
        dialect: config.dialect,
        url,
    })
    const response = await deps.fetchWithBurstRateRetry({
        url,
        init: { method: 'POST', headers: authHeaders(config), body: JSON.stringify(body) },
        signal: input.signal,
        stage: 'video_create',
        timeoutMs: 60_000,
        detail: { providerId: input.providerId, modelKey: input.modelKey },
    })
    const text = await response.text()
    let payload: unknown = null
    try { payload = JSON.parse(text) } catch { payload = text }
    if (!response.ok) {
        throw new Error(`视频建单失败（HTTP ${response.status}）：${extractErrorMessage(payload) || String(text).slice(0, 160)}`)
    }
    const record = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
    const taskId = String(
        record.id
        || record.task_id
        || record.taskId
        || (record.data && typeof record.data === 'object' ? (record.data as Record<string, unknown>).id || (record.data as Record<string, unknown>).task_id : '')
        || '',
    ).trim()
    const immediateUrl = extractVideoUrl(payload)
    if (!taskId && !immediateUrl) {
        throw new Error(`视频建单响应里既没有任务 id 也没有成品地址：${String(text).slice(0, 160)}`)
    }
    return { upstreamUrl: url, taskId: taskId || 'immediate', immediateUrl: immediateUrl || undefined }
}

/** 轮询到终态；失败时抛上游给的原因（不吞） */
export const pollVideoTaskRequest = async (
    input: {
        providerId: string
        modelKey: string
        taskId: string
        signal: AbortSignal
        onProgress?: (state: { rawStatus: string; progress?: number; attempt: number }) => Promise<void> | void
    },
    deps: VideoRequestDeps,
): Promise<{ upstreamUrl: string; videoUrl: string }> => {
    const config = await resolveConfig(input)
    const statusPath = (config.statusPath || `${config.createEndpoint}/{id}`).replace('{id}', encodeURIComponent(input.taskId))
    const url = joinUpstreamUrl(config.baseUrl, statusPath)
    deps.log?.('video_upstream:poll_start', {
        providerId: input.providerId,
        modelKey: input.modelKey,
        taskId: input.taskId,
        url,
        dialect: config.dialect,
    })

    for (let attempt = 1; attempt <= VIDEO_POLL_MAX_ATTEMPTS; attempt += 1) {
        if (input.signal.aborted) throw new Error('任务已取消')
        const response = await deps.fetchWithBurstRateRetry({
            url,
            init: { method: 'GET', headers: authHeaders(config) },
            signal: input.signal,
            stage: 'video_poll',
            timeoutMs: 30_000,
            detail: { providerId: input.providerId, taskId: input.taskId, attempt },
        })
        const text = await response.text()
        let payload: unknown = null
        try { payload = JSON.parse(text) } catch { payload = text }
        if (!response.ok) {
            // 查询接口偶发 5xx 不应直接判失败：继续轮询，但把原文留在日志里
            deps.log?.('video_upstream:poll_http_error', {
                status: response.status,
                attempt,
                body: String(text).slice(0, 200),
            })
        } else {
            const record = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
            const rawStatus = String(
                record.status
                || (record.data && typeof record.data === 'object' ? (record.data as Record<string, unknown>).status : '')
                || '',
            )
            const state = normalizeTaskStatus(rawStatus)
            await input.onProgress?.({ rawStatus, progress: extractProgress(payload), attempt })
            if (state === 'succeeded') {
                const videoUrl = extractVideoUrl(payload)
                if (videoUrl) return { upstreamUrl: url, videoUrl }
                // 状态成功但没给地址：再等一轮（有的网关先改状态后补地址）
                deps.log?.('video_upstream:poll_succeeded_without_url', { attempt, body: String(text).slice(0, 200) })
            } else if (state === 'failed') {
                throw new Error(`上游视频任务失败：${extractErrorMessage(payload) || rawStatus || '未知原因'}`)
            }
        }
        await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_INTERVAL_MS))
    }
    throw new Error(`视频任务轮询超时（${Math.round((VIDEO_POLL_INTERVAL_MS * VIDEO_POLL_MAX_ATTEMPTS) / 60000)} 分钟未出结果）`)
}
