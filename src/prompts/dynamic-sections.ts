/**
 * Environment Info + System Context section
 * ---------------------------------------------------------------------------
 * 还原自 zcode.cjs：
 *   wRr, bRr, kRr, SRr, IRr, CRr, TRr, ERr, $Rr, PRr, ARr, DRr, MRr, zRr, RRr, ORr, NRr
 *   jRr(e) = buildEnvInfoContent(envInfo)
 *   Uce(e) = buildEnvInfoSection(envInfo)
 *   BRr(e) = buildGitSystemContextContent(envInfo)
 *   Fce(e) = buildGitSystemContextSection(envInfo)
 *   P0t(e) = isGitRepository(envInfo)
 *
 * 这就是每个会话开头看到的 "# Environment" 块。
 */

export interface EnvInfo {
  cwd: string;
  platform: string;
  shell: string;
  osVersion: string;
  currentModel?: string;
  // git 相关
  isGitRepository?: boolean;
  gitStatus?: "clean" | "dirty" | "not_repo" | string;
  gitBranch?: string;
  gitMainBranch?: string;
  gitUser?: string;
  gitStatusLines?: string[];
  recentCommits?: string[];
}

// @原始 wRr
const ENV_HEADER = "# Environment";
// @原始 bRr..NRr
const L = {
  primaryWorkingDirectory: "Primary working directory",
  isGitRepo: "Is a git repository",
  platform: "Platform",
  shell: "Shell",
  osVersion: "OS Version",
  yes: "yes",
  no: "no",
  gitStatusNote:
    "gitStatus: This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.",
  currentBranch: "Current branch",
  mainBranch: "Main branch (you will usually use this for PRs)",
  gitUser: "Git user",
  status: "Status",
  recentCommits: "Recent commits",
  clean: "(clean)",
  dirty: "(dirty)",
  unknown: "(unknown)",
};

/** @原始 jRr @~212900 */
export function buildEnvInfoContent(e: EnvInfo): string {
  const isRepo = isGitRepository(e);
  return [
    ENV_HEADER,
    "You have been invoked in the following environment:",
    `- ${L.primaryWorkingDirectory}: ${e.cwd}`,
    `- ${L.isGitRepo}: ${isRepo ? L.yes : L.no}`,
    `- ${L.platform}: ${e.platform}`,
    `- ${L.shell}: ${e.shell}`,
    `- ${L.osVersion}: ${e.osVersion}`,
    ...(e.currentModel ? [`- You are powered by the model named ${e.currentModel}.`] : []),
  ].join("\n");
}

/** @原始 P0t */
function isGitRepository(e: EnvInfo): boolean {
  return (
    e.isGitRepository ??
    (e.gitStatus !== undefined ? e.gitStatus !== "not_repo" : !!e.gitBranch)
  );
}

/** @原始 BRr — git 系统上下文（分支/状态/最近提交） */
export function buildGitSystemContextContent(e: EnvInfo): string {
  const lines = [L.gitStatusNote];
  if (e.gitBranch) lines.push("", `${L.currentBranch}: ${e.gitBranch}`);
  if (e.gitMainBranch) lines.push("", `${L.mainBranch}: ${e.gitMainBranch}`);
  if (e.gitUser) lines.push("", `${L.gitUser}: ${e.gitUser}`);
  lines.push("", `${L.status}:\n${formatGitStatus(e)}`);
  lines.push("", `${L.recentCommits}:\n${formatRecentCommits(e)}`);
  return lines.join("\n");
}

/** @原始 LRr */
function formatGitStatus(e: EnvInfo): string {
  if (e.gitStatusLines && e.gitStatusLines.length > 0) return e.gitStatusLines.join("\n");
  if (e.gitStatus === "dirty") return L.dirty;
  if (e.gitStatus === "clean") return L.clean;
  return L.unknown;
}

/** @原始 URr */
function formatRecentCommits(e: EnvInfo): string {
  return e.recentCommits && e.recentCommits.length > 0 ? e.recentCommits.join("\n") : "";
}
