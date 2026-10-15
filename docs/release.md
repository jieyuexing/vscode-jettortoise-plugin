# 打包与上架

入口：`pnpm run vsce:package` 打包，`pnpm run vsce:publish` 上传到 Visual Studio Marketplace。只有维护者或获得用户明确发布授权的协调者可以运行 `vsce:publish`；打包、检查通过不授予发布权限。

## 身份与版本

- publisher `jieyuexing`，扩展名 `jettortoise`，扩展 ID `jieyuexing.jettortoise`。
- 版本只在 `package.json`；VSIX 为 `release/jettortoise-<version>.vsix`，由 `scripts/package-vsix.cjs` 按 manifest 版本命名。`release/` 不进 Git。
- Marketplace 不接受重复版本号，也不能覆盖已上传的版本；每次上传都要递增版本并补 `CHANGELOG.md`。
- 上架页面读取 `README.md`、`CHANGELOG.md`、`LICENSE` 和 `images/icon.png`；README 里的相对图片链接由 vsce 改写为 GitHub raw 地址，因此截图不进 VSIX，推送到 `main` 后才会显示。

## 一次性准备（用户本人在网页完成）

1. 用 Microsoft 账号登录 [Azure DevOps](https://dev.azure.com/)，建立一个组织（任意名称）。
2. 在该组织的 **User settings → Personal access tokens** 新建 PAT：Organization 选 **All accessible organizations**，Scopes 选 **Marketplace → Manage**，有效期按需。token 只显示一次。
3. 在 [Marketplace 管理页](https://marketplace.visualstudio.com/manage) 用同一账号创建 publisher，ID 必须是 `jieyuexing`（与 `package.json` 的 `publisher` 一致）。若此 ID 已被占用而改用别的名字，同步改 `package.json`、两份 README、`docs/migration.md`、`CHANGELOG.md` 里的扩展 ID。
4. 把 PAT 写进登录钥匙串（命令省略 `-w` 的值，由 macOS 提示输入，不进 shell 历史）：

   ```sh
   security add-generic-password -a jettortoise -s vscode-marketplace-token -w
   ```

   `scripts/publish-vsix.cjs` 从这里读取，只注入 `vsce publish` 子进程的环境变量 `VSCE_PAT`。也可以临时用 `VSCE_PAT=… pnpm run vsce:publish`，但不要把 token 写进仓库、日志或任务书。

## 每次发布

在本仓根、干净的 `main` 上执行：

```sh
export TMPDIR="<总仓>/.local/tmp/<任务>"; export TMP="$TMPDIR" TEMP="$TMPDIR"
pnpm install --frozen-lockfile && (cd webview && pnpm install --frozen-lockfile)
pnpm run check:l10n
pnpm run test:headless
pnpm run vsce:package
npx vsce ls --no-dependencies        # 核对包内只有 dist/、nls/l10n、icon、README、CHANGELOG、LICENSE
code --install-extension release/jettortoise-<version>.vsix   # 本机试用
```

`test:headless` 里的 `cvs-real-test.mjs` 需要本机 `cvs` 客户端；没有时如实记录为未执行，不改脚本绕过。本机试用后，按顺序：

1. 提交版本号与 CHANGELOG，推送 `main`。
2. `pnpm run vsce:publish`：上传 `release/jettortoise-<version>.vsix`，不重新打包。失败不自动重试，先到管理页核对该版本是否已出现，再决定是否重跑；版本已存在时只能递增版本重来。
3. `git tag v<version> && git push origin v<version>`，然后 `gh release create v<version> release/jettortoise-<version>.vsix --verify-tag --notes-from-tag`（或用 CHANGELOG 段落作说明），让 VSIX 渠道与 Marketplace 同版本。
4. 核对：`npx vsce show jieyuexing.jettortoise` 显示新版本；市场页图标、README 图片、CHANGELOG 正常。首次上架后 Marketplace 还会做自动校验，页面可能延后几分钟可见。

## 首次上架前的检查

- `package.json` 的 `publisher` 与管理页创建的 publisher ID 一致。
- 名称、图标与描述不冒用 JetBrains、TortoiseGit 商标；README 保留与它们无隶属关系的声明和上游致谢。
- `LICENSE` 保留上游两行版权。
- README 截图已推送到 GitHub `main`，否则市场页图片为空。

参考：[Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)、[Marketplace publisher 管理](https://marketplace.visualstudio.com/manage)。
