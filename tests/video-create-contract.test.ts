/**
 * 视频建单契约的纯逻辑验证（2026-09-25）
 *
 * 这段逻辑回答的是「发到上游的字段名与固定值对不对」——上游对写错的字段名**不报错、直接忽略**，
 * 所以只能靠这里钉死：mode 必须发 2.5（不传按 2.0）、时长字段名是 durationSeconds、
 * 2.5 只有 30 秒这一档、参考图必须写成上游能取到的 URL。
 * 用真实渠道（GenVideo / Seedance 2.5）的能力声明做样本，声明来源与入库脚本同一份
 * （scripts/lib/video-model-upstream-config.mjs），避免"库里改了、测试还按老的断言"。
 */

import {
  VIDEO_UPSTREAM_MAX_IMAGES,
  normalizeVideoCreateBody,
  readRequestImageUrls,
  resolveUpstreamImageUrls,
  resolveVideoCreateContract,
} from "../server/generation-tasks/video-create-contract";
import { resolveVideoParamSchema } from "../src/config/model-params";
import type { VideoModel } from "../src/config/models";
import { VIDEO_MODEL_CAPABILITY } from "../scripts/lib/video-model-upstream-config.mjs";

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
  console.error(`  FAIL ${label}:\n       期望 ${e}\n       实际 ${a}`);
}

async function checkThrows(
  label: string,
  run: () => Promise<unknown> | unknown,
  mustContain: string,
) {
  try {
    await run();
    failed += 1;
    console.error(`  FAIL ${label}: 期望抛错，实际没抛`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(mustContain)) {
      passed += 1;
      console.log(`  ok   ${label} → 抛错（含「${mustContain}」）`);
    } else {
      failed += 1;
      console.error(
        `  FAIL ${label}: 抛错信息不含「${mustContain}」：${message}`,
      );
    }
  }
}

const videoModel = (overrides: Partial<VideoModel> = {}): VideoModel => ({
  id: "m-sceneflow-genvideo-2-5-0",
  key: "seedance2.5",
  label: "seedance2.5",
  modelKey: "seedance2.5",
  providerId: "p-sceneflow-genvideo-2-5",
  providerCode: "sceneflow-genvideo-2-5",
  providerName: "genvideo-2.5",
  description: "",
  capabilityJson: VIDEO_MODEL_CAPABILITY,
  defaultParams: { ratio: "16:9", duration: 30, resolution: "720p" },
  sortOrder: 0,
  isDefault: true,
  ratios: [],
  durs: [],
  ...overrides,
});

console.log("\n【1】契约解析：字段名与固定值都来自模型能力声明");
const contract = resolveVideoCreateContract(VIDEO_MODEL_CAPABILITY);
check("mode 固定值", contract.fixedParams.mode, "2.5");
check("时长字段名", contract.durationField, "durationSeconds");
check("参考图字段名", contract.imagesField, "images");
check("允许时长", contract.allowedDurations, [30]);
check("默认时长", contract.defaultDuration, 30);
check("默认画幅", contract.defaultRatio, "16:9");
check("允许画幅（六种，上游口径）", contract.allowedRatios, [
  "21:9",
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
]);

console.log("\n【2】没有声明的厂商不受影响（回归：H3 / Replicate 走原样透传）");
const emptyContract = resolveVideoCreateContract(null);
check("无声明 → 无固定参数", emptyContract.fixedParams, {});
check("无声明 → 时长字段名交给调用方", emptyContract.durationField, undefined);
const passthrough = normalizeVideoCreateBody({
  body: {
    model: "H3",
    prompt: "x",
    ratio: "16x9",
    duration: 5,
    image_urls: ["https://cdn.example.com/a.png"],
  },
  contract: emptyContract,
});
check("无声明 → 请求体原样不变", passthrough.body, {
  model: "H3",
  prompt: "x",
  ratio: "16x9",
  duration: 5,
  image_urls: ["https://cdn.example.com/a.png"],
});
check("无声明 → 没有纠正记录", passthrough.adjustments, []);

console.log(
  "\n【3】用户选了 5 秒（UI 老数据）→ 在我们这层就纠到 30 秒，并为 2.5 补上 mode",
);
const normalized = normalizeVideoCreateBody({
  body: {
    providerId: "p-sceneflow-genvideo-2-5",
    model: "seedance2.5",
    prompt: "雪夜里的便利店，镜头缓慢推近",
    ratio: "9x16",
    resolution: "720p",
    duration: 5,
    image_urls: ["https://cdn.example.com/ref/1.png"],
  },
  contract,
  referenceImages: ["https://cdn.example.com/ref/1.png"],
});
check("mode = 2.5（必发）", normalized.body.mode, "2.5");
check("时长字段名 = durationSeconds", normalized.body.durationSeconds, 30);
check(
  "旧的 duration 字段被删掉（否则上游按未知字段忽略）",
  "duration" in normalized.body,
  false,
);
check("比例归一成冒号形式", normalized.body.ratio, "9:16");
check("参考图改成上游口径 images:[{url}]", normalized.body.images, [
  { url: "https://cdn.example.com/ref/1.png" },
]);
check("旧的 image_urls 字段被删掉", "image_urls" in normalized.body, false);
check(
  "保留了提示词/分辨率",
  [normalized.body.prompt, normalized.body.resolution],
  ["雪夜里的便利店，镜头缓慢推近", "720p"],
);
check("纠正记录（时长 + 比例写法）", normalized.adjustments, [
  "时长: 5 → 30 秒（模型只支持 30 秒）",
]);

console.log("\n【4】表外的画幅 → 纠到声明的默认档（16:9）");
const badRatio = normalizeVideoCreateBody({
  body: { ratio: "3:2", duration: 30 },
  contract,
});
check("画幅 3:2 → 16:9", badRatio.body.ratio, "16:9");
check("纠正记录", badRatio.adjustments.length, 1);

console.log("\n【5】参考图超上限（上游最多 10 张）必须明确报错，不能静默丢");
check("上限常量", VIDEO_UPSTREAM_MAX_IMAGES, 10);
const tooMany = Array.from(
  { length: 11 },
  (_, index) => `https://cdn.example.com/${index}.png`,
);
await checkThrows(
  "11 张参考图",
  () =>
    normalizeVideoCreateBody({
      body: { ratio: "16:9", duration: 30 },
      contract,
      referenceImages: tooMany,
    }),
  "最多 10 张",
);

console.log(
  "\n【6】参考图可达性：取不到就明确报错（上游对取不到的图是静默忽略）",
);
const okFetch = (async () =>
  new Response("", { status: 200 })) as unknown as typeof fetch;
const forbiddenFetch = (async () =>
  new Response("", { status: 403 })) as unknown as typeof fetch;
const boomFetch = (async () => {
  throw new Error("connect timeout");
}) as unknown as typeof fetch;

await checkThrows(
  "本地 /uploads 地址（未配公网基址）",
  () =>
    resolveUpstreamImageUrls({
      images: ["/uploads/generated/image/1.png"],
      fetchImpl: okFetch,
    }),
  "PUBLIC_ASSET_BASE_URL",
);
check(
  "配了公网基址 → 转成绝对地址并通过探测",
  await resolveUpstreamImageUrls({
    images: ["/uploads/generated/image/1.png"],
    publicAssetBaseUrl: "https://cdn.example.com/",
    fetchImpl: okFetch,
  }),
  ["https://cdn.example.com/uploads/generated/image/1.png"],
);
await checkThrows(
  "base64 内联图（上游不接受上传）",
  () =>
    resolveUpstreamImageUrls({
      images: ["data:image/png;base64,AAAA"],
      fetchImpl: okFetch,
    }),
  "内联 base64",
);
await checkThrows(
  "公网地址但探测 403",
  () =>
    resolveUpstreamImageUrls({
      images: ["https://cdn.example.com/a.png"],
      fetchImpl: forbiddenFetch,
    }),
  "HTTP 403",
);
await checkThrows(
  "公网地址但不可达（网络错误）",
  () =>
    resolveUpstreamImageUrls({
      images: ["https://cdn.example.com/a.png"],
      fetchImpl: boomFetch,
    }),
  "不可达",
);
check(
  "公网地址可达 → 原样放行",
  await resolveUpstreamImageUrls({
    images: ["https://cdn.example.com/a.png"],
    fetchImpl: okFetch,
  }),
  ["https://cdn.example.com/a.png"],
);

console.log("\n【7】从请求体捞参考图（三种历史写法）");
check(
  "images:[{url}]",
  readRequestImageUrls({ images: [{ url: "https://a/1.png" }] }),
  ["https://a/1.png"],
);
check(
  "image_urls:[string]（前端现状）",
  readRequestImageUrls({ image_urls: ["https://a/2.png"] }),
  ["https://a/2.png"],
);
check(
  "referenceImages:[string]",
  readRequestImageUrls({ referenceImages: ["https://a/3.png"] }),
  ["https://a/3.png"],
);

console.log(
  "\n【8】画布上六种画幅可选 + 时长只有 30 秒（前端 schema 同源解析）",
);
const schema = resolveVideoParamSchema(videoModel());
check("画幅数量", schema.ratios.length, 6);
check(
  "画幅 key（即发给上游的值）",
  schema.ratios.map((item) => item.key),
  ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
);
check("默认画幅", schema.defaultRatio, "16:9");
check(
  "时长档位",
  schema.durations.map((item) => item.key),
  ["30"],
);
check("默认时长", schema.defaultDuration, "30");

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);
