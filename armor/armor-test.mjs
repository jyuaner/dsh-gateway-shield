#!/usr/bin/env node
/**
 * armor/armor-test.mjs —— 整合层的回归测试。
 *
 * 全部跑在临时 fixture 上：不碰真实的 ~/.dsh，不联网，不调包管理器。
 * 检测这种事最怕「在真机上看着对」—— 只有把它压到 fixture 里，
 * 才能证明它认得出 mmparko 那份 `dsh-purge`、也认得出手写块和毒清单。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ARMOR_ID, detectAll, detectProfile, hostCompatible, listProfiles } from "./detect.mjs";
import { bundlesOf, readManifest } from "../lib/profile.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail === undefined ? "" : `\n        ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "armor-test-"));
const DSH = path.join(tmpRoot, "dsh");

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

/** 造一个「已装且有 bundle 声明」的包目录。 */
function fakeBundlePackage(profileDir, id, { version = "1.0.0", extra = {} } = {}) {
  const dir = path.join(profileDir, "node_modules", id);
  writeJson(path.join(dir, "package.json"), {
    name: id,
    version,
    type: "module",
    main: "index.js",
    dsh: { bundle: { patch: "./cordis.patch.yml" } },
    ...extra,
  });
  writeText(path.join(dir, "cordis.patch.yml"), "- insert: []\n");
  writeText(path.join(dir, "index.js"), "export const name = 'x';\n");
  return dir;
}

// ---- fixture：宿主版本 + 两个 profile（web 用 kingcharleslzy 那份，desktop 用 mmparko 那份）----
writeJson(path.join(DSH, "profiles", "node_modules", "@deepseek-ai", "dsh-base", "package.json"), {
  name: "@deepseek-ai/dsh-base",
  version: "0.2.2-rc.5",
});

const WEB = path.join(DSH, "profiles", "web");
writeJson(path.join(WEB, "package.json"), {
  name: "dsh-profile-web",
  private: true,
  dependencies: {
    "dsh-purge-community": "github:kingcharleslzy-ai/dsh-purge",
    "dsh-connect-workbuddy": "^5.25.1",
    "dsh-qoder-connect": "0.2.15",
  },
  dsh: { profile: { bundles: ["dsh-purge-community", "dsh-connect-workbuddy", "dsh-qoder-connect"] } },
});
fakeBundlePackage(WEB, "dsh-purge-community", { version: "1.6.84" });
fakeBundlePackage(WEB, "dsh-connect-workbuddy", { version: "5.25.1" });
fakeBundlePackage(WEB, "dsh-qoder-connect", { version: "0.2.15" });

const DESKTOP = path.join(DSH, "profiles", "desktop");
writeJson(path.join(DESKTOP, "package.json"), {
  name: "dsh-profile-desktop",
  private: true,
  dependencies: { "dsh-purge": "github:mmparko/dsh-purge" },
  dsh: { profile: { bundles: ["dsh-purge"] } },
});
fakeBundlePackage(DESKTOP, "dsh-purge", { version: "1.1.71" });

// ---- 1) 版本区间 ----
{
  ok("宿主 0.2.2-rc.5 在区间内", hostCompatible("0.2.2-rc.5").compatible === true);
  ok("宿主 0.3.0 超出上限", hostCompatible("0.3.0").compatible === false);
  ok("宿主 0.2.0 低于下限", hostCompatible("0.2.0").compatible === false);
  ok("宿主版本未知时不误判", hostCompatible(null).compatible === null);
}

// ---- 2) 按角色识别破甲：web 是 community，desktop 是 mmparko 那份 ----
{
  const det = detectAll({ dshHome: DSH });
  ok("找到两个 profile", listProfiles(DSH).length === 2, listProfiles(DSH));
  ok("宿主版本从 dsh-base 反查", det.host.version === "0.2.2-rc.5", det.host);

  const web = det.profiles.find((p) => p.name === "web");
  const desk = det.profiles.find((p) => p.name === "desktop");
  ok("web 认得出 dsh-purge-community", web.purge.candidates.some((c) => c.id === "dsh-purge-community" && c.installed));
  ok("web 的破甲已就位", web.purge.satisfied === true);
  ok(
    "web 的来源标成 git 并带原始 spec",
    web.purge.candidates.find((c) => c.id === "dsh-purge-community").source.kind === "git" &&
      web.purge.candidates.find((c) => c.id === "dsh-purge-community").source.spec === "github:kingcharleslzy-ai/dsh-purge",
    web.purge.candidates[0].source,
  );
  ok(
    "desktop 认得出换名换源的 dsh-purge（硬编码 id 会漏掉它）",
    desk.purge.satisfied === true && desk.purge.candidates.some((c) => c.id === "dsh-purge"),
    desk.purge.candidates,
  );
  ok("两个 profile 都还没有 shield", det.todo.length === 2, det.todo);
  ok("结论是 installable", det.summary.verdict === "installable", det.summary);
}

// ---- 3) 装了但没登记 → 告警 ----
{
  const dir = path.join(tmpRoot, "dsh-unreg");
  writeJson(path.join(dir, "profiles", "web", "package.json"), {
    name: "p",
    dependencies: { "dsh-purge-community": "github:kingcharleslzy-ai/dsh-purge" },
    dsh: { profile: { bundles: [] } },
  });
  fakeBundlePackage(path.join(dir, "profiles", "web"), "dsh-purge-community");
  const p = detectProfile({ dshHome: dir, name: "web" });
  ok("装了没登记：破甲不算就位", p.purge.satisfied === false);
  ok("装了没登记：给出 purge-not-registered 告警", p.conflicts.some((c) => c.code === "purge-not-registered"), p.conflicts);
}

// ---- 4) 毒清单 → 阻断 ----
{
  const dir = path.join(tmpRoot, "dsh-toxic");
  writeJson(path.join(dir, "profiles", "web", "package.json"), { name: "p", dsh: { profile: { bundles: [] } } });
  const broken = path.join(dir, "profiles", "web", "node_modules", "dsh-purge-community");
  writeJson(path.join(broken, "package.json"), {
    name: "dsh-purge-community",
    version: "1.6.84",
    dsh: { bundle: { patch: "./cordis.patch.yml" }, client: { platform: "web" } },
  });
  writeText(path.join(broken, "cordis.patch.yml"), "- insert: []\n");
  const det = detectAll({ dshHome: dir });
  ok("毒清单：报成 error", det.conflicts.some((c) => c.level === "error" && c.code === "purge-toxic-manifest"), det.conflicts);
  ok("毒清单：整体阻断", det.summary.verdict === "blocked", det.summary);
}

// ---- 5) 重复破甲 + refusalRetry 冲突 ----
{
  const dir = path.join(tmpRoot, "dsh-dup");
  const prof = path.join(dir, "profiles", "web");
  writeJson(path.join(prof, "package.json"), {
    name: "p",
    dependencies: { "dsh-purge-community": "github:a/b", "dsh-purge": "github:c/d" },
    dsh: { profile: { bundles: ["dsh-purge-community", "dsh-purge"] } },
  });
  fakeBundlePackage(prof, "dsh-purge-community");
  fakeBundlePackage(prof, "dsh-purge");
  writeJson(path.join(dir, "dsh-purge", "tuning.json"), { refusalRetry: true });
  const det = detectAll({ dshHome: dir });
  ok("重复破甲：告警", det.conflicts.some((c) => c.code === "purge-duplicated"), det.conflicts);
  ok("refusalRetry 打开：告警（它那份是空转）", det.conflicts.some((c) => c.code === "refusal-retry-duplicated"), det.conflicts);
}

// ---- 6) 端到端：--check 不写盘 ----
function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${path.relative(dir, p)}:${fs.statSync(p).size}:${fs.readFileSync(p, "utf8")}`);
    }
  };
  walk(dir);
  return out.sort().join("\n");
}
function run(args) {
  return spawnSync(process.execPath, [path.join(HERE, "armor.mjs"), ...args], { encoding: "utf8", cwd: ROOT });
}
{
  const before = snapshot(DSH);
  const res = run(["--check", "--dsh-home", DSH]);
  const after = snapshot(DSH);
  ok("--check 退出码 0", res.status === 0, res.stderr || res.stdout);
  ok("--check 一个字节都不写", before === after);
  ok("--check 输出里点名两个 profile", /profile web/.test(res.stdout) && /profile desktop/.test(res.stdout), res.stdout);
}

// ---- 7) 端到端：--json 可解析 ----
{
  const res = run(["--json", "--dsh-home", DSH]);
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    /* 下面断言会报 */
  }
  ok("--json 输出是合法 JSON", parsed !== null, res.stdout.slice(0, 200));
  ok("--json 带 summary.verdict", parsed?.summary?.verdict === "installable", parsed?.summary);
  ok("--json 带每个 profile 的破甲来源", parsed?.profiles?.[0]?.purge?.candidates?.[0]?.source?.kind === "git");
}

// ---- 8) 端到端：真装 ----
{
  const res = run(["--dsh-home", DSH, "--profile", "web"]);
  ok("安装退出码 0", res.status === 0, res.stderr || res.stdout);
  ok("文件落盘", fs.existsSync(path.join(WEB, "node_modules", ARMOR_ID, "package.json")));
  ok("armor 目录也跟着落盘", fs.existsSync(path.join(WEB, "node_modules", ARMOR_ID, "armor", "detect.mjs")));
  const read = readManifest(WEB);
  ok("登记进 dsh.profile.bundles", bundlesOf(read.manifest).includes(ARMOR_ID), bundlesOf(read.manifest));
  ok(
    "既有破甲没被动过",
    read.manifest.dependencies["dsh-purge-community"] === "github:kingcharleslzy-ai/dsh-purge",
    read.manifest.dependencies,
  );
  ok("清单备份已写", fs.existsSync(path.join(DSH, "dsh-purge", "gateway-shield-backups")));

  const again = run(["--dsh-home", DSH, "--profile", "web"]);
  const listed = bundlesOf(readManifest(WEB).manifest).filter((n) => n === ARMOR_ID);
  ok("重复跑不重复登记", listed.length === 1, listed);
  ok("重复跑仍退出 0", again.status === 0, again.stdout);
  ok("重复跑不再复制（已是就位状态）", /都已就位/.test(again.stdout), again.stdout);
}

// ---- 9) 端到端：--force 能重落文件 ----
{
  const target = path.join(WEB, "node_modules", ARMOR_ID, "cordis.patch.yml");
  fs.writeFileSync(target, "# tampered\n", "utf8");
  const res = run(["--dsh-home", DSH, "--profile", "web", "--force"]);
  ok("--force 退出码 0", res.status === 0, res.stdout);
  ok("--force 覆盖掉被改过的文件", fs.readFileSync(target, "utf8").includes("refusalRetry"), fs.readFileSync(target, "utf8"));
}

// ---- 10) 旧版手写块：登记后被摘掉，并留备份 ----
{
  const patchFile = path.join(WEB, "cordis.patch.yml");
  fs.writeFileSync(
    patchFile,
    `- insert: []\n# >>> ${ARMOR_ID}\n- insert:\n    - id: ${ARMOR_ID}\n# <<< ${ARMOR_ID}\n`,
    "utf8",
  );
  const res = run(["--dsh-home", DSH, "--profile", "web", "--force"]);
  const txt = fs.readFileSync(patchFile, "utf8");
  ok("手写块已摘掉", !txt.includes(`# >>> ${ARMOR_ID}`), txt);
  ok("摘块前留了备份", fs.readdirSync(path.join(DSH, "dsh-purge", "gateway-shield-backups")).some((f) => f.startsWith("cordis.patch.yml.")));
  ok("摘块这轮退出码 0", res.status === 0, res.stdout);
}

// ---- 收尾 ----
fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log("");
console.log(`${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);