# ZCode CLI Harness — 逆向工程还原 · 完整文件说明

> **逆向对象**：`ZCode/resources/glm/zcode.cjs`（9.42 MB，esbuild 打包的 Node CJS CLI）。
> 
> **本工程**：对该 Harness 的**可读源码重建**——驱动整个 AI Agent 的运行时外壳。

原始代码经 esbuild 压缩混淆（标识符被改写成 `t8r` / `Ckt` / `E0` 等单字母变量），
无法逐行还原 TypeScript；本工程保留了**真实无损的字符串内容**（系统提示全文、
工具描述、权限规则、Schema），并用清晰命名重建了**架构骨架**。
每个文件头部标注它在 `zcode.cjs` 中的**字节偏移**，便于回溯核对。

经 **19/19 字符串交叉验证**确认还原内容与原始 bundle 一致。

---

## 目录速览

```
harness/
├── README.md                  ← 本文件（逐文件说明）
├── ARCHITECTURE.md            ← 架构详解（数据流图 + 子系统 + 偏移索引）
├── raw/                       ← 原始 bundle 副本（只读，供核对）
├── docs/                      ← 从 bundle 提取的原始代码片段（无损）
└── src/                       ← 可读重建源码（13 个 TS 文件，2474 行）
```

---

## 一、顶层文档（2 个）

| 文件 | 大小 | 作用 |
|---|---|---|
| **`README.md`** | 8.3 KB | 本文件。逆向概览 + 全部 65 个文件的逐项说明。每个文件讲清"是什么 / 干什么 / 还原自哪段 bundle"。 |
| **`ARCHITECTURE.md`** | 15.6 KB | 架构深度文档。包含总体分层图、一次用户提问的完整数据流路径、10 大子系统（提示组装/工具/权限/技能/会话/钩子）详解、以及全部关键符号在 `zcode.cjs` 中的字节偏移索引（回溯核对用）。读源码前先读它。 |

---

## 二、原始副本（raw/，2 个）

| 文件 | 大小 | 作用 |
|---|---|---|
| **`raw/zcode.cjs`** | 9.42 MB | 原始打包文件的**只读副本**。9,422,458 字节 / 2,666 行，`#!/usr/bin/env node` 开头。所有 `src/` 和 `docs/` 内容都从这里提取。不要修改它——它是核对基准。 |
| **`raw/prompt_window.txt`** | 14.2 KB | 从 offset ~211101 提取的系统提示原文窗口（"You are ZCode..."开始，向后 14 KB），是定位整个 prompt 组装系统的起点片段。 |

---

## 三、可读重建源码（src/，13 个 TS 文件）

这是工程核心。按**子系统**分组说明每个文件的职责。

### 3.1 入口索引

| 文件 | 大小 | 作用 |
|---|---|---|
| **`src/index.ts`** | 1.2 KB | 整个工程的**统一导出入口**。`export *` 汇总所有子模块，方便一次性 import。同时是一份导读：列出了重建原则（字符串无损 / 类型忠实 / 函数体给签名+伪代码 / 标注偏移）。 |

### 3.2 系统提示组装（src/prompts/，5 个文件）

这组文件还原了 **Harness 最关键的能力：决定模型看到什么**。
ZCode 不用固定系统提示，而是由 `ContextBuilder` 动态拼装 9~13 个可组合 section。

| 文件 | 大小 | 作用 |
|---|---|---|
| **`src/prompts/sections.ts`** | 1.7 KB | **类型基础设施**。定义 `PromptSection` 接口（每个 section 的元数据结构：`name`/`source`/`injectionTarget`/`cacheHint`/`content`）和全部 13 种 `SectionSource` 枚举。`injectionTarget` 决定最终消息角色（system 或 meta_user），`cacheHint` 决定能否被 provider 端 prompt-cache（stable 长期缓存 / dynamic 跨轮变化）。 |
| **`src/prompts/identity.ts`** | 2.4 KB | 还原 **CLI Prefix + Agent Identity** 段。含 `CLI_PREFIX` 常量（原始 `vRr` @211101，那句 "You are ZCode, an interactive coding agent"）和 `buildIdentityPrompt()`（原始 `yRr`）。这是整个系统提示的**第一句**和 "# Harness" 行为准则（含安全策略、工具并行规则、`<system-reminder>` 说明等）。**正是我当前运行的提示开头。** |
| **`src/prompts/dynamic-sections.ts`** | 3.3 KB | 还原 **Environment Info + System Context** 段（原始 `jRr`/`BRr`/`Uce`/`Fce`）。生成每个会话开头看到的 "# Environment" 块：cwd / git / platform / shell / osVersion / 当前模型，以及 git 分支/状态/最近提交。含 `EnvInfo` 接口和格式化函数。 |
| **`src/prompts/context-builder.ts`** | 16.5 KB | **提示组装引擎的核心**（还原原始 `Qce` 类 @221636）。`ContextBuilder.build()` 把所有 section 排序、统计、拼装成最终 4~5 条消息。内含全部 section 工厂函数：identity/envInfo/skills/memory/outputStyle/dynamicBehavior/contextManagement/sessionGuidance/requestUserContext/currentDate/gitContext。读懂它就读懂了"模型收到的上下文是怎么来的"。 |
| **`src/prompts/task-behavior.ts`** | 6.2 KB | 还原 **Task Behavior** 提示全文（原始 `d2o` 数组）。另一套行为准则（区别于 identity 的 "# Harness"），指导任务执行风格：仓库探索、证据优先、变更范围、失败处理等。100% 无损原文。 |

### 3.3 工具系统（src/tools/，2 个文件）

| 文件 | 大小 | 作用 |
|---|---|---|
| **`src/tools/capability.ts`** | 5.9 KB | **工具能力模型**。定义 `ToolCapability` 接口——每个工具的 8 维描述：metadata（名称/只读/破坏性/并发/超时/风险/需批准）、handler、input/outputSchema、permission（级别/原因/风险/副作用/patternSources）、resultBudget、timeout、cancellation、trace。还定义 8 种 `PermissionLevel`（read/edit/bash/mcp/skill/subagent/webfetch/websearch）和各类 Port 接口（文件/执行/技能/子agent/图片）。 |
| **`src/tools/registry.ts`** | 23.8 KB | **14 个内置工具的完整定义**。每个工具含完整描述（无损原文，逐字提取自 bundle 的字符串字面量）+ JSON Schema 形状的 inputSchema + 权限级别 + 风险评级。涵盖 Read/Write/Edit/Bash/Glob/Grep/Agent/Skill/TodoRead/TodoWrite/EnterPlanMode/ExitPlanMode/AskUserQuestion/ReadSessionContext。还含 `EXPLORE_AGENT_TOOLS`（子 Agent 可用工具子集）。 |

### 3.4 权限系统（src/permissions/，1 个文件）

| 文件 | 大小 | 作用 |
|---|---|---|
| **`src/permissions/permission-service.ts`** | 12.0 KB | **Harness 安全模型的核心**（还原原始 `E0` 类 @576736）。`checkPermission()` 在每个工具调用执行前判定 allow/ask/deny。含 10 种 `SessionMode` 枚举、11 级优先级决策链（yolo→auto→黑名单→项目deny→项目ask→plan→项目allow→白名单→edit→build）、build 模式的风险梯度、项目权限规则匹配（含 `"prefix:*"` 通配与 glob）。读懂它就读懂了"为什么 Bash 要问我确认而 Read 不用"。 |

### 3.5 技能系统（src/skills/，1 个文件）

| 文件 | 大小 | 作用 |
|---|---|---|
| **`src/skills/skill-adapter.ts`** | 10.7 KB | **技能发现与加载器**（还原原始 `mSe` 类 `NodeSkillAdapter`）。按优先级扫描技能根目录（用户级→项目级→插件缓存），解析每个 `SKILL.md` 的 YAML-like frontmatter（仅识别 name/description/when_to_use/license/metadata），同名技能按优先级去重。`loadSkill()` 读取正文（超 100KB 截断）并剥离 frontmatter。**这正是本会话可用的 docx/pdf/skill-creator 技能的来源机制。** |

### 3.6 运行时与主循环（src/runtime/，2 个文件）

| 文件 | 大小 | 作用 |
|---|---|---|
| **`src/runtime/agent-runtime.ts`** | 17.2 KB | **Harness 的大脑**（还原原始 `yd` 类 @843577）。一个会话 = 一个 `AgentRuntime` 实例，装配所有组件（permissionService/toolScheduler/hookRunner/modelAdapter/各 Port）。`executeTurn()`（原始 `Ckt` @771670）是主循环入口，完整还原了单轮流程：SessionStart 钩子→UserPromptSubmit 钩子→记忆注入→附件解析→模型步进循环→TurnComplete→持久化→记忆记录。含斜杠命令分流（/compact、/rewind）。 |
| **`src/runtime/model-step-loop.ts`** | 6.0 KB | **模型"思考-行动-观察"循环**（还原原始 `hkt` @773000）。反复向模型发送 messages，执行返回的 tool_call，直到模型不再调用工具。每步含：自动 compact 检测、重复工具调用检测（防死循环）、并发调度、Stop 钩子。同时定义单个工具调用的权限决策流程（allow→执行 / ask→请求用户 / deny→拒绝）。 |

### 3.7 RPC 接口（src/rpc/，1 个文件）

| 文件 | 大小 | 作用 |
|---|---|---|
| **`src/rpc/methods.ts`** | 4.6 KB | **Harness 对外的完整 API 表**（还原原始 `Xt` 对象 @~6893000）。列出全部 RPC 方法（session/create、session/send、interaction/requestPermission 等，39 个）。还含 `MODEL_PROVIDERS` 枚举（claude/opencode/gemini/codex/glm 5 种后端）和会话持久化数据结构（`PersistedMessage` / `SessionTask`）。这是前端/CLI 与 Harness 通信的契约。 |

---

## 四、原始代码片段（docs/，48 个文件）

这些是从 `zcode.cjs` 直接切片的**无损原文片段**，按用途分三组。它们是 `src/` 重建内容的**出处凭证**——每个 `src` 文件还原的内容都能在对应 `docs` 片段里找到原始混淆代码。

### 4.1 关键类与流程（docs/ 根目录，8 个）

| 文件 | 大小 | 作用 |
|---|---|---|
| **`docs/context_builder.txt`** | 6.0 KB | `ContextBuilder`（原始 `Qce`）类的原始混淆代码切片。`src/prompts/context-builder.ts` 的出处。 |
| **`docs/permission_service.txt`** | 3.8 KB | `PermissionService`（原始 `E0`）类切片。权限决策引擎原文。 |
| **`docs/turn_loop.txt`** | 6.0 KB | `executeTurn`（原始 `Ckt`）函数体切片。Agent 主循环原文。 |
| **`docs/task_behavior.txt`** | 5.5 KB | Task Behavior（原始 `d2o` 数组）全文切片。 |
| **`docs/tool_registry.txt`** | 5.5 KB | `AgentRuntime`（原始 `yd`）类装配区域切片，展示组件如何 wire 在一起。 |
| **`docs/skill_loader.txt`** | 3.5 KB | `NodeSkillAdapter`（原始 `mSe`）技能加载器切片。 |
| **`docs/mode_policy.txt`** | 3.5 KB | 会话模式相关的 zod schema 定义区域。 |
| **`docs/permission_gate.txt`** / **`docs/permission_window.txt`** | 4.0 KB 各 | 权限模式枚举（`zHn`）及 provider 枚举的定位窗口。 |

### 4.2 Prompt Section 窗口（docs/section_*.window.txt + after_*.txt，18 个）

| 文件 | 数量 | 作用 |
|---|---|---|
| **`docs/section_<source>.window.txt`** | 9 个 | 每个 prompt section 的 `name:"X",source:"Y"` 标记点**向前** 4 KB 的窗口，用于定位 section builder 函数和其依赖的字符串常量。覆盖全部 9 种 source：cli_prefix/identity/env_info/system_context/skills/memory/request_user_context/current_date/custom_system_prompt。 |
| **`docs/after_<source>.txt`** | 9 个 | 每个 section 标记点**向后** 6.5 KB 的窗口，捕获 builder 函数体和 helper。与 `section_*.window.txt` 配对使用。 |

### 4.3 工具片段（docs/tools/，22 个）

| 文件 | 数量 | 作用 |
|---|---|---|
| **`docs/tools/tool_<Name>.txt`** | 6 个 | 6 个核心工具（Read/Write/Edit/Bash/Glob/Grep）的完整 `capability` 对象切片（每个 2.2 KB），含 metadata/permission/resultBudget/timeout 等全部字段原文。 |
| **`docs/tools/descvar_<Name>.txt`** | 6 个 | 6 个核心工具的**描述变量**（原始 `t8r`/`_8r`/`J8r`/`T9r`/`j9r`/`F9r`）的赋值切片（每个 1.5 KB），即工具描述字符串的原始定义处。 |
| **`docs/tools/secondary_<Name>.txt`** | 8 个 | 8 个次级工具（Agent/Skill/TodoRead/TodoWrite/EnterPlanMode/ExitPlanMode/AskUserQuestion/ReadSessionContext）的定义窗口（每个 2 KB），通过描述片段关键词定位。 |
| **`docs/read_tool.txt`** | 1 个 | Read 工具 capability 块的扩展上下文（2.5 KB），展示完整 schema 结构范例。 |

---

## 五、打包文件（1 个）

| 文件 | 大小 | 作用 |
|---|---|---|
| **`harness.zip`** | 51.4 KB | （非逆向产物）一份工程的 zip 打包，可能是之前会话中生成的快照。 |

---

## 六、阅读建议

**第一次读**（建立全局认知）：
1. `README.md`（本文件）→ 了解每个文件干什么
2. `ARCHITECTURE.md` → 理解组件如何协作、数据怎么流动
3. `src/runtime/agent-runtime.ts` → 看主循环 `executeTurn()`

**深入某一子系统**：
| 想了解 | 读这些 |
|---|---|
| 模型收到的提示怎么来的 | `src/prompts/context-builder.ts` + `sections.ts` + `identity.ts` |
| 工具有哪些、怎么定义 | `src/tools/registry.ts` + `capability.ts` |
| 为什么有些操作要确认 | `src/permissions/permission-service.ts` |
| 技能怎么被发现加载 | `src/skills/skill-adapter.ts` |
| Agent 一步步怎么思考 | `src/runtime/model-step-loop.ts` |
| 前端怎么和 Harness 通信 | `src/rpc/methods.ts` |

**核对还原准确性**：每个 `src/` 文件头部标注了原始偏移，对照同名的 `docs/` 片段即可验证。

---

## 七、构建信息

| 项目 | 值 |
|---|---|
| 程序 | ZCode Desktop v3.0.1（Electron） |
| Harness 文件 | `resources/glm/zcode.cjs` |
| 文件大小 | 9,422,458 字节 / 2,666 行 |
| 打包方式 | esbuild bundle（CJS），`#!/usr/bin/env node` |
| 源构建路径（来自 `.node-bundle-meta.json`） | `apps/zcode-cli/packages/cli/dist/zcode.cjs` |
| 运行时 | electron-node |
| Schema 库 | zod |
| 重建验证 | 19/19 字符串交叉验证通过，13/13 TS 文件括号平衡通过 |
