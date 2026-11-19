/**
 * 组合包清单体检 —— 专治「装完 DSH 直接起不来」。
 *
 * ## 为什么需要单独一个模块
 *
 * 0.2.0 里给 package.json 加了一行 `"client": { "platform": "web" }`，
 * 意图是「让 web profile 认得这个包」。真实语义完全不是这样：
 *
 *   `dsh.client` 声明的是「本包带浏览器端模块」，宿主 `dsh-client-modules`
 *   在组合 client 层时会对每个声明的包执行 resolveMeta()：
 *
 *       const decl = parseDshClient(name, pkg.dsh.client)
 *       if (decl.platform !== "web") return null
 *       const clientRel = clientExportOf(name, pkg.exports)
 *       if (clientRel === undefined)
 *         throw new Error(`${name} declares dsh.client but exports no "./client" bundle`)
 *
 *   而 dsh-app-boot 把这个异常当成「required plugin did not activate」，
 *   直接抛 StartupError —— 整个 DSH 进程退出。表现就是：装完重启，DSH 死了，
 *   日志里只有一行 `ClientPackageCompositionError`。
 *
 * 本插件是纯宿主侧（`llm/stream` 钩子），没有也不需要有 client 产物。
 * 所以正确做法是**不声明 dsh.client**，加载路径只走 `dsh.bundle` +
 * `dsh.profile.bundles`（见 lib/profile.js）。
 *
 * 这个模块把「什么样的清单会让宿主起不来」写成可执行检查，安装器在落盘前后
 * 各跑一次，测试里也拿它当回归闸门 —— 同一类错误不要再犯第二次。
 */
import fs from "node:fs";
import path from "node:path";

/** 宿主认的浏览器端入口子路径。 */
export const CLIENT_EXPORT = "./client";

/**
 * 复刻宿主 `clientExportOf()` 的解析规则（含它的抛错分支）。
 *
 * 一致性地抄而不是「宽松判断」，是因为体检的结论必须和宿主的判定同构：
 * 宿主认为没有入口，体检就必须报错；宿主会抛 malformed，体检也必须先拦住。
 *
 * @returns {{ ok: boolean, rel?: string, reason?: string }}
 */
export function resolveClientExport(exportsField) {
  if (typeof exportsField !== "object" || exportsField === null) {
    return { ok: false, reason: `没有 exports["${CLIENT_EXPORT}"]` };
  }
  const client = exportsField[CLIENT_EXPORT];
  if (client === undefined) return { ok: false, reason: `没有 exports["${CLIENT_EXPORT}"]` };
  if (typeof client === "string") return { ok: true, rel: client };
  if (typeof client === "object" && client !== null) {
    const fallback = client.default;
    if (typeof fallback === "string") return { ok: true, rel: fallback };
  }
  return {
    ok: false,
    reason: `exports["${CLIENT_EXPORT}"] 既不是字符串，也不是带字符串 default 的对象`,
  };
}

const problem = (code, fatal, message, hint) => ({ code, fatal, message, ...(hint ? { hint } : {}) });

/**
 * 体检一个包目录。
 *
 * 两种「不合格」要分开：
 *   - `ok === false`       —— 这份清单做不了本插件想做的事（缺 dsh.bundle 等）
 *   - `startable === false` —— 这份清单会让 DSH 启动失败（client 声明残缺）
 *
 * 后者比前者严重得多：前者是「不生效」，后者是「整个宿主起不来」。
 */
export function checkPackage(dir) {
  const file = path.join(dir, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return {
      ok: false,
      startable: false,
      file,
      version: null,
      clientDeclared: false,
      bundleDeclared: false,
      problems: [problem("manifest-unreadable", true, `读不到或解析不了 ${file}：${e.message}`)],
    };
  }

  const problems = [];
  const dsh = manifest?.dsh && typeof manifest.dsh === "object" ? manifest.dsh : {};

  // ---- 组合包声明：决定「装上了会不会真被加载」 ----
  const patch = dsh?.bundle?.patch;
  let bundleDeclared = false;
  if (typeof patch !== "string" || patch === "") {
    problems.push(
      problem(
        "bundle-patch-missing",
        false,
        "package.json 缺 dsh.bundle.patch：宿主不会把它当作组合包加载（登记进 dsh.profile.bundles 也会被跳过）",
      ),
    );
  } else if (!fs.existsSync(path.join(dir, patch))) {
    problems.push(
      problem("bundle-patch-file-missing", false, `dsh.bundle.patch 指向的 ${patch} 不在包里`, "补回该文件，或改指向真实存在的 patch"),
    );
  } else {
    bundleDeclared = true;
  }

  // ---- 浏览器端声明：决定「装上了 DSH 会不会起不来」 ----
  const client = dsh.client;
  const clientDeclared = client !== undefined;
  if (clientDeclared) {
    if (typeof client !== "object" || client === null) {
      problems.push(
        problem(
          "client-non-object",
          true,
          "dsh.client 必须是对象（宿主：has a non-object dsh.client declaration）",
          "纯宿主插件请不要声明 dsh.client",
        ),
      );
    } else if (typeof client.platform !== "string") {
      problems.push(
        problem(
          "client-platform-missing",
          true,
          "dsh.client.platform 必须是字符串（宿主：dsh.client.platform must be a string）",
          "纯宿主插件请不要声明 dsh.client",
        ),
      );
    } else if (client.platform === "web") {
      // 只有 platform === "web" 会进入宿主的 resolveMeta()，也只有它会抛。
      const exp = resolveClientExport(manifest?.exports);
      if (!exp.ok) {
        problems.push(
          problem(
            "client-export-missing",
            true,
            `声明了 dsh.client.platform="web" 但${exp.reason}。` +
              '宿主会抛 `declares dsh.client but exports no "./client" bundle`，' +
              "并把它算作 required plugin 未激活 → DSH 启动失败",
            "纯宿主插件请删掉 dsh.client；真要带前端产物，就加 exports[\"./client\"] 并给出真实文件",
          ),
        );
      } else if (!fs.existsSync(path.join(dir, exp.rel))) {
        problems.push(
          problem(
            "client-export-file-missing",
            true,
            `exports["${CLIENT_EXPORT}"] 指向的 ${exp.rel} 不在包里`,
            "补回该文件，或删掉 dsh.client 声明",
          ),
        );
      }
    }
  }

  return {
    ok: problems.length === 0,
    startable: problems.every((p) => !p.fatal),
    file,
    version: typeof manifest.version === "string" ? manifest.version : null,
    clientDeclared,
    bundleDeclared,
    problems,
  };
}

/** 只要「会不会让 DSH 起不来」这一个结论。 */
export function startabilityOf(dir) {
  const res = checkPackage(dir);
  return {
    startable: res.startable,
    fatal: res.problems.filter((p) => p.fatal),
    version: res.version,
  };
}

/** 把体检结果压成终端可读的多行文本（可选带缩进）。 */
export function describeProblems(result, indent = "  ") {
  return result.problems
    .map((p) => `${indent}${p.fatal ? "✗" : "·"} [${p.code}] ${p.message}${p.hint ? `\n${indent}  → ${p.hint}` : ""}`)
    .join("\n");
}