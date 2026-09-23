import { ref } from "vue";

/**
 * 画布节点的「执行器」注册表（2026-09-23）
 *
 * 为什么需要：节点的生成动作（buildRequest → 建任务 → 订阅事件 → 落库）实现在**节点组件内部**
 * （ImageNode 的 runGeneration 等），画布这一层没有可调用的入口。于是画布助手这类
 * 「替我跑一下这个节点」的能力就无处下手 —— 只能让用户自己点。
 *
 * 做法：节点挂载时把「用自身当前参数跑一次」的闭包注册进来，卸载时注销。
 *   - 不引入新的状态源：注册表本身不存业务数据，只是把组件内的能力暴露出来；
 *   - 失效安全：节点不在画面上（未挂载）时 hasNodeRunner 为 false，调用方给出明确提示，
 *     而不是静默什么都不发生。
 */
const runners = new Map<string, () => Promise<void> | void>();
/** 供 UI 判断「这个节点现在能不能被执行」，变化时响应式更新 */
export const runnerNodeIds = ref<string[]>([]);

export const registerNodeRunner = (
  nodeId: string,
  run: () => Promise<void> | void,
) => {
  if (!nodeId) return;
  runners.set(nodeId, run);
  runnerNodeIds.value = [...runners.keys()];
};

export const unregisterNodeRunner = (nodeId: string) => {
  if (!runners.delete(nodeId)) return;
  runnerNodeIds.value = [...runners.keys()];
};

export const hasNodeRunner = (nodeId: string) => runners.has(nodeId);

/**
 * 跑一次该节点。返回它自己的执行结果（成功/失败原因），不吞异常 ——
 * 调用方（例如画布助手）要把真实原因转述给用户，而不是假装成功。
 */
export const runNodeById = async (
  nodeId: string,
): Promise<{ ok: boolean; reason?: string }> => {
  const runner = runners.get(nodeId);
  if (!runner) return { ok: false, reason: "该节点未挂载或暂不支持直接执行" };
  try {
    await runner();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};
