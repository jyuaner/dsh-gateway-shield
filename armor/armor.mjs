#!/usr/bin/env node
/**
 * armor/armor.mjs —— 一个入口做完「检测 → 落文件 → 登记 → 复检」。
 *
 * ## 和原版 install.mjs 的分工
 *
 *   install.mjs   上游原版：装本体 + 顺手补搭档（会调包管理器）
 *   armor.mjs     整合版：先体检所有 profile，再只装本体，**绝不碰包管理器**
 *
 * 整合版之所以把「补搭档」这一步砍掉，不是省事，而是因为它会伤到用户已经在用的东西：
 *
 *   `pnpm add github:yu994419160/dsh-purge1.7.3-`
 *     → 重写 pnpm-lock.yaml
 *     → 用户当前那份 `github:yu994419160/dsh-purge1.7.3-` 会被重新解析
 *     → 落到另一个 commit 就是换了一个破甲版本，用户的补丁状态、注入文本全变
 *
 * 本插件是零依赖的纯宿主包（`llm/stream` 钩子 + 一个 yml），复制文件就够用。
 * 所以这里的策略是：**已就位的破甲 / 连接器一律不动，只复制本插件自己的文件。**
 *
 * 破甲没装时的确需要走一次包管理器 —— 那条路交给 `install.mjs`（0.6.2 起默认
 * 就装破甲），本文件只负责报告「还缺什么」：`node install.mjs --only dsh-purge`。
 *
 * ## 用法
 *
 *   node armor/armor.mjs                 一键：体检 → 装上 → 登记 → 复检
 *   node armor/armor.mjs --check         只体检（零写入）
 *   node armor/armor.mjs --json          机器可读的体检结果（隐含 --check）
 *   node armor/armor.mjs --dry-run       打印会做什么，不落盘
 *   node armor/armor.mjs --all-profiles  web 与 desktop 都装
 *   node armor/armor.mjs --profile web   指定单个 profile
 *   node armor/armor.mjs --dsh-home PATH 指定 DSH 数据目录
 *
 * 退出码：0 就位 / 1 有阻断项 / 2 参数错误
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkPackage, describeProblems } from "../lib/manifest.js";
import { ensureBundles, hasMarkerBlock, readManifest, stripMarkerBlock } from "../lib/profile.js";
import { ARMOR_ID, defaultDshHome, describeDetection, detectAll, listProfiles } from "./detect.mjs";

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // 包根目录
const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  const v = i >= 0 ? args[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : fallback;
}

if (has("help") || has("h")) {
  console.log(
    [
      "用法：node armor/armor.mjs [选项]",
      "",
      "  （无参数）          一键：体检 → 落文件 → 登记 → 复检",
      "  --check             只体检，不写盘",
      "  --json              输出体检结果 JSON（隐含 --check）",
      "  --dry-run           打印计划，不落盘",
      "  --profile NAME      指定 profile（默认 web）",
      "  --all-profiles      所有带 package.json 的 profile 都装",
      "  --dsh-home PATH     指定 DSH 数据目录（默认 ~/.dsh）",
      "  --help              这段文字",
    ].join("\n"),
  );
  process.exit(0);
}

const DSH_HOME = opt("dsh-home", defaultDshHome());
const CHECK = has("check") || has("json");
const JSON_OUT = has("json");
const DRY = has("dry-run");
const ALL = has("all-profiles");
/** 强制重落文件（升级、修好自带副本、怀疑目标目录被改过时用）。 */
const FORCE = has("force");

/** 装进 profile 的文件。cordis.patch.yml 是注册凭据，armor/ 让目标目录也能自查。 */
const SHIP = ["lib", "armor", "cordis.patch.yml", "package.json", "README.md", "CHANGELOG.md", "LICENSE", "install.mjs", "bootstrap.mjs"];

const log = (m = "") => process.stdout.write(`${m}\n`);

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** 递归复制、原地覆盖，跳过 node_modules / .git / 备份。Windows 上不 rename（占用会 EBUSY）。 */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (["node_modules", ".git"].includes(e.name)) continue;
    if (e.name.endsWith(".bak") || e.name.includes(".bak-")) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) n += copyDir(s, d);
    else if (e.isFile()) {
      fs.copyFileSync(s, d);
      n += 1;
    }
  }
  return n;
}

/** 本包自己的 dsh.bundle 声明是否有效（未声明 = 登记时会被宿主跳过）。 */
function readBundleDeclaration() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8"));
    const rel = j?.dsh?.bundle?.patch;
    if (typeof rel !== "string" || rel === "") return { ok: false, reason: "package.json 缺 dsh.bundle.patch" };
    if (!fs.existsSync(path.resolve(HERE, rel))) return { ok: false, reason: `声明的 ${rel} 不在包里` };
    return { ok: true, rel, version: j.version ?? "?" };
  } catch (e) {
    return { ok: false, reason: `读 package.json 失败：${e.message}` };
  }
}

/** 目标 profile 的选取。默认 web —— 这台机器上跑着 Web GUI 的就是它。 */
function pickProfiles() {
  const explicit = opt("profile", null);
  const all = listProfiles(DSH_HOME);
  if (explicit) {
    if (!all.includes(explicit)) {
      log(`✗ ${path.join(DSH_HOME, "profiles", explicit)} 下没有 package.json。可选：${all.join(" / ") || "无"}`);
      process.exit(2);
    }
    return [explicit];
  }
  if (ALL) return all.length > 0 ? all : [];
  if (all.includes("web")) return ["web"];
  if (all.length > 0) return [all[0]];
  log(`✗ ${path.join(DSH_HOME, "profiles")} 下没有可用 profile`);
  process.exit(2);
  return [];
}

/**
 * 把本包装进一个 profile。
 *
 * 顺序刻意与宿主语义一致：**先文件、再登记、最后摘手写块**。
 * 反过来（先摘手写块）会留下「文件在、谁都没加载」的孤儿目录。
 */
function installInto({ name, dryRun, backupDir }) {
  const profileDir = path.join(DSH_HOME, "profiles", name);
  const target = path.join(profileDir, "node_modules", ARMOR_ID);
  const result = { profile: name, target, steps: [], ok: false };

  // 0) 装前预检：这份清单会不会让宿主起不来
  const self = checkPackage(HERE);
  if (!self.startable) {
    result.steps.push({ level: "error", message: `本包清单会让 DSH 启动失败，拒绝安装：\n${describeProblems(self, "    ")}` });
    return result;
  }

  // 1) 落文件
  if (dryRun) {
    result.steps.push({ level: "dry", message: `将覆盖 ${SHIP.join(", ")} → ${target}` });
  } else {
    fs.mkdirSync(target, { recursive: true });
    let n = 0;
    for (const item of SHIP) {
      const s = path.join(HERE, item);
      if (!fs.existsSync(s)) continue;
      const d = path.join(target, item);
      if (fs.statSync(s).isDirectory()) n += copyDir(s, d);
      else {
        fs.copyFileSync(s, d);
        n += 1;
      }
    }
    result.steps.push({ level: "ok", message: `${n} 个文件已覆盖` });

    // 落盘后按「真正装进去的那份」复检：复制残留也可能让清单变质
    const installed = checkPackage(target);
    if (!installed.startable) {
      result.steps.push({ level: "error", message: `已安装的清单会让 DSH 起不来，停止登记：\n${describeProblems(installed, "    ")}` });
      return result;
    }
  }

  // 2) 登记：DSH 只从 dsh.profile.bundles 读组合包
  if (dryRun) {
    const listed = new Set(readManifest(profileDir).manifest?.dsh?.profile?.bundles ?? []);
    result.steps.push({
      level: "dry",
      message: listed.has(ARMOR_ID) ? "已在 dsh.profile.bundles 中" : `将把 ${ARMOR_ID} 追加进 dsh.profile.bundles`,
    });
  } else {
    const reg = ensureBundles(profileDir, [ARMOR_ID], { backupDir });
    if (!reg.ok) {
      result.steps.push({ level: "error", message: `登记失败：${reg.error}` });
      return result;
    }
    result.steps.push({
      level: "ok",
      message: reg.changed ? `已登记进 dsh.profile.bundles${reg.backup ? `（备份 ${path.basename(reg.backup)}）` : ""}` : "dsh.profile.bundles 已收录",
    });
    if (reg.skipped?.length) {
      for (const s of reg.skipped) result.steps.push({ level: "warn", message: `${s.name} 跳过登记：${s.reason}` });
      return result;
    }
  }

  // 3) 手写注册块：登记确认之后才摘
  const profilePatch = path.join(profileDir, "cordis.patch.yml");
  if (fs.existsSync(profilePatch)) {
    const txt = fs.readFileSync(profilePatch, "utf8");
    if (hasMarkerBlock(txt, ARMOR_ID)) {
      if (dryRun) {
        result.steps.push({ level: "dry", message: "将摘掉 cordis.patch.yml 里的手写注册块" });
      } else {
        fs.mkdirSync(backupDir, { recursive: true });
        const bak = path.join(backupDir, `cordis.patch.yml.${stamp()}`);
        fs.copyFileSync(profilePatch, bak);
        fs.writeFileSync(profilePatch, stripMarkerBlock(txt, ARMOR_ID), "utf8");
        result.steps.push({ level: "ok", message: `已摘掉手写注册块（备份 ${path.basename(bak)}）` });
      }
    }
  }

  result.ok = true;
  return result;
}

function main() {
  const targets = pickProfiles();

  // ---- 检测（永远先跑：这是这个包存在的理由） ----
  const det = detectAll({ dshHome: DSH_HOME, profiles: targets.length > 0 ? listProfiles(DSH_HOME) : null });

  if (JSON_OUT) {
    log(JSON.stringify({ ...det, targets, action: CHECK ? "check" : "install" }, null, 2));
    process.exit(det.summary.verdict === "blocked" ? 1 : 0);
  }

  log(describeDetection(det));
  log("");
  log(`本次安装目标：${targets.join(", ")}（加 --all-profiles 就是全部）`);
  log("");

  if (CHECK) process.exit(det.summary.verdict === "blocked" ? 1 : 0);

  if (det.summary.verdict === "blocked") {
    log("✗ 有阻断项，未做任何改动。先按上面的 [code] 处理。");
    process.exit(1);
  }

  const decl = readBundleDeclaration();
  if (!decl.ok) {
    log(`✗ 本包未正确声明 dsh.bundle：${decl.reason}`);
    process.exit(1);
  }

  const backupDir = path.join(DSH_HOME, "dsh-purge", "gateway-shield-backups");
  const installing = det.profiles.filter((p) => p.ok && targets.includes(p.name) && (FORCE || p.needsInstall));
  const installingNames = new Set(installing.map((p) => p.name));
  const ready = det.profiles.filter((p) => p.ok && !p.needsInstall && targets.includes(p.name) && !installingNames.has(p.name));

  log(`本插件 v${decl.version}  dsh.bundle.patch = ${decl.rel}`);
  log(
    `目标 profile：${installing.map((p) => p.name).join(", ") || "无（都已就位）"}` +
      `${ready.length ? `　已就位跳过：${ready.map((p) => p.name).join(", ")}` : ""}`,
  );
  log(`搭档：一律不动（已就位的破甲 / 连接器不会被包管理器碰）${DRY ? "　[dry-run]" : ""}`);
  log("");

  const results = [];
  for (const p of installing) {
    log(`── profile ${p.name}`);
    const r = installInto({ name: p.name, dryRun: DRY, backupDir });
    for (const s of r.steps) log(`  ${s.level === "error" ? "✗" : s.level === "warn" ? "!" : s.level === "dry" ? "*" : "✓"} ${s.message}`);
    results.push(r);
    log("");
  }

  if (DRY) {
    log("dry-run：没有写任何文件。去掉 --dry-run 就是真装。");
    return;
  }

  // ---- 复检：用同一套检测再看一遍，绿了才算完成 ----
  const after = detectAll({ dshHome: DSH_HOME, profiles: targets.length > 0 ? listProfiles(DSH_HOME) : null });
  const failed = after.profiles.filter((p) => targets.includes(p.name) && p.ok && p.needsInstall);
  const blocked = after.conflicts.filter((c) => c.level === "error" && targets.includes(c.profile));

  if (blocked.length > 0 || failed.length > 0) {
    log(`✗ 复检未通过：${blocked.map((c) => c.code).join(", ") || failed.map((p) => p.name).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  log("复检通过：");
  for (const p of after.profiles.filter((x) => targets.includes(x.name))) {
    const a = p.armor;
    log(
      `  ✓ ${p.name.padEnd(8)} shield v${a.version} 已登记` +
        `　破甲 ${p.purge.candidates.filter((c) => c.installed).map((c) => `${c.id}@${c.version}`).join(", ") || "未装 → 补：node install.mjs --only dsh-purge"}`,
    );
  }
  log("");
  log("完成。重启 DSH 后生效，日志里应出现：");
  log("  [gateway-shield] active | sanitize=true refusalRetry=true retryMax=2 providers=all");
  log("复查：node armor/armor.mjs --check");
}

main();