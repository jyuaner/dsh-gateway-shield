#!/usr/bin/env node
/**
 * 一行命令从 GitHub 安装 dsh-gateway-shield 到本地 DSH。
 *
 * 用法（别人复制这一行就能装）：
 *   node --input-type=module -e "const s=await(await fetch('https://raw.githubusercontent.com/jyuaner/dsh-gateway-shield/main/bootstrap.mjs')).text(); await import('data:text/javascript;base64,'+Buffer.from(s).toString('base64'))"
 *
 * 为什么要 base64 转 data: URL：本文件是 ESM（用了顶层 await / import），
 * `node -e` 默认按 CommonJS 解析，`eval` 跑不了 import。用 data: URL 动态
 * import 才能正确进入 ESM 上下文。Windows PowerShell 里也不会被引号转义搞乱。
 *
 * 或者更稳的（先下载再跑，可看清内容）：
 *   curl -fsSL https://raw.githubusercontent.com/jyuaner/dsh-gateway-shield/main/bootstrap.mjs -o bootstrap.mjs
 *   node bootstrap.mjs
 *
 * ## 它现在只负责「把包放到位」
 *
 * 包里声明了 `dsh.bundle.patch` → `./cordis.patch.yml`，DSH 的插件管理器
 * 读这份声明后自行挂载 profile。所以**不需要**再往 profile 的
 * cordis.patch.yml 里写任何东西；写了反而会和 bundle 重复注册。
 *
 * 步骤：
 *   1. 找 DSH_HOME（默认 ~/.dsh）和 profile（默认 web）
 *   2. 下载仓库 tarball
 *   3. 解包到 <profile>/node_modules/dsh-gateway-shield
 *   4. 顺带清掉早期版本可能留下的手写注册
 *   5. 提示重启
 *
 * 不依赖 git、不依赖 npm install。只需要 Node >= 18。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const HOME = os.homedir();
const REPO = process.env.SHIELD_REPO?.trim() || "jyuaner/dsh-gateway-shield";
const REF = process.env.SHIELD_REF?.trim() || "main";
const DSH_HOME = process.env.DSH_HOME?.trim() || path.join(HOME, ".dsh");
const ID = "dsh-gateway-shield";

const MARK_BEGIN = "    # >>> dsh-gateway-shield";
const MARK_END = "    # <<< dsh-gateway-shield";

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

const profileName = process.env.SHIELD_PROFILE?.trim() || (profiles.includes("web") ? "web" : profiles[0]);
const profileDir = path.join(profilesDir, profileName);
const profilePatch = path.join(profileDir, "cordis.patch.yml");
const targetDir = path.join(profileDir, "node_modules", ID);

log("dsh-gateway-shield 安装器");
log(`  DSH_HOME  ${DSH_HOME}`);
log(`  profile   ${profileName}`);
log(`  目标      ${targetDir}`);
log(`  来源      github.com/${REPO}@${REF}`);
log("");

// ---------------------------------------------------------------- 下载

const url = `https://codeload.github.com/${REPO}/tar.gz/refs/heads/${REF}`;
log(`[1/3] 下载 ${url}`);

let tarball;
try {
  const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "dsh-gateway-shield-bootstrap" } });
  if (!res.ok) die(`下载失败 HTTP ${res.status}。仓库是否存在？是否为公开仓库？`);
  tarball = Buffer.from(await res.arrayBuffer());
} catch (e) {
  die(`下载失败：${e.message}\n网络受限的话设代理：$env:HTTPS_PROXY="http://127.0.0.1:7897"`);
}
log(`      ${(tarball.length / 1024).toFixed(1)} KB`);

// ---------------------------------------------------------------- 解包

log(`[2/3] 解包`);
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

log(`[3/3] 安装到 ${targetDir}`);
const SHIP = ["lib", "scripts", "cordis.patch.yml", "package.json", "README.md", "LICENSE", "install.mjs"];

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

// ---------------------------------------------------------------- 校验声明

let declOk = false;
try {
  const j = JSON.parse(fs.readFileSync(path.join(targetDir, "package.json"), "utf8"));
  const p = j?.dsh?.bundle?.patch;
  declOk = typeof p === "string" && fs.existsSync(path.join(targetDir, p));
} catch {
  declOk = false;
}
if (!declOk) {
  die("装好了文件，但 package.json 的 dsh.bundle.patch 缺失或指向的文件不在。\
插件管理器会认不出，请检查仓库版本是否为 0.2.0+。");
}
log(`      ✓ dsh.bundle.patch 声明有效（插件管理器可识别）`);

// ---------------------------------------------------------------- 清旧的手写注册

if (fs.existsSync(profilePatch)) {
  const txt = fs.readFileSync(profilePatch, "utf8");
  if (txt.includes(MARK_BEGIN)) {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const cleaned = txt.replace(new RegExp(`\\n?${esc(MARK_BEGIN)}[\\s\\S]*?${esc(MARK_END)}\\n?`, "g"), "");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = path.join(DSH_HOME, "dsh-purge", "gateway-shield-backups");
    fs.mkdirSync(dir, { recursive: true });
    const bak = path.join(dir, `cordis.patch.yml.${stamp}`);
    fs.copyFileSync(profilePatch, bak);
    fs.writeFileSync(profilePatch, cleaned, "utf8");
    log(`      ✓ 清掉早期手写注册（备份 ${path.basename(bak)}）`);
    log(`        现在是 dsh.bundle 单一路径注册，不会再重复`);
  }
}

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* 临时目录清不掉不影响结果 */
}

log("");
log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
log("装好了。重启 DSH 后生效。");
log("");
log("预期：");
log("  · 设置 → 插件 里能看到 dsh-gateway-shield，可以开关");
log("  · 日志出现 [gateway-shield] active | sanitize=true refusalRetry=true …");
log("");
log("体检：node \"" + path.join(targetDir, "install.mjs") + "\" --verify");
log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
