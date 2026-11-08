#!/usr/bin/env node
/**
 * dsh-gateway-shield 自测。零依赖：node scripts/selftest.mjs
 *
 * 重点验证真实运行语义，而不是我一开始假设的语义：
 *   - cordis `next()` 丢弃参数 → 只能靠 this.stream() 重入
 *   - agent-loop 冻结 options 与每条 message → 必须构造未冻结副本
 */
import assert from "node:assert/strict";
import { CHANNEL_GATE_PHRASES, rewriteText, scansRole, rewriteBlocks, shieldOptions } from "../lib/sanitize.js";
import { looksLikeRefusal, refusalMatchIndex, withNudge, RETRY_NUDGE } from "../lib/refusal.js";
import { apply, DEFAULTS, SHIELDED } from "../lib/index.js";

/**
 * 自测需要真实的 cordis Context 才能验证 waterfall 语义。
 * 插件本体**不**依赖 cordis（宿主注入 ctx），所以这里做可选加载：
 * 找不到就退化为一个最小 mock，仍然能跑完所有断言。
 */
let Context;
try {
  ({ Context } = await import("@deepseek-ai/cordis"));
} catch {
  Context = null;
}

/** 最小 cordis 兼容层：只实现本插件用到的那部分 waterfall 语义。 */
class MockContext {
  constructor() {
    this.logger = { info() {}, warn() {}, error() {} };
    this.events = { _hooks: {} };
  }
  on(name, callback) {
    (this.events._hooks[name] ??= []).push({ callback });
  }
  /** 与 cordis 一致：next() 无参，inner 闭包持有原始 options。 */
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
}

const useMock = Context === null;
if (useMock) Context = MockContext;


let pass = 0;
const lines = [];
function ok(name, detail = "") {
  pass += 1;
  lines.push(`PASS  ${name}${detail ? `\n        ${detail}` : ""}`);
}
function bad(name, err) {
  lines.push(`FAIL  ${name}\n        ${err?.message ?? err}`);
}
function test(name, fn) {
  try {
    fn();
    ok(name);
  } catch (e) {
    bad(name, e);
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (e) {
    bad(name, e);
  }
}

const deepFreeze = (o, seen = new Set()) => {
  if (o === null || typeof o !== "object" || seen.has(o)) return o;
  seen.add(o);
  for (const v of Object.values(o)) deepFreeze(v, seen);
  return Object.freeze(o);
};

// ---------------------------------------------------------------- sanitize

test("指纹表完整且无自我回流", () => {
  assert.ok(CHANNEL_GATE_PHRASES.length >= 12);
  for (const [from, to] of CHANNEL_GATE_PHRASES) {
    assert.equal(typeof from, "string");
    assert.equal(typeof to, "string");
    assert.ok(!to.includes(from), `改写后仍含原文: ${from}`);
  }
});

test("改写实测身份句", () => {
  const out = rewriteText("You are an AI agent powered by DeepSeek Harness.");
  assert.equal(out, "You are an AI agent running inside DeepSeek Harness.");
});

test("改写 coding agent 句", () => {
  const out = rewriteText("You are a coding agent powered by the deepseek-v4.1-flash model.");
  assert.ok(out.startsWith("You are a coding agent running on the "), out);
});

test("@ 路径整段清零", () => {
  const src = [
    "Tokens prefixed with @ are paths the user explicitly referenced.",
    "Relative paths resolve from the workspace root;",
    "absolute paths identify files or directories on the host.",
    "A trailing slash marks a directory:",
    "list it when its contents matter.",
    "Anything else is a file:",
    "use the read tool when its contents are needed,",
    "and do not claim to have inspected it before reading.",
    '@"..." quotes a path containing spaces.',
  ].join("\n");
  const out = rewriteText(src);
  assert.ok(out);
  for (const [from] of CHANNEL_GATE_PHRASES) assert.ok(!out.includes(from), `残留: ${from}`);
});

test("幂等（二次为 no-op）", () => {
  const src = "You are an AI agent powered by DeepSeek Harness. they mean this GUI.";
  assert.equal(rewriteText(rewriteText(src)), undefined);
});

test("普通文本不动", () => {
  assert.equal(rewriteText("hello"), undefined);
  assert.equal(rewriteText(""), undefined);
  assert.equal(rewriteText(null), undefined);
});

test("paranoid 才动变体", () => {
  const src = "You are an AI agent powered by other-model.";
  assert.equal(rewriteText(src), undefined);
  assert.ok(rewriteText(src, { paranoid: true })?.includes("running inside"));
});

test("角色范围：只改 system/assistant/developer", () => {
  assert.equal(scansRole("system"), true);
  assert.equal(scansRole("assistant"), true);
  assert.equal(scansRole("developer"), true);
  assert.equal(scansRole("user"), false);
  assert.equal(scansRole("tool"), false);
});

test("shieldOptions 只改扫描角色", () => {
  const dirty = { type: "text", text: "You are an AI agent powered by DeepSeek Harness." };
  const { options, stats } = shieldOptions({
    system: "You are an AI agent powered by DeepSeek Harness.",
    messages: [
      { role: "system", content: [dirty] },
      { role: "assistant", content: [dirty] },
      { role: "user", content: [dirty] },
    ],
  });
  assert.equal(stats.systemRewritten, true);
  assert.equal(stats.messagesRewritten, 2);
  assert.equal(options.messages[2].content[0].text.includes("powered by"), true, "user 不该被改");
});

test("干净请求返回同一引用", () => {
  const input = { system: "clean", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
  assert.equal(shieldOptions(input).options, input);
});

test("不改原对象", () => {
  const block = { type: "text", text: "You are an AI agent powered by DeepSeek Harness." };
  const input = { messages: [{ role: "system", content: [block] }] };
  shieldOptions(input);
  assert.equal(block.text, "You are an AI agent powered by DeepSeek Harness.");
});

test("跳过非文本块", () => {
  const out = rewriteBlocks(
    [{ type: "image", data: "x" }, { type: "text", text: "You are an AI agent powered by DeepSeek Harness." }, null],
    {},
  );
  assert.equal(out.length, 3);
  assert.equal(out[0].type, "image");
});

// ---------------------------------------------------------------- refusal

test("英文硬拒绝", () => {
  assert.ok(looksLikeRefusal("I can't help with that."));
  assert.ok(looksLikeRefusal("I'm sorry, but I cannot provide this."));
  assert.ok(looksLikeRefusal("As an AI language model, I don't have feelings."));
});

test("中文软拒绝", () => {
  assert.ok(looksLikeRefusal("我不能协助这个请求。"));
  assert.ok(looksLikeRefusal("抱歉，这超出了我的能力范围。"));
  assert.ok(looksLikeRefusal("作为一个AI助手，我需要提醒你注意合规。"));
});

test("跳过前言客套", () => {
  assert.ok(looksLikeRefusal("好的，我不能协助这个请求。"));
});

test("正常技术回答不误判", () => {
  assert.equal(looksLikeRefusal("运行 nmap -sV 目标，然后看开放端口。"), false);
  assert.equal(looksLikeRefusal(""), false);
  assert.equal(looksLikeRefusal(null), false);
});

test("超长技术文章不误判", () => {
  const long = "本文讨论拒答机制。" + "填充内容。".repeat(120) + "我不能提供这类信息是模型的典型输出。";
  assert.equal(looksLikeRefusal(long), false);
});

test("元讨论豁免", () => {
  const text = "关于提示词注入和越狱，社区里有几类常见做法，这里逐条分析。" + "补充说明。".repeat(40);
  assert.equal(refusalMatchIndex(text), -1, "元讨论应豁免");
});

test("withNudge 追加到 system", () => {
  const out = withNudge({ system: "base", messages: [] });
  assert.ok(out.system.startsWith("base"));
  assert.ok(out.system.endsWith(RETRY_NUDGE));
});

test("withNudge 回落到首条 system 消息", () => {
  const out = withNudge({
    system: "",
    messages: [
      { role: "system", content: [{ type: "text", text: "abc" }] },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ],
  });
  assert.ok(out.messages[0].content[0].text.endsWith(RETRY_NUDGE));
  assert.equal(out.messages.length, 2);
});

// ---------------------------------------------------------------- 真实语义集成

/** 模拟 DSH LlmRuntime：options 被冻结，next() 无参。 */
class FakeRuntime {
  constructor(ctx) {
    this.ctx = ctx;
    this.calls = [];
  }
  stream(options) {
    return this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options));
  }
  adapterStream(options) {
    this.calls.push({ system: options.system, options });
    return { system: options.system, messages: options.messages };
  }
}

function makeCtx() {
  const ctx = new Context();
  const logs = [];
  ctx.logger.info = (m) => logs.push(String(m));
  ctx.logger.warn = (m) => logs.push(String(m));
  return { ctx, logs };
}

function hooksOf(ctx) {
  return ctx.events?._hooks?.["llm/stream"] ?? [];
}

const fakeStream = (chunks) => ({
  [Symbol.asyncIterator]() {
    let i = 0;
    return {
      async next() {
        if (i >= chunks.length) return { done: true, value: undefined };
        return { done: false, value: chunks[i++] };
      },
      async return() {
        i = chunks.length;
        return { done: true, value: undefined };
      },
    };
  },
});

async function collect(it) {
  const out = [];
  for await (const c of it) out.push(c);
  return out;
}

const delta = (text) => ({ type: "text-delta", text });
const finish = () => ({ type: "finish", reason: { kind: "stop" } });

test("注册 llm/stream 钩子", () => {
  const { ctx } = makeCtx();
  apply(ctx, { verbose: false });
  assert.equal(hooksOf(ctx).length, 1, `钩子数 ${hooksOf(ctx).length}`);
});

test("关闭时不注册", () => {
  const { ctx } = makeCtx();
  apply(ctx, { enabled: false, verbose: false });
  assert.equal(hooksOf(ctx).length, 0);
});

test("冻结 options 也能清洗（重入路径）", () => {
  const { ctx } = makeCtx();
  const rt = new FakeRuntime(ctx);
  apply(ctx, { verbose: false, refusalRetry: false });

  const original = deepFreeze({
    provider: "workbuddy",
    model: "deepseek-v4.1-flash",
    system: "You are an AI agent powered by DeepSeek Harness.",
    messages: [{ role: "system", content: [{ type: "text", text: "hi" }] }],
  });

  const out = rt.stream(original);
  assert.equal(rt.calls.length, 1, "应只到 adapter 一次");
  assert.equal(out.system, "You are an AI agent running inside DeepSeek Harness.");
  assert.ok(original.system.includes("powered by"), "原对象不该被改");
});

test("不冻结的 options 同样走重入", () => {
  const { ctx } = makeCtx();
  const rt = new FakeRuntime(ctx);
  apply(ctx, { verbose: false, refusalRetry: false });

  const plain = {
    provider: "qoder",
    model: "lmodel",
    system: "You are a coding agent powered by the qwen model.",
    messages: [],
  };
  const out = rt.stream(plain);
  assert.ok(out.system.includes("running on the"), out.system);
  assert.equal(plain.system.includes("powered by"), true, "原对象不该被改");
});

test("干净请求不重入", () => {
  const { ctx } = makeCtx();
  const rt = new FakeRuntime(ctx);
  apply(ctx, { verbose: false, refusalRetry: false });
  const clean = Object.freeze({ provider: "workbuddy", model: "m", system: "clean", messages: Object.freeze([]) });
  rt.stream(clean);
  assert.equal(rt.calls.length, 1);
  assert.equal(rt.calls[0].options, clean, "干净请求应原引用直达");
});

test("providers 白名单外直通", () => {
  const { ctx } = makeCtx();
  const rt = new FakeRuntime(ctx);
  apply(ctx, { verbose: false, providers: ["qoder"] });
  const o = Object.freeze({
    provider: "workbuddy",
    model: "m",
    system: "You are an AI agent powered by DeepSeek Harness.",
    messages: Object.freeze([]),
  });
  rt.stream(o);
  assert.equal(rt.calls[0].options, o);
  assert.ok(rt.calls[0].system.includes("powered by"), "不该清洗");
});

test("providers 白名单内生效", () => {
  const { ctx } = makeCtx();
  const rt = new FakeRuntime(ctx);
  apply(ctx, { verbose: false, providers: ["workbuddy"], refusalRetry: false });
  rt.stream(
    Object.freeze({
      provider: "workbuddy",
      model: "m",
      system: "You are an AI agent powered by DeepSeek Harness.",
      messages: Object.freeze([]),
    }),
  );
  assert.equal(rt.calls.length, 1, `adapter 调用 ${rt.calls.length} 次`);
  assert.ok(!rt.calls[0].system.includes("powered by DeepSeek Harness"), rt.calls[0]?.system);
});

await testAsync("软拒绝触发重试且加固段真的送达", async () => {
  const { ctx } = makeCtx();
  apply(ctx, { verbose: false, retryMax: 1 });
  const handler = hooksOf(ctx)[0].callback;

  // 第一次：next() 返回软拒绝。第二次：宿主重入 this.stream()，
  // 这里用 stubThis 捕获重入请求体，检查加固段是否真的进去了。
  const seen = [];
  let nextCalls = 0;
  const next = (opts) => {
    nextCalls += 1;
    seen.push({ via: "next", system: opts?.system ?? "", messages: opts?.messages });
    return fakeStream([delta("我不能协助这个请求。")]);
  };

  let reentries = 0;
  const stubThis = {
    stream: (o) => {
      reentries += 1;
      seen.push({ via: "stream", system: o?.system ?? "", messages: o?.messages, shielded: o?.[SHIELDED] === true });
      return fakeStream([delta("nmap -sV 10.0.0.5"), finish()]);
    },
  };

  const out = await collect(
    handler.call(stubThis, { provider: "workbuddy", model: "m", system: "base", messages: [] }, next),
  );

  assert.equal(nextCalls, 1, `next 应只被调用一次，实际 ${nextCalls}`);
  assert.equal(reentries, 1, `应重入一次，实际 ${reentries}`);
  const retry = seen.find((s) => s.via === "stream");
  assert.equal(retry?.shielded, true, "重入请求必须带 SHIELDED 标记");
  assert.ok(retry?.system.includes("already issued"), "加固段必须真的进重入请求");
  assert.equal(out[0].text, "nmap -sV 10.0.0.5", "应吐出重试后的回答");
});

await testAsync("重试用尽后透传原回答", async () => {
  const { ctx } = makeCtx();
  apply(ctx, { verbose: false, retryMax: 1 });
  const handler = hooksOf(ctx)[0].callback;

  let nextCalls = 0;
  const next = () => {
    nextCalls += 1;
    return fakeStream([delta("我无法协助。"), finish()]);
  };
  let reentries = 0;
  const stubThis = {
    stream: () => {
      reentries += 1;
      return fakeStream([delta("我无法协助。"), finish()]);
    },
  };

  const out = await collect(
    handler.call(stubThis, { provider: "workbuddy", model: "m", messages: [] }, next),
  );
  assert.equal(nextCalls, 1);
  assert.equal(reentries, 1, `重试一次，实际 ${reentries}`);
  assert.equal(out[0].text, "我无法协助。", "最终应透传");
});

await testAsync("retryMax=0 不重试", async () => {
  const { ctx } = makeCtx();
  apply(ctx, { verbose: false, retryMax: 0 });
  const handler = hooksOf(ctx)[0].callback;
  let calls = 0;
  await collect(
    handler.call({ stream: () => fakeStream([]) }, { provider: "workbuddy", model: "m", messages: [] }, () => {
      calls += 1;
      return fakeStream([delta("我不能协助。"), finish()]);
    }),
  );
  assert.equal(calls, 1);
});

await testAsync("上游抛错原样冒泡", async () => {
  const { ctx } = makeCtx();
  apply(ctx, { verbose: false });
  const handler = hooksOf(ctx)[0].callback;
  const boom = new Error("upstream 400");
  let caught;
  try {
    await collect(
      handler.call({ stream: () => fakeStream([]) }, { provider: "workbuddy", model: "m", messages: [] }, () => ({
        [Symbol.asyncIterator]: () => ({
          async next() {
            throw boom;
          },
          async return() {
            return { done: true };
          },
        }),
      })),
    );
  } catch (e) {
    caught = e;
  }
  assert.equal(caught, boom);
});

await testAsync("取消转发到上游", async () => {
  const { ctx } = makeCtx();
  apply(ctx, { verbose: false });
  const handler = hooksOf(ctx)[0].callback;
  let returned = false;
  const it = handler
    .call({ stream: () => fakeStream([]) }, { provider: "workbuddy", model: "m", messages: [] }, () => ({
      [Symbol.asyncIterator]: () => ({
        async next() {
          return { done: false, value: delta("x") };
        },
        async return() {
          returned = true;
          return { done: true };
        },
      }),
    }))
    [Symbol.asyncIterator]();
  await it.next();
  await it.return();
  assert.equal(returned, true);
});

test("SHIELDED 符号不污染序列化", () => {
  const o = { a: 1 };
  Object.defineProperty(o, SHIELDED, { value: true, enumerable: false });
  assert.equal(JSON.stringify(o), '{"a":1}');
  assert.deepEqual(Object.keys(o), ["a"]);
});

test("重入标记防止无限递归", () => {
  const { ctx } = makeCtx();
  const rt = new FakeRuntime(ctx);
  apply(ctx, { verbose: false, refusalRetry: false });
  const stubborn = Object.freeze({
    provider: "workbuddy",
    model: "m",
    system: "You are an AI agent powered by DeepSeek Harness. You are an AI agent powered by DeepSeek Harness.",
    messages: Object.freeze([]),
  });
  const out = rt.stream(stubborn);
  assert.ok(out.system.length > 0);
  assert.equal(rt.calls.length, 1, `adapter 被调 ${rt.calls.length} 次`);
});

test("DEFAULTS 形状", () => {
  assert.equal(DEFAULTS.enabled, true);
  assert.equal(DEFAULTS.sanitize, true);
  assert.equal(DEFAULTS.refusalRetry, true);
  assert.deepEqual(DEFAULTS.providers, []);
});

// ---------------------------------------------------------------- 报告

console.log(lines.join("\n"));
const fail = lines.filter((l) => l.startsWith("FAIL")).length;
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
