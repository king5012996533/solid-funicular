import { buildApiUrl } from '@/api/http'
import { handleUnauthorizedResponse, readApiData } from '@/api/response'

export interface WorkflowDefinitionSummary {
  id: string
  userId: string | null
  code: string
  name: string
  description: string | null
  category: string | null
  scene: string
  sourceType: string
  status: string
  currentVersionId: string | null
  latestVersionNo: number
  isBuiltIn: boolean
  isEnabled: boolean
  sortOrder: number
  tagsJson: unknown
  createdAt: string
  updatedAt: string
  currentVersion?: WorkflowDefinitionVersionDetail | null
  latestVersion?: WorkflowDefinitionVersionDetail | null
  versionCount: number
}

export interface WorkflowDefinitionVersionDetail {
  id: string
  workflowId: string
  createdBy: string | null
  versionNo: number
  versionName: string | null
  changeSummary: string | null
  status: string
  definitionJson: unknown
  nodesJson: unknown
  edgesJson: unknown
  viewportJson: unknown
  inputSchemaJson: unknown
  outputSchemaJson: unknown
  runtimeConfigJson: unknown
  publishedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface WorkflowDefinitionDetailResponse {
  definition: WorkflowDefinitionSummary
  versions: WorkflowDefinitionVersionDetail[]
}

export interface WorkflowDefinitionListQuery {
  scene?: string
  status?: string
  keyword?: string
  page?: number
  pageSize?: number
  /**
   * 只看「我自己的」画布，并按 updatedAt 倒序（不带系统内置）。
   * 用在「无 workflowId 时回到上次那张画布」：默认列表把 user 与内置画布混在一起、
   * 还先按 sortOrder 排，直接取第一条会打开一张系统画布而不是用户自己的。
   */
  mine?: boolean
}

export interface WorkflowDefinitionListResponse {
  items: WorkflowDefinitionSummary[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
}

export interface WorkflowDefinitionCreatePayload {
  code?: string
  name?: string
  description?: string | null
  category?: string | null
  scene?: string
  sourceType?: string
  status?: string
  isBuiltIn?: boolean
  isEnabled?: boolean
  sortOrder?: number
  tagsJson?: unknown
  versionName?: string | null
  changeSummary?: string | null
  definitionJson?: unknown
  nodesJson?: unknown
  edgesJson?: unknown
  viewportJson?: unknown
  inputSchemaJson?: unknown
  outputSchemaJson?: unknown
  runtimeConfigJson?: unknown
}

export interface WorkflowDefinitionVersionPayload {
  versionName?: string | null
  changeSummary?: string | null
  status?: string
  definitionJson?: unknown
  nodesJson?: unknown
  edgesJson?: unknown
  viewportJson?: unknown
  inputSchemaJson?: unknown
  outputSchemaJson?: unknown
  runtimeConfigJson?: unknown
}

export interface WorkflowDefinitionUpdatePayload {
  name?: string
  description?: string | null
  category?: string | null
  status?: string
  isEnabled?: boolean
  sortOrder?: number
  tagsJson?: unknown
}

const WORKFLOW_DEFINITIONS_PATH = '/api/workflows'

const buildWorkflowListUrl = (query: WorkflowDefinitionListQuery = {}) => {
  const url = new URL(buildApiUrl(WORKFLOW_DEFINITIONS_PATH), window.location.origin)

  if (query.scene) {
    url.searchParams.set('scene', query.scene)
  }

  if (query.status) {
    url.searchParams.set('status', query.status)
  }

  if (query.keyword) {
    url.searchParams.set('keyword', query.keyword)
  }

  if (query.page) {
    url.searchParams.set('page', String(query.page))
  }

  if (query.pageSize) {
    url.searchParams.set('pageSize', String(query.pageSize))
  }

  if (query.mine) {
    url.searchParams.set('mine', '1')
  }

  return `${url.pathname}${url.search}`
}

const requestWorkflowApi = async <T>(input: {
  url: string
  method?: string
  data?: unknown
  successMessage?: string
}) => {
  const response = await fetch(buildApiUrl(input.url), {
    method: input.method || 'GET',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: input.data === undefined ? undefined : JSON.stringify(input.data),
  })

  handleUnauthorizedResponse(response.status, 'workflow-definitions')

  return await readApiData<T>(response, {
    showSuccessMessage: Boolean(input.successMessage),
    successMessage: input.successMessage,
  })
}

export const listWorkflowDefinitions = async (query: WorkflowDefinitionListQuery = {}) => {
  return await requestWorkflowApi<WorkflowDefinitionListResponse>({
    url: buildWorkflowListUrl(query),
  })
}

export const getWorkflowDefinitionDetail = async (workflowId: string) => {
  return await requestWorkflowApi<WorkflowDefinitionDetailResponse>({
    url: `${WORKFLOW_DEFINITIONS_PATH}/${encodeURIComponent(workflowId)}`,
  })
}

export const createWorkflowDefinition = async (payload: WorkflowDefinitionCreatePayload) => {
  return await requestWorkflowApi<WorkflowDefinitionDetailResponse>({
    url: WORKFLOW_DEFINITIONS_PATH,
    method: 'POST',
    data: payload,
    successMessage: '工作流已创建',
  })
}

export const createWorkflowDefinitionVersion = async (
  workflowId: string,
  payload: WorkflowDefinitionVersionPayload,
) => {
  return await requestWorkflowApi<WorkflowDefinitionVersionDetail>({
    url: `${WORKFLOW_DEFINITIONS_PATH}/${encodeURIComponent(workflowId)}/versions`,
    method: 'POST',
    data: payload,
    successMessage: '工作流版本已保存',
  })
}

export const updateWorkflowDefinition = async (
  workflowId: string,
  payload: WorkflowDefinitionUpdatePayload,
) => {
  return await requestWorkflowApi<WorkflowDefinitionDetailResponse>({
    url: `${WORKFLOW_DEFINITIONS_PATH}/${encodeURIComponent(workflowId)}`,
    method: 'PATCH',
    data: payload,
    successMessage: '工作流已更新',
  })
}

export const deleteWorkflowDefinition = async (workflowId: string) => {
  return await requestWorkflowApi<{ id: string; name: string; deleted: boolean }>({
    url: `${WORKFLOW_DEFINITIONS_PATH}/${encodeURIComponent(workflowId)}`,
    method: 'DELETE',
    successMessage: '工作流已删除',
  })
}

/**
 * 画布正被流水线占用（服务端 409）。
 *
 * 单独一个错误类型、并且**走自己的 fetch** 而不是复用 requestWorkflowApi：
 * 后者把错误统一成一条 message，前端就分不出「保存失败」和「被 Agent 占用」——
 * 而这两件事对用户的意义完全不同（后者要暂存编辑、等锁释放后重发，绝不能丢）。
 */
export class WorkflowCanvasLockedError extends Error {
  readonly holder?: { acquiredAt: number; expiresAt: number }
  constructor(message: string, holder?: { acquiredAt: number; expiresAt: number }) {
    super(message)
    this.name = 'WorkflowCanvasLockedError'
    this.holder = holder
  }
}

export const autosaveWorkflowDefinitionDraft = async (
  workflowId: string,
  payload: WorkflowDefinitionVersionPayload,
  options: { pipelineToken?: string } = {},
) => {
  const response = await fetch(buildApiUrl(`${WORKFLOW_DEFINITIONS_PATH}/${encodeURIComponent(workflowId)}/draft`), {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    // token 跟着业务载荷一起走：服务端从 body 里取（它同时也接受 x-pipeline-token 头）
    body: JSON.stringify({ ...payload, pipelineToken: options.pipelineToken || undefined }),
  })

  handleUnauthorizedResponse(response.status, 'workflow-definitions')

  if (response.status === 409) {
    const body = await response.json().catch(() => null)
    if (body?.code === 'canvas_locked_by_pipeline') {
      throw new WorkflowCanvasLockedError(body?.message || '这块画布正在被 Agent 的这轮执行占用', body?.data?.holder)
    }
  }

  return await readApiData<WorkflowDefinitionVersionDetail>(response)
}

/**
 * 取/放「流水线锁」。
 *
 * 画布页在制片 Agent 开跑前取锁（服务端会顺带留一份快照），跑完释放；
 * 持锁期间，**不带 token 的保存会被 409 拦下** —— 那条路走的是
 * WorkflowCanvasLockedError，前端据此暂存编辑而不是丢掉。
 */
export const acquireWorkflowPipelineLock = async (workflowId: string, label?: string) => {
  /**
   * 走自己的 fetch 而不是 requestWorkflowApi：409（被占用）要和「真·错误」分开。
   * 占用是可操作状态（提示用户等 / 或强制释放），错误不是 —— 混成一条 message，
   * 面板就只能一律显示「画布已被占用」，还错误地给出强制释放按钮。
   */
  const response = await fetch(
    buildApiUrl(`${WORKFLOW_DEFINITIONS_PATH}/${encodeURIComponent(workflowId)}/pipeline-lock`),
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    },
  )

  handleUnauthorizedResponse(response.status, 'workflow-definitions')

  if (response.status === 409) {
    const body = await response.json().catch(() => null)
    throw new WorkflowCanvasLockedError(
      body?.message || '这块画布正在被另一个流水线执行占用',
      body?.data?.holder,
    )
  }

  return await readApiData<{ token: string; snapshotVersionId: string; expiresAt: number }>(response)
}

export const releaseWorkflowPipelineLock = async (workflowId: string, token: string) => {
  return await requestWorkflowApi<{ released: boolean }>({
    url: `${WORKFLOW_DEFINITIONS_PATH}/${encodeURIComponent(workflowId)}/pipeline-lock/release`,
    method: 'POST',
    data: { token },
  })
}

export interface WorkflowPipelineLockStatus {
  locked: boolean
  holder: { acquiredAt: number; expiresAt: number } | null
}

/**
 * 只读查询画布上有没有生效中的流水线锁。
 *
 * 首页「说完话 → 新建画布 → 自动交给 Agent」在发送前用它做占用保护：
 * 有锁就只把话填进输入框、不发送。**只读**，不建快照、不占锁 —— 探测本身不能成为一次写入。
 */
export const getWorkflowPipelineLockStatus = async (workflowId: string) => {
  return await requestWorkflowApi<WorkflowPipelineLockStatus>({
    url: `${WORKFLOW_DEFINITIONS_PATH}/${encodeURIComponent(workflowId)}/pipeline-lock`,
  })
}

/**
 * 强制释放自己画布上的锁（无需 token）。
 *
 * 用在「任务其实早跑完、锁却没被正常放掉」这种孤儿锁场景：用户被自己的锁挡在门外时，
 * 不该干等 TTL。服务端只放 userId 匹配的那把，不会影响别人的并发保护。
 */
export const forceReleaseWorkflowPipelineLock = async (workflowId: string) => {
  return await requestWorkflowApi<{ released: boolean; forced?: boolean }>({
    url: `${WORKFLOW_DEFINITIONS_PATH}/${encodeURIComponent(workflowId)}/pipeline-lock/release?force=1`,
    method: 'POST',
    data: { force: true },
    successMessage: '已强制释放画布锁',
  })
}

export const publishWorkflowDefinition = async (workflowId: string, versionId?: string) => {
  return await requestWorkflowApi<WorkflowDefinitionVersionDetail>({
    url: `${WORKFLOW_DEFINITIONS_PATH}/${encodeURIComponent(workflowId)}/publish`,
    method: 'POST',
    data: versionId ? { versionId } : {},
    successMessage: '工作流版本已发布',
  })
}
