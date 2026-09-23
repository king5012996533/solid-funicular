/**
 * Pi 接入面（单一入口）—— 2026-09-23
 *
 * 为什么不让各处直接 import 包名：Pi 现在是 0.87.x（0.x 版本，接口会动），
 * 而且我们只用它很小一部分能力（Agent 循环 + 事件流 + 转录助手）。
 * 把「我们依赖了它什么」集中在这一个文件里，将来它改接口时只需要改这里，
 * 而不是在十几个业务文件里找。
 *
 * 依赖清单（每一项都是实测确认过语义的）：
 *   - Agent            服务端 Agent 循环本体（工具执行、转录维护、事件订阅）
 *   - createAssistantMessageEventStream  构造 StreamFn 要返回的事件流
 *   - collapseSystemMessages / getCurrentSystemPrompt / getCurrentTools
 *     从转录里回放「当前的系统提示与工具声明」——**必须用这三个**，
 *     不能用 context.tools（那是运行时集合，发不到上游，会表现为「模型看不到工具」）
 */
export { Agent } from "@earendil-works/pi-agent-core";
export type {
  AgentEvent,
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
  StreamFn,
} from "@earendil-works/pi-agent-core";
export {
  createAssistantMessageEventStream,
  collapseSystemMessages,
  getCurrentSystemPrompt,
  getCurrentTools,
  Type,
} from "@earendil-works/pi-ai";
export type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
