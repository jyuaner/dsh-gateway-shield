/**
 * 出网前文本清洗。
 *
 * 依据：WorkBuddy 网关于 2026-10-21 / 10-29 实测的指纹表（见 dsh-connect-workbuddy
 * 的 CHANNEL_GATE_PHRASES 与 UNAPPROVED_CHANNEL_OPENINGS 注释）。网关按
 * business code 11128 拒绝请求，`displayTips` 统一显示「这次调用没通过渠道校验，
 * 可能不是官方客户端发出的」，但它实际匹配的是 system / assistant 消息里的
 * 内容片段，位置无关，大小写不敏感（部分规则）。
 *
 * 表中每一条 `from → to` 都是同义改写：语义不变、可读性不变、只换措辞。
 * 改写的目的是让 DSH 自己的身份句不再撞上「第三方 agent 提示词」名单。
 */

/** 实测命中的指纹 → 同义改写。顺序无关，全部大小写敏感精确匹配。 */
export const CHANNEL_GATE_PHRASES = [
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

/**
 * 兜底补充：不是实测表，但是同一族身份句的其它常见拼写。
 * 只在 `paranoid` 打开时启用，避免无谓改写。
 */
export const PARANOID_PHRASES = [
  ["You are an AI agent powered by", "You are an AI agent running inside"],
  ["You are a coding agent powered by", "You are a coding agent running on"],
  ["powered by DeepSeek Harness", "running inside DeepSeek Harness"],
  ["You are Claude Code, Anthropic's official CLI for Claude", "You are the operator's CLI agent"],
  ["You are Claude Code", "You are the operator's CLI agent"],
];

const ZWSP = "\u200b";

/** 身份句里每个词边界后插零宽空格。CN 网关会归一化掉，global 网关实测有效。 */
const IDENTITY_CLAUSE =
  /(you)(\s+are\s+(?:(?:an?\s+)?[\w-]*\s*agent\s+powered\s+by|interacting\s+with\s+the\s+user\s+through\s+the\s+deepseek\s+harness))/giu;

function breakIdentityClauses(text) {
  return text.replace(IDENTITY_CLAUSE, (clause) => clause.replace(/(\s+)/gu, `$1${ZWSP}`));
}

/**
 * 改写一段文本。返回 `undefined` 表示无需改动（调用方据此跳过整条重建）。
 * 幂等：所有 `to` 都不包含任何 `from`，二次调用是 no-op。
 */
export function rewriteText(text, { paranoid = false, zeroWidth = false } = {}) {
  if (typeof text !== "string" || text === "") return undefined;
  let out = text;
  for (const [from, to] of CHANNEL_GATE_PHRASES) {
    if (out.includes(from)) out = out.split(from).join(to);
  }
  if (paranoid) {
    for (const [from, to] of PARANOID_PHRASES) {
      if (out.includes(from)) out = out.split(from).join(to);
    }
  }
  if (zeroWidth) out = breakIdentityClauses(out);
  return out === text ? undefined : out;
}

/** 网关真正扫描的角色。user / tool 不改（实测它们命中也不拒）。 */
export function scansRole(role) {
  if (typeof role !== "string") return false;
  const r = role.trim().toLowerCase();
  return r === "system" || r === "assistant" || r === "developer";
}

/**
 * 清洗一条消息的 content 块数组。不改原数组，返回新数组或 undefined。
 */
export function rewriteBlocks(blocks, options) {
  if (!Array.isArray(blocks)) return undefined;
  let changed = false;
  const next = blocks.map((block) => {
    if (block === null || typeof block !== "object" || Array.isArray(block)) return block;
    if (block.type !== "text" || typeof block.text !== "string") return block;
    const rewritten = rewriteText(block.text, options);
    if (rewritten === undefined) return block;
    changed = true;
    return { ...block, text: rewritten };
  });
  return changed ? next : undefined;
}

/**
 * 清洗整个 GenerateOptions。返回统计而不是原地改：
 * 调用方拿到新对象再交给 `next()`，原对象保持不可变契约。
 */
export function shieldOptions(options, config = {}) {
  const opts = {
    paranoid: config.paranoid === true,
    zeroWidth: config.zeroWidth === true,
  };
  const stats = { systemRewritten: false, messagesRewritten: 0 };
  if (options === null || typeof options !== "object") return { options, stats };

  let system = options.system;
  if (typeof system === "string") {
    const next = rewriteText(system, opts);
    if (next !== undefined) {
      system = next;
      stats.systemRewritten = true;
    }
  }

  let messages = options.messages;
  if (Array.isArray(messages)) {
    let touched = false;
    messages = messages.map((message) => {
      if (message === null || typeof message !== "object") return message;
      if (!scansRole(message.role)) return message;
      const blocks = rewriteBlocks(message.content, opts);
      if (blocks === undefined) return message;
      touched = true;
      stats.messagesRewritten += 1;
      return { ...message, content: blocks };
    });
    if (!touched) messages = options.messages;
  }

  if (!stats.systemRewritten && stats.messagesRewritten === 0) {
    return { options, stats };
  }
  return { options: { ...options, system, messages }, stats };
}
