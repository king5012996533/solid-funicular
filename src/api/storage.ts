import { buildApiUrl } from './http'
import { readApiData, type ApiMessageOptions } from './response'

// 本地文件上传分类。
export type StorageUploadCategory = 'general' | 'asset' | 'avatar' | 'publish' | 'reference'

// 上传成功后返回的文件信息。
export interface UploadedStorageFile {
  filePath: string
  relativePath: string
  publicUrl: string
  filename: string
  mimeType: string
  size: number
  storageType?: 'local' | 'object'
  storageCode?: string
}

// 上传浏览器文件到后端本地存储。
export const uploadStorageFile = async (
  file: File,
  category: StorageUploadCategory = 'general',
  messageOptions: ApiMessageOptions = {},
) => {
  // 以原始二进制方式发给后端，避免额外 multipart 依赖。
  const response = await fetch(buildApiUrl('/api/storage/upload'), {
    method: 'POST',
    /*
     * `credentials: 'include'` 是必须的，2026-09-26 真机踩到：
     * `buildApiUrl` 在配了 `VITE_API_BASE_URL` 时会产出**跨源绝对地址**
     * （开发环境是 http://localhost:5409，而页面在 5010），而 fetch 默认是
     * `same-origin` —— 跨源时**不带 cookie**，于是上传稳定 401，
     * 界面上表现为新节点显示「当前未登录或登录已失效」。
     * 影响面：上传参考图、裁剪生成新节点、视频抽帧等**所有走本接口的素材上传**。
     * 同类接口（points / auth / asset-items …）本来就都带这个字段，这里属于漏写。
     */
    credentials: 'include',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'x-upload-filename': encodeURIComponent(file.name || 'file'),
      'x-upload-category': category,
    },
    body: file,
  })

  // 返回后端保存结果。
  return readApiData<UploadedStorageFile>(response, {
    showSuccessMessage: false,
    showErrorMessage: true,
    ...messageOptions,
  })
}
