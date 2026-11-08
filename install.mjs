#!/usr/bin/env node
/**
 * dsh-gateway-shield 安装 / 体检 / 卸载。
 *
 *   node install.mjs             安装（复制到 DSH profile 并写 cordis.patch.yml）
 *   node install.mjs --verify    体检
 *   node install.mjs --uninstall 从 patch 摘除
 *   node install.mjs --dry-run   预演，不落盘
 *   node install.mjs --profile web|desktop   指定 profile（默认自动探测）
 *
 * 幂等：已存在就更新 config，不重复插入。改动前备份到 $DSH_HOME/dsh-purge/gateway-shield-backups/。
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
const UNINSTALL = has("uninstall");

const ID = "dsh-gateway-shield";
const MARK_BEGIN = "    # >>> dsh-gateway-shield";
const MARK_END = "    # <<< dsh-gateway-shield";

/** Shell 无关地解析 DSH_HOME。 */
const DSH_HOME = opt("dsh-home", process.env.DSH_HOME?.trim() || path.join(HOME, ".dsh"));

const DEFAULT_CONFIG = {
  enabled: true,
  sanitize: true,
  refusalRetry: true,
  retryMax: 2,
  bufferChars: 480,
  providers: [],
  paranoid: false,
  zeroWidth: false,
  verbose: false,
};

/** 源文件：本仓库里要复制过去的东西。 */
const SHIP = ["lib", "scripts", "package.json", "README.md", "LICENSE", "install.mjs"];

const log = (m = "") => console.log(m);

/** 找一个存在 cordis.patch.yml 的 profile。 */
function resolveProfile() {
  const explicit = opt("profile", null);
  const profilesDir = path.join(DSH_HOME, "profiles");
  if (!fs.existsSync(profilesDir)) {
    log(`✗ 找不到 ${profilesDir}。DSH 装过吗？或者用 --dsh-home 指定。`);
    process.exit(1);
  }
  if (explicit) {
    const p = path.join(profilesDir, explicit);
    if (!fs.existsSync(path.join(p, "cordis.patch.yml"))) {
      log(`✗ ${p} 下没有 cordis.patch.yml`);
      process.exit(1);
    }
    return { name: explicit, dir: p, patch: path.join(p, "cordis.patch.yml") };
  }
  // 自动探测：优先 web，其次任何带 cordis.patch.yml 的
  const candidates = fs
    .readdirSync(profilesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => fs.existsSync(path.join(profilesDir, n, "cordis.patch.yml")));
  const pick = candidates.includes("web") ? "web" : candidates[0];
  if (!pick) {
    log(`✗ ${profilesDir} 下没有可用 profile`);
    process.exit(1);
  }
  return { name: pick, dir: path.join(profilesDir, pick), patch: path.join(profilesDir, pick, "cordis.patch.yml") };
}

const profile = VERIFY || UNINSTALL || DRY || true ? resolveProfile() : null;
const TARGET = path.join(profile.dir, "node_modules", ID);
const BACKUP_DIR = path.join(DSH_HOME, "dsh-purge", "gateway-shield-backups");

function backup(file) {
  if (!fs.existsSync(file)) return null;
  if (DRY) return null;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dst = path.join(BACKUP_DIR, `${path.basename(file)}.${stamp}`);
  fs.copyFileSync(file, dst);
  return dst;
}

function block(config = DEFAULT_CONFIG) {
  const lines = [MARK_BEGIN, `    - id: ${ID}`, `      name: ${ID}`, "      config:"];
  for (const [k, v] of Object.entries(config)) {
    lines.push(`        ${k}: ${Array.isArray(v) ? `[${v.join(", ")}]` : v}`);
  }
  lines.push(MARK_END);
  return lines.join("\n");
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function stripExisting(text) {
  return text.replace(new RegExp(`\\n?${esc(MARK_BEGIN)}[\\s\\S]*?${esc(MARK_END)}\\n?`, "g"), "");
}

/**
 * 找插入位置。
 *
 * 优先并入已有的 insert 列表；没有 insert 列表就在文件末尾新建一个。
 * 不把「装了 dsh-purge」当成前提 —— 别人机器上不一定有。
 */
function locateAnchor(text) {
  const insertIdx = text.search(/^- insert:\s*$/m);
  if (insertIdx >= 0) {
    const lines = text.slice(insertIdx).split("\n");
    let consumed = 0;
    let lastItemLine = 0;
    let seenItem = false;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (i === 0) {
        consumed += line.length + 1;
        continue;
      }
      if (/^ {4}- /.test(line) || /^ {6,}/.test(line) || line.trim() === "") {
        if (/^ {4}- /.test(line)) seenItem = true;
        consumed += line.length + 1;
        lastItemLine = consumed;
        continue;
      }
      break;
    }
    if (seenItem) return { end: insertIdx + lastItemLine, mode: "append-insert" };
  }
  return { end: text.length, mode: "new-insert" };
}

/** 递归复制，跳过 node_modules / .git / 备份。返回复制的文件数。 */
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

function verify() {
  let bad = 0;
  log(`体检 ${ID}`);
  log(`  profile  ${profile.name}  (${profile.dir})`);
  log(`  安装点   ${TARGET}`);
  log("");

  for (const f of ["package.json", "lib/index.js", "lib/sanitize.js", "lib/refusal.js", "install.mjs"]) {
    const ok = fs.existsSync(path.join(TARGET, f));
    log(`${ok ? "✓" : "✗"} ${f}`);
    if (!ok) bad += 1;
  }

  for (const f of ["scripts/selftest.mjs", "scripts/e2e.mjs"]) {
    const ok = fs.existsSync(path.join(TARGET, f));
    log(`${ok ? "✓" : "·"} ${f}${ok ? "" : "（可选，测试用）"}`);
  }

  const patch = fs.existsSync(profile.patch) ? fs.readFileSync(profile.patch, "utf8") : "";
  const registered = patch.includes(`- id: ${ID}`);
  log(`${registered ? "✓" : "✗"} cordis.patch.yml 已注册`);
  if (!registered) bad += 1;

  log("");
  log(bad === 0 ? "就位。重启 DSH 后生效。" : `${bad} 项不合格。跑 node install.mjs 修复。`);
  if (bad) process.exitCode = 1;
}

function install() {
  if (!fs.existsSync(profile.patch)) {
    log(`✗ 找不到 ${profile.patch}`);
    process.exit(1);
  }

  log(`安装 ${ID}`);
  log(`  profile ${profile.name}`);
  log(`  目标    ${TARGET}`);
  log("");

  // 1) 复制文件
  //
  // 曾经这里用「先 rename 成 .old.<时间戳>，再重新 mkdir」的方式做原地升级。
  // 那条路在 pnpm 装包时必挂：pnpm 自己正持有这个目录，Windows 会返回
  // EBUSY（resource busy or locked）。而且 pnpm 的 postinstall 一失败，
  // 它会把整条依赖回滚掉 —— package.json 里的声明被删，目录却残留。
  //
  // 所以改成原地覆盖：逐文件 copyFileSync 覆盖同名文件，不做 rename、
  // 不删目录。覆盖一个被读着的 .js 文件在 Windows 上是允许的（只读打开），
  // 而 rename 一个被打开的目录不允许。
  if (!DRY) {
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
    log(`✓ 文件已覆盖（${n} 项）`);
  } else {
    log(`[dry-run] 将覆盖 ${SHIP.join(", ")} → ${TARGET}`);
  }

  // 2) 写 patch
  const original = fs.readFileSync(profile.patch, "utf8");
  const already = original.includes(`- id: ${ID}`);
  const sanitized = original.replace(/!!js\s+[^\n]+/g, "null");
  const text = stripExisting(original);
  const anchor = locateAnchor(text);

  const next =
    anchor.mode === "new-insert"
      ? `${text.replace(/\s*$/, "")}\n\n- insert:\n${block()}\n`
      : `${text.slice(0, anchor.end).replace(/\s*$/, "")}\n${block()}\n${text.slice(anchor.end)}`;
  if (!DRY) log(`✓ 位置：${anchor.mode === "new-insert" ? "新建 insert 块" : "并入已有 insert 列表"}`);

  if (DRY) {
    log(`[dry-run] 将${already ? "更新" : "插入"} cordis.patch.yml`);
    return;
  }

  const bak = backup(profile.patch);
  fs.writeFileSync(profile.patch, next, "utf8");
  log(`✓ ${already ? "已更新" : "已插入"} cordis.patch.yml`);
  if (bak) log(`  备份 ${bak}`);

  log("");
  log("新增的 insert 条目必须重启 DSH 才载入（热重载无效）。");
  log("重启后日志里应出现：");
  log(`  [gateway-shield] active | sanitize=true refusalRetry=true retryMax=2 providers=all`);
  log("");
  log("体检：node install.mjs --verify");
}

function uninstall() {
  if (!fs.existsSync(profile.patch)) {
    log("没有 profile patch 文件");
    return;
  }
  const text = fs.readFileSync(profile.patch, "utf8");
  if (!text.includes(`- id: ${ID}`)) {
    log("没有安装记录");
    return;
  }
  if (DRY) {
    log("[dry-run] 将从 cordis.patch.yml 移除 shield 段");
    return;
  }
  const bak = backup(profile.patch);
  fs.writeFileSync(profile.patch, stripExisting(text), "utf8");
  log(`✓ 已从 cordis.patch.yml 移除 ${ID}`);
  if (bak) log(`  备份 ${bak}`);
  log("");
  log("插件目录仍保留。彻底删除：");
  log(`  rm -rf "${TARGET}"`);
}

if (VERIFY) verify();
else if (UNINSTALL) uninstall();
else install();
