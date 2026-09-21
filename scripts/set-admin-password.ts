#!/usr/bin/env node
/**
 * 重设管理员登录密码
 *
 * 为什么需要这个脚本：
 *   应用**没有任何改密码的入口** —— 后端没有 change-password 接口，后台也没有对应页面
 *   （`grep -rn "change.?password|reset.?password" server/ src/api/` 是空的）。
 *   而登录方式目前只启用了「管理员账号密码」（`/api/auth/methods` 只返回 ADMIN_PASSWORD），
 *   邮箱/短信验证码没开 —— 所以密码一旦丢失，账号就彻底进不去，只能从数据库层改。
 *
 * 哈希直接用后端自己的 `hashUserPassword`，不手写 scrypt：
 *   格式是 `scrypt:<salt>:<64字节hex>`，自己拼很容易在 salt 长度或 keylen 上和校验端错开。
 *
 * 用法：
 *   npx tsx --env-file=.env.development scripts/set-admin-password.ts <新密码> [账号名=admin]
 *
 * 副作用：会清掉该账号所有未过期的会话（改完密码应当重新登录）。
 */

import { prisma } from '../server/db/prisma'
import { hashUserPassword, isValidAdminUsername, isValidAdminPassword } from '../server/auth/service'

const main = async () => {
  const [password, username = 'admin'] = process.argv.slice(2)

  if (!password) {
    console.error('用法：npx tsx --env-file=.env.development scripts/set-admin-password.ts <新密码> [账号名=admin]')
    process.exitCode = 1
    return
  }

  if (!isValidAdminUsername(username)) {
    console.error(`账号名不合法（需 4-32 位、字母开头、只能字母数字下划线中划线）：${username}`)
    process.exitCode = 1
    return
  }

  if (!isValidAdminPassword(password)) {
    console.error('密码不合法：长度需 8-64 位')
    process.exitCode = 1
    return
  }

  const user = await prisma.appUser.findUnique({ where: { username } })
  if (!user) {
    console.error(`没有找到账号：${username}`)
    process.exitCode = 1
    return
  }

  if (user.role !== 'ADMIN') {
    console.error(`账号 ${username} 的角色是 ${user.role}，只有 ADMIN 能走管理员账号密码登录`)
    process.exitCode = 1
    return
  }

  const passwordHash = await hashUserPassword(password)
  await prisma.appUser.update({ where: { id: user.id }, data: { passwordHash } })

  // 改完密码把旧会话清掉，避免旧 Cookie 还能继续用
  const revoked = await prisma.appSession.updateMany({
    where: { userId: user.id, revokedAt: null },
    data: { revokedAt: new Date() },
  })

  console.log(`已更新账号 ${username} 的登录密码（密码本身不打印）`)
  console.log(`已撤销 ${revoked.count} 个未过期会话，请重新登录`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
