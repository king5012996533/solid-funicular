/**
 * 本轮给画布节点 data 补的字段（模块声明合并）
 *
 * 为什么不直接改 `useWorkflowCanvas.ts` 里的接口：那个文件本轮有并行改动（工作包 A 在动它），
 * 约定不碰。声明合并在类型层面等价，运行时零影响。
 *
 * 这个文件只有类型、没有运行时逻辑，靠 tsconfig 的 include（覆盖 src 下所有 .ts）进程序，
 * 不需要被任何人 import；打包产物里也不会有它。
 */
import type { UpstreamFingerprint } from './upstream-staleness'

declare module '../../composables/useWorkflowCanvas' {
  interface WorkflowNodeDataBase {
    /**
     * 「上游已变 / 需重跑」指纹：上游节点 id → 本次提交时用到的产出 url。
     * 只写在自己节点的 data 上，不碰别人的节点或边（见 ./upstream-staleness.ts）。
     */
    upstreamFingerprint?: UpstreamFingerprint
  }

  interface WorkflowImageNodeData {
    /**
     * 图片显示比例：false / 缺省 = 锁比例（按卡片比例 cover 裁切填满）；
     * true = 自由比例（contain 完整显示原图，可能留白）。
     */
    freeResize?: boolean
  }
}
