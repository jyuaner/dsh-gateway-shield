/**
 * armor/detect.mjs —— 整合包的检测层（零副作用：只读，不写盘、不联网、不调包管理器）。
 *
 * ## 为什么原版 install.mjs 的检测不够
 *
 * 原版 `lib/companions.js` 把搭档写成三行硬编码：
 *
 *     dsh-purge-community / dsh-connect-workbuddy / dsh-qoder-connect
 *
 * 但真实的机器上，同一个「破甲」角色可能由不同的包承担：
 *
 *     web profile      dsh-purge-community   github:kingcharleslzy-ai/dsh-purge   v1.6.84
 *     desktop profile  dsh-purge             github:mmparko/dsh-purge
 *
 * 硬编码 id 的后果是：desktop 那一份检测不到 → 要么被当成「缺」而去下载一份
 * 同角色的第二个包（两个破甲插件同时挂 systemPrompt，重复注入），要么干脆看不见。
 *
 * 所以这一层的判定原则是**按角色找，不按 id 找**：只要某个 profile 里已经有
 * 一个「提供破甲行为层」的包装好且登记了，就算这一环已就位，绝不再装第二个。
 *
 * ## 为什么检测结果要带着「来源」
 *
 * 用户是 `github:` 装的还是 registry 装的，决定的不是「装没装」，而是
 * **「要不要让包管理器碰它」**。`github:` 来源经 `pnpm add` 重解依赖树时
 * 可能被换成另一个 commit；registry 来源则可能被升到不兼容的小版本。
 * 所以 detect 把 sourceKind 标出来，armor.mjs 据此决定：只复制文件、不碰依赖树。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkPackage } from "../lib/manifest.js";
import { declaresBundle, readManifest } from "../lib/profile.js";
import { PROVIDER_RULES, UNIVERSAL_PHRASES, profileFor } from "../lib/fingerprints.js";

export const ARMOR_ID = "dsh-gateway-shield";

/** 承担「破甲行为层」的包名。按角色认，不按单一 id 认。 */
export const PURGE_IDS = ["dsh-purge-community", "dsh-purge"];

/** 三段式版本 → 数字元组，`0.2.2-rc.5` → [0,2,2]（预发布号不参与区间判断）。 */
export function tuple(version) {
  const m = String(version ?? "").replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** 本插件声明的宿主区间：>=0.2.1-rc.1 <0.3.0。 */
export const HOST_RANGE = { label: ">=0.2.1-rc.1 <0.3.0", min: [0, 2, 1], maxExclusive: [0, 3, 0] };

export function hostCompatible(version) {
  const t = tuple(version);
  if (!t) return { known: false, compatible: null, reason: "宿主版本未知（按插件声明不阻断，但请自行确认）" };
  if (cmp(t, HOST_RANGE.min) < 0) return { known: true, compatible: false, reason: `低于下限 ${HOST_RANGE.label}` };
  if (cmp(t, HOST_RANGE.maxExclusive) >= 0) return { known: true, compatible: false, reason: `达到上限 ${HOST_RANGE.label}` };
  return { known: true, compatible: true, reason: `在 ${HOST_RANGE.label} 内` };
}

/** Node 主次版本是否满足 `[major, minor]` 下限（与 lib/companions.js 同口径）。 */
export function nodeSatisfied(minNode, version = process.versions.node) {
  const m = String(version).replace(/^v/, "").match(/^(\d+)\.(\d+)/);
  if (!m || !Array.isArray(minNode)) return true;
  const maj = Number(m[1]);
  const min = Number(m[2]);
  const [wantMaj, wantMin] = minNode;
  if (maj !== wantMaj) return maj > wantMaj;
  return min >= wantMin;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 读一个已安装包的清单，带「文件在不在 / 会不会让宿主起不来」。 */
export function inspectPackage(profileDir, id) {
  const dir = path.join(profileDir, "node_modules", id);
  const manifest = readJson(path.join(dir, "package.json"));
  if (!manifest) return { id, dir, installed: false, version: null, bundle: declaresBundle(dir), health: null, manifest: null };
  return {
    id,
    dir,
    installed: true,
    version: typeof manifest.version === "string" ? manifest.version : "?",
    bundle: declaresBundle(dir),
    health: checkPackage(dir),
    manifest,
  };
}

/** `dependencies` 里那个字段长什么样 —— 决定「要不要让包管理器碰它」。 */
export function sourceOf(manifest, id) {
  const spec =
    manifest?.dependencies?.[id] ??
    manifest?.devDependencies?.[id] ??
    manifest?.optionalDependencies?.[id] ??
    null;
  if (spec === null) return { spec: null, kind: "unknown" };
  const s = String(spec);
  if (/^github:|^git\+|^git:|^https?:\/\/github\.com/.test(s)) return { spec: s, kind: "git" };
  if (/^file:|^link:|^workspace:/.test(s)) return { spec: s, kind: "local" };
  if (/^[\^~]?\d/.test(s)) return { spec: s, kind: "registry" };
  return { spec: s, kind: "other" };
}

/** 宿主版本：从已安装的 @deepseek-ai/dsh-base 反查，几个可能的位置都试一遍。 */
export function detectHostVersion(dshHome) {
  const tried = [];
  const candidates = [
    path.join(dshHome, "profiles", "node_modules", "@deepseek-ai", "dsh-base", "package.json"),
    path.join(dshHome, "profiles", "web", "node_modules", "@deepseek-ai", "dsh-base", "package.json"),
    path.join(dshHome, "profiles", "desktop", "node_modules", "@deepseek-ai", "dsh-base", "package.json"),
  ];
  for (const file of candidates) {
    tried.push(file);
    const j = readJson(file);
    if (j?.version) return { version: j.version, from: file, tried };
  }
  if (process.env.DSH_VERSION?.trim()) {
    return { version: process.env.DSH_VERSION.trim(), from: "env:DSH_VERSION", tried };
  }
  return { version: null, from: null, tried };
}

/** 该 profile 的依赖管理器痕迹（只读文件，不探 PATH）。 */
export function detectPackageManager(profileDir) {
  if (fs.existsSync(path.join(profileDir, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(profileDir, "pnpm-workspace.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(profileDir, "package-lock.json"))) return "npm";
  return "pnpm";
}

/**
 * 破甲插件（行为层）现状：按角色找出这个 profile 里所有的候选，
 * 逐个标注 id / 版本 / 来源 / 是否登记 / 清单健康，并给出「这一环是否已就位」。
 */
export function detectPurge(profileDir, manifest, bundles) {
  const candidates = [];
  for (const id of PURGE_IDS) {
    const pkg = inspectPackage(profileDir, id);
    if (!pkg.installed && !manifest?.dependencies?.[id]) continue;
    candidates.push({
      ...pkg,
      source: sourceOf(manifest, id),
      inBundles: bundles.includes(id),
      registeredButMissing: !pkg.installed && bundles.includes(id),
    });
  }
  // 兜底：依赖里还有别的名字带 purge 的包，也报出来，避免「看不见的第二个破甲」。
  for (const id of Object.keys(manifest?.dependencies ?? {})) {
    if (PURGE_IDS.includes(id)) continue;
    if (!/purge/i.test(id)) continue;
    const pkg = inspectPackage(profileDir, id);
    candidates.push({
      ...pkg,
      source: sourceOf(manifest, id),
      inBundles: bundles.includes(id),
      registeredButMissing: !pkg.installed && bundles.includes(id),
      extra: true,
    });
  }
  const active = candidates.filter((c) => c.installed && c.inBundles && c.health?.startable !== false);
  return { candidates, active, satisfied: active.length > 0 };
}

/**
 * 检测单个 profile。
 *
 * @param {{dshHome:string, name:string, dshVersion?:string|null}} opts
 */
export function detectProfile({ dshHome, name, dshVersion = null }) {
  const dir = path.join(dshHome, "profiles", name);
  const read = readManifest(dir);
  const conflicts = [];
  const notes = [];

  if (!read.ok) {
    return {
      name,
      dir,
      ok: false,
      manifest: null,
      conflicts: [{ level: "error", code: "profile-unreadable", message: read.error }],
      notes,
    };
  }

  const manifest = read.manifest;
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];

  const purge = detectPurge(dir, manifest, bundles);
  const providers = detectProviders(dir);
  const workbuddy = inspectPackage(dir, "dsh-connect-workbuddy");
  const qoder = inspectPackage(dir, "dsh-qoder-connect");
  const armor = inspectPackage(dir, ARMOR_ID);

  // ---- 冲突 / 风险 ----
  if (armor.installed && armor.health?.startable === false) {
    const fatal = armor.health.problems.find((p) => p.fatal);
    conflicts.push({
      level: "error",
      code: "armor-toxic-manifest",
      message: `已装的 ${ARMOR_ID} 清单会让 DSH 起不来：${fatal?.message ?? "清单不合格"}`,
    });
  }
  for (const c of purge.candidates) {
    if (c.installed && c.health?.startable === false) {
      conflicts.push({
        level: "error",
        code: "purge-toxic-manifest",
        message: `${c.id} 清单会让 DSH 起不来：${c.health.problems.find((p) => p.fatal)?.message ?? "清单不合格"}`,
      });
    }
    if (c.installed && !c.inBundles) {
      conflicts.push({
        level: "warn",
        code: "purge-not-registered",
        message: `${c.id} 装了但不在 dsh.profile.bundles 里 —— 启动时不会加载，破甲那一半是空的`,
      });
    }
    if (c.registeredButMissing) {
      conflicts.push({
        level: "warn",
        code: "purge-registered-missing",
        message: `${c.id} 在 dsh.profile.bundles 里但目录不存在 —— 启动会打一行 skipping profile bundle`,
      });
    }
  }
  if (!purge.satisfied) {
    conflicts.push({
      level: "warn",
      code: "purge-missing",
      message: "这个 profile 没有生效中的破甲插件：本插件只在传输层工作，行为层缺一半",
    });
  }
  if (purge.candidates.length > 1) {
    conflicts.push({
      level: "warn",
      code: "purge-duplicated",
      message: `这个 profile 装了 ${purge.candidates.length} 个破甲插件（${purge.candidates.map((c) => c.id).join(", ")}）—— 两个都挂 systemPrompt 会重复注入`,
    });
  }

  // ---- purge 的 refusalRetry 与本插件的重试是同一件事 ----
  const tuningFile = path.join(dshHome, "dsh-purge", "tuning.json");
  const tuning = readJson(tuningFile);
  if (tuning && tuning.refusalRetry === true) {
    conflicts.push({
      level: "warn",
      code: "refusal-retry-duplicated",
      message:
        "purge 的 tuning.json 打开了 refusalRetry，而它那份加固段走 next(opts)、参数会被丢弃（空转）。" +
        "建议改回 false，把重试交给本插件",
      file: tuningFile,
    });
  }

  const appliedFile = path.join(dshHome, "dsh-purge", "applied.json");
  const applied = readJson(appliedFile);
  if (applied?.version) notes.push(`purge 宿主补丁已应用：v${applied.version}（${applied.at ?? "?"}）`);

  // ---- 旧版手写注册块 ----
  const profilePatch = path.join(dir, "cordis.patch.yml");
  let legacyBlock = false;
  try {
    const txt = fs.readFileSync(profilePatch, "utf8");
    legacyBlock = txt.includes(`# >>> ${ARMOR_ID}`) && txt.includes(`# <<< ${ARMOR_ID}`);
  } catch {
    /* 没有就是没有 */
  }

  const host = hostCompatible(dshVersion);
  if (host.compatible === false) {
    conflicts.push({ level: "warn", code: "host-out-of-range", message: `宿主 ${dshVersion} ${host.reason}` });
  }

  const armorListed = bundles.includes(ARMOR_ID);
  const armorStartable = armor.health?.startable !== false;

  return {
    name,
    dir,
    ok: true,
    pm: detectPackageManager(dir),
    manifest,
    bundles,
    purge,
    providers,
    partners: { workbuddy, qoder },
    armor: { ...armor, inBundles: armorListed },
    legacyBlock,
    conflicts,
    notes,
    // 「需要装」= 文件不在 / 没登记 / 清单会让宿主起不来。三者都过才是就位。
    needsInstall: !armor.installed || !armorListed || !armorStartable,
  };
}

/** 列出所有像样的 profile（有 package.json 的目录）。 */
export function listProfiles(dshHome) {
  const root = path.join(dshHome, "profiles");
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => fs.existsSync(path.join(root, n, "package.json")));
  } catch {
    return [];
  }
}

export function defaultDshHome() {
  return process.env.DSH_HOME?.trim() || path.join(os.homedir(), ".dsh");
}

/**
 * 装了哪个连接器 → 哪几个 provider 档位真的会走到。
 *
 * 这一层回答的是「全模型到底覆盖到哪」：不是「支持几个名字」，而是
 * **每个真实会出网的 provider，落到哪一档、那一档有几条、是实测还是推断**。
 */
export const PROVIDER_PLUGINS = [
  { id: "dsh-connect-workbuddy", label: "WorkBuddy", provider: "workbuddy" },
  { id: "dsh-qoder-connect", label: "Qoder", provider: "qoder" },
  { id: "dsh-connect-trae", label: "Trae", provider: "trae" },
  { id: "dsh-connect-doubao", label: "Doubao", provider: "doubao" },
];

/**
 * 这个 profile 的网关覆盖矩阵。
 *
 * 内置 provider（deepseek / anthropic / openai 系）不靠连接器，宿主自带，
 * 所以它们在矩阵里恒为「可用」，只是不一定有请求走。
 */
export function detectProviders(profileDir) {
  const present = PROVIDER_PLUGINS.filter((p) => fs.existsSync(path.join(profileDir, "node_modules", p.id)));
  const activeIds = new Set(present.map((p) => p.provider));
  const matrix = PROVIDER_RULES.map((rule) => {
    const prof = profileFor(rule.sample);
    const extra = prof.phrases.length - UNIVERSAL_PHRASES.length;
    return {
      id: rule.id,
      label: rule.label,
      confidence: rule.confidence,
      phrases: prof.phrases.length,
      extra,
      builtin: !PROVIDER_PLUGINS.some((p) => p.provider === rule.id),
      active: activeIds.has(rule.id),
    };
  });
  return {
    present: present.map((p) => ({ id: p.id, label: p.label, provider: p.provider })),
    matrix,
    // 通用层永远在，所以「未覆盖」这件事只可能是「新网关有新指纹」。
    fallback: { phrases: UNIVERSAL_PHRASES.length },
  };
}

/**
 * 全量体检。`--json` 直接吃这个对象。
 *
 * @param {{dshHome?:string, profiles?:string[], dshVersion?:string|null}} opts
 */
export function detectAll({ dshHome = defaultDshHome(), profiles = null, dshVersion = null } = {}) {
  const names = profiles && profiles.length > 0 ? profiles : listProfiles(dshHome);
  const host = detectHostVersion(dshHome);
  const version = dshVersion ?? host.version;
  const hostState = hostCompatible(version);

  const profileStates = names.map((name) => detectProfile({ dshHome, name, dshVersion: version }));
  const allConflicts = profileStates.flatMap((p) => (p.conflicts ?? []).map((c) => ({ ...c, profile: p.name })));

  const errors = allConflicts.filter((c) => c.level === "error");
  const warns = allConflicts.filter((c) => c.level === "warn");
  const todo = profileStates.filter((p) => p.ok && p.needsInstall);

  return {
    dshHome,
    node: process.versions.node,
    host: { version, from: host.from, ...hostState },
    profiles: profileStates,
    conflicts: allConflicts,
    summary: {
      profiles: profileStates.length,
      needsInstall: todo.map((p) => p.name),
      errors: errors.length,
      warns: warns.length,
      verdict: errors.length > 0 ? "blocked" : todo.length > 0 ? "installable" : "ready",
    },
    todo: todo.map((p) => p.name),
  };
}

/** 终端可读的一段话。armor.mjs 和测试共用。 */
export function describeDetection(det) {
  const lines = [];
  const mark = (b) => (b ? "✓" : "·");
  lines.push(`宿主 DeepSeek Harness ${det.host.version ?? "未知"}（${det.host.reason}）`);
  lines.push(`Node ${det.node}    DSH_HOME ${det.dshHome}`);
  lines.push("");

  for (const p of det.profiles) {
    if (!p.ok) {
      lines.push(`✗ profile ${p.name}：${p.conflicts[0]?.message ?? "无法读取"}`);
      continue;
    }
    const a = p.armor;
    lines.push(
      `profile ${p.name}  ${a.installed ? `shield v${a.version}${a.inBundles ? "（已登记）" : "（未登记）"}` : "shield 未装"}`,
    );
    for (const c of p.purge.candidates) {
      const src = c.source.kind === "unknown" ? "" : `  ${c.source.kind}:${c.source.spec}`;
      lines.push(
        `  ${mark(c.installed && c.inBundles)} 破甲 ${c.id.padEnd(20)} ${c.installed ? `v${c.version}` : "未装"}` +
          `${c.inBundles ? "  已登记" : "  未登记"}${src}${c.extra ? "  ! 额外候选" : ""}`,
      );
    }
    for (const [key, label] of [
      ["workbuddy", "WorkBuddy"],
      ["qoder", "Qoder"],
    ]) {
      const x = p.partners[key];
      lines.push(`  ${mark(x.installed && p.bundles.includes(x.id))} 路由 ${label.padEnd(18)} ${x.installed ? `v${x.version}` : "未装"}`);
    }
    if (p.providers) {
      const tags = p.providers.matrix
        .map((m) => {
          const tag = m.confidence === "measured" ? "实测" : m.confidence === "inferred" ? "推断" : "通用";
          return `${m.id} ${tag}${m.extra ? `+${m.extra}` : ""}`;
        })
        .join(" · ");
      lines.push(`  ≡ 网关档位 ${tags}`);
      lines.push(`    未识别的 provider 仍走通用层（${p.providers.fallback.phrases} 条），不会静默跳过`);
    }
    if (p.needsInstall) lines.push(`  → 需要装 shield`);
    for (const c of p.conflicts) lines.push(`  ${c.level === "error" ? "✗" : "!"} [${c.code}] ${c.message}`);
    for (const n of p.notes) lines.push(`  · ${n}`);
    lines.push("");
  }

  const s = det.summary;
  lines.push(
    s.verdict === "ready"
      ? "已就位：每个 profile 的 shield 都装好并登记，无需动作。"
      : s.verdict === "blocked"
        ? `有 ${s.errors} 个阻断项，先处理再装。`
        : `可以装：${s.needsInstall.join(", ") || "无"} 缺 shield。`,
  );
  return lines.join("\n");
}