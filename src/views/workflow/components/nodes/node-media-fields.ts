/**
 * 节点 data 上的「产物真实尺寸/时长」字段（模块声明合并，2026-09-27）
 *
 * 为什么不写在 `node-data-fields.ts`：那个文件本轮由另一个工作包（音频节点）在改，
 * 约定不碰。声明合并在类型层面等价，运行时零影响。
 *
 * 为什么要往节点 data 上放：卡片标题行要显示「1456 × 816」这种真实尺寸。
 * 一开始的方案是拿模型声明的"计划尺寸"，那是**编数字**；正解是服务端把产物的真实
 * 宽高（从文件字节里量出来的）随产物一起给出来，前端只负责显示 —— 拿不到就不显示。
 */
declare module '../../composables/useWorkflowCanvas' {
  interface WorkflowNodeDataBase {
    /** 产物真实宽度（像素）。只有服务端量到了才有值 */
    artifactWidth?: number
    /** 产物真实高度（像素） */
    artifactHeight?: number
    /** 产物真实时长（秒）。视频/音频用 */
    artifactDurationSeconds?: number
  }
}

/*
 * 必须有这行：文件里没有任何 import/export 时，TS 会把它当成**脚本**而不是模块，
 * 此时 `declare module '相对路径'` 被理解为"声明一个新模块"，而相对模块名是禁止的
 * （报 TS2436）。加上 `export {}` 之后它变成模块，同一句就变成对既有模块的**声明合并**。
 * 同目录的 node-data-fields.ts 之所以没这行是因为它本来就 import 了类型。
 */
export {}
