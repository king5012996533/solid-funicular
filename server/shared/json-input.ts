import { Prisma } from '@prisma/client'

/**
 * 写 Json 字段时的收口。
 *
 * 为什么需要：Prisma 7 对可空 Json 字段的输入类型是
 * `NullableJsonNullValueInput | InputJsonValue`，而 `NullableJsonNullValueInput = { DbNull } | { JsonNull }`
 * —— **不接受裸 `null`**；同时业务侧的对象字面量（`Record<string, any> | null`、
 * 带 `undefined` 可选字段的接口）也不能直接赋给 `InputJsonValue`。
 * 于是每个写 Json 的地方都报 TS2322（2026-09-23 清类型债时共 32 处）。
 *
 * 语义与「直接传 null / 传对象」完全一致：
 *   - `undefined` → 不更新这个字段（保持 Prisma 的「缺省即不动」语义）
 *   - `null`      → `Prisma.DbNull`（SQL NULL，与旧行为一致）
 *   - 其它        → 原值（仅做类型收窄，不改数据）
 */
export const toJsonInput = (value: unknown): Prisma.InputJsonValue | undefined => {
  if (value === undefined) {
    return undefined
  }
  return value as Prisma.InputJsonValue
}

export const toNullableJsonInput = (value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return Prisma.DbNull
  }
  return value as Prisma.InputJsonValue
}
