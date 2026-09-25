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

/**
 * 「成片生产」的完整链路手册（第 1~10 步 + 9.5 步）。
 *
 * 这段原文原先整段睡在服务端 system 提示里 —— 而 system 每轮都要发，**包括「只回复一个数字」
 * 这种用不上流程的对话**：一次实测里那种对话耗时 15~31 秒，几千字的手册是被怀疑的主因之一。
 * 现在改成**按需加载**：system 只留分类判断、硬规则与一句指针，判定为「成片生产」时再让模型调
 * `load_playbook` 取这份原文。**内容一字未改**（成片生产的质量全靠它），只是搬了家。
 *
 * 放在共享文件（而不是服务端）：工具定义与它的正文是同一件事，且单测要能直接断言
 * 「手册没被简写」——共享文件是唯一真源，改一处两侧同时生效。
 */
export const CANVAS_AGENT_STORYBOARD_PRODUCTION_PLAYBOOK = `# 完整链路（**仅当第 0 步判定为「成片生产」时**，除非用户另有要求，按这个顺序推进）

## 第 1 步 · 需要时读画布（**不是开场动作；先单节点后概览**）
只有要动已有节点、要避免覆盖已有内容、要连谁挂谁时才读；闲聊/问答/纯新建设计不必读。
需要细节先读单节点 get_canvas_node(id)；不够定位再用 get_canvas_overview 看清已有什么（素材/母版/分镜表），别重复造、别覆盖。
**不要为了拿 id 或看状态去调 get_canvas_state**（它返回整张画布，又贵又慢）；确需整张画布时才用它。
节点 id 只能来自工具返回，**不要编造**。

## 第 2 步 · 拆剧本 → 分镜表
把用户的剧本/创意拆成**分镜表**，落到一个 text 节点上（add_node type=text），内容用 Markdown 表格，
每条包含：镜号、画面内容、景别与运镜、台词/旁白、时长（秒）。
镜数按内容定，一般 6~12 条；用户指定了就按他说的。
**这一步不花钱**，做完先把分镜表讲给用户听（一两句概括 + 镜数）。

## 第 3 步 · 定母版（连续性全靠这一步）
为主要角色、关键场景各建一个 image 节点当**母版**（一般 2~4 个）。提示词里写死外观特征
（年龄/发型/服装/材质/配色…），这是后面所有分镜必须继承的东西。
母版提示词要写得**具体到可以复现**，不要写「一个女孩」这种。

## 第 4 步 · 花钱前先要确认（半自动闸门，必须遵守）
在触发任何生成之前，调 request_confirmation，把三件事说清：
  1. 将要建多少节点、出多少张图/视频；
  2. 逐条列出要生成的提示词（或至少概括到用户能核对）；
  3. **预计消耗多少积分**（按「每张图/每条视频」的量级估，给可靠上界）。
用户同意之后才继续；拒绝就换方案或停下来问他。服务端也会硬拦没有确认的付费动作。

## 第 5 步 · 批量提交母版生成（**提交即回执，不要等出图**）
用 run_nodes 一次把母版节点**提交**起来。回执是「已提交 · 生成中」，**这一轮不会等出图**（出图要几分钟）。
拿到回执就继续往下做，**不要为了等结果反复读画布或轮询**。确实需要某张母版图时，读一次 get_canvas_node(id)：
generationStatus 还是 generating 就先做不依赖它的步骤（比如铺分镜表），别原地打转。

## 第 6 步 · 铺分镜节点
用 add_nodes 一次建好分镜节点（一次不超过 12 个），每个 image 节点的提示词 =
**母版的外观特征 + 这一镜的画面/景别/运镜**。再用 connect_nodes 的 links 参数，
一次把母版连到对应的分镜节点（表达继承关系）。

## 第 7 步 · 把母版图挂给分镜（continuity 的关键动作）
母版出图之后，用 attach_reference_images 把**母版节点实际生成出来的那张图**（get_canvas_node 里的
data.url）挂到它的分镜节点上。挂上之后执行分镜节点会走图生图，角色才真的长得一样。
只靠文字描述是做不到的 —— 这一步不做，出来的每一张都是不同的脸。
若读到的 generationStatus 还是 generating（图还没出来），就先把分镜铺完、把不依赖它的活做完，
再回来读一次挂上；**不要卡在原地反复读**。挂图失败要如实说清（例如「母版图还没出来」）。

## 第 8 步 · 出分镜图
再要一次确认（如果这一批与第 4 步说的不一致，尤其规模变大了），然后用 run_nodes 批量**提交**分镜节点
（同样是提交即回执，不等出图）。

## 第 9 步 · 分镜视频（用户要动起来的镜头才做）
需要运动的镜头建 video 节点（提示词写清运镜与动作），同样先确认再批量执行。

## 第 9.5 步 · 批量生成前先预校验（硬要求）
调 preflight_check，把这一批节点过一遍：提示词、模型/画幅取值、继承链、参考图是否还能访问。
**报告不过就不要开始生成** —— 带着空提示词或失效参考图跑，等于把用户的钱花在废图上。
报告里的每条问题都带「哪个节点 + 怎么改」，照着修完再重跑一次 preflight_check。
（服务端与客户端都会在 run_nodes 时复核报告是否仍然有效：过期、覆盖面不符、参考图丢失都会被拦下，
所以别想着跳过这一步 —— 跳过了也跑不动。）

## 第 10 步 · 汇报
每完成一段用一两句中文说清「做了什么、下一步是什么、要他确认什么」。
全部做完时说清：分镜表在哪、母版是哪几个、分镜图多少张、有没有失败项。`;

/** 手册主题名。目前只有「成片生产」，留出加更多主题的位置 */
export type CanvasAgentPlaybookName = "storyboard-production";

/**
 * 按主题取手册正文。名称为空时默认成片生产；未知主题返回 null（调用方据此如实说明）。
 */
export const resolveCanvasAgentPlaybook = (name?: string): string | null => {
  const key = String(name || "").trim() || "storyboard-production";
  return key === "storyboard-production"
    ? CANVAS_AGENT_STORYBOARD_PRODUCTION_PLAYBOOK
    : null;
};

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
    name: "ask_user",
    label: "向用户提问",
    description:
      "【关键信息不足时用】当「要做什么 / 产出成片还是单张 / 大概多大规模」这类**猜不出来**的信息缺失时，用这个工具问用户。它会在**同一轮里等用户回答**，拿到答案你继续往下做，不会把一次委托拆成好几轮 —— 所以在回复里用纯文字提问是错的，要用这个工具。一次把想问的问全（最多 3 个），每个问题给 2~4 个可点选项，用户也可以自己输入。有常识默认值的偏好（风格 / 画幅 / 画质 / 镜头数 / 时长）**不要问**，按默认值做并在最后汇报里说明。",
    parameters: {
      type: "object",
      properties: {
        context: {
          type: "string",
          description: "为什么需要问（一句话，帮用户快速判断该答什么）",
        },
        questions: {
          type: "array",
          description: "要问的问题，最多 3 个",
          items: {
            type: "object",
            properties: {
              question: { type: "string", description: "问题本身，一句话" },
              options: {
                type: "array",
                items: { type: "string" },
                description: "可点选的答案（2~4 个），用户也可以自己输入",
              },
            },
            required: ["question"],
          },
        },
      },
      required: ["questions"],
    },
    requiresClient: true,
  },
  {
    name: "get_canvas_state",
    label: "读取整张画布",
    description:
      "读取整张画布的完整现状：全部节点（含提示词/模型/状态/是否已有出图）、全部连线、当前选中的节点。**上下文开销大**，**按需读取** —— 不是每轮开场动作，只在确实需要整张画布时才用 —— 定位节点用 get_canvas_overview，看某个节点的细节用 get_canvas_node(id)。判断某个节点还要不要执行时，看它的 hasImage 与 status：hasImage 为 true 或 status 为「生成中」都说明它已经有结果或正在跑，不要对它再提交生成。",
    parameters: { type: "object", properties: {}, required: [] },
    requiresClient: true,
  },
  {
    /**
     * 便宜的整画布读（2026-09-26，第一刀：手感）。
     *
     * 原来的默认读工具是 get_canvas_state —— 一次返回全部节点 + 全部连线 + 文本片段。
     * 模型为了「拿几个 id」要反复拉回整张画布，上下文被同一份内容反复塞，还把每轮工具预算烧光。
     * 这里只给**定位与决策需要的字段**：id / kind / 标题 / 生成状态 / 有没有产物 + 各类计数。
     * 刻意不含 prompt、不含坐标、不含连线明细 —— 那些要细节时用 get_canvas_node(id) 单独取。
     */
    name: "get_canvas_overview",
    label: "读取画布概览",
    description:
      "读取画布概览：节点总数、连线数、按类型/生成状态的计数，以及每个节点的 id / 类型 / 标题 / 生成状态 / 是否已有产物。**不含提示词、坐标与连线明细**。**按需读取** —— 只在需要定位节点或确认画布现状时才调，别把它当成每轮开场动作；闲聊/问答不必读画布。需要单个节点的细节时先读它一个（get_canvas_node），不够定位再用这个。",
    parameters: { type: "object", properties: {}, required: [] },
    requiresClient: true,
  },
  {
    /**
     * 单节点全量读（2026-09-26，第一刀：手感）。
     *
     * 与概览配对：概览负责定位，单节点负责细节。此前任何细节（提示词、错误、出图地址、参考图）
     * 都只能靠整画布读，于是「看一眼某个节点」的代价是拉回整张画布。
     */
    name: "get_canvas_node",
    label: "读取单个节点",
    description:
      "按 id 读取一个节点的全部细节：类型、标题、坐标、是否选中、提示词/内容/模型/尺寸/画质/参考图/出图地址/任务 id/生成状态/错误，以及精简的入线与出线摘要（来源/目标节点的 id 与标题）。**按需读取** —— 只有在需要知道这个节点的现状（要改它、要连它、要挂图、要核结果）时才读它一个，不要为此读整张画布。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "节点 id（来自 get_canvas_overview）" },
      },
      required: ["id"],
    },
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
        id: { type: "string", description: "节点 id（来自 get_canvas_overview）" },
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
     * 批量生图前的预校验入口（M3 风险③ 第一步）。
     *
     * **职责边界（工具说明里必须写明）**：真正执行的是调用方/客户端 ——
     * 读节点、HEAD 探参考图、跑校验器都在那一层完成；Agent 拿到的只是一份报告。
     * 校验器本身是纯函数，不会连库、不会发请求。写清楚这条，是为了避免以后有人
     * 误以为「在提示词里让它校验」就等于服务端会去探图与查余额。
     */
    name: "preflight_check",
    label: "批量预校验",
    description:
      "批量执行（run_nodes）之前检查这批节点「能不能跑」：提示词是否为空/超长/含未替换占位符、模型与画幅取值是否合法、分镜是否真的继承了母版、参考图是否还能访问、余额是否够这一批。执行在客户端完成（读画布、探图、跑校验器），你拿到的是报告。报告不过就别开始生成 —— 带着问题跑等于白花钱。",
    parameters: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "要校验的节点 id；不填则校验画布上全部可执行节点",
        },
      },
      required: [],
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
    label: "批量提交生成",
    description:
      "一次**提交**多个节点的生成任务（每个节点各自起一个生成任务，跟单独 run_node 等价）。批量出分镜图/视频时用它。**提交即回执，不等出图** —— 回执里每个节点带提交状态（generating 表示已提交、正在生成）。会消耗积分，调用前必须先取得用户确认，并在确认里写清这一批的规模与预计消耗。同一个节点在同一轮里只会真正提交一次：重复提交会被忽略并如实说明原因。**不要用读取工具反复轮询等结果** —— 提交完就继续做下一步；确实要看某个节点出没出图时，用 get_canvas_node(id) 读一次它的 generationStatus，别原地打转。",
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
      "删除一个节点（连带它的连线）。删之前按需确认 id（可用 get_canvas_node(id) 或概览）。",
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
      "把参考图挂到某个图片节点上：挂上之后执行该节点会用这些图做参考（图生图）。默认用用户本轮上传的参考图；也可以显式给 images 引用别的素材 —— images 里每一项既可以是图片地址，也可以是**已有出图的节点 id**（例如想把母版节点 node_1 的成图挂到分镜节点上，就写 node_1，不要写提示词或别的东西）。节点上已有参考图时会被替换。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "图片节点 id" },
        images: {
          type: "array",
          items: { type: "string" },
          description: "要挂的参考图：图片地址，或已有出图的节点 id（可选；不填则用用户本轮上传的参考图）",
        },
      },
      required: ["id"],
    },
    requiresClient: true,
  },
  {
    name: "run_node",
    label: "提交节点生成",
    description:
      "**提交**某个节点的生成任务（图片节点会真的去生成；视频节点当前服务端已接通但仍在验证中）。**提交即回执，不等出图**：回执里带这个节点的提交状态，出图结果随后由节点自己落到画布上。提交失败会如实回执（不会把「没提交成功」说成成功）。同一个节点在同一轮里只会真正提交一次：重复提交会被忽略并如实说明原因（不会重复扣费）。**不要用读取工具反复轮询等结果**，要看结果就读单节点 get_canvas_node(id) 的 generationStatus 与出图地址。",
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
  {
    /**
     * 按需取手册（2026-09-26，提示词瘦身）。
     *
     * 这是**纯服务端工具**（requiresClient: false）：正文就在服务端内存里，不必走浏览器桥 ——
     * 走桥要多一次往返，而这段文本与画布状态无关。system 提示只留一句指针，模型判定为「成片生产」
     * 时再调它一次取全文；小活不调，system 因此每轮都短一截。
     */
    name: "load_playbook",
    label: "加载工作手册",
    description:
      "取「成片生产」的完整链路手册正文（第 1~10 步，含 9.5 步预校验）。**只在第 0 步判定为「成片生产」、准备动手前调一次**；手册内容不会变，**已经调过就不要重复调**。小活（单张图、改图、只要一份分镜表/文案、整理画布、换模型重跑）不要调。",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          enum: ["storyboard-production"],
          description:
            "手册主题，目前只有 storyboard-production（短片 / 漫剧 / 广告片的完整链路）",
        },
      },
      required: [],
    },
    requiresClient: false,
  },
];

export const findCanvasAgentTool = (name: string) =>
  CANVAS_AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === name);

/**
 * `preflight_check` 的配额检查结论（前后端共用的数据形状）。
 *
 * 为什么单独一个类型：真正的余额/预估是在**浏览器**里取的（只有它拿得到画布节点的模型键），
 * 而「配额到底查了没有」这件事必须出现在**服务端日志**里 —— 否则「闸门被静默跳过」在服务端
 * 完全看不出来（表现就是「明明余额不足却没拦住」）。所以客户端把结论挂在工具结果的 details 上，
 * 服务端按这个类型读取并埋点。放到共享文件，是为了让两侧改字段时同步编译失败、不漂移。
 */
export interface CanvasPreflightQuotaCheck {
  /** checked = 两个接口都拿到、配额参与了校验；skipped = 拿不到，配额校验静默跳过 */
  status: "checked" | "skipped";
  /** skipped 时的原因（balance_api_error / estimate_api_error / no_estimatable_nodes） */
  reason?: string;
  /** 当前可用积分（checked 时有） */
  available?: number;
  /** 整批预估消耗（checked 时有） */
  totalEstimated?: number;
  /** 参与预估/校验的可执行节点数 */
  nodeCount?: number;
}

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
