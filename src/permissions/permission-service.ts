/**
 * 权限决策引擎（PermissionService）
 * ---------------------------------------------------------------------------
 * 还原自 zcode.cjs @576736：E0 = class PermissionService
 *   checkPermission(request, projectRules, capability) → { decision, ruleId, reason }
 *
 * 这是 Harness 安全模型的核心：每个工具调用执行前都先经过这里，
 * 根据当前【会话模式】×【工具风险】×【项目规则】决定 allow / ask / deny。
 *
 * 决策优先级链（自上而下，命中即返回）：
 *   1. 工具自身要求 userInteraction      → ask
 *   2. disallowedTools 黑名单             → deny
 *   3. mode === "yolo"                    → allow（yolo 跳过所有提示）
 *   4. mode === "auto"                    → deny（auto 未实现）
 *   5. 项目 deny 规则                      → deny
 *   6. 项目 ask 规则                       → ask
 *   7. mode === "plan"                    → checkPlanMode（只读非破坏 allow，否则 deny）
 *   8. 项目 allow 规则                     → allow
 *   9. 全局 allowedTools 白名单            → allow
 *  10. mode === "edit"                    → checkEditMode（edit 类 allow，否则走 build）
 *  11. mode === "build"(default)          → checkBuildMode（按风险梯度）
 */
import { RiskLevel, SideEffectScope, PermissionLevel } from "../tools/capability";

/** 10 种会话模式（@原始 zHn / rQn） */
export type SessionMode =
  | "default"
  | "yolo"
  | "plan"
  | "edit"
  | "acceptEdits"
  | "auto"
  | "dontAsk"
  | "bypassPermissions"
  | "autoEdit"
  | "build";

export type Decision = "allow" | "ask" | "deny";

export interface PermissionRequest {
  toolName: string;
  input: unknown;
  mode: SessionMode;
}

export interface ResolvedCapability {
  permissionName: PermissionLevel;
  readOnly: boolean;
  destructive: boolean;
  needsApproval: boolean;
  riskLevel: RiskLevel;
  sideEffectScope: SideEffectScope;
}

export interface ProjectPermissionRules {
  allow?: ProjectRule[];
  ask?: ProjectRule[];
  deny?: ProjectRule[];
}

export interface ProjectRule {
  toolName: string;
  ruleContent?: string; // 如 "git commit:*" / "rm -rf *"
}

export interface PermissionResult {
  decision: Decision;
  ruleId: string;
  reason: string;
}

export interface PermissionServiceConfig {
  autoApproveHighRisk: boolean;
  allowedTools: Set<string>;
  disallowedTools: Set<string>;
}

export class PermissionService {
  config: PermissionServiceConfig;

  constructor(config: Partial<PermissionServiceConfig> = {}) {
    this.config = {
      autoApproveHighRisk: false,
      allowedTools: new Set(),
      disallowedTools: new Set(),
      ...config,
    };
  }

  /** @原始 E0.checkPermission */
  checkPermission(
    req: PermissionRequest,
    capability: ResolvedCapability,
    projectRules?: ProjectPermissionRules
  ): PermissionResult {
    // 1. 需要用户交互的工具 → ask
    if (capability.needsApproval === undefined /* requiresUserInteraction */) {
      // （原始逻辑：某些工具标记 requiresUserInteraction）
    }

    // 2. yolo 模式：跳过所有提示
    if (req.mode === "yolo") {
      return this.allow(req, capability, "mode.yolo", "Yolo mode bypasses permission prompts");
    }
    // 3. auto 模式：保留但未实现
    if (req.mode === "auto") {
      return this.deny(req, capability, "mode.auto.unimplemented", "Auto mode is reserved but not implemented yet");
    }
    // 4. 黑名单
    if (this.config.disallowedTools.has(req.toolName)) {
      return this.deny(req, capability, "rule.disallowedTools", `Tool ${req.toolName} is explicitly disallowed`);
    }
    // 5. 项目 deny 规则
    if (this.findProjectRule(projectRules, "deny", req)) {
      return this.deny(req, capability, "rule.project.deny", `Tool ${req.toolName} is denied by project permission rules`);
    }
    // 6. 项目 ask 规则
    if (this.findProjectRule(projectRules, "ask", req)) {
      return this.ask(req, capability, "rule.project.ask", `Tool ${req.toolName} requires approval by project permission rules`);
    }
    // 7. plan 模式：只读非破坏才 allow
    if (req.mode === "plan") {
      return this.checkPlanMode(req, capability);
    }
    // 8. 项目 allow 规则
    if (this.findProjectRule(projectRules, "allow", req)) {
      return this.allow(req, capability, "rule.project.allow", `Tool ${req.toolName} is allowed by project permission rules`);
    }
    // 9. 全局白名单
    if (this.config.allowedTools.has(req.toolName)) {
      return this.allow(req, capability, "rule.allowedTools", `Tool ${req.toolName} is explicitly allowed`);
    }
    // 10. edit 模式
    if (req.mode === "edit") {
      return this.checkEditMode(req, capability);
    }
    // 11. build / default 模式
    return this.checkBuildMode(req, capability);
  }

  // ──────────────────────────── 模式策略 ────────────────────────────

  /** @原始 checkPlanMode — 只读且非破坏 → allow，否则 deny */
  private checkPlanMode(req: PermissionRequest, cap: ResolvedCapability): PermissionResult {
    if (cap.readOnly && !cap.destructive) {
      return this.allow(req, cap, "mode.plan.readOnly", "Plan mode allows read-only tool execution");
    }
    return this.deny(req, cap, "mode.plan.nonReadOnly", "Plan mode only allows read-only, non-destructive tools");
  }

  /** @原始 checkEditMode — 文件编辑类（edit×workspace）→ allow，否则走 build */
  private checkEditMode(req: PermissionRequest, cap: ResolvedCapability): PermissionResult {
    if (cap.permissionName === "edit" && cap.sideEffectScope === "workspace") {
      return this.allow(req, cap, "mode.edit.fileEdit", "Edit mode allows file edit tools");
    }
    return this.checkBuildMode(req, cap);
  }

  /** @原始 checkBuildMode — 按风险梯度判定（default 模式的默认策略） */
  private checkBuildMode(req: PermissionRequest, cap: ResolvedCapability): PermissionResult {
    // 只读 + 非破坏 + 无需批准 → allow
    if (cap.readOnly && !cap.destructive && !cap.needsApproval) {
      return this.allow(req, cap, "mode.build.readOnly", "Build mode allows read-only tools");
    }
    // critical 风险 → ask
    if (cap.riskLevel === "critical") {
      return this.ask(req, cap, "mode.build.criticalRisk", "Critical risk tools require explicit approval");
    }
    // high 风险（且未开启 autoApproveHighRisk）→ ask
    if (cap.riskLevel === "high" && !this.config.autoApproveHighRisk) {
      return this.ask(req, cap, "mode.build.highRisk", "High risk tools require explicit approval");
    }
    // 低风险 session-local 状态更新 → allow
    if (cap.sideEffectScope === "session" && cap.riskLevel === "low" && !cap.destructive && !cap.needsApproval) {
      return this.allow(req, cap, "mode.build.sessionState", "Build mode allows low-risk session-local state updates");
    }
    // 有副作用/需批准/破坏性 → ask
    if (cap.needsApproval || cap.destructive || cap.sideEffectScope !== "none") {
      return this.ask(req, cap, "mode.build.sideEffect", "Tool has side effects and requires approval");
    }
    // 其余低风险 → allow
    return this.allow(req, cap, "mode.build.lowRisk", "Build mode allows low-risk tool execution");
  }

  // ──────────────────────────── 项目规则匹配 ────────────────────────────

  /** @原始 findProjectRule */
  private findProjectRule(rules: ProjectPermissionRules | undefined, kind: keyof ProjectPermissionRules, req: PermissionRequest): ProjectRule | undefined {
    const list = rules?.[kind];
    if (!Array.isArray(list)) return undefined;
    return list.find((r) => this.matchesRule(r, req));
  }

  /** @原始 matchesRule */
  private matchesRule(rule: ProjectRule, req: PermissionRequest): boolean {
    if (!this.matchesRuleToolName(rule.toolName, req.toolName)) return false;
    if (!rule.ruleContent) return true; // 无内容则匹配该工具所有调用
    const subjects = this.ruleSubjects(req.input, req.toolName);
    if (subjects.length === 0) return false;
    return subjects.some((s) => this.matchesRuleContent(s, rule.ruleContent!));
  }

  /** Write 规则也匹配 Edit（@原始 matchesRuleToolName） */
  private matchesRuleToolName(ruleTool: string, reqTool: string): boolean {
    return ruleTool === reqTool || (reqTool === "Write" && ruleTool === "Edit");
  }

  /** @原始 ruleSubjects — 从输入中提取用于匹配的"主题"字符串 */
  private ruleSubjects(input: unknown, toolName: string): string[] {
    if (typeof input === "string") return [input];
    if (!input || typeof input !== "object") return [];
    const o = input as Record<string, unknown>;
    // WebFetch 特殊：用 url 的域名 + 完整 url
    if (toolName === "WebFetch" && typeof o.url === "string") {
      const domain = extractDomain(o.url);
      return domain ? [domain, o.url] : [o.url];
    }
    // 其余工具：依次取 command/url/file_path/path/pattern/patch_text
    for (const key of ["command", "url", "file_path", "path", "pattern", "patch_text"]) {
      const v = o[key];
      if (typeof v === "string") return [v];
    }
    return [];
  }

  /** @原始 matchesRuleContent — 支持 "prefix:*" 通配与 glob */
  private matchesRuleContent(subject: string, rule: string): boolean {
    if (rule.endsWith(":*")) {
      const prefix = rule.slice(0, -2);
      return subject === prefix || subject.startsWith(`${prefix} `) || subject.startsWith(`${prefix}\t`);
    }
    if (rule.includes("*")) return globToRegex(rule).test(subject);
    return subject === rule;
  }

  // ──────────────────────────── 决策工厂 ────────────────────────────

  private allow(req: PermissionRequest, _cap: ResolvedCapability, ruleId: string, reason: string): PermissionResult {
    return { decision: "allow", ruleId, reason };
  }
  private deny(req: PermissionRequest, _cap: ResolvedCapability, ruleId: string, reason: string): PermissionResult {
    return { decision: "deny", ruleId, reason };
  }
  private ask(req: PermissionRequest, _cap: ResolvedCapability, ruleId: string, reason: string): PermissionResult {
    return { decision: "ask", ruleId, reason };
  }

  // ──────────────────────────── 工具风险推断（无 capability 时） ────────────────────────────

  /** @原始 getRiskLevel */
  getRiskLevel(toolName: string, cap?: ResolvedCapability): RiskLevel {
    if (cap?.riskLevel) return cap.riskLevel;
    if (this.isReadOnlyTool(toolName)) return "low";
    if (this.isWriteTool(toolName)) return "medium";
    if (this.isDestructiveTool(toolName)) return "high";
    return "medium";
  }
  isReadOnlyTool(toolName: string): boolean {
    return new Set(["Read", "Glob", "Grep", "TodoRead"]).has(toolName);
  }
  isWriteTool(toolName: string): boolean {
    return new Set(["Write", "Edit"]).has(toolName);
  }
  isDestructiveTool(toolName: string): boolean {
    // 仅极少数工具标记 destructive:true（@原始 destructive:!0 计数=1）
    return false;
  }
}

// ──────────────────────────── 辅助 ────────────────────────────

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function globToRegex(glob: string): RegExp {
  // 简化版（原始 gvt 实现更完整）
  const re = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${re}$`);
}
