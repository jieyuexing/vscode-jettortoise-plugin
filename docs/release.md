# 打包与上架

入口：`pnpm run vsce:package` 打包，`pnpm run vsce:publish` 上传到 Visual Studio Marketplace。只有维护者或获得用户明确发布授权的协调者可以运行 `vsce:publish`；打包、检查通过不授予发布权限。

## 身份与版本

- publisher `jieyuexing`，扩展名 `jettortoise`，扩展 ID `jieyuexing.jettortoise`。
- 版本只在 `package.json`；VSIX 为 `release/jettortoise-<version>.vsix`，由 `scripts/package-vsix.cjs` 按 manifest 版本命名。`release/` 不进 Git。
- Marketplace 不接受重复版本号，也不能覆盖已上传的版本；每次上传都要递增版本并补 `CHANGELOG.md`。
- 上架页面读取 `README.md`、`CHANGELOG.md`、`LICENSE` 和 `images/icon.png`；README 里的相对图片链接由 vsce 改写为 GitHub raw 地址，因此截图不进 VSIX，推送到 `main` 后才会显示。

## 一次性准备（用户本人完成）

1. 在 [Marketplace 管理页](https://marketplace.visualstudio.com/manage) 创建 publisher，ID 必须是 `jieyuexing`（与 `package.json` 的 `publisher` 一致；2026-10-15 已创建）。若换 ID，同步改 `package.json`、两份 README、`docs/migration.md`、`CHANGELOG.md` 和本文。
2. 选一条发布路线：A（Entra，需先有租户）、B（全球 PAT，2026-12-01 前）、C（网页手动上传，无需令牌）。`scripts/publish-vsix.cjs` 只服务 A/B：`az account show` 成功时走 Entra，否则走 PAT；也可用 `pnpm run vsce:publish -- --entra` / `-- --pat` 强制指定。

### 路线 A：Microsoft Entra ID（长期）

Azure DevOps 的全球 PAT 于 2026-12-01 停用，官方推荐改用 Entra 认证。本仓固定的 vsce 3.7.1 的 `--azure-credential` 取令牌顺序为：`AZURE_*` 环境变量 → Azure CLI（`az login`）→ 托管身份 → Azure PowerShell → Azure Developer CLI，向 Azure DevOps 资源申请令牌，再由 Marketplace 按 publisher 成员身份放行。本机步骤：

```sh
brew install azure-cli
az login            # 用创建 publisher 的同一个 Microsoft 账号登录
pnpm run vsce:publish
```

2026-10-15 实测：publisher 所属账号 `jieyuexing@outlook.com` 是个人 Microsoft 账号，不属于任何 Entra 租户。`az login --use-device-code --allow-no-subscriptions` 浏览器登录成功但返回空列表，`az account get-access-token` 因此无法执行；Azure DevOps 也不接受个人账号经 `/consumers` 取得的令牌。所以本路线目前走不通，前提是先有一个 Entra 租户：

1. 用该账号在 [Microsoft Entra 管理中心](https://entra.microsoft.com/) 创建租户（或注册 Azure 账号时自动得到 Default Directory），记下租户 ID。
2. 在 [Marketplace 管理页](https://marketplace.visualstudio.com/manage) 的 publisher **Members** 里加入该租户内的身份（可以就是本人在租户里的成员账号）。
3. `az login --tenant <租户ID> --allow-no-subscriptions`，再 `pnpm run vsce:publish -- --entra`。

完成前先用路线 B。

### 路线 B：全球 PAT（只能用到 2026-12-01）

在 [Azure DevOps](https://dev.azure.com/) 的 **User settings → Personal access tokens** 新建 PAT：Organization 选 **All accessible organizations**，Scopes 选 **Marketplace → Manage**。VS Code 官方 FAQ 说明只选单个组织（组织范围 PAT）会在发布时得到 401/403，因此 Azure DevOps 通知里「迁移到组织范围 PAT」不适用于 Marketplace 发布，只能迁到路线 A。

把 PAT 写进登录钥匙串（命令省略 `-w` 的值，由 macOS 提示输入，不进 shell 历史）：

```sh
security add-generic-password -a jettortoise -s vscode-marketplace-token -w
```

脚本只把它注入 `vsce publish` 子进程的环境变量 `VSCE_PAT`。也可以临时 `VSCE_PAT=… pnpm run vsce:publish -- --pat`，但不要把 token 写进仓库、日志或任务书。

GitHub Actions 的 trusted publishing（`vsce publish --oidc`）只在 CI 里可用；本仓没有 CI，不采用。

### 路线 C：网页手动上传（不需要任何令牌）

在 [Marketplace 管理页](https://marketplace.visualstudio.com/manage/publishers/jieyuexing) 用 Microsoft 账号登录，对扩展选 **Update**，上传 `release/jettortoise-<version>.vsix`。只需账号登录，不受 PAT 退役影响；发布频率低时这是最省事的做法。上传后仍按「每次发布」的第 3、4 步打 tag、发 GitHub Release 并核对。

## 发布记录

- 2026-10-15 `0.5.0`：首次上架，用户经路线 C 网页上传；Marketplace 校验通过（`validated, public`）。GitHub Release `v0.5.0` 挂同一个 VSIX，市场包、GitHub 资产与本地构建 SHA-256 一致：`0be67fdd9f1e390f67a063c1d2e83c818faccb1ac274da6a2b41c25c6d63cd23`。

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

参考：[Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)、[Azure DevOps PAT 文档（全球 PAT 退役）](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops)、[Marketplace publisher 管理](https://marketplace.visualstudio.com/manage)。
