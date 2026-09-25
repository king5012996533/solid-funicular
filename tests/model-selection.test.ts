/**
 * 模型解析收敛规则的验证
 *
 * 这段逻辑对应的就是用户实际撞到的那个报错：
 *   「未匹配到后台模型配置，请先在后台配置可用模型」
 * 它来自前端拿「用户选中的模型」去目录里反查厂商，查不到就抛。
 *
 * 两条线必须同时成立，缺一条都是事故：
 *   1. 原选模型还在目录里 → **原样返回，一个字节都不改**（静默换模型是历史事故）；
 *   2. 原选模型已下架 → 先强拉一次目录再试，仍没有就回落该分类默认模型，
 *      并标记 fellBack 交给调用方提示用户，而不是让整个操作硬失败。
 * 另外还钉住两件容易被改坏的事：
 *   · 目录请求失败**不能**用空目录覆盖手里那份可用快照；
 *   · 正常路径（原选模型可用）**不能**多打一次目录请求。
 *
 * 纯逻辑，直接跑 Node 比点界面更精确：目录快照由 stub 的 fetch 提供。
 */

import {
  getAllChatModels,
  isPublicModelCatalogLoaded,
  loadPublicModelCatalog,
  notifyModelSelectionFallback,
  reconcileModelSelection,
  resolveModelSelection,
} from '../src/config/models'
import type { PublicModelCatalogItem, PublicModelCatalogResult } from '../src/config/models'

let passed = 0
let failed = 0

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    console.log(`  ❌ ${label}\n     期望 ${e}\n     实际 ${a}`)
  }
}

const item = (
  category: 'CHAT' | 'IMAGE' | 'VIDEO',
  providerId: string,
  modelKey: string,
  isDefault = false,
): PublicModelCatalogItem => ({
  id: `${providerId}-${modelKey}`,
  selectionKey: `${providerId}::${category}::${modelKey}`,
  providerId,
  providerCode: providerId,
  providerName: providerId,
  category,
  label: modelKey,
  modelKey,
  description: '',
  capabilityJson: null,
  defaultParamsJson: null,
  sortOrder: 0,
  isDefault,
})

const chat = (...keys: string[]) => keys.map((key, index) => item('CHAT', 'p-chat', key, index === 0))
const video = (...keys: string[]) => keys.map((key, index) => item('VIDEO', 'p-video', key, index === 0))

const makeCatalog = (models: PublicModelCatalogItem[]): PublicModelCatalogResult => ({
  providers: [],
  models: {
    chat: models.filter(m => m.category === 'CHAT'),
    image: models.filter(m => m.category === 'IMAGE'),
    video: models.filter(m => m.category === 'VIDEO'),
  },
  defaults: {
    chat: models.find(m => m.category === 'CHAT' && m.isDefault)?.selectionKey || '',
    image: models.find(m => m.category === 'IMAGE' && m.isDefault)?.selectionKey || '',
    video: models.find(m => m.category === 'VIDEO' && m.isDefault)?.selectionKey || '',
  },
})

// 目录接口用 stub 的 fetch 提供：既能数请求次数，也能模拟请求失败。
let catalogRequests = 0
let catalogPayload = makeCatalog([])
let failNextRequest = false

globalThis.fetch = (async () => {
  catalogRequests++
  if (failNextRequest) {
    failNextRequest = false
    throw new Error('network down')
  }
  return new Response(JSON.stringify({ data: catalogPayload }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}) as typeof fetch

const main = async () => {
  console.log('\n【1】目录还没到：不做任何判断，绝不静默替换存值')
  {
    const result = reconcileModelSelection('p-chat::CHAT::spark', 'CHAT')
    check('未拉过目录', isPublicModelCatalogLoaded(), false)
    check('原样保留存值', result.key, 'p-chat::CHAT::spark')
    check('没有回落', result.fellBack, false)
    check('目录未就绪', result.catalogReady, false)
  }

  console.log('\n【2】目录到货后：TTL 内复用快照，不再重复打网络')
  {
    catalogPayload = makeCatalog([...chat('spark', 'nova'), ...video('seedance2.5')])
    await loadPublicModelCatalog(true)
    check('强拉一次', catalogRequests, 1)
    check('目录已就绪', isPublicModelCatalogLoaded(), true)

    const before = catalogRequests
    await loadPublicModelCatalog()
    check('TTL 内复用快照（0 次新请求）', catalogRequests, before)
  }

  console.log('\n【3】原选模型仍可用：一个字节都不改')
  {
    const result = reconcileModelSelection('p-chat::CHAT::nova', 'CHAT')
    check('保留原选', result.key, 'p-chat::CHAT::nova')
    check('不算回落', result.fellBack, false)
    check('目录已就绪', result.catalogReady, true)

    // 裸 modelKey（历史数据里存过）也要认得
    const byModelKey = reconcileModelSelection('nova', 'CHAT')
    check('裸 modelKey 同样保留', byModelKey.key, 'nova')
    check('不算回落', byModelKey.fellBack, false)
  }

  console.log('\n【4】原选模型已下架：回落默认模型，并标记 fellBack')
  {
    const result = reconcileModelSelection('p-chat::CHAT::ghost', 'CHAT')
    check('回落到目录默认模型', result.key, 'p-chat::CHAT::spark')
    check('标记回落（调用方必须提示用户）', result.fellBack, true)
    check('原选值被记录下来', result.requestedKey, 'p-chat::CHAT::ghost')

    // 空值（用户从没选过）不算「回落」，不该弹「已下架」提示
    const empty = reconcileModelSelection('', 'CHAT')
    check('空值取默认', empty.key, 'p-chat::CHAT::spark')
    check('空值不算回落', empty.fellBack, false)
  }

  console.log('\n【5】提交解析：可用模型不多打请求；已下架的强拉一次再回落')
  {
    const before = catalogRequests
    const usable = await resolveModelSelection({ modelKey: 'p-chat::CHAT::nova', category: 'CHAT' })
    check('原选可用 → 原样返回', usable && { providerId: usable.providerId, modelKey: usable.modelKey }, {
      providerId: 'p-chat',
      modelKey: 'nova',
    })
    check('没有回落', usable?.usedFallback, false)
    check('正常路径 0 次新请求', catalogRequests, before)

    const stale = await resolveModelSelection({ modelKey: 'p-chat::CHAT::ghost', category: 'CHAT' })
    check('已下架 → 强拉一次目录', catalogRequests, before + 1)
    check('回落到默认模型', stale && { providerId: stale.providerId, modelKey: stale.modelKey }, {
      providerId: 'p-chat',
      modelKey: 'spark',
    })
    check('标记 usedFallback', stale?.usedFallback, true)
    check('记录原选值（提示文案要用）', stale?.requestedKey, 'p-chat::CHAT::ghost')

    // 没传 key（工作流节点还没挑模型）：直接用默认，且不强拉目录
    const requestsBeforeEmpty = catalogRequests
    const noKey = await resolveModelSelection({ category: 'CHAT' })
    check('没传 key → 默认模型', noKey?.modelKey, 'spark')
    check('没传 key 不强拉目录', catalogRequests, requestsBeforeEmpty)
  }

  console.log('\n【6】该分类后台一个可用模型都没有：返回 null，由调用方报错')
  {
    const none = await resolveModelSelection({ modelKey: 'p-video::VIDEO::seedance2.5', category: 'VIDEO' })
    check('目录里还有这个视频模型，正常返回', none?.modelKey, 'seedance2.5')

    catalogPayload = makeCatalog([...chat('spark', 'nova')])
    await loadPublicModelCatalog(true)
    const gone = await resolveModelSelection({ modelKey: 'p-video::VIDEO::seedance2.5', category: 'VIDEO' })
    check('视频分类空了 → null', gone, null)
  }

  console.log('\n【7】目录请求失败：保留上一份可用快照，不清空（旧行为是覆盖成空目录 → 整页报「未配置模型」）')
  {
    catalogPayload = makeCatalog([...chat('spark', 'nova')])
    await loadPublicModelCatalog(true)
    check('先有一份可用目录', getAllChatModels().length, 2)

    failNextRequest = true
    await loadPublicModelCatalog(true)
    check('请求失败后聊天模型仍在', getAllChatModels().length, 2)

    const stillUsable = await resolveModelSelection({ modelKey: 'p-chat::CHAT::nova', category: 'CHAT' })
    check('失败后仍能解析出厂商', stillUsable?.providerId, 'p-chat')
  }

  console.log('\n【8】回落提示：无 DOM 环境不抛错（浏览器里才真的弹提示）')
  {
    let threw = false
    try {
      notifyModelSelectionFallback('p-chat::CHAT::ghost', 'spark')
    } catch {
      threw = true
    }
    check('纯 Node 下不抛错', threw, false)
  }

  console.log(`\n${'─'.repeat(52)}`)
  console.log(`  通过 ${passed} / 失败 ${failed}`)
  process.exit(failed ? 1 : 0)
}

void main()
