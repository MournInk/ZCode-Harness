/**
 * 模型步进循环（Model Step Loop）
 * ---------------------------------------------------------------------------
 * 还原自 zcode.cjs：hkt.call(this, state) @~773000（在 executeTurn 内部调用）
 *
 * 这是 Agent "思考-行动-观察"循环的核心：反复向模型发送 messages，
 * 执行模型返回的工具调用，直到模型不再调用工具（产生最终回答）。
 *
 * 每一步：
 *   1. 用 ContextBuilder.build() 组装当前 messages（含 system + 历史 + 本轮 user）
 *   2. 调用 modelAdapter（流式）获取模型输出
 *   3. 解析输出中的 tool_call（并行/串行）
 *   4. 对每个 tool_call：
 *        a. permissionService.checkPermission(req, capability, projectRules)
 *        b. allow → executor.execute(tool, input, ctx)
 *        c. ask   → permissionBroker.requestPermission(req) → 用户授权/拒绝
 *        d. deny  → 构造拒绝结果（不执行）
 *      结果以 tool_result 形式追加到 messageHistory
 *   5. 若有 tool_call → 回到步骤 1（下一步）
 *      若无 → 循环结束，turnState.modelResponse = 最终文本
 *
 * 循环终止条件：
 *   - 模型不再产生 tool_call（自然停止）
 *   - abortSignal 被触发（用户中断）
 *   - 达到最大步数（modelStepCount 上限）
 *   - UserPromptSubmit/Stop 钩子阻止
 *   - 发生不可恢复错误
 */

export interface TurnState {
  activeTurn: unknown;
  anomalyWarningsInjected: number;
  currentUserMessageId: string;
  events: unknown[];
  input: string;
  modelResponse: string;
  modelStepCount: number;
  pendingBackgroundSubagents: unknown[];
  reactiveCompactRetryUsed: boolean;
  repeatedToolCallSignature?: string;
  repeatedToolCallStreakCount: number;
  stopHookContinuationCount: number;
  streamRecoveryRetryCount: number;
  tokenCount: number;
  toolCallCount: number;
  traceId: string;
  turnAbortSignal: AbortSignal;
  turnId: string;
  turnMachine: unknown;
  turnTraceContext: unknown;
  userMessageId: string;
}

/** @原始 hkt — 在 executeTurn 内运行的单轮步进循环 */
export async function runModelStepLoop(this: unknown, state: TurnState): Promise<TurnState> {
  // 伪代码骨架（原始为深度内联的 async 函数）：
  let stepCount = 0;
  const MAX_STEPS = 100; // 防失控

  while (stepCount < MAX_STEPS) {
    // 1. abort 检查
    if (state.turnAbortSignal.aborted) break;

    // 2. 自动 compact 检测（上下文将满 → 触发压缩）
    if (await maybeAutoCompact(state)) {
      state.reactiveCompactRetryUsed = true;
      continue;
    }

    // 3. 组装 messages（ContextBuilder.build().messages + messageHistory）
    const messages = await buildMessagesForModel(state);

    // 4. 调用模型（流式），收集文本 + tool_calls
    const modelOutput = await callModel(this, messages, state);

    // 5. 累计 token / 记录 assistant 消息
    state.tokenCount += modelOutput.usage?.inputTokens ?? 0;
    state.modelStepCount = ++stepCount;

    // 6. 提取 tool_calls
    const toolCalls = modelOutput.toolCalls ?? [];

    // 7. 无 tool_call → 循环结束
    if (toolCalls.length === 0) {
      state.modelResponse = modelOutput.text;
      break;
    }

    // 8. 重复工具调用检测（防死循环）
    if (detectRepeatedToolCall(state, toolCalls)) {
      state.anomalyWarningsInjected++;
    }

    // 9. 调度执行 tool_calls（并发受 toolScheduler.maxConcurrency 限制）
    const results = await executeToolCalls(this, toolCalls, state);

    // 10. 将 tool_result 追加到 messageHistory
    appendToolResultsToHistory(state, results);
    state.toolCallCount += toolCalls.length;

    // 11. Stop 钩子：可强制继续或停止
    const stopDecision = await runStopHook(state);
    if (stopDecision.preventContinuation) break;
    if (stopDecision.forceContinue) {
      state.stopHookContinuationCount++;
      continue;
    }
  }

  return state;
}

// ──────────────────────────── 步骤实现（签名） ────────────────────────────

async function maybeAutoCompact(_state: TurnState): Promise<boolean> { return false; }
async function buildMessagesForModel(_state: TurnState): Promise<unknown[]> { return []; }
async function callModel(_self: unknown, _messages: unknown[], _state: TurnState): Promise<{ text: string; toolCalls?: unknown[]; usage?: { inputTokens: number } }> { return { text: "" }; }
function detectRepeatedToolCall(_state: TurnState, _calls: unknown[]): boolean { return false; }
async function executeToolCalls(_self: unknown, _calls: unknown[], _state: TurnState): Promise<unknown[]> { return []; }
function appendToolResultsToHistory(_state: TurnState, _results: unknown[]): void {}
async function runStopHook(_state: TurnState): Promise<{ preventContinuation?: boolean; forceContinue?: boolean }> { return {}; }

/**
 * 单个工具调用的执行 + 权限决策流程（@原始 Z$/executor 内部）
 *
 *   toolCall = { toolCallId, toolName, input }
 *   capability = registry.get(toolName)
 *   req = { toolName, input, mode: runtime.config.mode }
 *   decision = permissionService.checkPermission(req, capability.permission, projectRules)
 *
 *   switch (decision.decision) {
 *     case "allow": result = executor.run(capability, input, ctx); break;
 *     case "deny":  result = { error: decision.reason, denied: true }; break;
 *     case "ask":
 *       userDecision = await permissionBroker.requestPermission(req, capability, decision)
 *       if (userDecision === "allow") result = executor.run(...);
 *       else result = { error: "User declined", denied: true };
 *   }
 */
export interface ToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface ToolCallResult {
  toolCallId: string;
  output?: unknown;
  error?: string;
  denied?: boolean;
  decision: "allow" | "deny" | "ask";
  ruleId?: string;
}
