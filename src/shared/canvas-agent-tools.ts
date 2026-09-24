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

/**
 * 任务策略的「技能键」：前端提交任务时带 `type: 'agent' + skill: 'canvas-agent'`，
 * 服务端据此选中制片 Agent 策略。前后端共用同一个常量，避免某一边改字符串导致
 * 「任务提交成功但走的是普通对话」这种沉默失败。
 */
export const CANVAS_AGENT_SKILL_KEY = "canvas-agent";

export interface CanvasAgentToolDefinition {
  name: string;
  /** 界面展示用的中文名（工具执行记录、确认卡片上都用它，比英文名可读得多） */
  label: string;
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
    /**
     * 半自动的闸门（2026-09-23 定的产品规则）。
     *
     * 用户要的是「Agent 能干活，但不是让它自己刷卡」：凡是**花钱**（生成图片/视频）和**交付**
     * （把成果定稿、导出、覆盖已有作品）这两类动作，Agent 必须先停在这里等人点确认。
     * 所以它不是给模型用的「礼貌询问」，而是这类动作的**唯一合法入口** ——
     * 模型的系统提示里写明「未取得确认不得触发付费动作」，同时服务端把这条作为审计记录落库。
     */
    name: "request_confirmation",
    label: "向用户确认",
    description:
      "【必须先调用】在执行任何**花钱**（生成图片 / 生成视频）或**交付**（定稿、覆盖已有成果、批量删除）的动作之前，用这个工具向用户展示确认卡片并等待答复。用户同意才继续，拒绝就换做法或向他说明。摘要要写清「将要发生什么 + 预计消耗多少积分」。",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "确认卡片标题，例如「生成 6 张分镜图」",
        },
        summary: {
          type: "string",
          description: "将要做什么、做几步、产出是什么（给用户看的完整说明）",
        },
        items: {
          type: "array",
          items: { type: "string" },
          description: "逐条列出涉及的节点 / 提示词 / 文件，便于用户核对",
        },
        costPoints: {
          type: "number",
          description: "预计消耗的积分总数（不确定就填可靠上界，不要留空）",
        },
        riskLevel: {
          type: "string",
          enum: ["low", "medium", "high"],
          description:
            "风险等级：low = 新增内容不影响已有成果；medium = 覆盖部分已有内容；high = 不可逆或大批量消耗",
        },
      },
      required: ["title", "summary"],
    },
    requiresClient: true,
  },
  {
    name: "get_canvas_state",
    label: "读取画布",
    description:
      "读取当前画布：节点清单（id / 类型 / 提示词 / 模型 / 状态）、连线、当前选中的节点。动手改画布之前先调用它。",
    parameters: { type: "object", properties: {}, required: [] },
    requiresClient: true,
  },
  {
    name: "add_node",
    label: "新增节点",
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
    label: "修改节点",
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
    /**
     * 一次建多个节点（2026-09-24，M3）。
     *
     * 为什么必须批量：一条正常的分镜链路是「1 个分镜表 + 2~4 个母版 + 6~12 张分镜图」，
     * 逐个调 add_node 意味着十几轮模型往返，既慢又容易在中途丢步骤（模型忘了建第 7 个）。
     * 一把建完还能顺便把「谁是谁」一次性告诉模型：返回值按输入顺序给出 id。
     */
    name: "add_nodes",
    label: "批量建节点",
    description:
      "一次创建多个节点，返回按输入顺序排列的 id 列表。铺分镜时用它（一次不要超过 12 个）。每个节点都要给 type；图片/视频节点请写清 prompt。",
    parameters: {
      type: "object",
      properties: {
        nodes: {
          type: "array",
          description: "要创建的节点列表，按想要的顺序给（返回的 id 顺序与之一致）",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["text", "image", "video", "asset"] },
              label: { type: "string", description: "节点标题，例如「镜号 03」" },
              content: { type: "string", description: "文本节点的内容（type=text 时用）" },
              prompt: { type: "string", description: "图片/视频节点的提示词" },
              model: { type: "string", description: "模型 key（可选，不填用画布默认）" },
              size: { type: "string" },
              quality: { type: "string" },
              x: { type: "number", description: "画布坐标（可选）" },
              y: { type: "number" },
            },
            required: ["type"],
          },
        },
      },
      required: ["nodes"],
    },
    requiresClient: true,
  },
  {
    /**
     * 一次执行多个节点（2026-09-24，M3）。
     *
     * 分镜图是「一批一起出」的活：6 个节点分 6 次调 run_node，界面上就是 6 条零碎的执行记录，
     * 而且模型要在中间反复等待。合成一次调用让「一次确认 → 一把出图」这个流程在日志里也看得清。
     * 仍然是**每个节点各起一个生成任务**（计费、并发、失败重试都还走原有那套），不是新机制。
     */
    name: "run_nodes",
    label: "批量执行节点",
    description:
      "依次执行多个节点（每个节点各自起一个生成任务，跟单独 run_node 等价）。批量出分镜图/视频时用它。会消耗积分，调用前必须先取得用户确认。",
    parameters: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "要执行的节点 id 列表，按执行顺序给",
        },
      },
      required: ["ids"],
    },
    requiresClient: true,
  },
  {
    name: "connect_nodes",
    label: "连接节点",
    description:
      "把两个节点连起来（source 的输出作为 target 的输入）。连线是有方向的。",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", description: "起点节点 id（单条连线时用）" },
        target: { type: "string", description: "终点节点 id（单条连线时用）" },
        links: {
          type: "array",
          description: "一次连多条时用这个：每项 {source,target}。母版连到多个分镜时用它省往返。",
          items: {
            type: "object",
            properties: {
              source: { type: "string" },
              target: { type: "string" },
            },
            required: ["source", "target"],
          },
        },
      },
      required: [],
    },
    requiresClient: true,
  },
  {
    name: "remove_node",
    label: "删除节点",
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
    label: "选中节点",
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
    /**
     * 让用户附的参考图真正进入生产（2026-09-23）。
     *
     * 之前参考图只有一条路：直接走图片生成，Agent 完全接不住 —— 于是「附了图」就绕开了 Agent，
     * 面板也就一直像个生成器。有了这个工具，参考图可以挂到任意图片节点上，
     * 之后 Agent 用 run_node 跑那个节点时，节点会以这些图做参考（图生图）。
     */
    name: "attach_reference_images",
    label: "挂参考图",
    description:
      "把参考图挂到某个图片节点上：挂上之后执行该节点会用这些图做参考（图生图）。默认用用户本轮上传的参考图；也可以显式给 images（图片地址）以引用别的素材。节点上已有参考图时会被替换。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "图片节点 id" },
        images: {
          type: "array",
          items: { type: "string" },
          description: "要挂的图片地址（可选；不填则用用户本轮上传的参考图）",
        },
      },
      required: ["id"],
    },
    requiresClient: true,
  },
  {
    name: "run_node",
    label: "执行节点",
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
    label: "列出模板",
    description:
      "列出可一键套用的工作流模板（多角度分镜、电商全套、文生图、图生视频等）。",
    parameters: { type: "object", properties: {}, required: [] },
    requiresClient: true,
  },
  {
    name: "apply_workflow_template",
    label: "套用模板",
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

/**
 * `request_confirmation` 的参数与回执。
 *
 * 单独定义类型（而不是让两边各写一份 `any`）：这是**半自动闸门**的数据形状，
 * 服务端要按它落审计、客户端要按它渲染卡片，任何一侧改字段都必须让另一侧编译失败。
 */
export interface AgentConfirmationRequest {
  title: string;
  summary: string;
  items?: string[];
  costPoints?: number;
  riskLevel?: "low" | "medium" | "high";
}

export interface AgentConfirmationDecision {
  approved: boolean;
  /** 用户可选补充说明，例如「不要生成第 3 张」 */
  note?: string;
  /** 用户是否选择了「本任务内不再询问同类动作」 */
  remember?: boolean;
}

/** 把确认回执转成给模型看的文本（服务端与客户端共用，避免措辞漂移） */
export const describeConfirmationDecision = (
  request: AgentConfirmationRequest,
  decision: AgentConfirmationDecision,
) => {
  const lines = [
    `确认项：${request.title}`,
    `用户答复：${decision.approved ? "同意" : "拒绝"}`,
  ];
  if (decision.note) {
    lines.push(`用户补充：${decision.note}`);
  }
  if (!decision.approved) {
    lines.push("（不要执行该动作；如需继续，请换个方案或先征询用户意见）");
  }
  return lines.join("\n");
};
