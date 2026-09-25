import { readJsonBody, sendJson } from '../ai-gateway/shared'

export interface WorkflowDefinitionListQuery {
  scene?: string
  status?: string
  keyword?: string
  page?: number
  pageSize?: number
  /**
   * 只看当前用户自己的画布，并按 updatedAt 倒序（`mine=1`）。
   * 「无 id 时回到上次那张画布」要的是用户自己的最近一条；
   * 默认列表含系统内置画布且先按 sortOrder 排，取第一条会拿到内置的。
   */
  mine?: boolean
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

export interface WorkflowDefinitionPublishPayload {
  versionId?: string
}

export const sendWorkflowDefinitionError = (res: any, status: number, message: string) => {
  sendJson(res, status, {
    error: {
      type: 'workflow_definition_error',
      message,
    },
    message,
  })
}

export const readWorkflowDefinitionBody = async <T>(req: any) => {
  return await readJsonBody(req) as T
}
