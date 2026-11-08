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
 * 它会做的事：
 *   1. 找到 DSH_HOME（默认 ~/.dsh）和带 cordis.patch.yml 的 profile（默认 web）
 *   2. 下载仓库 tarball
 *   3. 解包到 <profile>/node_modules/dsh-gateway-shield
 *   4. 往 cordis.patch.yml 的 insert 列表写一条配置（幂等，带备份）
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

const CONFIG = {
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

const log = (m = "") => console.log(m);
const die = (m) => {
  console.error(`\n✗ ${m}\n`);
  process.exit(1);
};

// ---------------------------------------------------------------- 环境探测

if (process.versions.node.split(".")[0] < 18) die(`需要 Node >= 18，当前 ${process.versions.node}`);

if (!fs.existsSync(DSH_HOME)) {
  die(`找不到 DSH 目录 ${DSH_HOME}。装过 DSH 吗？或用 SHIELD_DSH_HOME 指定。`);
}

const profilesDir = path.join(DSH_HOME, "profiles");
if (!fs.existsSync(profilesDir)) die(`找不到 ${profilesDir}`);

const profiles = fs
  .readdirSync(profilesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((n) => fs.existsSync(path.join(profilesDir, n, "cordis.patch.yml")));

if (profiles.length === 0) die(`${profilesDir} 下没有带 cordis.patch.yml 的 profile`);

const profileName = process.env.SHIELD_PROFILE?.trim() || (profiles.includes("web") ? "web" : profiles[0]);
const profileDir = path.join(profilesDir, profileName);
const patchPath = path.join(profileDir, "cordis.patch.yml");
const targetDir = path.join(profileDir, "node_modules", ID);

log(`dsh-gateway-shield 安装器`);
log(`  DSH_HOME  ${DSH_HOME}`);
log(`  profile   ${profileName}`);
log(`  目标      ${targetDir}`);
log(`  来源      github.com/${REPO}@${REF}`);
log("");

// ---------------------------------------------------------------- 下载

const url = `https://codeload.github.com/${REPO}/tar.gz/refs/heads/${REF}`;
log(`[1/4] 下载 ${url}`);

let tarball;
try {
  const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "dsh-gateway-shield-bootstrap" } });
  if (!res.ok) die(`下载失败 HTTP ${res.status}。仓库是否存在？是否为公开仓库？`);
  tarball = Buffer.from(await res.arrayBuffer());
} catch (e) {
  die(`下载失败：${e.message}\n如果是网络问题，可设代理：$env:HTTPS_PROXY="http://127.0.0.1:7897"`);
}
log(`      ${(tarball.length / 1024).toFixed(1)} KB`);

// ---------------------------------------------------------------- 解包

log(`[2/4] 解包`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shield-"));
const tarPath = path.join(tmp, "pkg.tgz");
fs.writeFileSync(tarPath, tarball);

// 用系统 tar（Windows 10+ / macOS / Linux 都自带）
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

log(`[3/4] 安装到 ${targetDir}`);
const SHIP = ["lib", "scripts", "package.json", "README.md", "LICENSE", "install.mjs"];

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

// 原地覆盖，不 rename。
//
// 先 rename 成 .old.<时间戳> 再重建，在 Windows 上会 EBUSY：只要有任何进程
// （pnpm、IDE、正在运行的 node）打开着目标目录里的东西，rename 目录就会失败。
// 覆盖单个文件则允许 —— 读着的文件也能被替换。所以这里只增不删。
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

// ---------------------------------------------------------------- 写 patch

log(`[4/4] 注册到 cordis.patch.yml`);

function block(config) {
  const lines = [MARK_BEGIN, `    - id: ${ID}`, `      name: ${ID}`, "      config:"];
  for (const [k, v] of Object.entries(config)) {
    lines.push(`        ${k}: ${Array.isArray(v) ? `[${v.join(", ")}]` : v}`);
  }
  lines.push(MARK_END);
  return lines.join("\n");
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const stripExisting = (t) =>
  t.replace(new RegExp(`\\n?${esc(MARK_BEGIN)}[\\s\\S]*?${esc(MARK_END)}\\n?`, "g"), "");

/**
 * 找插入位置。
 *
 * 优先挂在已有 insert 列表的末尾（这样和 dsh-purge 等插件同处一个列表）。
 * 找不到任何 insert 列表时，兜底在文件末尾新建一个 —— 别人机器上不一定装了
 * dsh-purge，不能把「有 dsh-purge」当成前提。
 */
function locateAnchor(text) {
  // 1) 优先：已有的 insert 列表，取列表中最后一个条目之后
  const insertIdx = text.search(/^- insert:\s*$/m);
  if (insertIdx >= 0) {
    const lines = text.slice(insertIdx).split("\n");
    let consumed = 0;
    let lastItem = 0;
    let seenItem = false;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (i === 0) {
        consumed += line.length + 1;
        continue; // "- insert:" 本身
      }
      if (/^ {4}- /.test(line) || /^ {6,}/.test(line) || line.trim() === "") {
        if (/^ {4}- /.test(line)) seenItem = true;
        consumed += line.length + 1;
        lastItem = consumed;
        continue;
      }
      break;
    }
    if (seenItem) return { end: insertIdx + lastItem, mode: "append-insert" };
  }

  // 2) 兜底：文件末尾新建一个 insert 块
  return { end: text.length, mode: "new-insert" };
}

const original = fs.readFileSync(patchPath, "utf8");
const already = original.includes(`- id: ${ID}`);
const cleaned = stripExisting(original);
const anchor = locateAnchor(cleaned);

if (!anchor) {
  log("");
  log("✗ cordis.patch.yml 结构无法识别，请手动加下面这段：");
  log("");
  log(block(CONFIG));
  process.exit(1);
}

let next;
if (anchor.mode === "new-insert") {
  next = `${cleaned.replace(/\s*$/, "")}\n\n- insert:\n${block(CONFIG)}\n`;
} else {
  next = `${cleaned.slice(0, anchor.end).replace(/\s*$/, "")}\n${block(CONFIG)}\n${cleaned.slice(anchor.end)}`;
}
log(`      ✓ 位置：${anchor.mode === "new-insert" ? "新建 insert 块" : "并入已有 insert 列表"}`);

fs.mkdirSync(path.join(DSH_HOME, "dsh-purge", "gateway-shield-backups"), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const bak = path.join(DSH_HOME, "dsh-purge", "gateway-shield-backups", `cordis.patch.yml.${stamp}`);
fs.copyFileSync(patchPath, bak);
fs.writeFileSync(patchPath, next, "utf8");

log(`      ✓ ${already ? "已更新" : "已插入"}（备份 ${path.basename(bak)}）`);

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* 临时目录清不掉不影响结果 */
}

log("");
log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
log("装好了。重启 DSH 后生效（新增 insert 条目无法热加载）。");
log("");
log("重启后日志里应出现：");
log("  [gateway-shield] active | sanitize=true refusalRetry=true retryMax=2 providers=all");
log("");
log("体检：node \"" + path.join(targetDir, "install.mjs") + "\" --verify");
log("卸载：node \"" + path.join(targetDir, "install.mjs") + "\" --uninstall");
log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
