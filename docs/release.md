# 打包与发布

适用于现行分支 `restart`。发布对外可见：GitHub Release 或 Marketplace 上传都要有用户授权（任务书写明），打包和检查通过不等于可以发布。

## 身份与版本

- publisher `jieyuexing`，扩展名 `jettortoise`，扩展 ID `jieyuexing.jettortoise`。
- 版本只在 `package.json`，同时补 `CHANGELOG.md`。`pnpm run vsce:package` 产出 `release/jettortoise-<version>.vsix`（vsce 按 manifest 的 name 与 version 命名），`release/` 不进 Git。
- 提交与标签用仓内 Git 身份（`jieyuexing@outlook.com`）。

## 现行：GitHub 预发布（ETECH 随包固定版本）

0.6 系列只发 GitHub 预发布，供 ETECH Theia 产品仓 `package.json` 的 `theiaPlugins` 固定下载地址，不上架 Marketplace。在干净的 `restart` 上：

```sh
export TMPDIR="<总仓>/.local/tmp/<任务>"; export TMP="$TMPDIR" TEMP="$TMPDIR"
pnpm install --frozen-lockfile && (cd webview && pnpm install --frozen-lockfile)
pnpm run check-types && pnpm run lint && pnpm run test:headless
mkdir -p release        # 没有该目录时 vsce 会把包写成名为 release 的文件
pnpm run vsce:package
```

macOS 上 `TMPDIR` 要用真实路径（不经 `/var` 这类软链），否则部分路径比较检查会误报。`test:headless` 里的 `cvs-real-test.mjs` 需要本机 `cvs`；没有时如实记录未执行，不改脚本绕过。然后：

1. 提交版本号与 CHANGELOG，推送 `restart`。
2. `git tag v<version> && git push origin v<version>`。
3. `gh release create v<version> release/jettortoise-<version>.vsix --verify-tag --prerelease --title v<version> --notes <CHANGELOG 该版本段>`。
4. 匿名下载 Release 资产，核对 SHA-256 与本地 VSIX 一致，再改产品仓的固定地址。

## Marketplace

只有 `0.5.0` 从 `main` 上架过（2026-10-15，网页手动上传）。`restart` 版本要上架时，在 [Marketplace 管理页](https://marketplace.visualstudio.com/manage/publishers/jieyuexing) 对扩展选 **Update**，上传同一个 `release/jettortoise-<version>.vsix`；Marketplace 不接受重复版本号。`restart` 的 `vsce:publish` 直接调用 `vsce publish`，需要 `VSCE_PAT`；全球 PAT 2026-12-01 停用，Entra 与 PAT 两条命令行路线的实测记录见 `git show main:docs/release.md`（其中的 `scripts/package-vsix.cjs`、`scripts/publish-vsix.cjs` 只在 `main`）。

## 发布记录

- 2026-10-15 `0.5.0`：Marketplace 首次上架（`main`），GitHub Release `v0.5.0` 同一 VSIX，SHA-256 `0be67fdd9f1e390f67a063c1d2e83c818faccb1ac274da6a2b41c25c6d63cd23`。
- 2026-10-30 起 `0.6.x`：`restart` 的 GitHub 预发布，各版本资产见 Releases 页。
- 2026-11-05 提交身份改写：11-04 的 4 个提交误用公司身份，按用户决定改为仓内身份并强推 `restart`，v0.6.10～v0.6.19 重打到改写后的对应提交（tree 不变，Release 与资产不变）。改写前的哈希与前态在总仓 `.state/records/vscode-jettortoise-plugin/recovery/r2c01-rewrite-20261105/`（仅 M3）。
