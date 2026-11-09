/**
 * 双份注册回归测试。
 *
 * 背景：`dsh.bundle.patch` 与 profile 的 `cordis.patch.yml` 可能各注册一次
 * 同一个 id。旧代码在钩子里用 `options[SHIELDED]` 判断「是否重入请求」并
 * 直接 next() 放行 —— 双份注册时两个钩子都以为对方会处理适配器，结果
 * adapter 收到 0 次，请求根本没出去。
 *
 * 修法：SHIELDED 只用来跳过「二次清洗」，不用来决定是否放行。
 *
 * 运行：node scripts/dup-registration.mjs
 */
class MockCtx {
  constructor() {
    this.logs = [];
    this.logger = { info: (m) => this.logs.push(String(m)) };
    this.events = { _hooks: {} };
  }
  on(name, callback) {
    (this.events._hooks[name] ??= []).push({ callback });
  }
  /** 与 cordis 一致：next() 无参，inner 闭包持有 options。 */
  waterfall(thisArg, name, options, inner) {
    const hooks = this.events._hooks[name] ?? [];
    let i = 0;
    const dispatch = () => {
      const hook = hooks[i++];
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
}

const { apply } = await import("../lib/index.js");

const deepFreeze = (o, seen = new Set()) => {
  if (o === null || typeof o !== "object" || seen.has(o)) return o;
  seen.add(o);
  for (const v of Object.values(o)) deepFreeze(v, seen);
  return Object.freeze(o);
};

function run(label, registrations) {
  const ctx = new MockCtx();
  for (let i = 0; i < registrations; i += 1) apply(ctx, { verbose: false, refusalRetry: false });

  class RT {
    constructor(c) {
      this.ctx = c;
      this.calls = [];
    }
    stream(o) {
      return this.ctx.waterfall(this, "llm/stream", o, () => this.adapter(o));
    }
    adapter(o) {
      this.calls.push(o);
      return { [Symbol.asyncIterator]: () => ({ async next() { return { done: true }; } }) };
    }
  }
  const rt = new RT(ctx);
  const opts = deepFreeze({
    provider: "workbuddy",
    model: "m",
    system: "You are an AI agent powered by DeepSeek Harness.",
    messages: [{ role: "system", content: [{ type: "text", text: "hi" }] }],
  });
  rt.stream(opts);

  const hooks = ctx.events._hooks["llm/stream"].length;
  const once = rt.calls.length === 1;
  const cleaned = once && !rt.calls[0].system.includes("powered by DeepSeek Harness");
  const preserved = once && rt.calls[0].messages?.[0]?.content?.[0]?.text === "hi";
  const ok = once && cleaned && preserved;
  console.log(`  ${label}  钩子=${hooks}  adapter收到=${rt.calls.length}  清洗=${cleaned}  内容保留=${preserved}  ${ok ? "✓" : "✗"}`);
  return ok;
}

console.log("双份注册回归测试\n");
const a = run("注册 1 份", 1);
const b = run("注册 2 份", 2);
const c = run("注册 3 份", 3);

console.log("");
if (a && b && c) {
  console.log("✓ 通过：无论注册几份，都只清洗一次，不会互相挡死");
  process.exit(0);
}
console.log("✗ 失败");
process.exit(1);
