/**
 * 提示词预设片段
 *
 * 对齐 LibTV composer 上的能力 chip：图片节点是 `参考 / 标记 / 风格`，
 * 视频节点是 `参考 / 标记 / 特效 / 角色库 / 运镜`。
 *
 * 我们只摆**有真实行为**的 chip：
 *   - `参考` → 打开 @ 素材引用面板（已实现，见 MentionPicker）
 *   - `风格` → 把下面这些风格片段插到光标处（本文件）
 *   - `标记 / 特效 / 角色库 / 运镜` → 需要后端能力，**不摆**（宁缺勿假）
 *
 * 风格做成「往提示词里插一段文字」而不是一个开关状态，有两个好处：
 *   1. 没有额外的状态要同步 —— 提示词本身就是唯一事实来源
 *   2. 用户可以插完再改，比如把「冷色调」改成「冷色调，偏青」
 */

export interface PromptPreset {
  key: string
  /** 中文名，chip 与菜单里显示 */
  label: string
  /** 插进提示词的片段。开头不带标点，由插入逻辑负责与上下文衔接 */
  fragment: string
}

export const STYLE_PRESETS: PromptPreset[] = [
  {
    key: 'cinematic',
    label: '电影质感',
    fragment: '电影级画质，浅景深，柔和体积光，胶片颗粒',
  },
  {
    key: 'anime',
    label: '日系动画',
    fragment: '日系动画风格，干净线稿，明快配色，赛璐璐上色',
  },
  {
    key: 'watercolor',
    label: '水彩绘本',
    fragment: '水彩绘本风格，湿画法晕染，纸张肌理，色彩柔和',
  },
  {
    key: 'render3d',
    label: '3D 渲染',
    fragment: '3D 渲染，柔顺曲面，棚拍布光，次表面散射',
  },
  {
    key: 'cyberpunk',
    label: '赛博朋克',
    fragment: '赛博朋克，霓虹光晕，湿润反光地面，高对比冷色调',
  },
  {
    key: 'ecommerce',
    label: '电商白底',
    fragment: '电商产品图，纯白背景，均匀柔光，无阴影，突出材质细节',
  },
]

/**
 * 把片段插到提示词末尾。
 *
 * 为什么插末尾而不是光标处：chip 的语义是「给这段描述补一个风格」，
 * 而风格描述天然属于句尾的补充说明。光标插入留着给 @ 引用用 ——
 * 那个才需要在句子中间定位。
 */
export const appendPreset = (prompt: string, preset: PromptPreset): string => {
  const base = String(prompt || '').trim()
  const fragment = preset.fragment.trim()
  if (!fragment) return base
  if (base.includes(fragment)) return base
  if (!base) return fragment
  // 中文场景用全角逗号衔接；已有句末标点时不重复加
  return /[，。,.\s]$/.test(base) ? `${base}${fragment}` : `${base}，${fragment}`
}

/**
 * 从提示词里移除某个片段（再点一次 chip 即取消）。
 * 顺带把因此产生的悬空标点收拾掉，否则提示词会留下「，。」这种残迹。
 */
export const removePreset = (prompt: string, preset: PromptPreset): string => {
  const base = String(prompt || '')
  const fragment = preset.fragment.trim()
  if (!fragment || !base.includes(fragment)) return base

  let next = base.replace(fragment, '')
  next = next
    .replace(/[，,]\s*(?=[，,。.])/g, '')   // 连着两个逗号 → 去掉一个
    .replace(/[，,]\s*$/, '')               // 结尾悬空的逗号
    .replace(/^\s*[，,]/, '')               // 开头悬空的逗号
    .trim()
  return next
}

/** 判断某个片段当前是否已经在提示词里（chip 据此显示选中态） */
export const hasPreset = (prompt: string, preset: PromptPreset): boolean =>
  !!preset.fragment.trim() && String(prompt || '').includes(preset.fragment.trim())
