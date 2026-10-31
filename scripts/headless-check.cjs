const { spawnSync } = require("node:child_process");
const checks = [
  ["scripts/check-l10n.cjs"],
  ["scripts/manifest-check.cjs"],
  ["scripts/grouping-check.cjs"],
  ["scripts/cvs-core-check.cjs"],
  ["scripts/catalog-discovery-check.cjs"],
  ["scripts/git-nesting-check.cjs"],
  ["scripts/git-update-check.cjs"],
  ["scripts/git-security-check.cjs"],
  ["scripts/message-security-check.cjs"],
  ["--test", "scripts/cvs-nesting-check.mjs"],
  ["--test", "scripts/cvs-real-test.mjs"],
  ["scripts/restart-host-check.cjs"],
];
for (const args of checks) {
  process.stdout.write(`\n$ node ${args.join(" ")}\n`);
  const result = spawnSync(process.execPath, args, {stdio:"inherit",env:process.env});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

// 交互回归沿用既有 headless 入口，不启动 GUI。
const ui = spawnSync("pnpm", ["--dir", "webview", "exec", "vitest", "run", "src/commit/commit-ui.test.tsx"], {stdio:"inherit",env:process.env});
if (ui.error) throw ui.error;
if (ui.status !== 0) process.exit(ui.status || 1);
