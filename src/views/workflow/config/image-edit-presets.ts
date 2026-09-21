/**
 * 图片加工预设（角度 / 打光 / HD 增强 / 全景图）
 *
 * 这些按钮不是新能力 —— 它们的本质都是「拿这张图 + 一句固定指令」交给图生图管线
 * （image-edit）。所以这里只存**数据**（标签 + 指令 + 尺寸意图），执行统一走一条路，
 * 不然后面每加一个按钮就多一处重复代码。
 *
 * 指令写成中文祈使句，并且都带一句"保持什么不变" —— 实测 gpt-image-2 在没有这句
 * 约束时会顺手把主体也重画一遍（同一只金毛换个角度就变成另一只）。
 *
 * 尺寸意图用 ImageAspectIntent，由 `pickSizeByAspect` 在**当前模型声明的档位**里
 * 挑最接近的一档 —— 不写死像素，因为 gpt-image-2 只有 1024x1024 / 1536x1024 /
 * 1024x1536，而 Seedream 那套 2048x2048 之类它根本不认。
 */

import type { ImageAspectIntent } from '@/config/model-params'

export interface ImageEditPreset {
  /** 稳定 id，用于 key / 埋点 */
  key: string
  /** 菜单里显示的文案 */
  label: string
  /** 一句话说明这份预设要做什么（菜单里做副标题） */
  description: string
  /** 交给上游的指令 */
  prompt: string
  /** 需要换画幅时才给（如全景图要横版） */
  sizeIntent?: ImageAspectIntent
}

/** 角度：换摄像机角度，保持主体与风格 */
const KEEP_SUBJECT = '严格保持人物的五官、发型、服装、配色与整体风格不变，只改变视角。'

export const ANGLE_PRESETS: ImageEditPreset[] = [
  {
    key: 'front',
    label: '正视',
    description: '正面平视，最常用的基准角度',
    prompt: `把视角改为正面平视。${KEEP_SUBJECT}`,
  },
  {
    key: 'side',
    label: '侧视',
    description: '90° 正侧面',
    prompt: `把视角改为 90 度正侧面。${KEEP_SUBJECT}`,
  },
  {
    key: 'three-quarter',
    label: '45° 侧脸',
    description: '半侧面，立体感更强',
    prompt: `把视角改为 45 度半侧面（能同时看到正脸与侧面轮廓）。${KEEP_SUBJECT}`,
  },
  {
    key: 'high-angle',
    label: '俯视',
    description: '从上方往下拍',
    prompt: `把视角改为俯视（从上方往下拍），带出轻微压缩感。${KEEP_SUBJECT}`,
  },
  {
    key: 'low-angle',
    label: '仰视',
    description: '从下方往上拍，更显气势',
    prompt: `把视角改为仰视（从下方往上拍），带出力量感与气势。${KEEP_SUBJECT}`,
  },
  {
    key: 'back',
    label: '背面',
    description: '背面全身',
    prompt: `把视角改为背面（背影），展示背部轮廓与服装后背设计。${KEEP_SUBJECT}`,
  },
]

export const LIGHT_PRESETS: ImageEditPreset[] = [
  {
    key: 'studio-soft',
    label: '影棚柔光',
    description: '电商主图常用，干净通透',
    prompt: '把打光改为影棚柔光箱：光线均匀柔和、过渡自然、阴影很淡，背景干净通透，整体明亮。严格保持主体形态、材质、颜色与构图不变，只改变光线。',
  },
  {
    key: 'rembrandt',
    label: '伦勃朗光',
    description: '侧上方主光，脸颊有三角光斑',
    prompt: '把打光改为伦勃朗光：主光来自侧上方约 45 度，脸颊暗部出现标志性的三角光斑，层次厚重有质感。严格保持主体形态、材质、颜色与构图不变，只改变光线。',
  },
  {
    key: 'golden-hour',
    label: '黄昏暖光',
    description: '低角度金色阳光',
    prompt: '把打光改为黄昏金色时刻：低角度暖色阳光斜射，整体暖调、光晕柔和。严格保持主体形态、材质、颜色与构图不变，只改变光线与氛围。',
  },
  {
    key: 'rim-light',
    label: '逆光轮廓',
    description: '背后打光，边缘发亮',
    prompt: '把打光改为逆光轮廓光：光源在主体背后，边缘泛出明亮轮廓线，正面略暗但有细节。严格保持主体形态、材质、颜色与构图不变，只改变光线。',
  },
  {
    key: 'top-light',
    label: '顶光',
    description: '正上方打光，对比强烈',
    prompt: '把打光改为正上方顶光：光线自上而下，明暗对比强烈，眼窝与下方形成阴影。严格保持主体形态、材质、颜色与构图不变，只改变光线。',
  },
  {
    key: 'cool-night',
    label: '冷调夜景',
    description: '冷色环境光 + 点状高光',
    prompt: '把打光改为冷调夜景氛围：整体偏冷的蓝青色环境光，点缀少量明亮高光。严格保持主体形态、材质、颜色与构图不变，只改变光线与氛围。',
  },
]

/** HD 增强：注意它本质是"重绘增强"，不是无损放大 —— UI 上要如实说明 */
export const ENHANCE_PRESET: ImageEditPreset = {
  key: 'hd',
  label: 'HD 增强',
  description: '重绘并提升细节（会轻微重画，不是无损放大）',
  prompt: '在不改变构图、主体、材质与颜色的前提下提升画质：增强细节纹理与边缘清晰度，修正模糊、噪点与压缩伪影，让画面更锐利干净。',
}

/** 全景图：往横版扩画幅，补全主体周围的环境 */
export const PANORAMA_PRESET: ImageEditPreset = {
  key: 'panorama',
  label: '全景图',
  description: '扩成横版并补全周围环境',
  prompt: '把画面扩展为广角全景：向左右两侧补充周围环境与背景，使场景完整连贯、透视自然，主体保持原来的位置、比例与外观不变。',
  sizeIntent: 'landscape',
}
