# Changelog

本文件记录所有值得写下来的改动。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.6.2] - 2026-11-19

**默认反过来：装本体就顺手装破甲。破甲的源换成 `yu994419160/dsh-purge1.7.3-`。**

0.6.0 把搭档整体移出默认路径，理由是「补搭档会 `pnpm add` 并重写 lockfile」。
但这条理由只在**破甲缺**的时候成立 —— 缺的那次确实该装，装完才有「让模型愿意做」那一半。
所以 0.6.2 用「缺才装」解决同一个风险，而不是用「默认不装」。

### 改

- **`lib/companions.js`：破甲条目换成 `dsh-purge`**，源 `github:yu994419160/dsh-purge1.7.3-`
  （旧的 `dsh-purge-community` / `kingcharleslzy-ai/dsh-purge` 不再出现在搭档表里；
  `armor/` 的角色识别仍然同时认 `dsh-purge-community` 和 `dsh-purge`，老装的照样看得见）。
- **搭档分两档**，新增 `byDefault` 标记与 `DEFAULT_COMPANION_IDS`：
  - 默认档 = 破甲（`install.mjs` 不加任何参数就装）
  - 显式档 = 两个连接器（`--with-companions` / `--all` 才装；Node ≥22.19 且要本机登录）
- `selectCompanions` 增加 `all` 参数：`only` > `all` > 默认档。`planCompanions` 透传。
- **`install.mjs` / `bootstrap.mjs` 的 `WITH_COMPANIONS` 改为默认开**（`--no-companions` 才关）。
  同时搭档失败**一律非零退出**：默认路径里现在包含破甲，静默告警会让用户以为装齐了。
- `--verify`、`armor/` 的提示文案跟着改：破甲缺失时直接给出
  `node install.mjs --only dsh-purge`。

### 测试

- `scripts/companions-test.mjs` 跟着改断言：表里 id 换成 `dsh-purge`、spec 换成新源；
  「默认全选」拆成「默认只选破甲」+「`all: true` 才全选」；计划相关用例显式传 `all: true`；
  端到端三条改成「默认装破甲」「`--with-companions` 才补连接器」「`--no-companions` 全不碰」。

## [0.6.1] - 2026-11-19

**修「照文档验不了，所以判定用不了」。功能一直在跑，回执从来没到过。**

### 修

- **启动回执改走 `console`（`emit()` 双写）**。0.6.0 及以前那两行
  `[gateway-shield] active | …` / `fingerprints | …` 用 `ctx.logger.info()` 发，
  而 cordis 的 `LoggerService` 构造时只挂一个把消息塞进 1000 条内存环形缓冲的
  自带 exporter —— 不写 stdout、不写文件：

  ```js
  self.exporter({ colors: 3, export: (message) => { self.buffer.push(message) } })
  ```

  于是 `~/.dsh/logs` 全量 grep `gateway-shield] active` **零命中**，与此同时插件在
  插件列表里是 `fiberPhase: active`、并且确实在改写出网的 `system`。README「怎么确认
  生效」给出的唯一验收步骤因此**永远不可能通过**，按文档测只能得出「用不了」的结论。
  现在 `emit()` 同时写 `ctx.logger` 与 `console.log`，回执真正落到 `run-*-out.log`
  （`ds-harness-remote` 的 `[ds-harness-remote] …` 走的就是这条通道）。
- 新增配置项 `receipt`（默认 `true`）：需要静音回执的嵌入场景可关掉。
  `verbose` 的逐请求日志同样改走 `emit()`，否则它也一样不可见。

### 顺带

- `cordis.patch.yml` 补 `receipt: true` 与对应注释。

## [0.6.0] - 2026-11-19

**定位收口：这不再是一个「WorkBuddy / Qoder 补丁」，而是 DSH 出网前的通用护栏。**

0.5.0 让代码对所有 provider 生效，但文档、仓库简介、安装器的默认行为还停在「必须搭配
连接器 + dsh-purge」。这一版把这三处一起改掉，让写下来的东西和实际行为对上。

### 改

- **`install.mjs` 默认只装本体**。原来是「装本体 = 装全套」，默认会去 `pnpm add` 那三个搭档；
  现在只有显式加 `--with-companions`（或 `--all` / `--only`）才碰它们。理由是那一步会重写
  `pnpm-lock.yaml`，对已打过宿主补丁的 `github:` 破甲有实打实的干扰风险——这种事不该是默认。
  `--no-companions` 保留为兼容写法，语义等同于默认。
- README 头部、`一句话说清`、`和 dsh-purge、连接器怎么配合` 三节重写：把「必须三个都装」
  改成「本插件单独就能用，另外两个是可选的加成」。「一键装齐三件套」改名为「可选搭档：不装也能跑」。
- `package.json` 的 `description` 与 `keywords` 改为 provider 无关的口径。
- 「兼容性」一节澄清 Node 下限：只有真在用 WorkBuddy / Qoder 时才要 ≥ 22.19，只装本插件 20 即可。
- 「已知边界」里的指纹表述改为分档口径（通用层实测、其余标推断），与 `lib/fingerprints.js` 一致。
- 英 / 日文档标注为停在 0.3.x，以中文为准（避免两份过期翻译继续误导）。

### 测试

- `scripts/companions-test.mjs` 跟着改默认值：新增「默认不碰搭档」「`--with-companions` 才补」
  「`--no-companions` 压过 `--with-companions`」三项，毒清单告警那项改成显式带 `--with-companions`。
  现在 39 项。

### 顺带修

- `install.mjs` 的 `SHIP` 列表补上 `armor/` 与 `bootstrap.mjs`：之前走这条路径装出来的目录里
  没有 `armor/`，`dsh-armor` 这个 bin 是废的。`--verify` 的文件检查也加上了
  `lib/fingerprints.js`、`armor/armor.mjs`、`armor/detect.mjs`。

## [0.5.0] - 2026-11-19

破甲从「WorkBuddy / Qoder 两个网关」扩到**全模型**。钩子层本来就不用改（`llm/stream` 与
provider 无关），挡住全模型的是三个数据层的问题，这一版逐个处理。

### 新增

- `lib/fingerprints.js`：指纹表按 provider 分档。
  - `UNIVERSAL_PHRASES`：原来那 15 条实测表，所有 provider 都洗；
  - `PROVIDER_PHRASES`：单 provider 专属补充（目前只有 `anthropic` 的两条 Claude Code 身份句）；
  - `PROVIDER_RULES`：按**前缀**匹配，不穷举 —— `provider` 是开放集合，用户在设置里能自己加 route；
  - 每档带 `confidence: measured | inferred | universal`，进日志与 `armor --check` 的矩阵。
- 清洗面从 2 个扩到 4 个：`system`、`messages[].content`（含**字符串 content**）、
  `tools[].description`、`toolHistory.tools[] / updates[].additions[]`。
  后两者是 `GenerateOptions` 里真实存在、原来完全没洗的字段。
- `armor/detect.mjs` 增加网关覆盖矩阵：每个 profile 的每个 provider 档位、条数、实测/推断。
- `scripts/provider-coverage-test.mjs`：21 项，锁住「认档 / 洗面 / 边界」三件事。
- 启动日志多一行 `fingerprints | fallback=… surfaces=system,messages,tools,toolHistory`；
  逐请求日志多 `profile=workbuddy(measured, 15 条) … tools=N`。

### 改

- `rewriteText` / `shieldOptions` 接受 `provider`（`config.provider` 优先，其次 `options.provider`）。
  不传时行为与 0.4.0 完全一致 —— 旧调用点和测试不受影响。
- `scansRole` 增加 `model`（部分适配器用它代替 `assistant`）。
- 兼容导出保留：`CHANNEL_GATE_PHRASES` 仍等于通用层，`PARANOID_PHRASES` 移入 `fingerprints.js` 后重导出。

### 为什么不是「多写几个网关的名字」

按名字扩表只会得到一张永远追不上新网关的名单。分成「通用身份句层 + provider 专属层」之后，
新 provider 至少落在通用层里（不会静默跳过），而实测过的网关仍然吃它自己那一档，
两件事互不干扰。

## [0.4.0] - 2026-11-19

新增整合入口 `armor/`：**先体检，再一键装**，且全程不碰包管理器。

### 为什么

上游 `install.mjs` 把搭档写成三行硬编码（`dsh-purge-community` / `dsh-connect-workbuddy` /
`dsh-qoder-connect`），缺的会 `pnpm add`。这在「破甲已经从 git 装好、宿主补丁已应用」的机器上
有两个具体问题：

1. 同一个破甲角色可能换名换源。实测一台机器上 `web` 是 `dsh-purge-community`（kingcharleslzy-ai）、
   `desktop` 是 `dsh-purge`（mmparko）。硬编码 id 在 desktop 里什么都看不到。
2. `pnpm add` 会重写 `pnpm-lock.yaml` 并重新解析那两个 `github:` 依赖 —— 落到另一个 commit，
   就是悄悄换掉用户的破甲版本。

### 新增

- `armor/detect.mjs`：只读体检。按**角色**识别破甲（`dsh-purge-community` / `dsh-purge` /
  任何名字带 `purge` 的依赖），带来源判定（`git` / `registry` / `local`）、登记状态、
  清单启动安全、重复破甲、`tuning.json` 的 `refusalRetry` 冲突、手写注册块残留、
  宿主版本区间与 Node 下限。
- `armor/armor.mjs`：一键入口。顺序固定为「预检 → 落文件 → 复检已落盘的那份 → 登记 →
  摘手写块 → 全量复检」，`--check` / `--json` / `--dry-run` / `--profile` / `--all-profiles` /
  `--force` 可选。不调 `pnpm`、不发网络请求。
- `package.json`：`bin.dsh-armor`，`files` 收录 `armor`，版本 `0.4.0`。
- `install.mjs` 与上游行为保持不变，作为「要顺手补搭档」时的老路径保留。

### 修

- 复检用的 `needsInstall` 曾经读的是 `inspectPackage()` 的返回值，而 `inBundles` 只加在
  返回对象的副本上 —— 结果是装完永远显示「需要装」，复检永远不通过。改用局部变量。
- `--force` 与「已就位跳过」两个列表会同时列出同一个 profile，日志读起来像矛盾。

## [0.3.2] - 2026-11-19

只有元数据与文档，**功能与 0.3.1 完全相同**。这一版是为了让「面板里填名字就能装」
这件事有一个可执行的答案。

### 新增

- `package.json` 补 `repository` / `homepage` / `bugs`：npm 页面能指回仓库，
  `hosted-git-info` 也能把 `github:jyuaner/dsh-gateway-shield` 这类写法正确归位。
- [`docs/PUBLISHING.md`](docs/PUBLISHING.md)：发布到 npm 的完整步骤、发布前后核对表、
  以及三条不该做的事（别打 `node_modules`、别发会让宿主起不来的清单、别让 tag 与版本脱节）。

### 文档

- README 新增「面板里该填什么」：裸包名 / GitHub URL / `github:...#tag` / 本地绝对路径
  四种写法分别走哪条路。**裸包名只查 npm registry**，本包没发布时填名字必然是
  「未找到相关插件」—— 这不是网络问题。
- 说明 git 路线报「无法连接插件源」时，是 DSH 自己的子进程没有代理，需要给启动环境
  `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY`，而不是改本插件。

## [0.3.1] - 2026-11-19

这一版是**事故修复**。0.3.0 装完重启会让 DSH 直接起不来；同时把「装这个」
真正做成一条命令 —— 搭档先检测，缺的才下载。

### 修复

- **`dsh.client` 声明让 DSH 启动失败（严重，0.2.0 引入、0.3.0 仍在）**。
  0.2.0 为了「让 web profile 认得本包」加了 `"client": {"platform": "web"}`。
  这行的真实语义是「本包带浏览器端模块」：宿主 `dsh-client-modules` 会对每个这么声明的
  包去找 `exports["./client"]`，找不到就抛
  `declares dsh.client but exports no "./client" bundle`，`dsh-app-boot` 把它算作
  required plugin 未激活 → `StartupError` → 进程退出。本插件是纯宿主侧，已删除该声明；
  加载路径只剩 `dsh.bundle` + `dsh.profile.bundles`。
- **安装器没有「装完会不会起不来」这一关**。新增 `lib/manifest.js`，按宿主
  `parseDshClient()` / `clientExportOf()` 的真实规则体检清单，并把两种不合格分开：
  「不生效」（缺 `dsh.bundle.patch`）与「起不来」（client 声明残缺）。
  - `install.mjs`：落盘前检查源清单，落盘后按装进去的那份再查一次，不合格就**不登记**。
  - `bootstrap.mjs`：解包后先查，毒清单直接拒装，一个字节都不写。
  - `lib/profile.js`：登记处加同一道闸门 —— 会让宿主起不来的包不进
    `dsh.profile.bundles`。宁可插件不生效，也不让 DSH 死。
- **`--verify` 看不到启动风险**。体检新增「不影响启动」项，并把
  `lib/manifest.js` 纳入文件清单；搭档里清单有毒的单独标红并计入不合格。

### 变更

- **一条命令就是完整安装**：`install.mjs` / `bootstrap.mjs` 默认处理搭档三件套，
  `--no-companions`（别名 `--without-companions`）才是「只要本体」。
  `--with-companions` / `--all` 仍然接受，语义变成「显式要求」。
- **搭档先检测，没有再下载**：`planCompanions()` 新增 `summary`
  （`已装 N 个 → 跳过；缺 M 个 → 下载`）。已在 `node_modules` 且清单健康的直接不进
  包管理器命令，因此不会重复下载；已装但清单有毒的算「没就位」，会被要求重装并告警。
- **默认模式下搭档失败只告警**：插件本体已装好时，用一个可选依赖把结果改写成「安装失败」
  是误导。显式点名（`--with-companions` / `--only`）时仍以非零码退出。

### 测试

- 自测 38 → 47 项：新增 9 项清单启动安全断言，含「本包不得声明 `dsh.client`」这条回归闸门、
  `dsh.client` 三种畸形形态、`platform` 非 `web` 时宿主忽略、以及
  `resolveClientExport()` 与宿主同构。
- 搭档测试 30 → 38 项：新增检测优先（已装/毒清单）、登记拒绝毒清单、
  默认一键装、`--no-companions` 完全不碰、全装好时不发起下载。
- 合计 47 + 13 + 38 = **98 项全通过**（`npm test`）。

## [0.3.0] - 2026-11-19

这一版的主题是**「装完真的会跑」**。上一个版本能装、能识别，但在一台干净的机器上
走命令安装时，DSH 启动后一行日志都不会出现 —— 因为漏了登记那一步。

### 新增

- **一条命令装齐三件套**：`install.mjs` 与 `bootstrap.mjs` 都支持
  `--with-companions`，把 dsh-purge Community、dsh-connect-workbuddy、
  dsh-qoder-connect 一并装上并登记。搭配 `--only` / `--skip` 可选子集，
  `--pm pnpm|npm` 可指定包管理器，`--dry-run` 只打印计划。
- `bootstrap.mjs` 的一行命令支持带参数：把参数写进 `globalThis.__SHIELD_ARGV`
  即可（`node -e` 的 `process.argv` 塞不进脚本参数）。
- `lib/companions.js`：三件套注册表 + 安装计划 + 执行器。计划是纯函数，
  执行器接受注入的 `run`，因此测试不碰网络也不碰真实包管理器。
- `lib/profile.js`：profile 清单读写、`ensureBundles()` 登记、手写块摘除。
- `npm run setup:all`、`npm run test:companions`。

### 修复

- **装了但不加载**（严重）。DSH 只从 `<profile>/package.json` 的
  `dsh.profile.bundles` 读组合包，`dsh.bundle` 声明只是「这个包可以被当作
  bundle」的资格。设置 → 插件面板在装完后会替你把它追加进 bundles
  （`dsh-plugin-manager` 的 `reconcile()`），命令行安装没有这一步。
  结果：`node install.mjs` 报「装好了」，重启后日志里什么都没有，插件管理器
  里也看不到。现在安装流程走「放文件 → 登记 → （登记确认后才）摘手写块」。
- **启动回执默认看不到**。`[gateway-shield] active | …` 那行被 `verbose`
  闸住了，而默认配置 `verbose: false` —— README 让人「重启后看日志应有这一行」，
  实际永远看不到，等于没有回执。现在这行常开，`verbose` 只控制逐请求日志。
- **`verbose` 默认值与文档不一致**。代码里是 `true`，README 的配置表和
  `cordis.patch.yml` 都写 `false`。以文档为准改成 `false`。
- **`--clean` 会摘成孤儿**。早期版本的手写注册块是当时唯一的挂载路径；
  在 bundles 还没收录本包时摘掉它，插件就彻底不会被加载。现在 `--clean`
  先检查登记状态，没有就拒绝并提示先跑 `node install.mjs`。
- **`--verify` 体检项不完整**：补上 `lib/companions.js` / `lib/profile.js`
  文件检查、`dsh.profile.bundles` 登记检查、三件套的安装与登记状态。
- **`--dry-run` 的文案会撒谎**：明明已经登记过，仍打印「将追加」；结尾还写「装好了」。
  现在按实际状态输出，结尾改成「预演完成，没有改动任何文件」。
- **代理提示不生效**：原文让人设 `HTTPS_PROXY`，但 Node 的 `fetch` 只有 24+ 才读
  代理变量。现在提示补上 `NODE_USE_ENV_PROXY=1`，并给出 18–23 的替代路线。

### 测试

- 新增 `scripts/companions-test.mjs`：30 项，覆盖子集选择、未知 id、Node 下限、
  计划形状、一条命令装完、失败回滚线索、幂等、登记顺序、拒绝无 `dsh.bundle`
  的包、手写块摘除不误伤、以及 `install.mjs --dry-run` 真的一个字节都不写。
- 自测新增 3 项日志回执断言：35 → 38 项。
- 合计：38 + 13 + 30 = **81 项全通过**（`npm test`）。

## [0.2.0] - 2026-11-08

### 新增

- 声明 `dsh.bundle.patch`，成为插件管理器（设置 → 插件）能识别、能开关的正式插件。
- 声明 `dsh.client`（`platform: web`），修 web profile 下客户端 bundle 不被加载。
- `bootstrap.mjs` 一行命令安装（下载 tarball，不依赖 git / npm）。
- 英文与日文 README。

### 修复

- **双份注册互挡**：bundle patch 与 profile patch 各注册一次时，两个钩子
  互相以为对方会处理，结果谁都调不到适配器（实测 adapter 收到 0 次）。
  现在带 `SHIELDED` 标记的请求也继续往下走，只是跳过清洗。
- **`next(opts)` 静默丢参**：cordis 的 `next()` 是无参闭包，传进去的改写请求
  被丢弃，所谓「重试」只是把同一份请求原样又发了一遍。改为 `this.stream()`
  重入 waterfall，带加固段重试才真的生效。
- **`messages[0]` 为 system 时加固段丢失**：覆盖三种 options 形状。
- 去掉对 dsh-purge 的硬依赖，`bootstrap` 改为原地覆盖（不 rename，
  Windows 上 rename 被占用目录会 EBUSY）。

## [0.1.0] - 2026-11-08

- 首个可用版本：`llm/stream` 钩子、15 条网关指纹同义改写、软拒绝带加固段重试。
- 靠往 profile 的 `cordis.patch.yml` 手写注册块挂载（0.2.0 起改为 `dsh.bundle`）。

[0.3.2]: https://github.com/jyuaner/dsh-gateway-shield/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/jyuaner/dsh-gateway-shield/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/jyuaner/dsh-gateway-shield/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jyuaner/dsh-gateway-shield/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jyuaner/dsh-gateway-shield/releases/tag/v0.1.0