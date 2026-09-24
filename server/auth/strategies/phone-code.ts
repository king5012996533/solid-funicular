import type { AuthStrategy } from '../types'
import { AuthRequestError } from '../shared'
import { grantLoginReward } from '../../marketing-center/service'
import { hasSmsProviderCredentials, sendSmsVerifyCode } from '../sms-provider'
import { attachVerificationCodeUser, consumeVerificationCodeRecord, createUserSession, createVerificationCodeRecord, getAuthMethodConfig, isVerificationCodeDebugEnabled, isValidPhone, resolveUserByIdentifier, resolveVerificationCodeDebugCode, toAuthUserProfile, updateVerificationCodeRecordCode } from '../service'

// 手机验证码登录策略。
export const phoneCodeStrategy: AuthStrategy = {
  methodType: 'PHONE_CODE',
  category: 'CODE',
  canSendCode: true,
  canLoginWithCode: true,
  async sendCode(context) {
    const phone = context.target.trim()
    if (!isValidPhone(phone)) {
      throw new Error('请输入正确的手机号')
    }

    const record = await createVerificationCodeRecord({
      methodType: 'PHONE_CODE',
      channel: 'PHONE',
      target: phone,
      requesterIp: context.requesterIp,
      userAgent: context.userAgent,
    })

    // 没配短信密钥时：只有显式打开调试开关才回显验证码，否则直接失败。
    // 这里绝不能返回“码已生成”，否则用户永远收不到短信、也看不到错误。
    if (!hasSmsProviderCredentials()) {
      if (!isVerificationCodeDebugEnabled()) {
        throw new AuthRequestError(503, '短信通道未配置，暂时无法下发验证码')
      }
      console.warn('[auth] 未配置短信通道（缺少 ALIYUN_SMS_ACCESS_KEY_ID/SECRET），手机验证码走 AUTH_DEBUG_CODE_ENABLED 调试开关回显，仅限本地开发。')
      return {
        id: record.id,
        target: phone,
        channel: 'PHONE',
        expiresAt: record.expiresAt,
        debugCode: resolveVerificationCodeDebugCode(record.code),
      }
    }

    const dispatch = await sendSmsVerifyCode(phone)
    if (!dispatch.ok || !dispatch.code) {
      // 下发失败必须让接口失败，不能只在日志里报错。
      throw new AuthRequestError(502, `短信发送失败：${dispatch.error || '未知错误'}`)
    }

    // 短信里的验证码由阿里云生成（ReturnVerifyCode 带回），以此落库，
    // 保证“用户收到的码”与“库里存着用来校验的码”是同一个（与老项目 send-code 路由一致）。
    await updateVerificationCodeRecordCode(record.id, dispatch.code)

    return {
      id: record.id,
      target: phone,
      channel: 'PHONE',
      expiresAt: record.expiresAt,
    }
  },
  async login(context) {
    const phone = String(context.target || '').trim()
    const code = String(context.code || '').trim()

    if (!isValidPhone(phone)) {
      throw new Error('请输入正确的手机号')
    }

    if (!/^\d{6}$/.test(code)) {
      throw new Error('请输入 6 位验证码')
    }

    const verificationRecord = await consumeVerificationCodeRecord({
      methodType: 'PHONE_CODE',
      target: phone,
      code,
    })

    const currentMethodConfig = await getAuthMethodConfig('PHONE_CODE')
    const resolvedUser = await resolveUserByIdentifier({
      methodType: 'PHONE_CODE',
      identifier: phone,
      allowSignUp: currentMethodConfig.allowSignUp,
    })

    const user = resolvedUser.user

    await attachVerificationCodeUser(verificationRecord.id, user.id)

    const session = await createUserSession({
      userId: user.id,
      methodType: 'PHONE_CODE',
      identifierSnapshot: phone,
      requesterIp: context.requesterIp,
      userAgent: context.userAgent,
    })

    await grantLoginReward(user.id)

    return {
      token: session.token,
      expiresAt: session.expiresAt,
      user: toAuthUserProfile(user, 'PHONE_CODE'),
    }
  },
}
