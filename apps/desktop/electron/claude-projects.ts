/**
 * Claude project / worktree discovery and git helpers for the Sessions rail.
 * Sources: ~/.claude.json projects + optional board Claude cwds.
 */
import { execFile } from "node:child_process";
import {
  existsSync,
  openSync,
  readSync,
  closeSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

export type ClaudeProjectFolder = {
  path: string;
  branch?: string;
  /** Parent repo path when this folder is a linked worktree. */
  worktreeOf?: string;
  changes?: number;
  ahead?: number;
  behind?: number;
  trusted?: boolean;
};

export type ClaudeTranscriptSession = {
  id: string;
  cwd: string;
  title: string;
  at: number;
};

const SESSION_LIMIT = 150;
const HEAD_BYTES = 256 * 1024;

function claudeJsonPath(): string {
  return path.join(os.homedir(), ".claude.json");
}

function claudeProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

function normPath(p: string): string {
  return path.resolve(p).toLowerCase();
}

function git(
  cwd: string,
  args: string[]
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, out) => {
        resolve(err ? null : String(out ?? ""));
      }
    );
  });
}

function parsePorcelainWorktrees(
  out: string,
  rootPath: string
): Array<{ path: string; branch: string; worktreeOf?: string }> {
  const results: Array<{ path: string; branch: string; worktreeOf?: string }> =
    [];
  for (const block of out.split(/\r?\n\r?\n/)) {
    const wt = block.match(/^worktree (.+)$/m)?.[1];
    if (!wt) continue;
    const branch =
      block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? "(detached)";
    const resolved = path.resolve(wt);
    const isRoot = normPath(resolved) === normPath(rootPath);
    results.push({
      path: resolved,
      branch,
      worktreeOf: isRoot ? undefined : rootPath,
    });
  }
  return results;
}

async function attachGitMeta(folder: ClaudeProjectFolder): Promise<void> {
  const out = await git(folder.path, [
    "status",
    "--porcelain=v2",
    "--branch",
  ]);
  if (out == null) return;
  const ab = out.match(/^# branch\.ab \+(\d+) -(\d+)$/m);
  folder.changes = out
    .split("\n")
    .filter((l) => l && !l.startsWith("#")).length;
  if (ab) {
    folder.ahead = Number(ab[1]);
    folder.behind = Number(ab[2]);
  }
  const head = out.match(/^# branch\.head (.+)$/m)?.[1];
  if (head && head !== "(detached)" && !folder.branch) {
    folder.branch = head;
  } else if (head === "(detached)") {
    folder.branch = folder.branch ?? "(detached)";
  }
}

function readClaudeJsonProjects(): Array<{
  path: string;
  trusted: boolean;
  lastStartTime: number;
}> {
  try {
    const raw = JSON.parse(readFileSync(claudeJsonPath(), "utf8")) as {
      projects?: Record<
        string,
        { hasTrustDialogAccepted?: boolean; lastStartTime?: number }
      >;
    };
    const projects = raw.projects || {};
    return Object.entries(projects)
      .filter(([p]) => existsSync(p))
      .map(([p, v]) => ({
        path: path.resolve(p),
        trusted: !!v.hasTrustDialogAccepted,
        lastStartTime: v.lastStartTime || 0,
      }))
      .sort((a, b) => b.lastStartTime - a.lastStartTime);
  } catch {
    return [];
  }
}

/** Resolve the main worktree / repo root for a path (or null if not git). */
export async function resolveGitRoot(
  cwd: string
): Promise<string | null> {
  const out = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!out) return null;
  const root = out.trim();
  return root && existsSync(root) ? path.resolve(root) : null;
}

export function worktreeTargetDir(repo: string, branch: string): string {
  const safe = branch.replace(/[\\/]/g, "-");
  return path.join(
    path.dirname(repo),
    `${path.basename(repo)}.worktrees`,
    safe
  );
}

/**
 * List Claude-known folders + extra board cwds, expanded with worktrees.
 */
export async function listClaudeProjectFolders(
  extraCwds: string[] = []
): Promise<ClaudeProjectFolder[]> {
  const fromJson = readClaudeJsonProjects();
  const seen = new Map<string, ClaudeProjectFolder>();

  for (const e of fromJson) {
    seen.set(normPath(e.path), {
      path: e.path,
      trusted: e.trusted,
    });
  }

  for (const raw of extraCwds) {
    if (!raw || typeof raw !== "string") continue;
    const p = path.resolve(raw);
    if (!existsSync(p)) continue;
    const key = normPath(p);
    if (!seen.has(key)) {
      seen.set(key, { path: p });
    }
  }

  // For every path that is (or is inside) a git repo, expand worktrees from the root.
  const roots = new Set<string>();
  for (const folder of [...seen.values()]) {
    const root = await resolveGitRoot(folder.path);
    if (root) roots.add(normPath(root));
  }

  // Re-key by resolved root path string
  const rootPaths: string[] = [];
  for (const folder of [...seen.values()]) {
    const root = await resolveGitRoot(folder.path);
    if (root && !rootPaths.some((r) => normPath(r) === normPath(root))) {
      rootPaths.push(root);
    }
  }

  for (const root of rootPaths) {
    const out = await git(root, ["worktree", "list", "--porcelain"]);
    if (!out) {
      // Still keep the folder even if worktree list fails
      const key = normPath(root);
      if (!seen.has(key)) seen.set(key, { path: root });
      continue;
    }
    for (const wt of parsePorcelainWorktrees(out, root)) {
      const key = normPath(wt.path);
      const existing = seen.get(key);
      if (existing) {
        existing.branch = wt.branch;
        if (wt.worktreeOf) existing.worktreeOf = wt.worktreeOf;
      } else {
        seen.set(key, {
          path: wt.path,
          branch: wt.branch,
          worktreeOf: wt.worktreeOf,
        });
      }
    }
    // Ensure root entry has branch from HEAD if missing
    const rootEntry = seen.get(normPath(root));
    if (rootEntry && !rootEntry.branch) {
      const head = await git(root, ["branch", "--show-current"]);
      if (head?.trim()) rootEntry.branch = head.trim();
    }
  }

  const all = [...seen.values()];
  await Promise.all(all.map((f) => attachGitMeta(f)));
  return all;
}

export async function listLocalBranches(
  repo: string
): Promise<{ branches: string[]; current: string | null }> {
  const root = (await resolveGitRoot(repo)) || repo;
  const out = await git(root, [
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname:short)%09%(HEAD)",
    "refs/heads",
  ]);
  if (out == null) return { branches: [], current: null };
  const branches: string[] = [];
  let current: string | null = null;
  for (const line of out.split("\n")) {
    const [name, head] = line.split("\t");
    if (!name?.trim()) continue;
    branches.push(name.trim());
    if (head?.trim() === "*") current = name.trim();
  }
  if (!current) {
    const show = await git(root, ["branch", "--show-current"]);
    current = show?.trim() || null;
  }
  return { branches, current };
}

export function previewWorktreePath(
  repo: string,
  branch: string
): { path: string } | { error: string } {
  const b = String(branch || "").trim();
  if (!b) return { error: "Branch name is required" };
  if (b.startsWith("-")) {
    return { error: `Invalid branch name: ${b}` };
  }
  const dir = worktreeTargetDir(repo, b);
  return { path: dir };
}

export async function addWorktree(
  repo: string,
  branch: string,
  baseRef?: string
): Promise<{ path: string } | { error: string }> {
  const b = String(branch || "").trim();
  if (!b) return { error: "Branch name is required" };
  if (b.startsWith("-")) {
    return { error: `Invalid branch name: ${b}` };
  }
  const root = (await resolveGitRoot(repo)) || path.resolve(repo);
  const check = await git(root, ["check-ref-format", "--branch", b]);
  if (check == null) {
    return { error: `Invalid branch name: ${b}` };
  }
  const dir = worktreeTargetDir(root, b);
  if (existsSync(dir)) {
    return { error: `Folder already exists: ${dir}` };
  }
  const exists =
    (await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`])) !=
    null;
  const base = (baseRef || "HEAD").trim() || "HEAD";

  return new Promise((resolve) => {
    const args = exists
      ? ["worktree", "add", dir, b]
      : ["worktree", "add", "-b", b, dir, base];
    execFile(
      "git",
      ["-C", root, ...args],
      { windowsHide: true },
      (err, _out, stderr) => {
        if (err) {
          resolve({
            error: String(stderr || err.message || "worktree add failed").trim(),
          });
          return;
        }
        resolve({ path: dir });
      }
    );
  });
}

export async function removeWorktree(
  worktreePath: string
): Promise<{ ok: true } | { error: string }> {
  const wt = path.resolve(worktreePath);
  if (!existsSync(wt)) {
    return { error: `Path not found: ${wt}` };
  }
  const root = await resolveGitRoot(wt);
  if (!root) return { error: "Not a git worktree" };
  if (normPath(root) === normPath(wt)) {
    return { error: "Cannot remove the main worktree" };
  }
  const dirty = await git(wt, ["status", "--porcelain"]);
  if (dirty == null) {
    return { error: "Could not read worktree status" };
  }
  if (dirty.trim()) {
    return {
      error:
        "Worktree has uncommitted changes. Commit or stash them first, then remove.",
    };
  }
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", root, "worktree", "remove", wt],
      { windowsHide: true },
      (err, _out, stderr) => {
        if (err) {
          resolve({
            error: String(
              stderr || err.message || "worktree remove failed"
            ).trim(),
          });
          return;
        }
        resolve({ ok: true });
      }
    );
  });
}

function headLines(file: string, bytes = HEAD_BYTES): string[] {
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    const buf = Buffer.alloc(Math.min(bytes, size));
    readSync(fd, buf, 0, buf.length, 0);
    return buf.toString("utf8").split("\n").slice(0, -1);
  } finally {
    closeSync(fd);
  }
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function realPrompt(t: unknown): string | null {
  if (typeof t !== "string") return null;
  const s = t.trim();
  if (!s || s.startsWith("<")) return null;
  return s.replace(/\s+/g, " ").slice(0, 120);
}

function newestTranscriptFiles(
  root: string,
  match: (name: string) => boolean,
  depth: number
): Array<{ p: string; at: number }> {
  const out: Array<{ p: string; at: number }> = [];
  const walk = (dir: string, d: number) => {
    let ents: import("node:fs").Dirent[] = [];
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const name = String(ent.name);
      const p = path.join(dir, name);
      if (ent.isDirectory() && d > 0) walk(p, d - 1);
      else if (ent.isFile() && match(name)) {
        try {
          out.push({ p, at: statSync(p).mtimeMs });
        } catch {
          /* skip */
        }
      }
    }
  };
  walk(root, depth);
  return out.sort((a, b) => b.at - a.at).slice(0, SESSION_LIMIT);
}

export function listClaudeTranscripts(): ClaudeTranscriptSession[] {
  const root = claudeProjectsDir();
  if (!existsSync(root)) return [];
  return newestTranscriptFiles(
    root,
    (n) => /^[0-9a-f-]{36}\.jsonl$/i.test(n),
    1
  )
    .map(({ p, at }) => {
      let cwd = "";
      let title: string | null = null;
      for (const j of headLines(p).map(parseJsonLine)) {
        if (!j) continue;
        if (!cwd && typeof j.cwd === "string") cwd = j.cwd;
        if (!title && j.type === "user" && !j.isMeta) {
          const message = j.message as
            | { content?: unknown }
            | undefined;
          const c = message?.content;
          if (typeof c === "string") title = realPrompt(c);
          else if (Array.isArray(c)) {
            const textPart = c.find(
              (x): x is { type: string; text?: string } =>
                !!x &&
                typeof x === "object" &&
                (x as { type?: string }).type === "text"
            );
            title = realPrompt(textPart?.text);
          }
        }
        if (cwd && title) break;
      }
      if (!title) return null;
      return {
        id: path.basename(p, ".jsonl"),
        cwd,
        title,
        at,
      };
    })
    .filter((s): s is ClaudeTranscriptSession => !!s);
}

/** Locate ~/.claude/projects/<project>/<sessionId>.jsonl. */
export function findClaudeTranscriptPath(sessionId: string): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  const root = claudeProjectsDir();
  if (!existsSync(root)) return null;
  try {
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const p = path.join(root, String(dir.name), `${sessionId}.jsonl`);
      if (existsSync(p)) return p;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Delete a Claude Code transcript from disk. Irreversible.
 * Refuses invalid ids; returns not_found when the file is already gone.
 */
export function deleteClaudeTranscript(
  sessionId: string
): { ok: true; path: string } | { error: string } {
  const id = String(sessionId || "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return { error: "Invalid session id" };
  }
  const file = findClaudeTranscriptPath(id);
  if (!file) return { error: "Transcript not found" };
  try {
    unlinkSync(file);
    return { ok: true, path: file };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
