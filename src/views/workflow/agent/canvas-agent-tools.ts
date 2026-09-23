/**
 * 画布助手的工具层（2026-09-23）
 *
 * 设计要点
 *   1. **纯函数式注入**：所有画布操作通过 CanvasAgentContext 传进来，工具层自己不 import
 *      画布 store —— 这样能在 Node 里用假 ctx 直接单测（见 scripts/tests/test-canvas-agent-tools.mjs），
 *      也让「模型能对画布做什么」这件事有一份可读、可测的清单。
 *   2. **工具失败要能被模型看见**：每个执行器返回 { ok, ... } 或抛错，循环里都转成 tool 结果，
 *      让模型自己决定重试/换个做法，而不是整轮对话直接崩掉。
 *   3. 只暴露「画布能承受的操作」：新增/改参数/连线/删除/选中/执行/套模板。没有删库、没有改配置。
 */

import {
  CANVAS_AGENT_TOOL_DEFINITIONS,
  describeConfirmationDecision,
  type AgentConfirmationDecision,
  type AgentConfirmationRequest,
} from "@/shared/canvas-agent-tools";

export interface CanvasAgentNodeSnapshot {
  id: string;
  type: string;
  label: string;
  /** 图片/视频节点的提示词或文本节点的内容（截断后给模型，避免把整张图 base64 塞进上下文） */
  text: string;
  model?: string;
  size?: string;
  quality?: string;
  status?: string;
}

export interface CanvasAgentContext {
  /** 当前画布上的节点快照 */
  snapshotNodes: () => CanvasAgentNodeSnapshot[];
  /** 当前连线 */
  snapshotEdges: () => Array<{ source: string; target: string }>;
  /** 当前选中的节点 id */
  selectedIds: () => string[];
  /** 新节点默认落点（通常是视口中心），模型不指定坐标时使用 */
  defaultPosition: () => { x: number; y: number };
  addNode: (
    type: string,
    position: { x: number; y: number },
    data?: Record<string, unknown>,
  ) => string | null;
  updateNode: (id: string, patch: Record<string, unknown>) => boolean;
  removeNode: (id: string) => boolean;
  addEdge: (source: string, target: string) => boolean;
  selectNodes: (ids: string[], focus?: boolean) => void;
  /** 执行某个节点（node 组件注册进来的 runGeneration） */
  runNode: (id: string) => Promise<{ ok: boolean; reason?: string }>;
  /** 套用一个工作流模板，返回创建出的节点/连线数量 */
  applyTemplate: (
    templateId: string,
    position: { x: number; y: number },
  ) => { nodes: number; edges: number } | null;
  /** 模板 id → 名称，供模型选择 */
  listTemplates: () => Array<{ id: string; name: string; description: string }>;
  /** 节点类型说明（让模型知道有哪些 type 可用） */
  nodeTypeHints: () => Array<{ type: string; name: string }>;
  /**
   * 向用户要一个确认（半自动闸门）。
   *
   * 服务端 Agent 在花钱/交付前会调 request_confirmation，这里负责把卡片弹给用户并等答复。
   * 不注入它的话，该工具会明确失败 —— 而不是静默「当作同意」，那样闸门就形同虚设了。
   */
  requestConfirmation?: (
    request: AgentConfirmationRequest,
  ) => Promise<AgentConfirmationDecision>;
}

export interface CanvasAgentToolSchema {
  type: "function";
  function: {
    name: string;
    /** 界面展示用中文名 */
    label: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface CanvasAgentToolResult {
  ok: boolean;
  /** 回给模型的文本（成功摘要或失败原因） */
  result: string;
  /** 给 UI 展示的一行记录 */
  summary: string;
}

const text = (value: unknown, max = 400) => {
  const raw = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
};

/** 工具清单：这是「Agent 能对画布做什么」的唯一来源，模型看到的描述也来自这里 */
/**
 * 工具清单：**从共享真源派生**，不再手写一份。
 *
 * 2026-09-23 改：这份清单原来和服务端（`src/shared/canvas-agent-tools.ts`）各写一份，
 * 两边描述/参数已经开始漂移（例如 run_node 的说明一边写「视频没接通」一边写「视频已接通」）。
 * 漂移的后果是最难查的那种：模型学到的是一套、执行的是另一套，表现为「它老调错工具」。
 * 现在两边都从共享定义派生，改一处两边同时生效，漂移在结构上不可能发生。
 */
export const CANVAS_AGENT_TOOL_SCHEMAS: CanvasAgentToolSchema[] =
  CANVAS_AGENT_TOOL_DEFINITIONS.map((definition) => ({
    type: "function",
    function: {
      name: definition.name,
      label: definition.label,
      description: definition.description,
      parameters: definition.parameters,
    },
  }));

/**
 * 执行一个工具调用。未知工具、参数缺失、节点不存在都返回 ok:false + 明确原因，
 * 由循环把它作为 tool 结果回给模型。
 */
export const executeCanvasAgentTool = async (
  name: string,
  args: Record<string, unknown>,
  ctx: CanvasAgentContext,
): Promise<CanvasAgentToolResult> => {
  const fail = (result: string, summary = result): CanvasAgentToolResult => ({
    ok: false,
    result,
    summary,
  });

  switch (name) {
    case "request_confirmation": {
      const request: AgentConfirmationRequest = {
        title: String(args.title || "请确认"),
        summary: String(args.summary || ""),
        items: Array.isArray(args.items)
          ? args.items.map((item) => String(item))
          : undefined,
        costPoints: Number.isFinite(Number(args.costPoints))
          ? Number(args.costPoints)
          : undefined,
        riskLevel: (["low", "medium", "high"] as readonly unknown[]).includes(
          args.riskLevel,
        )
          ? (args.riskLevel as AgentConfirmationRequest["riskLevel"])
          : "medium",
      };
      if (!request.summary.trim()) {
        return fail("确认事项必须写清 summary（将要做什么）");
      }
      if (!ctx.requestConfirmation) {
        return fail(
          "当前环境不支持向用户确认（没有注入确认入口），因此不能执行任何花钱或交付类动作。请把计划讲给用户，让他自己决定。",
        );
      }
      const decision = await ctx.requestConfirmation(request);
      return {
        ok: decision.approved,
        // 回执必须是 JSON：服务端要按 approved 字段放行后续付费动作
        result: JSON.stringify({
          approved: Boolean(decision.approved),
          note: decision.note || "",
          summary: describeConfirmationDecision(request, decision),
        }),
        summary: decision.approved
          ? `用户同意：${request.title}`
          : `用户拒绝：${request.title}${decision.note ? `（${decision.note}）` : ""}`,
      };
    }
    case "get_canvas_state": {
      const nodes = ctx.snapshotNodes();
      const edges = ctx.snapshotEdges();
      const selected = ctx.selectedIds();
      const payload = {
        nodes: nodes.map((node) => ({
          id: node.id,
          type: node.type,
          label: node.label,
          text: text(node.text, 120),
          model: node.model || undefined,
          size: node.size || undefined,
          quality: node.quality || undefined,
          status: node.status || undefined,
        })),
        edges,
        selectedNodeIds: selected,
        availableNodeTypes: ctx.nodeTypeHints(),
      };
      return {
        ok: true,
        result: JSON.stringify(payload),
        summary: `读取画布：${nodes.length} 个节点、${edges.length} 条连线${selected.length ? `、已选 ${selected.length} 个` : ""}`,
      };
    }
    case "add_node": {
      const type = String(args.type || "").trim();
      const allowed = ctx.nodeTypeHints().map((item) => item.type);
      if (!allowed.includes(type))
        return fail(
          `不支持的节点类型「${type}」，可用：${allowed.join(" / ")}`,
        );
      const base = ctx.defaultPosition();
      const position = {
        x: Number.isFinite(Number(args.x)) ? Number(args.x) : base.x,
        y: Number.isFinite(Number(args.y)) ? Number(args.y) : base.y,
      };
      const data: Record<string, unknown> = {};
      if (typeof args.content === "string") data.content = args.content;
      if (typeof args.prompt === "string") data.prompt = args.prompt;
      if (typeof args.model === "string" && args.model.trim())
        data.model = args.model.trim();
      if (typeof args.size === "string" && args.size.trim())
        data.size = args.size.trim();
      if (typeof args.quality === "string" && args.quality.trim())
        data.quality = args.quality.trim();
      const id = ctx.addNode(type, position, data);
      if (!id) return fail("节点没能创建（画布拒绝了这个类型或数据）");
      return {
        ok: true,
        result: JSON.stringify({ id }),
        summary: `新增 ${type} 节点 ${id}${data.prompt ? `（提示词：${text(data.prompt, 30)}）` : ""}`,
      };
    }
    case "update_node": {
      const id = String(args.id || "").trim();
      if (!id) return fail("缺少节点 id");
      const patch: Record<string, unknown> = {};
      for (const key of [
        "content",
        "prompt",
        "label",
        "model",
        "size",
        "quality",
      ]) {
        const value = args[key];
        if (typeof value === "string") patch[key] = value;
      }
      if (!Object.keys(patch).length) return fail("没有给出任何要修改的字段");
      const ok = ctx.updateNode(id, patch);
      if (!ok) return fail(`找不到节点 ${id}（先用 get_canvas_state 确认）`);
      return {
        ok: true,
        result: JSON.stringify({ id, updated: Object.keys(patch) }),
        summary: `更新节点 ${id}：${Object.keys(patch).join("、")}`,
      };
    }
    case "connect_nodes": {
      const source = String(args.source || "").trim();
      const target = String(args.target || "").trim();
      if (!source || !target) return fail("缺少 source / target");
      if (source === target) return fail("不能把节点连到自己");
      const ids = new Set(ctx.snapshotNodes().map((node) => node.id));
      if (!ids.has(source) || !ids.has(target))
        return fail("节点不存在（先用 get_canvas_state 确认 id）");
      if (!ctx.addEdge(source, target))
        return fail("连线失败（可能已存在同样的连线）");
      return {
        ok: true,
        result: JSON.stringify({ source, target }),
        summary: `连线 ${source} → ${target}`,
      };
    }
    case "remove_node": {
      const id = String(args.id || "").trim();
      if (!id) return fail("缺少节点 id");
      if (!ctx.removeNode(id)) return fail(`找不到节点 ${id}`);
      return {
        ok: true,
        result: JSON.stringify({ id }),
        summary: `删除节点 ${id}（含其连线）`,
      };
    }
    case "select_nodes": {
      const ids = Array.isArray(args.ids)
        ? args.ids.map((item) => String(item || "").trim()).filter(Boolean)
        : [];
      if (!ids.length) return fail("ids 不能为空");
      const focus = args.focus !== false;
      ctx.selectNodes(ids, focus);
      return {
        ok: true,
        result: JSON.stringify({ selected: ids }),
        summary: `选中 ${ids.length} 个节点${focus ? "并把视图移过去" : ""}`,
      };
    }
    case "run_node": {
      const id = String(args.id || "").trim();
      if (!id) return fail("缺少节点 id");
      const outcome = await ctx.runNode(id);
      if (!outcome.ok) return fail(`执行失败：${outcome.reason || "未知原因"}`);
      return {
        ok: true,
        result: JSON.stringify({ id, started: true }),
        summary: `已触发节点 ${id} 执行`,
      };
    }
    case "list_workflow_templates": {
      const templates = ctx.listTemplates();
      return {
        ok: true,
        result: JSON.stringify(templates),
        summary: `列出 ${templates.length} 个可用模板`,
      };
    }
    case "apply_workflow_template": {
      const templateId = String(args.templateId || "").trim();
      if (!templateId) return fail("缺少 templateId");
      const base = ctx.defaultPosition();
      const position = {
        x: Number.isFinite(Number(args.x)) ? Number(args.x) : base.x,
        y: Number.isFinite(Number(args.y)) ? Number(args.y) : base.y,
      };
      const created = ctx.applyTemplate(templateId, position);
      if (!created)
        return fail(
          `没有这个模板：${templateId}（先用 list_workflow_templates 拿 id）`,
        );
      return {
        ok: true,
        result: JSON.stringify(created),
        summary: `套用模板 ${templateId}：新增 ${created.nodes} 个节点、${created.edges} 条连线`,
      };
    }
    default:
      return fail(`没有这个工具：${name}`);
  }
};
