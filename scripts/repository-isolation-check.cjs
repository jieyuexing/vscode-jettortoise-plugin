/*
 * Headless multi-repository isolation checks. Bundles the production registry
 * and content provider against a narrow vscode mock, then uses only temporary
 * Git roots and a CVS metadata fixture.
 */
const childProcess = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

function git(cwd, args) {
  return childProcess.execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function rejects(action, label) {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

async function createGitRoot(root, content) {
  await fs.mkdir(root, { recursive: true });
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Repository Isolation"]);
  git(root, ["config", "user.email", "repository-isolation@example.invalid"]);
  await fs.writeFile(path.join(root, "tracked.txt"), content);
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-m", "initial"]);
}

async function main() {
  const projectRoot = path.resolve(__dirname, "..");
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "jettortoise-repository-isolation-"));
  try {
    const gitA = path.join(tempRoot, "git-a");
    const gitB = path.join(tempRoot, "git-b");
    const cvs = path.join(tempRoot, "cvs-copy");
    await createGitRoot(gitA, "alpha\n");
    await createGitRoot(gitB, "bravo\n");
    const realGitA = await fs.realpath(gitA);
    const realGitB = await fs.realpath(gitB);
    await fs.mkdir(path.join(cvs, "CVS"), { recursive: true });
    await fs.writeFile(path.join(cvs, "CVS", "Root"), ":local:/fixture\n");
    await fs.writeFile(path.join(cvs, "CVS", "Repository"), "demo\n");
    await fs.writeFile(path.join(cvs, "CVS", "Entries"), "\n");
    const alias = path.join(tempRoot, "git-a-alias");
    await fs.symlink(gitA, alias);

    const entry = path.join(tempRoot, "entry.ts");
    const bundle = path.join(tempRoot, "repository.cjs");
    const vscodeStub = path.join(tempRoot, "vscode-stub.cjs");
    await fs.writeFile(vscodeStub, `
class EventEmitter { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} }
class Disposable { constructor(fn) { this.dispose = fn || (() => {}); } }
class Uri {
  constructor(value) { Object.assign(this, value); this.fsPath = value.fsPath || value.path || ""; }
  static from(value) { return new Uri(value); }
  static file(fsPath) { return new Uri({ scheme: "file", fsPath, path: fsPath, authority: "", query: "" }); }
  toString() { return this.scheme + "://" + (this.authority || "") + (this.path || "") + (this.query ? "?" + this.query : ""); }
}
const state = global.__jettortoiseVscodeMock || (global.__jettortoiseVscodeMock = { workspace: { isTrusted: true, workspaceFolders: [] } });
const workspace = state.workspace;
exports.workspace = workspace;
exports.window = { showInformationMessage() {}, showQuickPick: async () => undefined };
exports.l10n = { t: (message) => message };
exports.FileSystemError = { NoPermissions: () => new Error("NoPermissions"), FileNotFound: () => new Error("FileNotFound") };
exports.EventEmitter = EventEmitter; exports.Disposable = Disposable; exports.Uri = Uri;
exports.FileType = { File: 1 };
`);
    await fs.writeFile(
      entry,
      `export * from ${JSON.stringify(path.join(projectRoot, "src/repositories/registry.ts"))};\nexport * from ${JSON.stringify(path.join(projectRoot, "src/views/gitContentProvider.ts"))};\nexport { GitService } from ${JSON.stringify(path.join(projectRoot, "src/git/gitService.ts"))};\n`,
    );
    await esbuild.build({
      entryPoints: [entry], bundle: true, platform: "node", format: "cjs", outfile: bundle,
      plugins: [{ name: "vscode-stub", setup(build) { build.onResolve({ filter: /^vscode$/ }, () => ({ path: vscodeStub })); } }],
    });
    global.__jettortoiseVscodeMock = { workspace: { isTrusted: true, workspaceFolders: [] } };
    const api = require(bundle);
    const vscode = require(vscodeStub);
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(tempRoot) }];

    const fromNestedFile = await api.discoverRepositories(path.join(gitA, "tracked.txt"));
    const fromAlias = await api.discoverRepositories(path.join(alias, "tracked.txt"));
    const a = fromNestedFile.find((repository) => repository.kind === "git");
    const aliasA = fromAlias.find((repository) => repository.kind === "git");
    if (!a || !aliasA || a.root !== realGitA || a.id !== aliasA.id) {
      throw new Error("Nested file discovery or canonical alias identity failed");
    }
    if ((await api.discoverRepositories(cvs)).find((repository) => repository.kind === "cvs")?.root !== await fs.realpath(cvs)) {
      throw new Error("CVS metadata fixture was not discovered");
    }
    const falseRoot = path.join(tempRoot, "false-root");
    await fs.mkdir(path.join(falseRoot, ".git"), { recursive: true });
    await rejects(
      () => api.discoverRepositories(falseRoot),
      "false Git metadata boundary",
    );

    let created = 0;
    const disposed = [];
    const registry = new api.RepositoryRegistry((repository) => {
      created++;
      return {
        open() {}, restore() {}, refresh() {}, async provideContent() { return repository.id; },
        dispose() { disposed.push(repository.id); },
      };
    });
    vscode.workspace.workspaceFolders = [
      { uri: vscode.Uri.file(gitA) },
      { uri: vscode.Uri.file(gitB) },
      { uri: vscode.Uri.file(cvs) },
    ];
    const directA = await api.discoverRepositories(gitA);
    if (!directA.some((repository) => repository.kind === "git" && repository.root === realGitA)) {
      throw new Error(`Direct Git root discovery failed: ${JSON.stringify(directA)}`);
    }
    const directB = await api.discoverRepositories(gitB);
    const directCvs = await api.discoverRepositories(cvs);
    if ((await registry.discover()).length !== 0)
      throw new Error("Unregistered repositories were exposed by discover()");
    await registry.register(directA[0]);
    await registry.register(directB[0]);
    await registry.register(directCvs[0]);
    await registry.ensureAvailable(directA[0]);
    const repositories = await registry.discover();
    const repoA = repositories.find((repository) => repository.kind === "git" && repository.root === realGitA);
    const repoB = repositories.find((repository) => repository.kind === "git" && repository.root === realGitB);
    if (!repoA || !repoB) throw new Error(`Both Git roots were not independently discovered: ${JSON.stringify(repositories)}`);
    const sessionA1 = await registry.session(repoA);
    const sessionA2 = await registry.session(repoA);
    const sessionB = await registry.session(repoB);
    if (sessionA1 !== sessionA2 || sessionA1 === sessionB || created !== 2) {
      throw new Error("Repository sessions are not singleton-per-root and isolated-per-repository");
    }
    await rejects(() => registry.resolveUri(vscode.Uri.from({ scheme: "jettortoise", authority: "not-a-repository", path: "/tracked.txt", query: "ref=HEAD" })), "forged repository authority");

    const providerA = new api.GitContentProvider(new api.GitService(repoA.root), repoA.id, async () => registry.ensureAvailable(repoA));
    const ownContent = await providerA.provideTextDocumentContent(api.gitRevisionUri(repoA.id, "tracked.txt", "HEAD"));
    if (ownContent !== "alpha\n") throw new Error("Correct repository diff did not resolve its own file");
    await rejects(() => providerA.provideTextDocumentContent(api.gitRevisionUri(repoB.id, "tracked.txt", "HEAD")), "cross-repository diff authority");
    const crossPath = await providerA.provideTextDocumentContent(api.gitRevisionUri(repoA.id, "../git-b/tracked.txt", "HEAD"));
    if (crossPath !== "") throw new Error("Cross-repository path was readable through a valid authority");

    const legacyRegistry = new api.RepositoryRegistry(repository => ({open(){},restore(){},refresh(){},async provideContent(){return repository.id;},dispose(){}}), { saved: [{kind:'git',root:repoA.root}], save(){} });
    if ((await legacyRegistry.discover()).length !== 0)
      throw new Error("Legacy candidates were auto-registered");
    await rejects(() => legacyRegistry.resolveUri(api.gitRevisionUri(repoA.id,'tracked.txt','HEAD')), "legacy diff context");
    legacyRegistry.dispose();
    const restoredRegistry = new api.RepositoryRegistry(repository => ({open(){},restore(){},refresh(){},async provideContent(){return repository.id;},dispose(){}}), { saved: [{kind:'git',root:repoA.root}], registered: {version:1,repositories:[{kind:'git',root:repoA.root}]}, save(){} });
    const restoredSession = await restoredRegistry.resolveUri(api.gitRevisionUri(repoA.id,'tracked.txt','HEAD'));
    if (await restoredSession.provideContent() !== repoA.id) throw new Error('Saved diff context did not restore');
    restoredRegistry.dispose();
    vscode.workspace.isTrusted = false;
    await rejects(() => registry.candidates(), "untrusted workspace");
    vscode.workspace.isTrusted = true;
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(gitB) }];
    await rejects(() => registry.ensureAvailable(repoA), "removed or out-of-workspace repository");
    if (disposed.length !== 0) throw new Error("Availability check unexpectedly disposed an active session");
    vscode.workspace.workspaceFolders = [{ uri: { scheme: "vscode-vfs", fsPath: gitA } }];
    await rejects(() => registry.ensureAvailable(repoA), "virtual workspace");
    registry.dispose();

    console.log(JSON.stringify({
      checks: 14,
      canonicalRepositoryId: repoA.id,
      isolatedRepositoryId: repoB.id,
      rootFileHistoryRouting: repoA.root,
      cvsDiscovery: true,
    }));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
