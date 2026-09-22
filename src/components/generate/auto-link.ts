/**
 * 智能引用 AutoLink 的纯逻辑（对齐 LibTV）
 *
 * LibTV 的文档行为是「输入提示词后，实时把相关参考素材智能 @ 引用到对应提示词后面」。
 * 我们的做法保持一致但更保守：**只自动引用上游连入、而用户没有显式 @ 的媒体素材**，
 * 补上它们的 token，交给既有的 `resolvePromptReferences` 走同一条路
 * （正文出现 `【图片1】`、URL 进请求体）。
 *
 * 抽成纯函数是因为这里最容易出的是「关闭开关却还在自动带」这类静默错误 ——
 * 在界面上看不出来，只能靠测试钉住（见 tests/auto-link.test.ts）。
 */

import type { ReferenceableAsset } from '@/views/workflow/composables/reference-resolver'

export interface AutoLinkInput {
  /** 用户输入的提示词原文 */
  input: string
  /** 参与候选的可引用资产（画布节点传上游连入的清单） */
  assets: ReferenceableAsset[]
  /** 提示词里已经显式引用到的媒体 URL（由 resolvePromptReferences 解析得到） */
  referencedMediaUrls: string[]
  /** 开关状态 */
  enabled: boolean
}

export interface AutoLinkResult {
  /** 补完 token 的提示词（没有可补的时候与入参逐字节相同） */
  prompt: string
  /** 本次自动补上的 token（不含 @），UI 用它显示「自动引用 N 个」 */
  tokens: string[]
}

/**
 * 挑出可以自动引用的资产。
 *
 * 三条排除规则：
 *  1. 开关关掉 → 一个都不挑（这是这个函数的首要职责）；
 *  2. 文本类不自动带 —— 它的语义是「把这段正文塞进提示词」，自动塞会改写用户的意图；
 *  3. 已经被显式引用过的不再重复（`referencedMediaUrls` 里出现过的 URL）。
 */
export const pickAutoLinkedAssets = (input: AutoLinkInput): ReferenceableAsset[] => {
  if (!input.enabled) return []
  const referenced = new Set(input.referencedMediaUrls)
  return input.assets.filter(asset =>
    (asset.kind === 'image' || asset.kind === 'video')
    && Boolean(asset.value)
    && Boolean(asset.token)
    && !referenced.has(asset.value))
}

/** 把自动引用的 token 拼到提示词末尾；没有可拼的时候原样返回 */
export const appendAutoLinkedTokens = (input: AutoLinkInput): AutoLinkResult => {
  const picked = pickAutoLinkedAssets(input)
  if (!picked.length) return { prompt: input.input, tokens: [] }
  const tokens = picked.map(asset => String(asset.token))
  const suffix = tokens.map(token => `@${token}`).join(' ')
  return {
    prompt: `${input.input} ${suffix}`.trim(),
    tokens,
  }
}
