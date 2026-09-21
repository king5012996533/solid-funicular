/**
 * e2e 脚本共用的 console 报错过滤器
 *
 * 为什么需要它：这些页面**大量热链第三方素材**
 * （qwe-oss 的个人 OSS bucket、字节的 byteimg 与 vlabstatic、picsum 等），
 * 依赖外网解析。代理一开、或对方 bucket 一关，这些图就全裂，
 * 每个脚本的「没有 console error」断言都会因此判失败 ——
 * 但那是环境与对方服务的问题，不是我们代码的回归。
 *
 * 所以统一分三类：
 *   1. IGNORABLE      —— 未登录时的 401，本来就不算问题
 *   2. thirdParty     —— 第三方资源的网络失败：**只统计、不计入失败**
 *                        （本身是真实的产品风险，见清单 §5，所以不隐藏）
 *   3. real           —— 其余全部算失败，包括我们自己 origin 的任何报错
 *
 * 判断「是不是第三方」用的是报错文本里有没有我们自己的地址 ——
 * 宁可把不确定的算作 real（严格），也不要把自己的问题归到第三方去（掩盖）。
 */

/** 未登录时的正常响应，不算回归 */
export const IGNORABLE = [/401/, /Unauthorized/, /当前未登录/]

/** 我们自己的 origin：出现在报错文本里就说明是自家问题 */
const OWN_ORIGIN = /localhost:5011|127\.0\.0\.1:5011|localhost:5409|127\.0\.0\.1:5409/

const NETWORK_FAILURE = /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_INTERNET_DISCONNECTED|ERR_TIMED_OUT|ERR_ADDRESS_UNREACHABLE/

/** 是否为「第三方资源的网络失败」 */
export const isThirdPartyResourceError = (text) => {
  if (!NETWORK_FAILURE.test(text)) return false
  return !OWN_ORIGIN.test(text)
}

/**
 * 把原始报错列表分成「真失败」与「第三方失败」。
 * @param {string[]} errors
 * @returns {{ real: string[], thirdParty: string[] }}
 */
export const classifyConsoleErrors = (errors) => {
  const notIgnorable = errors.filter((text) => !IGNORABLE.some((re) => re.test(text)))
  const thirdParty = notIgnorable.filter(isThirdPartyResourceError)
  const real = notIgnorable.filter((text) => !isThirdPartyResourceError(text))
  return { real, thirdParty }
}

/**
 * 一行搞定「断言无报错 + 报出第三方失败」。
 * @param {(label: string, ok: boolean, detail?: string) => void} check 各脚本自己的断言函数
 * @param {string[]} errors
 * @param {string} [label]
 */
export const assertNoConsoleErrors = (check, errors, label = 'console errors') => {
  const { real, thirdParty } = classifyConsoleErrors(errors)
  check(label, real.length === 0 ? [] : real.map((t) => t.slice(0, 160)), [])
  if (thirdParty.length) {
    console.log(`     ⚠️ 第三方热链资源失败 ${thirdParty.length} 项（不计入失败，但是真实风险）`)
  }
  return { real, thirdParty }
}
