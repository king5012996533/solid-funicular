/**
 * 画布 Agent 的工具定义（前后端共用的一份真源）—— 2026-09-23
 *
 * 为什么抽到这里：这些工具现在有**两个使用者**
 *   1. 浏览器侧 Agent（`views/workflow/agent/canvas-agent-tools.ts`）—— 直接改画布 store；
 *   2. 服务端 Agent（Pi 的 `AgentTool`）—— 它不能直接改画布（画布是客户端状态），
 *      必须在 `execute` 里发事件请前端执行、再等结果回来。
 * 两边的「工具名/描述/参数」必须是同一份，否则模型学到的是一套、执行的是另一套 ——
 * 这种漂移在这条链路上会表现为「模型老调错工具/参数」，最难查。所以定义放这里，
 * 前端直接用，服务端用 typebox 的 `Type.Unsafe()` 包一层交给 Pi。
 *
 * 参数写的是 JSON Schema（typebox 与 OpenAI function calling 都吃这一套）。
 */

export interface CanvasAgentToolDefinition {
  name: string;
  /** 给模型看的说明：什么时候该用它、用了会怎样 */
  description: string;
  /** JSON Schema */
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** 是否需要前端执行（画布是客户端状态；服务端 Agent 靠这个判断哪些工具要走桥） */
  requiresClient: boolean;
}

export const CANVAS_AGENT_TOOL_DEFINITIONS: CanvasAgentToolDefinition[] = [
  {
    name: "get_canvas_state",
    description:
      "读取当前画布：节点清单（id / 类型 / 提示词 / 模型 / 状态）、连线、当前选中的节点。动手改画布之前先调用它。",
    parameters: { type: "object", properties: {}, required: [] },
    requiresClient: true,
  },
  {
    name: "add_node",
    description:
      "在画布上新增一个节点。type 只能是 text / image / video / asset。可以同时给初始内容（文本节点的 content，图片节点的 prompt、model、size、quality）。",
    parameters: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["text", "image", "video", "asset"],
          description: "节点类型",
        },
        x: {
          type: "number",
          description: "画布横坐标（可选，不填则放在视口中心）",
        },
        y: { type: "number", description: "画布纵坐标（可选）" },
        content: { type: "string", description: "文本节点的内容" },
        prompt: { type: "string", description: "图片/视频节点的提示词" },
        model: { type: "string", description: "模型 key（不填用节点默认）" },
        size: { type: "string", description: "比例/尺寸，如 1:1、16:9" },
        quality: { type: "string", description: "画质档位，如 低/中/高" },
      },
      required: ["type"],
    },
    requiresClient: true,
  },
  {
    name: "update_node",
    description:
      "修改已有节点的内容或参数（提示词、文本内容、模型、尺寸、画质、标题）。只会覆盖显式给出的字段。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "节点 id（来自 get_canvas_state）" },
        content: { type: "string", description: "文本节点的新内容" },
        prompt: { type: "string", description: "新的提示词" },
        label: { type: "string", description: "节点标题" },
        model: { type: "string" },
        size: { type: "string" },
        quality: { type: "string" },
      },
      required: ["id"],
    },
    requiresClient: true,
  },
  {
    name: "connect_nodes",
    description:
      "把两个节点连起来（source 的输出作为 target 的输入）。连线是有方向的。",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", description: "起点节点 id" },
        target: { type: "string", description: "终点节点 id" },
      },
      required: ["source", "target"],
    },
    requiresClient: true,
  },
  {
    name: "remove_node",
    description:
      "删除一个节点（连带它的连线）。删之前先用 get_canvas_state 确认 id。",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    requiresClient: true,
  },
  {
    name: "select_nodes",
    description:
      "在画布上选中若干节点（方便用户看到你在操作哪些），可选把视图对准它们。",
    parameters: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "要选中的节点 id",
        },
        focus: {
          type: "boolean",
          description: "是否把视图移动过去（默认 true）",
        },
      },
      required: ["ids"],
    },
    requiresClient: true,
  },
  {
    name: "run_node",
    description:
      "执行某个节点（图片节点会真的去生成；视频节点当前服务端已接通但仍在验证中）。耗时较长，执行后如实告知结果。",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    requiresClient: true,
  },
  {
    name: "list_workflow_templates",
    description:
      "列出可一键套用的工作流模板（多角度分镜、电商全套、文生图、图生视频等）。",
    parameters: { type: "object", properties: {}, required: [] },
    requiresClient: true,
  },
  {
    name: "apply_workflow_template",
    description:
      "把一个工作流模板整套铺到画布上（会创建多个节点与连线）。适合「帮我把某个流程搭起来」这类需求。",
    parameters: {
      type: "object",
      properties: {
        templateId: {
          type: "string",
          description: "模板 id（先用 list_workflow_templates 拿）",
        },
        x: { type: "number", description: "起点横坐标（可选）" },
        y: { type: "number", description: "起点纵坐标（可选）" },
      },
      required: ["templateId"],
    },
    requiresClient: true,
  },
];

export const findCanvasAgentTool = (name: string) =>
  CANVAS_AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === name);
