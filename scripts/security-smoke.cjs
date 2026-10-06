/*
 * Isolated security smoke test for GitService.
 *
 * This compiles the repository's actual GitService into a temporary directory,
 * then uses a disposable local Git repository and local bare remote only. It
 * never reads a user workspace or contacts a network remote.
 */
const childProcess = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

function git(cwd, args) {
  return childProcess.execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function main() {
  const projectRoot = path.resolve(__dirname, "..");
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "jetgit-security-"));
  try {
  const entry = path.join(tempRoot, "entry.ts");
  const bundle = path.join(tempRoot, "git-service.cjs");
  const vscodeStub = path.join(tempRoot, "vscode-stub.cjs");
  await fs.writeFile(
    vscodeStub,
    "exports.l10n = { t: (message) => message };\n",
  );
  await fs.writeFile(
    entry,
    `export { GitService } from ${JSON.stringify(
      path.join(projectRoot, "src/git/gitService.ts"),
    )};\n`,
  );
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    plugins: [
      {
        name: "vscode-test-stub",
        setup(build) {
          build.onResolve({ filter: /^vscode$/ }, () => ({ path: vscodeStub }));
        },
      },
    ],
  });
  const { GitService } = require(bundle);

  const remote = path.join(tempRoot, "remote.git");
  const workspace = path.join(tempRoot, "workspace");
  await fs.mkdir(workspace);
  git(tempRoot, ["init", "--bare", remote]);
  git(workspace, ["init", "-b", "main"]);
  git(workspace, ["config", "user.name", "JetGit Security Smoke"]);
  git(workspace, ["config", "user.email", "security-smoke@example.invalid"]);
  await fs.writeFile(path.join(workspace, "tracked.txt"), "base\n");
  git(workspace, ["add", "tracked.txt"]);
  git(workspace, ["commit", "-m", "initial"]);
  git(workspace, ["remote", "add", "origin", remote]);
  git(workspace, ["push", "-u", "origin", "main"]);

  const service = new GitService(workspace);
  await service.fetch("origin");
  await service.pull("main");
  await service.push("main", false, "origin", "smoke-pushed");
  const remoteRef = git(remote, ["rev-parse", "refs/heads/smoke-pushed"]).trim();

  const outsideWrite = path.join(tempRoot, "outside-write.txt");
  await fs.writeFile(outsideWrite, "before\n");
  await service.saveMergedContent("../outside-write.txt", "written-by-git-service\n");

  const outsideDelete = path.join(tempRoot, "outside-delete.txt");
  await fs.writeFile(outsideDelete, "delete-me\n");
  await service.rollbackFile("../outside-delete.txt");

  console.log(
    JSON.stringify({
      localRemoteOnly: remote,
      fetchPullPush: Boolean(remoteRef),
      outsideWrite: (await fs.readFile(outsideWrite, "utf8")).trim(),
      outsideDeleteExists: await fs
        .access(outsideDelete)
        .then(() => true)
        .catch(() => false),
    }),
  );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
