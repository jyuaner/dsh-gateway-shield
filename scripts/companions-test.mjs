#!/usr/bin/env node
/**
 * 搭档安装器自测。零依赖、零网络：node scripts/companions-test.mjs
 *
 * 测的是「一条命令装齐三件套」那条路，用的是临时 fixture profile：
 *   - 选子集 / 未知 id / Node 版本下限
 *   - 先检测：已装的跳过、只下载缺的；毒清单会被当成「没就位」
 *   - 只发一条包管理器命令、装完复查目录
 *   - 失败时的备份与回滚线索
 *   - 幂等：第二次跑是 no-op
 *   - 登记：追加进 dsh.profile.bundles，保持既有顺序，拒绝没有 dsh.bundle 的包
 *   - 登记：拒绝会让 DSH 起不来的清单（0.3.0 事故的闸门）
 *   - 手写块摘除：有缩进、有相邻条目也不误伤
 *   - 端到端：默认就处理搭档；`--no-companions` 完全不碰；`--dry-run` 一个字节都不写
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  COMPANIONS,
  COMPANION_IDS,
  detectInstalled,
  detectPackageManager,
  installCompanions,
  nodeSatisfied,
  planCompanions,
  pmCommand,
  registerBundles,
  selectCompanions,
  specOf,
} from "../lib/companions.js";
import { bundlesOf, ensureBundles, hasMarkerBlock, stripMarkerBlock } from "../lib/profile.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALL = path.join(HERE, "..", "install.mjs");

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

// ---------------------------------------------------------------- fixture

const tmpRoots = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
};
process.on("exit", () => {
  for (const dir of tmpRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清不掉不影响断言结果 */
    }
  }
});

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** 造一个只装了 `ids` 的 profile 目录。 */
function makeProfile({ ids = [], lock = "pnpm-lock.yaml", extraDeps = {} } = {}) {
  const dir = tmp("shield-profile-");
  const manifest = {
    name: "dsh-profile-web",
    private: true,
    dependencies: { "ds-harness-remote": "^0.6.4", ...extraDeps },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
  };
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, lock), "lockfileVersion: '9.0'\n");
  for (const id of ids) fakeInstall(dir, id, "1.0.0");
  return dir;
}

function fakeInstall(dir, id, version) {
  const pkg = path.join(dir, "node_modules", id);
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    `${JSON.stringify({ name: id, version, dsh: { bundle: { patch: "./cordis.patch.yml" } } }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(pkg, "cordis.patch.yml"), "- insert: []\n");
  const manifestFile = path.join(dir, "package.json");
  if (fs.existsSync(manifestFile)) {
    const m = readJson(manifestFile);
    m.dependencies = { ...(m.dependencies ?? {}), [id]: "1.0.0" };
    fs.writeFileSync(manifestFile, `${JSON.stringify(m, null, 2)}\n`);
  }
  return pkg;
}

/** 造一个「装了但没有 dsh.bundle 声明」的普通依赖。 */
function fakePlainDep(dir, id) {
  const pkg = path.join(dir, "node_modules", id);
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), `${JSON.stringify({ name: id, version: "0.0.1" })}\n`);
}

/**
 * 把已装的包改成「声明了 dsh.client 却没有 ./client 入口」的毒清单。
 * 这是 0.3.0 让 DSH 起不来的真实形态，用来验证检测/登记两道闸门。
 */
function poisonManifest(dir, id, version = "0.3.0") {
  const pkg = path.join(dir, "node_modules", id);
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    `${JSON.stringify(
      {
        name: id,
        version,
        exports: { ".": "./lib/index.js" },
        dsh: { bundle: { patch: "./cordis.patch.yml" }, client: { platform: "web" } },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(path.join(pkg, "cordis.patch.yml"), "- insert: []\n");
  return pkg;
}

// ---------------------------------------------------------------- 表

test("三件套表形状", () => {
  assert.equal(COMPANIONS.length, 3);
  assert.deepEqual(COMPANION_IDS, ["dsh-purge-community", "dsh-connect-workbuddy", "dsh-qoder-connect"]);
  const ids = new Set(COMPANIONS.map((c) => c.id));
  assert.equal(ids.size, 3, "id 不能重复");
  for (const c of COMPANIONS) {
    assert.match(c.repo, /^[\w.-]+\/[\w.-]+$/, `${c.id} 的 repo 不是 owner/name`);
    assert.ok(["行为", "路由"].includes(c.layer), `${c.id} 的层`);
    assert.ok(Array.isArray(c.minNode) && c.minNode.length === 2, `${c.id} 的 minNode`);
    assert.equal(specOf(c), `github:${c.repo}`);
  }
});

test("两个连接器要求 Node 22.19，purge 只要 18", () => {
  const byId = new Map(COMPANIONS.map((c) => [c.id, c]));
  assert.deepEqual(byId.get("dsh-connect-workbuddy").minNode, [22, 19]);
  assert.deepEqual(byId.get("dsh-qoder-connect").minNode, [22, 19]);
  assert.deepEqual(byId.get("dsh-purge-community").minNode, [18, 0]);
});

// ---------------------------------------------------------------- 选子集

test("默认全选，顺序即安装顺序", () => {
  const { selected, unknown } = selectCompanions();
  assert.equal(selected.length, 3);
  assert.deepEqual(selected.map((c) => c.id), COMPANION_IDS);
  assert.deepEqual(unknown, []);
});

test("--only 取子集", () => {
  const { selected } = selectCompanions({ only: ["dsh-qoder-connect"] });
  assert.deepEqual(selected.map((c) => c.id), ["dsh-qoder-connect"]);
});

test("--skip 排除", () => {
  const { selected } = selectCompanions({ skip: ["dsh-purge-community"] });
  assert.deepEqual(selected.map((c) => c.id), ["dsh-connect-workbuddy", "dsh-qoder-connect"]);
});

test("--only 与 --skip 同时用，skip 优先", () => {
  const { selected } = selectCompanions({ only: ["dsh-purge-community", "dsh-qoder-connect"], skip: ["dsh-qoder-connect"] });
  assert.deepEqual(selected.map((c) => c.id), ["dsh-purge-community"]);
});

test("未知 id 单独回报，不静默吞掉", () => {
  const { selected, unknown } = selectCompanions({ only: ["dsh-qoder-connect", "dsh-pruge"] });
  assert.deepEqual(selected.map((c) => c.id), ["dsh-qoder-connect"]);
  assert.deepEqual(unknown, ["dsh-pruge"]);
});

// ---------------------------------------------------------------- 版本

test("Node 下限判定", () => {
  assert.equal(nodeSatisfied([22, 19], "22.19.0"), true);
  assert.equal(nodeSatisfied([22, 19], "22.18.9"), false);
  assert.equal(nodeSatisfied([22, 19], "24.0.0"), true);
  assert.equal(nodeSatisfied([22, 19], "20.11.1"), false);
  assert.equal(nodeSatisfied([18, 0], "18.20.4"), true);
  assert.equal(nodeSatisfied([18, 0], "20.0.0"), true);
  assert.equal(nodeSatisfied([18, 0], "v24.19.0"), true);
});

// ---------------------------------------------------------------- 计划

test("空 profile：三个都缺，用 pnpm 一条命令", () => {
  const dir = makeProfile();
  const plan = planCompanions({ profileDir: dir, nodeVersion: "24.19.0" });
  assert.equal(plan.pm, "pnpm");
  assert.equal(plan.todo.length, 3);
  assert.deepEqual(plan.todo.map((t) => t.spec), [
    "github:kingcharleslzy-ai/dsh-purge",
    "github:dingminhua/dsh-connect-workbuddy",
    "github:masknull/dsh-qoder-connect",
  ]);
  assert.deepEqual(plan.warnings, []);
});

test("已装的跳过，缺的才装", () => {
  const dir = makeProfile({ ids: ["dsh-purge-community"] });
  const plan = planCompanions({ profileDir: dir, nodeVersion: "24.19.0" });
  const purge = plan.items.find((i) => i.id === "dsh-purge-community");
  assert.equal(purge.action, "skip");
  assert.equal(purge.installed, true);
  assert.equal(purge.version, "1.0.0");
  assert.equal(plan.todo.length, 2);
});

test("Node 太老时对连接器出告警", () => {
  const dir = makeProfile();
  const plan = planCompanions({ profileDir: dir, nodeVersion: "20.11.1" });
  assert.equal(plan.warnings.length, 2, plan.warnings.join(" | "));
  assert.ok(plan.warnings.every((w) => w.includes("22.19")));
});

test("--pm 覆盖包管理器探测", () => {
  const dir = makeProfile();
  assert.equal(planCompanions({ profileDir: dir, pm: "npm" }).pm, "npm");
});

test("包管理器按 lockfile 探测", () => {
  assert.equal(detectPackageManager(makeProfile({ lock: "pnpm-lock.yaml" })), "pnpm");
  assert.equal(detectPackageManager(makeProfile({ lock: "package-lock.json" })), "npm");
});

test("命令形状", () => {
  assert.deepEqual(pmCommand("pnpm", ["github:a/b"]), { cmd: "pnpm", args: ["add", "--save-prod", "github:a/b"] });
  assert.deepEqual(pmCommand("npm", ["github:a/b"]), { cmd: "npm", args: ["install", "--save-prod", "github:a/b"] });
});

// ---------------------------------------------------------------- 执行

test("dry-run 不执行、不写备份", () => {
  const dir = makeProfile();
  const plan = planCompanions({ profileDir: dir, nodeVersion: "24.19.0" });
  let called = false;
  const res = installCompanions({
    profileDir: dir,
    backupDir: path.join(dir, ".bak"),
    plan,
    dryRun: true,
    run: () => {
      called = true;
      return { code: 0 };
    },
  });
  assert.equal(called, false);
  assert.equal(res.reason, "dry-run");
  assert.equal(res.backups.length, 0);
  assert.match(res.command, /^pnpm add --save-prod github:/);
  assert.equal(fs.existsSync(path.join(dir, ".bak")), false);
});

test("成功路径：一条命令装完全部，并复查目录", () => {
  const dir = makeProfile();
  const backupDir = path.join(dir, ".bak");
  const plan = planCompanions({ profileDir: dir, nodeVersion: "24.19.0" });
  const calls = [];
  const res = installCompanions({
    profileDir: dir,
    backupDir,
    plan,
    run: (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts.cwd });
      // 模拟包管理器的效果
      for (const spec of args.slice(2)) {
        const repo = spec.replace(/^github:/, "");
        const id = COMPANIONS.find((c) => c.repo === repo).id;
        fakeInstall(dir, id, "9.9.9");
      }
      return { code: 0 };
    },
  });

  assert.equal(calls.length, 1, "只该发一条包管理器命令");
  assert.equal(calls[0].cwd, dir);
  assert.equal(calls[0].args.length, 2 + 3);
  assert.equal(res.ok, true);
  assert.equal(res.results.length, 3);
  assert.ok(res.results.every((r) => r.installed && r.version === "9.9.9"));
  assert.ok(res.backups.some((b) => b.includes("package.json")));
  assert.ok(res.backups.some((b) => b.includes("pnpm-lock.yaml")), "改依赖会动 lockfile，必须备份");
  assert.ok(res.backups.every((b) => fs.existsSync(b)));
});

test("失败路径：报错带备份与回滚线索", () => {
  const dir = makeProfile();
  const plan = planCompanions({ profileDir: dir, nodeVersion: "24.19.0" });
  const res = installCompanions({
    profileDir: dir,
    backupDir: path.join(dir, ".bak"),
    plan,
    run: () => ({ code: 1, error: "ERR_PNPM_UNSUPPORTED_ENGINE" }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 1);
  assert.match(res.error, /UNSUPPORTED_ENGINE/);
  assert.match(res.hint, /覆盖回去/);
  assert.ok(res.backups.length >= 1);
});

test("命令成功但目录没出现 → 也不算成功", () => {
  const dir = makeProfile();
  const plan = planCompanions({ profileDir: dir, nodeVersion: "24.19.0" });
  const res = installCompanions({ profileDir: dir, plan, run: () => ({ code: 0 }) });
  assert.equal(res.ok, false);
  assert.equal(res.failures.length, 3);
  assert.match(res.error, /目录没出现/);
});

test("幂等：第二次是 no-op", () => {
  const dir = makeProfile({ ids: COMPANION_IDS });
  const plan = planCompanions({ profileDir: dir, nodeVersion: "24.19.0" });
  assert.equal(plan.todo.length, 0);
  let called = false;
  const res = installCompanions({
    profileDir: dir,
    plan,
    run: () => {
      called = true;
      return { code: 0 };
    },
  });
  assert.equal(called, false);
  assert.equal(res.reason, "nothing-missing");
  assert.equal(res.ok, true);
});

test("detectInstalled 读出版本", () => {
  const dir = makeProfile({ ids: ["dsh-qoder-connect"] });
  const state = detectInstalled(dir, ["dsh-qoder-connect", "dsh-purge-community"]);
  assert.equal(state.get("dsh-qoder-connect").installed, true);
  assert.equal(state.get("dsh-qoder-connect").version, "1.0.0");
  assert.equal(state.get("dsh-qoder-connect").startable, true);
  assert.equal(state.get("dsh-purge-community").installed, false);
});

test("先检测：已装且健康的不进下载清单", () => {
  const dir = makeProfile({ ids: COMPANION_IDS });
  const plan = planCompanions({ profileDir: dir, nodeVersion: "24.19.0" });
  assert.deepEqual(plan.todo, [], "没有缺的就不该有下载项");
  assert.deepEqual(plan.summary, { total: 3, skipped: 3, download: 0 });
});

test("先检测：毒清单不算「已就位」，会被要求重装并告警", () => {
  const dir = makeProfile({ ids: ["dsh-purge-community"] });
  poisonManifest(dir, "dsh-purge-community");
  const plan = planCompanions({ profileDir: dir, nodeVersion: "24.19.0" });
  const item = plan.items.find((i) => i.id === "dsh-purge-community");
  assert.equal(item.installed, true);
  assert.equal(item.broken, true);
  assert.equal(item.action, "install", "坏的要重装，不是跳过");
  assert.equal(plan.summary.skipped, 0);
  assert.equal(plan.summary.download, 3);
  assert.ok(
    plan.warnings.some((w) => w.includes("会让 DSH 起不来")),
    plan.warnings.join(" | "),
  );
});

// ---------------------------------------------------------------- 登记

test("登记：追加进 dsh.profile.bundles，保持既有顺序", () => {
  const dir = makeProfile({ ids: COMPANION_IDS });
  const before = readJson(path.join(dir, "package.json"));
  const res = registerBundles({ profileDir: dir, ids: COMPANION_IDS, backupDir: path.join(dir, ".bak") });
  assert.equal(res.ok, true);
  assert.deepEqual(res.added, COMPANION_IDS);
  const after = readJson(path.join(dir, "package.json"));
  assert.deepEqual(bundlesOf(after), [...bundlesOf(before), ...COMPANION_IDS]);
  assert.ok(res.backup && fs.existsSync(res.backup));
});

test("登记：第二次 no-op", () => {
  const dir = makeProfile({ ids: COMPANION_IDS });
  registerBundles({ profileDir: dir, ids: COMPANION_IDS, backupDir: path.join(dir, ".bak") });
  const again = registerBundles({ profileDir: dir, ids: COMPANION_IDS, backupDir: path.join(dir, ".bak") });
  assert.equal(again.changed, false);
  assert.deepEqual(again.added, []);
  assert.deepEqual(again.already, COMPANION_IDS);
});

test("登记：拒绝没有 dsh.bundle 的包", () => {
  const dir = makeProfile({ ids: ["dsh-qoder-connect"] });
  fakePlainDep(dir, "left-pad");
  const res = ensureBundles(dir, ["left-pad"], { backupDir: path.join(dir, ".bak") });
  assert.equal(res.ok, true);
  assert.deepEqual(res.added, []);
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0].reason, /dsh\.bundle/);
});

test("登记：包目录不存在时跳过而不是写进清单", () => {
  const dir = makeProfile();
  const res = ensureBundles(dir, ["dsh-qoder-connect"]);
  assert.deepEqual(res.added, []);
  assert.equal(res.skipped.length, 1);
  assert.equal(res.changed, false);
});

test("登记：拒绝会让 DSH 起不来的清单", () => {
  const dir = makeProfile();
  poisonManifest(dir, "dsh-qoder-connect");
  const res = ensureBundles(dir, ["dsh-qoder-connect"], { backupDir: path.join(dir, ".bak") });
  assert.equal(res.ok, true);
  assert.deepEqual(res.added, [], "毒清单不许进 dsh.profile.bundles");
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0].reason, /起不来/);
  assert.deepEqual(bundlesOf(readJson(path.join(dir, "package.json"))).filter((b) => b === "dsh-qoder-connect"), []);
});

test("登记：registerBundles 也拦住毒清单", () => {
  const dir = makeProfile();
  poisonManifest(dir, "dsh-purge-community");
  const res = registerBundles({ profileDir: dir, ids: ["dsh-purge-community"], backupDir: path.join(dir, ".bak") });
  assert.deepEqual(res.added, []);
  assert.match(res.skipped[0].reason, /起不来/);
});

test("登记 dry-run：只报真正会新增的，且不写盘", () => {
  const dir = makeProfile({ ids: COMPANION_IDS });
  registerBundles({ profileDir: dir, ids: ["dsh-qoder-connect"] });
  const dry = registerBundles({ profileDir: dir, ids: COMPANION_IDS, dryRun: true });
  assert.deepEqual(dry.added, ["dsh-purge-community", "dsh-connect-workbuddy"]);
  assert.deepEqual(dry.already, ["dsh-qoder-connect"]);
  const bundles = bundlesOf(readJson(path.join(dir, "package.json")));
  assert.deepEqual(bundles.filter((b) => COMPANION_IDS.includes(b)), ["dsh-qoder-connect"]);
});

// ---------------------------------------------------------------- 手写块

test("摘手写块：带缩进、与相邻条目共存", () => {
  const text = [
    "- insert:",
    "    - id: dsh-purge",
    "      name: dsh-purge-community",
    "    # >>> dsh-gateway-shield",
    "    - id: dsh-gateway-shield",
    "      name: dsh-gateway-shield",
    "      config:",
    "        enabled: true",
    "    # <<< dsh-gateway-shield",
    "    - id: dsh-connect-workbuddy",
    "      name: dsh-connect-workbuddy",
    "",
  ].join("\n");
  const out = stripMarkerBlock(text, "dsh-gateway-shield");
  assert.ok(!out.includes("dsh-gateway-shield"), "块还在");
  assert.ok(out.includes("dsh-purge-community"), "误伤了前面的条目");
  assert.ok(out.includes("dsh-connect-workbuddy"), "误伤了后面的条目");
  assert.equal(out.split("\n").filter((l) => l.trim() === "").length, 1, "空行不该堆积");
});

test("摘手写块：没有块时原样返回", () => {
  const text = "- insert:\n    - id: a\n";
  assert.equal(stripMarkerBlock(text, "dsh-gateway-shield"), text);
});

test("hasMarkerBlock 只在首尾都在时为真", () => {
  assert.equal(hasMarkerBlock("# >>> x\nbody\n# <<< x", "x"), true);
  assert.equal(hasMarkerBlock("# >>> x\nbody", "x"), false);
  assert.equal(hasMarkerBlock("# <<< x\nbody", "x"), false);
});

// ---------------------------------------------------------------- 端到端

/** 造一个临时 DSH_HOME（含 profiles/web）。 */
function makeHome({ installed = [] } = {}) {
  const home = tmp("shield-home-");
  const profileDir = path.join(home, "profiles", "web");
  fs.mkdirSync(profileDir, { recursive: true });
  const manifest = {
    name: "dsh-profile-web",
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
  };
  fs.writeFileSync(path.join(profileDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(profileDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  for (const id of installed) fakeInstall(profileDir, id, "1.0.0");
  return { home, profileDir };
}

test("install.mjs --dry-run：一个字节都不写", () => {
  const home = tmp("shield-home-");
  const profileDir = path.join(home, "profiles", "web");
  fs.mkdirSync(profileDir, { recursive: true });
  const manifest = {
    name: "dsh-profile-web",
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
  };
  fs.writeFileSync(path.join(profileDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(profileDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

  const res = spawnSync(process.execPath, [INSTALL, "--dry-run", "--with-companions", "--dsh-home", home], {
    encoding: "utf8",
  });
  const out = `${res.stdout}${res.stderr}`;
  assert.equal(res.status, 0, out);
  assert.match(out, /dry-run/);
  assert.match(out, /将把 dsh-gateway-shield 追加进 dsh\.profile\.bundles/);
  assert.match(out, /pnpm add --save-prod github:/);
  assert.deepEqual(readJson(path.join(profileDir, "package.json")), manifest, "清单被写了");
  assert.equal(fs.existsSync(path.join(profileDir, "node_modules", "dsh-gateway-shield")), false, "文件被复制了");
});

test("install.mjs 默认就处理搭档（一条命令）", () => {
  const { home } = makeHome();
  const res = spawnSync(process.execPath, [INSTALL, "--dry-run", "--dsh-home", home], { encoding: "utf8" });
  const out = `${res.stdout}${res.stderr}`;
  assert.equal(res.status, 0, out);
  assert.match(out, /先检测，只下载缺的/);
  assert.match(out, /已装 0 个 → 跳过；缺 3 个 →/);
  assert.match(out, /pnpm add --save-prod github:kingcharleslzy-ai\/dsh-purge/);
});

test("install.mjs --no-companions 完全不碰搭档", () => {
  const { home } = makeHome();
  const res = spawnSync(process.execPath, [INSTALL, "--dry-run", "--no-companions", "--dsh-home", home], {
    encoding: "utf8",
  });
  const out = `${res.stdout}${res.stderr}`;
  assert.equal(res.status, 0, out);
  assert.match(out, /跳过（--no-companions）/);
  assert.doesNotMatch(out, /pnpm add/, "不该出现任何下载命令");
});

test("install.mjs 全装好时不发起下载", () => {
  const { home } = makeHome({ installed: COMPANION_IDS });
  const res = spawnSync(process.execPath, [INSTALL, "--dry-run", "--dsh-home", home], { encoding: "utf8" });
  const out = `${res.stdout}${res.stderr}`;
  assert.equal(res.status, 0, out);
  assert.match(out, /已装 3 个 → 跳过；缺 0 个/);
  assert.match(out, /全部已就位，没有发起下载/);
  assert.doesNotMatch(out, /pnpm add/, "已装的不该再下载");
});

test("install.mjs 对毒清单搭档给出告警", () => {
  const { home, profileDir } = makeHome();
  poisonManifest(profileDir, "dsh-purge-community");
  const res = spawnSync(process.execPath, [INSTALL, "--dry-run", "--dsh-home", home], { encoding: "utf8" });
  const out = `${res.stdout}${res.stderr}`;
  assert.match(out, /会让 DSH 起不来/);
  assert.match(out, /已装 0 个 → 跳过；缺 3 个/);
});

test("install.mjs --verify：认得出「装了但没登记」", () => {
  const home = tmp("shield-home-");
  const profileDir = path.join(home, "profiles", "web");
  const pkg = path.join(profileDir, "node_modules", "dsh-gateway-shield");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, "package.json"),
    `${JSON.stringify({ name: "dsh-profile-web", dsh: { profile: { bundles: [] } } }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    `${JSON.stringify({ name: "dsh-gateway-shield", version: "0.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(pkg, "cordis.patch.yml"), "- insert: []\n");

  const res = spawnSync(process.execPath, [INSTALL, "--verify", "--dsh-home", home], { encoding: "utf8" });
  const out = `${res.stdout}${res.stderr}`;
  assert.match(out, /dsh\.profile\.bundles 未收录/);
  assert.match(out, /启动时不会加载|不会加载/);
  assert.equal(res.status, 1, "未登记应当算不合格");
});

// ---------------------------------------------------------------- 汇总

console.log(lines.join("\n"));
const failed = lines.filter((l) => l.startsWith("FAIL")).length;
console.log("");
console.log(`${pass} 通过 / ${failed} 失败`);
if (failed > 0) process.exitCode = 1;