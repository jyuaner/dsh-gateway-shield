/**
 * 一键装齐「三件套」。
 *
 * 本插件单独装上是能跑的，但它是**空转的**：它管的层在「请求出网之后、
 * 模型落笔之前」，而这一层要有对象才谈得上管。对象来自两个连接器
 * （WorkBuddy / Qoder provider），另一半破甲来自 dsh-purge。
 *
 *     行为  dsh-purge Community        提示词 / 规则 / 预设，让 Agent 不推脱
 *     传输  dsh-gateway-shield         出网前清洗 + 软拒绝重试   ← 本包
 *     路由  dsh-connect-workbuddy      用哪个模型 / 凭据 / 积分
 *           dsh-qoder-connect
 *
 * 所以「装这个」和「装那三个」在体验上应该是同一件事：一条命令。
 *
 * ## 为什么不是「下载 tarball 再解包」
 *
 * 本包自己是零依赖的，解包即用（bootstrap.mjs 就是这么干的）。三个搭档不是：
 * 它们各自带 `dependencies`（purge 带 yaml，workbuddy 带 schemastery），
 * 直接复制文件会得到一个「看上去装好了、import 就炸」的目录。所以这里走
 * profile 的包管理器（pnpm / npm），让依赖树由它解析。
 *
 * ## 装完还必须登记
 *
 * DSH 只从 `dsh.profile.bundles` 读组合包（见 lib/profile.js 的说明）。
 * 包管理器负责「文件到位」，`ensureBundles` 负责「启动时真的会加载」。
 * 少了后一步，命令会成功、目录会存在、插件一行都不会跑。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { backupFile, bundlesOf, declaresBundle, ensureBundles, readManifest } from "./profile.js";

export const SHIELD_ID = "dsh-gateway-shield";

/**
 * 顺序即安装顺序，也即追加进 `dsh.profile.bundles` 的顺序：
 * 行为层在前，路由层在后，读日志时能对上「先有倾向、再有入口」。
 */
export const COMPANIONS = [
  {
    id: "dsh-purge-community",
    title: "dsh-purge Community",
    layer: "行为",
    role: "提示词 / 规则 / 预设，让 Agent 不推脱",
    repo: "kingcharleslzy-ai/dsh-purge",
    minNode: [18, 0],
    login: false,
  },
  {
    id: "dsh-connect-workbuddy",
    title: "DSH Connect WorkBuddy",
    layer: "路由",
    role: "把本机登录的 WorkBuddy 模型接进 DSH",
    repo: "dingminhua/dsh-connect-workbuddy",
    minNode: [22, 19],
    login: true,
  },
  {
    id: "dsh-qoder-connect",
    title: "DSH Qoder Connect",
    layer: "路由",
    role: "把本机登录的 Qoder 模型接进 DSH",
    repo: "masknull/dsh-qoder-connect",
    minNode: [22, 19],
    login: true,
  },
];

export const COMPANION_IDS = COMPANIONS.map((c) => c.id);

/** 包管理器认的依赖写法：GitHub 仓库，走默认分支。 */
export function specOf(companion) {
  return `github:${companion.repo}`;
}

export function findCompanion(id) {
  return COMPANIONS.find((c) => c.id === id);
}

/**
 * 按 `--only` / `--skip` 选子集。
 * 未知 id 不静默吞掉，单独回报，避免「我以为装了、其实拼错了」。
 */
export function selectCompanions({ only = [], skip = [] } = {}) {
  const unknown = [];
  const onlySet = new Set();
  for (const id of only) {
    if (!findCompanion(id)) unknown.push(id);
    else onlySet.add(id);
  }
  const skipSet = new Set();
  for (const id of skip) {
    if (!findCompanion(id)) unknown.push(id);
    else skipSet.add(id);
  }
  const base = onlySet.size > 0 ? COMPANIONS.filter((c) => onlySet.has(c.id)) : COMPANIONS;
  return { selected: base.filter((c) => !skipSet.has(c.id)), unknown };
}

export function parseVersion(version) {
  const m = String(version ?? "").replace(/^v/, "").match(/^(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

/** Node 主次版本是否满足 `[major, minor]` 下限。 */
export function nodeSatisfied(minNode, version) {
  const cur = parseVersion(version);
  if (!cur || !Array.isArray(minNode)) return true;
  const [maj, min] = minNode;
  if (cur[0] !== maj) return cur[0] > maj;
  return cur[1] >= min;
}

/** 读 profile 里已装了什么（只看目录，不跑包管理器，零副作用）。 */
export function detectInstalled(profileDir, ids = COMPANION_IDS) {
  const out = new Map();
  for (const id of ids) {
    const dir = path.join(profileDir, "node_modules", id);
    const decl = declaresBundle(dir);
    let version = decl.version;
    if (version === undefined) {
      try {
        version = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version ?? "?";
      } catch {
        version = undefined;
      }
    }
    out.set(id, { installed: version !== undefined, version: version ?? null, declaresBundle: decl.ok, reason: decl.reason });
  }
  return out;
}

/**
 * profile 由谁管依赖：有 pnpm 的痕迹就用 pnpm，否则 npm。
 * 纯看文件，不探 PATH —— 探测会把「没装 pnpm」变成一次可疑的 300ms 超时。
 */
export function detectPackageManager(profileDir) {
  if (fs.existsSync(path.join(profileDir, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(profileDir, "pnpm-workspace.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(profileDir, "package-lock.json"))) return "npm";
  return "pnpm";
}

export function pmCommand(pm, specs) {
  if (pm === "npm") return { cmd: "npm", args: ["install", "--save-prod", ...specs] };
  return { cmd: "pnpm", args: ["add", "--save-prod", ...specs] };
}

/**
 * 算一份可打印、可测试的安装计划。纯函数：不写盘、不执行命令。
 *
 * @returns {{pm:string, items:Array, todo:Array, warnings:Array<string>, unknown:Array<string>}}
 */
export function planCompanions({ profileDir, nodeVersion = process.versions.node, only = [], skip = [], pm } = {}) {
  const { selected, unknown } = selectCompanions({ only, skip });
  const installed = detectInstalled(profileDir, COMPANION_IDS);
  const warnings = [];

  const items = selected.map((c) => {
    const state = installed.get(c.id);
    const tooOld = !nodeSatisfied(c.minNode, nodeVersion);
    if (tooOld && !state.installed) {
      warnings.push(
        `${c.id} 声明 Node ${c.minNode[0]}.${c.minNode[1]}+，当前 ${nodeVersion}；` +
          `包管理器大概率会以 ERR_PNPM_UNSUPPORTED_ENGINE 失败`,
      );
    }
    return {
      ...c,
      installed: state.installed,
      version: state.version,
      action: state.installed ? "skip" : "install",
      spec: specOf(c),
    };
  });

  const todo = items.filter((i) => i.action === "install");
  return { pm: pm ?? detectPackageManager(profileDir), items, todo, warnings, unknown };
}

function defaultRun(cmd, args, { cwd }) {
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    // Windows 上 pnpm/npm 是 .cmd/.ps1 垫片，没有 shell 就 ENOENT。
    shell: process.platform === "win32",
    env: process.env,
  });
  return { code: res.status ?? 1, error: res.error?.message };
}

const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"];

/**
 * 执行计划：备份清单 → 一次性 add 全部缺的包 → 复查目录是否真的出现。
 *
 * 只发**一条** add 命令，而不是每个包一条：pnpm 每次 add 都会重解一遍依赖树，
 * 三条命令等于三次重解，中间任何一次失败都会留下半套。
 */
export function installCompanions({
  profileDir,
  backupDir = null,
  plan,
  dryRun = false,
  run = defaultRun,
  now = new Date(),
} = {}) {
  const { pm, todo } = plan;
  if (todo.length === 0) {
    return { ok: true, ran: false, reason: "nothing-missing", command: null, backups: [], results: [] };
  }

  const { cmd, args } = pmCommand(pm, todo.map((i) => i.spec));
  const command = `${cmd} ${args.join(" ")}`;

  if (dryRun) return { ok: true, ran: false, reason: "dry-run", command, backups: [], results: [] };

  const backups = [];
  const manifestPath = path.join(profileDir, "package.json");
  const manifestBackup = backupFile(manifestPath, backupDir, "package.json", now);
  if (manifestBackup) backups.push(manifestBackup);
  for (const lock of LOCKFILES) {
    const file = path.join(profileDir, lock);
    if (!fs.existsSync(file)) continue;
    const bak = backupFile(file, backupDir, lock, now);
    if (bak) backups.push(bak);
  }

  const res = run(cmd, args, { cwd: profileDir });
  if (res.code !== 0) {
    return {
      ok: false,
      ran: true,
      code: res.code,
      command,
      backups,
      error: res.error ?? `exit ${res.code}`,
      hint: "依赖树可能被中断，用上面 backups 里的文件覆盖回去即可回到装之前的状态",
      results: [],
    };
  }

  const after = detectInstalled(profileDir, todo.map((i) => i.id));
  const results = todo.map((i) => {
    const state = after.get(i.id);
    return { id: i.id, installed: state?.installed ?? false, version: state?.version ?? null };
  });
  const failures = results.filter((r) => !r.installed);

  return {
    ok: failures.length === 0,
    ran: true,
    command,
    backups,
    results,
    failures: failures.map((f) => f.id),
    error: failures.length === 0 ? undefined : `命令成功但目录没出现：${failures.map((f) => f.id).join(", ")}`,
  };
}

/**
 * 装完登记：把已就位的包追加进 `dsh.profile.bundles`。
 * `--dry-run` 时只算不写 —— 而且**只报真正会新增的**，不然会把「已经在了」
 * 也印成「将追加」，看日志的人会以为清单要变。
 */
export function registerBundles({ profileDir, ids, backupDir = null, dryRun = false, now = new Date() } = {}) {
  const present = ids.filter((id) => declaresBundle(path.join(profileDir, "node_modules", id)).ok);
  if (!dryRun) return ensureBundles(profileDir, present, { backupDir, now });

  const read = readManifest(profileDir);
  const listed = new Set(read.ok ? bundlesOf(read.manifest) : []);
  const added = present.filter((id) => !listed.has(id));
  return {
    ok: read.ok,
    changed: added.length > 0,
    added,
    already: present.filter((id) => listed.has(id)),
    skipped: [],
    dryRun: true,
  };
}

/** 面向终端的一行摘要，install.mjs / bootstrap.mjs 共用。 */
export function describePlan(plan) {
  return plan.items.map((i) => {
    const mark = i.action === "install" ? "+" : "·";
    const state = i.installed ? `已装 ${i.version ?? ""}`.trim() : "缺";
    return `${mark} ${i.id.padEnd(22)} ${i.layer}  ${state}  ${i.role}`;
  });
}