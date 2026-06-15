/**
 * ZCode CLI Harness — 可读源码重建索引
 * ============================================================================
 * 本目录是对 `resources/glm/zcode.cjs`（9.42MB esbuild bundle）的架构级重建。
 *
 * 重建原则：
 *   - 字符串内容（系统提示、工具描述、权限规则、错误消息）**100% 无损**，逐字提取
 *   - 类型/接口/常量**忠实还原**（zod schema 用 JSON Schema 形状表达）
 *   - 函数体给出**签名 + 流程注释**，复杂内部用伪代码骨架标注原始变量名
 *   - 每个文件头部标注原始 bundle 中的字节偏移，便于核对
 *
 * 字节偏移是相对于 zcode.cjs 文件起始的字符偏移（非字节，因 JS 字符串）。
 */
export * from "./prompts/sections";
export * from "./prompts/identity";
export * from "./prompts/dynamic-sections";
export * from "./prompts/context-builder";
export * from "./prompts/task-behavior";

export * from "./tools/capability";
export * from "./tools/registry";

export * from "./permissions/permission-service";

export * from "./skills/skill-adapter";

export * from "./runtime/agent-runtime";
export * from "./runtime/model-step-loop";

export * from "./rpc/methods";
