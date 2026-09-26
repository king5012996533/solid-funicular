/**
 * 生成器页脚的「本次预估积分」—— 只问服务端要，不在客户端算钱。
 *
 * 设计要点（每条都是踩过的坑）：
 *   1. **只在拿得到时给数字**：`total` 保持 `null` 表示「不知道」，绝不用 0 冒充（见
 *      `shared/composer-cost-display.ts` 里的说明）。
 *   2. **不阻塞提交**：估算失败（未登录 / 5xx / 超时）就静默保持 `null`，
 *      页脚不显示数字，但发送按钮照常可用 —— 估算只是提示，不是闸门。
 *      （真正的闸门在服务端：余额不足会拦下并自动退还。）
 *   3. **防抖 + 缓存**：参数一动就重新问价会打一堆请求。这里 400ms 防抖，
 *      并且按「模型::规格::数量」缓存 5 分钟（与确认卡的缓存口径一致）。
 *   4. **在途请求要中止**：用户连点参数时，旧请求回来会把新结果覆盖掉 —— 用 AbortController 掐掉。
 *   5. **余额只取一次**：只用来决定数字的颜色（够 / 快不够 / 不够），拿不到就不上色。
 */

import { computed, onScopeDispose, ref, watch, type ComputedRef, type Ref } from 'vue'
import { requestPointsBalance, requestPointsEstimate } from '@/api/points'
import { resolveModelSelectionKey } from '@/config/models'
import {
  buildComposerEstimateKey,
  formatEstimateText,
  resolveCreditGapLevel,
  resolveUsableEstimate,
  type CreditGapLevel,
} from '@/shared/composer-cost-display'

export interface ComposerCostSource {
  /** 裸 modelKey（工具栏的 currentModelVersion）。返回空串 = 这一档不估（调用方说明原因） */
  modelKey: () => string
  /** 生成类别，决定三段式选择键里的 IMAGE / VIDEO */
  category: () => 'image' | 'video'
  /** 本次张数/条数 */
  count: () => number
  /** 画幅或清晰度档位（可选，能给就给 —— 它会影响定价） */
  size: () => string
}

interface EstimateCacheEntry {
  total: number
  at: number
}

/** 与确认卡保持一致的 5 分钟：同一组参数短时间内不必反复问价 */
export const COMPOSER_ESTIMATE_TTL_MS = 5 * 60 * 1000
export const COMPOSER_ESTIMATE_DEBOUNCE_MS = 400

const cache = new Map<string, EstimateCacheEntry>()

/** 只给单测用：清缓存，避免用例之间互相污染 */
export const clearComposerEstimateCache = () => cache.clear()

export const readCachedComposerEstimate = (key: string, now = Date.now()): number | null => {
  const hit = cache.get(key)
  if (!hit) return null
  if (now - hit.at > COMPOSER_ESTIMATE_TTL_MS) {
    cache.delete(key)
    return null
  }
  return hit.total
}

export const writeCachedComposerEstimate = (key: string, total: number, now = Date.now()) => {
  // 只有正数才值得缓存：0 / 负数按「不知道」处理，缓存它等于把「不知道」固化 5 分钟
  if (!key || !(total > 0)) return
  cache.set(key, { total, at: now })
}

export interface ComposerCostEstimate {
  /** 本次预估总额；null = 拿不到（调用方不要渲染数字） */
  estimateTotal: Ref<number | null>
  /** 可用余额；null = 拿不到（此时不上色） */
  availablePoints: Ref<number | null>
  gapLevel: ComputedRef<CreditGapLevel>
  displayText: ComputedRef<string>
  loading: Ref<boolean>
}

export function useComposerCostEstimate(source: ComposerCostSource): ComposerCostEstimate {
  const estimateTotal = ref<number | null>(null)
  const availablePoints = ref<number | null>(null)
  const loading = ref(false)

  let timer: ReturnType<typeof setTimeout> | null = null
  let controller: AbortController | null = null
  let disposed = false

  const signature = computed(() =>
    buildComposerEstimateKey(source.modelKey(), source.size(), source.count()),
  )

  const run = async () => {
    const key = signature.value
    // 空模型键 = 调用方明确表示这一档不估
    if (!key || key.startsWith('::')) {
      estimateTotal.value = null
      return
    }

    const cached = readCachedComposerEstimate(key)
    if (cached !== null) {
      estimateTotal.value = cached
      return
    }

    controller?.abort()
    const current = new AbortController()
    controller = current
    loading.value = true
    try {
      const modelKey = resolveModelSelectionKey(
        source.modelKey(),
        source.category() === 'video' ? 'VIDEO' : 'IMAGE',
      ) || source.modelKey()
      const response = await requestPointsEstimate(
        [{ model: modelKey, size: source.size(), count: source.count() }],
        current.signal,
      )
      if (disposed || current.signal.aborted) return
      const total = resolveUsableEstimate(response?.totalEstimated)
      estimateTotal.value = total
      if (total !== null) writeCachedComposerEstimate(key, total)
    } catch {
      // 估算失败不打扰用户：页脚不显示数字，发送照常（真正的闸门在服务端）
      if (!disposed && !current.signal.aborted) estimateTotal.value = null
    } finally {
      if (!disposed && !current.signal.aborted) loading.value = false
    }
  }

  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void run()
    }, COMPOSER_ESTIMATE_DEBOUNCE_MS)
  }

  watch(signature, () => {
    // 参数一变，旧数字立刻作废 —— 否则会短暂显示「上一个参数」的价格（比不显示更误导）
    estimateTotal.value = null
    schedule()
  }, { immediate: true })

  // 余额：只读一次，用于上色。失败就保持 null（不上色），不重试、不提示。
  void requestPointsBalance()
    .then((res) => {
      if (disposed) return
      const value = Number(res?.available)
      availablePoints.value = Number.isFinite(value) && value >= 0 ? value : null
    })
    .catch(() => { availablePoints.value = null })

  onScopeDispose(() => {
    disposed = true
    if (timer) clearTimeout(timer)
    controller?.abort()
  })

  const gapLevel = computed(() => resolveCreditGapLevel(estimateTotal.value, availablePoints.value))
  const displayText = computed(() => formatEstimateText(estimateTotal.value))

  return { estimateTotal, availablePoints, gapLevel, displayText, loading }
}
