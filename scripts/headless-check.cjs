const { spawnSync } = require("node:child_process");
const checks = [
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
