/**
 * AgentRuntime — 运行时装配与主循环
 * ---------------------------------------------------------------------------
 * 还原自 zcode.cjs @~843577：yd = class AgentRuntime
 *
 * 这是整个 Harness 的"大脑"。一个会话对应一个 AgentRuntime 实例，
 * 它持有所有组件的引用，并实现 executeTurn()（@原始 Ckt @771670）主循环。
 */
import { ContextBuilder } from "../prompts/context-builder";
import { PermissionService } from "../permissions/permission-service";
import { SessionMode } from "../permissions/permission-service";
import { BUILTIN_TOOLS } from "../tools/registry";

/** 各类 Port（端口适配器）——Harness 通过端口与外部能力交互 */
export interface RuntimePorts {
  fileSystemPort?: unknown;        // 文件系统（Read/Write/Edit/Glob/Grep）
  executionPort?: unknown;         // 进程执行（Bash）
  skillPort?: unknown;             // 技能（Skill）
  mcpPort?: unknown;               // MCP 外部服务器
  subagentPort?: unknown;          // 子 Agent（Agent）
  imageProcessorPort?: unknown;    // 图片处理
  modelAdapter?: unknown;          // 模型适配器（对话）
  modelConnectionPort?: unknown;   // 模型连接
  httpClientPort?: unknown;        // HTTP（WebFetch/WebSearch）
  artifactStore?: unknown;         // 产物存储
  eventStore?: unknown;            // 事件存储
  sessionStore?: unknown;          // 会话持久化
  contextSourcePort?: unknown;     // 上下文来源
  workflowPort?: unknown;          // 工作流
  sessionMailboxPort?: unknown;    // 会话邮箱（steer）
  providerRuntimeHeadersPort?: unknown;
  eventSink?: unknown;
  traceContext?: unknown;
  logger?: unknown;
  toolRegistry?: unknown;
  toolExecutor?: unknown;
  toolScheduler?: unknown;
  permissionService?: PermissionService;
  permissionBroker?: unknown;
  hookRunner?: unknown;
  now?: () => Date;
  appVersion?: string;
}

export interface RuntimeConfig {
  modelRef?: unknown;
  workingDirectory?: string;
  mode?: SessionMode;
  toolConcurrency?: { maxConcurrency: number };
  permissionTimeoutMs?: number;
  toolAllowlist?: string[];
  toolset?: "default" | "explore";
  hooks?: { enabled: boolean };
  customSystemPrompt?: string;
}

export interface TurnOptions {
  abortSignal?: AbortSignal;
  inputId?: string;
  queryId?: string;
  inputSource?: string;
  inputVisibility?: "visible" | "model-only";
  targetId?: string;
  traceContext?: unknown;
}

export interface TurnResult {
  response: string;
  turnId: string;
  traceId: string;
  usage: unknown;
  events: unknown[];
  projection: unknown;
}

export class AgentRuntime {
  sessionId: string;
  turnNumber = 0;
  config: RuntimeConfig;
  appVersion: string;

  // 核心服务
  permissionService: PermissionService;
  permissionBroker: unknown;
  toolScheduler: unknown;
  eventReducer: unknown;
  eventStore?: unknown;
  sessionStore?: unknown;

  // 追踪与日志
  rootTraceContext: unknown;
  logger?: unknown;
  eventSinks = new Set<unknown>();
  now: () => Date;

  // 工具与执行
  registry: unknown;           // 工具注册表（KB()）
  executor: unknown;           // 工具执行器（Z$()）
  hookRunner?: unknown;
  modelAdapter?: unknown;
  modelConnectionPort?: unknown;

  // 上下文
  messageHistory: unknown;     // 消息历史（I_）
  contextBuilder: ContextBuilder | null = null;
  contextInitialized = false;
  memoryContext?: unknown;

  // Ports
  fileSystemPort?: unknown;
  executionPort?: unknown;
  skillPort?: unknown;
  mcpPort?: unknown;
  subagentPort?: unknown;
  artifactStore?: unknown;
  imageProcessorPort?: unknown;

  // 状态
  skillLoadOutcome?: unknown;
  workingDirectory: string;
  prePlanMode?: SessionMode;
  activeTurn?: unknown;
  sessionPersisted = false;
  sessionStartHookRan = false;

  constructor(sessionId: string, config: RuntimeConfig, ports: RuntimePorts) {
    this.sessionId = sessionId;
    this.config = config;
    this.appVersion = ports.appVersion ?? "0.0.0";
    this.permissionService = ports.permissionService ?? new PermissionService();
    this.permissionBroker = ports.permissionBroker ?? createDefaultPermissionBroker();
    this.toolScheduler = ports.toolScheduler ?? createToolScheduler({ maxConcurrency: config.toolConcurrency?.maxConcurrency });
    this.eventStore = ports.eventStore;
    this.sessionStore = ports.sessionStore;
    this.rootTraceContext = ports.traceContext ?? createTraceContext({ sessionId });
    this.logger = ports.logger;
    this.now = ports.now ?? (() => new Date);
    this.modelAdapter = ports.modelAdapter;
    this.messageHistory = createMessageHistory();
    this.workingDirectory = config.workingDirectory ?? ".";
    this.registry = ports.toolRegistry ?? createBuiltinToolRegistry();
    this.executor = ports.toolExecutor ?? createToolExecutor({
      registry: this.registry,
      permissionService: this.permissionService,
      permissionBroker: this.permissionBroker,
      fileSystemPort: ports.fileSystemPort,
      executionPort: ports.executionPort,
      skillPort: ports.skillPort,
      subagentPort: ports.subagentPort ?? this.createDefaultSubagentPort(ports),
      getMode: () => this.config.mode ?? "build",
      sessionId: this.sessionId,
      // ...（其余字段见原始 Z$() 工厂）
    });
    this.fileSystemPort = ports.fileSystemPort;
    this.executionPort = ports.executionPort;
    this.skillPort = ports.skillPort;
    this.mcpPort = ports.mcpPort;
    this.subagentPort = ports.subagentPort ?? this.createDefaultSubagentPort(ports);
    this.artifactStore = ports.artifactStore;
    this.imageProcessorPort = ports.imageProcessorPort;

    // 根据配置筛选可见工具
    configureRegistry(this.registry, {
      includeSkill: !!this.skillPort,
      includeAgent: !!this.subagentPort,
      includeSendMessage: ports.sessionMailboxPort !== undefined,
      includeWorkflow: !!ports.workflowPort,
      includeExploreOnlyTools: config.toolset === "explore",
      allowedTools: resolveBuiltInToolAllowlist(config.toolAllowlist),
    });

    // 钩子装配（hooks）
    this.hookRunner = ports.hookRunner ?? (
      config.hooks?.enabled && ports.executionPort
        ? createUserHookRunner({ config: config.hooks, executionPort: ports.executionPort })
        : undefined
    );
  }

  // ──────────────────────────── 主循环 ────────────────────────────

  /**
   * executeTurn — 单轮 Agent 循环。
   * @原始 Ckt @771670
   *
   * 流程：
   *   1. 生成 turnId / traceContext，创建 abort 信号
   *   2. ensureContextInitialized（首次构建 ContextBuilder）
   *   3. runSessionStartHooks("startup")  → 注入额外上下文
   *   4. 检测 /compact、/rewind 等斜杠命令 → 转发到专用处理
   *   5. beginActiveTurn，ensureSessionPersisted，读取 session 目标
   *   6. drainPending*Notifications（子 agent / 后台任务通知）
   *   7. appendEvent(TurnStarted)
   *   8. runUserPromptSubmitHooks → 可能 preventContinuation
   *   9. injectRelevantMemoryFromTurn / injectDateChangeReminder
   *  10. 解析附件（图片/文件）→ addUser(message)
   *  11. 【模型步进循环】runModelStepLoop（@原始 hkt）：
   *        - 向模型发送 messages
   *        - 模型返回文本 + tool_call
   *        - 对每个 tool_call：permissionService.checkPermission → ask/allow/deny
   *          - allow → executor 执行 → 结果追加到 messages
   *          - ask   → 通过 permissionBroker 请求用户 → 据结果 allow/deny
   *          - deny  → 返回拒绝原因给模型
   *        - 重复直到模型不再产生 tool_call（stop）
   *  12. appendEvent(TurnComplete)，持久化，rebuildProjection
   *  13. turnNumber++，accountTargetTurnCompletion
   */
  async executeTurn(prompt: string, _extra: unknown, options?: TurnOptions): Promise<TurnResult> {
    const turnId = generateTurnId();
    const queryId = options?.queryId ?? options?.inputId ?? generateId();
    const traceContext = enrichTraceContext(
      options?.traceContext ?? this.rootTraceContext,
      { queryId, sessionId: this.sessionId, turnId, turnNumber: this.turnNumber }
    );
    const traceId = getTraceId(traceContext);
    const startedAtMs = Date.now();
    const events: unknown[] = [];
    const { signal } = createLinkedAbort(options?.abortSignal);
    let userMessageId: string | undefined;

    return runInTrace(traceContext, async () => {
      throwIfAborted(signal);
      await this.ensureContextInitialized(traceContext);
      throwIfAborted(signal);

      // 1. SessionStart 钩子
      const startHooks = await this.runSessionStartHooks("startup", traceContext, signal);
      this.injectHookAdditionalContext(startHooks.additionalContexts);

      // 2. 斜杠命令分流
      const compactCmd = detectCompactCommand(prompt);
      if (compactCmd !== null) return this.executeManualCompact(prompt, compactCmd, turnId, traceContext, signal, options?.inputId);
      const rewindCmd = detectRewindCommand(prompt);
      if (rewindCmd !== null) return this.executeRewindCommand(prompt, rewindCmd, turnId, traceContext, signal, options?.inputId);

      // 3. 开启活动 turn
      this.beginActiveTurn(turnId, traceContext);
      await this.ensureSessionPersisted(prompt, traceContext);

      // 4. 排空待处理通知
      await this.drainPendingSubagentNotifications(traceContext);
      await this.drainPendingBackgroundTaskNotifications(traceContext);

      // 5. TurnStarted 事件
      await this.appendEvent(this.createEvent("TurnStarted", {
        turnNumber: this.turnNumber,
        input: prompt,
        inputId: options?.inputId,
        queryId,
        inputSource: options?.inputSource,
        inputVisibility: options?.inputVisibility,
        targetId: options?.targetId,
      }, traceContext), traceContext);

      try {
        // 6. UserPromptSubmit 钩子（可阻止继续）
        const submitHooks = await this.runUserPromptSubmitHooks(prompt, traceContext, signal);
        if (submitHooks.preventContinuation) {
          return this.finishBlockedTurn(prompt, turnId, traceId, events, submitHooks.stopReason ?? "Prompt blocked by UserPromptSubmit hook.");
        }
        this.injectHookAdditionalContext(submitHooks.additionalContexts);

        // 7. 记忆与日期提醒注入
        this.injectDateChangeReminder();
        await this.injectRelevantMemoryFromTurn(prompt, traceContext);

        // 8. 附件解析 + 添加用户消息
        const attachments = await resolveAttachments(options, { fileSystemPort: this.fileSystemPort, imageProcessorPort: this.imageProcessorPort });
        const enriched = enrichUserMessage(prompt, attachments);
        userMessageId = generateId();
        this.addUserMessage(enriched, options?.inputSource);

        // 9. 【核心】模型步进循环（工具调用 ↔ 模型）
        const turnState = await this.runModelStepLoop({
          activeTurn: this.activeTurn,
          events,
          input: prompt,
          currentUserMessageId: userMessageId,
          turnAbortSignal: signal,
          turnId,
          traceId,
          turnTraceContext: traceContext,
        });

        // 10. TurnComplete
        await this.appendEvent(this.createEvent("TurnComplete", {
          response: turnState.modelResponse,
          tokenCount: turnState.tokenCount,
          toolCallCount: turnState.toolCallCount,
          resultType: "success",
        }, traceContext), traceContext);
        await this.persistTurn({ completedAt: Date.now(), events, startedAt: startedAtMs, status: "completed", turnId, userMessageId });

        // 11. 显式记忆记录
        await this.recordExplicitMemoryFromTurn(prompt, traceContext);

        this.turnNumber++;
        const projection = await this.rebuildProjection();
        return {
          response: turnState.modelResponse,
          turnId,
          traceId,
          usage: aggregateUsage(events),
          events,
          projection,
        };
      } catch (err) {
        const coreError = wrapError(err, signal, "Turn execution failed");
        await this.failTurn({ coreError, events, turnId, userMessageId, traceContext });
        throw coreError;
      }
    }).finally(() => {
      this.finishActiveTurn();
    });
  }

  // 以下方法体在原始代码中存在，此处给出签名与职责说明
  private async ensureContextInitialized(_tc: unknown): Promise<void> { /* 首次构建 ContextBuilder */ }
  private async runSessionStartHooks(_phase: string, _tc: unknown, _sig: AbortSignal): Promise<{ additionalContexts: unknown[] }> { return { additionalContexts: [] }; }
  private injectHookAdditionalContext(_ctx: unknown): void {}
  private async runUserPromptSubmitHooks(_prompt: string, _tc: unknown, _sig: AbortSignal): Promise<{ preventContinuation?: boolean; stopReason?: string; additionalContexts: unknown[] }> { return { additionalContexts: [] }; }
  private injectDateChangeReminder(): void {}
  private async injectRelevantMemoryFromTurn(_prompt: string, _tc: unknown): Promise<void> {}
  private beginActiveTurn(_turnId: string, _tc: unknown): void {}
  private async ensureSessionPersisted(_prompt: string, _tc: unknown): Promise<void> {}
  private async drainPendingSubagentNotifications(_tc: unknown): Promise<void> {}
  private async drainPendingBackgroundTaskNotifications(_tc: unknown): Promise<void> {}
  private async appendEvent(_event: unknown, _tc: unknown): Promise<void> {}
  private createEvent(_type: string, _payload: unknown, _tc: unknown): unknown { return {}; }
  private addUserMessage(_content: unknown, _source?: string): void {}
  private async runModelStepLoop(_state: unknown): Promise<{ modelResponse: string; tokenCount: number; toolCallCount: number }> { return { modelResponse: "", tokenCount: 0, toolCallCount: 0 }; }
  private async persistTurn(_args: unknown): Promise<void> {}
  private async recordExplicitMemoryFromTurn(_prompt: string, _tc: unknown): Promise<void> {}
  private async rebuildProjection(): Promise<unknown> { return null; }
  private async failTurn(_args: unknown): Promise<void> {}
  private async finishBlockedTurn(..._args: unknown[]): Promise<TurnResult> { return { response: "", turnId: "", traceId: "", usage: {}, events: [], projection: null }; }
  private async executeManualCompact(..._args: unknown[]): Promise<TurnResult> { return { response: "", turnId: "", traceId: "", usage: {}, events: [], projection: null }; }
  private async executeRewindCommand(..._args: unknown[]): Promise<TurnResult> { return { response: "", turnId: "", traceId: "", usage: {}, events: [], projection: null }; }
  private finishActiveTurn(): void {}
  private createDefaultSubagentPort(_ports: RuntimePorts): unknown { return {}; }
}

// ──────────────────────────── 占位工厂（原始实现见 zcode.cjs） ────────────────────────────
function createDefaultPermissionBroker(): unknown { return {}; }
function createToolScheduler(_opts: { maxConcurrency?: number }): unknown { return {}; }
function createTraceContext(_opts: { sessionId: string }): unknown { return {}; }
function createMessageHistory(): unknown { return {}; }
function createBuiltinToolRegistry(): unknown { return BUILTIN_TOOLS; }
function createToolExecutor(_opts: unknown): unknown { return {}; }
function configureRegistry(_reg: unknown, _opts: unknown): void {}
function createUserHookRunner(_opts: unknown): unknown { return {}; }
function resolveBuiltInToolAllowlist(list?: string[]): string[] | undefined { return list?.map((t) => (t === "web_search" ? "WebSearch" : t)); }

function generateTurnId(): string { return Math.random().toString(36).slice(2); }
function generateId(): string { return Math.random().toString(36).slice(2); }
function getTraceId(_tc: unknown): string { return ""; }
function enrichTraceContext(_tc: unknown, _attrs: unknown): unknown { return _tc; }
function runInTrace(_tc: unknown, fn: () => Promise<unknown>): { finally(cb: () => void): Promise<unknown> } {
  const p = fn();
  return { finally: (cb: () => void) => p.finally(cb) as Promise<unknown> } as unknown as { finally(cb: () => void): Promise<unknown> };
}
function createLinkedAbort(signal?: AbortSignal): { signal: AbortSignal } {
  return { signal: signal ?? new AbortController().signal };
}
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw new Error("aborted"); }
function detectCompactCommand(_prompt: string): unknown { return null; }
function detectRewindCommand(_prompt: string): unknown { return null; }
async function resolveAttachments(_opts: unknown, _ports: unknown): Promise<unknown[]> { return []; }
function enrichUserMessage(prompt: string, _att: unknown[]): string { return prompt; }
function aggregateUsage(_events: unknown[]): unknown { return {}; }
function wrapError(err: unknown, _sig: AbortSignal, fallback: string): Error { return err instanceof Error ? err : new Error(fallback); }
