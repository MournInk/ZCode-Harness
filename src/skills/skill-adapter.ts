/**
 * 技能发现与加载器（NodeSkillAdapter）
 * ---------------------------------------------------------------------------
 * 还原自 zcode.cjs：mSe = class NodeSkillAdapter
 *   discoverSkills(context, signal) → 按优先级扫描所有技能根目录
 *   loadSkill(target, signal)       → 读取并解析单个 SKILL.md
 *
 * 技能来源（按优先级，@原始 SUt 解析）：
 *   1. 用户级技能目录（~/.zcode/skills/...）
 *   2. 项目级技能目录（./.zcode/skills/...）
 *   3. 插件提供的技能（plugins/*/skills/）
 *   4. 内置技能包（resources/glm/packages/*-plugin）
 *
 * 每个 SKILL.md 含 YAML-like frontmatter：
 *   ---
 *   name: docx
 *   description: 完整的 DOCX 文档创建能力...
 *   when_to_use: 适用于创建新文档...
 *   license: ...
 *   metadata: ...
 *   ---
 *   # 正文指令（Markdown）
 *
 * 这正是本会话可用的 docx / pdf / skill-creator 技能的来源。
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const SKILL_FILENAME = "SKILL.md";        // @原始 Upn
const FRONTMATTER_READ_BYTES = 1024;      // @原始 Fpn（仅读取头部判断 frontmatter）
const MAX_SKILL_BYTES = 100000;           // @原始 qpn（loadSkill 默认上限）
const ALLOWED_FRONTMATTER_KEYS = new Set([
  "name", "description", "when_to_use", "license", "metadata",
]); // @原始 Zpn

export interface SkillRoot {
  path: string;
  priority: number; // 数字越小优先级越高
}

export interface ParsedSkill {
  name: string;
  description: string;
  whenToUse?: string;
  license?: string;
  metadata?: string;
  path: string;          // SKILL.md 绝对路径
  directory: string;     // 技能目录（SKILL.md 所在目录）
  frontmatterKeys: string[];
}

export interface SkillDiagnostic {
  code: string;
  severity: "warning" | "error";
  message: string;
  path: string;
  pluginId?: string;
}

export interface DiscoverResult {
  skills: ParsedSkill[];
  diagnostics: SkillDiagnostic[];
  totalDiscovered: number;
}

export interface LoadResult {
  metadata: ParsedSkill;
  content: string;       // 去掉 frontmatter 后的正文
  baseDirectory: string;
  bytesRead: number;
  sizeBytes: number;
  truncated: boolean;
}

export interface SkillAdapterOptions {
  disabledPaths?: string[];
  roots?: SkillRoot[];
}

export class NodeSkillAdapter {
  options: SkillAdapterOptions;
  disabledPaths: Set<string>;

  constructor(options: SkillAdapterOptions = {}) {
    this.options = options;
    this.disabledPaths = new Set(
      Array.from(options.disabledPaths ?? [], (p) => path.resolve(p))
    );
  }

  /** @原始 mSe.discoverSkills */
  async discoverSkills(
    context: { workingDirectory: string; roots?: SkillRoot[] },
    signal?: AbortSignal
  ): Promise<DiscoverResult> {
    throwIfCancelled(signal);
    const cwd = path.resolve(context.workingDirectory);
    const roots = context.roots ?? (await resolveSkillRoots(cwd, this.options));
    const diagnostics: SkillDiagnostic[] = [];
    const byPath = new Map<string, ParsedSkill>();
    let total = 0;

    // 按优先级排序（priority 小的先扫，先到先得，去重 by path）
    for (const root of roots.toSorted((a, b) => a.priority - b.priority)) {
      throwIfCancelled(signal);
      const files = await this.skillFilesUnderRoot(root, diagnostics);
      for (const file of files) {
        throwIfCancelled(signal);
        const parsed = await this.parseSkill(file, root, diagnostics);
        if (parsed) {
          if (this.disabledPaths.has(path.resolve(parsed.path))) continue; // 被禁用
          total++;
          if (!byPath.has(parsed.path)) byPath.set(parsed.path, parsed);
        }
      }
    }
    return {
      skills: Array.from(byPath.values()).toSorted((a, b) => a.name.localeCompare(b.name)),
      diagnostics,
      totalDiscovered: total,
    };
  }

  /** @原始 mSe.loadSkill */
  async loadSkill(
    target: { name: string; workingDirectory: string; roots?: SkillRoot[]; maxBytes?: number },
    signal?: AbortSignal
  ): Promise<LoadResult> {
    throwIfCancelled(signal);
    const discovered = (
      await this.discoverSkills({ workingDirectory: target.workingDirectory, roots: target.roots }, signal)
    ).skills.find((s) => s.name === target.name);
    if (!discovered) throw new Error(`Skill not found: ${target.name}`);

    const maxBytes = target.maxBytes ?? MAX_SKILL_BYTES;
    const stat = await fs.stat(discovered.path);
    const truncated = stat.size > maxBytes;
    const buf = truncated ? await readHead(discovered.path, maxBytes) : await fs.readFile(discovered.path);
    const text = buf.toString("utf8");
    const content = stripFrontmatter(text).trim();

    return {
      metadata: discovered,
      content,
      baseDirectory: discovered.directory,
      bytesRead: buf.byteLength,
      sizeBytes: stat.size,
      truncated,
    };
  }

  /** @原始 mSe.skillFilesUnderRoot — root.path 是目录，其下的每个子目录的 SKILL.md */
  private async skillFilesUnderRoot(root: SkillRoot, diagnostics: SkillDiagnostic[]): Promise<string[]> {
    try {
      const stat = await fs.stat(root.path);
      if (!stat.isDirectory()) return [];
      const entries = await fs.readdir(root.path, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => path.join(root.path, e.name, SKILL_FILENAME));
    } catch (err) {
      if (isENOENT(err)) return [];
      diagnostics.push({
        code: "skill_scan_failed",
        severity: "warning",
        message: err instanceof Error ? err.message : `Failed to scan skill root: ${root.path}`,
        path: root.path,
      });
      return [];
    }
  }

  /** @原始 mSe.parseSkill */
  private async parseSkill(file: string, root: SkillRoot, diagnostics: SkillDiagnostic[]): Promise<ParsedSkill | null> {
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (err) {
      if (isENOENT(err)) return null;
      diagnostics.push({
        code: "skill_read_failed",
        severity: "warning",
        message: err instanceof Error ? err.message : `Failed to read skill: ${file}`,
        path: file,
      });
      return null;
    }

    const fmText = extractFrontmatter(text);
    const fm = fmText ? parseFrontmatter(fmText, file, diagnostics) : { values: {}, keys: [] };
    const name = unwrapQuotes(fm.values.name) ?? (fmText ? undefined : path.basename(path.dirname(file)));
    if (!name) {
      diagnostics.push({ code: "skill_missing_name", severity: "warning", message: `Skill missing name: ${file}`, path: file });
      return null;
    }
    return {
      name,
      description: unwrapQuotes(fm.values.description) ?? "",
      whenToUse: unwrapQuotes(fm.values.when_to_use),
      license: unwrapQuotes(fm.values.license),
      metadata: unwrapQuotes(fm.values.metadata),
      path: file,
      directory: path.dirname(file),
      frontmatterKeys: fm.keys,
    };
  }
}

// ──────────────────────────── frontmatter 解析（@原始 Gpn/Vpn/Wpn/pSe） ────────────────────────────

/** @原始 Gpn — 提取 --- 之间的 frontmatter 文本 */
export function extractFrontmatter(text: string): string | null {
  const t = text.replace(/^\uFEFF/, "");
  if (!t.startsWith("---")) return null;
  const lines = t.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end <= 0) return null;
  return lines.slice(1, end).join("\n");
}

/** @原始 Vpn — 去掉 frontmatter，返回正文 */
export function stripFrontmatter(text: string): string {
  const t = text.replace(/^\uFEFF/, "");
  if (!t.startsWith("---")) return t;
  const lines = t.split(/\r?\n/);
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end <= 0) return t;
  return lines.slice(end + 1).join("\n");
}

/** @原始 Wpn — 解析 key: value 行 */
function parseFrontmatter(fmText: string, file: string, diagnostics: SkillDiagnostic[]): { values: Record<string, string>; keys: string[] } {
  const values: Record<string, string> = {};
  const keys: string[] = [];
  const lines = fmText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0 || line.trim().startsWith("#") || /^\s/.test(line)) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) {
      diagnostics.push({
        code: "skill_invalid_frontmatter",
        severity: "warning",
        message: `Invalid frontmatter line ${i + 1} in ${path.basename(file)}`,
        path: file,
      });
      continue;
    }
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    keys.push(key);
    values[key] = val;
  }
  return { values, keys };
}

/** @原始 pSe — 去掉首尾引号 */
function unwrapQuotes(v?: string): string | undefined {
  if (v === undefined) return;
  const t = v.trim();
  if (t.length === 0) return;
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

/** @原始 Kpn — 仅读取文件头部 maxBytes */
async function readHead(file: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(Math.max(0, maxBytes));
    const { bytesRead } = await handle.read(buf, 0, buf.byteLength, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isENOENT(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "ENOENT";
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Skill operation cancelled");
}

/** @原始 SUt — 解析技能根目录列表（按优先级）。具体路径来自配置，此处给出典型布局。 */
async function resolveSkillRoots(cwd: string, _options: SkillAdapterOptions): Promise<SkillRoot[]> {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return [
    // 用户级
    { path: path.join(home, ".zcode", "skills"), priority: 10 },
    // 项目级
    { path: path.join(cwd, ".zcode", "skills"), priority: 20 },
    // 插件市场缓存（实际由 plugin 系统注入）
    { path: path.join(home, ".zcode", "cli", "plugins", "cache"), priority: 30 },
  ];
}

export function createSkillAdapter(options?: SkillAdapterOptions): NodeSkillAdapter {
  return new NodeSkillAdapter(options);
}
