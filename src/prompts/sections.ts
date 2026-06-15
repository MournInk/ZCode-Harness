/**
 * Prompt Section 定义
 * ---------------------------------------------------------------------------
 * 还原自 zcode.cjs 中的 section builder 函数。
 * 每个 section 是一个对象：{ name, source, injectionTarget, cacheHint, chars, tokens, content, preview }
 *
 * injectionTarget 决定最终消息角色：
 *   - "system"    → 拼成 system 消息（按 cacheHint 分组：cli_prefix / stable / dynamic）
 *   - "meta_user" → 拼成 user 消息（skills 单独一条，其余 context 一条）
 *
 * cacheHint 决定能否被 provider 端 prompt-cache：
 *   - "stable"  内容跨轮不变（如身份提示），可长期缓存
 *   - "dynamic" 内容随轮次变化（如 env_info、日期）
 *
 * 真实代码：zcode.cjs 的 buildXxxSection 函数族（如 Bce=buildIdentitySection）。
 */

/** Section 元数据 + 内容。对应原始 {name, source, injectionTarget, cacheHint, chars, tokens, content, preview} */
export interface PromptSection {
  name: string;
  source: SectionSource;
  injectionTarget: "system" | "meta_user";
  cacheHint: "stable" | "dynamic";
  content: string;
  // 派生字段（build 时自动计算）：
  chars?: number;
  tokens?: number;
  preview?: string;
}

export type SectionSource =
  | "cli_prefix"
  | "identity"
  | "dynamic_behavior"
  | "session_guidance"
  | "memory"
  | "env_info"
  | "output_style"
  | "context_management"
  | "system_context"
  | "custom_system_prompt"
  | "skills"
  | "request_user_context"
  | "current_date";

/** cacheControl 标记，标记可缓存的 system 消息（对应原始 Jce = { type: "ephemeral" }） */
export const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" } as const;
