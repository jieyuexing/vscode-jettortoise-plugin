import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import {
  assertNoNestedRepositories,
  assertOwnedPath as assertRepositoryOwnedPath,
  boundariesForPaths,
  NestedRepositoryError,
} from "../repositories/boundaries.cjs";
import { GitCache } from "./cache";
import { computeGraphLayout } from "./graphLayout";
import {
  resolveShelfEntry,
  resolveWorktreePath,
  safeGitContentRef,
  safeGitRef,
  safeGitRevision,
  safeObjectId,
  safeRelativePath,
  safeRemoteName,
} from "./security";
import type {
  BranchInfo,
  CherryPickState,
  CommitNode,
  DiffFile,
  FileStatus,
  GraphLayoutResult,
  IdeaShelfEntry,
  LaneSnapshot,
  LogOptions,
  MergeState,
  RefInfo,
  TagInfo,
} from "./types";

const execFileAsync = promisify(execFile);

// For parsing git output (actual null byte)
const FIELD_SEP = "\x00";
const RECORD_SEP = "\x00\x00\x01";
// For git log --format (pretty-format): %x00 produces null byte
const FMT_FIELD_SEP = "%x00";
const FMT_RECORD_SEP = "%x00%x00%x01";
// For git branch/tag --format (ref-format / for-each-ref): %00 produces null byte
const REF_FMT_FIELD_SEP = "%00";
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB

/** A bounded object read used by the read-only comparison workbench. */
export class GitContentTooLargeError extends Error {
  readonly code = "GIT_CONTENT_TOO_LARGE";
  constructor() {
    super("Git content exceeds the comparison preview limit");
  }
}

const LOG_FORMAT = [
  "%H", // hash
  "%h", // shortHash
  "%P", // parents (space separated)
  "%aN", // authorName (mailmap resolved)
  "%aE", // authorEmail (mailmap resolved)
  "%aI", // authorDate ISO 8601
  "%s", // subject
  "%b", // body
  "%D", // refs
].join(FMT_FIELD_SEP);

export class GitService {
  readonly cache = new GitCache();
  private nestedBoundaries: Array<{ kind: "git" | "cvs"; root: string }> = [];

  constructor(
    private readonly cwd: string,
    private readonly ensureAvailable?: () => Promise<void>,
  ) {}

  private async checkedPath(
    filePath: string,
    allowMissing = true,
  ): Promise<string> {
    const safePath = safeRelativePath(filePath);
    await resolveWorktreePath(this.cwd, safePath, { allowMissing });
    await assertRepositoryOwnedPath(this.cwd, "git", safePath);
    return safePath;
  }

  private async checkedPaths(filePaths: string[]): Promise<string[]> {
    return Promise.all(filePaths.map((filePath) => this.checkedPath(filePath)));
  }

  /** Reject a mutating operation that could cross an unregistered child root. */
  private async assertWholeWorktreeOwned(): Promise<void> {
    await assertNoNestedRepositories(this.cwd, "git");
  }

  /** Commit and index-wide operations must also reject entries staged outside this repository. */
  private async assertStagedPathsOwned(): Promise<void> {
    const output = await this.execGit(["ls-files", "--cached", "-z"]);
    const paths = output.split("\0").filter(Boolean);
    if (paths.length === 0) return;
    const boundaries = await boundariesForPaths(this.cwd, "git", paths);
    if (boundaries.length > 0) {
      throw new NestedRepositoryError(boundaries);
    }
    await Promise.all(paths.map((filePath) => this.checkedPath(filePath)));
  }

  /** Check the full existing index before a commit handler stages any files. */
  async assertCanCommit(): Promise<void> {
    await this.assertStagedPathsOwned();
  }

  /** Explicit status paths replace `git add -A`, so every candidate is authorized. */
  private async workingTreePathsForStageAll(): Promise<string[]> {
    const output = await this.execGit([
      "ls-files",
      "--modified",
      "--deleted",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    return (
      output
        .split("\0")
        .filter(Boolean)
        // `git ls-files --others` prints an embedded repository as `child/`.
        // It is a directory marker, not a valid Git file path, so normalize it
        // before the boundary check can identify the nested root.
        .map((entry) => (entry.endsWith("/") ? entry.slice(0, -1) : entry))
    );
  }

  /**
   * The latest targeted status lookup for UI boundary notices. This is not a
   * discovery scan: callers receive only nested roots observed in status paths.
   */
  getNestedBoundaries(): Array<{ kind: "git" | "cvs"; root: string }> {
    return this.nestedBoundaries.map((boundary) => ({ ...boundary }));
  }

  private async updateNestedBoundaries(paths: string[]): Promise<void> {
    this.nestedBoundaries = paths.length
      ? await boundariesForPaths(this.cwd, "git", paths)
      : [];
  }

  private async configuredRemote(remote: string): Promise<string> {
    const safeRemote = safeRemoteName(remote);
    const configured = (await this.execGit(["remote"]))
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (!configured.includes(safeRemote)) {
      throw new Error("Remote is not configured for this repository");
    }
    return safeRemote;
  }

  private async execGit(
    args: string[],
    maxBuffer = MAX_BUFFER,
  ): Promise<string> {
    await this.ensureAvailable?.();
    const { stdout } = await execFileAsync("git", args, {
      cwd: this.cwd,
      maxBuffer,
      env: {
        ...process.env,
        LC_ALL: "C",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return stdout;
  }

  async checkGitAvailable(): Promise<boolean> {
    try {
      await this.execGit(["rev-parse", "--is-inside-work-tree"]);
      return true;
    } catch {
      return false;
    }
  }

  async getLog(options: LogOptions = {}): Promise<CommitNode[]> {
    const cacheKey = `log:${JSON.stringify(options)}`;
    const cached = this.cache.get<CommitNode[]>(cacheKey);
    if (cached) {
      return cached;
    }

    const args = [
      "log",
      `--format=${LOG_FORMAT}${FMT_RECORD_SEP}`,
      "--date-order",
    ];

    if (options.maxCount) {
      args.push(`--max-count=${options.maxCount}`);
    } else {
      args.push("--max-count=200");
    }
    if (options.skip) {
      args.push(`--skip=${options.skip}`);
    }
    if (options.author) {
      args.push(`--author=${options.author}`);
    }
    if (options.search) {
      args.push(`--grep=${options.search}`);
    }
    if (options.since) {
      args.push(`--since=${options.since}`);
    }
    if (options.until) {
      args.push(`--until=${options.until}`);
    }
    if (options.branch) {
      args.push(safeGitRevision(options.branch, "History ref"));
    } else {
      args.push("--all");
    }
    if (options.file) {
      args.push("--", options.file);
    }

    const output = await this.execGit(args);
    const commits = parseLogOutput(output);
    this.cache.set(cacheKey, commits);
    return commits;
  }

  async getGraphTopology(
    options: LogOptions = {},
    prevSnapshot?: LaneSnapshot,
  ): Promise<GraphLayoutResult> {
    const commits = await this.getLog(options);
    const breakHiddenParents = !!options.search;
    return computeGraphLayout(commits, prevSnapshot, breakHiddenParents);
  }

  async getBranches(): Promise<BranchInfo[]> {
    const cacheKey = "branches";
    const cached = this.cache.get<BranchInfo[]>(cacheKey);
    if (cached) {
      return cached;
    }

    const localFormat = [
      "%(refname:short)",
      "%(HEAD)",
      "%(upstream:short)",
      "%(upstream:track,nobracket)",
      "%(objectname:short)",
    ].join(REF_FMT_FIELD_SEP);

    const localOutput = await this.execGit([
      "branch",
      `--format=${localFormat}`,
    ]);

    const remoteOutput = await this.execGit([
      "branch",
      "-r",
      `--format=${localFormat}`,
    ]).catch(() => "");

    const branches: BranchInfo[] = [];

    for (const line of localOutput.trim().split("\n")) {
      if (!line.trim()) {
        continue;
      }
      const fields = line.split(FIELD_SEP);
      const name = fields[0]?.trim() ?? "";
      const isCurrent = fields[1]?.trim() === "*";
      const upstream = fields[2]?.trim() || undefined;
      const track = fields[3]?.trim() ?? "";
      const lastCommitHash = fields[4]?.trim() ?? "";

      const { ahead, behind } = parseTrack(track);

      branches.push({
        name,
        isRemote: false,
        isCurrent,
        upstream,
        ahead,
        behind,
        lastCommitHash,
      });
    }

    for (const line of remoteOutput.trim().split("\n")) {
      if (!line.trim()) {
        continue;
      }
      const fields = line.split(FIELD_SEP);
      const name = fields[0]?.trim() ?? "";
      const lastCommitHash = fields[4]?.trim() ?? "";

      // Skip HEAD pointers like origin/HEAD
      if (name.endsWith("/HEAD")) {
        continue;
      }

      branches.push({
        name,
        isRemote: true,
        isCurrent: false,
        ahead: 0,
        behind: 0,
        lastCommitHash,
      });
    }

    this.cache.set(cacheKey, branches);
    return branches;
  }

  async getRemoteBranches(): Promise<{ remote: string; branches: string[] }[]> {
    // Get the actual configured remotes (not inferred from tracking branches)
    const remoteOutput = await this.execGit(["remote"]).catch(() => "");
    const configuredRemotes = new Set(
      remoteOutput
        .trim()
        .split("\n")
        .map((r) => r.trim())
        .filter(Boolean),
    );

    if (configuredRemotes.size === 0) {
      return [];
    }

    const allBranches = await this.getBranches();
    const remoteBranches = allBranches.filter((b) => b.isRemote);

    const groups = new Map<string, string[]>();
    for (const branch of remoteBranches) {
      const slashIdx = branch.name.indexOf("/");
      if (slashIdx === -1) continue;
      const remote = branch.name.substring(0, slashIdx);
      // Only include branches for remotes that still exist
      if (!configuredRemotes.has(remote)) continue;
      const branchName = branch.name.substring(slashIdx + 1);
      if (!groups.has(remote)) {
        groups.set(remote, []);
      }
      groups.get(remote)?.push(branchName);
    }

    // Ensure all configured remotes appear even if they have no tracking branches yet
    for (const remote of configuredRemotes) {
      if (!groups.has(remote)) {
        groups.set(remote, []);
      }
    }

    // Sort branches alphabetically within each group (case-insensitive)
    const result: { remote: string; branches: string[] }[] = [];
    for (const [remote, branchList] of groups) {
      branchList.sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" }),
      );
      result.push({ remote, branches: branchList });
    }

    return result;
  }

  async getTags(): Promise<TagInfo[]> {
    const cacheKey = "tags";
    const cached = this.cache.get<TagInfo[]>(cacheKey);
    if (cached) {
      return cached;
    }

    const tagFormat = [
      "%(refname:short)",
      "%(objectname:short)",
      "%(objecttype)",
      "%(contents:subject)",
    ].join(REF_FMT_FIELD_SEP);

    const output = await this.execGit([
      "tag",
      "-l",
      `--format=${tagFormat}`,
    ]).catch(() => "");

    const tags: TagInfo[] = [];
    for (const line of output.trim().split("\n")) {
      if (!line.trim()) {
        continue;
      }
      const fields = line.split(FIELD_SEP);
      tags.push({
        name: fields[0]?.trim() ?? "",
        hash: fields[1]?.trim() ?? "",
        isAnnotated: fields[2]?.trim() === "tag",
        message: fields[3]?.trim() || undefined,
      });
    }

    this.cache.set(cacheKey, tags);
    return tags;
  }

  async getDiff(ref1: string, ref2: string, file?: string): Promise<string> {
    const args = [
      "diff",
      safeGitRevision(ref1, "Left revision"),
      safeGitRevision(ref2, "Right revision"),
    ];
    if (file) {
      args.push("--", safeRelativePath(file));
    }
    return this.execGit(args);
  }

  async getFileContent(ref: string, filePath: string): Promise<string> {
    if (!ref) {
      return "";
    }
    try {
      return await this.execGit([
        "show",
        `${safeGitContentRef(ref)}:${safeRelativePath(filePath)}`,
      ]);
    } catch {
      return "";
    }
  }

  async hasBaseline(file: string): Promise<boolean> {
    try {
      await this.execGit(["cat-file", "-e", `HEAD:${safeRelativePath(file)}`]);
      return true;
    } catch {
      return false;
    }
  }

  async getFileContentBuffer(ref: string, filePath: string): Promise<Buffer> {
    if (!ref) {
      return Buffer.alloc(0);
    }
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["show", `${safeGitContentRef(ref)}:${safeRelativePath(filePath)}`],
        {
          cwd: this.cwd,
          maxBuffer: MAX_BUFFER,
          encoding: "buffer",
          env: {
            ...process.env,
            LC_ALL: "C",
            GIT_TERMINAL_PROMPT: "0",
          },
        },
      );
      return stdout;
    } catch {
      return Buffer.alloc(0);
    }
  }

  /**
   * Read a blob or index entry without allowing a preview request to allocate
   * the regular 10 MiB Git command buffer.  Unlike the legacy content
   * provider, failures are not converted into an empty document: the resolver
   * has already represented legitimate missing sides explicitly as `empty`.
   */
  async getFileContentBufferLimited(
    ref: string,
    filePath: string,
    maxBytes: number,
  ): Promise<Buffer> {
    if (!ref) return Buffer.alloc(0);
    const limit = Math.max(1, Math.floor(maxBytes));
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["show", `${safeGitContentRef(ref)}:${safeRelativePath(filePath)}`],
        {
          cwd: this.cwd,
          // One extra byte makes an exact limit valid while retaining a hard
          // bound for an over-limit stream.
          maxBuffer: limit + 1,
          encoding: "buffer",
          env: {
            ...process.env,
            LC_ALL: "C",
            GIT_TERMINAL_PROMPT: "0",
          },
        },
      );
      const content = Buffer.from(stdout);
      if (content.byteLength > limit) throw new GitContentTooLargeError();
      return content;
    } catch (error) {
      if (error instanceof GitContentTooLargeError) throw error;
      if (
        (error as NodeJS.ErrnoException).code ===
        "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
      ) {
        throw new GitContentTooLargeError();
      }
      throw error;
    }
  }

  async getCommitFiles(hash: string): Promise<DiffFile[]> {
    const output = await this.execGit([
      "diff-tree",
      "--root",
      "--no-commit-id",
      "-r",
      "--name-status",
      "-z",
      "-M",
      safeObjectId(hash, "Commit hash"),
    ]);
    return parseDiffNameStatus(output);
  }

  async getCommitRangeFiles(hashes: string[]): Promise<DiffFile[]> {
    if (hashes.length === 0) return [];
    if (hashes.length === 1) return this.getCommitFiles(hashes[0]);

    // Cherry-pick style: get diff-tree for each commit individually, then merge
    const perCommitFiles = await Promise.all(
      hashes.map((h) => this.getCommitFiles(h)),
    );

    const merged = new Map<string, DiffFile>();
    for (const files of perCommitFiles) {
      for (const f of files) {
        const key = f.newPath || f.oldPath;
        if (!merged.has(key)) {
          merged.set(key, f);
        }
      }
    }
    return Array.from(merged.values());
  }

  async findFileRange(
    hashes: string[],
    filePath: string,
  ): Promise<{ oldest: string; newest: string } | null> {
    // From hashes (newest first), find commits that touch this file
    const touching: string[] = [];
    for (const h of hashes) {
      const files = await this.getCommitFiles(h);
      if (files.some((f) => f.newPath === filePath || f.oldPath === filePath)) {
        touching.push(h);
      }
    }
    if (touching.length === 0) return null;
    return { newest: touching[0], oldest: touching[touching.length - 1] };
  }

  async getStatus(): Promise<FileStatus[]> {
    const output = await this.execGit(["status", "--porcelain=v1", "-z"]);
    const files: FileStatus[] = parsePorcelainV1Z(output).map((entry) => ({
      path: entry.path,
      oldPath: entry.oldPath,
      indexStatus: entry.indexStatus,
      workTreeStatus: entry.workTreeStatus,
    }));
    await this.updateNestedBoundaries(files.map((file) => file.path));
    return files;
  }

  async getCommitParents(hash: string): Promise<string[]> {
    const output = await this.execGit([
      "rev-parse",
      `${safeObjectId(hash, "Commit hash")}^@`,
    ]).catch(() => "");
    return output
      .trim()
      .split("\n")
      .filter((s) => s.length > 0);
  }

  async getMergeState(): Promise<MergeState> {
    try {
      const mergeHead = (
        await fs.readFile(path.join(this.cwd, ".git", "MERGE_HEAD"), "utf-8")
      ).trim();
      let mergeMsg = "";
      try {
        mergeMsg = (
          await fs.readFile(path.join(this.cwd, ".git", "MERGE_MSG"), "utf-8")
        ).trim();
      } catch {}
      return { isMerging: true, mergeHead, mergeMsg };
    } catch {
      return { isMerging: false };
    }
  }

  async getCherryPickState(): Promise<CherryPickState> {
    try {
      const cherryPickHead = (
        await fs.readFile(
          path.join(this.cwd, ".git", "CHERRY_PICK_HEAD"),
          "utf-8",
        )
      ).trim();
      return { isCherryPicking: true, cherryPickHead };
    } catch {
      return { isCherryPicking: false };
    }
  }

  async cherryPickAction(action: "continue" | "abort" | "skip"): Promise<void> {
    await this.assertWholeWorktreeOwned();
    if (action === "continue") {
      // Stage all resolved files before continuing (like IntelliJ IDEA behavior)
      await this.execGit(["add", "-u"]);
      // Use --allow-empty to handle the case where cherry-pick becomes empty after conflict resolution
      try {
        await this.execGit(["cherry-pick", "--continue"]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("allow-empty")) {
          await this.execGit(["commit", "--allow-empty"]);
        } else {
          throw err;
        }
      }
    } else if (action === "skip") {
      await this.execGit(["cherry-pick", "--skip"]);
    } else {
      await this.execGit(["cherry-pick", "--abort"]);
    }
    this.invalidateCache();
  }

  async getRebaseState(): Promise<{
    isRebasing: boolean;
    branchName?: string;
    step?: number;
    totalSteps?: number;
  }> {
    const rebaseMergePath = path.join(this.cwd, ".git", "rebase-merge");
    const rebaseApplyPath = path.join(this.cwd, ".git", "rebase-apply");
    try {
      await fs.access(rebaseMergePath);
      let branchName = "";
      let step = 0;
      let totalSteps = 0;
      try {
        const headName = await fs.readFile(
          path.join(rebaseMergePath, "head-name"),
          "utf-8",
        );
        branchName = headName.trim().replace("refs/heads/", "");
      } catch {}
      try {
        const msgnum = await fs.readFile(
          path.join(rebaseMergePath, "msgnum"),
          "utf-8",
        );
        step = Number.parseInt(msgnum.trim(), 10);
      } catch {}
      try {
        const end = await fs.readFile(
          path.join(rebaseMergePath, "end"),
          "utf-8",
        );
        totalSteps = Number.parseInt(end.trim(), 10);
      } catch {}
      return { isRebasing: true, branchName, step, totalSteps };
    } catch {}
    try {
      await fs.access(rebaseApplyPath);
      let branchName = "";
      let step = 0;
      let totalSteps = 0;
      try {
        const headName = await fs.readFile(
          path.join(rebaseApplyPath, "head-name"),
          "utf-8",
        );
        branchName = headName.trim().replace("refs/heads/", "");
      } catch {}
      try {
        const next = await fs.readFile(
          path.join(rebaseApplyPath, "next"),
          "utf-8",
        );
        step = Number.parseInt(next.trim(), 10);
      } catch {}
      try {
        const last = await fs.readFile(
          path.join(rebaseApplyPath, "last"),
          "utf-8",
        );
        totalSteps = Number.parseInt(last.trim(), 10);
      } catch {}
      return { isRebasing: true, branchName, step, totalSteps };
    } catch {}
    return { isRebasing: false };
  }

  async getConflictFiles(): Promise<string[]> {
    const output = await this.execGit([
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);
    return output
      .trim()
      .split("\n")
      .filter((s) => s.length > 0);
  }

  async getFileVersions(
    filePath: string,
  ): Promise<{ base: string; ours: string; theirs: string }> {
    const [base, ours, theirs] = await Promise.all([
      this.getFileContent(":1", filePath),
      this.getFileContent(":2", filePath),
      this.getFileContent(":3", filePath),
    ]);
    return { base, ours, theirs };
  }

  async saveMergedContent(filePath: string, content: string): Promise<void> {
    const safePath = await this.checkedPath(filePath, true);
    const target = await resolveWorktreePath(this.cwd, safePath, {
      allowMissing: true,
    });
    await fs.writeFile(target, content, "utf-8");
  }

  async stageFile(filePath: string): Promise<void> {
    const safePath = await this.checkedPath(filePath);
    await this.execGit(["add", "--", safePath]);
  }

  async acceptOurs(filePath: string): Promise<void> {
    const safePath = await this.checkedPath(filePath);
    await this.execGit(["checkout", "--ours", "--", safePath]);
    await this.execGit(["add", "--", safePath]);
  }

  async acceptTheirs(filePath: string): Promise<void> {
    const safePath = await this.checkedPath(filePath);
    await this.execGit(["checkout", "--theirs", "--", safePath]);
    await this.execGit(["add", "--", safePath]);
  }

  async checkout(branchName: string): Promise<void> {
    await this.assertWholeWorktreeOwned();
    await this.execGit(["checkout", safeGitRef(branchName, "Branch")]);
    this.invalidateCache();
  }

  async createBranch(
    newBranchName: string,
    startPoint: string,
    force = false,
  ): Promise<void> {
    const safeBranch = safeGitRef(newBranchName, "Branch");
    const safeStartPoint = safeGitRevision(startPoint, "Start point");
    const args = force
      ? ["branch", "-f", safeBranch, safeStartPoint]
      : ["branch", safeBranch, safeStartPoint];
    await this.execGit(args);
    this.invalidateCache();
  }

  async deleteBranch(branchName: string, force = false): Promise<void> {
    const flag = force ? "-D" : "-d";
    await this.execGit(["branch", flag, safeGitRef(branchName, "Branch")]);
    this.invalidateCache();
  }

  async deleteRemoteBranch(remoteBranch: string): Promise<void> {
    // remoteBranch is like "origin/feature" → push --delete origin feature
    const slashIdx = remoteBranch.indexOf("/");
    if (slashIdx <= 0 || slashIdx === remoteBranch.length - 1) {
      throw new Error("Remote branch is invalid");
    }
    const remote = await this.configuredRemote(
      remoteBranch.substring(0, slashIdx),
    );
    const branch = safeGitRef(
      remoteBranch.substring(slashIdx + 1),
      "Remote branch",
    );
    await this.execGit(["push", remote, "--delete", branch]);
    this.invalidateCache();
  }

  async renameBranch(oldName: string, newName: string): Promise<void> {
    await this.execGit([
      "branch",
      "-m",
      safeGitRef(oldName, "Branch"),
      safeGitRef(newName, "Branch"),
    ]);
    this.invalidateCache();
  }

  async merge(branchName: string): Promise<void> {
    await this.assertWholeWorktreeOwned();
    await this.execGit(["merge", "--", safeGitRef(branchName, "Branch")]);
    this.invalidateCache();
  }

  async rebase(onto: string): Promise<void> {
    await this.assertWholeWorktreeOwned();
    await this.execGit(["rebase", safeGitRevision(onto, "Rebase target")]);
    this.invalidateCache();
  }

  async rebaseAction(action: "continue" | "abort" | "skip"): Promise<void> {
    await this.assertWholeWorktreeOwned();
    if (action === "continue") {
      // Stage all resolved files before continuing
      await this.execGit(["add", "-u"]);
    }
    await this.execGit(["rebase", `--${action}`]);
    this.invalidateCache();
  }

  async mergeAbort(): Promise<void> {
    await this.assertWholeWorktreeOwned();
    await this.execGit(["merge", "--abort"]);
    this.invalidateCache();
  }

  async mergeContinue(): Promise<void> {
    await this.assertWholeWorktreeOwned();
    // Stage all resolved files before committing
    await this.execGit(["add", "-u"]);
    await this.execGit(["commit", "--no-edit"]);
    this.invalidateCache();
  }

  async checkoutAndRebase(
    branchToCheckout: string,
    rebaseOnto: string,
  ): Promise<void> {
    await this.assertWholeWorktreeOwned();
    await this.execGit(["checkout", safeGitRef(branchToCheckout, "Branch")]);
    await this.execGit([
      "rebase",
      safeGitRevision(rebaseOnto, "Rebase target"),
    ]);
    this.invalidateCache();
  }

  async push(
    branchName: string,
    force = false,
    remote = "origin",
    targetBranch?: string,
  ): Promise<string> {
    const safeBranch = safeGitRef(branchName, "Branch");
    const safeRemote = await this.configuredRemote(remote);
    const safeTarget = safeGitRef(targetBranch || branchName, "Target branch");
    const args = ["push"];
    if (force) args.push("--force-with-lease");
    args.push(safeRemote, `${safeBranch}:${safeTarget}`);
    const output = await this.execGit(args);
    this.invalidateCache();
    return output;
  }

  /**
   * Get commits that are ahead of the remote tracking branch.
   * Returns commits in newest-first order.
   */
  async getAheadCommits(
    branchName: string,
    remote?: string,
  ): Promise<CommitNode[]> {
    const safeBranch = safeGitRef(branchName, "Branch");
    const remoteName = remote
      ? await this.configuredRemote(remote)
      : await this.getDefaultRemote(safeBranch);
    const upstream = `${remoteName}/${safeBranch}`;
    // Check if upstream exists
    try {
      await this.execGit(["rev-parse", "--verify", upstream]);
    } catch {
      // No upstream — all local commits are "ahead"
      const args = [
        "log",
        `--format=${LOG_FORMAT}${FMT_RECORD_SEP}`,
        safeBranch,
        "--max-count=50",
      ];
      const output = await this.execGit(args);
      return parseLogOutput(output);
    }
    const args = [
      "log",
      `--format=${LOG_FORMAT}${FMT_RECORD_SEP}`,
      `${upstream}..${safeBranch}`,
    ];
    const output = await this.execGit(args);
    return parseLogOutput(output);
  }

  async pull(branchName?: string): Promise<void> {
    if (branchName && branchName !== (await this.getCurrentBranch()))
      throw new Error(
        "Update Project updates the current branch upstream only.",
      );
    await this.updateFastForward(this.ensureAvailable);
  }

  /** Catalog update never merges, rebases, stashes, or recurses into submodules. */
  async updateFastForward(
    revalidate: () => Promise<void> = async () => {},
    signal?: AbortSignal,
  ): Promise<void> {
    await revalidate();
    await this.assertWholeWorktreeOwned();
    const branch = (
      await this.execGit(["symbolic-ref", "--quiet", "HEAD"]).catch(() => "")
    ).trim();
    if (!branch)
      throw new Error(
        vscode.l10n.t(
          "Cannot update a detached HEAD. Check out a branch first.",
        ),
      );
    const upstream = (
      await this.execGit([
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
      ]).catch(() => "")
    ).trim();
    if (!upstream)
      throw new Error(
        vscode.l10n.t(
          "This branch has no upstream. Configure an upstream before updating.",
        ),
      );
    const dirty = await this.execGit([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    if (dirty)
      throw new Error(
        vscode.l10n.t(
          "Commit or discard local changes before updating this repository.",
        ),
      );
    for (const marker of [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
      "sequencer",
      "BISECT_LOG",
    ]) {
      const location = (
        await this.execGit(["rev-parse", "--git-path", marker])
      ).trim();
      if (
        await fs.stat(path.resolve(this.cwd, location)).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        )
      ) {
        throw new Error(
          vscode.l10n.t(
            "Finish the current Git operation before updating this repository.",
          ),
        );
      }
    }
    // Repeat the Host identity/editor guard after all asynchronous preflight reads.
    await revalidate();
    await this.assertWholeWorktreeOwned();
    await execFileAsync(
      "git",
      [
        "pull",
        "--ff-only",
        "--no-rebase",
        "--no-autostash",
        "--no-recurse-submodules",
      ],
      {
        cwd: this.cwd,
        maxBuffer: MAX_BUFFER,
        timeout: 60_000,
        signal,
        env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
      },
    );
    this.invalidateCache();
  }

  async pullRebase(branchName?: string): Promise<void> {
    await this.pull(branchName);
  }

  async fetch(remote = "origin"): Promise<void> {
    await this.execGit(["fetch", await this.configuredRemote(remote)]);
    this.invalidateCache();
  }

  async cherryPick(hash: string): Promise<void> {
    await this.assertWholeWorktreeOwned();
    await this.execGit(["cherry-pick", safeObjectId(hash, "Commit hash")]);
    this.invalidateCache();
  }

  async checkoutCommit(hash: string): Promise<void> {
    await this.assertWholeWorktreeOwned();
    await this.execGit(["checkout", safeObjectId(hash, "Commit hash")]);
    this.invalidateCache();
  }

  async checkoutFileFromCommit(hash: string, filePath: string): Promise<void> {
    await this.execGit([
      "checkout",
      safeObjectId(hash, "Commit hash"),
      "--",
      await this.checkedPath(filePath),
    ]);
    this.invalidateCache();
  }

  async checkoutFileFromParent(
    hash: string,
    filePath: string,
    status?: string,
  ): Promise<void> {
    const safePath = await this.checkedPath(filePath);
    const safeHash = safeObjectId(hash, "Commit hash");
    if (status === "added") {
      // File was newly added in this commit, revert means removing it
      // Use --cached to handle case where file may not exist on disk
      try {
        await this.execGit(["rm", "-f", "--", safePath]);
      } catch {
        // File might not exist in working tree or index, try removing from index only
        try {
          await this.execGit(["rm", "-f", "--cached", "--", safePath]);
        } catch {
          // File doesn't exist at all - nothing to revert
        }
        // Also try to remove the physical file if it exists
        try {
          await fs.unlink(await resolveWorktreePath(this.cwd, safePath));
        } catch {
          // File already doesn't exist on disk
        }
      }
    } else if (status === "deleted") {
      // File was deleted in this commit, revert means restoring it from parent
      await this.execGit(["checkout", `${safeHash}~1`, "--", safePath]);
    } else {
      // File was modified/renamed/copied, revert to parent state
      await this.execGit(["checkout", `${safeHash}~1`, "--", safePath]);
    }
    this.invalidateCache();
  }

  async resetToCommit(
    hash: string,
    mode: "soft" | "mixed" | "hard",
  ): Promise<void> {
    await this.assertWholeWorktreeOwned();
    await this.execGit([
      "reset",
      `--${mode}`,
      safeObjectId(hash, "Commit hash"),
    ]);
    this.invalidateCache();
  }

  async revertCommit(hash: string): Promise<void> {
    await this.assertWholeWorktreeOwned();
    await this.execGit([
      "revert",
      "--no-edit",
      safeObjectId(hash, "Commit hash"),
    ]);
    this.invalidateCache();
  }

  async dropCommit(hash: string): Promise<void> {
    await this.assertWholeWorktreeOwned();
    hash = safeObjectId(hash, "Commit hash");
    const headHash = (await this.execGit(["rev-parse", "HEAD"])).trim();
    const isHead = hash === headHash;

    if (isHead) {
      await this.dropHeadCommit(hash);
    } else {
      await this.dropNonHeadCommit(hash);
    }
    this.invalidateCache();
  }

  private async dropHeadCommit(hash: string): Promise<void> {
    // Verify commit has a parent
    const parents = await this.getCommitParents(hash);
    if (parents.length === 0) {
      throw new Error(
        vscode.l10n.t("Cannot drop the initial commit (no parent)"),
      );
    }
    await this.execGit(["reset", "--mixed", "HEAD~1"]);
  }

  private async dropNonHeadCommit(hash: string): Promise<void> {
    // 1. Capture the target commit's diff BEFORE rebase
    const diff = await this.execGit(["diff-tree", "-p", hash]);

    // 2. Check working directory status
    const status = await this.execGit(["status", "--porcelain"]);
    const isDirty = status.trim().length > 0;

    // 3. Stash if dirty
    if (isDirty) {
      await this.execGit([
        "stash",
        "push",
        "-u",
        "-m",
        "drop-commit-autostash",
      ]);
    }

    // 4. Execute rebase to remove the commit
    try {
      await this.execGit(["rebase", "--onto", `${hash}^`, hash]);
    } catch (rebaseErr) {
      // Abort rebase on failure
      try {
        await this.execGit(["rebase", "--abort"]);
      } catch {
        // ignore abort errors
      }

      // Restore stash if it was used
      if (isDirty) {
        try {
          await this.execGit(["stash", "pop"]);
        } catch {
          // stash pop failure is secondary
        }
      }

      throw rebaseErr;
    }

    // 5. Restore stashed changes on success
    if (isDirty) {
      await this.execGit(["stash", "pop"]);
    }

    // 6. Apply dropped commit's diff to working directory via temp file
    if (diff.trim()) {
      const tmpFile = path.join(os.tmpdir(), `drop-commit-${hash}.patch`);
      try {
        await fs.writeFile(tmpFile, diff, "utf-8");
        await this.execGit(["apply", "--3way", tmpFile]);
      } catch {
        throw new Error(
          vscode.l10n.t(
            "Commit was removed from history but its changes could not be applied to the working directory",
          ),
        );
      } finally {
        try {
          await fs.unlink(tmpFile);
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }

  async createBranchFromCommit(
    branchName: string,
    hash: string,
    force = false,
  ): Promise<void> {
    const safeBranch = safeGitRef(branchName, "Branch");
    const safeHash = safeObjectId(hash, "Commit hash");
    const args = force
      ? ["branch", "-f", safeBranch, safeHash]
      : ["branch", safeBranch, safeHash];
    await this.execGit(args);
    this.invalidateCache();
  }

  async createTag(
    tagName: string,
    hash: string,
    message?: string,
  ): Promise<void> {
    const safeTag = safeGitRef(tagName, "Tag");
    const safeHash = safeObjectId(hash, "Commit hash");
    if (message) {
      await this.execGit(["tag", "-a", safeTag, safeHash, "-m", message]);
    } else {
      await this.execGit(["tag", safeTag, safeHash]);
    }
    this.invalidateCache();
  }

  // ─── Commit Panel Operations ───────────────────────────────────────

  async getWorkingTreeChanges(
    paths?: string[],
    collapseUnversioned = false,
  ): Promise<import("./types").WorkingTreeFile[]> {
    const output = await this.execGit([
      "status",
      "--porcelain=v1",
      "-z",
      collapseUnversioned ? "-unormal" : "-uall",
      ...(paths ? ["--", ...paths.map(safeRelativePath)] : []),
    ]);
    const files: import("./types").WorkingTreeFile[] = [];

    for (const entry of parsePorcelainV1Z(output)) {
      const code = `${entry.indexStatus}${entry.workTreeStatus}`;
      if (code === "!!") continue;
      if (isUnmerged(code)) {
        files.push({
          path: entry.path,
          oldPath: entry.oldPath,
          status: "conflicted",
          staged: true,
        });
        continue;
      }
      if (isIndexChange(entry.indexStatus)) {
        files.push({
          path: entry.path,
          oldPath:
            entry.indexStatus === "R" || entry.indexStatus === "C"
              ? entry.oldPath
              : undefined,
          status: workingStatus(entry.indexStatus),
          staged: true,
        });
      }
      if (entry.workTreeStatus === "?") {
        files.push({ path: entry.path, status: "untracked", staged: false });
      } else if (isWorktreeChange(entry.workTreeStatus)) {
        // An index rename followed by a disk edit compares the index's new
        // name with that same new worktree path; the old name belongs only to
        // the staged rename comparison.
        files.push({
          path: entry.path,
          oldPath:
            entry.workTreeStatus === "R" || entry.workTreeStatus === "C"
              ? entry.oldPath
              : undefined,
          status: workingStatus(entry.workTreeStatus),
          staged: false,
        });
      }
    }
    await this.updateNestedBoundaries(files.map((file) => file.path));
    return files.filter(
      (file) =>
        !this.nestedBoundaries.some((boundary) => {
          const target = path.resolve(this.cwd, file.path);
          const relative = path.relative(boundary.root, target);
          return (
            relative === "" ||
            (!path.isAbsolute(relative) &&
              relative !== ".." &&
              !relative.startsWith(`..${path.sep}`))
          );
        }),
    );
  }

  async stageFiles(filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) return;
    await this.execGit(["add", "--", ...(await this.checkedPaths(filePaths))]);
  }

  async unstageFile(filePath: string): Promise<void> {
    await this.execGit([
      "reset",
      "HEAD",
      "--",
      await this.checkedPath(filePath),
    ]);
  }

  async unstageAll(): Promise<void> {
    await this.assertWholeWorktreeOwned();
    await this.execGit(["reset", "HEAD"]);
  }

  async stageAll(): Promise<void> {
    const paths: string[] = [];
    for (const candidate of await this.workingTreePathsForStageAll()) {
      try {
        paths.push(await this.checkedPath(candidate));
      } catch (error) {
        if (
          !(error instanceof NestedRepositoryError) ||
          error.code !== "NESTED_REPOSITORY"
        )
          throw error;
      }
    }
    if (paths.length) await this.execGit(["add", "--", ...paths]);
  }

  async commit(message: string, amend = false): Promise<void> {
    await this.assertStagedPathsOwned();
    const args = ["commit", "-m", message];
    if (amend) args.push("--amend");
    await this.execGit(args);
    this.invalidateCache();
  }

  async commitPaths(
    message: string,
    paths: string[],
    amend = false,
  ): Promise<void> {
    if (!message.trim() || message.includes("\0") || !paths.length)
      throw new Error(
        vscode.l10n.t("Enter a commit message and select changed files."),
      );
    await this.assertCanCommit();
    const checked = await this.checkedPaths([...new Set(paths)]);
    await this.execGit([
      "commit",
      "-m",
      message,
      ...(amend ? ["--amend"] : []),
      "--",
      ...checked,
    ]);
    this.invalidateCache();
  }

  async commitAndPush(message: string, amend = false): Promise<void> {
    await this.commit(message, amend);
    // Push current branch
    const branch = await this.getCurrentBranch();
    if (branch) {
      const force = amend;
      await this.push(branch, force);
    }
  }

  async getCurrentBranch(): Promise<string | null> {
    try {
      const output = await this.execGit(["rev-parse", "--abbrev-ref", "HEAD"]);
      const branch = output.trim();
      return branch === "HEAD" ? null : branch;
    } catch {
      return null;
    }
  }

  /**
   * Get the default remote for the current branch.
   * Tries the upstream tracking remote first, then falls back to the first configured remote.
   */
  async getDefaultRemote(branch?: string): Promise<string> {
    // Try to get the upstream remote for the given branch
    if (branch) {
      branch = safeGitRef(branch, "Branch");
      try {
        const output = await this.execGit([
          "config",
          `branch.${branch}.remote`,
        ]);
        const remote = output.trim();
        if (remote) return safeRemoteName(remote);
      } catch {
        // No upstream configured
      }
    }

    // Fall back to first configured remote
    try {
      const output = await this.execGit(["remote"]);
      const remotes = output
        .trim()
        .split("\n")
        .map((r) => r.trim())
        .filter(Boolean);
      if (remotes.length > 0) {
        // Prefer "origin" if it exists, otherwise first remote
        return safeRemoteName(
          remotes.includes("origin") ? "origin" : remotes[0],
        );
      }
    } catch {
      // ignore
    }

    return "origin";
  }

  async getLastCommitMessage(): Promise<string> {
    try {
      const output = await this.execGit(["log", "-1", "--format=%B"]);
      return output.trim();
    } catch {
      return "";
    }
  }

  async getRecentCommitMessages(count = 20): Promise<string[]> {
    try {
      if (!Number.isSafeInteger(count) || count < 1 || count > 200) {
        throw new Error("Commit message count is invalid");
      }
      const output = await this.execGit(["log", `-${count}`, "--format=%s"]);
      return output
        .trim()
        .split("\n")
        .filter((msg) => msg.length > 0);
    } catch {
      return [];
    }
  }

  async rollbackFile(filePath: string): Promise<void> {
    const safePath = await this.checkedPath(filePath);
    // Check if file exists in HEAD (i.e., was previously committed)
    let existsInHead = false;
    try {
      await this.execGit(["cat-file", "-e", `HEAD:${safePath}`]);
      existsInHead = true;
    } catch {
      existsInHead = false;
    }

    if (existsInHead) {
      // File exists in HEAD - restore to HEAD version (handles both staged and unstaged changes)
      await this.execGit(["checkout", "HEAD", "--", safePath]);
    } else {
      // File is new (not in HEAD) - remove from index and delete from disk
      try {
        await this.execGit(["rm", "-f", "--cached", "--", safePath]);
      } catch {
        // Not in index either, nothing to unstage
      }
      const fullPath = await resolveWorktreePath(this.cwd, safePath);
      try {
        await fs.unlink(fullPath);
      } catch {
        // File already doesn't exist on disk
      }
    }
  }

  // ─── Shelf (Stash-based) Operations ───────────────────────────────

  async getShelves(): Promise<import("./types").ShelveEntry[]> {
    try {
      const output = await this.execGit([
        "stash",
        "list",
        "--format=%gd%x00%s%x00%aI%x00%D",
      ]);
      if (!output.trim()) return [];

      const entries: import("./types").ShelveEntry[] = [];
      for (const line of output.trim().split("\n")) {
        if (!line.trim()) continue;
        const parts = line.split("\x00");
        const id = parts[0] ?? "";
        const message = (parts[1] ?? "").replace(/^(WIP on|On) [^:]+:\s*/, "");
        const date = parts[2] ?? "";
        const _refs = parts[3] ?? "";
        // Extract branch from refs or message
        const branchMatch = (parts[1] ?? "").match(/^(?:WIP on|On) ([^:]+)/);
        const branch = branchMatch?.[1] ?? "";

        entries.push({ id, message, date, branch, files: [] });
      }

      // Load files for each stash
      for (const entry of entries) {
        try {
          const filesOutput = await this.execGit([
            "stash",
            "show",
            entry.id,
            "--name-only",
          ]);
          entry.files = filesOutput.trim().split("\n").filter(Boolean);
        } catch {
          // ignore
        }
      }

      return entries;
    } catch {
      return [];
    }
  }

  async shelveChanges(message: string, filePaths?: string[]): Promise<void> {
    if (filePaths && filePaths.length > 0) {
      const selectedPaths = await this.checkedPaths(filePaths);
      // This workflow resets and reconstructs the whole index before stashing.
      await this.assertStagedPathsOwned();
      // Strategy: to stash only specific files without pulling in other staged files,
      // we need to temporarily reset the index, stage only our target files, then stash.

      // 1. Save current index state by creating a temporary stash of the index
      //    We use a different approach: reset index, add targets, stash, restore index.

      // Get current status to know what's staged
      const statusBefore = await this.execGit(["status", "--porcelain=v1"]);
      const previouslyStaged: string[] = [];
      for (const line of statusBefore.split("\n")) {
        if (line.length < 4) continue;
        const indexStatus = line[0];
        if (indexStatus !== " " && indexStatus !== "?" && indexStatus !== "!") {
          const rest = line.substring(3);
          const arrowIdx = rest.indexOf(" -> ");
          const filePath =
            arrowIdx !== -1 ? rest.substring(arrowIdx + 4) : rest;
          previouslyStaged.push(filePath);
        }
      }

      // 2. Reset the index (unstage everything) without touching working tree
      try {
        await this.execGit(["reset", "HEAD"]);
      } catch {
        // May fail if there's no HEAD (initial commit) — that's ok
      }

      // 3. Stage only the target files
      await this.execGit(["add", "--", ...selectedPaths]);

      // 4. Stash only the staged files
      await this.execGit([
        "stash",
        "push",
        "--staged",
        "-m",
        message || "Shelved changes",
      ]);

      // 5. Re-stage previously staged files (that weren't stashed)
      const remainingToStage = previouslyStaged.filter(
        (f) => !selectedPaths.includes(f),
      );
      if (remainingToStage.length > 0) {
        try {
          await this.execGit(["add", "--", ...remainingToStage]);
        } catch {
          // Some files may no longer exist, ignore errors
        }
      }
    } else {
      await this.assertWholeWorktreeOwned();
      // Stash all changes including untracked
      const args = ["stash", "push", "-m", message || "Shelved changes", "-u"];
      await this.execGit(args);
    }
    this.invalidateCache();
  }

  async unshelveChanges(stashId: string, drop = true): Promise<void> {
    await this.assertWholeWorktreeOwned();
    await this.assertKnownStash(stashId);
    if (drop) {
      await this.execGit(["stash", "pop", stashId]);
    } else {
      await this.execGit(["stash", "apply", stashId]);
    }
    this.invalidateCache();
  }

  async deleteShelve(stashId: string): Promise<void> {
    await this.assertKnownStash(stashId);
    await this.execGit(["stash", "drop", stashId]);
  }

  private async assertKnownStash(stashId: string): Promise<void> {
    if (!/^stash@\{\d+\}$/.test(stashId)) {
      throw new Error("Shelf entry is invalid");
    }
    const known = await this.getShelves();
    if (!known.some((entry) => entry.id === stashId)) {
      throw new Error("Shelf entry is not available in this repository");
    }
  }

  // ─── IDEA Shelf (patch-file based) Operations ─────────────────────

  private async getShelfDirectory(create = false): Promise<string> {
    await this.checkedPath(".idea/shelf", create);
    const candidate = await resolveWorktreePath(this.cwd, ".idea/shelf", {
      allowMissing: create,
    });
    if (create) {
      await fs.mkdir(candidate, { recursive: true });
      return resolveWorktreePath(this.cwd, ".idea/shelf");
    }
    return candidate;
  }

  async getIdeaShelves(): Promise<IdeaShelfEntry[]> {
    let shelfDir: string;
    try {
      shelfDir = await this.getShelfDirectory();
    } catch {
      return [];
    }

    const entries: IdeaShelfEntry[] = [];
    const dirContents = await fs.readdir(shelfDir);

    for (const item of dirContents) {
      if (!item.endsWith(".xml")) continue;
      try {
        const xmlCandidate = path.join(shelfDir, safeRelativePath(item));
        if ((await fs.lstat(xmlCandidate)).isSymbolicLink()) continue;
        const xmlPath = await resolveWorktreePath(shelfDir, item);
        const xmlContent = await fs.readFile(xmlPath, "utf-8");
        const entry = await this.parseIdeaShelfXml(
          xmlContent,
          item.slice(0, -".xml".length),
        );
        if (entry) entries.push(entry);
      } catch {
        // skip malformed entries
      }
    }

    // Sort by date descending (newest first)
    entries.sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );
    return entries;
  }

  private async parseIdeaShelfXml(
    xmlContent: string,
    expectedName: string,
  ): Promise<IdeaShelfEntry | null> {
    // Parse: <changelist name="..." date="..." recycled="...">
    const nameMatch = xmlContent.match(/changelist\s+name="([^"]*)"/);
    const dateMatch = xmlContent.match(/\bdate="(\d+)"/);
    const descMatch = xmlContent.match(
      /option\s+name="DESCRIPTION"\s+value="([^"]*)"/,
    );

    if (!nameMatch || nameMatch[1] !== expectedName) return null;

    const name = nameMatch[1];
    const dateMs = dateMatch ? Number.parseInt(dateMatch[1], 10) : Date.now();
    const date = new Date(dateMs).toISOString();
    const description = descMatch?.[1] ?? "";

    let shelf: Awaited<ReturnType<typeof resolveShelfEntry>>;
    try {
      shelf = await resolveShelfEntry(this.cwd, name);
    } catch {
      return null;
    }
    const files = await this.parseFilesFromPatchPath(shelf.patch);

    return { name, description, date, patchPath: shelf.patch, files };
  }

  private async parseFilesFromPatchPath(patchPath: string): Promise<string[]> {
    try {
      const content = await fs.readFile(patchPath, "utf-8");
      return this.parseFilesFromPatch(content);
    } catch {
      return [];
    }
  }

  private parseFilesFromPatch(patchContent: string): string[] {
    const files: string[] = [];
    const lines = patchContent.split("\n");
    for (const line of lines) {
      // Match: diff --git a/path b/path
      const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (diffMatch) {
        files.push(diffMatch[2]);
        continue;
      }
      // Match: Index: path
      const indexMatch = line.match(/^Index:\s+(.+)$/);
      if (indexMatch) {
        files.push(indexMatch[1]);
      }
    }
    return [...new Set(files)];
  }

  async ideaShelveChanges(
    message: string,
    filePaths?: string[],
  ): Promise<void> {
    if (filePaths && filePaths.length > 0) {
      await this.checkedPaths(filePaths);
    } else {
      await this.assertWholeWorktreeOwned();
    }
    const shelfDir = await this.getShelfDirectory(true);

    const sanitizedName =
      this.sanitizeShelfName(message || "Changes") || "Changes";
    const uniqueName = await this.getUniqueShelfName(shelfDir, sanitizedName);

    // Create shelf subdirectory
    const entryDir = path.join(shelfDir, uniqueName);
    await this.checkedPath(path.join(".idea", "shelf", uniqueName), true);
    await fs.mkdir(entryDir, { recursive: true });
    const verifiedEntryDir = await resolveWorktreePath(shelfDir, uniqueName);

    // Generate patch
    let patchContent = "";
    if (filePaths && filePaths.length > 0) {
      patchContent = await this.generatePatchForFiles(filePaths);
    } else {
      patchContent = await this.generatePatchAll();
    }

    if (!patchContent.trim()) {
      // Clean up empty directory
      await fs.rm(verifiedEntryDir, { recursive: true, force: true });
      throw new Error(vscode.l10n.t("No changes to shelve"));
    }

    // Write patch file
    const patchFilePath = await resolveWorktreePath(
      verifiedEntryDir,
      "shelved.patch",
      { allowMissing: true },
    );
    await fs.writeFile(patchFilePath, patchContent, "utf-8");

    // Write XML metadata
    const timestamp = Date.now();
    const xmlContent = `<changelist name="${this.escapeXml(uniqueName)}" date="${timestamp}" recycled="false">\n  <option name="PATH" value="$PROJECT_DIR$/.idea/shelf/${uniqueName}/shelved.patch" />\n  <option name="DESCRIPTION" value="${this.escapeXml(message || "")}" />\n</changelist>\n`;
    const xmlPath = await resolveWorktreePath(shelfDir, `${uniqueName}.xml`, {
      allowMissing: true,
    });
    await fs.writeFile(xmlPath, xmlContent, "utf-8");

    // Revert the files in working tree
    if (filePaths && filePaths.length > 0) {
      await this.revertFiles(filePaths);
    } else {
      await this.revertAllChanges();
    }

    this.invalidateCache();
  }

  async ideaUnshelveChanges(shelfName: string, drop?: boolean): Promise<void> {
    await this.assertWholeWorktreeOwned();
    const shelf = await resolveShelfEntry(this.cwd, shelfName);

    try {
      const patchContent = await fs.readFile(shelf.patch, "utf-8");
      if (patchContent.trim()) {
        // Apply patch using git apply
        try {
          await this.execGit(["apply", "--3way", "--", shelf.patch]);
        } catch {
          // Try without --3way as fallback
          await this.execGit(["apply", "--", shelf.patch]);
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        vscode.l10n.t('Failed to apply shelf "{0}": {1}', shelfName, message),
      );
    }

    if (drop) {
      await this.deleteIdeaShelf(shelfName);
    }

    this.invalidateCache();
  }

  async deleteIdeaShelf(shelfName: string): Promise<void> {
    const safeShelfName = safeRelativePath(shelfName);
    await this.checkedPath(path.join(".idea", "shelf", safeShelfName), true);
    const shelf = await resolveShelfEntry(this.cwd, shelfName);

    // Delete directory
    try {
      await fs.rm(shelf.directory, { recursive: true, force: true });
    } catch {
      // ignore
    }

    // Delete XML file
    try {
      await fs.unlink(shelf.xml);
    } catch {
      // ignore
    }
  }

  private sanitizeShelfName(name: string): string {
    return name
      .replace(/[<>:"/\\|?*]/g, "_")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .substring(0, 100);
  }

  async importPatchAsShelf(name: string, patchContent: string): Promise<void> {
    const shelfDir = await this.getShelfDirectory(true);

    const sanitized = this.sanitizeShelfName(name || "Imported") || "Imported";
    const shelfName = await this.getUniqueShelfName(shelfDir, sanitized);

    // Create shelf directory and write patch
    const entryDir = path.join(shelfDir, shelfName);
    await this.checkedPath(path.join(".idea", "shelf", shelfName), true);
    await fs.mkdir(entryDir, { recursive: true });
    const verifiedEntryDir = await resolveWorktreePath(shelfDir, shelfName);
    await fs.writeFile(
      await resolveWorktreePath(verifiedEntryDir, "shelved.patch", {
        allowMissing: true,
      }),
      patchContent,
      "utf-8",
    );

    // Write XML metadata
    const now = Date.now();
    const xml = `<changelist name="${shelfName}" date="${now}" recycled="false">\n  <option name="PATH" value="$PROJECT_DIR$/.idea/shelf/${shelfName}/shelved.patch" />\n  <option name="DESCRIPTION" value="${shelfName}" />\n</changelist>\n`;
    await fs.writeFile(
      await resolveWorktreePath(shelfDir, `${shelfName}.xml`, {
        allowMissing: true,
      }),
      xml,
      "utf-8",
    );
  }

  private async getUniqueShelfName(
    shelfDir: string,
    baseName: string,
  ): Promise<string> {
    safeRelativePath(baseName);
    let candidate = baseName;
    let counter = 1;
    while (true) {
      const xmlPath = path.join(shelfDir, `${candidate}.xml`);
      try {
        await fs.access(xmlPath);
        // File exists, try next
        candidate = `${baseName}${counter}`;
        counter++;
      } catch {
        // File doesn't exist, use this name
        return candidate;
      }
    }
  }

  private async generatePatchForFiles(filePaths: string[]): Promise<string> {
    let patch = "";

    // Separate tracked and untracked files
    const tracked: string[] = [];
    const untracked: string[] = [];

    for (const filePath of await this.checkedPaths(filePaths)) {
      try {
        await this.execGit(["ls-files", "--error-unmatch", "--", filePath]);
        tracked.push(filePath);
      } catch {
        untracked.push(filePath);
      }
    }

    // Generate diff for tracked files (staged + unstaged)
    if (tracked.length > 0) {
      try {
        const diff = await this.execGit(["diff", "HEAD", "--", ...tracked]);
        patch += diff;
      } catch {
        // If HEAD doesn't exist (initial commit), diff against empty tree
        try {
          const diff = await this.execGit([
            "diff",
            "--cached",
            "--",
            ...tracked,
          ]);
          patch += diff;
        } catch {
          // ignore
        }
      }
    }

    // Generate patch for untracked files
    for (const filePath of untracked) {
      const fullPath = await resolveWorktreePath(this.cwd, filePath);
      try {
        const content = await fs.readFile(fullPath, "utf-8");
        const lines = content.split("\n");
        patch += `diff --git a/${filePath} b/${filePath}\n`;
        patch += "new file mode 100644\n";
        patch += "--- /dev/null\n";
        patch += `+++ b/${filePath}\n`;
        patch += `@@ -0,0 +1,${lines.length} @@\n`;
        for (const line of lines) {
          patch += `+${line}\n`;
        }
      } catch {
        // skip files that can't be read
      }
    }

    return patch;
  }

  private async generatePatchAll(): Promise<string> {
    let patch = "";

    // Get diff for all tracked changes
    try {
      const diff = await this.execGit(["diff", "HEAD"]);
      patch += diff;
    } catch {
      try {
        const diff = await this.execGit(["diff", "--cached"]);
        patch += diff;
      } catch {
        // ignore
      }
    }

    // Get untracked files
    try {
      const untrackedOutput = await this.execGit([
        "ls-files",
        "--others",
        "--exclude-standard",
      ]);
      const untrackedFiles = untrackedOutput.trim().split("\n").filter(Boolean);

      for (const filePath of untrackedFiles) {
        const fullPath = await resolveWorktreePath(this.cwd, filePath);
        try {
          const content = await fs.readFile(fullPath, "utf-8");
          const lines = content.split("\n");
          patch += `diff --git a/${filePath} b/${filePath}\n`;
          patch += "new file mode 100644\n";
          patch += "--- /dev/null\n";
          patch += `+++ b/${filePath}\n`;
          patch += `@@ -0,0 +1,${lines.length} @@\n`;
          for (const line of lines) {
            patch += `+${line}\n`;
          }
        } catch {
          // skip binary or unreadable files
        }
      }
    } catch {
      // ignore
    }

    return patch;
  }

  private async revertFiles(filePaths: string[]): Promise<void> {
    for (const filePath of await this.checkedPaths(filePaths)) {
      try {
        await this.execGit(["ls-files", "--error-unmatch", "--", filePath]);
        // Tracked file: checkout from HEAD
        await this.execGit(["checkout", "HEAD", "--", filePath]);
      } catch {
        // Untracked file: delete it
        const fullPath = await resolveWorktreePath(this.cwd, filePath);
        try {
          await fs.unlink(fullPath);
        } catch {
          // ignore
        }
      }
    }
  }

  private async revertAllChanges(): Promise<void> {
    await this.assertWholeWorktreeOwned();
    // Reset tracked files
    try {
      await this.execGit(["checkout", "HEAD", "--", "."]);
    } catch {
      // ignore (e.g. no HEAD yet)
    }
    // Remove untracked files
    try {
      await this.execGit(["clean", "-fd"]);
    } catch {
      // ignore
    }
  }

  private escapeXml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  invalidateCache(pattern?: string): void {
    this.cache.invalidate(pattern);
  }
}

interface PorcelainV1Entry {
  indexStatus: string;
  workTreeStatus: string;
  /** In `-z` mode this is the destination/current path. */
  path: string;
  /** Present for a rename or copy, without quoting or arrow heuristics. */
  oldPath?: string;
}

/**
 * Parse Git porcelain v1's NUL-delimited form. Unlike the human-oriented
 * newline form it preserves embedded newlines, spaces, Unicode and literal
 * ` -> ` path text. Rename/copy records are `XY new\0old\0` in this mode.
 */
function parsePorcelainV1Z(output: string): PorcelainV1Entry[] {
  const records = output.split("\0");
  const entries: PorcelainV1Entry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const indexStatus = record[0] ?? " ";
    const workTreeStatus = record[1] ?? " ";
    if (record[2] !== " ") continue;
    const path = record.slice(3);
    if (!path) continue;
    const renameOrCopy = [indexStatus, workTreeStatus].some(
      (status) => status === "R" || status === "C",
    );
    const oldPath = renameOrCopy ? records[++index] : undefined;
    if (renameOrCopy && !oldPath) continue;
    entries.push({ indexStatus, workTreeStatus, path, oldPath });
  }
  return entries;
}

function isIndexChange(status: string): boolean {
  return status !== " " && status !== "?" && status !== "!";
}

function isWorktreeChange(status: string): boolean {
  return status !== " " && status !== "?" && status !== "!";
}

function isUnmerged(code: string): boolean {
  return ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(code);
}

function workingStatus(
  code: string,
): import("./types").WorkingTreeFile["status"] {
  if (code === "A") return "added";
  if (code === "D") return "deleted";
  if (code === "R" || code === "C") return "renamed";
  return "modified";
}

/** Parse NUL-delimited `git diff --name-status -z` output. */
function parseDiffNameStatus(output: string): DiffFile[] {
  const files: DiffFile[] = [];
  const records = output.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const statusCode = records[index] ?? "";
    if (!statusCode) continue;
    if (statusCode.startsWith("R") || statusCode.startsWith("C")) {
      const oldPath = records[++index] ?? "";
      const newPath = records[++index] ?? "";
      if (!oldPath || !newPath) continue;
      files.push({
        oldPath,
        newPath,
        status: statusCode.startsWith("R") ? "renamed" : "copied",
        isBinary: false,
      });
    } else {
      const filePath = records[++index] ?? "";
      if (!filePath) continue;
      let status: DiffFile["status"] = "modified";
      if (statusCode === "A") {
        status = "added";
      } else if (statusCode === "D") {
        status = "deleted";
      }
      files.push({
        oldPath: filePath,
        newPath: filePath,
        status,
        isBinary: false,
      });
    }
  }
  return files;
}

function parseLogOutput(output: string): CommitNode[] {
  const commits: CommitNode[] = [];
  const records = output.split(RECORD_SEP);

  for (const record of records) {
    const trimmed = record.trim();
    if (!trimmed) {
      continue;
    }
    const fields = trimmed.split(FIELD_SEP);
    if (fields.length < 9) {
      continue;
    }

    const refsStr = fields[8]?.trim() ?? "";
    const refs = parseRefs(refsStr);

    commits.push({
      hash: fields[0] ?? "",
      shortHash: fields[1] ?? "",
      parents: (fields[2] ?? "").split(" ").filter((s) => s.length > 0),
      authorName: fields[3] ?? "",
      authorEmail: fields[4] ?? "",
      authorDate: fields[5] ?? "",
      subject: fields[6] ?? "",
      body: fields[7] ?? "",
      refs,
    });
  }
  return commits;
}

function parseRefs(refsStr: string): RefInfo[] {
  if (!refsStr) {
    return [];
  }
  const refs: RefInfo[] = [];
  const parts = refsStr.split(",").map((s) => s.trim());

  for (const part of parts) {
    if (!part) {
      continue;
    }
    if (part === "HEAD") {
      refs.push({ type: "HEAD", name: "HEAD" });
    } else if (part.startsWith("HEAD -> ")) {
      refs.push({ type: "HEAD", name: "HEAD" });
      refs.push({ type: "branch", name: part.replace("HEAD -> ", "") });
    } else if (part.startsWith("tag: ")) {
      refs.push({ type: "tag", name: part.replace("tag: ", "") });
    } else if (part.includes("/")) {
      // Distinguish remote branches from local branches with slashes (e.g. feat/xxx)
      // Remote branches in %D format are prefixed with remote name (origin/, upstream/, etc.)
      // Common pattern: if first segment before / is a short name (likely a remote), treat as remote
      const firstSlash = part.indexOf("/");
      const prefix = part.substring(0, firstSlash);
      // Heuristic: remote names are typically short (origin, upstream, fork, etc.)
      // Local branch names with / typically start with feat/, fix/, hotfix/, release/, etc.
      const localPrefixes = [
        "feat",
        "fix",
        "hotfix",
        "release",
        "bugfix",
        "feature",
        "chore",
        "docs",
        "refactor",
        "test",
        "ci",
        "build",
        "perf",
        "style",
        "revert",
        "wip",
        "dependabot",
      ];
      if (localPrefixes.includes(prefix.toLowerCase())) {
        refs.push({ type: "branch", name: part });
      } else {
        refs.push({ type: "remote-branch", name: part });
      }
    } else {
      refs.push({ type: "branch", name: part });
    }
  }
  return refs;
}

function parseTrack(track: string): { ahead: number; behind: number } {
  let ahead = 0;
  let behind = 0;
  const aheadMatch = track.match(/ahead (\d+)/);
  if (aheadMatch) {
    ahead = parseInt(aheadMatch[1], 10);
  }
  const behindMatch = track.match(/behind (\d+)/);
  if (behindMatch) {
    behind = parseInt(behindMatch[1], 10);
  }
  return { ahead, behind };
}
