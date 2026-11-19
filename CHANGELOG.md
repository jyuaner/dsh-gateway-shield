# Changelog

本文件记录所有值得写下来的改动。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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

[0.3.0]: https://github.com/jyuaner/dsh-gateway-shield/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jyuaner/dsh-gateway-shield/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jyuaner/dsh-gateway-shield/releases/tag/v0.1.0