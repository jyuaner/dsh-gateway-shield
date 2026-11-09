#!/usr/bin/env node
/**
 * dsh-gateway-shield 辅助工具。
 *
 * ## 重要：本文件不再负责「注册插件」
 *
 * package.json 里声明了 `dsh.bundle.patch` → `./cordis.patch.yml`，
 * DSH 的插件管理器（设置 → 插件）读取该声明后会自动把它挂上 profile。
 * 所以「装包」= 「完成注册」，不需要再往 profile 的 cordis.patch.yml 写任何东西。
 *
 * 早期版本没有这个声明，只能靠这个脚本手改配置。那条路有两个问题：
 *   1. 插件管理器认不出（提示「没有声明组合包」）
 *   2. 一旦补上声明，手写的条目就和 bundle 重复注册
 *
 * 现在它只做三件事：
 *   node install.mjs            把包复制到目标 profile（手动安装用；pnpm/npm 装则不需要）
 *   node install.mjs --verify   体检：文件完整 + 声明正确 + 是否已注册
 *   node install.mjs --clean    清掉早期版本可能残留的手写注册
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
}

const DRY = has("dry-run");
const VERIFY = has("verify");
const CLEAN = has("clean");

const ID = "dsh-gateway-shield";
const MARK_BEGIN = "    # >>> dsh-gateway-shield";
const MARK_END = "    # <<< dsh-gateway-shield";

const DSH_HOME = opt("dsh-home", process.env.DSH_HOME?.trim() || path.join(HOME, ".dsh"));

/** 要复制的文件。cordis.patch.yml 是注册凭据，必须带上。 */
const SHIP = ["lib", "scripts", "cordis.patch.yml", "package.json", "README.md", "LICENSE", "install.mjs"];

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

/** 清掉早期版本手写的注册块（有了 bundle 之后它会造成重复注册）。 */
function stripLegacyMarkers(text) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`\\n?${esc(MARK_BEGIN)}[\\s\\S]*?${esc(MARK_END)}\\n?`, "g"), "");
}

function verify() {
  let bad = 0;
  log(`体检 ${ID}`);
  log(`  profile ${profile.name}`);
  log(`  安装点  ${TARGET}`);
  log("");

  // 1) 文件完整
  for (const f of ["package.json", "lib/index.js", "lib/sanitize.js", "lib/refusal.js", "cordis.patch.yml"]) {
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
      decl = { ok: true, rel: p };
    } else {
      decl = { ok: false, reason: "dsh.bundle.patch 缺失或指向的文件不存在" };
    }
  } catch (e) {
    decl = { ok: false, reason: e.message };
  }
  log(`${decl.ok ? "✓" : "✗"} dsh.bundle.patch = ${decl.ok ? decl.rel : decl.reason}`);
  if (!decl.ok) bad += 1;

  // 3) profile 里的注册情况
  //
  // 双份注册无害：bundle patch 与 profile patch 各注册一次时，lib/index.js
  // 用 SHIELDED 标记保证只清洗一次、不会互相挡死（dup-test 实测 1/2/3 份
  // 都正常）。所以这里只做提示，不算不合格。
  if (fs.existsSync(PROFILE_PATCH)) {
    const txt = fs.readFileSync(PROFILE_PATCH, "utf8");
    const legacy = txt.includes(MARK_BEGIN);
    const manual = txt.includes(`- id: ${ID}`);
    if (legacy || manual) {
      log(`· profile 里有一处注册（${legacy ? "本工具手写" : "外部写入"}），与 bundle 并存无害`);
    } else {
      log(`✓ profile 无注册，由 dsh.bundle 单独接管`);
    }
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
    return;
  }

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

  // 有 bundle 声明之后，profile 里的手写注册就是重复的
  if (fs.existsSync(PROFILE_PATCH)) {
    const txt = fs.readFileSync(PROFILE_PATCH, "utf8");
    if (txt.includes(MARK_BEGIN)) {
      const cleaned = stripLegacyMarkers(txt);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const bak = path.join(DSH_HOME, "dsh-purge", "gateway-shield-backups", `cordis.patch.yml.${stamp}`);
      fs.mkdirSync(path.dirname(bak), { recursive: true });
      fs.copyFileSync(PROFILE_PATCH, bak);
      fs.writeFileSync(PROFILE_PATCH, cleaned, "utf8");
      log(`✓ 已清掉旧的手写注册（备份 ${path.basename(bak)}）`);
    }
  }

  log("");
  log("完成。重启 DSH 后生效：");
  log("  设置 → 插件 里应能看到 dsh-gateway-shield，并且可以开关");
  log("  日志里应出现 [gateway-shield] active …");
}

function clean() {
  if (!fs.existsSync(PROFILE_PATCH)) {
    log("没有 profile patch 文件");
    return;
  }
  const txt = fs.readFileSync(PROFILE_PATCH, "utf8");
  if (!txt.includes(MARK_BEGIN)) {
    log("没有需要清理的手写注册块");
    return;
  }
  if (DRY) {
    log("[dry-run] 将清掉手写注册块");
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const bak = path.join(DSH_HOME, "dsh-purge", "gateway-shield-backups", `cordis.patch.yml.${stamp}`);
  fs.mkdirSync(path.dirname(bak), { recursive: true });
  fs.copyFileSync(PROFILE_PATCH, bak);
  fs.writeFileSync(PROFILE_PATCH, stripLegacyMarkers(txt), "utf8");
  log(`✓ 已清掉手写注册块（备份 ${path.basename(bak)}）`);
  log("插件本身仍在 node_modules，由 dsh.bundle 注册。");
}

if (VERIFY) verify();
else if (CLEAN) clean();
else install();
