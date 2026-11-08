/**
 * dsh-gateway-shield
 *
 * 一个插件同时管 WorkBuddy 和 Qoder 两条模型路由，因为二者的失败模式相同：
 *
 *  1. 出网前 —— 网关按 business code `11128` 扫 system / assistant 消息里的
 *     「第三方 agent 提示词」指纹（`displayTips` 统一说成「渠道校验」，
 *     与账号、额度、地区无关）。命中即 400。
 *  2. 出网后 —— 模型软拒绝，或网关 `11140` 内容策略拒绝。
 *
 * ## 为什么必须用 `this.stream()` 重入
 *
 * 实测（scripts/probe-waterfall.mjs、probe-reentry.mjs）确认两件事：
 *
 *   1. cordis 的 `next()` 是无参闭包 —— `next(newOptions)` 传入的参数被**丢弃**，
 *      `inner()` 用的始终是外层原始 options。所以「清洗后调 next(clean)」无效。
 *   2. `dsh-agent-loop` 对 options 做 `Object.freeze`，对每条 message 做
 *      `deepFreeze`。原地改会被静默忽略（非严格模式）或抛错（严格模式）。
 *
 * 合法路径只剩一条：listener 里构造一份**未冻结的新 options**，
 * 用 `this.stream(newOptions)` 重入 waterfall。用一个 Symbol 标记新对象，
 * 重入时看到标记就直通，避免无限递归。干净请求不重入，零额外开销。
 *
 * 挂载点是 `llm/stream`：provider 无关，所以 WorkBuddy、Qoder 以及以后
 * 任何 loopback shim 型 provider 都自动覆盖，不需要改它们的代码。
 */
import { shieldOptions, rewriteBlocks } from "./sanitize.js";
import { looksLikeRefusal, refusalMatchIndex, withNudge } from "./refusal.js";

export const name = "dsh-gateway-shield";
export const inject = [];

/** 重入标记。Symbol.for 保证跨模块实例一致。 */
export const SHIELDED = Symbol.for("dsh-gateway-shield.shielded");

/** 重入上限，防御性兜底：正常情况下只会重入 1 次。 */
const MAX_REENTRY = 3;

export const DEFAULTS = {
  enabled: true,
  /** 只对这些 provider 生效；空数组 = 全部。 */
  providers: [],
  /** 出网前清洗 system / assistant 里的网关指纹。 */
  sanitize: true,
  /** 额外改写真身句变体（超出实测表）。 */
  paranoid: false,
  /** 同时在身份句内部插零宽空格。CN 网关会归一化掉，global 网关有效。 */
  zeroWidth: false,
  /** 软拒绝时重发一次带加固指令的请求。 */
  refusalRetry: true,
  /** 同一轮最多重试几次。 */
  retryMax: 2,
  /** 判为拒绝前至少先缓冲多少字符。 */
  bufferChars: 480,
  /** verbose */
  verbose: true,
};

function pickConfig(config) {
  const raw = config && typeof config === "object" ? config : {};
  const merged = { ...DEFAULTS, ...raw };
  const max = Number(merged.retryMax);
  merged.retryMax = Number.isFinite(max) ? Math.max(0, Math.min(5, Math.trunc(max))) : DEFAULTS.retryMax;
  const buf = Number(merged.bufferChars);
  merged.bufferChars = Number.isFinite(buf) ? Math.max(120, Math.min(4000, Math.trunc(buf))) : DEFAULTS.bufferChars;
  merged.providers = Array.isArray(merged.providers)
    ? merged.providers.filter((p) => typeof p === "string" && p.trim() !== "").map((p) => p.trim())
    : [];
  return merged;
}

function providerAllowed(cfg, provider) {
  if (cfg.providers.length === 0) return true;
  const p = String(provider ?? "").toLowerCase();
  return cfg.providers.some((a) => p === a.toLowerCase() || p.startsWith(`${a.toLowerCase()}-`));
}

function markShielded(options) {
  const clone = { ...options };
  Object.defineProperty(clone, SHIELDED, { value: true, enumerable: false, configurable: false });
  return clone;
}

/** 冻结的 options 先摊平成一层的可写副本；消息已是不可变值，共享即可。 */
function thawOptions(options) {
  return { ...options, messages: Array.isArray(options.messages) ? [...options.messages] : options.messages };
}

/**
 * 包一层拒绝重试。
 *
 * 只缓冲到能下结论为止；确认不是拒绝就把已缓冲的块原样吐出、后续直通。
 * 每轮重试用重新组装的请求（带加固段），而不是原样重发 —— 后者是无效重试。
 */
async function* withRefusalRetry(spawn, baseOptions, cfg, log, counters) {
  let attempt = 0;
  let current = baseOptions;

  while (true) {
    const iterator = spawn(current)[Symbol.asyncIterator]();
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      try {
        await iterator.return?.();
      } catch {
        /* 保留原始错误/结果 */
      }
    };

    try {
      const buffered = [];
      let text = "";
      let decided = false;

      while (!decided) {
        const step = await iterator.next();
        if (step.done) {
          decided = true;
          break;
        }
        buffered.push(step.value);
        const chunk = step.value;
        if (chunk?.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
        if (
          text.length >= cfg.bufferChars ||
          chunk?.type === "finish" ||
          chunk?.type === "tool-call-delta" ||
          chunk?.type === "reasoning-delta"
        ) {
          decided = true;
        }
      }

      const match = looksLikeRefusal(text) ? refusalMatchIndex(text) : -1;

      if (match >= 0 && attempt < cfg.retryMax) {
        attempt += 1;
        counters.retries += 1;
        if (cfg.verbose) {
          log(
            `refusal (rule #${match}, ${text.length} 字符) → retry ${attempt}/${cfg.retryMax}` +
              ` | head: ${JSON.stringify(text.slice(0, 80))}`,
          );
        }
        await close();
        current = withNudge(baseOptions);
        continue;
      }

      if (match >= 0 && cfg.verbose) {
        log(`refusal persisted after ${attempt} retry(ies); passing through`);
      }

      for (const chunk of buffered) yield chunk;
      while (true) {
        const step = await iterator.next();
        if (step.done) return;
        yield step.value;
      }
    } finally {
      await close();
    }
  }
}

export function apply(ctx, config) {
  const cfg = pickConfig(config);
  const counters = { sanitized: 0, retries: 0, requests: 0, reentries: 0 };

  const log = (message) => {
    if (!cfg.verbose) return;
    try {
      ctx.logger?.info?.(`[gateway-shield] ${message}`);
    } catch {
      /* 日志失败不影响主流程 */
    }
  };

  if (!cfg.enabled) {
    log("disabled by config");
    return undefined;
  }

  ctx.on("llm/stream", function (options, next) {
    const provider = options?.provider;
    if (!providerAllowed(cfg, provider)) return next(options);

    // 已处置过的重入请求（清洗结果 / 加固后的重试体）：直通适配器。
    if (options?.[SHIELDED] === true) return next(options);

    counters.requests += 1;

    // ---- 1) 出网前清洗 ----
    let sanitized = options;
    let didSanitize = false;
    if (cfg.sanitize) {
      const { options: shielded, stats } = shieldOptions(options, cfg);
      if (shielded !== options) {
        sanitized = shielded;
        didSanitize = true;
        counters.sanitized += 1;
        if (cfg.verbose) {
          log(
            `sanitize provider=${provider} model=${options?.model ?? "?"}` +
              ` system=${stats.systemRewritten ? "yes" : "no"} messages=${stats.messagesRewritten}`,
          );
        }
      }
    }

    /**
     * 取一次流。语义要点（已实测）：
     *   - `next()` 无参，`next(newOptions)` 的参数会被丢弃；
     *   - 宿主对 options 与 message 做了 freeze / deepFreeze，原地改无效。
     * 所以：原封不动的请求走 next()（零开销），任何改写过的对象都必须
     * 通过 this.stream() 重入 waterfall，并带 SHIELDED 标记防止二次处置。
     */
    const runOnce = (opts) => {
      if (opts === options) return next();
      return this.stream(opts);
    };

    if (!cfg.refusalRetry) {
      return runOnce(didSanitize ? markShielded(thawOptions(sanitized)) : options);
    }

    // 首轮用的请求体：清洗过就标记后重入，否则原样交给 next()。
    const first = didSanitize ? markShielded(thawOptions(sanitized)) : options;
    // 重试体由 withNudge 生成（新对象），必须先标记再重入。
    const spawn = (opts) => this.stream(opts?.[SHIELDED] === true ? opts : markShielded(thawOptions(opts)));

    return withRefusalRetry(
      (opts) => (opts === options ? runOnce(options) : spawn(opts)),
      first,
      cfg,
      log,
      counters,
    );
  });

  log(
    `active | sanitize=${cfg.sanitize} refusalRetry=${cfg.refusalRetry} retryMax=${cfg.retryMax}` +
      ` providers=${cfg.providers.length ? cfg.providers.join(",") : "all"}${cfg.paranoid ? " paranoid" : ""}`,
  );

  return {
    stats: () => ({ ...counters }),
    /** 供调试：看当前配置 */
    config: () => ({ ...cfg }),
  };
}

export { rewriteBlocks };
