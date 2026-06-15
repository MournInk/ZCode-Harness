/**
 * 工具能力模型（Tool Capability）
 * ---------------------------------------------------------------------------
 * 还原自 zcode.cjs 的 lgt / s2t / ... capability 对象。
 *
 * 每个工具是一个 "capability" 对象，包含：
 *   - capability:     一句话能力描述（给内部用）
 *   - metadata:       工具元数据（名称、描述、只读/破坏性/并发安全/超时/风险/是否需批准）
 *   - handler:        实际执行函数 (input, ctx) => result
 *   - inputSchema:    zod 输入 schema
 *   - outputSchema:   zod 输出 schema
 *   - permission:     权限模型（级别、原因、风险、副作用范围、模式来源、拒绝优先级）
 *   - resultBudget:   结果预算（内联/模型字节上限、截断策略、预览）
 *   - timeout:        超时（默认/最大/是否允许调用覆盖）
 *   - cancellation:   取消支持（是否支持、清理动作、用户可见消息）
 *   - trace:          追踪（是否必需、是否传播到 adapter、输入/输出记录级别）
 */

/** 8 种权限级别（permission.permission 的取值） */
export type PermissionLevel =
  | "read"      // 只读：Read/Glob/Grep
  | "edit"      // 文件编辑：Write/Edit
  | "bash"      // Shell 执行：Bash
  | "mcp"       // MCP 外部工具
  | "skill"     // 技能调用：Skill
  | "subagent"  // 子 Agent：Agent
  | "webfetch"  // 抓取网页：WebFetch
  | "websearch"; // 网页搜索：WebSearch

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type SideEffectScope = "none" | "session" | "workspace" | "external";

export interface ToolMetadata {
  name: string;
  description: string;        // 给模型看的完整描述
  readOnly: boolean;          // 是否只读
  destructive: boolean;       // 是否破坏性
  concurrentSafe: boolean;    // 是否可并发执行
  timeoutMs: number;
  maxOutputBytes: number;
  sideEffectScope: SideEffectScope;
  riskLevel: RiskLevel;
  needsApproval: boolean;
}

export interface ToolPermission {
  permission: PermissionLevel;
  reason: string;
  riskLevel: RiskLevel;
  sideEffectScope: SideEffectScope;
  needsApproval: boolean;
  /** 用于权限规则匹配的输入字段（如 Bash 的 command、WebFetch 的 url、Read 的 path） */
  patternSources: string[];
  /** 这些 patternSource 即使匹配 deny 也总是允许（用于只读工具的安全路径） */
  alwaysAllowPatternSources?: string[];
  /** deny 规则的优先级：beforeAsk（先查 deny 再 ask） */
  denyPriority?: "beforeAsk";
}

export interface ResultBudget {
  maxInlineBytes: number;
  maxModelBytes: number;
  strategy: "truncate" | "summarize";
  preview?: { maxBytes: number; direction: "head" | "tail" };
}

export interface ToolTimeout {
  defaultMs: number;
  maxMs: number;
  allowCallOverride: boolean;
}

export interface ToolCancellation {
  supported: boolean;
  cleanup: "none" | "kill";
  userVisibleMessage: string;
}

export interface ToolTrace {
  required: boolean;
  propagateToAdapters: boolean;
  recordInput: "none" | "summary" | "full";
  recordOutput: "none" | "summary" | "full";
}

export interface ToolCapability<I = unknown, O = unknown> {
  capability: string;
  metadata: ToolMetadata;
  handler: (input: I, ctx: ToolContext) => Promise<O>;
  inputSchema: unknown;   // zod schema
  outputSchema: unknown;  // zod schema
  permission: ToolPermission;
  resultBudget: ResultBudget;
  timeout: ToolTimeout;
  cancellation: ToolCancellation;
  trace: ToolTrace;
}

/** 工具执行上下文（传入 handler 的 ctx，还原自原始 t 参数） */
export interface ToolContext {
  toolCallId: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sessionId: string;
  turnId: string;
  workingDirectory: string;
  workspaceRoot?: string;
  abortSignal: AbortSignal;
  // 各种 Port（端口适配器）：
  fileSystemPort?: FileSystemPort;
  executionPort?: ExecutionPort;
  skillPort?: SkillPort;
  subagentPort?: SubagentPort;
  imageProcessorPort?: ImageProcessorPort;
  readFileState?: Map<string, ReadFileState>;
}

export interface ReadFileState {
  path: string;
  content?: string;
  revisionId?: string;
  isPartialView?: boolean;
  offset?: number;
  limit?: number;
}

// Port 接口签名（简化，仅展示工具用到的方法）
export interface FileSystemPort {
  stat(req: { path: string; trace?: unknown }, opts?: { signal?: AbortSignal }): Promise<{ size: number; mtimeMs: number } & Record<string, unknown>>;
  readTextFile(req: { path: string; trace?: unknown }, opts?: { signal?: AbortSignal }): Promise<{ content: string; encoding?: string; lineEndings?: string; revision?: { id: string } }>;
  writeTextFile(req: { path: string; content: string; createParents?: boolean; atomic?: boolean; expectedRevision?: { id: string }; trace?: unknown }, opts?: { signal?: AbortSignal }): Promise<{ revision: { id: string } }>;
  searchFiles(req: { path: string; pattern: string; maxResults?: number; trace?: unknown }, opts?: { signal?: AbortSignal }): Promise<{ files: string[]; durationMs: number; truncated?: boolean }>;
}
export interface ExecutionPort {
  run?(req: unknown, opts?: { signal?: AbortSignal }): Promise<unknown>;
  start?(req: unknown, opts?: { signal?: AbortSignal }): Promise<unknown>;
}
export interface SkillPort { invoke?(req: unknown): Promise<unknown>; }
export interface SubagentPort { run?(req: unknown, opts?: { signal?: AbortSignal }): Promise<unknown>; start?(req: unknown, opts?: { signal?: AbortSignal }): Promise<unknown>; }
export interface ImageProcessorPort { process?(req: unknown): Promise<unknown>; }

// 常量（@原始）
export const READ_DEFAULT_LINES = 2000;      // @原始 hS
export const READ_MAX_BYTES = 0;             // f0 — Read 结果预算
export const BASH_DEFAULT_TIMEOUT_MS = 300000;  // Zde
export const BASH_MAX_TIMEOUT_MS = 600000;      // o2t
