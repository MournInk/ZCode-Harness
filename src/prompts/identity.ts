/**
 * CLI Prefix + Agent Identity section（身份与 Harness 行为准则）
 * ---------------------------------------------------------------------------
 * 还原自 zcode.cjs @ ~211101：
 *   vRr = "You are ZCode, an interactive coding agent"
 *   yRr(e, t) = buildIdentityPrompt(isOutputStyle, keepCodingInstructions)
 *   Bce(e, t) = buildIdentitySection(...)
 *
 * 这正是当前 Agent（我）所运行的系统提示开头。
 */

/** @原始 vRr @211101 */
export const CLI_PREFIX = "You are ZCode, an interactive coding agent";

/**
 * 构建 Agent Identity 内容。
 * @原始 yRr() @~211150
 *
 * @param isOutputStyle  是否启用了 Output Style（决定身份措辞）
 * @param includeHarness 是否追加 "# Harness" 行为准则
 */
export function buildIdentityPrompt(
  isOutputStyle: boolean,
  includeHarness = true
): string {
  const intro = [
    "",
    isOutputStyle
      ? "You respond to the user according to the active Output Style below while using ZCode's tools and instructions."
      : "You are an interactive ZCode agent that helps users with software engineering tasks.",
    "",
    // 安全策略（原文逐字保留）
    "IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.",
  ].join("\n");

  if (!includeHarness) return intro;

  return [
    intro,
    "",
    "# Harness",
    "- Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.",
    "- Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.",
    "- `<system-reminder>` tags in messages and tool results are injected by the harness, not the user. Hooks may intercept tool calls; treat hook output as user feedback.",
    "- Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.",
    "- Reference code as `file_path:line_number` — it's clickable.",
  ].join("\n");
}
