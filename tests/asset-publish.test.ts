/**
 * 参考图发布到公网可达位置的单测（2026-09-26）
 *
 * 背景：视频上游要自己去取参考图，而我们的参考图是本站相对地址 `/uploads/...`，上游取不到 localhost。
 * 这条链路补上「把本地文件 scp 到 nginx 已暴露的公网目录」，本文件钉死三件事：
 *   1. 路径映射对不对（公网 URL / 远端路径 / 本地磁盘候选，含斜杠边界）；
 *   2. 配置不全时 `resolveUpstreamImageUrls` 的行为与改动前**一字不差**；
 *   3. 发布会失败，且失败原因**必须带进错误信息**，不能被吞掉。
 * 另有反证：已经取得到的图**不能**被重复上传；发布"成功"但探测仍不过时不能放行。
 *
 * 跑法：npx tsx tests/asset-publish.test.ts
 */

import path from "node:path";
import type { spawnSync } from "node:child_process";
import {
  buildLocalFileCandidates,
  mapUploadPathToPublicUrl,
  mapUploadPathToRemotePath,
  publishLocalUploadIfNeeded,
  resolveAssetPublishConfig,
} from "../server/generation-tasks/asset-publish";
import type { AssetPublishConfig } from "../server/generation-tasks/asset-publish";
import { resolveUpstreamImageUrls } from "../server/generation-tasks/video-create-contract";

let passed = 0;
let failed = 0;

const check = (label: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed += 1;
    console.log(`  ok   ${label} = ${a}`);
    return;
  }
  failed += 1;
  console.error(`  FAIL ${label}:\n       期望 ${e}\n       实际 ${a}`);
};

const checkTrue = (label: string, cond: boolean, hint = "") => {
  check(label, cond, true);
  if (!cond && hint) console.error(`       ${hint}`);
};

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
      console.error(`  FAIL ${label}: 抛错信息不含「${mustContain}」：${message}`);
    }
  }
}

console.log("\n【1】路径映射：本站相对地址 → 公网 URL / 远端路径");
check(
  "公网 URL（基址无尾斜杠）",
  mapUploadPathToPublicUrl("/uploads/a/b.png", "https://cdn.example.com"),
  "https://cdn.example.com/uploads/a/b.png",
);
check(
  "公网 URL（基址带尾斜杠，去重斜杠）",
  mapUploadPathToPublicUrl("/uploads/a/b.png", "https://cdn.example.com/"),
  "https://cdn.example.com/uploads/a/b.png",
);
check(
  "公网 URL（两侧都有多余斜杠 + 中间重复斜杠都要归一）",
  mapUploadPathToPublicUrl("/uploads//a/b.png", "https://cdn.example.com//base//"),
  "https://cdn.example.com//base/uploads/a/b.png",
);
check(
  "公网 URL（相对地址没前导斜杠也补齐）",
  mapUploadPathToPublicUrl("uploads/a.png", "https://cdn.example.com"),
  "https://cdn.example.com/uploads/a.png",
);
check(
  "公网 URL（空相对地址 → 就是基址）",
  mapUploadPathToPublicUrl("", "https://cdn.example.com/"),
  "https://cdn.example.com",
);
check(
  "远端路径",
  mapUploadPathToRemotePath("/uploads/a/b.png", "/root/infinite-canvas/web/public/showcase/canana"),
  "/root/infinite-canvas/web/public/showcase/canana/uploads/a/b.png",
);
check(
  "远端路径（远端目录带尾斜杠）",
  mapUploadPathToRemotePath("/uploads/a/b.png", "/srv/canana/"),
  "/srv/canana/uploads/a/b.png",
);

console.log("\n【2】本地磁盘候选：UPLOADS_DIR 指向 uploads 目录本身，要去掉 /uploads 前缀");
const uploadsDir = path.join("/tmp", "fake-uploads");
const candidates = buildLocalFileCandidates(uploadsDir, "/uploads/generated/image/1.png");
check(
  "首选候选 = <UPLOADS_DIR>/generated/image/1.png（真实布局）",
  candidates[0],
  path.join(uploadsDir, "generated", "image", "1.png"),
);
check(
  "兜底候选 = <UPLOADS_DIR>/uploads/generated/image/1.png（UPLOADS_DIR 指向项目根时）",
  candidates[1],
  path.join(uploadsDir, "uploads", "generated", "image", "1.png"),
);
check(
  "相对地址本来就没有 uploads/ 前缀 → 候选去重成 1 个",
  buildLocalFileCandidates(uploadsDir, "/generated/image/1.png").length,
  1,
);

console.log("\n【3】配置解析：四个变量齐全才启用");
const fullEnv = {
  PUBLIC_ASSET_BASE_URL: "https://cdn.example.com/showcase/canana/",
  ASSET_PUBLISH_SSH_TARGET: "root@host",
  ASSET_PUBLISH_SSH_KEY: "C:\\Users\\Administrator\\.ssh\\id_ed25519",
  ASSET_PUBLISH_REMOTE_DIR: "/srv/canana/",
};
check("齐全 → 启用（并去尾部斜杠）", resolveAssetPublishConfig(fullEnv), {
  publicBaseUrl: "https://cdn.example.com/showcase/canana",
  sshTarget: "root@host",
  sshKeyPath: "C:\\Users\\Administrator\\.ssh\\id_ed25519",
  remoteDir: "/srv/canana",
});
for (const missing of [
  "PUBLIC_ASSET_BASE_URL",
  "ASSET_PUBLISH_SSH_TARGET",
  "ASSET_PUBLISH_SSH_KEY",
  "ASSET_PUBLISH_REMOTE_DIR",
] as const) {
  const env: Record<string, string> = { ...fullEnv };
  delete env[missing];
  check(`缺 ${missing} → 不启用（null）`, resolveAssetPublishConfig(env), null);
}
check(
  "全空 → 不启用（null）",
  resolveAssetPublishConfig({ PUBLIC_ASSET_BASE_URL: "" }),
  null,
);
// 归一化后的发布配置（字段名与 env 变量名不同，不能直接拿 fullEnv 当配置对象用）
const publishConfig: AssetPublishConfig = {
  publicBaseUrl: "https://cdn.example.com/showcase/canana",
  sshTarget: "root@host",
  sshKeyPath: "C:\\Users\\Administrator\\.ssh\\id_ed25519",
  remoteDir: "/srv/canana",
};

console.log("\n【4】未配置发布时，resolveUpstreamImageUrls 的错误与改动前一字不差");
const okFetch = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
const forbiddenFetch = (async () => new Response("", { status: 403 })) as unknown as typeof fetch;

await checkThrows(
  "相对地址 + 未配基址 + 未配发布（消息保持原样）",
  () =>
    resolveUpstreamImageUrls({
      images: ["/uploads/generated/image/1.png"],
      fetchImpl: okFetch,
      publishConfig: null,
    }),
  "参考图无法被上游取到，已中止本次生成（否则上游会静默忽略，成片对不上）：/uploads/generated/image/1.png（本站相对地址，上游取不到；未配置公网基址 PUBLIC_ASSET_BASE_URL）",
);
await checkThrows(
  "配了基址但探测 403、未配发布（消息保持原样）",
  () =>
    resolveUpstreamImageUrls({
      images: ["/uploads/generated/image/1.png"],
      publicAssetBaseUrl: "https://cdn.example.com",
      fetchImpl: forbiddenFetch,
      publishConfig: null,
    }),
  "参考图无法被上游取到，已中止本次生成（否则上游会静默忽略，成片对不上）：https://cdn.example.com/uploads/generated/image/1.png（探测失败：HTTP 403）",
);

console.log("\n【5】有基址且已可取到 → 直接用，绝不重复上传（反证）");
let publishCalled = 0;
const spyPublish = (): never => {
  publishCalled += 1;
  return undefined as never;
};
check(
  "探测通过 → 用公网地址",
  await resolveUpstreamImageUrls({
    images: ["/uploads/generated/image/1.png"],
    publicAssetBaseUrl: "https://cdn.example.com/",
    fetchImpl: okFetch,
    publishConfig,
    publishImpl: spyPublish,
  }),
  ["https://cdn.example.com/uploads/generated/image/1.png"],
);
check("已可取到时发布实现一次都没被调用", publishCalled, 0);

console.log("\n【6】探测不过 → 发布 → 再探测（成功路径）");
const sequenceFetch = (statuses: number[]) => {
  let index = 0;
  return (async () => {
    const status = statuses[Math.min(index, statuses.length - 1)];
    index += 1;
    return new Response("", { status });
  }) as unknown as typeof fetch;
};
let publishedPath = "";
check(
  "首次 403 → 发布 → 复探 200 → 采用发布后的地址",
  await resolveUpstreamImageUrls({
    images: ["/uploads/generated/image/1.png"],
    publicAssetBaseUrl: "https://cdn.example.com/",
    // 注意：探测现在是「HEAD 非 2xx 再用 GET 复核」（见 video-create-contract.ts 的
    // probeImageReachability），所以"不可达"必须**两个方法都失败**：
    // 第 1 次 HEAD=403、第 2 次 GET=403 → 判定不可达 → 触发发布 → 第 3 次 HEAD=200。
    // 旧夹具写成 [403,200] 时，HEAD+GET 恰好凑成"可达"，发布分支根本不会被执行。
    fetchImpl: sequenceFetch([403, 403, 200]),
    publishConfig,
    publishImpl: (relativePath, config) => {
      publishedPath = mapUploadPathToRemotePath(relativePath, config.remoteDir);
      return { ok: true, durationMs: 1 };
    },
  }),
  ["https://cdn.example.com/uploads/generated/image/1.png"],
);
check("发布实现收到的远端路径正确", publishedPath, "/srv/canana/uploads/generated/image/1.png");

check(
  "没有输入基址但配了发布 → 用发布配置的基址：先探测 403，发布后复探 200",
  await resolveUpstreamImageUrls({
    images: ["/uploads/generated/image/1.png"],
    // 注意：探测现在是「HEAD 非 2xx 再用 GET 复核」（见 video-create-contract.ts 的
    // probeImageReachability），所以"不可达"必须**两个方法都失败**：
    // 第 1 次 HEAD=403、第 2 次 GET=403 → 判定不可达 → 触发发布 → 第 3 次 HEAD=200。
    // 旧夹具写成 [403,200] 时，HEAD+GET 恰好凑成"可达"，发布分支根本不会被执行。
    fetchImpl: sequenceFetch([403, 403, 200]),
    publishConfig,
    publishImpl: () => ({ ok: true, durationMs: 1 }),
  }),
  ["https://cdn.example.com/showcase/canana/uploads/generated/image/1.png"],
);

console.log("\n【7】发布失败 → 错误里必须带出原因（不能被吞）");
await checkThrows(
  "探测 403 + 发布失败 → 中止且带发布失败原因",
  () =>
    resolveUpstreamImageUrls({
      images: ["/uploads/generated/image/1.png"],
      publicAssetBaseUrl: "https://cdn.example.com",
      fetchImpl: forbiddenFetch,
      publishConfig,
      publishImpl: () => ({ ok: false, reason: "测试注入：ssh 不可用", durationMs: 1 }),
    }),
  "已尝试发布到公网但失败：测试注入：ssh 不可用",
);

console.log("\n【8】反证：发布「成功」但复探仍不过 → 不能放行");
await checkThrows(
  "发布 ok 但复探 403 → 报「已发布到公网但仍不可达」",
  () =>
    resolveUpstreamImageUrls({
      images: ["/uploads/generated/image/1.png"],
      publicAssetBaseUrl: "https://cdn.example.com",
      fetchImpl: sequenceFetch([403, 403]),
      publishConfig,
      publishImpl: () => ({ ok: true, durationMs: 1 }),
    }),
  "已发布到公网但仍不可达",
);

console.log("\n【9】publishLocalUploadIfNeeded：失败一律不抛，优雅降级");
const realConfig = publishConfig;
const noSpawn = () => {
  throw new Error("不该走到 spawn");
};
check(
  "未配置 → ok:false + reason（不 spawn）",
  publishLocalUploadIfNeeded("/uploads/a.png", {
    config: null,
    spawnImpl: noSpawn as unknown as typeof spawnSync,
    existsImpl: () => true,
    log: () => {},
  }).ok,
  false,
);
check(
  "本地文件不存在 → ok:false + reason 指出路径（不 spawn）",
  publishLocalUploadIfNeeded("/uploads/a.png", {
    config: realConfig,
    uploadsDir,
    spawnImpl: noSpawn as unknown as typeof spawnSync,
    existsImpl: () => false,
    log: () => {},
  }).reason,
  `本地文件不存在：${path.join(uploadsDir, "a.png")} 或 ${path.join(uploadsDir, "uploads", "a.png")}`,
);

type SpawnCall = { command: string; args: string[]; options?: { cwd?: string } };
const makeSpawn = (options: { remoteExists?: boolean; scpStatus?: number; sshStatus?: number }) => {
  const calls: SpawnCall[] = [];
  const impl = ((command: string, args: string[], spawnOptions?: { cwd?: string }) => {
    calls.push({ command, args, options: spawnOptions });
    if (command === "ssh") {
      if (args.includes("test")) {
        return { status: options.remoteExists ? 0 : 1, stderr: "" };
      }
      return { status: options.sshStatus ?? 0, stderr: "" };
    }
    return { status: options.scpStatus ?? 0, stderr: options.scpStatus ? "scp: no route" : "" };
  }) as unknown as typeof spawnSync;
  return { impl, calls };
};

const skipSpawn = makeSpawn({ remoteExists: true });
const skipResult = publishLocalUploadIfNeeded("/uploads/generated/image/1.png", {
  config: realConfig,
  uploadsDir,
  spawnImpl: skipSpawn.impl,
  existsImpl: () => true,
  log: () => {},
});
check("远端已存在 → ok + skipped（幂等）", [skipResult.ok, skipResult.skipped], [true, true]);
check("远端已存在 → 不执行 scp", skipSpawn.calls.some((call) => call.command === "scp"), false);

const okSpawn = makeSpawn({ remoteExists: false, scpStatus: 0 });
const okResult = publishLocalUploadIfNeeded("/uploads/generated/image/1.png", {
  config: realConfig,
  uploadsDir,
  spawnImpl: okSpawn.impl,
  existsImpl: () => true,
  log: () => {},
});
check("正常上传 → ok 且未 skip", [okResult.ok, Boolean(okResult.skipped)], [true, false]);
check("远端路径", okResult.remotePath, "/srv/canana/uploads/generated/image/1.png");
const scpCall = okSpawn.calls.find((call) => call.command === "scp");
checkTrue("确实执行了 scp", Boolean(scpCall));
if (scpCall) {
  check("scp 目标 = target:remotePath", scpCall.args[scpCall.args.length - 1], "root@host:/srv/canana/uploads/generated/image/1.png");
  check("scp 用 cwd 定位本地文件（避免 Windows 盘符冒号被当 host）", scpCall.options?.cwd, path.join(uploadsDir, "generated", "image"));
}

const failSpawn = makeSpawn({ remoteExists: false, scpStatus: 1 });
const failResult = publishLocalUploadIfNeeded("/uploads/generated/image/1.png", {
  config: realConfig,
  uploadsDir,
  spawnImpl: failSpawn.impl,
  existsImpl: () => true,
  log: () => {},
});
check("scp 失败 → ok:false", failResult.ok, false);
checkTrue("失败原因带出 scp 退出码", /上传失败/.test(String(failResult.reason)), String(failResult.reason));

const boomSpawn = (() => {
  throw new Error("spawn 本身抛异常");
}) as unknown as typeof spawnSync;
const boomResult = publishLocalUploadIfNeeded("/uploads/generated/image/1.png", {
  config: realConfig,
  uploadsDir,
  spawnImpl: boomSpawn,
  existsImpl: () => true,
  log: () => {},
});
check("spawn 抛异常也不外抛 → ok:false", boomResult.ok, false);

console.log("\n【10】日志前缀 asset_publish:skipped|published|failed 可验收");
const logLines: string[] = [];
publishLocalUploadIfNeeded("/uploads/generated/image/1.png", {
  config: realConfig,
  uploadsDir,
  spawnImpl: skipSpawn.impl,
  existsImpl: () => true,
  log: (line) => logLines.push(line),
});
checkTrue(
  "幂等跳过 → asset_publish:skipped 且含相对路径/远端路径/耗时",
  logLines.some(
    (line) =>
      line.startsWith("asset_publish:skipped") &&
      line.includes('"relativePath":"/uploads/generated/image/1.png"') &&
      line.includes('"remotePath":"/srv/canana/uploads/generated/image/1.png"') &&
      line.includes("durationMs"),
  ),
  logLines.join("\n"),
);
const publishedLog: string[] = [];
publishLocalUploadIfNeeded("/uploads/generated/image/1.png", {
  config: realConfig,
  uploadsDir,
  spawnImpl: okSpawn.impl,
  existsImpl: () => true,
  log: (line) => publishedLog.push(line),
});
checkTrue(
  "上传成功 → asset_publish:published",
  publishedLog.some((line) => line.startsWith("asset_publish:published")),
  publishedLog.join("\n"),
);
const failedLog: string[] = [];
publishLocalUploadIfNeeded("/uploads/generated/image/1.png", {
  config: realConfig,
  uploadsDir,
  spawnImpl: failSpawn.impl,
  existsImpl: () => true,
  log: (line) => failedLog.push(line),
});
checkTrue(
  "上传失败 → asset_publish:failed 且含原因",
  failedLog.some((line) => line.startsWith("asset_publish:failed") && line.includes("reason")),
  failedLog.join("\n"),
);

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed > 0 ? 1 : 0);
