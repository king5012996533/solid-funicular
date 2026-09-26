/**
 * 视频抽帧的「取哪一秒」换算（纯逻辑，便于单测，2026-09-26）
 *
 * 抽帧本身要碰 `<video>` / canvas（在 VideoNode.vue 里做），但「取哪一帧」这步换算
 * 最容易算错，而且错了在浏览器里往往表现为「点了没反应」或一张黑图，不会报错：
 *   · 视频元数据还没加载完时 `duration` 是 NaN；
 *   · 尾帧直接把 `duration` 喂给 `video.currentTime`，有的浏览器 seek 不出来；
 *   · `currentTime` 来自时间轴拖拽，可能是 NaN 或越界。
 * 这些边界在这里一次钉死，组件只负责把返回的秒数喂给 `video.currentTime`。
 */

export type FramePosition = 'current' | 'first' | 'last'

/**
 * 取尾帧时相对 `duration` 的回退量（秒）。
 *
 * 为什么不能直接用 `duration`：`currentTime === duration` 正好落在媒体结束点，
 * 部分浏览器在这个位置 seek 不出画面，随后 `drawImage` 会画出黑帧或空帧。
 * 回退一个远小于一帧（常见 24~60fps，一帧约 16~40ms）的量，既保证落在最后一帧里，
 * 又不会跨到倒数第二帧。
 */
export const LAST_FRAME_BACKOFF_SECONDS = 0.05

/** `duration` 可用 = 是有限正数。NaN（元数据未加载）/ 0 / 负数 / Infinity 都算不可用 */
const isUsableDuration = (duration: number): boolean =>
  Number.isFinite(duration) && duration > 0

/**
 * 返回要截取的时间点（秒）。
 *
 * 任何拿不准的情况一律返回 `0`：
 *   · `NaN` 传给 `video.currentTime` 会抛错，或让浏览器表现成「点了没反应」；
 *   · 负值同样非法。
 * 宁可截到第一帧，也不要静默失败。
 */
export const resolveFrameTimestamp = (
  position: FramePosition,
  currentTime: number,
  duration: number,
): number => {
  if (position === 'first') return 0
  // 下面两种位置都要靠 duration 定位：拿不到可靠的 duration 就退回 0
  if (!isUsableDuration(duration)) return 0
  if (position === 'last') return Math.max(0, duration - LAST_FRAME_BACKOFF_SECONDS)
  // current：currentTime 可能是 NaN 或超出 [0, duration]，必须 clamp
  if (!Number.isFinite(currentTime)) return 0
  return Math.min(Math.max(currentTime, 0), duration)
}

/**
 * 抽帧产物的文件名（仅用于上传时的文件命名）。
 *
 * 刻意**不把时间戳拼进名字**：秒数里的 `.` 以及位置名若换成中文，在部分系统/下载路径上
 * 容易出现非法字符或编码问题；这张图入库后由新节点承载展示，文件名只需要区分是哪种位置。
 * （第二个参数保留在签名里，方便调用方后续按需扩展，当前不参与命名。）
 */
export const buildFrameFileName = (
  position: FramePosition,
  _timestampSeconds: number,
): string => `frame-${position}.jpg`
