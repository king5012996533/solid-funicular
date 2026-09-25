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
import { saveUploadedBuffer } from "../storage/service";
import {
  normalizeVideoCreateBody,
  readRequestImageUrls,
  resolveUpstreamImageUrls,
  resolveVideoCreateContract,
} from "./video-create-contract";
import {
  VIDEO_POLL_FIRST_DELAY_MS,
  VIDEO_POLL_MAX_DELAY_MS,
  VIDEO_POLL_MIN_DELAY_MS,
  VIDEO_POLL_TOTAL_BUDGET_MS,
  computeVideoPollDelayMs,
  shouldContinueVideoPolling,
  sleepWithAbort,
} from "./video-poll-schedule";
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
  /**
   * 重新签发成品地址的路径模板（GenVideo：`/tasks/output-url/{id}`）。
   * 上游产物是带时间签名的 CDN 地址，过期后 403 —— 这时只能向它换一份新地址。
   */
  outputUrlPath?: string;
  dialect: VideoDialect;
  apiKey?: string;
  /** 模型能力声明（capabilityJson）：建单参数契约（mode / 时长字段名 / 参考图字段名）从这里读 */
  modelCapability?: unknown;
  /** 本站资源的公网基址；参考图是 `/uploads/...` 相对地址时靠它转成上游能取到的绝对地址 */
  publicAssetBaseUrl?: string;
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
        // 时长字段名按契约归一化后可能落在 durationSeconds 上（见 normalizeVideoCreateBody）
        ...((body.durationSeconds ?? body.duration) ? { duration: Number(body.durationSeconds ?? body.duration) } : {}),
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

// ---------------------------------------------------------------------------
// 真正的 HTTP 动作：建单 + 轮询（由执行器注入 fetchWithBurstRateRetry，与图片链路同一套重试/日志）
// ---------------------------------------------------------------------------

// 轮询节奏（首次 5 分钟 / 15→30 秒退避 / 2 小时上限）在 video-poll-schedule.ts 里，
// 那边是纯函数、有单测；原来的 3 秒 × 400 次（20 分钟就放弃）已删。

const resolveConfig = async (input: { providerId: string; modelKey: string }): Promise<VideoUpstreamConfig> => {
    const upstream = await resolveGatewayProviderUpstream({
        providerId: input.providerId,
        endpointType: 'video',
        modelKey: input.modelKey,
    })
    const extraJson = (upstream as unknown as {
        extraJson?: {
            videoDialect?: unknown
            videoStatusPath?: string
            videoContentPath?: string
            videoOutputUrlPath?: string
        }
    }).extraJson || {}
    const videoEndpoint = upstream.endpoint || '/videos'
    return {
        providerId: input.providerId,
        baseUrl: upstream.baseUrl,
        createEndpoint: videoEndpoint,
        statusPath: extraJson.videoStatusPath,
        contentPath: extraJson.videoContentPath,
        outputUrlPath: extraJson.videoOutputUrlPath || deriveOutputUrlPath(extraJson.videoStatusPath),
        dialect: resolveVideoDialect({ videoEndpoint, explicit: extraJson.videoDialect }),
        apiKey: upstream.apiKey,
        modelCapability: (upstream as unknown as { modelCapabilityJson?: unknown }).modelCapabilityJson,
        publicAssetBaseUrl: String(process.env.PUBLIC_ASSET_BASE_URL || '').trim(),
    }
}

/**
 * 从查询路径推出「换发成品地址」的路径：`/tasks/{id}` → `/tasks/output-url/{id}`。
 * 上游文档给的是 `GET /v1/tasks/output-url/{id}`；厂商配置里显式写了就用配置的。
 */
const deriveOutputUrlPath = (statusPath?: string): string | undefined => {
    const value = String(statusPath || '').trim()
    if (!value.includes('/tasks/{id}')) return undefined
    return value.replace('/tasks/{id}', '/tasks/output-url/{id}')
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
): Promise<{ upstreamUrl: string; taskId: string; immediateUrl?: string; adjustments: string[] }> => {
    const config = await resolveConfig(input)
    // 建单参数按模型能力声明归一化：mode / 时长字段名 / 时长档位 / 画幅写法 / 参考图字段名
    const contract = resolveVideoCreateContract(config.modelCapability)
    // 参考图先在本层确认上游真能取到：上游对取不到的图是**静默忽略**的（成片对不上、钱已经花了）
    const requestedImages = readRequestImageUrls(input.requestBody)
    const reachableImages = requestedImages.length
        ? await resolveUpstreamImageUrls({
            images: requestedImages,
            publicAssetBaseUrl: config.publicAssetBaseUrl,
        })
        : []
    const normalized = normalizeVideoCreateBody({
        body: input.requestBody,
        contract,
        referenceImages: reachableImages,
    })
    const { url, body } = buildVideoCreateRequest(config, normalized.body)
    deps.log?.('video_upstream:create', {
        providerId: input.providerId,
        modelKey: input.modelKey,
        dialect: config.dialect,
        url,
        // 按「真正发出去的形状」留痕：字段名与固定值写错时上游不报错、直接忽略，只能靠日志对账
        mode: body.mode ?? null,
        ratio: body.ratio ?? null,
        durationField: contract.durationField || 'duration',
        duration: body[contract.durationField || 'duration'] ?? null,
        imageCount: reachableImages.length,
        adjustments: normalized.adjustments,
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
    // 任务 id 是 long、以字符串返回：只能用字符串收发。number 超过安全整数会静默丢精度，
    // 拿着错的 id 去查任务只会得到 404，而钱已经扣了。
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
    // 建单响应里带 points（本渠道 5 积分/条、建单即预扣）与状态，留痕供对账
    deps.log?.('video_upstream:create_response', {
        taskId: taskId || '(immediate)',
        status: String(record.status || ''),
        points: record.points ?? null,
        createdAt: record.createdAt ?? null,
        finishedAt: record.finishedAt ?? null,
        hasOutputUrl: Boolean(record.outputUrl),
        immediateUrl: Boolean(immediateUrl),
    })
    return {
        upstreamUrl: url,
        taskId: taskId || 'immediate',
        immediateUrl: immediateUrl || undefined,
        adjustments: normalized.adjustments,
    }
}

/** 轮询到终态；失败时抛上游给的原因（不吞） */
export const pollVideoTaskRequest = async (
    input: {
        providerId: string
        modelKey: string
        taskId: string
        /** 我们的任务记录 id：只用于日志，让轮询/失败日志能按 recordId 直接检索（原来只带上游 taskId，出问题查不动） */
        recordId?: string
        signal: AbortSignal
        onProgress?: (state: { rawStatus: string; progress?: number; attempt: number }) => Promise<void> | void
    },
    deps: VideoRequestDeps,
): Promise<{ upstreamUrl: string; videoUrl: string; attempts: number }> => {
    const config = await resolveConfig(input)
    /** 统一的轮询日志出口：把 recordId 与上游 taskId 绑进每条 detail，便于事后按我们的记录 id 检索 */
    const log = (stage: string, detail: Record<string, unknown>) =>
        deps.log?.(stage, { recordId: input.recordId, taskId: input.taskId, ...detail })
    const statusPath = (config.statusPath || `${config.createEndpoint}/{id}`).replace('{id}', encodeURIComponent(input.taskId))
    const url = joinUpstreamUrl(config.baseUrl, statusPath)
    const startedAt = Date.now()
    log?.('video_upstream:poll_start', {
        providerId: input.providerId,
        modelKey: input.modelKey,
        taskId: input.taskId,
        url,
        dialect: config.dialect,
        firstDelayMs: VIDEO_POLL_FIRST_DELAY_MS,
        minDelayMs: VIDEO_POLL_MIN_DELAY_MS,
        maxDelayMs: VIDEO_POLL_MAX_DELAY_MS,
        totalBudgetMs: VIDEO_POLL_TOTAL_BUDGET_MS,
    })

    let attempt = 0
    while (shouldContinueVideoPolling(Date.now() - startedAt)) {
        attempt += 1
        // 先等再查：第一次查询落在建单 5 分钟后（上游文档要求），之后 15→30 秒退避；
        // 等待掐到预算内，避免最后一次等待越过 2 小时上限
        const remainingMs = Math.max(0, VIDEO_POLL_TOTAL_BUDGET_MS - (Date.now() - startedAt))
        const delayMs = Math.min(computeVideoPollDelayMs(attempt), remainingMs)
        log?.('video_upstream:poll_wait', { attempt, delayMs, elapsedMs: Date.now() - startedAt })
        await sleepWithAbort(delayMs, input.signal)
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
            log?.('video_upstream:poll_http_error', {
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
            const progress = extractProgress(payload)
            // 每次轮询都留一条：原来 pending/processing 这种"一切正常"的状态完全不记日志，
            // 出问题时无法判断上游到底卡在哪一步
            log('video_upstream:poll_observed', { attempt, rawStatus, progress: progress ?? null, state })
            await input.onProgress?.({ rawStatus, progress, attempt })
            if (state === 'succeeded') {
                const videoUrl = extractVideoUrl(payload)
                if (videoUrl) {
                    // 终态里带 points（本渠道按条预扣，失败/超时全额退回）与 finishedAt
                    log?.('video_upstream:poll_succeeded', {
                        attempt,
                        elapsedMs: Date.now() - startedAt,
                        rawStatus,
                        points: record.points ?? null,
                        finishedAt: record.finishedAt ?? null,
                    })
                    return { upstreamUrl: url, videoUrl, attempts: attempt }
                }
                // 状态成功但没给地址：再等一轮（有的网关先改状态后补地址）
                log?.('video_upstream:poll_succeeded_without_url', { attempt, body: String(text).slice(0, 200) })
            } else if (state === 'failed') {
                // 上游对失败原因常常写得含糊（例如真人脸这类策略拒绝只说"未成功，请重试"），
                // 所以原文必须留档：否则事后只能猜。
                log('video_upstream:poll_failed', {
                    attempt,
                    rawStatus,
                    errorMessage: extractErrorMessage(payload) || '',
                    points: record.points ?? null,
                    body: String(text).slice(0, 600),
                })
                throw new Error(`上游视频任务失败：${extractErrorMessage(payload) || rawStatus || '未知原因'}`)
            }
        }
    }
    throw new Error(`视频任务轮询超时（${Math.round(VIDEO_POLL_TOTAL_BUDGET_MS / 60000)} 分钟未出结果；上游此时也会判 timeout 并全额退分）`)
}

// ---------------------------------------------------------------------------
// 产物转存：上游给的是带时间签名的 CDN 地址（会过期，过期后 403 = 内容丢失），
// 所以拿到 succeeded 就立刻下载到我们自己的存储，库里只留本地地址。
// ---------------------------------------------------------------------------

/**
 * 产物 MIME 兜底。
 *
 * 实测：GenVideo 的成品在 doubao TOS 上回的 content-type 是 `binary/octet-stream`，
 * 直接拿它存盘会**存成没有扩展名的文件**，我们静态服务再按扩展名回 content-type，
 * 画布上的 <video> 就播不动了（字节是对的、能播不了）。所以：非 video/* 时按地址里的
 * 扩展名认，再认不出就按上游文档的 mime_type=video_mp4 落成 video/mp4。
 */
const resolveVideoMimeType = (contentType: string, sourceUrl: string): string => {
    if (/^video\//i.test(contentType)) return contentType
    const extension = /\.(mp4|webm|mov|m4v)(?:\?|#|$)/i.exec(String(sourceUrl || ''))?.[1]?.toLowerCase()
    if (extension === 'webm') return 'video/webm'
    if (extension === 'mov') return 'video/quicktime'
    if (extension === 'm4v') return 'video/x-m4v'
    return 'video/mp4'
}

export interface MaterializedVideoOutput {
    /** 落库用的本地地址（/uploads/... 或对象存储地址） */
    publicUrl: string
    relativePath: string
    storageType: string
    size: number
    mimeType?: string
    /** 实际下载用的上游地址（可能是换发后的新地址），只做日志用，不落库 */
    sourceUrl: string
    /** 是否走了「换发新地址」这一步 */
    refreshed: boolean
}

/** 向上游换发一份新的成品地址（旧地址过期/403 时用；文档：GET /v1/tasks/output-url/{id}） */
export const requestRefreshedOutputUrl = async (
    input: { providerId: string; modelKey: string; taskId: string; signal: AbortSignal },
    deps: VideoRequestDeps,
): Promise<string> => {
    const config = await resolveConfig(input)
    const outputUrlPath = String(config.outputUrlPath || '').trim()
    if (!outputUrlPath) {
        throw new Error('上游没有配置换发成品地址的路径，无法重新获取视频地址')
    }
    const url = joinUpstreamUrl(config.baseUrl, outputUrlPath.replace('{id}', encodeURIComponent(input.taskId)))
    const response = await deps.fetchWithBurstRateRetry({
        url,
        init: { method: 'GET', headers: authHeaders(config) },
        signal: input.signal,
        stage: 'video_output_url_refresh',
        timeoutMs: 30_000,
        detail: { providerId: input.providerId, taskId: input.taskId },
    })
    const text = await response.text()
    let payload: unknown = null
    try { payload = JSON.parse(text) } catch { payload = text }
    if (!response.ok) {
        throw new Error(`换发视频地址失败（HTTP ${response.status}）：${extractErrorMessage(payload) || String(text).slice(0, 160)}`)
    }
    const refreshed = extractVideoUrl(payload)
    deps.log?.('video_upstream:output_url_refreshed', {
        taskId: input.taskId,
        url,
        ok: Boolean(refreshed),
    })
    if (!refreshed) {
        throw new Error(`上游换发的响应里没有视频地址：${String(text).slice(0, 160)}`)
    }
    return refreshed
}

/**
 * 下载上游成品并转存到我们自己的存储，返回落库用的本地地址。
 *
 * 为什么必须在视频链路上做这一步（而不是只把 CDN 地址写进库）：
 * `outputUrl` 是第三方 CDN 的**时间签名地址**，过期后用户再看就是 403 ——
 * 记录还在、视频没了，等于内容丢失。地址为 null 或下载 403 时按文档向
 * `/tasks/output-url/{id}` 换一份新地址再试一次。
 */
export const materializeVideoOutput = async (
    input: { providerId: string; modelKey: string; taskId: string; videoUrl: string; signal: AbortSignal },
    deps: VideoRequestDeps,
): Promise<MaterializedVideoOutput> => {
    const downloadOnce = async (sourceUrl: string) => {
        const response = await deps.fetchWithBurstRateRetry({
            url: sourceUrl,
            init: { method: 'GET' },
            signal: input.signal,
            stage: 'video_output_download',
            timeoutMs: 300_000,
            detail: { providerId: input.providerId, taskId: input.taskId },
        })
        if (!response.ok) {
            throw new Error(`下载视频成品失败（HTTP ${response.status}）`)
        }
        const arrayBuffer = await response.arrayBuffer()
        return {
            buffer: Buffer.from(arrayBuffer),
            mimeType: resolveVideoMimeType(
                String(response.headers.get('content-type') || '').trim(),
                sourceUrl,
            ),
        }
    }

    let sourceUrl = String(input.videoUrl || '').trim()
    let refreshed = false
    let downloaded: { buffer: Buffer; mimeType?: string } | null = null

    if (!sourceUrl) {
        // 文档：succeeded 时 outputUrl 应当非空；为空就只能换发
        sourceUrl = await requestRefreshedOutputUrl(input, deps)
        refreshed = true
        downloaded = await downloadOnce(sourceUrl)
    } else {
        try {
            downloaded = await downloadOnce(sourceUrl)
        } catch (error) {
            // 签名过期/403：换一份新地址再下一次（上游地址只做中转，不落库）
            deps.log?.('video_upstream:output_download_failed', {
                taskId: input.taskId,
                error: error instanceof Error ? error.message : String(error),
            })
            sourceUrl = await requestRefreshedOutputUrl(input, deps)
            refreshed = true
            downloaded = await downloadOnce(sourceUrl)
        }
    }

    const size = downloaded.buffer.byteLength
    if (!size) throw new Error('视频成品转存失败：下载到的内容为空')

    const saved = await saveUploadedBuffer({
        buffer: downloaded.buffer,
        mimeType: downloaded.mimeType,
        filename: `generation-output-${input.taskId}`,
        category: 'generated/video',
    })
    deps.log?.('video_upstream:output_stored', {
        taskId: input.taskId,
        refreshed,
        sourceUrlPreview: sourceUrl.slice(0, 160),
        savedUrl: saved.publicUrl,
        storageType: saved.storageType,
        relativePath: saved.relativePath,
        size,
        mimeType: downloaded.mimeType || null,
    })

    return {
        publicUrl: saved.publicUrl,
        relativePath: saved.relativePath,
        storageType: saved.storageType,
        size,
        mimeType: downloaded.mimeType,
        sourceUrl,
        refreshed,
    }
}
