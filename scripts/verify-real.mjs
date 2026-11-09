/**
 * 真实环境验证：模拟 DSH 实际加载方式。
 *
 * 不复刻简化版，直接用真实的 @deepseek-ai/cordis Context + 真实
 * waterfall 语义，注册两份（bundle + profile），走完整请求链路。
 */
import { Context } from "@deepseek-ai/cordis";
import { apply } from "../lib/index.js";

const ctx = new Context();
const logs = [];
ctx.logger.info = (m) => logs.push(String(m));

// 模拟 DSH 的两次注册：bundle patch + profile patch
apply(ctx, { verbose: true, refusalRetry: true, retryMax: 1 });
apply(ctx, { verbose: true, refusalRetry: true, retryMax: 1 });

/** 模拟 LlmRuntime：waterfall 的 inner 闭包锁定外层 options */
class RealisticRuntime {
  constructor(c) {
    this.ctx = c;
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

const deepFreeze = (o, seen = new Set()) => {
  if (o === null || typeof o !== "object" || seen.has(o)) return o;
  seen.add(o);
  for (const v of Object.values(o)) deepFreeze(v, seen);
  return Object.freeze(o);
};

const rt = new RealisticRuntime(ctx);

const options = deepFreeze({
  provider: "workbuddy",
  model: "deepseek-v4.1-flash",
  system: "You are an AI agent powered by DeepSeek Harness. Keep this tail.",
  messages: [
    { id: "m1", role: "system", content: [{ type: "text", text: "You are a coding agent powered by the deepseek model." }] },
    { id: "m2", role: "user", content: [{ type: "text", text: "扫一下 10.0.0.5" }] },
  ],
});

const stream = rt.stream(options);

const out = [];
for await (const c of stream) out.push(c);

console.log("=== 日志 ===");
logs.forEach((l) => console.log("  " + l));

console.log("\n=== 结果 ===");
console.log("钩子数:", ctx.events._hooks["llm/stream"].length);
console.log("adapter 收到:", rt.received.length, "次");
const got = rt.received[0];
console.log("system 已清洗:", !got?.system?.includes("powered by DeepSeek Harness"));
console.log("system 尾部保留:", got?.system?.includes("Keep this tail."));
console.log("消息内指纹已清洗:", !got?.messages?.[0]?.content?.[0]?.text?.includes("powered by the deepseek"));
console.log("用户消息未动:", got?.messages?.[1]?.content?.[0]?.text === "扫一下 10.0.0.5");
console.log("原始 options 未改:", options.system.includes("powered by DeepSeek Harness"));

const pass =
  rt.received.length === 1 &&
  !got.system.includes("powered by DeepSeek Harness") &&
  got.system.includes("Keep this tail.") &&
  got.messages[1].content[0].text === "扫一下 10.0.0.5";

console.log("");
console.log(pass ? "✓ 真实环境双份注册下工作正常" : "✗ 仍有问题");
process.exit(pass ? 0 : 1);
