import { acquirePipelineLock, releasePipelineLock } from './pipeline-lock'
import { WorkflowLockedByPipelineError } from './service'
import { sendJson } from '../ai-gateway/shared'
import { requireCurrentSessionUser } from '../auth/session'
import { isPrismaConfigured } from '../db/prisma'
import { WORKFLOW_DEFINITIONS_BASE_PATH } from './constants'
import {
  autosaveWorkflowDefinitionDraft,
  createWorkflowDefinition,
  createWorkflowDefinitionVersion,
  deleteWorkflowDefinition,
  getWorkflowDefinitionDetail,
  listWorkflowDefinitions,
  publishWorkflowDefinition,
  updateWorkflowDefinition,
} from './service'
import {
  readWorkflowDefinitionBody,
  sendWorkflowDefinitionError,
  type WorkflowDefinitionCreatePayload,
  type WorkflowDefinitionPublishPayload,
  type WorkflowDefinitionUpdatePayload,
  type WorkflowDefinitionVersionPayload,
} from './shared'

const matchWorkflowDetailPath = (requestPath: string) => {
  const matched = requestPath.match(/^\/api\/workflows\/([^/]+)$/)
  if (!matched) {
    return null
  }

  return {
    workflowId: decodeURIComponent(matched[1]),
  }
}

const matchWorkflowVersionsPath = (requestPath: string) => {
  const matched = requestPath.match(/^\/api\/workflows\/([^/]+)\/versions$/)
  if (!matched) {
    return null
  }

  return {
    workflowId: decodeURIComponent(matched[1]),
  }
}

const matchWorkflowPublishPath = (requestPath: string) => {
  const matched = requestPath.match(/^\/api\/workflows\/([^/]+)\/publish$/)
  if (!matched) {
    return null
  }

  return {
    workflowId: decodeURIComponent(matched[1]),
  }
}

/** POST /api/workflows/:id/pipeline-lock —— 制片 Agent 开跑前取锁（同时留一份快照） */
const matchWorkflowPipelineLockPath = (requestPath: string) => {
  const matched = requestPath.match(/^\/api\/workflows\/([^/]+)\/pipeline-lock$/)
  return matched ? { workflowId: decodeURIComponent(matched[1]) } : null
}

/** POST /api/workflows/:id/pipeline-lock/release —— 本轮结束（成功/失败都）释放 */
const matchWorkflowPipelineLockReleasePath = (requestPath: string) => {
  const matched = requestPath.match(/^\/api\/workflows\/([^/]+)\/pipeline-lock\/release$/)
  return matched ? { workflowId: decodeURIComponent(matched[1]) } : null
}

const matchWorkflowDraftPath = (requestPath: string) => {
  const matched = requestPath.match(/^\/api\/workflows\/([^/]+)\/draft$/)
  if (!matched) {
    return null
  }

  return {
    workflowId: decodeURIComponent(matched[1]),
  }
}

// 处理工作流定义与版本相关请求。
export const handleWorkflowDefinitionsRequest = async (req: any, res: any) => {
  try {
    if (!isPrismaConfigured()) {
      sendWorkflowDefinitionError(res, 500, '缺少 DATABASE_URL，暂时无法使用工作流定义能力。')
      return
    }

    const currentUser = await requireCurrentSessionUser(req, res)
    if (!currentUser) {
      return
    }

    const requestUrl = new URL(String(req.url || ''), 'http://localhost')
    const requestPath = requestUrl.pathname
    const workflowDetailMatch = matchWorkflowDetailPath(requestPath)
    const workflowVersionsMatch = matchWorkflowVersionsPath(requestPath)
    const workflowPublishMatch = matchWorkflowPublishPath(requestPath)
    const workflowDraftMatch = matchWorkflowDraftPath(requestPath)
    const workflowPipelineLockMatch = matchWorkflowPipelineLockPath(requestPath)
    const workflowPipelineLockReleaseMatch = matchWorkflowPipelineLockReleasePath(requestPath)

    if (req.method === 'GET' && requestPath === WORKFLOW_DEFINITIONS_BASE_PATH) {
      const data = await listWorkflowDefinitions({
        scene: requestUrl.searchParams.get('scene') || undefined,
        status: requestUrl.searchParams.get('status') || undefined,
        keyword: requestUrl.searchParams.get('keyword') || undefined,
        page: Number(requestUrl.searchParams.get('page') || 1),
        pageSize: Number(requestUrl.searchParams.get('pageSize') || 12),
      }, {
        currentUserId: currentUser.id,
      })
      sendJson(res, 200, { data })
      return
    }

    if (req.method === 'POST' && requestPath === WORKFLOW_DEFINITIONS_BASE_PATH) {
      const payload = await readWorkflowDefinitionBody<WorkflowDefinitionCreatePayload>(req)
      const data = await createWorkflowDefinition(payload, {
        currentUserId: currentUser.id,
      })
      sendJson(res, 200, { data, message: '工作流已创建' })
      return
    }

    if (req.method === 'GET' && workflowDetailMatch) {
      const data = await getWorkflowDefinitionDetail(workflowDetailMatch.workflowId, {
        currentUserId: currentUser.id,
      })
      sendJson(res, 200, { data })
      return
    }

    if (req.method === 'PATCH' && workflowDetailMatch) {
      // 与 draft 同一套：token 从 body 或请求头取，缺了就是「外部写入」，持锁期间会被 409 拦下
      const payload = await readWorkflowDefinitionBody<WorkflowDefinitionUpdatePayload>(req)
      const data = await updateWorkflowDefinition(workflowDetailMatch.workflowId, payload, {
        currentUserId: currentUser.id,
        pipelineToken: String((payload as { pipelineToken?: string })?.pipelineToken || req.headers?.['x-pipeline-token'] || ''),
      })
      sendJson(res, 200, { data, message: '工作流已更新' })
      return
    }

    if (req.method === 'DELETE' && workflowDetailMatch) {
      const data = await deleteWorkflowDefinition(workflowDetailMatch.workflowId, {
        currentUserId: currentUser.id,
      })
      sendJson(res, 200, { data, message: '工作流已删除' })
      return
    }

    if (req.method === 'POST' && workflowVersionsMatch) {
      const payload = await readWorkflowDefinitionBody<WorkflowDefinitionVersionPayload>(req)
      const data = await createWorkflowDefinitionVersion(workflowVersionsMatch.workflowId, payload, {
        currentUserId: currentUser.id,
        pipelineToken: String((payload as { pipelineToken?: string })?.pipelineToken || req.headers?.['x-pipeline-token'] || ''),
      })
      sendJson(res, 200, { data, message: '工作流版本已保存' })
      return
    }

    /**
     * 取流水线锁：跑之前占住这块画布，并留一份快照用于失败回滚。
     *
     * 返回 409 表示已被别的流水线占着 —— 这时**不抢占**，把持锁者是谁告诉调用方，
     * 由它决定是等还是提示用户（抢占会让前一轮的中间成果变成孤儿）。
     */
    if (req.method === 'POST' && workflowPipelineLockMatch) {
      const payload = await readWorkflowDefinitionBody<{ label?: string }>(req).catch(() => ({ label: undefined }))
      const result = await acquirePipelineLock({
        workflowId: workflowPipelineLockMatch.workflowId,
        userId: currentUser.id,
        label: payload?.label,
      })
      if (result.ok) {
        sendJson(res, 200, { data: result.lock })
        return
      }
      if (result.reason === 'locked') {
        sendWorkflowDefinitionError(res, 409, `这块画布正在被另一个流水线执行占用（自 ${new Date(result.holder.acquiredAt).toLocaleTimeString('zh-CN')} 起），请等它结束或先停止它。`)
        return
      }
      sendWorkflowDefinitionError(res, result.reason === 'not_found' ? 404 : 403, '无法获取画布锁')
      return
    }

    if (req.method === 'POST' && workflowPipelineLockReleaseMatch) {
      const payload = await readWorkflowDefinitionBody<{ token?: string }>(req)
      const released = releasePipelineLock(workflowPipelineLockReleaseMatch.workflowId, String(payload?.token || ''))
      if (!released) {
        sendWorkflowDefinitionError(res, 409, '释放失败：锁不存在，或 token 不是持锁者的（不能释放别人的锁）')
        return
      }
      sendJson(res, 200, { data: { released: true } })
      return
    }

    if (req.method === 'PUT' && workflowDraftMatch) {
      const payload = await readWorkflowDefinitionBody<WorkflowDefinitionVersionPayload & { pipelineToken?: string }>(req)
      /**
       * token 从 body 或请求头取（body 优先）。
       *
       * 用请求头是给「同一轮里 Agent 自己的保存」用的：前端不必把它混进业务载荷里，
       * 也不容易在序列化时被漏掉。body 里的字段则方便手工调试。
       */
      const pipelineToken = String(payload?.pipelineToken || req.headers?.['x-pipeline-token'] || '')
      const data = await autosaveWorkflowDefinitionDraft(workflowDraftMatch.workflowId, payload, {
        currentUserId: currentUser.id,
        pipelineToken,
      })
      sendJson(res, 200, { data, message: '工作流草稿已自动保存' })
      return
    }

    if (req.method === 'POST' && workflowPublishMatch) {
      const payload = await readWorkflowDefinitionBody<WorkflowDefinitionPublishPayload>(req)
      const data = await publishWorkflowDefinition(workflowPublishMatch.workflowId, payload, {
        currentUserId: currentUser.id,
      })
      sendJson(res, 200, { data, message: '工作流版本已发布' })
      return
    }

    sendWorkflowDefinitionError(res, 405, 'Method Not Allowed')
  } catch (error: any) {
    /**
     * 画布被流水线占用 → 409，并把持锁时间一并告诉前端。
     *
     * 前端要据此做两件事：① 明确提示「Agent 正在改这块画布」；② 把这次编辑暂存在本地、
     * 等锁释放后重发 —— 而不是让用户的改动静默消失（那比不加锁还糟）。
     */
    if (error instanceof WorkflowLockedByPipelineError) {
      sendJson(res, 409, {
        code: 'canvas_locked_by_pipeline',
        message: error.message,
        data: { holder: error.holder },
      })
      return
    }
    sendWorkflowDefinitionError(res, 500, error?.message || '处理工作流请求失败')
  }
}
