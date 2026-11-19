#!/usr/bin/env node
/**
 * dsh-gateway-shield 辅助工具。
 *
 * ## 它负责什么
 *
 * 三件事，按顺序：
 *
 *   1. **放文件** —— 把包复制进 `<profile>/node_modules/dsh-gateway-shield`
 *      （pnpm/npm 装的话这一步已经由包管理器做了，跳过即可）
 *   2. **登记** —— 把包名追加进 profile 的 `dsh.profile.bundles`
 *      DSH 只从这里读组合包；只放文件不登记，启动时一行都不会跑
 *   3. **可选：装齐搭档** —— `--with-companions` 把 dsh-purge / 两个连接器
 *      一并装上并登记，一条命令到达「能用」的状态
 *
 * 早期版本没有 `dsh.bundle` 声明，只能靠往 profile 的 `cordis.patch.yml`
 * 手写注册块。现在有声明了，那段手写块就是重复注册 —— 但**必须等第 2 步
 * 登记成功之后**才能摘，否则会出现「文件在、注册没了」的孤儿状态。
 *
 * 用法：
 *   node install.mjs                        放文件 + 登记
 *   node install.mjs --with-companions      再装齐 dsh-purge + 两个连接器
 *   node install.mjs --only dsh-qoder-connect --with-companions
 *   node install.mjs --verify               体检：文件 / 声明 / 登记 / 搭档
 *   node install.mjs --clean                清掉早期版本的手写注册块
 *   node install.mjs --dry-run              只打印计划，不动盘
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundles, hasMarkerBlock, readManifest, stripMarkerBlock } from "./lib/profile.js";
import {
  COMPANIONS,
  describePlan,
  detectInstalled,
  installCompanions,
  planCompanions,
  registerBundles,
} from "./lib/companions.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
}
/** 可重复、可逗号分隔：--only a,b --only c */
function list(name) {
  const out = [];
  args.forEach((a, i) => {
    if (a !== `--${name}`) return;
    const v = args[i + 1];
    if (!v || v.startsWith("--")) return;
    for (const part of v.split(",")) if (part.trim() !== "") out.push(part.trim());
  });
  return out;
}

const DRY = has("dry-run");
const VERIFY = has("verify");
const CLEAN = has("clean");
const WITH_COMPANIONS = has("with-companions") || has("all") || list("only").length > 0;

const ID = "dsh-gateway-shield";

const DSH_HOME = opt("dsh-home", process.env.DSH_HOME?.trim() || path.join(HOME, ".dsh"));
const BACKUP_DIR = path.join(DSH_HOME, "dsh-purge", "gateway-shield-backups");

/** 要复制的文件。cordis.patch.yml 是注册凭据，必须带上。 */
const SHIP = ["lib", "scripts", "cordis.patch.yml", "package.json", "README.md", "CHANGELOG.md", "LICENSE", "install.mjs"];

const log = (m = "") => console.log(m);

function resolveProfile() {
  const explicit = opt("profile", null);
  const profilesDir = path.join(DSH_HOME, "profiles");
  if (!fs.existsSync(profilesDir)) {
    log(`✗ 找不到 ${profilesDir}。用 --dsh-home 指定 DSH 数据目录。`);
    process.exit(1);
  }
  if (explicit) {
    const p = path.join(profilesDir, explicit);
    if (!fs.existsSync(p)) {
      log(`✗ ${p} 不存在`);
      process.exit(1);
    }
    return { name: explicit, dir: p };
  }
  const candidates = fs
    .readdirSync(profilesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => fs.existsSync(path.join(profilesDir, n, "package.json")));
  const pick = candidates.includes("web") ? "web" : candidates[0];
  if (!pick) {
    log(`✗ ${profilesDir} 下没有可用 profile`);
    process.exit(1);
  }
  return { name: pick, dir: path.join(profilesDir, pick) };
}

const profile = resolveProfile();
const TARGET = path.join(profile.dir, "node_modules", ID);
const PROFILE_PATCH = path.join(profile.dir, "cordis.patch.yml");

/** 递归复制，原地覆盖。不 rename —— Windows 上目标被占用时 rename 会 EBUSY。 */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (["node_modules", ".git"].includes(e.name)) continue;
    if (e.name.endsWith(".bak") || e.name.includes(".bak-")) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) n += copyDir(s, d);
    else {
      fs.copyFileSync(s, d);
      n += 1;
    }
  }
  return n;
}

/** 本包自己的 manifest 是否声明了 bundle。 */
function readBundleDeclaration() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8"));
    const p = j?.dsh?.bundle?.patch;
    if (typeof p !== "string" || p === "") return { ok: false, reason: "package.json 缺 dsh.bundle.patch" };
    const abs = path.resolve(HERE, p);
    if (!fs.existsSync(abs)) return { ok: false, reason: `声明的 patch 文件不存在：${p}` };
    return { ok: true, rel: p, abs };
  } catch (e) {
    return { ok: false, reason: `读 package.json 失败：${e.message}` };
  }
}

/** profile 的 bundles 是否已经接管本包。 */
function profileRegistered(id = ID) {
  const read = readManifest(profile.dir);
  if (!read.ok) return { ok: false, listed: false, error: read.error };
  const bundles = read.manifest?.dsh?.profile?.bundles ?? [];
  return { ok: true, listed: Array.isArray(bundles) && bundles.includes(id) };
}

function verify() {
  let bad = 0;
  log(`体检 ${ID}`);
  log(`  profile ${profile.name}`);
  log(`  安装点  ${TARGET}`);
  log("");

  // 1) 文件完整
  for (const f of ["package.json", "lib/index.js", "lib/sanitize.js", "lib/refusal.js", "lib/companions.js", "lib/profile.js", "cordis.patch.yml"]) {
    const ok = fs.existsSync(path.join(TARGET, f));
    log(`${ok ? "✓" : "✗"} ${f}`);
    if (!ok) bad += 1;
  }

  // 2) 声明正确（用目标位置的 manifest，不是源目录）
  let decl = { ok: false, reason: "未安装" };
  try {
    const j = JSON.parse(fs.readFileSync(path.join(TARGET, "package.json"), "utf8"));
    const p = j?.dsh?.bundle?.patch;
    if (typeof p === "string" && fs.existsSync(path.join(TARGET, p))) {
      decl = { ok: true, rel: p, version: j.version };
    } else {
      decl = { ok: false, reason: "dsh.bundle.patch 缺失或指向的文件不存在" };
    }
  } catch (e) {
    decl = { ok: false, reason: e.message };
  }
  log(`${decl.ok ? "✓" : "✗"} dsh.bundle.patch = ${decl.ok ? decl.rel : decl.reason}`);
  if (!decl.ok) bad += 1;

  // 3) 登记情况 —— 这一项才是「会不会真的加载」
  const reg = profileRegistered();
  if (!reg.ok) {
    log(`✗ ${reg.error}`);
    bad += 1;
  } else if (reg.listed) {
    log(`✓ dsh.profile.bundles 已收录（DSH 启动时会加载）`);
  } else {
    const legacy = fs.existsSync(PROFILE_PATCH) && hasMarkerBlock(fs.readFileSync(PROFILE_PATCH, "utf8"), ID);
    log(
      legacy
        ? `· dsh.profile.bundles 未收录，但 cordis.patch.yml 里有手写块 —— 目前靠它挂载`
        : `✗ dsh.profile.bundles 未收录：文件在，但 DSH 启动时不会加载`,
    );
    if (!legacy) bad += 1;
  }

  // 4) 搭档三件套
  log("");
  log("搭档：");
  const installed = detectInstalled(profile.dir);
  const bundles = new Set(readManifest(profile.dir).manifest?.dsh?.profile?.bundles ?? []);
  for (const c of COMPANIONS) {
    const s = installed.get(c.id);
    const listed = bundles.has(c.id);
    const mark = s?.installed ? (listed ? "✓" : "·") : "·";
    const state = s?.installed ? `v${s.version}` : "未装";
    const note = s?.installed && !listed ? "  装了但没登记（DSH 不会加载）" : "";
    log(`${mark} ${c.id.padEnd(22)} ${state.padEnd(10)} ${c.role}${note}`);
  }
  const missing = COMPANIONS.filter((c) => !installed.get(c.id)?.installed);
  if (missing.length > 0) {
    log(`  补齐：node install.mjs --with-companions${list("only").length ? ` --only ${list("only").join(",")}` : ""}`);
  }

  log("");
  if (bad === 0) {
    log("就位。插件管理器应能识别；重启 DSH 后生效。");
  } else {
    log(`${bad} 项不合格。`);
    process.exitCode = 1;
  }
}

function install() {
  const decl = readBundleDeclaration();
  if (!decl.ok) {
    log(`✗ 本包未正确声明 dsh.bundle：${decl.reason}`);
    process.exit(1);
  }

  log(`安装 ${ID}`);
  log(`  profile ${profile.name}`);
  log(`  目标    ${TARGET}`);
  log(`  声明    dsh.bundle.patch = ${decl.rel}`);
  log("");

  if (DRY) {
    log(`[dry-run] 将覆盖 ${SHIP.join(", ")}`);
  } else {
    fs.mkdirSync(TARGET, { recursive: true });
    let n = 0;
    for (const item of SHIP) {
      const s = path.join(HERE, item);
      if (!fs.existsSync(s)) continue;
      const d = path.join(TARGET, item);
      if (fs.statSync(s).isDirectory()) n += copyDir(s, d);
      else {
        fs.copyFileSync(s, d);
        n += 1;
      }
    }
    log(`✓ ${n} 个文件已覆盖`);
  }

  // ---- 登记：DSH 只认 dsh.profile.bundles ----
  const alreadyListed = profileRegistered().listed;
  const reg = DRY ? { ok: true, changed: !alreadyListed, backup: null } : ensureBundles(profile.dir, [ID], { backupDir: BACKUP_DIR });
  if (DRY) {
    log(alreadyListed ? `[dry-run] 已在 dsh.profile.bundles 中，不会改动` : `[dry-run] 将把 ${ID} 追加进 dsh.profile.bundles`);
  } else if (!reg.ok) {
    log(`✗ 登记失败：${reg.error}`);
    process.exitCode = 1;
  } else if (reg.changed) {
    log(`✓ 已登记进 dsh.profile.bundles${reg.backup ? `（备份 ${path.basename(reg.backup)}）` : ""}`);
  } else {
    log(`✓ dsh.profile.bundles 已收录`);
  }

  // ---- 手写块：登记成功之后才摘，顺序不能反 ----
  const covered = DRY ? true : profileRegistered().listed;
  if (fs.existsSync(PROFILE_PATCH) && covered) {
    const txt = fs.readFileSync(PROFILE_PATCH, "utf8");
    if (hasMarkerBlock(txt, ID)) {
      if (DRY) {
        log("[dry-run] 将摘掉 cordis.patch.yml 里的手写注册块");
      } else {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        const bak = path.join(BACKUP_DIR, `cordis.patch.yml.${stamp}`);
        fs.copyFileSync(PROFILE_PATCH, bak);
        fs.writeFileSync(PROFILE_PATCH, stripMarkerBlock(txt, ID), "utf8");
        log(`✓ 已摘掉手写注册块（备份 ${path.basename(bak)}）`);
      }
    }
  }

  // ---- 可选：搭档三件套 ----
  if (WITH_COMPANIONS) {
    log("");
    installCompanionSet();
  }

  log("");
  log("完成。重启 DSH 后生效：");
  log("  设置 → 插件 里应能看到 dsh-gateway-shield，并且可以开关");
  log("  日志里应出现 [gateway-shield] active …");
}

function installCompanionSet() {
  const plan = planCompanions({
    profileDir: profile.dir,
    only: list("only"),
    skip: list("skip"),
    pm: opt("pm", undefined),
  });

  if (plan.unknown.length > 0) {
    log(`✗ 未知的插件 id：${plan.unknown.join(", ")}`);
    log(`  可选：${COMPANIONS.map((c) => c.id).join(" / ")}`);
    process.exitCode = 1;
    return;
  }

  log(`搭档（包管理器 ${plan.pm}）：`);
  for (const line of describePlan(plan)) log(`  ${line}`);
  for (const w of plan.warnings) log(`  ! ${w}`);

  const res = installCompanions({
    profileDir: profile.dir,
    backupDir: BACKUP_DIR,
    plan,
    dryRun: DRY,
  });

  if (!res.ran && res.reason === "nothing-missing") {
    log("  全部已就位，无需安装");
  } else if (res.reason === "dry-run") {
    log(`  [dry-run] 将执行：${res.command}`);
  } else if (!res.ok) {
    log(`  ✗ ${res.error}`);
    if (res.hint) log(`  ${res.hint}`);
    if (res.backups?.length) log(`  备份：${res.backups.map((b) => path.basename(b)).join(", ")}`);
    process.exitCode = 1;
    return;
  } else {
    log(`  ✓ ${res.command}`);
    for (const r of res.results) log(`  ✓ ${r.id.padEnd(22)} v${r.version ?? "?"}`);
  }

  const reg = registerBundles({
    profileDir: profile.dir,
    ids: plan.items.filter((i) => i.installed || res.results.some((r) => r.id === i.id && r.installed)).map((i) => i.id),
    backupDir: BACKUP_DIR,
    dryRun: DRY,
  });

  if (DRY) {
    log(
      reg.added.length > 0
        ? `  [dry-run] 将把 ${reg.added.join(", ")} 追加进 dsh.profile.bundles`
        : `  [dry-run] 已在 dsh.profile.bundles 中，不会改动`,
    );
  } else if (!reg.ok) {
    log(`  ✗ 登记失败：${reg.error}`);
    process.exitCode = 1;
  } else if (reg.added.length > 0) {
    log(`  ✓ 已登记：${reg.added.join(", ")}`);
  } else {
    log(`  · dsh.profile.bundles 已收录，无需改动`);
  }
  if (reg.skipped?.length) {
    for (const s of reg.skipped) log(`  ! ${s.name} 跳过登记：${s.reason}`);
  }
  const needLogin = plan.items.filter((i) => i.login && (i.installed || reg.added.includes(i.id)));
  if (needLogin.length > 0) {
    log(`  · ${needLogin.map((i) => i.title).join(" / ")} 还需要在本机登录一次对应客户端，模型才会出现`);
  }
}

function clean() {
  if (!fs.existsSync(PROFILE_PATCH)) {
    log("没有 profile patch 文件");
    return;
  }
  const txt = fs.readFileSync(PROFILE_PATCH, "utf8");
  if (!hasMarkerBlock(txt, ID)) {
    log("没有需要清理的手写注册块");
    return;
  }
  if (!profileRegistered().listed) {
    log("✗ dsh.profile.bundles 里没有本包。现在摘掉手写块，插件就彻底不会被加载。");
    log("  先跑 node install.mjs 让它进 bundles，再回来清。");
    process.exitCode = 1;
    return;
  }
  if (DRY) {
    log("[dry-run] 将清掉手写注册块");
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const bak = path.join(BACKUP_DIR, `cordis.patch.yml.${stamp}`);
  fs.copyFileSync(PROFILE_PATCH, bak);
  fs.writeFileSync(PROFILE_PATCH, stripMarkerBlock(txt, ID), "utf8");
  log(`✓ 已清掉手写注册块（备份 ${path.basename(bak)}）`);
  log("插件本身仍在 node_modules，由 dsh.profile.bundles 注册。");
}

if (VERIFY) verify();
else if (CLEAN) clean();
else install();