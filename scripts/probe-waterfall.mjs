/**
 * 验证 cordis waterfall 的 `next()` 是否接受改写后的参数。
 *
 * 这是整个插件能否生效的前提：如果 `next(newOptions)` 的参数被丢弃，
 * 那么唯一可行的路径是**原地修改** options 对象（因为 inner 闭包持有同一引用）。
 */
import { Context } from "@deepseek-ai/cordis";

const ctx = new Context();

const results = [];
function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
  return ok;
}

// 模拟 DSH 的 LlmRuntime.streamWithRegistration：
//   ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared))
// 注意 inner 是闭包，捕获外层 options。
let observedByInner = null;
function fakeStream(options) {
  observedByInner = { system: options.system, msgCount: options.messages.length };
  return "STREAM(" + options.system + ")";
}

const original = {
  provider: "workbuddy",
  model: "m",
  system: "ORIGINAL SYSTEM",
  messages: [{ role: "system", content: [{ type: "text", text: "hello" }] }],
};

// 1) 传参方式：next({...options, system:"REWRITTEN"})
const out1 = ctx.waterfall(
  null,
  "test/pass-arg",
  original,
  () => fakeStream(original),
);
check("baseline 直接调用 inner", out1 === "STREAM(ORIGINAL SYSTEM)", `got ${out1}`);

ctx.on("test/pass-arg2", (options, next) => {
  const replaced = { ...options, system: "REWRITTEN SYSTEM" };
  return next(replaced);
});
const out2 = ctx.waterfall(null, "test/pass-arg2", original, () => fakeStream(original));
check(
  "next(newOptions) 是否生效",
  out2 === "STREAM(REWRITTEN SYSTEM)",
  `实际 inner 收到 system=${JSON.stringify(observedByInner?.system)}，返回值=${out2}`,
);

// 2) 原地修改方式
observedByInner = null;
const original2 = {
  provider: "workbuddy",
  model: "m",
  system: "ORIGINAL SYSTEM",
  messages: [{ role: "system", content: [{ type: "text", text: "hello" }] }],
};
ctx.on("test/inplace", (options, next) => {
  options.system = "INPLACE SYSTEM";
  return next();
});
const out3 = ctx.waterfall(null, "test/inplace", original2, () => fakeStream(original2));
check(
  "原地改 options 是否生效",
  out3 === "STREAM(INPLACE SYSTEM)",
  `inner 收到 system=${JSON.stringify(observedByInner?.system)}`,
);

// 3) 原对象 frozen 时的原地修改
observedByInner = null;
const frozen = Object.freeze({
  provider: "workbuddy",
  model: "m",
  system: "ORIGINAL SYSTEM",
  messages: Object.freeze([{ role: "system", content: [{ type: "text", text: "hello" }] }]),
});
ctx.on("test/frozen", (options, next) => {
  try {
    options.system = "FROZEN ATTEMPT";
  } catch {
    /* 严格模式下静默失败或抛错 */
  }
  return next();
});
const out4 = ctx.waterfall(null, "test/frozen", frozen, () => fakeStream(frozen));
check(
  "frozen options 原地改是否生效",
  out4 === "STREAM(FROZEN ATTEMPT)",
  `inner 收到 system=${JSON.stringify(observedByInner?.system)}（预期不可改）`,
);

// 4) 数组内元素是否可变（messages[0].content[0].text）
observedByInner = null;
const nested = {
  provider: "workbuddy",
  model: "m",
  system: "S",
  messages: [{ role: "system", content: [{ type: "text", text: "ORIGINAL" }] }],
};
ctx.on("test/nested", (options, next) => {
  options.messages[0].content[0].text = "MUTATED";
  return next();
});
ctx.waterfall(null, "test/nested", nested, () => {
  observedByInner = { text: nested.messages[0].content[0].text };
  return "ok";
});
check(
  "嵌套块原地改是否生效",
  observedByInner?.text === "MUTATED",
  `inner 读到 ${JSON.stringify(observedByInner?.text)}`,
);

// 5) next() 被调两次
let twice = null;
ctx.on("test/twice", (options, next) => {
  next();
  try {
    next();
  } catch (e) {
    twice = e.message;
  }
  return "x";
});
ctx.waterfall(null, "test/twice", { a: 1 }, () => "y");
check("next() 二次调用会抛错", /multiple times/.test(String(twice)), `错误信息：${twice}`);

console.log(results.join("\n"));
console.log("");
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed === 0 ? "全部符合预期" : `${failed} 项不符合预期`);
