import crypto from 'node:crypto'

/**
 * 短信验证码下发通道：阿里云号码认证服务（dypnsapi）。
 *
 * 移植自老项目 SceneFlow 的 web/src/lib/sms.ts —— 老项目用
 * `@alicloud/dypnsapi20170525` + `@alicloud/openapi-client`，服务商不变。
 *
 * 这里不引 SDK，而是按老项目 SDK 的**请求形状 + 签名算法**手写 RPC 请求
 * （逐条对照老项目 node_modules 里 @alicloud/openapi-client / @alicloud/openapi-util 源码）：
 *   - Style=RPC、Method=POST、Pathname=/、协议 HTTPS，全部参数走 query（无 body）
 *   - Action=SendSmsVerifyCode、Version=2017-05-25
 *   - 公共参数：Format=json、SignatureMethod=HMAC-SHA1、SignatureVersion=1.0、
 *     AccessKeyId、Timestamp（UTC，YYYY-MM-DDTHH:mm:ssZ）、SignatureNonce
 *   - StringToSign = "POST&%2F&" + percentEncode(按 key 升序拼接的 canonicalizedQuery)
 *   - Signature = Base64(HMAC-SHA1(StringToSign, AccessKeySecret + "&"))
 * 手写的原因：SDK 会拖入 20+ 个传递依赖，且请求体对调用方不可见、无法干跑核对。
 */

// 端点与 API 版本与老项目 SDK 完全一致。
const ALIYUN_SMS_ENDPOINT = 'https://dypnsapi.aliyuncs.com'
const ALIYUN_SMS_API_VERSION = '2017-05-25'

// 验证码在阿里云侧的有效期（秒）与位数，与老项目一致。
const SMS_CODE_VALID_SECONDS = 300
const SMS_CODE_LENGTH = 6
// 模板里 ${min} 变量的填充值（模板文案形如“验证码${min}分钟内有效”）。
// 缺失会报“模板内容与模板参数不匹配”，所以必须随请求一起传。
const SMS_TEMPLATE_MINUTES = '5'

export interface SmsProviderConfig {
  accessKeyId: string
  accessKeySecret: string
  signName: string
  templateCode: string
  endpoint: string
}

export interface SmsRequestDraft {
  method: 'POST'
  url: string
  query: Record<string, string>
  stringToSign: string
  signature: string
}

export interface SendSmsVerifyCodeResult {
  ok: boolean
  code?: string
  bizId?: string
  error?: string
}

const readEnv = (name: string) => String(process.env[name] || '').trim()

/**
 * 是否具备可下发短信的最低配置（仅密钥）。
 * 只判断 AccessKey 是刻意的：SignName / TemplateCode 缺失属于配置错误，
 * 应该在真正下发时报错，而不是被当成“未配置”静默走调试开关。
 */
export const hasSmsProviderCredentials = () => Boolean(readEnv('ALIYUN_SMS_ACCESS_KEY_ID') && readEnv('ALIYUN_SMS_ACCESS_KEY_SECRET'))

/**
 * 读取完整配置；任何一项缺失都抛错（不回落默认值）。
 * 密钥（AccessKeyId/Secret）与业务配置（签名/模板）都必须在环境变量里显式给出：
 * 老项目对 SignName/TemplateCode 有“速通互联验证码 / 100001”这种测试默认值，
 * 一旦漏配就会拿测试签名去发真实短信 —— 宁可报错也不要静默发错。
 */
export const readSmsProviderConfig = (): SmsProviderConfig => {
  const accessKeyId = readEnv('ALIYUN_SMS_ACCESS_KEY_ID')
  const accessKeySecret = readEnv('ALIYUN_SMS_ACCESS_KEY_SECRET')
  const signName = readEnv('ALIYUN_SMS_SIGN_NAME')
  const templateCode = readEnv('ALIYUN_SMS_TEMPLATE_CODE')
  const missing = [
    ['ALIYUN_SMS_ACCESS_KEY_ID', accessKeyId],
    ['ALIYUN_SMS_ACCESS_KEY_SECRET', accessKeySecret],
    ['ALIYUN_SMS_SIGN_NAME', signName],
    ['ALIYUN_SMS_TEMPLATE_CODE', templateCode],
  ].filter(([, value]) => !value).map(([name]) => name)

  if (missing.length > 0) {
    throw new Error(`短信通道配置缺失：${missing.join('、')}`)
  }

  return {
    accessKeyId,
    accessKeySecret,
    signName,
    templateCode,
    // 端点可用环境变量覆盖，用于指向本地 mock server 做干跑验证；默认仍是阿里云官方端点。
    endpoint: readEnv('ALIYUN_SMS_ENDPOINT') || ALIYUN_SMS_ENDPOINT,
  }
}

// 阿里云 RPC 签名要求的 RFC3986 编码：encodeURIComponent 不含 !'()* 的转义，补齐之。
const percentEncode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)

// 阿里云要求的 UTC 时间戳格式：YYYY-MM-DDTHH:mm:ssZ。
const buildTimestamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

const buildCanonicalizedQuery = (query: Record<string, string>) => Object.keys(query)
  .sort()
  .map((key) => `${percentEncode(key)}=${percentEncode(query[key])}`)
  .join('&')

/**
 * 只构造请求（签名 + URL），不发网络请求。干跑核对与单元测试都走这个入口。
 * timestamp / signatureNonce 可注入，便于得到可复现的签名结果。
 */
export const buildSendSmsVerifyCodeRequest = (
  phoneNumber: string,
  config: SmsProviderConfig,
  options: { timestamp?: string; signatureNonce?: string } = {},
): SmsRequestDraft => {
  const query: Record<string, string> = {
    Action: 'SendSmsVerifyCode',
    Format: 'json',
    Version: ALIYUN_SMS_API_VERSION,
    Timestamp: options.timestamp || buildTimestamp(),
    SignatureNonce: options.signatureNonce || crypto.randomUUID(),
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    AccessKeyId: config.accessKeyId,
    // PhoneNumber 为纯手机号，国家码由独立的 CountryCode 字段指定；
    // 不能像普通短信接口 SendSms 那样把 86 拼进号码，否则阿里云报“手机格式不正确”（老项目踩过）。
    PhoneNumber: phoneNumber,
    CountryCode: '86',
    SignName: config.signName,
    TemplateCode: config.templateCode,
    // 验证码由阿里云生成并写入短信，模板变量用 ##code## 占位；
    // 若把真实码值填进 templateParam，阿里云内部生成流程会失败（返回 UNKNOWN）。
    TemplateParam: JSON.stringify({ code: '##code##', min: SMS_TEMPLATE_MINUTES }),
    ValidTime: String(SMS_CODE_VALID_SECONDS),
    CodeLength: String(SMS_CODE_LENGTH),
    // 让响应把生成的验证码带回，由我方落库校验（与老项目一致）。
    ReturnVerifyCode: 'true',
  }

  const stringToSign = `POST&${percentEncode('/')}&${percentEncode(buildCanonicalizedQuery(query))}`
  const signature = crypto.createHmac('sha1', `${config.accessKeySecret}&`).update(stringToSign).digest('base64')

  const finalQuery = { ...query, Signature: signature }

  return {
    method: 'POST',
    url: `${config.endpoint}/?${buildCanonicalizedQuery(finalQuery)}`,
    query: finalQuery,
    stringToSign,
    signature,
  }
}

const readResponseField = (payload: any, pascalName: string, camelName: string) => {
  const value = payload?.[pascalName] ?? payload?.[camelName]
  return value === undefined || value === null ? '' : String(value)
}

/**
 * 下发短信验证码。
 * 未配置密钥时返回 ok:false（调用方据此走调试开关或直接失败），不静默跳过。
 */
export const sendSmsVerifyCode = async (phoneNumber: string): Promise<SendSmsVerifyCodeResult> => {
  if (!hasSmsProviderCredentials()) {
    return { ok: false, error: '短信通道未配置：缺少 ALIYUN_SMS_ACCESS_KEY_ID / ALIYUN_SMS_ACCESS_KEY_SECRET' }
  }

  let config: SmsProviderConfig
  try {
    config = readSmsProviderConfig()
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '短信通道配置错误' }
  }

  const draft = buildSendSmsVerifyCodeRequest(phoneNumber, config)

  try {
    // 与老项目 SDK 相同：POST + 全部参数在 query，无请求体。
    const response = await fetch(draft.url, { method: draft.method })
    const payload = await response.json().catch(() => null)
    const responseCode = readResponseField(payload, 'Code', 'code')

    if (!response.ok || responseCode !== 'OK') {
      const message = readResponseField(payload, 'Message', 'message')
      return { ok: false, error: message || `阿里云短信接口返回 HTTP ${response.status}` }
    }

    const model = payload?.Model ?? payload?.model ?? {}
    const verifyCode = readResponseField(model, 'VerifyCode', 'verifyCode')
    if (!verifyCode) {
      return { ok: false, error: '阿里云未返回验证码' }
    }

    return {
      ok: true,
      code: verifyCode,
      bizId: readResponseField(model, 'BizId', 'bizId') || undefined,
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '短信发送失败' }
  }
}
