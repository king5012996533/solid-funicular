/**
 * 视频建单参数契约（2026-09-25）。
 *
 * 单独一个文件的原因：这里是**纯逻辑**（字段名映射 / 取值纠正 / 参考图可达性判断），
 * 要能被单测直接跑（tests/video-create-contract.test.ts）—— 如果留在 video-upstream.ts 里，
 * 单测一 import 就会连带拉起 prisma 与厂商配置解析，跑不动也看不出在测什么。
 */

import {
  logAssetPublish,
  mapUploadPathToPublicUrl,
  mapUploadPathToRemotePath,
  publishLocalUploadIfNeeded,
  resolveAssetPublishConfig,
} from "./asset-publish";
import type {
  AssetPublishConfig,
  AssetPublishResult,
} from "./asset-publish";

/** 上游参考图上限（官方文档：images 最多 10 项） */
export const VIDEO_UPSTREAM_MAX_IMAGES = 10;

/** 参考图可达性探测的超时（毫秒）：探测本身就慢的话会拖住建单 */
const REFERENCE_IMAGE_PROBE_TIMEOUT_MS = 10_000;

/**
 * 上游建单参数契约（来自模型能力声明 capabilityJson）。
 *
 * 为什么必须有它：同一个意思在我们的请求体里叫 `duration`，GenVideo 叫 `durationSeconds` ——
 * 字段名写错时上游**不报错，直接忽略**（按默认值出片）。2026-09-25 对账时就是这样丢的
 * mode 与时长：任务显示成功、我们按 2.5 的价钱卖，上游却按 2.0 出了 5 秒的片子。
 * 所以字段名与固定值一律走声明：没声明就原样透传，绝不猜（猜错就是打错上游）。
 *
 * 声明位置（capabilityJson，与前端 model-params.ts 认的两套写法一致）：
 *   "params": {
 *     "ratio":    { "options": [{"label":"16:9 横版","key":"16:9"}, ...], "default": "16:9" },
 *     "duration": { "options": [{"label":"30 秒","key":"30"}], "default": "30" }
 *   },
 *   "createParams": { "mode": "2.5", "durationField": "durationSeconds", "imagesField": "images" }
 */
export interface VideoCreateContract {
  /** 建单必发的固定参数（GenVideo 的 `mode: "2.5"`；不传上游按 2.0，只出 5/10 秒） */
  fixedParams: Record<string, string | number>;
  /** 时长字段名；不声明时沿用调用方给的字段名（`duration`） */
  durationField?: string;
  /** 模型允许的时长（秒） */
  allowedDurations: number[];
  /** 模型允许的画幅（上游口径，冒号形式） */
  allowedRatios: string[];
  /** 声明的默认画幅/时长：纠正表外值时优先纠到这里（没有就用第一个档位） */
  defaultRatio?: string;
  defaultDuration?: number;
  /** 参考图字段名：`images` → `[{url}]`，其它（如 `image_urls`）→ `[string]` */
  imagesField?: string;
}

const readObjectRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const readChoiceSeconds = (value: unknown): number[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const raw =
        item && typeof item === "object"
          ? ((item as Record<string, unknown>).key ??
            (item as Record<string, unknown>).value)
          : item;
      return Number(raw);
    })
    .filter((seconds) => Number.isFinite(seconds) && seconds > 0);
};

/** 比例归一化成上游口径（冒号形式）：`16x9` → `16:9` */
export const normalizeRatioKey = (value: unknown): string =>
  String(value ?? "")
    .trim()
    .replace(/[xX×]/g, ":");

/**
 * 读一个维度（比例 / 时长）的候选与默认值。
 * 两套后台写法都要认（与前端 model-params.ts 的 readDeclaredDimension 同一套约定）：
 *   "params": { "ratio": { "options": [...], "default": "16:9" } }   // 推荐
 *   "ratios": [ ... ]                                                // 顶层快捷写法
 */
const readDeclaredDimension = (
  capability: Record<string, unknown>,
  dimension: string,
): { keys: unknown[]; fallbackDefault: string } => {
  const params = readObjectRecord(capability.params);
  const raw =
    params[dimension] ?? capability[`${dimension}s`] ?? capability[dimension];
  if (Array.isArray(raw)) return { keys: raw, fallbackDefault: "" };
  const record = readObjectRecord(raw);
  return {
    keys: Array.isArray(record.options) ? (record.options as unknown[]) : [],
    fallbackDefault: String(record.default ?? "").trim(),
  };
};

export const resolveVideoCreateContract = (
  capability: unknown,
): VideoCreateContract => {
  const capabilityRecord = readObjectRecord(capability);
  const createParams = readObjectRecord(capabilityRecord.createParams);
  const fixedParams: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(createParams)) {
    // 这两个是字段名映射，不是要发给上游的参数
    if (key === "durationField" || key === "imagesField") continue;
    if (typeof value === "string" && value.trim())
      fixedParams[key] = value.trim();
    else if (typeof value === "number" && Number.isFinite(value))
      fixedParams[key] = value;
  }

  const declaredRatio = readDeclaredDimension(capabilityRecord, "ratio");
  const declaredDuration = readDeclaredDimension(capabilityRecord, "duration");
  const allowedRatios = declaredRatio.keys
    .map((item) =>
      item && typeof item === "object"
        ? ((item as Record<string, unknown>).key ??
          (item as Record<string, unknown>).value)
        : item,
    )
    .map(normalizeRatioKey)
    .filter(Boolean);
  const declaredDefaultDuration = Number(declaredDuration.fallbackDefault);

  return {
    fixedParams,
    durationField: String(createParams.durationField || "").trim() || undefined,
    allowedDurations: readChoiceSeconds(declaredDuration.keys),
    allowedRatios,
    defaultRatio: normalizeRatioKey(declaredRatio.fallbackDefault) || undefined,
    defaultDuration:
      Number.isFinite(declaredDefaultDuration) && declaredDefaultDuration > 0
        ? declaredDefaultDuration
        : undefined,
    imagesField: String(createParams.imagesField || "").trim() || undefined,
  };
};

/** 从请求体里把参考图捞出来（三种历史写法都认） */
export const readRequestImageUrls = (
  body: Record<string, unknown>,
): string[] => {
  for (const key of [
    "images",
    "image_urls",
    "referenceImages",
    "reference_images",
  ]) {
    const value = body[key];
    if (Array.isArray(value) && value.length) {
      return value
        .map((item) =>
          item && typeof item === "object"
            ? String((item as Record<string, unknown>).url ?? "").trim()
            : String(item ?? "").trim(),
        )
        .filter(Boolean);
    }
  }
  return [];
};

const pickClosestDuration = (
  seconds: number | undefined,
  allowed: number[],
) => {
  if (!Number.isFinite(seconds)) return allowed[0];
  return allowed.reduce((best, item) =>
    Math.abs(item - (seconds as number)) < Math.abs(best - (seconds as number))
      ? item
      : best,
  );
};

export interface VideoCreateNormalization {
  body: Record<string, unknown>;
  /** 纠正过的地方（字段名/时长/比例），调用方据此留痕，避免"静默改参数" */
  adjustments: string[];
}

/**
 * 把内部请求体归一化成上游契约的样子。
 * 三条硬约束（都是上游文档写死、错了不报错的）：
 *   1. `mode` 必须显式发（不传按 2.0）；
 *   2. 时长字段名按契约（GenVideo 是 `durationSeconds`）；
 *   3. 时长必须落在模型允许的档位上（2.5 只有 30 秒，调用方给 5 秒就纠到 30 秒）。
 */
export const normalizeVideoCreateBody = (input: {
  body: Record<string, unknown>;
  contract: VideoCreateContract;
  /** 已解析成上游可访问地址的参考图（由 resolveUpstreamImageUrls 产出） */
  referenceImages?: string[];
}): VideoCreateNormalization => {
  const body: Record<string, unknown> = { ...input.body };
  const adjustments: string[] = [];
  const { contract } = input;

  // 1) 固定参数（mode 等）：契约优先
  for (const [key, value] of Object.entries(contract.fixedParams)) {
    if (body[key] !== undefined && String(body[key]) !== String(value)) {
      adjustments.push(
        `${key}: ${String(body[key])} → ${String(value)}（按模型能力声明固定）`,
      );
    }
    body[key] = value;
  }

  // 2) 时长：统一到契约字段名，并按允许档位纠正
  const durationField = contract.durationField || "duration";
  const durationAliases = [
    "duration",
    "durationSeconds",
    "seconds",
    "videoSeconds",
  ];
  const rawDurationValue = durationAliases
    .map((key) => body[key])
    .find(
      (value) =>
        value !== undefined && value !== null && String(value).trim() !== "",
    );
  let duration: number | undefined = Number.isFinite(Number(rawDurationValue))
    ? Number(rawDurationValue)
    : undefined;
  if (contract.allowedDurations.length) {
    if (
      duration === undefined ||
      !contract.allowedDurations.includes(duration)
    ) {
      const corrected = contract.allowedDurations.includes(
        Number(contract.defaultDuration),
      )
        ? Number(contract.defaultDuration)
        : pickClosestDuration(duration, contract.allowedDurations);
      adjustments.push(
        `时长: ${duration === undefined ? "未指定" : duration} → ${corrected} 秒（模型只支持 ${contract.allowedDurations.join(" / ")} 秒）`,
      );
      duration = corrected;
    }
  }
  if (duration !== undefined) {
    for (const key of durationAliases) {
      if (key !== durationField) delete body[key];
    }
    body[durationField] = duration;
  }

  // 3) 画幅：上游要冒号形式，且必须在模型允许的档位里
  if (contract.allowedRatios.length) {
    const rawRatio = body.ratio ?? body.aspectRatio;
    const normalizedRatio = normalizeRatioKey(rawRatio);
    const targetRatio = contract.allowedRatios.includes(
      String(contract.defaultRatio),
    )
      ? String(contract.defaultRatio)
      : contract.allowedRatios[0];
    if (!normalizedRatio) {
      body.ratio = targetRatio;
      adjustments.push(`比例: 未指定 → ${targetRatio}`);
    } else if (!contract.allowedRatios.includes(normalizedRatio)) {
      adjustments.push(
        `比例: ${String(rawRatio)} → ${targetRatio}（模型只支持 ${contract.allowedRatios.join(" / ")}）`,
      );
      body.ratio = targetRatio;
    } else {
      body.ratio = normalizedRatio;
    }
  }

  // 4) 参考图：字段名与形状都按契约
  if (contract.imagesField) {
    const urls = (input.referenceImages || [])
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    for (const key of [
      "images",
      "image_urls",
      "referenceImages",
      "reference_images",
      "reference_frames",
    ]) {
      delete body[key];
    }
    if (urls.length > VIDEO_UPSTREAM_MAX_IMAGES) {
      // 静默丢参考图会让成片人物/场景对不上，用户看不出原因 —— 宁可明确报错
      throw new Error(
        `参考图最多 ${VIDEO_UPSTREAM_MAX_IMAGES} 张（上游限制），当前 ${urls.length} 张`,
      );
    }
    if (urls.length) {
      body[contract.imagesField] =
        contract.imagesField === "images" ? urls.map((url) => ({ url })) : urls;
    }
  }

  return { body, adjustments };
};

// ---------------------------------------------------------------------------
// 参考图可达性：上游必须能自己取到图，我们本地 /uploads 相对地址它取不到
// ---------------------------------------------------------------------------

const probeImageReachability = async (input: {
  url: string;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
}): Promise<{ ok: boolean; status: number; error?: string }> => {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1000, Number(input.timeoutMs) || REFERENCE_IMAGE_PROBE_TIMEOUT_MS),
  );
  try {
    let response = await input.fetchImpl(input.url, {
      method: "HEAD",
      signal: controller.signal,
    });
    // 有些静态站不支持 HEAD（405/501）：退回 GET，只看响应头，拿到就把 body 掐掉
    if (response.status === 405 || response.status === 501) {
      response = await input.fetchImpl(input.url, {
        method: "GET",
        headers: { Range: "bytes=0-0" },
        signal: controller.signal,
      });
    }
    void response.body?.cancel?.().catch(() => {});
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 把参考图解析成"上游真能取到"的绝对地址，取不到就明确报错。
 *
 * 为什么宁可报错也不放行：上游对取不到的参考图是**静默忽略**的 ——
 * 出片照出，只是人物/风格跟参考图完全不像，用户看不懂哪里错了，钱也已经花了。
 * 现在已知两个取不到的情形：
 *   1. 我们自己的本地地址 `/uploads/...`（除非配了公网基址 PUBLIC_ASSET_BASE_URL）；
 *   2. base64 内联图（`data:...`）—— 上游只接受 URL，不接受上传。
 *
 * 相对地址的处理顺序（2026-09-26 起）：
 *   有基址 → 直接拼绝对地址探测，**能取到就不重复上传**；
 *   探测不过（或本来没基址）→ 若配了「参考图发布」（asset-publish）→ 发布到公网后再探测一次；
 *   仍不行 → 保留清晰的报错，并把发布失败原因一并带上（不能把原因吞掉）。
 *   未配置发布时，行为与改动前**完全一致**。
 */
export const resolveUpstreamImageUrls = async (input: {
  images: string[];
  publicAssetBaseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** 发布配置；不传则按环境读取（未配置时行为与改动前完全一致） */
  publishConfig?: AssetPublishConfig | null;
  /** 发布实现（测试注入）；默认走 asset-publish 的真实 ssh/scp */
  publishImpl?: (
    relativePath: string,
    config: AssetPublishConfig,
  ) => AssetPublishResult;
  /** 日志出口，默认 console.log */
  log?: (line: string) => void;
}): Promise<string[]> => {
  const fetchImpl = input.fetchImpl || fetch;
  const publishConfig =
    input.publishConfig !== undefined
      ? input.publishConfig
      : resolveAssetPublishConfig();
  const publishImpl =
    input.publishImpl ||
    ((relativePath, config) => publishLocalUploadIfNeeded(relativePath, { config }));
  // 基址优先用调用方给的；没有时用发布配置自带的（发布配置里必须含 PUBLIC_ASSET_BASE_URL）
  const base = String(
    input.publicAssetBaseUrl || publishConfig?.publicBaseUrl || "",
  )
    .trim()
    .replace(/\/+$/, "");
  const resolved: string[] = [];
  const problems: string[] = [];

  const describeProbeFailure = (probe: {
    status: number;
    error?: string;
  }) =>
    probe.status ? `HTTP ${probe.status}` : `不可达：${probe.error || "未知错误"}`;

  for (const raw of input.images) {
    const value = String(raw || "").trim();
    if (!value) continue;

    if (/^data:/i.test(value)) {
      problems.push("内联 base64 参考图（上游只接受可访问的 URL，不接受上传）");
      continue;
    }

    if (/^https?:\/\//i.test(value)) {
      const probe = await probeImageReachability({
        url: value,
        fetchImpl,
        timeoutMs: input.timeoutMs,
      });
      if (!probe.ok) {
        problems.push(`${value}（探测失败：${describeProbeFailure(probe)}）`);
        continue;
      }
      resolved.push(value);
      continue;
    }

    if (!value.startsWith("/")) {
      problems.push(`${value}（不是可访问的 http(s) 地址）`);
      continue;
    }

    // 本站相对地址：先按基址探测；探测不过（或本来没基址）再尝试发布到公网
    let directProbeFailure = "";
    if (base) {
      const directUrl = mapUploadPathToPublicUrl(value, base);
      const probeStartedAt = Date.now();
      const probe = await probeImageReachability({
        url: directUrl,
        fetchImpl,
        timeoutMs: input.timeoutMs,
      });
      if (probe.ok) {
        // 已经取得到：不重复上传
        logAssetPublish(
          "skipped",
          {
            relativePath: value,
            publicUrl: directUrl,
            remotePath: publishConfig
              ? mapUploadPathToRemotePath(value, publishConfig.remoteDir)
              : "",
            durationMs: Date.now() - probeStartedAt,
            reason: "already_reachable",
          },
          input.log,
        );
        resolved.push(directUrl);
        continue;
      }
      directProbeFailure = describeProbeFailure(probe);
    }

    // 探测不过（或没有基址）：发布到公网后再探测一次
    let publishFailure = "";
    if (publishConfig) {
      const published = publishImpl(value, publishConfig);
      if (published.ok) {
        const publishedUrl = mapUploadPathToPublicUrl(value, base);
        const reprobe = await probeImageReachability({
          url: publishedUrl,
          fetchImpl,
          timeoutMs: input.timeoutMs,
        });
        if (reprobe.ok) {
          resolved.push(publishedUrl);
          continue;
        }
        problems.push(
          `${publishedUrl}（探测失败：${describeProbeFailure(reprobe)}；已发布到公网但仍不可达）`,
        );
        continue;
      }
      publishFailure = published.reason
        ? `；已尝试发布到公网但失败：${published.reason}`
        : "；已尝试发布到公网但失败";
    }

    if (!base) {
      problems.push(
        `${value}（本站相对地址，上游取不到；未配置公网基址 PUBLIC_ASSET_BASE_URL${publishFailure}）`,
      );
    } else {
      problems.push(
        `${mapUploadPathToPublicUrl(value, base)}（探测失败：${directProbeFailure}${publishFailure}）`,
      );
    }
  }

  if (problems.length) {
    throw new Error(
      `参考图无法被上游取到，已中止本次生成（否则上游会静默忽略，成片对不上）：${problems.join("；")}`,
    );
  }

  return resolved;
};
