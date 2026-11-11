const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// packages/tortoise-core 不得 import 或 require vscode。
const vscodeImport = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']vscode["']/;
function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(file);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [file] : [];
  });
}
const coreDir = path.join(__dirname, "..", "packages", "tortoise-core");
const offenders = sourceFiles(coreDir).filter((file) => vscodeImport.test(fs.readFileSync(file, "utf8")));
if (offenders.length) {
  process.stderr.write(`packages/tortoise-core 不得引用 vscode：\n${offenders.map((file) => `  ${path.relative(coreDir, file)}`).join("\n")}\n`);
  process.exit(1);
}
const checks = [
  ["scripts/check-l10n.cjs"],
  ["scripts/manifest-check.cjs"],
  ["scripts/grouping-check.cjs"],
  ["scripts/cvs-core-check.cjs"],
  ["--test", "scripts/cvs-log-check.mjs"],
  ["--test", "scripts/cvs-cache-check.mjs"],
  ["--test", "scripts/cvs-log-session-check.mjs"],
  ["scripts/catalog-discovery-check.cjs"],
  ["scripts/git-nesting-check.cjs"],
  ["scripts/git-update-check.cjs"],
  ["scripts/git-security-check.cjs"],
  ["scripts/message-security-check.cjs"],
  ["--test", "scripts/cvs-nesting-check.mjs"],
  ["--test", "scripts/cvs-real-test.mjs"],
  ["scripts/restart-host-check.cjs"],
  ["scripts/vcs-host-check.cjs"],
  ["--test", "scripts/repository-performance-check.cjs"],
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
