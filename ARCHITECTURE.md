# ZCode CLI Harness — 架构详解

本文档基于对 `resources/glm/zcode.cjs`（9.42 MB esbuild bundle）的逆向分析，
描述驱动 ZCode AI Agent 的 Harness（运行时外壳）的完整架构。

## 1. 总体分层

```
┌─────────────────────────────────────────────────────────────────┐
│  前端层（不在本 Harness 范围内）                                  │
│  Electron renderer (React) ←→ IPC ←→ main process               │
└──────────────────────────────┬──────────────────────────────────┘
                               │ RPC 方法（见 rpc/methods.ts）
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  CLI Harness（zcode.cjs，本工程重建对象）                         │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  AgentRuntime  (runtime/agent-runtime.ts)                │   │
│  │  一个会话 = 一个实例                                       │   │
│  │                                                            │   │
│  │  executeTurn(prompt) ── 主循环入口                         │   │
│  │    │                                                       │   │
│  │    ├─ ContextBuilder.build()  组装 system + user 消息      │   │
│  │    │     └─ 9~13 个 PromptSection（prompts/）             │   │
│  │    │                                                       │   │
│  │    ├─ hooks (SessionStart / UserPromptSubmit / Stop)      │   │
│  │    │                                                       │   │
│  │    ├─ runModelStepLoop()  ← runtime/model-step-loop.ts    │   │
│  │    │     循环：模型 → tool_call → 权限 → 执行 → 观察       │   │
│  │    │     │                                                 │   │
│  │    │     ├─ PermissionService.checkPermission()           │   │
│  │    │     │   10 模式 × 风险梯度 × 项目规则（permissions/） │   │
│  │    │     │                                                 │   │
│  │    │     ├─ ToolScheduler  并发调度（maxConcurrency）     │   │
│  │    │     │                                                 │   │
│  │    │     └─ ToolExecutor → 各 Tool.handler                │   │
│  │    │           ├─ FileSystemPort  (Read/Write/Edit/Glob)  │   │
│  │    │           ├─ ExecutionPort   (Bash)                  │   │
│  │    │           ├─ SkillPort      (Skill)                  │   │
│  │    │           ├─ SubagentPort   (Agent)                  │   │
│  │    │           ├─ McpPort        (MCP 外部工具)           │   │
│  │    │           └─ HttpClientPort (WebFetch/WebSearch)     │   │
│  │    │                                                       │   │
│  │    ├─ EventStore  持久化所有事件                           │   │
│  │    └─ SessionStore 持久化会话消息                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────┐  │
│  │ NodeSkillAdapter │  │  14 个内置工具    │  │ MCP 注册表    │  │
│  │ (skills/)        │  │  (tools/)        │  │ (动态加载)    │  │
│  └──────────────────┘  └──────────────────┘  └───────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## 2. 数据流：一次用户提问的完整路径

```
用户输入 "重构这个函数"
   │
   1│ RPC: session/send { prompt }
   ▼
   AgentRuntime.executeTurn(prompt)
   │
   2│ ensureContextInitialized()
   │  └─ ContextBuilder(config).build()
   │     组装顺序（@原始 orderSectionsForInjection）：
   │       system/stable:   cli_prefix → identity → [custom_system_prompt]
   │       system/dynamic:  dynamic_behavior → session_guidance → memory
   │                        → env_info → output_style → context_management
   │                        → system_context(git)
   │       meta_user:       skills → claudeMd → current_date
   │     产出：4~5 条消息（prefix/stable/dynamic 各一条 system，skills/context 各一条 user）
   ▼
   3│ runSessionStartHooks() → 注入额外上下文
   4│ runUserPromptSubmitHooks() → 可能阻止
   5│ injectRelevantMemoryFromTurn() → 检索项目记忆
   6│ addUserMessage(enrichedPrompt)
   ▼
   7│ runModelStepLoop()  ← 核心
   │  ┌─ 步骤 N ──────────────────────────────────────┐
   │  │ buildMessagesForModel()                        │
   │  │ callModel() → 流式返回 { text, toolCalls }     │
   │  │ for each toolCall:                             │
   │  │   decision = PermissionService.checkPermission │
   │  │   allow → executor.run(capability, input, ctx) │
   │  │   ask   → permissionBroker.requestPermission   │
   │  │             └─ RPC: interaction/requestPermission → 用户点"允许"│
   │  │   deny  → { denied: true, error }              │
   │  │ appendToolResultsToHistory()                   │
   │  └── 无 tool_call 则退出循环 ─────────────────────┘
   ▼
   8│ appendEvent(TurnComplete)
   9│ persistTurn() → SessionStore
  10│ recordExplicitMemoryFromTurn() → 更新项目记忆
  11│ rebuildProjection() → 返回给前端
   │
   ▼
RPC 返回：{ response, turnId, usage, events, projection }
```

## 3. 系统提示组装（ContextBuilder）

**关键洞察**：ZCode 不使用单一固定的系统提示，而是由 `ContextBuilder.build()`
动态拼装 **9~13 个可组合的 PromptSection**，每个 section 自带元数据：

| 字段 | 含义 |
|---|---|
| `source` | 唯一标识（cli_prefix / identity / env_info ...） |
| `injectionTarget` | `system`（拼成 system 消息）或 `meta_user`（拼成 user 消息） |
| `cacheHint` | `stable`（跨轮不变，可缓存）或 `dynamic`（随轮次变化） |
| `content` | 实际文本 |
| `chars` / `tokens` | 预算统计 |

最终 `assembleMessages()` 按 (injectionTarget, cacheHint) 分组拼成 4~5 条消息，
便于 provider 端的 prompt-cache 命中（stable 部分长期缓存）。

详见 `src/prompts/context-builder.ts`。

## 4. 工具系统

### 4.1 工具能力模型（capability）

每个工具是一个完整的 capability 对象，包含 8 个维度：

| 维度 | 字段 | 作用 |
|---|---|---|
| 能力 | `capability` | 一句话内部描述 |
| 元数据 | `metadata` | name/description/readOnly/destructive/concurrentSafe/timeoutMs/riskLevel/needsApproval |
| 执行 | `handler` | `(input, ctx) => result` |
| 校验 | `inputSchema` / `outputSchema` | zod schema |
| 权限 | `permission` | level/reason/riskLevel/sideEffectScope/patternSources/denyPriority |
| 预算 | `resultBudget` | maxInlineBytes/maxModelBytes/strategy/preview |
| 超时 | `timeout` | defaultMs/maxMs/allowCallOverride |
| 取消 | `cancellation` | supported/cleanup/userVisibleMessage |
| 追踪 | `trace` | required/propagateToAdapters/recordInput/recordOutput |

### 4.2 14 个内置工具

| 工具 | 权限级 | 风险 | 副作用范围 | 需批准 |
|---|---|---|---|---|
| Read | read | low | none | 否 |
| Glob | read | low | none | 否 |
| Grep | read | low | none | 否 |
| Write | edit | medium | workspace | 是 |
| Edit | edit | medium | workspace | 是 |
| Bash | bash | medium | external | 是 |
| Agent | subagent | low | session | 否 |
| Skill | skill | low | session | 否 |
| TodoRead | read | low | session | 否 |
| TodoWrite | read | low | session | 否 |
| EnterPlanMode | read | low | session | 否 |
| ExitPlanMode | read | low | session | 否 |
| AskUserQuestion | read | low | session | 否 |
| ReadSessionContext | read | low | none | 否 |

（WebFetch / WebSearch 在 bundle 中存在但通过 MCP/HTTP 端口注册，未在内置 capability 块中。）

### 4.3 工具筛选（@原始 X$ / OSt）

运行时根据配置动态决定哪些工具可见：
```js
configureRegistry(registry, {
  includeSkill: !!skillPort,
  includeAgent: !!subagentPort,
  includeSendMessage: !!sessionMailboxPort,
  includeWorkflow: !!workflowPort,
  includeExploreOnlyTools: config.toolset === "explore",
  allowedTools: resolveBuiltInToolAllowlist(config.toolAllowlist),
});
```
Explore 子 Agent 只能使用：`Read, Glob, Grep, Bash, WebFetch, WebSearch, TodoWrite`。

## 5. 权限系统（PermissionService）

### 5.1 10 种会话模式

| 模式 | 行为 |
|---|---|
| `default` / `build` | 按风险梯度判定（只读 allow；critical/high ask；有副作用 ask） |
| `yolo` | 跳过所有权限提示（全部 allow） |
| `plan` | 只读且非破坏才 allow，其余 deny |
| `edit` / `acceptEdits` | 文件编辑类（edit×workspace）自动 allow，其余走 build |
| `auto` | 保留但未实现（返回 deny） |
| `dontAsk` / `bypassPermissions` / `autoEdit` | 策略变体 |

### 5.2 决策优先级链（@原始 checkPermission）

```
1. 工具 requiresUserInteraction      → ask
2. disallowedTools 黑名单             → deny
3. mode === "yolo"                   → allow
4. mode === "auto"                   → deny（未实现）
5. 项目 deny 规则                     → deny
6. 项目 ask 规则                      → ask
7. mode === "plan"                   → 只读非破坏 allow / 否则 deny
8. 项目 allow 规则                    → allow
9. 全局 allowedTools 白名单           → allow
10. mode === "edit"                  → edit×workspace allow / 否则 build
11. mode === "build"(默认)           → checkBuildMode（风险梯度）
```

### 5.3 build 模式的风险梯度（@原始 checkBuildMode）

```
readOnly && !destructive && !needsApproval           → allow（"mode.build.readOnly"）
riskLevel === "critical"                             → ask（"mode.build.criticalRisk"）
riskLevel === "high" && !autoApproveHighRisk         → ask（"mode.build.highRisk"）
sideEffect==="session" && low && !destructive && !needsApproval → allow（"mode.build.sessionState"）
needsApproval || destructive || sideEffect!=="none"  → ask（"mode.build.sideEffect"）
其余                                                  → allow（"mode.build.lowRisk"）
```

### 5.4 项目权限规则匹配（@原始 matchesRule）

规则形如 `{ toolName: "Bash", ruleContent: "git commit:*" }`：
- `toolName` 匹配（Write 规则也匹配 Edit）
- `ruleContent` 支持 `"prefix:*"`（前缀+空格/Tab）与 glob 通配
- 主题字段按工具取：Bash→command、WebFetch→url(域名+url)、Read/Write→file_path、Glob→pattern...

## 6. 技能系统（NodeSkillAdapter）

### 6.1 发现

按优先级扫描技能根目录：
1. 用户级 `~/.zcode/skills/`
2. 项目级 `./.zcode/skills/`
3. 插件缓存 `~/.zcode/cli/plugins/cache/`

每个根目录下，每个**子目录**若含 `SKILL.md` 即视为一个技能。同名技能按优先级去重（先到先得）。

### 6.2 SKILL.md 格式

```markdown
---
name: docx
description: 完整的 DOCX 文档创建、编辑与分析能力...
when_to_use: 适用于创建新文档、修改内容...
license: MIT
metadata: ...
---
# 正文（给模型执行的指令）
```

frontmatter 仅识别 5 个键：`name` / `description` / `when_to_use` / `license` / `metadata`。
解析为 `ParsedSkill`，在系统提示的 `skills` section 中列出。

### 6.3 加载

`loadSkill({ name })` 读取对应 `SKILL.md`（超 100KB 截断），剥离 frontmatter 返回正文。

## 7. 会话与持久化

### 7.1 RPC 方法（@原始 Xt）

完整 API 见 `src/rpc/methods.ts`。核心分组：
- 会话：create / resume / send / steer / stop / compact / rewind / fork / setMode / setModel
- 工作区：readState / 模型提供商管理
- 插件：list / setEnabled
- 交互：requestPermission / requestUserInput（前端 ↔ Harness 的权限对话）

### 7.2 持久化结构（@原始 lQn）

每条消息含：role/content/timestamp/model/tools[]/thought/parts[]/turnIndex。
每个工具调用快照：toolName/status(completed|failed|denied)/input/output/error。

### 7.3 模型提供商

5 种后端：`claude` / `opencode` / `gemini` / `codex` / `glm`。通过 ModelAdapter 抽象统一接口。

## 8. 钩子系统（Hooks）

三类钩子可在工具执行前后注入逻辑或额外上下文：
- `SessionStart`（turn 开始时，注入 additionalContexts）
- `UserPromptSubmit`（可 preventContinuation 阻止本轮）
- `Stop`（可 forceContinue 强制继续）

钩子输出被视为"系统提供的上下文"（非用户原话）。

## 9. 与桌面端的关系

`zcode.cjs` 是纯 CLI Harness（无 Electron 依赖，`#!/usr/bin/env node`）。
桌面端 `app.asar` 的 `out/host` 通过子进程/RPC 调用此 CLI（也直接内嵌了相同 runtime 代码）。
`.node-bundle-meta.json` 指明源构建路径 `apps/zcode-cli/packages/cli/dist/zcode.cjs`，
表明这是 monorepo 中 `@zcode/cli` 包的产物。

## 10. 字节偏移索引（回溯核对用）

| 内容 | zcode.cjs 偏移 |
|---|---|
| CLI Prefix（vRr） | ~211101 |
| Identity / Harness 准则（yRr） | ~211150 |
| 9 个 section 的 `name:..,source:..` | 210915–222225 |
| ContextBuilder 类（Qce） | ~221636 |
| Task Behavior（d2o） | ~223xxx |
| Read 工具 capability（lgt） | ~302000 |
| Write 工具 | ~306000 |
| Edit 工具 | ~321000 |
| Bash 工具 | ~401000 |
| Glob 工具（s2t） | ~403000 |
| Grep 工具 | ~407000 |
| Agent 工具（K2t） | ~431000 |
| Skill 工具 | ~435000 |
| TodoRead / TodoWrite | ~437000–439000 |
| EnterPlanMode（t_t） / ExitPlanMode | ~440000–444000 |
| AskUserQuestion | ~450000 |
| ReadSessionContext | ~469000 |
| 权限模式枚举（zHn） | ~6895354 |
| PermissionService（E0） | ~576736 |
| NodeSkillAdapter（mSe） | ~（skill_loader.txt） |
| AgentRuntime（yd） | ~843577 |
| executeTurn（Ckt） | ~771670 |
| RPC 方法表（Xt） | ~6893000 |
