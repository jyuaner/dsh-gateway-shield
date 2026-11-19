/**
 * profile 清单读写。
 *
 * ## 为什么需要这个模块
 *
 * DSH 加载一个组合包（bundle）只认一处：`<profile>/package.json` 的
 * `dsh.profile.bundles` 数组（见 `dsh-app-boot` 的 `loadProfileDirectory`：
 * `bundles = manifest.dsh.profile.bundles ?? []`，逐项解析，**不看 dependencies**）。
 *
 * 也就是说：
 *
 *   pnpm add github:xxx/dsh-gateway-shield
 *     → 只是把文件放进了 <profile>/node_modules/
 *     → `dsh.profile.bundles` 里没有它
 *     → DSH 启动时**根本不会加载**
 *
 * 设置 → 插件面板之所以「装上就能用」，是因为面板在装完之后替你做了这一步：
 * `dsh-plugin-manager` 的 `reconcile()` 会把新依赖里声明了 `dsh.bundle` 的包
 * **追加**到 `dsh.profile.bundles` 末尾。命令行安装没有面板，就得自己补。
 *
 * 早期版本的手写注册块（`# >>> dsh-gateway-shield`）也是同一条路的旁支：
 * 它把条目写进 profile 的 `cordis.patch.yml`，一样能挂上，但两处并存会重复
 * 注册。所以本模块的顺序是「先确保 bundles 有，再摘手写块」——反过来会在
 * 摘掉手写块之后留下一个谁都不加载的孤儿目录。
 */
import fs from "node:fs";
import path from "node:path";
import { checkPackage } from "./manifest.js";

/** 读 profile 清单，失败不抛，返回原因。 */
export function readManifest(dir) {
  const file = path.join(dir, "package.json");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { ok: false, file, error: `读不到 ${file}：${e.message}` };
  }
  try {
    return { ok: true, file, text, manifest: JSON.parse(text) };
  } catch (e) {
    return { ok: false, file, error: `${file} 不是合法 JSON：${e.message}` };
  }
}

/** `dsh.profile.bundles`，缺省为空数组。 */
export function bundlesOf(manifest) {
  const list = manifest?.dsh?.profile?.bundles;
  return Array.isArray(list) ? list.filter((n) => typeof n === "string") : [];
}

/**
 * 某个已安装包是否声明了 `dsh.bundle`，且声明的 patch 文件真的在。
 * 返回 `{ ok, patch, version }`，`ok === false` 时带 `reason`。
 */
export function declaresBundle(pkgDir) {
  const file = path.join(pkgDir, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { ok: false, reason: `读不到 ${file}：${e.message}` };
  }
  const patch = manifest?.dsh?.bundle?.patch;
  if (typeof patch !== "string" || patch === "") {
    return { ok: false, reason: "package.json 缺 dsh.bundle.patch" };
  }
  if (!fs.existsSync(path.join(pkgDir, patch))) {
    return { ok: false, reason: `dsh.bundle.patch 指向的 ${patch} 不存在` };
  }
  return { ok: true, patch, version: manifest.version ?? "?" };
}

function stampOf(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

/** 备份单个文件到 backupDir，返回备份路径；目录建不出来就返回 null（不阻断主流程）。 */
export function backupFile(file, backupDir, baseName, date = new Date()) {
  if (!backupDir) return null;
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    const target = path.join(backupDir, `${baseName}.${stampOf(date)}`);
    fs.copyFileSync(file, target);
    return target;
  } catch {
    return null;
  }
}

/** 同目录临时文件 + rename，避免写一半断电留下坏清单。 */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件清不掉不影响结果 */
    }
    throw e;
  }
}

/**
 * 把 `names` 里尚未出现在 `dsh.profile.bundles` 的包追加进去。
 *
 * 与插件面板的 `reconcile()` 语义一致：**追加到末尾**、保持既有顺序、
 * 只接受目录里真的声明了 `dsh.bundle` 的包。已经在了就是 no-op。
 *
 * @param dir profile 目录
 * @param names 包名（顺序即追加顺序）
 * @param options.backupDir 清单被改动前先备份到这里
 */
export function ensureBundles(dir, names, { backupDir = null, now = new Date() } = {}) {
  const read = readManifest(dir);
  if (!read.ok) return { ok: false, error: read.error, added: [], already: [], skipped: [], changed: false };

  const manifest = read.manifest;
  const bundles = [...bundlesOf(manifest)];
  const seen = new Set(bundles);
  const added = [];
  const already = [];
  const skipped = [];

  for (const name of names) {
    if (typeof name !== "string" || name === "") continue;
    if (seen.has(name)) {
      already.push(name);
      continue;
    }
    const pkgDir = path.join(dir, "node_modules", name);
    const decl = declaresBundle(pkgDir);
    if (!decl.ok) {
      skipped.push({ name, reason: decl.reason });
      continue;
    }
    // 登记 = 下次启动一定加载这份清单。会让宿主起不来的清单不许进清单表，
    // 否则「修好一个插件」会变成「整个 DSH 起不来」（0.3.0 的真实事故）。
    const health = checkPackage(pkgDir);
    if (!health.startable) {
      const first = health.problems.find((p) => p.fatal);
      skipped.push({ name, reason: `清单会让 DSH 起不来：${first?.message ?? "清单不合格"}` });
      continue;
    }
    bundles.push(name);
    seen.add(name);
    added.push(name);
  }

  if (added.length === 0) {
    return { ok: true, changed: false, added, already, skipped, backup: null };
  }

  manifest.dsh = {
    ...(manifest.dsh ?? {}),
    profile: { ...(manifest.dsh?.profile ?? {}), bundles },
  };

  const backup = backupFile(read.file, backupDir, "package.json", now);
  try {
    writeAtomic(read.file, `${JSON.stringify(manifest, void 0, 2)}\n`);
  } catch (e) {
    return { ok: false, error: `写 ${read.file} 失败：${e.message}`, added: [], already, skipped, changed: false };
  }
  return { ok: true, changed: true, added, already, skipped, backup };
}

/**
 * 摘掉早期版本手写的注册块：
 *
 *     # >>> <id>
 *     - id: <id>
 *     ...
 *     # <<< <id>
 *
 * 只在 `dsh.profile.bundles` 已经接管该包时才该调用（见文件头说明）。
 * 函数本身是纯的，不判断该不该摘。
 */
export function stripMarkerBlock(text, id) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const begin = `# >>> ${id}`;
  const end = `# <<< ${id}`;
  if (!text.includes(begin) || !text.includes(end)) return text;
  return text.replace(new RegExp(`\\n?[ \\t]*${esc(begin)}[\\s\\S]*?[ \\t]*${esc(end)}[ \\t]*\\n?`, "g"), "\n");
}

/** 清单里是否还有该包的手写块。 */
export function hasMarkerBlock(text, id) {
  return text.includes(`# >>> ${id}`) && text.includes(`# <<< ${id}`);
}