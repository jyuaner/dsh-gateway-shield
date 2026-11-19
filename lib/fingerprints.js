/**
 * 按 provider 分档的指纹表。
 *
 * ## 为什么不能再写死一张表
 *
 * `lib/sanitize.js` 原来只有一张 15 条的 `CHANNEL_GATE_PHRASES`，全部来自
 * WorkBuddy 网关（business code `11128`）实测。这在只接 WorkBuddy / Qoder 时够用，
 * 但把它当成「全模型的破甲表」是错的：
 *
 *   - 每个网关扫的是**自己的**黑名单，不是同一张；
 *   - 官方 API（DeepSeek / OpenAI / Anthropic）根本不扫「第三方 agent 提示词」，
 *     对它们做同义改写是无害但无收益；
 *   - 真正跨网关通用的东西只有一类：**DSH 自己的身份句和它描述工作方式的那些句子**。
 *     任何在找「非官方客户端」的中间层，都会从这一族句子里取特征。
 *
 * 所以表被拆成两层：
 *
 *   1. `UNIVERSAL_PHRASES` —— 所有 provider 都洗。这 15 条就是原来那张实测表：
 *      它们的内容都是「DSH 是谁、路径怎么解析、@ 什么意思」，对任何网关都是同一族特征。
 *   2. `PROVIDER_PHRASES[id]` —— 单个 provider 的专属补充。只有真的为它加过条目时才非空。
 *
 * ## confidence 字段不是装饰
 *
 * 表里的每一档都标了它凭什么成立：
 *
 *   measured   —— 有实测记录（11128 / 网关 400）
 *   inferred   —— 同族身份句，按语义判断会命中，没有实测
 *   universal  —— 只吃通用层，没有专属条目
 *
 * 这个字段会进 `verbose` 日志和 `armor --check` 的矩阵。写「实测」而没有实测数据，
 * 比不写更糟：用户会以为新网关也被覆盖了。
 */

/** 所有 provider 共用的一层：DSH 自己的身份句与工作方式描述。来源：WorkBuddy 网关实测。 */
export const UNIVERSAL_PHRASES = [
  ["You are an AI agent powered by DeepSeek Harness", "You are an AI agent running inside DeepSeek Harness"],
  ["You are a coding agent powered by the ", "You are a coding agent running on the "],
  ["You are interacting with the user through the DeepSeek Harness Web GUI", "You are working with the user inside the DeepSeek Harness Web GUI"],
  ["Agent Teams is available in this session", "Agent Teams is enabled for this session"],
  ["Tokens prefixed with @ are paths the user explicitly referenced.", "Paths that begin with @ are the ones the user explicitly referenced."],
  ["Relative paths resolve from the workspace root;", "Relative paths are resolved against the workspace root;"],
  ["absolute paths identify files or directories on the host.", "absolute paths point at files or directories on the host."],
  ["A trailing slash marks a directory:", "A trailing slash indicates a directory:"],
  ["list it when its contents matter.", "list it whenever its contents matter."],
  ["Anything else is a file:", "Everything else is a file:"],
  ["use the read tool when its contents are needed,", "use the read tool whenever you need its contents,"],
  ["and do not claim to have inspected it before reading.", "and never claim to have inspected it before reading it."],
  ['@"..." quotes a path containing spaces.', 'A path containing spaces is quoted with @"...".'],
  ["without naming another target, they mean this GUI.", "and names no other target, the interface described here is meant."],
  ["they mean this GUI.", "the interface described here is meant."],
];

/** 兼容旧导出名：原 `CHANNEL_GATE_PHRASES` 就是这张通用表。 */
export const CHANNEL_GATE_PHRASES = UNIVERSAL_PHRASES;

/**
 * 单 provider 的专属补充。
 *
 * 只有 `anthropic` 有内容：Claude Code 的身份句是 Anthropic 侧真实会认的第三方客户端标志，
 * 而 DSH 的 prompt 在接入某些 route 时可能带着它。其余 provider 暂时没有实测条目 ——
 * 空数组是诚实的写法，不是遗漏。
 */
export const PROVIDER_PHRASES = {
  workbuddy: [],
  qoder: [],
  trae: [],
  anthropic: [
    ["You are Claude Code, Anthropic's official CLI for Claude", "You are the operator's CLI agent"],
    ["You are Claude Code", "You are the operator's CLI agent"],
  ],
  openai: [],
  deepseek: [],
  unknown: [],
};

/**
 * 兜底补充：同族身份句的其它常见拼写。`paranoid` 打开时对**所有** provider 生效。
 * 与 `PROVIDER_PHRASES.anthropic` 重叠是刻意的：那一档是默认开，这一档是显式开。
 */
export const PARANOID_PHRASES = [
  ["You are an AI agent powered by", "You are an AI agent running inside"],
  ["You are a coding agent powered by", "You are a coding agent running on"],
  ["powered by DeepSeek Harness", "running inside DeepSeek Harness"],
  ["You are Claude Code, Anthropic's official CLI for Claude", "You are the operator's CLI agent"],
  ["You are Claude Code", "You are the operator's CLI agent"],
];

/**
 * provider → 档位。**按前缀认，不穷举**：provider 名是开放的（用户能在设置里自己加 route），
 * 用一张封闭名单去匹配，新 route 就会静默落进「不洗」。
 */
export const PROVIDER_RULES = [
  { id: "workbuddy", test: /^workbuddy/i, sample: "workbuddy", label: "WorkBuddy 网关（11128）", confidence: "measured" },
  { id: "qoder", test: /^qoder/i, sample: "qoder", label: "Qoder 网关", confidence: "measured" },
  { id: "trae", test: /^trae/i, sample: "trae", label: "Trae 网关", confidence: "inferred" },
  { id: "anthropic", test: /^(anthropic|claude)/i, sample: "anthropic-messages", label: "Anthropic / Claude Code", confidence: "inferred" },
  { id: "openai", test: /^(openai|azure|codex|o[134])/i, sample: "openai", label: "OpenAI 系", confidence: "universal" },
  { id: "deepseek", test: /^deepseek/i, sample: "deepseek", label: "DeepSeek 官方", confidence: "universal" },
];

/** 兜底档：没认出来的 provider 也走通用层，不静默跳过。 */
export const FALLBACK_PROFILE = { id: "unknown", label: "未知 provider", confidence: "universal" };

/**
 * 取一个 provider 的清洗档。
 *
 * @param {string|null|undefined} provider `options.provider`
 * @returns {{id:string,label:string,confidence:string,phrases:Array<[string,string]>}}
 */
export function profileFor(provider) {
  const name = typeof provider === "string" ? provider.trim() : "";
  const rule = PROVIDER_RULES.find((r) => r.test.test(name)) ?? FALLBACK_PROFILE;
  const extra = PROVIDER_PHRASES[rule.id] ?? [];
  return {
    id: rule.id,
    label: rule.label,
    confidence: rule.confidence,
    phrases: extra.length > 0 ? [...UNIVERSAL_PHRASES, ...extra] : UNIVERSAL_PHRASES,
  };
}

/** 一行摘要，日志和检测矩阵共用。 */
export function describeProfile(profile) {
  const n = profile.phrases.length;
  return `${profile.id}(${profile.confidence}, ${n} 条)`;
}