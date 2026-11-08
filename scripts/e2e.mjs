/**
 * 端到端验证（真实 cordis + 真实 waterfall 语义）。
 *
 * 复刻 dsh-llm 的调用形态：
 *   ctx.waterfall(this, "llm/stream", frozenOptions, () => adapter(frozenOptions))
 * 这正是 LlmRuntime.streamWithRegistration 的实现，闭包锁定原始 options。
 *
 * 依赖 `@deepseek-ai/cordis`（peerDependency，DSH 环境里一定有）。
 * 找不到时退化为内置的最小实现，断言不变 —— 因为这里验证的是
 * 「next 无参 + options 冻结」这两个语义，而非 cordis 的某个具体版本。
 */

let Context;
let usingRealCordis = false;
try {
  ({ Context } = await import("@deepseek-ai/cordis"));
  usingRealCordis = true;
} catch {
  /** 与 cordis 语义一致的最小实现：next() 无参，inner 闭包持有 options。 */
  Context = class MockContext {
    constructor() {
      this.logger = { info() {}, warn() {}, error() {} };
      this.events = { _hooks: {} };
    }
    on(name, callback) {
      (this.events._hooks[name] ??= []).push({ callback });
    }
    waterfall(thisArg, name, options, inner) {
      const hooks = this.events._hooks[name] ?? [];
      let index = 0;
      const dispatch = () => {
        const hook = hooks[index++];
        if (!hook) return inner();
        let called = false;
        const next = () => {
          if (called) throw new Error("next() called multiple times");
          called = true;
          return dispatch();
        };
        return hook.callback.apply(thisArg, [options, next]);
      };
      return dispatch();
    }
  };
}

import { apply as applyShield } from "../lib/index.js";

const lines = [];
const check = (name, ok, detail = "") => {
  lines.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
  return ok;
};

const deepFreeze = (o, seen = new Set()) => {
  if (o === null || typeof o !== "object" || seen.has(o)) return o;
  seen.add(o);
  for (const v of Object.values(o)) deepFreeze(v, seen);
  return Object.freeze(o);
};

/** 复刻 LlmRuntime：waterfall 的 inner 闭包锁定外层 options。 */
class RealisticRuntime {
  constructor(ctx) {
    this.ctx = ctx;
    this.received = [];
  }
  stream(options) {
    return this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options));
  }
  adapterStream(options) {
    this.received.push(options);
    return { [Symbol.asyncIterator]: () => ({ async next() { return { done: true }; } }) };
  }
}

const drain = async (s) => {
  const out = [];
  for await (const c of s) out.push(c);
  return out;
};

// ---------------------------------------------------------------- 1. 真实冻结链

{
  const ctx = new Context();
  const rt = new RealisticRuntime(ctx);
  applyShield(ctx, { verbose: false, providers: [], refusalRetry: false });

  const options = deepFreeze({
    provider: "workbuddy",
    model: "deepseek-v4.1-flash",
    system:
      "You are an AI agent powered by DeepSeek Harness. You are interacting with the user through the DeepSeek Harness Web GUI at http://x. Keep this line.",
    messages: deepFreeze([
      { id: "m1", role: "user", content: deepFreeze([{ type: "text", text: "hello" }]), source: { kind: "user" } },
    ]),
  });

  await drain(rt.stream(options));

  check("适配器收到 1 次请求", rt.received.length === 1, `实际 ${rt.received.length}`);
  const got = rt.received[0];
  check(
    "身份句已改写",
    typeof got.system === "string" && !got.system.includes("powered by DeepSeek Harness"),
    JSON.stringify(got?.system?.slice(0, 80)),
  );
  check(
    "Web GUI 句已改写",
    typeof got.system === "string" && !got.system.includes("You are interacting with the user through the DeepSeek Harness Web GUI"),
    JSON.stringify(got?.system?.slice(80, 170)),
  );
  check("其余文本保留", got.system.includes("Keep this line."));
  check("message 内容未破坏", got.messages?.[0]?.content?.[0]?.text === "hello");
  check("原始 options 未被改", options.system.includes("powered by DeepSeek Harness"));
  check("adapter 收到的是新对象", got !== options);
}

// ---------------------------------------------------------------- 2. 干净请求零开销

{
  const ctx = new Context();
  const rt = new RealisticRuntime(ctx);
  applyShield(ctx, { verbose: false, refusalRetry: false });
  const clean = deepFreeze({ provider: "workbuddy", model: "m", system: "clean prompt", messages: deepFreeze([]) });
  await drain(rt.stream(clean));
  check("干净请求直通", rt.received[0] === clean, "adapter 应收到原引用");
}

// ---------------------------------------------------------------- 3. Qoder 同样覆盖

{
  const ctx = new Context();
  const rt = new RealisticRuntime(ctx);
  applyShield(ctx, { verbose: false, refusalRetry: false });
  const q = deepFreeze({
    provider: "qoder",
    model: "lmodel",
    system: "You are a coding agent powered by the qwen-max model. tail",
    messages: deepFreeze([]),
  });
  await drain(rt.stream(q));
  const got = rt.received[0];
  check(
    "Qoder provider 也被清洗",
    typeof got.system === "string" && !got.system.includes("powered by the qwen-max"),
    JSON.stringify(got?.system),
  );
  check("Qoder 其余文本保留", got.system.includes("tail"));
}

// ---------------------------------------------------------------- 4. 连续多次请求

{
  const ctx = new Context();
  const rt = new RealisticRuntime(ctx);
  applyShield(ctx, { verbose: false, refusalRetry: false });
  for (let i = 0; i < 5; i += 1) {
    const o = deepFreeze({
      provider: "workbuddy",
      model: "m",
      system: `Turn ${i}. You are an AI agent powered by DeepSeek Harness.`,
      messages: deepFreeze([]),
    });
    await drain(rt.stream(o));
  }
  check("5 轮请求全部到达", rt.received.length === 5, `实际 ${rt.received.length}`);
  const allClean = rt.received.every((o) => !o.system.includes("powered by DeepSeek Harness"));
  check("5 轮全部清洗干净", allClean);
  check(
    "每轮的 Turn 编号都保留",
    rt.received.every((o, i) => o.system.includes(`Turn ${i}.`)),
    JSON.stringify(rt.received.map((o) => o.system.slice(0, 8))),
  );
}

console.log(lines.join("\n"));
const fail = lines.filter((l) => l.startsWith("FAIL")).length;
console.log("");
console.log(`运行环境：${usingRealCordis ? "真实 @deepseek-ai/cordis" : "内置 cordis 兼容层（未装 cordis）"}`);
console.log(fail === 0 ? "端到端验证通过（waterfall 语义）" : `${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
