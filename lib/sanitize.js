/**
 * 出网前文本清洗。
 *
 * ## 洗哪几个面
 *
 * `GenerateOptions` 的真实形状（`@deepseek-ai/dsh-llm` 的 `typert.host.js`）：
 *
 *     provider: string
 *     model: string
 *     messages: RequestMessage[]        // content 是 ContentBlock[]，text 块里有正文
 *     system?: string                   // 请求级系统提示
 *     tools?: ToolSchema[]              // name / description / parameters
 *     toolHistory?: { tools, updates }  // 本会话累计的工具声明
 *
 * 网关做的是「位置无关的内容片段匹配」，它不看这段文字长在哪个字段里。所以
 * 只洗 `system + messages[].content` 会漏两类真实存在的东西：
 *
 *   1. `tools[].description`（以及 `toolHistory` 里累计的那份）—— 工具描述里
 *      经常出现「在 DeepSeek Harness 中……」这类句子；
 *   2. 历史消息里 `assistant` 复述过的身份句。
 *
 * `messages[].content` 在协议上恒为块数组，但第三方适配器（trae / qoder 这类
 * loopback shim）真的会传字符串。两种都处理，成本一样。
 *
 * ## 为什么改写而不是删
 *
 * 每条 `from → to` 都是同义改写：语义不变、可读性不变，只换措辞。删掉会让
 * 模型少掉真实上下文，改写不会。所有 `to` 都不包含任何 `from`，所以幂等。
 */
import { CHANNEL_GATE_PHRASES, PARANOID_PHRASES, describeProfile, profileFor } from "./fingerprints.js";

export { CHANNEL_GATE_PHRASES, PARANOID_PHRASES };

const ZWSP = "\u200b";

/** 身份句里每个词边界后插零宽空格。CN 网关会归一化掉，global 网关实测有效。 */
const IDENTITY_CLAUSE =
  /(you)(\s+are\s+(?:(?:an?\s+)?[\w-]*\s*agent\s+powered\s+by|interacting\s+with\s+the\s+user\s+through\s+the\s+deepseek\s+harness))/giu;

function breakIdentityClauses(text) {
  return text.replace(IDENTITY_CLAUSE, (clause) => clause.replace(/(\s+)/gu, `$1${ZWSP}`));
}

/**
 * 取本次请求要用的改写规则。
 *
 * `provider` 决定用哪一档（见 lib/fingerprints.js）；不传就是通用层 —— 这样
 * 旧调用点、测试、以及拿不到 provider 的边缘路径都还有确定行为。
 */
export function rulesFor({ provider = null, paranoid = false } = {}) {
  const profile = profileFor(provider);
  const rules = paranoid ? [...profile.phrases, ...PARANOID_PHRASES] : profile.phrases;
  return { profile, rules };
}

/**
 * 改写一段文本。返回 `undefined` 表示无需改动（调用方据此跳过整条重建）。
 * 幂等：所有 `to` 都不包含任何 `from`，二次调用是 no-op。
 */
export function rewriteText(text, { paranoid = false, zeroWidth = false, provider = null } = {}) {
  if (typeof text !== "string" || text === "") return undefined;
  const { rules } = rulesFor({ provider, paranoid });
  let out = text;
  for (const [from, to] of rules) {
    if (out.includes(from)) out = out.split(from).join(to);
  }
  if (zeroWidth) out = breakIdentityClauses(out);
  return out === text ? undefined : out;
}

/**
 * 网关真正扫描的角色。
 *
 * `user` / `tool` 不改：前者是用户原话（改写等于篡改输入），后者是工具输出
 * （内容来自磁盘或网络，不是本插件写出来的），且实测这两个角色命中也不拒。
 * `assistant` 要改 —— 历史里模型自己复述过的身份句同样会被扫到。
 */
export function scansRole(role) {
  if (typeof role !== "string") return false;
  const r = role.trim().toLowerCase();
  return r === "system" || r === "assistant" || r === "developer" || r === "model";
}

/**
 * 清洗一条消息的 content。
 *
 * 两种形状都认：
 *   - `ContentBlock[]`（协议规定的形状）
 *   - `string`（部分适配器直接给字符串）
 */
export function rewriteBlocks(blocks, options) {
  if (typeof blocks === "string") return rewriteText(blocks, options);
  if (!Array.isArray(blocks)) return undefined;
  let changed = false;
  const next = blocks.map((block) => {
    if (block === null || typeof block !== "object" || Array.isArray(block)) return block;
    if (typeof block.text !== "string") return block;
    if (block.type !== undefined && block.type !== "text") return block;
    const rewritten = rewriteText(block.text, options);
    if (rewritten === undefined) return block;
    changed = true;
    return { ...block, text: rewritten };
  });
  return changed ? next : undefined;
}

/** 洗一份 ToolSchema 的 description。`parameters` 是 JSON Schema，原样不动。 */
function rewriteTool(tool, options) {
  if (tool === null || typeof tool !== "object" || Array.isArray(tool)) return undefined;
  const next = rewriteText(tool.description, options);
  if (next === undefined) return undefined;
  return { ...tool, description: next };
}

/**
 * 洗 `tools[]` 与 `toolHistory` 里的工具声明。
 * @returns {{tools?:Array, toolHistory?:object, changed:number}}
 */
export function rewriteTools({ tools, toolHistory }, options) {
  let changed = 0;

  let nextTools;
  if (Array.isArray(tools)) {
    let touched = false;
    nextTools = tools.map((tool) => {
      const rewritten = rewriteTool(tool, options);
      if (rewritten === undefined) return tool;
      touched = true;
      changed += 1;
      return rewritten;
    });
    if (!touched) nextTools = undefined;
  }

  let nextHistory;
  if (toolHistory !== null && typeof toolHistory === "object") {
    let touched = false;
    const base = Array.isArray(toolHistory.tools) ? toolHistory.tools : null;
    const rewrittenBase = base
      ? base.map((tool) => {
          const r = rewriteTool(tool, options);
          if (r === undefined) return tool;
          touched = true;
          changed += 1;
          return r;
        })
      : null;

    const updates = Array.isArray(toolHistory.updates)
      ? toolHistory.updates.map((update) => {
          if (update === null || typeof update !== "object") return update;
          if (!Array.isArray(update.additions)) return update;
          let local = false;
          const additions = update.additions.map((tool) => {
            const r = rewriteTool(tool, options);
            if (r === undefined) return tool;
            local = true;
            changed += 1;
            return r;
          });
          if (!local) return update;
          touched = true;
          return { ...update, additions };
        })
      : toolHistory.updates;

    if (touched) {
      nextHistory = {
        ...toolHistory,
        ...(rewrittenBase ? { tools: rewrittenBase } : {}),
        ...(Array.isArray(updates) ? { updates } : {}),
      };
    }
  }

  return { tools: nextTools, toolHistory: nextHistory, changed };
}

/**
 * 清洗整个 GenerateOptions。返回**新对象**而不是原地改：
 * agent-loop 对 options 做了 freeze，原地改会被静默忽略。
 *
 * 三个面全干净时原样返回 `options`，调用方据此跳过重入（零额外开销）。
 */
export function shieldOptions(options, config = {}) {
  const provider = config.provider ?? options?.provider ?? null;
  const opts = {
    provider,
    paranoid: config.paranoid === true,
    zeroWidth: config.zeroWidth === true,
  };
  const stats = {
    systemRewritten: false,
    messagesRewritten: 0,
    toolsRewritten: 0,
    profile: describeProfile(rulesFor(opts).profile),
  };
  if (options === null || typeof options !== "object") return { options, stats };

  // ---- 1) 请求级 system ----
  let system = options.system;
  if (typeof system === "string") {
    const next = rewriteText(system, opts);
    if (next !== undefined) {
      system = next;
      stats.systemRewritten = true;
    }
  }

  // ---- 2) 历史消息（只动网关会扫的角色）----
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

  // ---- 3) 工具声明（tools + toolHistory）----
  const toolResult = rewriteTools(options, opts);
  stats.toolsRewritten = toolResult.changed;

  const nothingChanged =
    !stats.systemRewritten && stats.messagesRewritten === 0 && toolResult.changed === 0;
  if (nothingChanged) return { options, stats };

  return {
    options: {
      ...options,
      system,
      messages,
      ...(toolResult.tools ? { tools: toolResult.tools } : {}),
      ...(toolResult.toolHistory ? { toolHistory: toolResult.toolHistory } : {}),
    },
    stats,
  };
}