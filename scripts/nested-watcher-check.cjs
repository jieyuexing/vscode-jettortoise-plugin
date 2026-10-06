/*
 * Disposable save-routing checks for the production GitWatcher. The vscode
 * surface is mocked; repository ownership is resolved against real Git roots.
 */
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

function git(cwd, args) {
  return childProcess.execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function createGitRepository(root, email) {
  await fs.mkdir(root, { recursive: true });
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Watcher Check"]);
  git(root, ["config", "user.email", email]);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const projectRoot = path.resolve(__dirname, "..");
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "jettortoise-nested-watcher-"));
  try {
    const parent = path.join(tempRoot, "parent");
    const child = path.join(parent, "child");
    const peer = path.join(tempRoot, "peer");
    await createGitRepository(parent, "parent@example.invalid");
    await fs.writeFile(path.join(parent, "parent.txt"), "parent\n");
    git(parent, ["add", "parent.txt"]);
    git(parent, ["commit", "-m", "parent initial"]);
    await createGitRepository(child, "child@example.invalid");
    await fs.writeFile(path.join(child, "child.txt"), "child\n");
    git(child, ["add", "child.txt"]);
    git(child, ["commit", "-m", "child initial"]);
    await createGitRepository(peer, "peer@example.invalid");
    await fs.writeFile(path.join(peer, "peer.txt"), "peer\n");
    git(peer, ["add", "peer.txt"]);
    git(peer, ["commit", "-m", "peer initial"]);
    const aliasChild = path.join(tempRoot, "child-alias");
    await fs.symlink(child, aliasChild);

    const entry = path.join(tempRoot, "entry.ts");
    const bundle = path.join(tempRoot, "watcher.cjs");
    const vscodeStub = path.join(tempRoot, "vscode-stub.cjs");
    await fs.writeFile(
      vscodeStub,
      `
const listeners = global.__jettortoiseWatcherListeners || (global.__jettortoiseWatcherListeners = []);
class Disposable { constructor(fn) { this.dispose = fn || (() => {}); } }
class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } }
exports.Uri = { file: fsPath => ({ scheme: "file", fsPath }) };
exports.Disposable = Disposable;
exports.RelativePattern = RelativePattern;
exports.workspace = {
  onDidSaveTextDocument(callback) { listeners.push(callback); return new Disposable(() => { const index = listeners.indexOf(callback); if (index >= 0) listeners.splice(index, 1); }); },
  createFileSystemWatcher() { return { onDidChange: () => new Disposable(), onDidCreate: () => new Disposable(), onDidDelete: () => new Disposable(), dispose() {} }; },
};
exports.__emitSave = fsPath => { for (const callback of [...listeners]) callback({ uri: { scheme: "file", fsPath } }); };
`,
    );
    await fs.writeFile(entry, `export { GitWatcher } from ${JSON.stringify(path.join(projectRoot, "src/watchers/gitWatcher.ts"))};\n`);
    await esbuild.build({
      entryPoints: [entry], bundle: true, platform: "node", format: "cjs", outfile: bundle,
      plugins: [{ name: "vscode-stub", setup(build) { build.onResolve({ filter: /^vscode$/ }, () => ({ path: vscodeStub })); } }],
    });
    const { GitWatcher } = require(bundle);
    const vscode = require(vscodeStub);
    const events = { parent: [], child: [], peer: [] };
    const cache = () => ({ invalidate() {} });
    const watcherParent = new GitWatcher(parent, { broadcastEvent: (...args) => events.parent.push(args) }, cache());
    const watcherChild = new GitWatcher(child, { broadcastEvent: (...args) => events.child.push(args) }, cache());
    const watcherPeer = new GitWatcher(peer, { broadcastEvent: (...args) => events.peer.push(args) }, cache());
    const clear = () => { events.parent.length = 0; events.child.length = 0; events.peer.length = 0; };
    const expect = async (file, counts, label) => {
      clear();
      vscode.__emitSave(file);
      await delay(350);
      assert.deepEqual(
        { parent: events.parent.length, child: events.child.length, peer: events.peer.length },
        counts,
        label,
      );
    };

    await expect(path.join(child, "child.txt"), { parent: 0, child: 1, peer: 0 }, "child save only refreshes child by default");
    await expect(path.join(aliasChild, "child.txt"), { parent: 0, child: 1, peer: 0 }, "symlink alias is routed by canonical child root");
    await expect(path.join(parent, "parent.txt"), { parent: 1, child: 0, peer: 0 }, "parent file refreshes parent only");

    const overlapObject = childProcess.execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: parent, input: "overlap\n", encoding: "utf8" }).trim();
    git(parent, ["update-index", "--add", "--cacheinfo", `100644,${overlapObject},child/child.txt`]);
    await expect(path.join(child, "child.txt"), { parent: 1, child: 1, peer: 0 }, "exact parent index overlap refreshes both owners");
    const outside = path.join(tempRoot, "outside.txt");
    await fs.writeFile(outside, "outside\n");
    await expect(outside, { parent: 0, child: 0, peer: 0 }, "outside save has no broadcast");

    watcherParent.dispose();
    watcherChild.dispose();
    watcherPeer.dispose();
    console.log(JSON.stringify({ checks: 5, childOnly: true, canonicalAlias: true, exactIndexOverlap: true, peerQuiet: true, outsideQuiet: true }));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
