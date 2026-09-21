#!/usr/bin/env node
/**
 * 模型目录种子脚本
 *
 * 背景：ai_providers / ai_models 两张表在开发库里是空的，
 * 而前端「参数由上游模型决定」的实现是读这两张表的公开目录。
 * 目录为空时工具栏只能显示「未配置图片模型」，什么参数都验证不了。
 *
 * 这个脚本按上游文档填入几条真实的模型能力声明，让目录可用、可验证。
 * 它只做新增与更新（按 provider.code + model_key 幂等），不删任何东西。
 *
 * 用法：
 *   node scripts/seed-model-catalog.mjs            # 幂等写入 / 更新
 *   node scripts/seed-model-catalog.mjs --dry-run  # 只打印将要写入的内容
 *
 * 注意：这里填的是「模型能力」（可选尺寸 / 画质 / 比例 / 时长），
 * 不是 API Key。真实调用还需要在后台为厂商配置密钥。
 */

import { readFileSync } from 'node:fs'
import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import prismaClientPackage from '@prisma/client'

const { PrismaClient } = prismaClientPackage

const DRY_RUN = process.argv.includes('--dry-run')

// 与 server 侧一致：.env.development 里是 mysql://root:password@127.0.0.1:3306/canana_mind
const readEnvDatabaseUrl = () => {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  try {
    const content = readFileSync(new URL('../.env.development', import.meta.url), 'utf8')
    const matched = /^DATABASE_URL=(.*)$/m.exec(content)
    return matched ? matched[1].trim().replace(/^["']|["']$/g, '') : ''
  } catch {
    return ''
  }
}

const databaseUrl = readEnvDatabaseUrl()
if (!databaseUrl) {
  console.error('未找到 DATABASE_URL（环境变量或 .env.development 均可）')
  process.exit(1)
}
process.env.DATABASE_URL = databaseUrl

// Prisma 7 需要显式传入 driver adapter，与 server/db/prisma.ts 保持一致
const prisma = new PrismaClient({ adapter: new PrismaMariaDb(databaseUrl) })

/** 豆包 Seedream：2K 与 4K 两张不同的像素表，按画质切换 */
const seedreamParams = {
  maxImagesPerRequest: 1,
  params: {
    quality: {
      options: [
        { label: '标准画质', key: 'standard' },
        { label: '4K 高清', key: '4k' },
      ],
      default: 'standard',
    },
    size: {
      options: [
        { label: '21:9', key: '3024x1296', hint: '2K' },
        { label: '16:9', key: '2560x1440', hint: '2K' },
        { label: '3:2', key: '2496x1664', hint: '2K' },
        { label: '4:3', key: '2304x1728', hint: '2K' },
        { label: '1:1', key: '2048x2048', hint: '2K' },
        { label: '3:4', key: '1728x2304', hint: '2K' },
        { label: '2:3', key: '1664x2496', hint: '2K' },
        { label: '9:16', key: '1440x2560', hint: '2K' },
        { label: '9:21', key: '1296x3024', hint: '2K' },
      ],
      default: '2048x2048',
    },
  },
}

/** 4K 画质下换成另一张表；这里用同一份 capabilityJson 的 qualitySizeMap 表达 */
const seedream4kSizeMap = {
  '4k': [
    { label: '21:9', key: '6198x2656', hint: '4K' },
    { label: '16:9', key: '5404x3040', hint: '4K' },
    { label: '3:2', key: '4992x3328', hint: '4K' },
    { label: '4:3', key: '4694x3520', hint: '4K' },
    { label: '1:1', key: '4096x4096', hint: '4K' },
    { label: '3:4', key: '3520x4694', hint: '4K' },
    { label: '2:3', key: '3328x4992', hint: '4K' },
    { label: '9:16', key: '3040x5404', hint: '4K' },
    { label: '9:21', key: '2656x6198', hint: '4K' },
  ],
}

const providers = [
  {
    code: 'volcengine-ark',
    name: '火山方舟',
    description: '豆包系列图片与视频模型',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    supportedTypes: ['IMAGE', 'VIDEO'],
    models: [
      {
        category: 'IMAGE',
        name: 'Seedream 4.5',
        modelKey: 'doubao-seedream-4-5-251128',
        sortOrder: 10,
        capabilityJson: {
          ...seedreamParams,
          // 画质 → 尺寸表的映射，前端切画质时会换整张表
          qualitySizeMap: seedream4kSizeMap,
        },
        defaultParamsJson: { size: '2048x2048', quality: 'standard', billingRule: { power: 20 } },
      },
      {
        category: 'VIDEO',
        name: 'Seedance 1.0',
        modelKey: 'doubao-seedance-1-0-pro',
        sortOrder: 20,
        capabilityJson: {
          params: {
            ratio: {
              options: [
                { label: '16:9 横版', key: '16x9' },
                { label: '21:9 宽幅', key: '21x9' },
                { label: '4:3', key: '4x3' },
                { label: '1:1 方形', key: '1x1' },
                { label: '3:4', key: '3x4' },
                { label: '9:16 竖版', key: '9x16' },
              ],
              default: '16x9',
            },
            duration: { options: [{ label: '5 秒', key: '5' }, { label: '10 秒', key: '10' }], default: '5' },
            resolution: { options: [{ label: '720P', key: '720p' }, { label: '1080P', key: '1080p' }], default: '720p' },
            feature: {
              options: [
                { label: '文生视频', key: 'text-to-video' },
                { label: '图生视频', key: 'image-to-video' },
                { label: '首尾帧', key: 'first-last-frame' },
              ],
            },
          },
        },
        defaultParamsJson: { ratio: '16x9', duration: 5, billingRule: { power: 60 } },
      },
    ],
  },
  {
    code: 'nano-banana',
    name: 'Nano Banana',
    description: '比例型出图，不区分画质档，支持一次多张',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    supportedTypes: ['IMAGE'],
    models: [
      {
        category: 'IMAGE',
        name: 'Nano Banana Pro',
        modelKey: 'nano-banana-pro',
        sortOrder: 5,
        // 只声明比例，不声明画质 —— 前端就不该出现画质控件
        capabilityJson: {
          maxImagesPerRequest: 4,
          params: {
            size: {
              options: [
                { label: '21:9', key: '21x9' },
                { label: '16:9', key: '16x9' },
                { label: '3:2', key: '3x2' },
                { label: '4:3', key: '4x3' },
                { label: '1:1', key: '1x1' },
                { label: '3:4', key: '3x4' },
                { label: '2:3', key: '2x3' },
                { label: '9:16', key: '9x16' },
                { label: '9:21', key: '9x21' },
              ],
              default: '1x1',
            },
          },
        },
        defaultParamsJson: { size: '1x1', billingRule: { power: 15 } },
      },
    ],
  },
  {
    code: 'kling',
    name: '可灵',
    description: '只支持图生视频与首尾帧',
    baseUrl: 'https://api.klingai.com/v1',
    supportedTypes: ['VIDEO'],
    models: [
      {
        category: 'VIDEO',
        name: 'Kling v2',
        modelKey: 'kling-v2-master',
        sortOrder: 10,
        capabilityJson: {
          params: {
            ratio: {
              options: [
                { label: '16:9 横版', key: '16x9' },
                { label: '1:1 方形', key: '1x1' },
                { label: '9:16 竖版', key: '9x16' },
              ],
              default: '16x9',
            },
            duration: { options: [{ label: '5 秒', key: '5' }, { label: '10 秒', key: '10' }], default: '5' },
            feature: {
              options: [
                { label: '图生视频', key: 'image-to-video' },
                { label: '首尾帧', key: 'first-last-frame' },
              ],
            },
          },
        },
        defaultParamsJson: { ratio: '16x9', duration: 5, billingRule: { power: 80 } },
      },
    ],
  },
]

const main = async () => {
  for (const provider of providers) {
    const payload = {
      name: provider.name,
      description: provider.description,
      baseUrl: provider.baseUrl,
      supportedTypesJson: provider.supportedTypes,
      isEnabled: true,
      isBuiltIn: false,
      sortOrder: 0,
    }

    console.log(`\n厂商 ${provider.code}（${provider.name}）`)
    for (const model of provider.models) {
      console.log(`  · [${model.category}] ${model.name}  key=${model.modelKey}`)
      const keys = Object.keys(model.capabilityJson?.params || {})
      console.log(`      声明的参数维度：${keys.length ? keys.join(' / ') : '（无）'}`)
    }

    if (DRY_RUN) continue

    const saved = await prisma.aiProvider.upsert({
      where: { code: provider.code },
      update: payload,
      create: { code: provider.code, ...payload },
    })

    for (const model of provider.models) {
      const existing = await prisma.aiModel.findFirst({
        where: { providerId: saved.id, modelKey: model.modelKey },
        select: { id: true },
      })
      const modelPayload = {
        providerId: saved.id,
        category: model.category,
        name: model.name,
        modelKey: model.modelKey,
        capabilityJson: model.capabilityJson,
        defaultParamsJson: model.defaultParamsJson,
        sortOrder: model.sortOrder,
        isEnabled: true,
        isBuiltIn: false,
      }
      if (existing) {
        await prisma.aiModel.update({ where: { id: existing.id }, data: modelPayload })
      } else {
        await prisma.aiModel.create({ data: modelPayload })
      }
    }
  }

  if (DRY_RUN) {
    console.log('\n--dry-run：未写入任何数据')
    return
  }

  const providerCount = await prisma.aiProvider.count()
  const modelCount = await prisma.aiModel.count()
  console.log(`\n完成。当前目录：${providerCount} 个厂商 / ${modelCount} 个模型`)
  console.log('提示：模型能力已就位，真实调用仍需在后台为厂商填写 API Key。')
}

main()
  .catch((error) => {
    console.error('写入失败：', error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
