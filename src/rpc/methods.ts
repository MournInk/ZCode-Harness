/**
 * IPC/RPC 方法注册表
 * ---------------------------------------------------------------------------
 * 还原自 zcode.cjs @~6893000：Xt 对象 + nNi 映射表
 *
 * 这是 Harness 对外暴露（给 Electron 渲染进程 / CLI 前端）的完整 API。
 * 每个方法形如 "namespace/action"，对应 { params: ZodSchema, result: ZodSchema }。
 */
export const RPC_METHODS = {
  // ── 会话生命周期 ──
  sessionCreate: "session/create",
  sessionResume: "session/resume",
  sessionList: "session/list",
  sessionRead: "session/read",
  sessionMessages: "session/messages",
  sessionEvents: "session/events",
  sessionSubscribe: "session/subscribe",
  sessionSend: "session/send",
  sessionSteer: "session/steer",
  sessionStop: "session/stop",
  sessionCancelBackgroundTask: "session/cancelBackgroundTask",
  sessionFork: "session/fork",
  sessionCompact: "session/compact",
  sessionGoal: "session/goal",
  sessionRewind: "session/rewind",
  sessionClose: "session/close",
  sessionSetModel: "session/setModel",
  sessionSetThoughtLevel: "session/setThoughtLevel",
  sessionUpdateRuntimeModelConfig: "session/updateRuntimeModelConfig",
  sessionSetMode: "session/setMode",

  // ── 工作区与模型提供商 ──
  workspaceReadState: "workspace/readState",
  workspaceUpdateProviderRegistry: "workspace/updateProviderRegistry",
  workspaceUpsertModelProvider: "workspace/upsertModelProvider",
  workspaceRemoveModelProvider: "workspace/removeModelProvider",
  workspaceSetDefaultModel: "workspace/setDefaultModel",
  workspaceSetDefaultThoughtLevel: "workspace/setDefaultThoughtLevel",
  workspaceSetDefaultMode: "workspace/setDefaultMode",

  // ── 插件 ──
  pluginsList: "plugins/list",
  pluginsSetEnabled: "plugins/setEnabled",

  // ── 提示增强 ──
  promptEnhance: "prompt/enhance",
  promptEnhanceStart: "prompt/enhance/start",
  promptEnhanceCancel: "prompt/enhance/cancel",
  promptEnhanceResult: "prompt/enhance/result",

  // ── 用量统计 ──
  usageStats: "usage/stats",
  sessionUsage: "session/usage",

  // ── 交互（权限请求 / 用户输入） ──
  interactionRequestPermission: "interaction/requestPermission",
  interactionRequestUserInput: "interaction/requestUserInput",
  interactionRequestProviderRuntimeHeaders: "interaction/requestProviderRuntimeHeaders",
} as const;

export type RpcMethod = (typeof RPC_METHODS)[keyof typeof RPC_METHODS];

/**
 * 模型提供商枚举（@原始 RHn）
 * Harness 支持 5 种 provider 后端。
 */
export const MODEL_PROVIDERS = ["claude", "opencode", "gemini", "codex", "glm"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/**
 * 会话持久化状态（@原始 lQn 消息结构节选）
 * 每条消息：{ role, content, timestamp, model?, tools[], thought?, parts[], turnIndex?, ... }
 * 每个工具调用快照：{ toolName, title?, status: "completed"|"failed"|"denied", input, output?, error? }
 */
export interface PersistedMessage {
  id?: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  model?: string;
  characterCount?: number;
  durationMs?: number;
  interrupted?: boolean;
  feedback?: "like" | "dislike";
  attachments?: Array<{ kind: "image" | "file"; filename: string; mimeType: string }>;
  tools?: Array<{
    toolName?: string;
    title?: string;
    status?: "completed" | "failed" | "denied";
    input: unknown;
    output?: unknown;
    error?: string;
  }>;
  thought?: string;
  parts?: Array<
    | { type: "content"; content: string }
    | { type: "thought"; content: string }
    | { type: "tool-call"; toolIndex: number }
  >;
  turnIndex?: number;
}

/**
 * 会话任务（task）元数据（@原始 jHn）
 * 一个 workspace 可有多个 task（会话），每个 task 对应一个 AgentRuntime。
 */
export interface SessionTask {
  taskId: string;
  traceId: string;
  title: string;
  workspacePath: string;
  workspaceIdentity?: string;
  createdAt: number;
  updatedAt: number;
  mode: SessionMode;
  model?: string;
  runtimeEpoch?: number;
  provider?: ModelProvider;
  migrationSource?: "claudeCode";
  forkedFromTaskId?: string;
  unreadAt?: number;
  status?: "running" | "completed" | "error";
  lastError?: { code?: string; message: string; traceId?: string; taskId?: string };
  changeSummary?: {
    fileCount: number;
    added: number;
    removed: number;
    files: Array<{ path: string; added: number; removed: number; writeCount: number; lastTurnIndex: number }>;
  };
}

// 重新导出避免循环
type SessionMode = import("../permissions/permission-service").SessionMode;
