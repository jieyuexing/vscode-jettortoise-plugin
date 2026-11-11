# tortoise-core

CVS 与仓库边界的纯 Node 内核，不依赖 VS Code。

## 入口

| 导入 | 文件 | 内容 |
| --- | --- | --- |
| `tortoise-core/cvs` | `cvs-client/core.mjs` | CVS 命令适配、队列、签出、忽略规则 |
| `tortoise-core/cvs/log` | `cvs-client/log.mjs` | 仓库日志解析与按提交分组 |
| `tortoise-core/cvs/log-session` | `cvs-client/log-session.mjs`（类型 `log-session.d.mts`） | 仓库日志取数编排：范围覆盖、新鲜期、增量与合并；时间、取数与缓存由调用方注入 |
| `tortoise-core/cvs/cache` | `cvs-client/cache.mjs` | 日志落盘缓存 |
| `tortoise-core/boundaries` | `repositories/boundaries.cjs` | 仓库边界、Entries 读取、写路径校验 |
| `tortoise-core/network` | `repositories/network.cjs` | 网络命令全局并发闸 |

## 使用方

- JetTortoise（本仓）：根 `package.json` 用 `"tortoise-core": "workspace:*"`，esbuild 打进 `dist/extension.js`。
- T3 插件（`t3-tortoise-plugin`）：用 git 子目录依赖，`<sha>` 取本仓提交：

  ```
  git+ssh://git@github.com/jieyuexing/vscode-jettortoise-plugin.git#<sha>&path:/packages/tortoise-core
  ```

## 规则

不得 import vscode，不得依赖使用方的代码。`pnpm run test:headless` 开头会扫描本目录并拒绝 vscode 的 import 或 require。
