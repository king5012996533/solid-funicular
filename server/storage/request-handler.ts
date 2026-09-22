import { readRawBuffer, sendJson } from '../ai-gateway/shared'
import { saveUploadedBuffer } from './service'
import { requireCurrentSessionUser } from '../auth/session'

/**
 * 允许上传的媒体类型（白名单）。
 *
 * 为什么必须有：实测**未登录**也能上传，并且 `.html` 会以 `text/html` 原样回显 ——
 * 也就是同源存储型 XSS：攻击者上传一个页面，诱导已登录用户（含管理员）打开，
 * 就能以该用户身份在我们站内发起请求。同时它还是一条免登录的写盘通道（刷爆磁盘/占额度）。
 */
const ALLOWED_UPLOAD_MIME = [
  'image/', 'video/', 'audio/',
]
/** 明确禁止的类型：即使 MIME 伪装，也按扩展名再拦一道 */
const BLOCKED_UPLOAD_EXT = ['html', 'htm', 'svg', 'js', 'mjs', 'xhtml', 'xml']

const isAllowedUpload = (mimeType: string, filename: string) => {
  const mime = String(mimeType || '').toLowerCase()
  const ext = String(filename || '').split('.').pop()?.toLowerCase() || ''
  if (BLOCKED_UPLOAD_EXT.includes(ext)) return false
  return ALLOWED_UPLOAD_MIME.some((prefix) => mime.startsWith(prefix))
}

// 处理文件上传请求。
export const handleStorageUploadRequest = async (req: any, res: any) => {
  try {
    // 上传必须登录：未登录直接拒（原先没有任何校验，是免登录写盘 + 同源 XSS 的入口）。
    const user = await requireCurrentSessionUser(req, res)
    if (!user) return

    // 仅允许 POST 上传。
    if (req.method !== 'POST') {
      sendJson(res, 405, {
        message: 'Method Not Allowed',
        error: {
          type: 'storage_upload_error',
          message: 'Method Not Allowed',
        },
      })
      return
    }

    // 读取请求体原始二进制内容。
    const buffer = await readRawBuffer(req)

    // 空文件直接拒绝。
    if (!buffer.byteLength) {
      sendJson(res, 400, {
        message: '上传内容不能为空',
        error: {
          type: 'storage_upload_error',
          message: '上传内容不能为空',
        },
      })
      return
    }

    // 从请求头读取文件名。
    const filename = String(req.headers['x-upload-filename'] || '').trim()

    // 从请求头读取文件 MIME 类型。
    const mimeType = String(req.headers['content-type'] || 'application/octet-stream').trim()

    // 类型白名单：只放行图片/视频/音频，显式拦掉 html/svg/js 这类可执行内容。
    if (!isAllowedUpload(mimeType, filename)) {
      sendJson(res, 400, {
        message: '不支持的上传类型',
        error: {
          type: 'storage_upload_error',
          message: '仅支持图片、视频、音频文件',
        },
      })
      return
    }

    // 从请求头读取上传分类。
    const category = String(req.headers['x-upload-category'] || 'general').trim()

    // 保存文件到本地上传目录。
    const savedFile = await saveUploadedBuffer({
      buffer,
      filename,
      mimeType,
      category,
    })

    // 返回上传结果。
    sendJson(res, 200, {
      data: savedFile,
      message: '上传成功',
    })
  } catch (error: any) {
    // 返回统一错误结构。
    sendJson(res, 500, {
      message: error?.message || '文件上传失败',
      error: {
        type: 'storage_upload_error',
        message: error?.message || '文件上传失败',
      },
    })
  }
}
