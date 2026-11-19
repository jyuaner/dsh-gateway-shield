# 发布到 npm

## 为什么需要这一步

DSH 面板的「设置 → 插件 → 添加插件」里，**裸包名只查 npm registry**。
没发布过的名字，填进去就是「未找到相关插件」——那不是网络问题，也不是插件坏了，
是那个输入框按名字找不到任何东西可查。

面板同时接受 GitHub 地址与本地绝对路径（见 README 的「面板里该填什么」），
所以发布不是必须的。想要「填名字就能装」，才需要走这一页。

## 一次性准备

```powershell
npm login                     # 需要 npm 账号
npm view dsh-gateway-shield version   # E404 = 名字还没被占，可以发布
```

本机 `.npmrc` 目前只有镜像源（`registry=https://registry.npmmirror.com`），没有 token。
注意镜像源只影响**读**；`npm publish` 默认发到 `https://registry.npmjs.org`，
除非显式加 `--registry`。两个源不一致时，发布成功但别人从镜像搜不到，需要等镜像同步。

## 发布流程

```powershell
# 1. 全绿再发
npm test

# 2. 版本与记录
#    package.json 的 version、CHANGELOG.md 里对应段落，两处必须一致
#    语义化版本：只有文档/元数据改动走 patch，行为改动走 minor

# 3. 提交并打 tag（tag 与 npm 版本同号，release 记录才对得上）
git add -A
git commit -m "chore(0.3.2): 版本与更新记录"
git tag -a v0.3.2 -F tagmsg.txt
git push origin main
git push origin v0.3.2

# 4. 先预演，看清单对不对
npm publish --dry-run

# 5. 真发
npm publish
```

## 发布前后核对

| 检查 | 期望 |
| --- | --- |
| `npm publish --dry-run` 的 Tarball Contents | 只有白名单里的文件：`lib/`、`scripts/`、`cordis.patch.yml`、`install.mjs`、`bootstrap.mjs`、三份 README/CHANGELOG/LICENSE |
| `npm view dsh-gateway-shield version` | 返回刚发布的版本号 |
| `npm view dsh-gateway-shield repository.url` | 指回 GitHub 仓库（`package.json` 的 `repository` 已在 0.3.2 补齐） |
| DSH 面板填裸包名 | 能查到条目并进入安装确认 |
| 装完重启 | 日志出现 `[gateway-shield] active | …` |

## 不要做的事

- **别把 `node_modules` 打进包里**：`files` 白名单已经限定，别为了省事改成 `"*"`。
- **别发带 `dsh.client` 却没有 `exports["./client"]` 的清单**：宿主会在启动时抛
  `ClientPackageCompositionError`，整个 DSH 起不来。发布前跑 `node install.mjs --dry-run`，
  预检这一项会拦住（0.3.1 的事故就出在这里）。
- **别让 tag 与 npm 版本脱节**：`v0.3.1` 的 tag 与 npm 上的 `0.3.1` 必须是同一份代码，
  否则「更新记录」会说谎。