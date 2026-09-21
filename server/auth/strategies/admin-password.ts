import type { AuthStrategy } from '../types'
import { AuthRequestError } from '../shared'
import { createUserSession, getUserByUsername, isValidAdminPassword, isValidAdminUsername, toAuthUserProfile, verifyUserPassword } from '../service'

/**
 * 校验类失败要带状态码。
 *
 * 原先这里一律 `throw new Error(...)`，而 request-handler 的兜底是「非
 * AuthRequestError 就 500」—— 于是「密码打错了」在浏览器里是 500，
 * 看起来像服务端崩了，也会把真实的服务器故障和用户打字错误混进同一个指标里。
 * 凭据不对是 401，格式不合法是 400，都不是 500。
 */
const credentialError = (message: string) => new AuthRequestError(401, message)
const formatError = (message: string) => new AuthRequestError(400, message)

// 管理员账号密码登录策略。
export const adminPasswordStrategy: AuthStrategy = {
  methodType: 'ADMIN_PASSWORD',
  category: 'PASSWORD',
  canLoginWithCode: true,
  async login(context) {
    const username = String(context.target || '').trim()
    const password = String(context.password || '')

    if (!isValidAdminUsername(username)) {
      throw formatError('请输入 4-32 位管理员账号，只能包含字母、数字、下划线或中划线')
    }

    if (!isValidAdminPassword(password)) {
      throw formatError('请输入 8-64 位登录密码')
    }

    const user = await getUserByUsername(username)
    if (!user || user.role !== 'ADMIN') {
      throw credentialError('管理员账号或密码错误')
    }

    const passwordMatched = await verifyUserPassword(password, user.passwordHash)
    if (!passwordMatched) {
      throw credentialError('管理员账号或密码错误')
    }

    const session = await createUserSession({
      userId: user.id,
      methodType: 'ADMIN_PASSWORD',
      identifierSnapshot: username,
      requesterIp: context.requesterIp,
      userAgent: context.userAgent,
    })

    return {
      token: session.token,
      expiresAt: session.expiresAt,
      user: toAuthUserProfile(user, 'ADMIN_PASSWORD'),
    }
  },
}
