#!/usr/bin/env node
/**
 * dsh-gateway-shield 辅助工具。
 *
 * ## 它负责什么
 *
 * 四件事，按顺序：
 *
 *   0. **预检** —— 装上这份清单会不会让 DSH 起不来（lib/manifest.js）。
 *      0.3.0 就是漏了这一步：`dsh.client` 声明没有对应 `./client` 入口，
 *      宿主 `dsh-client-modules` 抛错 → `StartupError` → DSH 直接退出。
 *   1. **放文件** —— 把包复制进 `<profile>/node_modules/dsh-gateway-shield`
 *      （pnpm/npm 装的话这一步已经由包管理器做了，跳过即可）
 *   2. **登记** —— 把包名追加进 profile 的 `dsh.profile.bundles`
 *      DSH 只从这里读组合包；只放文件不登记，启动时一行都不会跑
 *   3. **搭档** —— dsh-purge / 两个连接器。默认一并处理，且**先检测**：
 *      已经在 profile 里的直接跳过，只下载缺的那几个。
 *
 * 早期版本没有 `dsh.bundle` 声明，只能靠往 profile 的 `cordis.patch.yml`
 * 手写注册块。现在有声明了，那段手写块就是重复注册 —— 但**必须等第 2 步
 * 登记成功之后**才能摘，否则会出现「文件在、注册没了」的孤儿状态。
 *
 * 用法：
 *   node install.mjs                        放文件 + 登记 + 顺带装破甲（dsh-purge）
 *   node install.mjs --with-companions      连两个连接器一起（WorkBuddy / Qoder）
 *   node install.mjs --no-companions        只装本体，一个搭档都不碰
 *   node install.mjs --only dsh-qoder-connect   只处理指定搭档（可逗号分隔）
 *   node install.mjs --skip dsh-purge
 *   node install.mjs --verify               体检：清单 / 文件 / 声明 / 登记 / 搭档
 *   node install.mjs --clean                清掉早期版本的手写注册块
 *   node install.mjs --dry-run              只打印计划，不动盘
 *
 * 搭档分两档：
 *   默认档 —— 破甲 `dsh-purge`（`byDefault: true`），装本体时一起装。
 *             没有它本插件只剩「清洗 + 重试」一半，模型依然不肯做。
 *   显式档 —— 两个连接器，要 `--with-companions` / `--all` 才装：Node ≥22.19，
 *             还要在本机登录一次客户端。
 *
 * 两档都遵守「先检测、只下载缺的」：已装且清单健康的直接 skip，不发网络请求，
 * 也就不会重写 lockfile。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundles, hasMarkerBlock, readManifest, stripMarkerBlock } from "./lib/profile.js";
import { checkPackage, describeProblems } from "./lib/manifest.js";
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
/** `--no-companions` 是唯一「一个搭档都不碰」的开关。 */
const NO_COMPANIONS = has("no-companions") || has("without-companions");
/** 显式要「全部搭档」：在默认集之外再补两个连接器。 */
const ALL_COMPANIONS = has("with-companions") || has("all");
/**
 * 0.6.2 起默认**顺带装破甲**。
 *
 * 只有破甲（`byDefault: true`）进默认路径：没有它，本插件只剩「清洗 + 重试」那一半，
 * 用户装完看到的仍然是「模型不肯做」。两个连接器不进默认路径 —— 它们要 Node ≥22.19
 * 且必须在本机登录一次，属于「你真要用 WorkBuddy / Qoder」才装的东西。
 *
 * 已经装过的破甲会被 detectInstalled 命中并 skip，**不会**触发 `pnpm add`，
 * 也就不会重写 lockfile —— 那正是 0.6.0 把它移出默认路径要躲的风险。
 */
const WITH_COMPANIONS = !NO_COMPANIONS;

const ID = "dsh-gateway-shield";

const DSH_HOME = opt("dsh-home", process.env.DSH_HOME?.trim() || path.join(HOME, ".dsh"));
const BACKUP_DIR = path.join(DSH_HOME, "dsh-purge", "gateway-shield-backups");

/** 要复制的文件。cordis.patch.yml 是注册凭据，armor/ 是整合入口，都必须带上。 */
const SHIP = ["lib", "armor", "scripts", "cordis.patch.yml", "package.json", "README.md", "CHANGELOG.md", "LICENSE", "install.mjs", "bootstrap.mjs"];

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

/**
 * 打印某份清单的体检结果。
 *
 * @returns {boolean} 是否「不会让 DSH 起不来」
 */
function reportManifest(label, result, { quietWhenClean = false } = {}) {
  if (result.problems.length === 0) {
    if (!quietWhenClean) {
      log(`✓ ${label} 清单健康（bundle 声明有效${result.clientDeclared ? "，client 入口齐全" : "，无 dsh.client 声明"}）`);
    }
    return true;
  }
  if (!result.startable) {
    log(`✗ ${label} 清单会让 DSH 启动失败：`);
  } else {
    log(`! ${label} 清单有问题（不至于阻断启动）：`);
  }
  log(describeProblems(result, "    "));
  return result.startable;
}

/**
 * 装前预检：*要装进 profile 的那份清单*会不会让 DSH 起不来。
 *
 * 0.3.0 的 `dsh.client` 事故就是缺了这一关 —— 安装器一路绿灯，
 * 重启后 DSH 抛 `ClientPackageCompositionError` 直接退出。
 */
function preflightInstall() {
  const self = checkPackage(HERE);
  if (!self.startable) {
    log("✗ 本包清单会让 DSH 启动失败，拒绝安装（不会动你的 profile）：");
    log(describeProblems(self, "    "));
    process.exit(1);
  }
  reportManifest("本包", self);
  return self;
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
  for (const f of ["package.json", "lib/index.js", "lib/sanitize.js", "lib/fingerprints.js", "lib/refusal.js", "lib/companions.js", "lib/profile.js", "lib/manifest.js", "armor/armor.mjs", "armor/detect.mjs", "cordis.patch.yml"]) {
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

  // 3) 启动安全 —— 这一项才是「装完重启会不会 DSH 直接起不来」
  //    0.3.0 的 dsh.client 事故在这里能被拦下。bundle 相关的问题上面已经报过。
  const safe = checkPackage(TARGET);
  const startupProblems = safe.problems.filter((p) => !p.code.startsWith("bundle-"));
  if (startupProblems.length === 0) {
    log(safe.clientDeclared ? "✓ 不影响启动（声明了 client 且有入口）" : "✓ 不影响启动（无 dsh.client 声明）");
  } else {
    log(describeProblems({ problems: startupProblems }, "  "));
    if (startupProblems.some((p) => p.fatal)) bad += 1;
  }

  // 4) 登记情况 —— 这一项才是「会不会真的加载」
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

  // 5) 搭档三件套（各自也有启动安全体检）
  log("");
  log("搭档：");
  const installed = detectInstalled(profile.dir);
  const bundles = new Set(readManifest(profile.dir).manifest?.dsh?.profile?.bundles ?? []);
  for (const c of COMPANIONS) {
    const s = installed.get(c.id);
    const listed = bundles.has(c.id);
    const broken = s?.installed && s.startable === false;
    const mark = broken ? "✗" : s?.installed ? (listed ? "✓" : "·") : "·";
    const state = s?.installed ? `v${s.version}` : "未装";
    const notes = [];
    if (s?.installed && !listed) notes.push("装了但没登记（DSH 不会加载）");
    if (broken) notes.push("清单会让 DSH 起不来");
    log(`${mark} ${c.id.padEnd(22)} ${state.padEnd(10)} ${c.role}${notes.length ? `  ${notes.join("；")}` : ""}`);
    if (broken) bad += 1;
  }
  const missing = COMPANIONS.filter((c) => !installed.get(c.id)?.installed);
  if (missing.length > 0) {
    log(`  补齐：node install.mjs --only ${missing.map((c) => c.id).join(",")}`);
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
  log(`  搭档    ${WITH_COMPANIONS ? `一并处理：默认装破甲${ALL_COMPANIONS ? " + 两个连接器" : ""}，先检测、只下载缺的` : "不碰（--no-companions）"}`);
  log("");

  // ---- 装前预检：这份清单会不会让 DSH 起不来 ----
  preflightInstall();
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

    // 落盘后按「装进去的那份」再复检：复制/残留文件都可能让清单变质。
    // 不合格就别登记了 —— 登记 = 下次启动一定加载这份清单。
    const installedCheck = checkPackage(TARGET);
    if (!reportManifest("已安装", installedCheck, { quietWhenClean: true })) {
      log("✗ 已安装的清单会让 DSH 启动失败，停止登记（你的 DSH 不会因此起不来）。");
      log("  处理：换成 0.3.1+ 的包重装，或手动修 package.json 里的 dsh.client 声明。");
      process.exitCode = 1;
      return;
    }
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

  // ---- 搭档：默认一并处理；先检测，只下载缺的 ----
  if (WITH_COMPANIONS) {
    log("");
    installCompanionSet();
  }

  log("");
  log("完成。重启 DSH 后生效：");
  log("  设置 → 插件 里应能看到 dsh-gateway-shield，并且可以开关");
  log("  日志里应出现 [gateway-shield] active …");
}

/**
 * 搭档安装失败的处理。
 *
 * 0.6.2 起默认就会装破甲，所以默认模式下失败也**算失败**：以前「只告警、
 * 退出码 0」是因为搭档纯属可选；现在用户不加参数就等于要了破甲，静默放过会
 * 让人以为装齐了。明确加了 `--no-companions` 的才不走到这里。
 */
function companionFailure(message) {
  log(`  ✗ ${message}`);
  process.exitCode = 1;
  log("  · 插件本体已装好；搭档可以之后补：node install.mjs --only <id>");
}

function installCompanionSet() {
  const plan = planCompanions({
    profileDir: profile.dir,
    only: list("only"),
    skip: list("skip"),
    all: ALL_COMPANIONS,
    pm: opt("pm", undefined),
  });

  if (plan.unknown.length > 0) {
    log(`✗ 未知的插件 id：${plan.unknown.join(", ")}`);
    log(`  可选：${COMPANIONS.map((c) => c.id).join(" / ")}`);
    process.exitCode = 1;
    return;
  }

  const { summary } = plan;
  log(`搭档（包管理器 ${plan.pm}）：已装 ${summary.skipped} 个 → 跳过；缺 ${summary.download} 个 → ${summary.download ? "下载" : "无需下载"}`);
  for (const line of describePlan(plan)) log(`  ${line}`);
  for (const w of plan.warnings) log(`  ! ${w}`);

  const res = installCompanions({
    profileDir: profile.dir,
    backupDir: BACKUP_DIR,
    plan,
    dryRun: DRY,
  });

  if (!res.ran && res.reason === "nothing-missing") {
    log("  · 全部已就位，没有发起下载");
  } else if (res.reason === "dry-run") {
    log(`  [dry-run] 将执行：${res.command}`);
  } else if (!res.ok) {
    companionFailure(res.error);
    if (res.hint) log(`  ${res.hint}`);
    if (res.backups?.length) log(`  备份：${res.backups.map((b) => path.basename(b)).join(", ")}`);
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
    companionFailure(`登记失败：${reg.error}`);
  } else if (reg.added.length > 0) {
    log(`  ✓ 已登记：${reg.added.join(", ")}`);
  } else {
    log(`  · dsh.profile.bundles 已收录，无需改动`);
  }
  if (reg.skipped?.length) {
    const sick = reg.skipped.filter((s) => String(s.reason).includes("起不来"));
    for (const s of reg.skipped) log(`  ! ${s.name} 跳过登记：${s.reason}`);
    if (sick.length > 0) companionFailure("有搭档的清单会让 DSH 起不来，已拒绝登记（不会写进 dsh.profile.bundles）");
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