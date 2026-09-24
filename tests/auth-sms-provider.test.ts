/**
 * 阿里云 dypnsapi 短信通道的请求构造与签名验证（纯干跑，不发真实短信）。
 *
 * 为什么要这个测试：
 *   短信下发是“发出去就只能靠线上反馈发现问题”的那类逻辑 —— 签名错一个字、
 *   参数名多一个字母，阿里云只会回一个模糊的报错，本地却看不见任何东西。
 *   所以这里把请求钉死：固定时间戳 + 固定 SignatureNonce，逐条断言 query 参数，
 *   再用一份独立实现的 RFC3986 规范化重算签名，最后用本地 mock server 接住请求，
 *   确认整条链路（URL 拼装 -> HTTP -> 响应解析）都通。
 *
 * 跑法：npx tsx tests/auth-sms-provider.test.ts（已接入 npm run test:unit）
 */

import crypto from 'node:crypto'
import http from 'node:http'

import {
  buildSendSmsVerifyCodeRequest,
  hasSmsProviderCredentials,
  readSmsProviderConfig,
  sendSmsVerifyCode,
} from '../server/auth/sms-provider'

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

// 供测试用的假密钥（不是真实凭据，仅用于本地签名计算）。
const TEST_CONFIG = {
  accessKeyId: 'LTAI_TEST_ACCESS_KEY_ID',
  accessKeySecret: 'TEST_ACCESS_KEY_SECRET',
  signName: '测试签名',
  templateCode: 'SMS_00000000',
  endpoint: 'https://dypnsapi.aliyuncs.com',
}

const FIXED_TIMESTAMP = '2026-01-01T00:00:00Z'
const FIXED_NONCE = '00000000-0000-4000-8000-000000000000'

// 独立实现的阿里云 RPC v1 签名（与 sms-provider 内部实现刻意分开写）。
const independentPercentEncode = (value: string) =>
  // eslint-disable-next-line no-control-regex
  encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)

const independentSignature = (query: Record<string, string>, accessKeySecret: string) => {
  const canonicalized = Object.keys(query)
    .sort()
    .map((key) => `${independentPercentEncode(key)}=${independentPercentEncode(query[key])}`)
    .join('&')
  const stringToSign = `POST&${independentPercentEncode('/')}&${independentPercentEncode(canonicalized)}`
  return {
    stringToSign,
    signature: crypto.createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64'),
  }
}

const parseQuery = (url: string) => {
  // mock server 拿到的是相对路径（/?...），补个 base 才能解析。
  const parsed = new URL(url, 'http://127.0.0.1')
  const query: Record<string, string> = {}
  parsed.searchParams.forEach((value, key) => {
    query[key] = value
  })
  return query
}

const listen = (handler: http.RequestListener): Promise<{ server: http.Server; port: number }> =>
  new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ server, port })
    })
  })

// 保存并恢复环境变量，避免测试之间互相污染。
const ORIGINAL_ENV = { ...process.env }
const resetSmsEnv = () => {
  for (const key of [
    'ALIYUN_SMS_ACCESS_KEY_ID',
    'ALIYUN_SMS_ACCESS_KEY_SECRET',
    'ALIYUN_SMS_SIGN_NAME',
    'ALIYUN_SMS_TEMPLATE_CODE',
    'ALIYUN_SMS_ENDPOINT',
  ]) {
    delete process.env[key]
  }
}

const main = async () => {
  console.log('\n[1] 请求构造（固定时间戳/随机数，逐条核对参数）')
  const draft = buildSendSmsVerifyCodeRequest('13800138000', TEST_CONFIG, {
    timestamp: FIXED_TIMESTAMP,
    signatureNonce: FIXED_NONCE,
  })

  console.log(`\n  ---- 干跑请求 ----\n  ${draft.method} ${draft.url}\n  StringToSign: ${draft.stringToSign}\n  Signature: ${draft.signature}\n  ------------------\n`)

  check('HTTP 方法为 POST（与老项目 SDK 一致）', draft.method, 'POST')
  check('Action', draft.query.Action, 'SendSmsVerifyCode')
  check('Version', draft.query.Version, '2017-05-25')
  check('Format', draft.query.Format, 'json')
  check('SignatureMethod', draft.query.SignatureMethod, 'HMAC-SHA1')
  check('SignatureVersion', draft.query.SignatureVersion, '1.0')
  check('Timestamp', draft.query.Timestamp, FIXED_TIMESTAMP)
  check('SignatureNonce', draft.query.SignatureNonce, FIXED_NONCE)
  check('AccessKeyId', draft.query.AccessKeyId, TEST_CONFIG.accessKeyId)
  check('PhoneNumber 为纯手机号（不带 86）', draft.query.PhoneNumber, '13800138000')
  check('CountryCode 单独指定', draft.query.CountryCode, '86')
  check('SignName', draft.query.SignName, TEST_CONFIG.signName)
  check('TemplateCode', draft.query.TemplateCode, TEST_CONFIG.templateCode)
  check('模板参数用 ##code## 占位（真实码由阿里云生成）', draft.query.TemplateParam, '{"code":"##code##","min":"5"}')
  check('ValidTime', draft.query.ValidTime, '300')
  check('CodeLength', draft.query.CodeLength, '6')
  check('ReturnVerifyCode 要求回传验证码', draft.query.ReturnVerifyCode, 'true')

  const signedParams = { ...draft.query }
  delete signedParams.Signature
  const expected = independentSignature(signedParams, TEST_CONFIG.accessKeySecret)
  check('StringToSign 与独立实现一致', draft.stringToSign, expected.stringToSign)
  check('Signature 与独立实现的 HMAC-SHA1 一致', draft.signature, expected.signature)

  console.log('\n[2] 本地 mock server 干跑：确认 URL 拼装与响应解析')
  resetSmsEnv()
  process.env.ALIYUN_SMS_ACCESS_KEY_ID = TEST_CONFIG.accessKeyId
  process.env.ALIYUN_SMS_ACCESS_KEY_SECRET = TEST_CONFIG.accessKeySecret
  process.env.ALIYUN_SMS_SIGN_NAME = TEST_CONFIG.signName
  process.env.ALIYUN_SMS_TEMPLATE_CODE = TEST_CONFIG.templateCode

  let captured: { method?: string; query?: Record<string, string> } = {}
  const { server, port } = await listen((req, res) => {
    captured = { method: req.method, query: parseQuery(String(req.url || '')) }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      Code: 'OK',
      Message: 'OK',
      RequestId: 'MOCK-REQUEST-ID',
      Model: { BizId: 'MOCK-BIZ-ID', VerifyCode: '654321' },
    }))
  })
  process.env.ALIYUN_SMS_ENDPOINT = `http://127.0.0.1:${port}`

  // 注意：请求打向本地 mock，不会触及阿里云，也就不会产生任何真实短信。
  const result = await sendSmsVerifyCode('13900139000')
  await new Promise<void>((resolve) => server.close(() => resolve()))

  check('下发成功', result.ok, true)
  check('取回阿里云生成的验证码', result.code, '654321')
  check('取回 BizId', result.bizId, 'MOCK-BIZ-ID')
  check('mock 收到 POST', captured.method, 'POST')
  check('mock 收到的 Action', captured.query?.Action, 'SendSmsVerifyCode')
  check('mock 收到的手机号', captured.query?.PhoneNumber, '13900139000')
  check('mock 收到的目标端点参数完整', [captured.query?.CountryCode, captured.query?.SignName, captured.query?.TemplateCode], ['86', TEST_CONFIG.signName, TEST_CONFIG.templateCode])

  const capturedSignedParams = { ...(captured.query || {}) }
  const capturedSignature = String(capturedSignedParams.Signature || '')
  delete capturedSignedParams.Signature
  const expectedForCaptured = independentSignature(capturedSignedParams, TEST_CONFIG.accessKeySecret)
  check('mock 收到的签名可被独立实现验证通过', capturedSignature, expectedForCaptured.signature)

  console.log('\n[3] 未配置密钥：明确失败，不静默跳过')
  resetSmsEnv()
  check('hasSmsProviderCredentials 为 false', hasSmsProviderCredentials(), false)
  const unconfigured = await sendSmsVerifyCode('13800138000')
  check('下发返回失败', unconfigured.ok, false)
  check('错误信息包含缺失的密钥名', /ALIYUN_SMS_ACCESS_KEY_ID/.test(String(unconfigured.error)), true)
  check('错误信息包含缺失的密钥名（Secret）', /ALIYUN_SMS_ACCESS_KEY_SECRET/.test(String(unconfigured.error)), true)

  console.log('\n[4] 只配了密钥、漏配签名/模板：报配置错误，而不是回落默认值')
  resetSmsEnv()
  process.env.ALIYUN_SMS_ACCESS_KEY_ID = TEST_CONFIG.accessKeyId
  process.env.ALIYUN_SMS_ACCESS_KEY_SECRET = TEST_CONFIG.accessKeySecret
  check('hasSmsProviderCredentials 为 true', hasSmsProviderCredentials(), true)
  const incomplete = await sendSmsVerifyCode('13800138000')
  check('下发返回失败', incomplete.ok, false)
  check('错误信息点名 ALIYUN_SMS_SIGN_NAME', /ALIYUN_SMS_SIGN_NAME/.test(String(incomplete.error)), true)
  check('错误信息点名 ALIYUN_SMS_TEMPLATE_CODE', /ALIYUN_SMS_TEMPLATE_CODE/.test(String(incomplete.error)), true)
  let readError = ''
  try {
    readSmsProviderConfig()
  } catch (error) {
    readError = error instanceof Error ? error.message : String(error)
  }
  check('readSmsProviderConfig 抛错而非返回默认值', /短信通道配置缺失/.test(readError), true)

  // 还原环境，避免影响同一进程里后续逻辑（若有）。
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key]
  }
  Object.assign(process.env, ORIGINAL_ENV)

  console.log(`\n结果：通过 ${passed}，失败 ${failed}`)
  if (failed > 0) {
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('[auth-sms-provider] 测试异常:', error)
  process.exit(1)
})
