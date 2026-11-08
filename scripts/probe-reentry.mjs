/**
 * 验证「用 this.stream() 重入 waterfall」是否可行。
 *
 * 背景（已实测确认）：
 *   1. cordis 的 `next()` 无参，`next(newOptions)` 的参数被丢弃；
 *   2. dsh-agent-loop 对 options 与每条 message 做 Object.freeze / deepFreeze，
 *      原地改也不行。
 * 唯一可行的改写路径：listener 里用 `this.stream(改写后的新对象)` 重入一次
 * waterfall，用 Symbol 标记防止无限递归。
 *
 * 本脚本用真实的 cordis Context + 一个模拟 LlmRuntime 验证这条链路。
 */
import { Context } from "@deepseek-ai/cordis";

const SHIELDED = Symbol.for("dsh-gateway-shield.shielded");

const results = [];
const check = (name, ok, detail = "") =>
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);

/** 模拟 DSH 的 LlmRuntime：stream() → waterfall → adapterStream() */
class FakeRuntime {
  constructor(ctx) {
    this.ctx = ctx;
    this.adapterCalls = [];
  }

  stream(options) {
    return this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options));
  }

  adapterStream(options) {
    this.adapterCalls.push({
      system: options.system,
      firstText: options.messages?.[0]?.content?.[0]?.text ?? null,
      nested: options,
      frozen: Object.isFrozen(options),
    });
    return { kind: "stream", system: options.system };
  }
}

// ---------------------------------------------------------------- 1. this 绑定

{
  const ctx = new Context();
  const rt = new FakeRuntime(ctx);
  let sawThis = null;
  ctx.on("llm/stream", function (options, next) {
    sawThis = this;
    return next();
  });
  rt.stream({ system: "S", messages: [] });
  check("listener 的 this 绑定到 LlmRuntime", sawThis === rt, `got ${sawThis?.constructor?.name}`);
  check("this.stream 可调用", typeof sawThis?.stream === "function");
}

// ---------------------------------------------------------------- 2. 深冻结的 options

{
  const ctx = new Context();
  const rt = new FakeRuntime(ctx);
  const deepFreeze = (o, seen = new Set()) => {
    if (o === null || typeof o !== "object" || seen.has(o)) return o;
    seen.add(o);
    for (const v of Object.values(o)) deepFreeze(v, seen);
    return Object.freeze(o);
  };
  const options = deepFreeze({
    provider: "workbuddy",
    model: "m",
    system: "You are an AI agent powered by DeepSeek Harness.",
    messages: [{ role: "system", content: [{ type: "text", text: "hi" }] }],
  });

  ctx.on("llm/stream", function (options, next) {
    let mutated = false;
    try {
      options.system = "X";
      mutated = options.system === "X";
    } catch {
      mutated = false;
    }
    let nestedMutated = false;
    try {
      options.messages[0].content[0].text = "X";
      nestedMutated = options.messages[0].content[0].text === "X";
    } catch {
      nestedMutated = false;
    }
    this.mutation = { mutated, nestedMutated };
    return next();
  });

  rt.stream(options);
  check("顶层 options 不可原地改", rt.mutation?.mutated === false);
  check("嵌套 message 块不可原地改", rt.mutation?.nestedMutated === false);
  check("adapterStream 收到的是冻结对象", rt.adapterCalls[0]?.frozen === true);
}

// ---------------------------------------------------------------- 3. this.stream 重入

{
  const ctx = new Context();
  const rt = new FakeRuntime(ctx);
  let depth = 0;
  const MAX = 6;

  ctx.on("llm/stream", function (options, next) {
    depth += 1;
    if (depth > MAX) throw new Error("递归失控");
    if (options?.[SHIELDED]) return next();

    // 清洗：生成新对象，避开冻结
    const cleaned = options.system.replace(
      "powered by DeepSeek Harness",
      "running inside DeepSeek Harness",
    );
    if (cleaned === options.system) return next();

    const shielded = { ...options, system: cleaned };
    Object.defineProperty(shielded, SHIELDED, { value: true, enumerable: false });
    return this.stream(shielded);
  });

  const options = Object.freeze({
    provider: "workbuddy",
    model: "m",
    system: "You are an AI agent powered by DeepSeek Harness.",
    messages: Object.freeze([{ role: "system", content: Object.freeze([{ type: "text", text: "hi" }]) }]),
  });

  const out = rt.stream(options);
  check("重入成功，返回流", out?.kind === "stream", JSON.stringify(out));
  check("只到 adapterStream 一次", rt.adapterCalls.length === 1, `调用 ${rt.adapterCalls.length} 次`);
  check(
    "adapterStream 收到清洗后的 system",
    rt.adapterCalls[0]?.system === "You are an AI agent running inside DeepSeek Harness.",
    JSON.stringify(rt.adapterCalls[0]?.system),
  );
  check("递归深度受控", depth === 2, `depth=${depth}`);
}

// ---------------------------------------------------------------- 4. 干净请求零开销

{
  const ctx = new Context();
  const rt = new FakeRuntime(ctx);
  let depth = 0;
  ctx.on("llm/stream", function (options, next) {
    depth += 1;
    if (options?.[SHIELDED]) return next();
    return next(); // 无需改写
  });
  rt.stream(Object.freeze({ system: "clean", messages: Object.freeze([]) }));
  check("干净请求只走一层", depth === 1, `depth=${depth}`);
  check("干净请求正常到达 adapter", rt.adapterCalls.length === 1);
}

// ---------------------------------------------------------------- 5. Symbol 不进序列化

{
  const o = { a: 1 };
  Object.defineProperty(o, SHIELDED, { value: true, enumerable: false });
  check("Symbol 标记不进 JSON", JSON.stringify(o) === '{"a":1}', JSON.stringify(o));
  check("Symbol 标记不进 Object.keys", Object.keys(o).length === 1);
  check("Symbol.for 跨模块一致", Symbol.for("dsh-gateway-shield.shielded") === SHIELDED);
}

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log("");
console.log(failed === 0 ? "全部符合预期：重入方案可行" : `${failed} 项不符合预期`);
process.exit(failed === 0 ? 0 : 1);
