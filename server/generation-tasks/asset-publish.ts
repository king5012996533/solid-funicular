/**
 * 把本地参考图发布到「上游取得到」的公网位置（2026-09-26）。
 *
 * 为什么需要它：视频上游（seedance2.5 → ai-genvideo.com）要自己去取参考图，而我们的参考图是
 * 本站相对地址 `/uploads/...`，上游取不到我们的 localhost，本地开发也没有公网入口。
 * 实测可用的通道：把文件 scp 到 VPS 上 nginx 已用 alias 暴露的目录
 * （`/root/infinite-canvas/web/public/showcase/canana`），公网即可取到
 * `https://xingtudesign.com/showcase/canana/<相对路径>` —— 线上 nginx 不用改一行配置。
 *
 * 三条硬约束：
 *   1. **未配置即不启用**：四个变量缺一就返回 null，`resolveUpstreamImageUrls` 的行为与从前完全一致。
 *   2. **任何失败都不抛**：生产容器里可能没有 ssh/scp、也没配密钥，返回 not ok + reason 让调用方优雅降级，
 *      绝不能因为发布失败把整条生成任务带崩。
 *   3. 命令一律以 argv 数组交给 `spawnSync`（shell:false），避免 Windows/cmd 下的引号与反斜杠问题。
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export interface AssetPublishConfig {
  /** 公网基址（PUBLIC_ASSET_BASE_URL，已去尾部斜杠），如 https://xingtudesign.com/showcase/canana */
  publicBaseUrl: string;
  /** SSH 目标（ASSET_PUBLISH_SSH_TARGET），如 root@8.163.71.55 */
  sshTarget: string;
  /** SSH 私钥路径（ASSET_PUBLISH_SSH_KEY） */
  sshKeyPath: string;
  /** 远端发布根目录（ASSET_PUBLISH_REMOTE_DIR，已去尾部斜杠） */
  remoteDir: string;
}

export interface AssetPublishResult {
  ok: boolean;
  /** 幂等跳过（远端已存在同名文件，没必要再传） */
  skipped?: boolean;
  /** 失败或跳过原因（失败时会被调用方拼进错误信息，不能吞） */
  reason?: string;
  /** 远端文件绝对路径 */
  remotePath?: string;
  durationMs: number;
}

/** 发布流程的依赖注入点（默认走真实环境；测试注入以避开真实网络/文件系统） */
export interface AssetPublishDeps {
  /** 显式指定配置；传 null 表示强制禁用（不读环境） */
  config?: AssetPublishConfig | null;
  /** 上传根目录；默认读 UPLOADS_DIR */
  uploadsDir?: string;
  /** spawnSync 实现，测试可注入 */
  spawnImpl?: typeof spawnSync;
  /** 本地文件存在性判断，测试可注入 */
  existsImpl?: (filePath: string) => boolean;
  /** 日志出口，默认 console.log */
  log?: (line: string) => void;
}

// 与 server/storage/service.ts 的 readUploadsDir 同一套约定；不直接 import 那里是为了
// 不把 prisma（storage-config/service → db/prisma）拖进本模块的 import 链，否则单测一 import 就跑不动。
const DEFAULT_UPLOADS_DIR = path.resolve(process.cwd(), "uploads");

const readUploadsDir = () => {
  const configuredDir = String(process.env.UPLOADS_DIR || "").trim();
  return configuredDir ? path.resolve(configuredDir) : DEFAULT_UPLOADS_DIR;
};

const stripTrailingSlashes = (value: string) => value.replace(/\/+$/, "");

const stripLeadingSlashes = (value: string) => value.replace(/^\/+/, "");

// 相对路径里的重复斜杠（`uploads//a.png`）也要归一，否则远端目录看着一样、实际不同
const collapseSlashes = (value: string) => value.replace(/\/{2,}/g, "/");

const normalizeUrlRelativePath = (relativePath: unknown) =>
  collapseSlashes(stripLeadingSlashes(String(relativePath ?? "").trim()));

/**
 * 本站相对地址 → 上游可取到的公网绝对地址。
 * `/uploads/a/b.png` + `https://host/showcase/canana/` → `https://host/showcase/canana/uploads/a/b.png`
 */
export const mapUploadPathToPublicUrl = (
  relativePath: string,
  base: string,
): string => {
  const trimmedBase = stripTrailingSlashes(String(base ?? "").trim());
  const relative = normalizeUrlRelativePath(relativePath);
  if (!relative) return trimmedBase;
  if (!trimmedBase) return `/${relative}`;
  return `${trimmedBase}/${relative}`;
};

/**
 * 本站相对地址 → 远端磁盘绝对路径（远端是 POSIX，不能用 path.join，Windows 会拼成反斜杠）。
 * `/uploads/a/b.png` + `/root/x/showcase/canana` → `/root/x/showcase/canana/uploads/a/b.png`
 *
 * 注意这里**保留 `uploads/` 这一段**：远端目录就是 URL 的镜像根，
 * 公网地址 = publicBaseUrl + `/uploads/...`，两边必须对得上（见 mapUploadPathToPublicUrl）。
 */
export const mapUploadPathToRemotePath = (
  relativePath: string,
  remoteDir: string,
): string => {
  const trimmedDir = stripTrailingSlashes(String(remoteDir ?? "").trim());
  const relative = normalizeUrlRelativePath(relativePath);
  if (!relative) return trimmedDir;
  if (!trimmedDir) return relative;
  return `${trimmedDir}/${relative}`;
};

/**
 * 本地磁盘候选路径。
 *
 * 关键事实：上传文件的公网地址是 `/uploads/generated/image/<日期>/<文件>`，
 * 而 `UPLOADS_DIR` 指向的是 uploads 目录本身（如 `.env.development` 的 `UPLOADS_DIR=uploads`），
 * 所以磁盘真实路径要**去掉 `/uploads/` 这一层前缀**（`<UPLOADS_DIR>/generated/image/...`）。
 * 同时给「UPLOADS_DIR 指向项目根」的部署留一个兜底候选（`<UPLOADS_DIR>/uploads/...`），
 * 两个候选哪个存在用哪个。
 */
export const buildLocalFileCandidates = (
  uploadsDir: string,
  relativePath: string,
): string[] => {
  const relative = normalizeUrlRelativePath(relativePath);
  const withinUploads = relative.startsWith("uploads/")
    ? relative.slice("uploads/".length)
    : relative;
  const toAbsolute = (value: string) =>
    path.join(uploadsDir, ...value.split("/").filter(Boolean));
  return Array.from(new Set([toAbsolute(withinUploads), toAbsolute(relative)]));
};

/** 四个变量齐全才算启用；否则返回 null（调用方据此保持旧行为） */
export const resolveAssetPublishConfig = (
  env: NodeJS.ProcessEnv = process.env,
): AssetPublishConfig | null => {
  const publicBaseUrl = stripTrailingSlashes(
    String(env.PUBLIC_ASSET_BASE_URL || "").trim(),
  );
  const sshTarget = String(env.ASSET_PUBLISH_SSH_TARGET || "").trim();
  const sshKeyPath = String(env.ASSET_PUBLISH_SSH_KEY || "").trim();
  const remoteDir = stripTrailingSlashes(
    String(env.ASSET_PUBLISH_REMOTE_DIR || "").trim(),
  );
  if (!publicBaseUrl || !sshTarget || !sshKeyPath || !remoteDir) return null;
  return { publicBaseUrl, sshTarget, sshKeyPath, remoteDir };
};

export type AssetPublishStatus = "skipped" | "published" | "failed";

/** 统一日志格式：`asset_publish:<状态> {json}` —— 验收就靠 grep 这个前缀 */
export const logAssetPublish = (
  status: AssetPublishStatus,
  detail: Record<string, unknown>,
  log?: (line: string) => void,
) => {
  const line = `asset_publish:${status} ${JSON.stringify(detail)}`;
  (log || ((value: string) => console.log(value)))(line);
};

interface SpawnOutcome {
  ok: boolean;
  status: number | null;
  reason?: string;
}

// spawnSync 对「命令不存在」不抛异常，而是把错误放在 result.error 上，这里统一收口；
// 外面再包一层 try/catch，保证任何情况下都不往外抛。
const runCommand = (
  spawn: typeof spawnSync,
  command: string,
  args: string[],
  timeoutMs: number,
  cwd?: string,
): SpawnOutcome => {
  try {
    const result = spawn(command, args, {
      timeout: timeoutMs,
      windowsHide: true,
      encoding: "utf8",
      ...(cwd ? { cwd } : {}),
    });
    if (result.error) {
      return { ok: false, status: result.status ?? null, reason: result.error.message };
    }
    const status = typeof result.status === "number" ? result.status : null;
    if (status !== 0) {
      const stderr = String(result.stderr || "").trim();
      return {
        ok: false,
        status,
        reason: `${command} 退出码 ${status ?? "null"}${stderr ? `：${stderr.slice(0, 200)}` : ""}`,
      };
    }
    return { ok: true, status: 0 };
  } catch (error) {
    return {
      ok: false,
      status: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * 把本地 `/uploads/...` 文件发布到公网可达位置（幂等：远端已有就跳过）。
 *
 * 流程：ssh mkdir -p 远端目录 → ssh test -f 远端文件（在就跳过）→ scp 上传。
 * **任何一步失败都不抛**，返回 `{ ok:false, reason }`；未配置时直接 ok:false。
 */
export const publishLocalUploadIfNeeded = (
  relativePath: string,
  deps: AssetPublishDeps = {},
): AssetPublishResult => {
  const startedAt = Date.now();
  const relative = normalizeUrlRelativePath(relativePath);
  const config =
    deps.config !== undefined ? deps.config : resolveAssetPublishConfig();
  const remotePath = config
    ? mapUploadPathToRemotePath(relative, config.remoteDir)
    : "";
  const log = deps.log;

  const finish = (
    result: Omit<AssetPublishResult, "durationMs"> & { durationMs?: number },
  ): AssetPublishResult => {
    const durationMs = result.durationMs ?? Date.now() - startedAt;
    const finalRemotePath = result.remotePath ?? remotePath;
    const status: AssetPublishStatus = !result.ok
      ? "failed"
      : result.skipped
        ? "skipped"
        : "published";
    logAssetPublish(
      status,
      {
        // 记原始相对地址（`/uploads/...`），便于和其它日志对照
        relativePath: String(relativePath ?? "").trim(),
        remotePath: finalRemotePath,
        durationMs,
        ...(result.reason ? { reason: result.reason } : {}),
      },
      log,
    );
    return {
      ...result,
      ...(finalRemotePath ? { remotePath: finalRemotePath } : {}),
      durationMs,
    };
  };

  if (!relative) {
    return finish({ ok: false, reason: "参考图地址为空，无法发布" });
  }
  if (!config) {
    return finish({
      ok: false,
      reason:
        "未配置参考图发布（PUBLIC_ASSET_BASE_URL / ASSET_PUBLISH_SSH_TARGET / ASSET_PUBLISH_SSH_KEY / ASSET_PUBLISH_REMOTE_DIR 需齐全）",
    });
  }

  const exists = deps.existsImpl || fs.existsSync;
  const candidates = buildLocalFileCandidates(
    deps.uploadsDir || readUploadsDir(),
    relative,
  );
  const localFile = candidates.find((candidate) => exists(candidate));
  if (!localFile) {
    return finish({
      ok: false,
      reason: `本地文件不存在：${candidates.join(" 或 ")}`,
    });
  }

  const spawn = deps.spawnImpl || spawnSync;
  const sshArgs = [
    "-i",
    config.sshKeyPath,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=10",
  ];
  const remoteDir = path.posix.dirname(remotePath);

  const mkdir = runCommand(
    spawn,
    "ssh",
    [...sshArgs, config.sshTarget, "mkdir", "-p", remoteDir],
    20_000,
  );
  if (!mkdir.ok) {
    return finish({ ok: false, reason: `创建远端目录失败：${mkdir.reason}` });
  }

  const remoteExists = runCommand(
    spawn,
    "ssh",
    [...sshArgs, config.sshTarget, "test", "-f", remotePath],
    20_000,
  );
  if (remoteExists.status === 0) {
    return finish({ ok: true, skipped: true, reason: "远端已存在同名文件，跳过上传" });
  }
  // test 返回 1 = 文件不存在（预期，继续上传）；其余（255 认证失败 / 命令缺失等）才算真失败
  if (remoteExists.status !== 1) {
    return finish({
      ok: false,
      reason: `检查远端文件失败：${remoteExists.reason || "未知错误"}`,
    });
  }

  // scp 源码只传文件名、用 cwd 定位：Windows 下 `C:\...` 里的盘符冒号会被 scp 误当作 host
  const upload = runCommand(
    spawn,
    "scp",
    [
      "-i",
      config.sshKeyPath,
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=10",
      path.basename(localFile),
      `${config.sshTarget}:${remotePath}`,
    ],
    60_000,
    path.dirname(localFile),
  );
  if (!upload.ok) {
    return finish({ ok: false, reason: `上传失败：${upload.reason}` });
  }

  return finish({ ok: true });
};
