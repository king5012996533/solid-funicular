/**
 * 产物元数据探测（**唯一有 IO 的一层**，2026-09-27）。
 *
 * `artifact-metadata.ts` 是纯解析；这里负责把字节取回来。两种来源：
 *   1. 本站地址 `/uploads/...`：服务端进程有文件系统权限，直接读盘；
 *   2. 远程地址：用 **Range 请求**只取头部一段（绝不为读个头把 45MB 视频整个吞进内存）。
 *      MP4 的 `moov` 常在文件尾部（非 fast-start），头部找不到时**再取尾部一段重试**。
 *
 * 三条硬约束：
 *   · **任何失败都不抛**：探测只是「尽力填元数据」，拿不到就返回 null，调用方跳过 ——
 *     绝不能因为我们读不到尺寸就把整条已经扣过费的生成任务带崩；
 *   · **单文件读取上限设死**（`MAX_BYTES`）：远程大文件也只读头尾各一段；
 *   · 只接受 `/uploads/` 本站路径与 http(s) 绝对地址，其余一律不碰。
 */

import { open, stat } from 'node:fs/promises'
import path from 'node:path'
import { buildLocalFileCandidates } from '../generation-tasks/asset-publish'
import { parseArtifactMetadata, type ArtifactMetadata } from './artifact-metadata'

/** 头部读取上限：图片/音频头与 fast-start 的 MP4（ftyp+moov 在前）都在这一截里 */
const HEAD_BYTES = 1024 * 1024
/** 尾部重试读取上限：`moov` 在文件尾部时的救济 */
const TAIL_BYTES = 1024 * 1024
/** 单文件读取上限（头 + 尾），防止把大视频整个读进内存 */
const MAX_BYTES = HEAD_BYTES + TAIL_BYTES
const REMOTE_TIMEOUT_MS = 8000

const UPLOADS_URL_PREFIX = '/uploads/'
const DEFAULT_UPLOADS_DIR = path.resolve(process.cwd(), 'uploads')

// 与 server/storage/service.ts 的 readUploadsDir 同一套约定（UPLOADS_DIR 未配则用项目根 uploads）。
const readUploadsDir = () => {
  const configured = String(process.env.UPLOADS_DIR || '').trim()
  return configured ? path.resolve(configured) : DEFAULT_UPLOADS_DIR
}

const mergeMetadata = (base: ArtifactMetadata, extra: ArtifactMetadata): ArtifactMetadata => {
  const merged: ArtifactMetadata = { byteSize: base.byteSize > 0 ? base.byteSize : extra.byteSize }
  const mimeType = base.mimeType || extra.mimeType
  if (mimeType) merged.mimeType = mimeType
  const width = base.width ?? extra.width
  if (width !== undefined) merged.width = width
  const height = base.height ?? extra.height
  if (height !== undefined) merged.height = height
  const durationSeconds = base.durationSeconds ?? extra.durationSeconds
  if (durationSeconds !== undefined) merged.durationSeconds = durationSeconds
  if (base.durationEstimated || extra.durationEstimated) merged.durationEstimated = true
  return merged
}

/** 头部一段是否已经足够：视频还要等 moov（宽高 / 时长），其它格式头就够了 */
const needsTailRetry = (metadata: ArtifactMetadata) =>
  Boolean(metadata.mimeType?.startsWith('video/'))
  && (metadata.durationSeconds === undefined || metadata.width === undefined)

const parseContentRangeTotal = (value: string): number | undefined => {
  const match = /\/(\d+)\s*$/.exec(value)
  if (!match) return undefined
  const total = Number(match[1])
  return Number.isFinite(total) && total > 0 ? total : undefined
}

/**
 * 本站路径：直接读盘。先读头一段，视频不完整时再读尾一段（文件小于头段时一次读完）。
 * 读不到文件（不存在 / 无权限）返回 null。
 */
const probeLocalFile = async (urlPath: string): Promise<ArtifactMetadata | null> => {
  // 传完整公开路径（`/uploads/...`），复用 asset-publish 那套「UPLOADS_DIR 指向 uploads 或其父目录」的候选规则
  for (const candidate of buildLocalFileCandidates(readUploadsDir(), urlPath)) {
    try {
      const info = await stat(candidate)
      if (!info.isFile() || info.size <= 0) continue

      const handle = await open(candidate, 'r')
      try {
        const headLength = Math.min(info.size, HEAD_BYTES)
        const head = Buffer.alloc(headLength)
        const headRead = await handle.read(head, 0, headLength, 0)
        const headMetadata = parseArtifactMetadata(head.subarray(0, headRead.bytesRead), null, {
          totalByteSize: info.size,
        })
        if (info.size <= HEAD_BYTES || !needsTailRetry(headMetadata)) return headMetadata

        const tailLength = Math.min(info.size, TAIL_BYTES)
        const tail = Buffer.alloc(tailLength)
        const tailRead = await handle.read(tail, 0, tailLength, info.size - tailLength)
        const tailMetadata = parseArtifactMetadata(tail.subarray(0, tailRead.bytesRead), headMetadata.mimeType, {
          totalByteSize: info.size,
        })
        return mergeMetadata(headMetadata, tailMetadata)
      } finally {
        await handle.close()
      }
    } catch {
      // 候选路径不存在或不可读：换下一个候选（存在性判断失败不算「探测失败」）
      continue
    }
  }
  return null
}

const readResponseHead = async (response: Response, maxBytes: number): Promise<Uint8Array | null> => {
  const body = response.body
  if (!body) return null
  const reader = body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.length) continue
      const take = Math.min(value.length, maxBytes - total)
      parts.push(value.subarray(0, take))
      total += take
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  if (!total) return null
  const output = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

const fetchRange = async (
  url: string,
  rangeHeader: string,
): Promise<{ bytes: Uint8Array; totalByteSize?: number } | null> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS)
  try {
    const response = await fetch(url, { headers: { Range: rangeHeader }, signal: controller.signal })
    if (!response.ok) return null
    const bytes = await readResponseHead(response, MAX_BYTES)
    if (!bytes) return null
    return { bytes, totalByteSize: parseContentRangeTotal(response.headers.get('content-range') || '') }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const probeRemoteUrl = async (url: string): Promise<ArtifactMetadata | null> => {
  const head = await fetchRange(url, `bytes=0-${HEAD_BYTES - 1}`)
  if (!head) return null
  const headMetadata = parseArtifactMetadata(head.bytes, null, { totalByteSize: head.totalByteSize })
  if (!needsTailRetry(headMetadata)) return headMetadata

  const tail = await fetchRange(url, `bytes=-${TAIL_BYTES}`)
  if (!tail) return headMetadata
  const tailMetadata = parseArtifactMetadata(tail.bytes, headMetadata.mimeType, {
    totalByteSize: head.totalByteSize ?? tail.totalByteSize,
  })
  return mergeMetadata(headMetadata, tailMetadata)
}

/**
 * 给一个产物 URL 返回元数据；拿不到返回 null。
 * 本站 `/uploads/...` 走磁盘，绝对 http(s) 地址走 Range 请求，其余直接跳过。
 */
export const probeArtifactMetadata = async (artifactUrl: string): Promise<ArtifactMetadata | null> => {
  const url = String(artifactUrl || '').trim()
  if (!url) return null
  if (url.startsWith(UPLOADS_URL_PREFIX)) return probeLocalFile(url)
  if (/^https?:\/\//i.test(url)) return probeRemoteUrl(url)
  return null
}
