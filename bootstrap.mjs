#!/usr/bin/env node
/**
 * 一行命令从 GitHub 安装 dsh-gateway-shield 到本地 DSH。
 *
 * 用法（别人复制这一行就能装）：
 *   node --input-type=module -e "const s=await(await fetch('https://raw.githubusercontent.com/jyuaner/dsh-gateway-shield/main/bootstrap.mjs')).text(); await import('data:text/javascript;base64,'+Buffer.from(s).toString('base64'))"
 *
 * 连搭档三件套一起装（dsh-purge + WorkBuddy / Qoder 连接器）：
 *   node --input-type=module -e "globalThis.__SHIELD_ARGV=['--with-companions']; const s=await(await fetch('https://raw.githubusercontent.com/jyuaner/dsh-gateway-shield/main/bootstrap.mjs')).text(); await import('data:text/javascript;base64,'+Buffer.from(s).toString('base64'))"
 *
 * 为什么参数要写进 `globalThis.__SHIELD_ARGV` 而不是命令行末尾：
 * `node -e` 的 `process.argv` 里塞不进脚本参数（`--` 之后的会被当成 Node 自己的
 * 参数解析），所以这一段把参数直接交给脚本读取 —— 本文件优先读
 * `globalThis.__SHIELD_ARGV`，没有再退回 `process.argv.slice(2)`（直接 node
 * bootstrap.mjs 跑时走这条）。
 *
 * 为什么要 base64 转 data: URL：本文件是 ESM（用了顶层 await / import），
 * `node -e` 默认按 CommonJS 解析，`eval` 跑不了 import。用 data: URL 动态
 * import 才能正确进入 ESM 上下文。Windows PowerShell 里也不会被引号转义搞乱。
 *
 * 或者更稳的（先下载再跑，可看清内容）：
 *   curl -fsSL https://raw.githubusercontent.com/jyuaner/dsh-gateway-shield/main/bootstrap.mjs -o bootstrap.mjs
 *   node bootstrap.mjs --with-companions
 *
 * 步骤：
 *   1. 找 DSH_HOME（默认 ~/.dsh）和 profile（默认 web）
 *   2. 下载仓库 tarball
 *   3. 解包到 <profile>/node_modules/dsh-gateway-shield
 *   4. 把自己追加进 `dsh.profile.bundles` —— DSH 只从这里读组合包
 *   5. 登记成功后才摘掉早期版本的手写注册块
 *   6. 可选：装齐搭档三件套
 *
 * 不依赖 git、不依赖 npm install 装自己。只需要 Node >= 18。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const HOME = os.homedir();
const REPO = process.env.SHIELD_REPO?.trim() || "jyuaner/dsh-gateway-shield";
const REF = process.env.SHIELD_REF?.trim() || "main";
const DSH_HOME = process.env.DSH_HOME?.trim() || path.join(HOME, ".dsh");
const ID = "dsh-gateway-shield";

const ARGV = Array.isArray(globalThis.__SHIELD_ARGV) ? globalThis.__SHIELD_ARGV.map(String) : process.argv.slice(2);
const has = (n) => ARGV.includes(`--${n}`);
const DRY = has("dry-run");
const WITH_COMPANIONS = has("with-companions") || has("all") || ARGV.includes("--only");
function list(name) {
  const out = [];
  ARGV.forEach((a, i) => {
    if (a !== `--${name}`) return;
    const v = ARGV[i + 1];
    if (!v || v.startsWith("--")) return;
    for (const part of v.split(",")) if (part.trim() !== "") out.push(part.trim());
  });
  return out;
}
function opt(name) {
  const i = ARGV.indexOf(`--${name}`);
  return i >= 0 && ARGV[i + 1] && !ARGV[i + 1].startsWith("--") ? ARGV[i + 1] : undefined;
}

const log = (m = "") => console.log(m);
const die = (m) => {
  console.error(`\n✗ ${m}\n`);
  process.exit(1);
};

if (Number(process.versions.node.split(".")[0]) < 18) {
  die(`需要 Node >= 18，当前 ${process.versions.node}`);
}
if (!fs.existsSync(DSH_HOME)) {
  die(`找不到 DSH 目录 ${DSH_HOME}。装过 DSH 吗？或用 DSH_HOME 环境变量指定。`);
}

const profilesDir = path.join(DSH_HOME, "profiles");
if (!fs.existsSync(profilesDir)) die(`找不到 ${profilesDir}`);

const profiles = fs
  .readdirSync(profilesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((n) => fs.existsSync(path.join(profilesDir, n, "package.json")));

if (profiles.length === 0) die(`${profilesDir} 下没有可用的 profile`);

const profileName = opt("profile") || process.env.SHIELD_PROFILE?.trim() || (profiles.includes("web") ? "web" : profiles[0]);
const profileDir = path.join(profilesDir, profileName);
const profilePatch = path.join(profileDir, "cordis.patch.yml");
const targetDir = path.join(profileDir, "node_modules", ID);
const backupDir = path.join(DSH_HOME, "dsh-purge", "gateway-shield-backups");

log("dsh-gateway-shield 安装器");
log(`  DSH_HOME  ${DSH_HOME}`);
log(`  profile   ${profileName}`);
log(`  目标      ${targetDir}`);
log(`  来源      github.com/${REPO}@${REF}`);
log(`  搭档      ${WITH_COMPANIONS ? "一并安装" : "跳过（加 --with-companions 一起装）"}`);
log("");

// ---------------------------------------------------------------- 下载

const url = `https://codeload.github.com/${REPO}/tar.gz/refs/heads/${REF}`;
log(`[1/5] 下载 ${url}`);

let tarball;
try {
  const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "dsh-gateway-shield-bootstrap" } });
  if (!res.ok) die(`下载失败 HTTP ${res.status}。仓库是否存在？是否为公开仓库？`);
  tarball = Buffer.from(await res.arrayBuffer());
} catch (e) {
  die(
    `下载失败：${e.message}\n` +
      `网络受限时：Node 24+ 先设 $env:NODE_USE_ENV_PROXY="1" 再设 $env:HTTPS_PROXY="http://127.0.0.1:7897"；\n` +
      `Node 18–23 的 fetch 不读代理变量，改用先下载再跑：\n` +
      `  curl -fsSL https://raw.githubusercontent.com/${REPO}/${REF}/bootstrap.mjs -o bootstrap.mjs\n` +
      `  node bootstrap.mjs --with-companions`,
  );
}
log(`      ${(tarball.length / 1024).toFixed(1)} KB`);

// ---------------------------------------------------------------- 解包

log(`[2/5] 解包`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shield-"));
const tarPath = path.join(tmp, "pkg.tgz");
fs.writeFileSync(tarPath, tarball);

try {
  execFileSync("tar", ["-xzf", tarPath, "-C", tmp], { stdio: "pipe" });
} catch (e) {
  die(`解包失败：tar 不可用？${e.message}`);
}

const extractedRoot = fs
  .readdirSync(tmp, { withFileTypes: true })
  .find((e) => e.isDirectory() && e.name.startsWith(ID));
if (!extractedRoot) die(`解包后找不到 ${ID}-* 目录`);
const src = path.join(tmp, extractedRoot.name);
log(`      ${extractedRoot.name}`);

// ---------------------------------------------------------------- 落盘

log(`[3/5] 安装到 ${targetDir}`);
const SHIP = ["lib", "scripts", "cordis.patch.yml", "package.json", "README.md", "CHANGELOG.md", "LICENSE", "install.mjs"];

function copyDir(s, d) {
  fs.mkdirSync(d, { recursive: true });
  let n = 0;
  for (const e of fs.readdirSync(s, { withFileTypes: true })) {
    if (["node_modules", ".git"].includes(e.name)) continue;
    const sp = path.join(s, e.name);
    const dp = path.join(d, e.name);
    if (e.isDirectory()) n += copyDir(sp, dp);
    else {
      fs.copyFileSync(sp, dp);
      n += 1;
    }
  }
  return n;
}

// 原地覆盖，不 rename —— Windows 上目标目录被任何进程打开时 rename 会 EBUSY，
// 而那正是覆盖已装版本时的常态。覆盖单个文件则允许。
if (DRY) {
  log(`      [dry-run] 将覆盖 ${SHIP.join(", ")}`);
} else {
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  let copied = 0;
  for (const item of SHIP) {
    const s = path.join(src, item);
    if (!fs.existsSync(s)) continue;
    const d = path.join(targetDir, item);
    if (fs.statSync(s).isDirectory()) copied += copyDir(s, d);
    else {
      fs.copyFileSync(s, d);
      copied += 1;
    }
  }
  log(`      ✓ ${copied} 个文件已覆盖`);
}

// ---------------------------------------------------------------- 校验声明

// dry-run 在干净机器上时目标目录还不存在，退回读刚解包的源码。
const declRoot = fs.existsSync(path.join(targetDir, "package.json")) ? targetDir : src;
let declOk = false;
try {
  const j = JSON.parse(fs.readFileSync(path.join(declRoot, "package.json"), "utf8"));
  const p = j?.dsh?.bundle?.patch;
  declOk = typeof p === "string" && fs.existsSync(path.join(declRoot, p));
} catch {
  declOk = false;
}
if (!declOk) {
  die("装好了文件，但 package.json 的 dsh.bundle.patch 缺失或指向的文件不在。\
插件管理器会认不出，请检查仓库版本是否为 0.2.0+。");
}
log(`      ✓ dsh.bundle.patch 声明有效`);

// ---------------------------------------------------------------- 登记

// 用刚落到 node_modules 里的那份模块，而不是 tmp 里的源码：
// 顺便验证「装进去的这堆文件彼此是自洽的」。dry-run 且尚未安装时退回源码。
const libRoot = fs.existsSync(path.join(targetDir, "lib", "profile.js")) ? targetDir : src;
const { ensureBundles, hasMarkerBlock, stripMarkerBlock, readManifest } = await import(
  pathToFileURL(path.join(libRoot, "lib", "profile.js")).href
);

log(`[4/5] 登记 dsh.profile.bundles`);
{
  const read = readManifest(profileDir);
  const current = read.ok && Array.isArray(read.manifest?.dsh?.profile?.bundles) ? read.manifest.dsh.profile.bundles : [];
  const alreadyListed = current.includes(ID);
  if (DRY) {
    log(
      alreadyListed
        ? `      [dry-run] 已在 dsh.profile.bundles 中，不会改动`
        : `      [dry-run] 将把 ${ID} 追加进 dsh.profile.bundles`,
    );
  } else {
    const reg = ensureBundles(profileDir, [ID], { backupDir });
    if (!reg.ok) die(`登记失败：${reg.error}`);
    log(reg.changed ? `      ✓ 已登记${reg.backup ? `（备份 ${path.basename(reg.backup)}）` : ""}` : "      ✓ 已收录，无需改动");
  }
}

const listed = (() => {
  const read = readManifest(profileDir);
  const bundles = read.manifest?.dsh?.profile?.bundles ?? [];
  return Array.isArray(bundles) && bundles.includes(ID);
})();

// ---------------------------------------------------------------- 清旧的手写注册

if (fs.existsSync(profilePatch) && (listed || DRY)) {
  const txt = fs.readFileSync(profilePatch, "utf8");
  if (hasMarkerBlock(txt, ID)) {
    if (DRY) {
      log(`      [dry-run] 将摘掉 cordis.patch.yml 里的手写注册块`);
    } else {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      fs.mkdirSync(backupDir, { recursive: true });
      const bak = path.join(backupDir, `cordis.patch.yml.${stamp}`);
      fs.copyFileSync(profilePatch, bak);
      fs.writeFileSync(profilePatch, stripMarkerBlock(txt, ID), "utf8");
      log(`      ✓ 摘掉早期手写注册（备份 ${path.basename(bak)}）`);
      log(`        现在由 dsh.profile.bundles 单一路径注册，不会再重复`);
    }
  }
}

// ---------------------------------------------------------------- 搭档

if (WITH_COMPANIONS) {
  log(`[5/5] 搭档三件套`);
  const companions = await import(pathToFileURL(path.join(libRoot, "lib", "companions.js")).href);
  const only = list("only");
  const skip = list("skip");
  const plan = companions.planCompanions({ profileDir, only, skip, pm: opt("pm") });

  if (plan.unknown.length > 0) {
    log(`      ✗ 未知的插件 id：${plan.unknown.join(", ")}`);
    log(`        可选：${companions.COMPANIONS.map((c) => c.id).join(" / ")}`);
    process.exitCode = 1;
  } else {
    for (const line of companions.describePlan(plan)) log(`      ${line}`);
    for (const w of plan.warnings) log(`      ! ${w}`);

    const res = companions.installCompanions({
      profileDir,
      backupDir,
      plan,
      dryRun: DRY,
    });

    if (res.reason === "nothing-missing") {
      log(`      · 全部已就位`);
    } else if (res.reason === "dry-run") {
      log(`      [dry-run] 将执行：${res.command}`);
    } else if (!res.ok) {
      log(`      ✗ ${res.error}`);
      if (res.hint) log(`        ${res.hint}`);
      process.exitCode = 1;
    } else {
      log(`      ✓ ${res.command}`);
      for (const r of res.results) log(`      ✓ ${r.id.padEnd(22)} v${r.version ?? "?"}`);
    }

    const ids = plan.items.filter((i) => !skip.includes(i.id)).map((i) => i.id);
    const reg = companions.registerBundles({ profileDir, ids, backupDir, dryRun: DRY });
    if (DRY)
      log(
        reg.added.length > 0
          ? `      [dry-run] 将把 ${reg.added.join(", ")} 追加进 dsh.profile.bundles`
          : `      [dry-run] 已在 dsh.profile.bundles 中，不会改动`,
      );
    else if (!reg.ok) {
      log(`      ✗ 登记失败：${reg.error}`);
      process.exitCode = 1;
    } else if (reg.added.length > 0) log(`      ✓ 已登记：${reg.added.join(", ")}`);
    for (const s of reg.skipped ?? []) log(`      ! ${s.name} 跳过登记：${s.reason}`);

    const login = plan.items.filter((i) => i.login && (i.installed || reg.added?.includes(i.id)));
    if (login.length > 0) log(`      · ${login.map((i) => i.title).join(" / ")} 还需在本机登录一次对应客户端，模型才会出现`);
  }
} else {
  log(`[5/5] 搭档：跳过（加 --with-companions 一起装）`);
}

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* 临时目录清不掉不影响结果 */
}

log("");
log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
if (DRY) {
  log("预演完成。上面是「真跑会发生什么」，没有改动任何文件。");
  log("去掉 --dry-run 再跑一次即可落地。");
} else {
  log("装好了。重启 DSH 后生效。");
  log("");
  log("预期：");
  log("  · 设置 → 插件 里能看到 dsh-gateway-shield，可以开关");
  log("  · 日志出现 [gateway-shield] active | sanitize=true refusalRetry=true …");
  log("");
  log("体检：node \"" + path.join(targetDir, "install.mjs") + "\" --verify");
}
log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");