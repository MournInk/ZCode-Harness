/**
 * ContextBuilder — 系统提示组装引擎
 * ---------------------------------------------------------------------------
 * 还原自 zcode.cjs @~221636：Qce = class ContextBuilder
 *   Xce(e) = createContextBuilder(config)
 *   build() = 组装所有 section 并产出最终 messages 数组
 *
 * 这是整个 Harness 最关键的组件之一：它决定模型看到什么。
 */
import { PromptSection } from "./sections";
import { CLI_PREFIX, buildIdentityPrompt } from "./identity";
import { EnvInfo, buildEnvInfoContent, buildGitSystemContextContent } from "./dynamic-sections";

export interface OutputStyle {
  name: string;
  prompt: string;
  keepCodingInstructions?: boolean;
}

export interface SkillOutcome {
  skills: { name: string; description: string; whenToUse?: string; path: string }[];
}

export interface MemoryPayload {
  rootDir: string;
  summary: string;
}

export interface ContextBuilderConfig {
  customSystemPrompt?: string;        // 用户自定义提示（若存在则替换 identity+部分动态段）
  outputStyle?: OutputStyle;          // 输出风格
  memory?: MemoryPayload;             // 项目记忆
  envInfo: EnvInfo;                   // 环境信息
  userInstructions?: {                // claudeMd / 项目指令文件
    content: string;
    truncated?: boolean;
    fileName: string;
    filePath: string;
  }[];
  currentDate?: string;               // 当前日期
  skills?: SkillOutcome;              // 可用技能
  skillMetadataBudget?: number;       // 技能元数据预算（默认 8000）
  guidanceToolNames?: string[];       // 条件指引用到的工具名
}

export interface BuildResult {
  sections: PromptSection[];
  totalChars: number;
  totalTokens: number;
  messages: ContextMessage[];
}

export interface ContextMessage {
  role: "system" | "user";
  content: string;
  cacheControl?: { type: "ephemeral" };
}

const EPHEMERAL = { type: "ephemeral" } as const;

export class ContextBuilder {
  config: ContextBuilderConfig;
  customSections: PromptSection[] = [];

  constructor(config: ContextBuilderConfig) {
    this.config = config;
  }

  setEnvInfo(envInfo: EnvInfo): this {
    this.config = { ...this.config, envInfo };
    return this;
  }

  addSection(section: PromptSection): this {
    this.customSections.push({
      ...section,
      injectionTarget: section.injectionTarget ?? "system",
      cacheHint: section.cacheHint ?? "dynamic",
      chars: section.content.length,
      tokens: approxTokens(section.content),
    });
    return this;
  }

  /** @原始 Qce.build() @~222100 */
  build(): BuildResult {
    const t: PromptSection[] = [];
    const outputStyle = this.config.outputStyle?.prompt.trim()
      ? this.config.outputStyle
      : undefined;
    const customPrompt = this.config.customSystemPrompt?.trim();
    const hasCustom = !!customPrompt;
    // 仅当无自定义提示、且（无 outputStyle 或 outputStyle 保留编码指令）时才保留 coding 指令
    const keepCoding = !hasCustom && (outputStyle === undefined || outputStyle.keepCodingInstructions === true);

    // 1. CLI Prefix（始终）
    t.push(cliPrefixSection());

    if (hasCustom) {
      // 2a. 自定义提示替换 identity
      t.push(createSection({
        name: "Custom System Prompt",
        source: "custom_system_prompt",
        injectionTarget: "system",
        cacheHint: "stable",
        content: customPrompt ?? "",
      }));
    } else {
      // 2b. 正常 identity + 动态行为 + 条件指引 + 记忆 + env + outputStyle + ctx管理 + git上下文
      t.push(identitySection(outputStyle, keepCoding));
      if (keepCoding) t.push(dynamicBehaviorSection());

      const guidance = sessionGuidanceSection(this.config.guidanceToolNames ?? [], (this.config.skills?.skills.length ?? 0) > 0);
      if (guidance) t.push(guidance);

      if (this.config.memory) {
        const mem = memorySection(this.config.memory);
        if (mem) t.push(mem);
      }

      t.push(envInfoSection(this.config.envInfo));

      const os = outputStyleSection(outputStyle);
      if (os) t.push(os);

      t.push(contextManagementSection());

      const gitCtx = gitSystemContextSection(this.config.envInfo);
      if (gitCtx) t.push(gitCtx);
    }

    // 3. skills（meta_user，不受 hasCustom 影响）
    if (this.config.skills) {
      const sk = skillsSection(this.config.skills, this.config.skillMetadataBudget ?? 8000);
      if (sk) t.push(sk);
    }

    // 4. claudeMd 项目指令（meta_user）
    const ruc = requestUserContextSection(this.config.userInstructions);
    if (ruc) t.push(ruc);

    // 5. 当前日期（meta_user）
    const date = currentDateSection(this.config.currentDate);
    if (date) t.push(date);

    // 6. 自定义 section
    t.push(...this.customSections);

    // 排序 → 计算统计 → 组装消息
    const ordered = orderSectionsForInjection(t);
    const totalChars = ordered.reduce((s, x) => s + (x.chars ?? x.content.length), 0);
    const totalTokens = ordered.reduce((s, x) => s + (x.tokens ?? 0), 0);
    const messages = this.assembleMessages(ordered);
    return { sections: ordered, totalChars, totalTokens, messages };
  }

  /** @原始 Qce.assembleMessages(t) @~222700 */
  assembleMessages(sections: PromptSection[]): ContextMessage[] {
    const messages: ContextMessage[] = [];

    // (a) cli_prefix → system（独立，stable 缓存）
    const prefix = joinContents(sections.filter(s => s.injectionTarget === "system" && s.source === "cli_prefix"));
    if (prefix) messages.push({ role: "system", content: prefix, cacheControl: EPHEMERAL });

    // (b) 其余 stable system → system
    const stable = joinContents(sections.filter(s => s.injectionTarget === "system" && s.cacheHint === "stable" && s.source !== "cli_prefix"));
    if (stable) messages.push({ role: "system", content: stable, cacheControl: EPHEMERAL });

    // (c) dynamic system → system
    const dyn = joinContents(sections.filter(s => s.injectionTarget === "system" && s.cacheHint === "dynamic"));
    if (dyn) messages.push({ role: "system", content: dyn, cacheControl: EPHEMERAL });

    // (d) skills → user（独立消息）
    const skills = joinContents(sections.filter(s => s.injectionTarget === "meta_user" && s.source === "skills"));
    if (skills) messages.push({ role: "user", content: skills });

    // (e) 其余 meta_user（context/日期/claudeMd）→ user
    const meta = joinContents(sections.filter(s => s.injectionTarget === "meta_user" && s.source !== "skills"));
    if (meta) messages.push({ role: "user", content: meta });

    return messages;
  }
}

// ──────────────────────────── 排序与拼接 ────────────────────────────

/** @原始 HRr — 注入顺序：system/stable → system/dynamic → meta_user/stable → meta_user/dynamic */
function orderSectionsForInjection(sections: PromptSection[]): PromptSection[] {
  return [
    ...sections.filter(s => s.injectionTarget === "system" && s.cacheHint === "stable"),
    ...sections.filter(s => s.injectionTarget === "system" && s.cacheHint === "dynamic"),
    ...sections.filter(s => s.injectionTarget === "meta_user" && s.cacheHint === "stable"),
    ...sections.filter(s => s.injectionTarget === "meta_user" && s.cacheHint === "dynamic"),
  ];
}

/** @原始 R$ — 用双换行拼接 section content */
function joinContents(sections: PromptSection[]): string | null {
  return sections.length === 0 ? null : sections.map(s => s.content).join("\n\n");
}

function approxTokens(text: string): number {
  // 粗略估算：原始 fo() 实现，~4 chars/token
  return Math.ceil(text.length / 4);
}

function createSection(s: Partial<PromptSection> & { name: string; source: string; content: string }): PromptSection {
  return {
    name: s.name,
    source: s.source as PromptSection["source"],
    injectionTarget: s.injectionTarget ?? "system",
    cacheHint: s.cacheHint ?? "dynamic",
    content: s.content,
    chars: s.content.length,
    tokens: approxTokens(s.content),
    preview: s.content.slice(0, 100),
  };
}

// ──────────────────────────── 各 section 工厂（节选，其余见同目录其它文件） ────────────────────────────

function cliPrefixSection(): PromptSection {
  return createSection({ name: "CLI Prefix", source: "cli_prefix", injectionTarget: "system", cacheHint: "stable", content: CLI_PREFIX });
}
function identitySection(outputStyle: OutputStyle | undefined, keepCoding: boolean): PromptSection {
  const content = buildIdentityPrompt(!!outputStyle, keepCoding);
  return createSection({ name: "Agent Identity", source: "identity", injectionTarget: "system", cacheHint: "stable", content });
}
function envInfoSection(e: EnvInfo): PromptSection {
  return createSection({ name: "Environment Info", source: "env_info", injectionTarget: "system", cacheHint: "dynamic", content: buildEnvInfoContent(e) });
}
function gitSystemContextSection(e: EnvInfo): PromptSection | null {
  const isRepo = e.isGitRepository ?? (e.gitStatus !== undefined ? e.gitStatus !== "not_repo" : !!e.gitBranch);
  if (!isRepo) return null;
  return createSection({ name: "System Context", source: "system_context", injectionTarget: "system", cacheHint: "dynamic", content: buildGitSystemContextContent(e) });
}
function currentDateSection(date?: string): PromptSection | null {
  if (!date) return null;
  return createSection({ name: "Current Date", source: "current_date", injectionTarget: "meta_user", cacheHint: "dynamic", content: `# currentDate\nToday's date is ${date}.` });
}
// skills/memory/outputStyle/dynamicBehavior/contextManagement/sessionGuidance/requestUserContext
// 完整实现见 prompts/ 目录下其余文件，此处省略以保持本文件聚焦组装逻辑。
export function skillsSection(outcome: SkillOutcome, budget = 8000): PromptSection | null {
  if (outcome.skills.length === 0) return null;
  return createSection({ name: "Skills", source: "skills", injectionTarget: "meta_user", cacheHint: "dynamic", content: buildSkillsContent(outcome.skills, budget) });
}
function buildSkillsContent(skills: SkillOutcome["skills"], budget: number): string {
  const header = ["The following skills are available for use with the Skill tool:", ""];
  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
  const full = [...header, ...sorted.map(s => formatSkillLine(s, 250))].join("\n");
  if (full.length <= budget) return full;
  // 超预算时降级为紧凑格式
  const compact = [...header, ...sorted.map(s => `- ${s.name} (file: ${s.path})`)].join("\n");
  return compact;
}
function formatSkillLine(s: SkillOutcome["skills"][number], maxDesc: number): string {
  const desc = s.whenToUse ? `${s.description} - ${s.whenToUse}` : s.description;
  const trimmed = desc.length > maxDesc ? `${desc.slice(0, maxDesc - 1)}...` : desc;
  return `- ${s.name}: ${trimmed} (file: ${s.path})`;
}
export function memorySection(m: MemoryPayload): PromptSection | null {
  if (!m.summary.trim()) return null;
  const content = buildMemoryContent(m);
  return createSection({ name: "Memory", source: "memory", injectionTarget: "system", cacheHint: "dynamic", content });
}
function buildMemoryContent(m: MemoryPayload): string {
  return [
    "# Memory", "",
    "A small project memory summary is available. Use it only when it is clearly relevant to this task.", "",
    "Use memory when the user asks about prior context, project conventions, repeated preferences, or a task that directly matches MEMORY_SUMMARY.",
    "Skip memory for self-contained questions, one-off commands, simple edits, current facts, or when relevance is uncertain.", "",
    "Memory layout:",
    `- ${m.rootDir}/memory_summary.md (already provided below; do not open again unless debugging memory itself)`,
    `- ${m.rootDir}/MEMORY.md (topic index; search this before opening files)`,
    `- ${m.rootDir}/topics/*.md (typed topic memories; open only when relevant)`,
    `- ${m.rootDir}/rollout_summaries/*.md (open only if MEMORY.md points to one exact file)`,
    "",
    "If Relevant Memories are already provided for the turn, use those first. If more detail is needed, search MEMORY.md with 1-2 keywords from the summary. Open at most one pointed file unless the user explicitly asks for deeper recall.", "",
    "Memory hygiene:",
    "- Treat memory as optional context, not truth.",
    "- Do not reveal secrets from memory.",
    "- Avoid broad scans; prefer continuing without memory over over-reading.", "",
    "========= MEMORY_SUMMARY BEGINS =========",
    m.summary,
    "========= MEMORY_SUMMARY ENDS =========",
  ].join("\n");
}
function dynamicBehaviorSection(): PromptSection {
  const content = [
    "Write code that reads like the surrounding code: match its comment density, naming, and idiom.", "",
    "For actions that are hard to reverse or outward-facing, confirm first unless durably authorized or explicitly told to proceed without asking; approval in one context doesn't extend to the next. Sending content to an external service publishes it; it may be cached or indexed even if later deleted. Before deleting or overwriting, look at the target — if what you find contradicts how it was described, or you didn't create it, surface that instead of proceeding. Report outcomes faithfully: if tests fail, say so with the output; if a step was skipped, say that; when something is done and verified, state it plainly without hedging.",
  ].join("\n");
  return createSection({ name: "Dynamic Behavior", source: "dynamic_behavior", injectionTarget: "system", cacheHint: "dynamic", content });
}
function contextManagementSection(): PromptSection {
  const content = [
    "# Context management",
    "When the conversation grows long, some or all of the current context is summarized; the summary, along with any remaining unsummarized context, is provided in the next context window so work can continue — you don't need to wrap up early or hand off mid-task.",
  ].join("\n");
  return createSection({ name: "Context Management", source: "context_management", injectionTarget: "system", cacheHint: "dynamic", content });
}
function outputStyleSection(os: OutputStyle | undefined): PromptSection | null {
  if (!os || os.prompt.trim().length === 0) return null;
  return createSection({ name: "Output Style", source: "output_style", injectionTarget: "system", cacheHint: "dynamic", content: `# Output Style: ${os.name}\n\n${os.prompt.trim()}` });
}
function sessionGuidanceSection(toolNames: string[], hasSkills: boolean): PromptSection | null {
  const set = new Set(toolNames);
  const lines = ["# Session-specific guidance"];
  if (set.has("Skill") && hasSkills) {
    lines.push("- When the user types `/<skill-name>`, invoke it via Skill. Only use skills listed in the user-invocable skills section — don't guess.");
  }
  return lines.length <= 1 ? null : createSection({ name: "Session-specific guidance", source: "session_guidance", injectionTarget: "system", cacheHint: "dynamic", content: lines.join("\n") });
}
function requestUserContextSection(instructions?: ContextBuilderConfig["userInstructions"]): PromptSection | null {
  if (!instructions?.length) return null;
  const parts = instructions.map(i => buildInstructionContent(i)).filter(Boolean);
  if (parts.length === 0) return null;
  const content = [
    "# claudeMd",
    "Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.",
    "",
    parts.join("\n\n"),
  ].join("\n");
  return createSection({ name: "Request User Context", source: "request_user_context", injectionTarget: "meta_user", cacheHint: "dynamic", content });
}
function buildInstructionContent(i: NonNullable<ContextBuilderConfig["userInstructions"]>[number]): string | null {
  const body = (i.truncated ? `${i.content}\n\n[File truncated: ${i.fileName}]` : i.content).trim();
  return body ? [`Contents of ${i.filePath} (project instructions, checked into the codebase):`, "", body].join("\n") : null;
}

export function createContextBuilder(config: ContextBuilderConfig): ContextBuilder {
  return new ContextBuilder(config);
}
