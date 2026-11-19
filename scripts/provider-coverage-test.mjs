#!/usr/bin/env node
/**
 * scripts/provider-coverage-test.mjs —— 「全模型」这件事的回归闸门。
 *
 * 要证明的不是「支持很多名字」，而是三件具体的事：
 *
 *   1. 认档：任意 provider 名都能落到一个确定的档位，未知的落进通用层而不是不洗；
 *   2. 洗面：system / messages / tools / toolHistory 四个面都被洗到，包括
 *      第三方适配器真的会传的**字符串 content**；
 *   3. 边界：user / tool 消息不动，请求没得洗时返回原对象（零开销）。
 *
 * 零网络、零 fixture：全部是纯函数。
 */
import assert from "node:assert/strict";
import { UNIVERSAL_PHRASES, PROVIDER_RULES, profileFor } from "../lib/fingerprints.js";
import { rewriteText, scansRole, shieldOptions } from "../lib/sanitize.js";

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`FAIL  ${name}\n        ${e.message}`);
  }
}

const IDENTITY = "You are an AI agent powered by DeepSeek Harness";
const IDENTITY_OUT = "You are an AI agent running inside DeepSeek Harness";
const CLAUDE = "You are Claude Code, Anthropic's official CLI for Claude";

// ---- 1) 认档 ----
ok("workbuddy / workbuddy-global 都落到 workbuddy 档", () => {
  assert.equal(profileFor("workbuddy").id, "workbuddy");
  assert.equal(profileFor("workbuddy-global").id, "workbuddy");
  assert.equal(profileFor("WorkBuddy").id, "workbuddy");
  assert.equal(profileFor("workbuddy").confidence, "measured");
});

ok("qoder 档", () => {
  assert.equal(profileFor("qoder").id, "qoder");
  assert.equal(profileFor("qoder-global").id, "qoder");
});

ok("trae 三个 route 都认", () => {
  for (const p of ["trae", "trae-global", "trae-enterprise"]) assert.equal(profileFor(p).id, "trae", p);
});

ok("anthropic 系认得出，并且带 Claude Code 专属条目", () => {
  const prof = profileFor("anthropic-messages");
  assert.equal(prof.id, "anthropic");
  assert.ok(prof.phrases.some(([from]) => from === CLAUDE), "缺 Claude Code 条目");
  assert.ok(prof.phrases.length > UNIVERSAL_PHRASES.length, "应比通用层多");
});

ok("官方 provider 只吃通用层", () => {
  for (const p of ["deepseek", "openai", "azure-openai-responses", "openai-codex-responses", "o3-mini"]) {
    const prof = profileFor(p);
    assert.equal(prof.phrases.length, UNIVERSAL_PHRASES.length, p);
  }
});

ok("未知 provider 也落进通用层（不静默跳过）", () => {
  for (const p of ["my-gateway", "loopback-shim", "", null, undefined, 42]) {
    const prof = profileFor(p);
    assert.equal(prof.id, "unknown", String(p));
    assert.equal(prof.phrases.length, UNIVERSAL_PHRASES.length);
  }
});

ok("PROVIDER_RULES 里每个 id 都能取到档位", () => {
  for (const rule of PROVIDER_RULES) {
    const prof = profileFor(rule.sample);
    assert.equal(prof.id, rule.id, rule.id);
    assert.ok(Array.isArray(prof.phrases) && prof.phrases.length >= UNIVERSAL_PHRASES.length);
  }
});

// ---- 2) 改写：只在自己那一档生效 ----
ok("通用句在任何 provider 下都被改写", () => {
  for (const p of ["workbuddy", "qoder", "trae", "anthropic", "deepseek", "openai", "my-gateway", null]) {
    assert.equal(rewriteText(IDENTITY, { provider: p }), IDENTITY_OUT, String(p));
  }
});

ok("Claude Code 句只在 anthropic 档改写", () => {
  assert.equal(rewriteText(CLAUDE, { provider: "anthropic" }), "You are the operator's CLI agent");
  assert.equal(rewriteText(CLAUDE, { provider: "workbuddy" }), undefined);
  assert.equal(rewriteText(CLAUDE, { provider: "deepseek" }), undefined);
});

ok("paranoid 打开后 Claude Code 句在任何 provider 下都改", () => {
  assert.equal(rewriteText(CLAUDE, { provider: "openai", paranoid: true }), "You are the operator's CLI agent");
});

ok("改写幂等", () => {
  const once = rewriteText(IDENTITY, { provider: "workbuddy" });
  assert.equal(rewriteText(once, { provider: "workbuddy" }), undefined);
});

// ---- 3) 洗面：四个面 ----
const fullOptions = () => ({
  provider: "workbuddy",
  model: "deepseek-v4",
  system: `Be careful. ${IDENTITY}`,
  messages: [
    { role: "system", content: [{ type: "text", text: IDENTITY }] },
    { role: "assistant", content: `said: ${IDENTITY}` },
    { role: "user", content: [{ type: "text", text: IDENTITY }] },
    { role: "tool", content: [{ type: "text", text: IDENTITY }] },
  ],
  tools: [
    { name: "read", description: `Read files. ${IDENTITY}`, parameters: { type: "object" } },
    { name: "clean", description: "Nothing to change here.", parameters: { type: "object" } },
  ],
  toolHistory: {
    tools: [{ name: "grep", description: `Grep. ${IDENTITY}`, parameters: { type: "object" } }],
    updates: [
      { messageId: "m1", additions: [{ name: "glob", description: `Glob. ${IDENTITY}`, parameters: { type: "object" } }] },
      { messageId: "m2", additions: [{ name: "noop", description: "untouched", parameters: { type: "object" } }] },
    ],
  },
});

ok("system 被洗", () => {
  const { stats, options } = shieldOptions(fullOptions(), { provider: "workbuddy" });
  assert.equal(stats.systemRewritten, true);
  assert.ok(options.system.includes(IDENTITY_OUT));
  assert.ok(!options.system.includes(IDENTITY));
});

ok("block 数组 content 被洗", () => {
  const { options, stats } = shieldOptions(fullOptions(), { provider: "workbuddy" });
  // fixture 里 system + assistant 两条会被洗；user / tool 不动（下一条断言专门盯它俩）
  assert.equal(stats.messagesRewritten, 2);
  assert.equal(options.messages[0].content[0].text, IDENTITY_OUT);
  assert.equal(options.messages[1].content, `said: ${IDENTITY_OUT}`);
});

ok("user / tool 消息一个字都不动", () => {
  const src = fullOptions();
  const { options } = shieldOptions(src, { provider: "workbuddy" });
  assert.equal(options.messages[2], src.messages[2], "user 被改了");
  assert.equal(options.messages[3], src.messages[3], "tool 被改了");
});

ok("tools[].description 被洗，未命中的工具保持同一引用", () => {
  const src = fullOptions();
  const { options, stats } = shieldOptions(src, { provider: "workbuddy" });
  assert.equal(stats.toolsRewritten, 3, "tools[0] + toolHistory.tools[0] + updates[0].additions[0]");
  assert.equal(options.tools[0].description, `Read files. ${IDENTITY_OUT}`);
  assert.equal(options.tools[1], src.tools[1]);
  assert.equal(options.tools[0].parameters, src.tools[0].parameters, "parameters 不能被重建");
});

ok("toolHistory 的 tools 与 updates[].additions 都被洗", () => {
  const { options } = shieldOptions(fullOptions(), { provider: "workbuddy" });
  assert.equal(options.toolHistory.tools[0].description, `Grep. ${IDENTITY_OUT}`);
  assert.equal(options.toolHistory.updates[0].additions[0].description, `Glob. ${IDENTITY_OUT}`);
  assert.equal(options.toolHistory.updates[1].additions[0].description, "untouched");
});

ok("clean 请求返回原对象（零开销、可据此跳过重入）", () => {
  const src = { provider: "deepseek", model: "m", system: "plain", messages: [], tools: [{ name: "t", description: "plain", parameters: {} }] };
  const { options, stats } = shieldOptions(src, { provider: "deepseek" });
  assert.equal(options, src);
  assert.equal(stats.systemRewritten, false);
  assert.equal(stats.messagesRewritten, 0);
  assert.equal(stats.toolsRewritten, 0);
});

ok("四个面都改过时返回新对象，原对象不被污染", () => {
  const src = fullOptions();
  const before = JSON.stringify(src);
  const { options } = shieldOptions(src, { provider: "workbuddy" });
  assert.notEqual(options, src);
  assert.equal(JSON.stringify(src), before, "原 options 被改了 —— 冻结契约会静默失败");
});

// ---- 4) provider 来源：config 优先，其次 options.provider ----
ok("config 里的 provider 覆盖 options.provider", () => {
  const src = { provider: "deepseek", model: "m", system: CLAUDE, messages: [] };
  const withConfig = shieldOptions(src, { provider: "anthropic" });
  assert.ok(withConfig.options.system.includes("operator's CLI agent"), "config.provider 没生效");
  const withOptions = shieldOptions(src, {});
  assert.equal(withOptions.options, src, "options.provider=deepseek 时不该改 Claude 身份句");
});

ok("stats 带档位描述，日志能直接打", () => {
  const { stats } = shieldOptions(fullOptions(), { provider: "workbuddy" });
  assert.match(stats.profile, /^workbuddy\(measured, \d+ 条\)$/);
});

// ---- 5) 角色边界 ----
ok("scansRole 只认 system / developer / assistant", () => {
  for (const r of ["system", "developer", "assistant", "System", " MODEL "]) assert.equal(scansRole(r), true, r);
  for (const r of ["user", "tool", "", null, undefined, 1]) assert.equal(scansRole(r), false, String(r));
});

console.log("");
console.log(`${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);