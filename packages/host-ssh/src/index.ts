import { spawn as ptySpawn, type IPty } from "node-pty";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  newId,
  type ExecResult,
  type SavedSession,
  type TargetRef,
} from "@drift/core";

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  if (!env.PATH) {
    env.PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  }
  if (!env.TERM) env.TERM = "xterm-256color";
  if (!env.HOME) env.HOME = os.homedir();
  return env;
}

export interface SshPtyBackend {
  readonly id: string;
  readonly session: SavedSession;
  readonly target: TargetRef;
  onData(cb: (chunk: string) => void): () => void;
  onExit(cb: (info: { exitCode: number; signal?: number }) => void): () => void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  exec(
    command: string,
    opts?: { cwd?: string; timeoutMs?: number }
  ): Promise<ExecResult>;
  getCwd(): Promise<string>;
  setCwd(cwd: string): void;
  dispose(): Promise<void>;
}

/** Shared control socket so password/key auth from the live PTY is reused by exec. */
export function sshControlPath(session: SavedSession): string {
  const dir = path.join(os.homedir(), ".ssh", "drift");
  mkdirSync(dir, { recursive: true });
  // %C = hash(local, host, port, user) — keeps the path short for sockaddr limits.
  return path.join(dir, "cm-%C");
}

export function buildSshArgs(
  session: SavedSession,
  opts?: { tty?: boolean; batch?: boolean }
): string[] {
  const args: string[] = [];
  if (opts?.tty !== false) args.push("-tt");
  if (session.port) args.push("-p", String(session.port));
  if (session.identityFile) args.push("-i", expandHome(session.identityFile));
  if (session.proxyJump) args.push("-J", session.proxyJump);
  args.push("-o", "StrictHostKeyChecking=accept-new");
  args.push("-o", "ControlMaster=auto");
  args.push("-o", `ControlPath=${sshControlPath(session)}`);
  args.push("-o", "ControlPersist=600");
  if (opts?.batch) args.push("-o", "BatchMode=yes");
  args.push(`${session.user}@${session.host}`);
  return args;
}

function expandHome(p: string): string {
  if (p === "~") return process.env.HOME || os.homedir();
  if (p.startsWith("~/")) {
    return `${process.env.HOME || os.homedir()}${p.slice(1)}`;
  }
  return p;
}

function sshBinary(): string {
  return process.platform === "win32" ? "ssh" : "/usr/bin/ssh";
}

/** Remote command that keeps an interactive shell and emits OSC 7 on each prompt. */
export function buildRemoteShellCommand(startDir?: string): string {
  const cd = startDir ? `cd ${shellQuote(startDir)} 2>/dev/null || true; ` : "";
  return (
    cd +
    `shell=\${SHELL:-/bin/bash}; base=\${shell##*/}; ` +
    `if [ "\$base" = zsh ]; then ` +
    `exec "\$shell" -i -c "pwd_report(){ printf '\\033]7;file://%s%s\\033\\\\' \\"\\\${HOST:-localhost}\\" \\"\\\$PWD\\"; }; precmd_functions+=(pwd_report); [[ -f ~/.zshrc ]] && source ~/.zshrc; exec zsh -i"; ` +
    `else ` +
    `export PROMPT_COMMAND='printf \"\\033]7;file://%s%s\\033\\\\\" \"\${HOSTNAME:-\${HOST:-localhost}}\" \"\$PWD\"'; ` +
    `exec "\$shell" -i; ` +
    `fi`
  );
}

export function createSshPty(
  session: SavedSession,
  opts?: { cols?: number; rows?: number }
): SshPtyBackend {
  const id = newId();
  const args = buildSshArgs(session, { tty: true });
  args.push(buildRemoteShellCommand(session.startDir));

  const pty: IPty = ptySpawn(sshBinary(), args, {
    name: "xterm-256color",
    cols: opts?.cols ?? 120,
    rows: opts?.rows ?? 30,
    cwd: process.env.HOME || os.homedir(),
    env: cleanEnv(),
  });

  let disposed = false;
  let cwdGuess = session.startDir || "~";
  const listeners = new Set<(chunk: string) => void>();
  const exitListeners = new Set<(info: { exitCode: number; signal?: number }) => void>();

  pty.onData((data) => {
    for (const cb of listeners) cb(data);
  });
  pty.onExit(({ exitCode, signal }) => {
    for (const cb of exitListeners) {
      cb({ exitCode, signal: signal ?? undefined });
    }
  });

  return {
    id,
    session,
    get target(): TargetRef {
      return {
        kind: "ssh",
        sessionId: session.id,
        hostLabel: session.name || `${session.user}@${session.host}`,
        cwd: cwdGuess,
      };
    },
    onData(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onExit(cb) {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
    write(data) {
      if (!disposed) pty.write(data);
    },
    resize(cols, rows) {
      if (!disposed) pty.resize(cols, rows);
    },
    async exec(command, execOpts) {
      return runSshExec(
        session,
        command,
        execOpts?.cwd ?? cwdGuess,
        execOpts?.timeoutMs
      );
    },
    async getCwd() {
      return cwdGuess;
    },
    setCwd(cwd: string) {
      if (cwd.trim()) cwdGuess = cwd.trim();
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      exitListeners.clear();
      try {
        pty.kill();
      } catch {
        /* ignore */
      }
    },
  };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\"'\"'`)}'`;
}

function scpBinary(): string {
  return process.platform === "win32" ? "scp" : "/usr/bin/scp";
}

/** Shared options with the interactive tab's ControlMaster (no remote argv). */
export function buildScpArgs(session: SavedSession): string[] {
  const args: string[] = ["-r"];
  if (session.port) args.push("-P", String(session.port));
  if (session.identityFile) args.push("-i", expandHome(session.identityFile));
  if (session.proxyJump) args.push("-o", `ProxyJump=${session.proxyJump}`);
  args.push("-o", "StrictHostKeyChecking=accept-new");
  args.push("-o", "ControlMaster=auto");
  args.push("-o", `ControlPath=${sshControlPath(session)}`);
  args.push("-o", "ControlPersist=600");
  args.push("-o", "BatchMode=yes");
  return args;
}

export type UploadProgress = {
  transferred: number;
  total: number;
  percent: number;
  currentName?: string;
};

function rsyncBinary(): string {
  if (process.platform === "win32") return "rsync";
  // Prefer Homebrew/Samba rsync (supports --info=progress2). macOS
  // /usr/bin/rsync is openrsync and only has classic --progress.
  for (const candidate of [
    "/opt/homebrew/bin/rsync",
    "/usr/local/bin/rsync",
    "/usr/bin/rsync",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return "rsync";
}

let progress2Support: boolean | null = null;

function rsyncSupportsProgress2(bin: string): boolean {
  if (progress2Support != null) return progress2Support;
  const probe = spawnSync(bin, ["--info=progress2"], {
    encoding: "utf8",
    timeout: 3000,
  });
  const err = `${probe.stderr || ""}${probe.stdout || ""}${probe.error?.message || ""}`;
  progress2Support = !/unrecognized option|--info/i.test(err);
  return progress2Support;
}

/** ssh command string for `rsync -e` (reuses the tab ControlMaster). */
function buildRsyncShell(session: SavedSession): string {
  const parts: string[] = [sshBinary()];
  if (session.port) parts.push("-p", String(session.port));
  if (session.identityFile) parts.push("-i", expandHome(session.identityFile));
  if (session.proxyJump) parts.push("-o", `ProxyJump=${session.proxyJump}`);
  parts.push("-o", "StrictHostKeyChecking=accept-new");
  parts.push("-o", "ControlMaster=auto");
  parts.push("-o", `ControlPath=${sshControlPath(session)}`);
  parts.push("-o", "ControlPersist=600");
  parts.push("-o", "BatchMode=yes");
  return parts.map((p) => (/\s/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p)).join(" ");
}

/** Samba rsync --info=progress2: first number is cumulative bytes. */
function parseProgress2(
  chunk: string
): { transferred: number; percent: number } | null {
  const text = chunk.replace(/\r/g, "\n");
  let best: { transferred: number; percent: number } | null = null;
  for (const line of text.split("\n")) {
    const m = line.match(/([\d,]+)\s+(\d+)%/);
    if (!m) continue;
    best = {
      transferred: Number(m[1].replace(/,/g, "")),
      percent: Math.min(100, Number(m[2])),
    };
  }
  return best;
}

type ClassicProgressState = {
  completedBytes: number;
  currentFileStart: number;
  currentName?: string;
};

/**
 * openrsync/classic `--progress`: per-file byte counts + optional filename
 * lines. We accumulate finished files so overall % keeps rising.
 */
function applyClassicProgress(
  state: ClassicProgressState,
  chunk: string,
  total: number
): UploadProgress | null {
  const text = chunk.replace(/\r/g, "\n");
  let latest: UploadProgress | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    const prog = line.match(/^([\d,]+)\s+(\d+)%/);
    if (prog) {
      const fileBytes = Number(prog[1].replace(/,/g, ""));
      const filePct = Math.min(100, Number(prog[2]));
      const transferred = Math.min(
        total || Number.POSITIVE_INFINITY,
        state.currentFileStart + fileBytes
      );
      const percent =
        total > 0
          ? Math.min(99, Math.round((transferred / total) * 100))
          : filePct;
      latest = {
        transferred: Number.isFinite(transferred) ? transferred : fileBytes,
        total: total || fileBytes || 1,
        percent,
        currentName: state.currentName,
      };
      if (filePct >= 100 || /\(xfer#\d+/i.test(line)) {
        state.completedBytes = Math.max(
          state.completedBytes,
          state.currentFileStart + fileBytes
        );
        state.currentFileStart = state.completedBytes;
      }
      continue;
    }

    // Filename lines look like "foo.bin" (not stats / errors).
    if (
      !line.includes("%") &&
      !line.startsWith("rsync:") &&
      !line.startsWith("building") &&
      !line.startsWith("sent ") &&
      !line.startsWith("total ") &&
      !/^opening /i.test(line)
    ) {
      state.currentName = path.basename(line.replace(/\/$/, ""));
      state.currentFileStart = state.completedBytes;
    }
  }
  return latest;
}

async function totalLocalBytes(paths: string[]): Promise<number> {
  let total = 0;
  async function walk(p: string): Promise<void> {
    let st;
    try {
      st = await stat(p);
    } catch {
      return;
    }
    if (st.isFile()) {
      total += st.size;
      return;
    }
    if (!st.isDirectory()) return;
    let entries;
    try {
      entries = await readdir(p);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "." || name === "..") continue;
      await walk(path.join(p, name));
    }
  }
  for (const p of paths) await walk(p);
  return total;
}

/** Copy local paths into a remote directory over the live ControlMaster. */
export async function uploadFilesViaScp(
  session: SavedSession,
  localPaths: string[],
  remoteDir: string,
  opts?: {
    timeoutMs?: number;
    onProgress?: (p: UploadProgress) => void;
  }
): Promise<{ ok: true } | { error: string }> {
  const cleaned = localPaths.map((p) => p.trim()).filter(Boolean);
  if (!cleaned.length) return { error: "No files" };
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  const onProgress = opts?.onProgress;
  const remote = remoteDir.trim() || "~";
  const dest = `${session.user}@${session.host}:${remote.replace(/\/?$/, "/")}`;
  const total = await totalLocalBytes(cleaned);
  onProgress?.({
    transferred: 0,
    total,
    percent: 0,
    currentName: path.basename(cleaned[0] || ""),
  });

  const tryRsync = (
    progressMode: "progress2" | "classic"
  ): Promise<{ ok: true } | { error: string } | "missing" | "unsupported"> =>
    new Promise((resolve) => {
      const args = [
        "-a",
        ...(progressMode === "progress2"
          ? ["--info=progress2"]
          : ["--progress"]),
        "-e",
        buildRsyncShell(session),
        ...cleaned,
        dest,
      ];
      const child = spawn(rsyncBinary(), args, { env: process.env });
      let stderr = "";
      let settled = false;
      const classicState: ClassicProgressState = {
        completedBytes: 0,
        currentFileStart: 0,
        currentName: path.basename(cleaned[0] || ""),
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        resolve({ error: "Upload timed out" });
      }, timeoutMs);
      const onChunk = (d: Buffer) => {
        const text = d.toString("utf8");
        stderr += text;
        if (!onProgress) return;
        if (progressMode === "progress2") {
          const parsed = parseProgress2(text);
          if (!parsed) return;
          const transferred = parsed.transferred;
          const percent =
            total > 0
              ? Math.min(99, Math.round((transferred / total) * 100))
              : parsed.percent;
          onProgress({
            transferred:
              total > 0 ? Math.min(transferred, total) : transferred,
            total: total || transferred || 1,
            percent,
            currentName: classicState.currentName,
          });
          return;
        }
        const latest = applyClassicProgress(classicState, text, total);
        if (latest) onProgress(latest);
      };
      child.stdout.on("data", onChunk);
      child.stderr.on("data", onChunk);
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if ((err as NodeJS.ErrnoException).code === "ENOENT") resolve("missing");
        else resolve({ error: err.message });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          onProgress?.({
            transferred: total,
            total: total || 1,
            percent: 100,
          });
          resolve({ ok: true });
          return;
        }
        const errText = (stderr || `rsync exit ${code}`).trim();
        // macOS ships openrsync (2.6.9-compatible) without --info=progress2.
        if (
          progressMode === "progress2" &&
          /unrecognized option|--info/i.test(errText)
        ) {
          resolve("unsupported");
          return;
        }
        resolve({ error: errText.slice(0, 400) });
      });
    });

  const bin = rsyncBinary();
  const preferClassic = !rsyncSupportsProgress2(bin);
  let rsyncResult = await tryRsync(preferClassic ? "classic" : "progress2");
  if (rsyncResult === "unsupported") {
    rsyncResult = await tryRsync("classic");
  }
  if (rsyncResult !== "missing" && rsyncResult !== "unsupported") {
    return rsyncResult;
  }

  // Fallback: one scp -r per top-level path, progress by completed size.
  let doneBytes = 0;
  for (const src of cleaned) {
    let size = 0;
    try {
      size = await totalLocalBytes([src]);
    } catch {
      size = 0;
    }
    onProgress?.({
      transferred: doneBytes,
      total: total || 1,
      percent:
        total > 0 ? Math.min(99, Math.round((doneBytes / total) * 100)) : 0,
      currentName: path.basename(src),
    });
    const args = [...buildScpArgs(session), src, dest];
    const one = await new Promise<{ ok: true } | { error: string }>((resolve) => {
      const child = spawn(scpBinary(), args, { env: process.env });
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        resolve({ error: "Upload timed out" });
      }, timeoutMs);
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ error: err.message });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve({ ok: true });
        else
          resolve({
            error: (stderr || `scp exit ${code}`).trim().slice(0, 400),
          });
      });
    });
    if ("error" in one) return one;
    doneBytes += size;
    onProgress?.({
      transferred: Math.min(doneBytes, total || doneBytes),
      total: total || doneBytes || 1,
      percent:
        total > 0
          ? Math.min(100, Math.round((doneBytes / total) * 100))
          : 100,
      currentName: path.basename(src),
    });
  }
  return { ok: true };
}

/** Pull remote paths into a local directory over the live ControlMaster. */
export async function downloadFilesViaScp(
  session: SavedSession,
  remotePaths: string[],
  localDir: string,
  opts?: {
    timeoutMs?: number;
    onProgress?: (p: UploadProgress) => void;
  }
): Promise<{ ok: true } | { error: string }> {
  const cleaned = remotePaths.map((p) => p.trim()).filter(Boolean);
  if (!cleaned.length) return { error: "No files" };
  const destDir = localDir.trim();
  if (!destDir) return { error: "No destination" };
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  const onProgress = opts?.onProgress;
  const remotes = cleaned.map(
    (p) => `${session.user}@${session.host}:${p}`
  );
  const dest = destDir.replace(/\/?$/, "/");
  onProgress?.({
    transferred: 0,
    total: cleaned.length,
    percent: 0,
    currentName: path.basename(cleaned[0] || ""),
  });

  const tryRsync = (
    progressMode: "progress2" | "classic"
  ): Promise<{ ok: true } | { error: string } | "missing" | "unsupported"> =>
    new Promise((resolve) => {
      const args = [
        "-a",
        ...(progressMode === "progress2"
          ? ["--info=progress2"]
          : ["--progress"]),
        "-e",
        buildRsyncShell(session),
        ...remotes,
        dest,
      ];
      const child = spawn(rsyncBinary(), args, { env: process.env });
      let stderr = "";
      let settled = false;
      const classicState: ClassicProgressState = {
        completedBytes: 0,
        currentFileStart: 0,
        currentName: path.basename(cleaned[0] || ""),
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        resolve({ error: "Download timed out" });
      }, timeoutMs);
      const onChunk = (d: Buffer) => {
        const text = d.toString("utf8");
        stderr += text;
        if (!onProgress) return;
        if (progressMode === "progress2") {
          const parsed = parseProgress2(text);
          if (!parsed) return;
          onProgress({
            transferred: parsed.transferred,
            total: Math.max(parsed.transferred, 1),
            percent: Math.min(99, parsed.percent),
            currentName: classicState.currentName,
          });
          return;
        }
        const latest = applyClassicProgress(classicState, text, 0);
        if (latest) onProgress(latest);
      };
      child.stdout.on("data", onChunk);
      child.stderr.on("data", onChunk);
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if ((err as NodeJS.ErrnoException).code === "ENOENT") resolve("missing");
        else resolve({ error: err.message });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          onProgress?.({
            transferred: cleaned.length,
            total: cleaned.length,
            percent: 100,
          });
          resolve({ ok: true });
          return;
        }
        const errText = (stderr || `rsync exit ${code}`).trim();
        if (
          progressMode === "progress2" &&
          /unrecognized option|--info/i.test(errText)
        ) {
          resolve("unsupported");
          return;
        }
        resolve({ error: errText.slice(0, 400) });
      });
    });

  const bin = rsyncBinary();
  const preferClassic = !rsyncSupportsProgress2(bin);
  let rsyncResult = await tryRsync(preferClassic ? "classic" : "progress2");
  if (rsyncResult === "unsupported") {
    rsyncResult = await tryRsync("classic");
  }
  if (rsyncResult !== "missing" && rsyncResult !== "unsupported") {
    return rsyncResult;
  }

  let done = 0;
  for (const remote of remotes) {
    const name = path.basename(cleaned[done] || remote);
    onProgress?.({
      transferred: done,
      total: cleaned.length,
      percent:
        cleaned.length > 0
          ? Math.min(99, Math.round((done / cleaned.length) * 100))
          : 0,
      currentName: name,
    });
    const args = [...buildScpArgs(session), remote, dest];
    const one = await new Promise<{ ok: true } | { error: string }>((resolve) => {
      const child = spawn(scpBinary(), args, { env: process.env });
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        resolve({ error: "Download timed out" });
      }, timeoutMs);
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ error: err.message });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve({ ok: true });
        else
          resolve({
            error: (stderr || `scp exit ${code}`).trim().slice(0, 400),
          });
      });
    });
    if ("error" in one) return one;
    done += 1;
    onProgress?.({
      transferred: done,
      total: cleaned.length,
      percent:
        cleaned.length > 0
          ? Math.min(100, Math.round((done / cleaned.length) * 100))
          : 100,
      currentName: name,
    });
  }
  return { ok: true };
}

function runSshExec(
  session: SavedSession,
  command: string,
  cwd: string,
  timeoutMs = 60_000
): Promise<ExecResult> {
  const remote = `cd ${shellQuote(cwd)} 2>/dev/null; ${command}`;
  // Slave connection: reuse ControlMaster from the interactive tab (no TTY, fail fast).
  const base = buildSshArgs(
    { ...session, startDir: undefined },
    { tty: false, batch: true }
  );
  base.push(remote);

  return new Promise((resolve) => {
    const child = spawn(sshBinary(), base, {
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ stdout, stderr, exitCode: null, timedOut: true });
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}
