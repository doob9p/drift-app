import { spawn as ptySpawn, type IPty } from "node-pty";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  newId,
  type ExecResult,
  type SavedSession,
  type TargetRef,
} from "@drift/core";

/** Directory with portable Win32-OpenSSH binaries (set by the desktop app). */
let winOpenSshDir: string | null = null;

/** Tell host-ssh where bundled Windows OpenSSH lives (`…/win-openssh`). */
export function setWinOpenSshDir(dir: string | null): void {
  winOpenSshDir = dir && dir.trim() ? dir : null;
  sshPathCache = undefined;
  scpPathCache = undefined;
}

function homeDir(): string {
  if (process.platform === "win32") {
    return process.env.USERPROFILE || process.env.HOME || os.homedir();
  }
  return process.env.HOME || os.homedir();
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  if (process.platform === "win32") {
    const sysRoot = process.env.SystemRoot || "C:\\Windows";
    const pathKey =
      Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "Path";
    const current = env[pathKey] || env.PATH || env.Path || "";
    const extras = [
      winOpenSshDir,
      path.join(sysRoot, "System32", "OpenSSH"),
      path.join(sysRoot, "System32"),
    ].filter((p): p is string => Boolean(p));
    const parts = [
      ...extras,
      ...current.split(";").map((p) => p.trim()).filter(Boolean),
    ];
    env[pathKey] = [...new Set(parts)].join(";");
    if (!env.HOME) env.HOME = homeDir();
    if (!env.USERPROFILE) env.USERPROFILE = homeDir();
  } else if (!env.PATH) {
    env.PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  }
  if (!env.TERM) env.TERM = "xterm-256color";
  if (!env.HOME) env.HOME = homeDir();
  return env;
}

type AskpassHandle = {
  env: Record<string, string>;
  cleanup: () => void;
};

/** Temporary SSH_ASKPASS helper that prints a one-time password. */
function createAskpassHandle(password: string): AskpassHandle {
  const dir = mkdtempSync(path.join(os.tmpdir(), "drift-askpass-"));
  const pwFile = path.join(dir, "pw");
  writeFileSync(pwFile, password, { encoding: "utf8", mode: 0o600 });
  let script: string;
  if (process.platform === "win32") {
    script = path.join(dir, "askpass.cmd");
    writeFileSync(
      script,
      `@echo off\r\ntype "${pwFile.replace(/"/g, "")}"\r\n`,
      "utf8"
    );
  } else {
    script = path.join(dir, "askpass.sh");
    writeFileSync(script, `#!/bin/sh\nexec cat ${JSON.stringify(pwFile)}\n`, {
      encoding: "utf8",
      mode: 0o700,
    });
    try {
      chmodSync(script, 0o700);
    } catch {
      /* ignore */
    }
  }
  return {
    env: {
      SSH_ASKPASS: script,
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: process.env.DISPLAY || ":0",
    },
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

function systemOpenSshDir(): string | null {
  if (process.platform !== "win32") return null;
  const sysRoot = process.env.SystemRoot || "C:\\Windows";
  const dir = path.join(sysRoot, "System32", "OpenSSH");
  return existsSync(path.join(dir, "ssh.exe")) ? dir : null;
}

function whichOnPath(exe: string): string | null {
  if (process.platform !== "win32") {
    const probe = spawnSync("which", [exe], { encoding: "utf8" });
    const line = (probe.stdout || "").trim().split("\n")[0];
    return line && existsSync(line) ? line : null;
  }
  const probe = spawnSync("where.exe", [exe], {
    encoding: "utf8",
    env: cleanEnv(),
    windowsHide: true,
  });
  const line = (probe.stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0 && existsSync(s));
  return line || null;
}

let sshPathCache: string | undefined;
let scpPathCache: string | undefined;

function resolveWinClient(kind: "ssh" | "scp"): string {
  const cached = kind === "ssh" ? sshPathCache : scpPathCache;
  if (cached) return cached;

  const exe = `${kind}.exe`;
  const candidates: string[] = [];

  const systemDir = systemOpenSshDir();
  if (systemDir) candidates.push(path.join(systemDir, exe));

  if (winOpenSshDir) candidates.push(path.join(winOpenSshDir, exe));

  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  if (typeof resourcesPath === "string") {
    candidates.push(path.join(resourcesPath, "win-openssh", exe));
  }

  let resolved: string | undefined;
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      resolved = candidate;
      break;
    }
  }
  if (!resolved) {
    resolved = whichOnPath(exe) || whichOnPath(kind) || exe;
  }

  if (kind === "ssh") sshPathCache = resolved;
  else scpPathCache = resolved;
  return resolved;
}

export interface SshPtyBackend {
  readonly id: string;
  readonly session: SavedSession;
  readonly target: TargetRef;
  /**
   * Saved password kept for the tab lifetime. On Windows (no ControlMaster)
   * exec/scp open a fresh SSH and need this via SSH_ASKPASS.
   */
  readonly authPassword?: string;
  onData(cb: (chunk: string) => void): () => void;
  onExit(cb: (info: { exitCode: number; signal?: number }) => void): () => void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  exec(
    command: string,
    opts?: {
      cwd?: string;
      timeoutMs?: number;
      stdin?: string | Buffer;
      onChunk?: (chunk: string) => void;
      abortSignal?: AbortSignal;
      onStdin?: (write: (data: string) => void) => void;
    }
  ): Promise<ExecResult>;
  getCwd(): Promise<string>;
  setCwd(cwd: string): void;
  dispose(): Promise<void>;
}

/**
 * Connection multiplexing (ControlMaster) reuses the interactive tab's auth
 * for exec/scp. Windows OpenSSH's mux sockets are unreliable and commonly
 * fail with `getsockname failed: Not a socket`, so keep mux off there.
 */
export function sshMuxSupported(): boolean {
  return process.platform !== "win32";
}

/**
 * Attach SSH_ASKPASS when a password is available.
 *
 * Previously skipped askpass whenever ControlMaster was supported (macOS/Linux).
 * That only works while a live master already exists — flow uploads and one-shot
 * exec often run with no master, then BatchMode fails with
 * `Permission denied (publickey,...,password)`.
 */
function createNonMuxAskpass(password?: string): AskpassHandle | null {
  const pw = password?.trim();
  if (!pw) return null;
  return createAskpassHandle(pw);
}

function pushPasswordAuthOptions(
  args: string[],
  opts?: { allowPublicKey?: boolean }
): void {
  args.push("-o", "NumberOfPasswordPrompts=1");
  args.push(
    "-o",
    opts?.allowPublicKey
      ? "PreferredAuthentications=publickey,password,keyboard-interactive"
      : "PreferredAuthentications=password,keyboard-interactive"
  );
}

/** Drift-private SSH state under ~/.ssh/drift (mux sockets, known_hosts). */
export function sshDriftDir(): string {
  const dir = path.join(homeDir(), ".ssh", "drift");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function toOpenSshPath(p: string): string {
  // OpenSSH on Windows accepts forward slashes more reliably in -o paths.
  return process.platform === "win32" ? p.replace(/\\/g, "/") : p;
}

/** Shared control socket so password/key auth from the live PTY is reused by exec. */
export function sshControlPath(session: SavedSession): string {
  // %C = hash(local, host, port, user) — keeps the path short for sockaddr limits.
  return toOpenSshPath(path.join(sshDriftDir(), "cm-%C"));
}

/** Isolate from other tools' ~/.ssh/known_hosts (stale keys, PuTTY leftovers, etc.). */
export function sshKnownHostsPath(): string {
  return toOpenSshPath(path.join(sshDriftDir(), "known_hosts"));
}

function pushHostKeyOptions(args: string[]): void {
  args.push("-o", "StrictHostKeyChecking=accept-new");
  args.push("-o", `UserKnownHostsFile=${sshKnownHostsPath()}`);
}

function pushMuxOptions(args: string[], session: SavedSession): void {
  if (sshMuxSupported()) {
    args.push("-o", "ControlMaster=auto");
    args.push("-o", `ControlPath=${sshControlPath(session)}`);
    args.push("-o", "ControlPersist=600");
    return;
  }
  // Explicitly disable in case a user ssh_config enables ControlMaster.
  // Windows OpenSSH mux often dies with: getsockname failed: Not a socket
  args.push("-o", "ControlMaster=no");
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
  pushHostKeyOptions(args);
  pushMuxOptions(args, session);
  if (opts?.batch) args.push("-o", "BatchMode=yes");
  args.push(`${session.user}@${session.host}`);
  return args;
}
function expandHome(p: string): string {
  if (p === "~") return homeDir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(homeDir(), p.slice(2));
  }
  return p;
}

function sshBinary(): string {
  if (process.platform === "win32") return resolveWinClient("ssh");
  return "/usr/bin/ssh";
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
  opts?: { cols?: number; rows?: number; password?: string }
): SshPtyBackend {
  const id = newId();
  const args = buildSshArgs(session, { tty: true });
  // Keep any saved password for Windows exec (metrics/files) even when a key
  // is configured. Interactive PTY still prefers the key when present.
  const storedPassword = opts?.password?.trim() || "";
  const ptyPassword =
    !session.identityFile?.trim() && storedPassword ? storedPassword : "";
  if (ptyPassword) {
    // Avoid hanging on host key prompts when automating password login.
    args.push("-o", "NumberOfPasswordPrompts=1");
  }
  args.push(buildRemoteShellCommand(session.startDir));

  const bin = sshBinary();
  const askpass = ptyPassword ? createAskpassHandle(ptyPassword) : null;
  const env = { ...cleanEnv(), ...(askpass?.env ?? {}) };
  let pty: IPty;
  try {
    pty = ptySpawn(bin, args, {
      name: "xterm-256color",
      cols: opts?.cols ?? 120,
      rows: opts?.rows ?? 30,
      cwd: homeDir(),
      env,
    });
  } catch (err) {
    askpass?.cleanup();
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not start SSH client (${bin}): ${detail}` +
        (process.platform === "win32"
          ? ". Reinstall Drift so the bundled OpenSSH client is present."
          : "")
    );
  }

  let disposed = false;
  let cwdGuess = session.startDir || "~";
  const listeners = new Set<(chunk: string) => void>();
  const exitListeners = new Set<(info: { exitCode: number; signal?: number }) => void>();

  // SSH login password is supplied only via SSH_ASKPASS (REQUIRE=force).
  // Do not mirror it into the PTY on any "password:" prompt — that also
  // matches sudo/script prompts and injects a stray CR into the session.
  pty.onData((data) => {
    for (const cb of listeners) cb(data);
  });
  pty.onExit(({ exitCode, signal }) => {
    askpass?.cleanup();
    for (const cb of exitListeners) {
      cb({ exitCode, signal: signal ?? undefined });
    }
  });

  return {
    id,
    session,
    authPassword: storedPassword || undefined,
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
        execOpts?.timeoutMs,
        storedPassword || undefined,
        execOpts?.stdin,
        execOpts?.onChunk,
        execOpts?.abortSignal,
        execOpts?.onStdin
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
      askpass?.cleanup();
      try {
        pty.kill();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * One-shot SSH command with password via askpass (no ControlMaster / BatchMode).
 * Used to install a public key into the remote authorized_keys.
 */
export async function installAuthorizedKey(
  session: SavedSession,
  publicKeyLine: string,
  password: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const key = publicKeyLine.trim();
  const pw = password.trim();
  if (!key) return { ok: false, message: "empty_key" };
  if (!pw) return { ok: false, message: "empty_password" };

  const remote =
    `mkdir -p ~/.ssh && chmod 700 ~/.ssh && ` +
    `touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && ` +
    `KEY=${shellQuote(key)}; ` +
    `grep -qxF "$KEY" ~/.ssh/authorized_keys 2>/dev/null || printf '%s\\n' "$KEY" >> ~/.ssh/authorized_keys`;

  const args = buildSshArgs(
    { ...session, identityFile: undefined, startDir: undefined },
    { tty: false, batch: false }
  );
  args.push("-o", "NumberOfPasswordPrompts=1");
  args.push("-o", "PreferredAuthentications=password,keyboard-interactive");
  args.push(remote);

  const askpass = createAskpassHandle(pw);
  const env = { ...cleanEnv(), ...askpass.env };

  try {
    const result = await new Promise<ExecResult>((resolve) => {
      const child = spawn(sshBinary(), args, {
        env,
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        resolve({ stdout, stderr, exitCode: null, timedOut: true });
      }, 45_000);
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          stdout,
          stderr: stderr || err.message,
          exitCode: 1,
        });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code });
      });
    });

    if (result.timedOut) {
      return { ok: false, message: "timed_out" };
    }
    if (result.exitCode === 0) return { ok: true };
    const detail = (result.stderr || result.stdout || "").trim();
    return {
      ok: false,
      message: detail.slice(0, 400) || `exit_${result.exitCode ?? "null"}`,
    };
  } finally {
    askpass.cleanup();
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\"'\"'`)}'`;
}

function scpBinary(): string {
  if (process.platform === "win32") return resolveWinClient("scp");
  return "/usr/bin/scp";
}

/** Shared options with the interactive tab's ControlMaster (no remote argv). */
export function buildScpArgs(
  session: SavedSession,
  opts?: { batch?: boolean; passwordAuth?: boolean }
): string[] {
  const args: string[] = ["-r"];
  if (session.port) args.push("-P", String(session.port));
  if (session.identityFile) args.push("-i", expandHome(session.identityFile));
  if (session.proxyJump) args.push("-o", `ProxyJump=${session.proxyJump}`);
  pushHostKeyOptions(args);
  pushMuxOptions(args, session);
  if (opts?.passwordAuth) {
    pushPasswordAuthOptions(args, {
      allowPublicKey: Boolean(session.identityFile?.trim()),
    });
  } else if (opts?.batch !== false) {
    args.push("-o", "BatchMode=yes");
  }
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
function buildRsyncShell(
  session: SavedSession,
  opts?: { passwordAuth?: boolean }
): string {
  const parts: string[] = [sshBinary()];
  if (session.port) parts.push("-p", String(session.port));
  if (session.identityFile) parts.push("-i", expandHome(session.identityFile));
  if (session.proxyJump) parts.push("-o", `ProxyJump=${session.proxyJump}`);
  pushHostKeyOptions(parts);
  pushMuxOptions(parts, session);
  if (opts?.passwordAuth) {
    pushPasswordAuthOptions(parts, {
      allowPublicKey: Boolean(session.identityFile?.trim()),
    });
  } else {
    parts.push("-o", "BatchMode=yes");
  }
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

/** No progress / child I/O for this long → kill. */
const TRANSFER_IDLE_MS = 10 * 60 * 1000;
/** Hard ceiling so a stuck child cannot live forever. */
const TRANSFER_MAX_MS = 24 * 60 * 60 * 1000;

type IdleWatch = {
  touch: () => void;
  clear: () => void;
};

function createIdleWatch(
  onTimeout: (reason: "idle" | "max") => void,
  opts?: { idleMs?: number; maxMs?: number }
): IdleWatch {
  const idleMs = opts?.idleMs ?? TRANSFER_IDLE_MS;
  const maxMs = opts?.maxMs ?? TRANSFER_MAX_MS;
  let lastActivity = Date.now();
  const started = Date.now();
  let fired = false;
  const tick = setInterval(() => {
    if (fired) return;
    const now = Date.now();
    if (now - started >= maxMs) {
      fired = true;
      onTimeout("max");
      return;
    }
    if (now - lastActivity >= idleMs) {
      fired = true;
      onTimeout("idle");
    }
  }, 5_000);
  return {
    touch: () => {
      lastActivity = Date.now();
    },
    clear: () => clearInterval(tick),
  };
}

function resolveTransferIdleMs(optsTimeoutMs?: number): number {
  // Legacy callers passed a short absolute timeout (e.g. 120s). Treat that as
  // "use defaults"; only honor an explicit longer idle override.
  if (optsTimeoutMs != null && optsTimeoutMs > TRANSFER_IDLE_MS) {
    return optsTimeoutMs;
  }
  return TRANSFER_IDLE_MS;
}

/** Best-effort remote file size (bytes). Returns null on failure. */
function probeRemoteFileSize(
  session: SavedSession,
  remotePath: string,
  env: NodeJS.ProcessEnv,
  passwordAuth: boolean
): Promise<number | null> {
  const cmd =
    `stat -c%s -- ${shellQuote(remotePath)} 2>/dev/null || ` +
    `wc -c < ${shellQuote(remotePath)} 2>/dev/null`;
  const args = buildSshArgs(
    { ...session, startDir: undefined },
    { tty: false, batch: !passwordAuth }
  );
  if (passwordAuth) {
    pushPasswordAuthOptions(args, {
      allowPublicKey: Boolean(session.identityFile?.trim()),
    });
  }
  args.push(cmd);
  return new Promise((resolve) => {
    const child = spawn(sshBinary(), args, {
      env,
      windowsHide: true,
    });
    let stdout = "";
    let settled = false;
    const done = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(null);
    }, 8_000);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.on("error", () => done(null));
    child.on("close", (code) => {
      if (code !== 0) {
        done(null);
        return;
      }
      const n = Number((stdout.trim().split(/\s+/).pop() || "").replace(/,/g, ""));
      done(Number.isFinite(n) && n >= 0 ? n : null);
    });
  });
}

function joinRemoteDir(remoteDir: string, name: string): string {
  const base = remoteDir.trim() || "~";
  if (base === "~") return `~/${name}`;
  return `${base.replace(/\/?$/, "/")}${name}`;
}

/** Copy local paths into a remote directory over the live ControlMaster. */
export async function uploadFilesViaScp(
  session: SavedSession,
  localPaths: string[],
  remoteDir: string,
  opts?: {
    /** Idle timeout override (ms). Short legacy values are ignored. */
    timeoutMs?: number;
    onProgress?: (p: UploadProgress) => void;
    /** Required on Windows for password-auth hosts (no ControlMaster). */
    password?: string;
    abortSignal?: AbortSignal;
  }
): Promise<{ ok: true } | { error: string }> {
  const cleaned = localPaths.map((p) => p.trim()).filter(Boolean);
  if (!cleaned.length) return { error: "No files" };
  if (opts?.abortSignal?.aborted) return { error: "Aborted" };
  const idleMs = resolveTransferIdleMs(opts?.timeoutMs);
  const onProgress = opts?.onProgress;
  const abortSignal = opts?.abortSignal;
  const askpass = createNonMuxAskpass(opts?.password);
  const passwordAuth = Boolean(askpass);
  const transferEnv = askpass
    ? { ...cleanEnv(), ...askpass.env }
    : process.env;
  const remote = remoteDir.trim() || "~";
  const dest = `${session.user}@${session.host}:${remote.replace(/\/?$/, "/")}`;
  const total = await totalLocalBytes(cleaned);
  onProgress?.({
    transferred: 0,
    total: total || 1,
    percent: 0,
    currentName: path.basename(cleaned[0] || ""),
  });

  try {
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
        buildRsyncShell(session, { passwordAuth }),
        ...cleaned,
        dest,
      ];
      const child = spawn(rsyncBinary(), args, {
        env: transferEnv,
        windowsHide: true,
      });
      let stderr = "";
      let settled = false;
      const classicState: ClassicProgressState = {
        completedBytes: 0,
        currentFileStart: 0,
        currentName: path.basename(cleaned[0] || ""),
      };
      let watch: ReturnType<typeof createIdleWatch> | undefined;
      const finish = (
        result: { ok: true } | { error: string } | "missing" | "unsupported"
      ) => {
        if (settled) return;
        settled = true;
        watch?.clear();
        abortSignal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        finish({ error: "Aborted" });
      };
      if (abortSignal?.aborted) {
        onAbort();
        return;
      }
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      watch = createIdleWatch(
        (reason) => {
          child.kill("SIGKILL");
          finish({
            error:
              reason === "max"
                ? "Upload exceeded maximum duration"
                : "Upload timed out (no progress)",
          });
        },
        { idleMs }
      );
      const onChunk = (d: Buffer) => {
        watch?.touch();
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
        if ((err as NodeJS.ErrnoException).code === "ENOENT") finish("missing");
        else finish({ error: err.message });
      });
      child.on("close", (code) => {
        if (code === 0) {
          onProgress?.({
            transferred: total,
            total: total || 1,
            percent: 100,
          });
          finish({ ok: true });
          return;
        }
        const errText = (stderr || `rsync exit ${code}`).trim();
        if (
          progressMode === "progress2" &&
          /unrecognized option|--info/i.test(errText)
        ) {
          finish("unsupported");
          return;
        }
        finish({ error: errText.slice(0, 400) });
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

  // Fallback: one scp -r per top-level path; poll remote size for progress.
  let doneBytes = 0;
  for (const src of cleaned) {
    let size = 0;
    try {
      size = await totalLocalBytes([src]);
    } catch {
      size = 0;
    }
    const name = path.basename(src);
    const remoteFile = joinRemoteDir(remote, name);
    onProgress?.({
      transferred: doneBytes,
      total: total || 1,
      percent:
        total > 0 ? Math.min(99, Math.round((doneBytes / total) * 100)) : 0,
      currentName: name,
    });
    const args = [
      ...buildScpArgs(session, {
        batch: !passwordAuth,
        passwordAuth,
      }),
      src,
      dest,
    ];
    if (abortSignal?.aborted) return { error: "Aborted" };
    const one = await new Promise<{ ok: true } | { error: string }>((resolve) => {
      const child = spawn(scpBinary(), args, {
        env: transferEnv,
        windowsHide: true,
      });
      let stderr = "";
      let settled = false;
      let lastRemoteBytes = 0;
      let watch: ReturnType<typeof createIdleWatch> | undefined;
      let poll: ReturnType<typeof setInterval> | undefined;
      const finish = (result: { ok: true } | { error: string }) => {
        if (settled) return;
        settled = true;
        if (poll) clearInterval(poll);
        watch?.clear();
        abortSignal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        finish({ error: "Aborted" });
      };
      if (abortSignal?.aborted) {
        onAbort();
        return;
      }
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      watch = createIdleWatch(
        (reason) => {
          child.kill("SIGKILL");
          finish({
            error:
              reason === "max"
                ? "Upload exceeded maximum duration"
                : "Upload timed out (no progress)",
          });
        },
        { idleMs }
      );
      const emitPartial = (fileBytes: number, heartbeat: boolean) => {
        const transferred = Math.min(doneBytes + fileBytes, total || doneBytes + fileBytes);
        onProgress?.({
          transferred: Math.max(transferred, 0),
          total: total || 1,
          percent:
            total > 0
              ? Math.min(99, Math.round((transferred / total) * 100))
              : 0,
          currentName: name,
        });
        if (!heartbeat && fileBytes > lastRemoteBytes) {
          lastRemoteBytes = fileBytes;
          watch?.touch();
        }
      };
      poll = setInterval(() => {
        void probeRemoteFileSize(
          session,
          remoteFile,
          transferEnv,
          passwordAuth
        ).then((n) => {
          if (settled) return;
          if (n != null) emitPartial(n, false);
          else emitPartial(lastRemoteBytes, true);
        });
      }, 1_000);
      child.stderr.on("data", (d: Buffer) => {
        watch?.touch();
        stderr += d.toString("utf8");
      });
      child.stdout?.on("data", () => watch?.touch());
      child.on("error", (err) => finish({ error: err.message }));
      child.on("close", (code) => {
        if (code === 0) finish({ ok: true });
        else
          finish({
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
      currentName: name,
    });
  }
  return { ok: true };
  } finally {
    askpass?.cleanup();
  }
}

/** Pull remote paths into a local directory over the live ControlMaster. */
export async function downloadFilesViaScp(
  session: SavedSession,
  remotePaths: string[],
  localDir: string,
  opts?: {
    /** Idle timeout override (ms). Short legacy values are ignored. */
    timeoutMs?: number;
    onProgress?: (p: UploadProgress) => void;
    /** Required on Windows for password-auth hosts (no ControlMaster). */
    password?: string;
  }
): Promise<{ ok: true } | { error: string }> {
  const cleaned = remotePaths.map((p) => p.trim()).filter(Boolean);
  if (!cleaned.length) return { error: "No files" };
  const destDir = localDir.trim();
  if (!destDir) return { error: "No destination" };
  const idleMs = resolveTransferIdleMs(opts?.timeoutMs);
  const onProgress = opts?.onProgress;
  const askpass = createNonMuxAskpass(opts?.password);
  const passwordAuth = Boolean(askpass);
  const transferEnv = askpass
    ? { ...cleanEnv(), ...askpass.env }
    : process.env;
  const remotes = cleaned.map(
    (p) => `${session.user}@${session.host}:${p}`
  );
  const dest = destDir.replace(/\/?$/, "/");

  let totalBytes = 0;
  const remoteSizes: number[] = [];
  for (const p of cleaned) {
    const n = await probeRemoteFileSize(
      session,
      p,
      transferEnv,
      passwordAuth
    );
    remoteSizes.push(n ?? 0);
    totalBytes += n ?? 0;
  }

  onProgress?.({
    transferred: 0,
    total: totalBytes || 1,
    percent: 0,
    currentName: path.basename(cleaned[0] || ""),
  });

  try {
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
        buildRsyncShell(session, { passwordAuth }),
        ...remotes,
        dest,
      ];
      const child = spawn(rsyncBinary(), args, {
        env: transferEnv,
        windowsHide: true,
      });
      let stderr = "";
      let settled = false;
      const classicState: ClassicProgressState = {
        completedBytes: 0,
        currentFileStart: 0,
        currentName: path.basename(cleaned[0] || ""),
      };
      const finish = (
        result: { ok: true } | { error: string } | "missing" | "unsupported"
      ) => {
        if (settled) return;
        settled = true;
        watch.clear();
        resolve(result);
      };
      const watch = createIdleWatch(
        (reason) => {
          child.kill("SIGKILL");
          finish({
            error:
              reason === "max"
                ? "Download exceeded maximum duration"
                : "Download timed out (no progress)",
          });
        },
        { idleMs }
      );
      const onChunk = (d: Buffer) => {
        watch.touch();
        const text = d.toString("utf8");
        stderr += text;
        if (!onProgress) return;
        if (progressMode === "progress2") {
          const parsed = parseProgress2(text);
          if (!parsed) return;
          const transferred = parsed.transferred;
          const knownTotal = totalBytes > 0 ? totalBytes : Math.max(transferred, 1);
          onProgress({
            transferred: Math.min(transferred, knownTotal),
            total: knownTotal,
            percent:
              totalBytes > 0
                ? Math.min(99, Math.round((transferred / totalBytes) * 100))
                : Math.min(99, parsed.percent),
            currentName: classicState.currentName,
          });
          return;
        }
        const latest = applyClassicProgress(
          classicState,
          text,
          totalBytes
        );
        if (latest) onProgress(latest);
      };
      child.stdout.on("data", onChunk);
      child.stderr.on("data", onChunk);
      child.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") finish("missing");
        else finish({ error: err.message });
      });
      child.on("close", (code) => {
        if (code === 0) {
          onProgress?.({
            transferred: totalBytes || 1,
            total: totalBytes || 1,
            percent: 100,
          });
          finish({ ok: true });
          return;
        }
        const errText = (stderr || `rsync exit ${code}`).trim();
        if (
          progressMode === "progress2" &&
          /unrecognized option|--info/i.test(errText)
        ) {
          finish("unsupported");
          return;
        }
        finish({ error: errText.slice(0, 400) });
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

  let doneBytes = 0;
  for (let i = 0; i < remotes.length; i++) {
    const remote = remotes[i]!;
    const remotePath = cleaned[i]!;
    const name = path.basename(remotePath);
    const expected = remoteSizes[i] ?? 0;
    const localPath = path.join(destDir, name);
    onProgress?.({
      transferred: doneBytes,
      total: totalBytes || 1,
      percent:
        totalBytes > 0
          ? Math.min(99, Math.round((doneBytes / totalBytes) * 100))
          : 0,
      currentName: name,
    });
    const args = [
      ...buildScpArgs(session, {
        batch: !passwordAuth,
        passwordAuth,
      }),
      remote,
      dest,
    ];
    const one = await new Promise<{ ok: true } | { error: string }>((resolve) => {
      const child = spawn(scpBinary(), args, {
        env: transferEnv,
        windowsHide: true,
      });
      let stderr = "";
      let settled = false;
      let lastLocalBytes = 0;
      const finish = (result: { ok: true } | { error: string }) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        watch.clear();
        resolve(result);
      };
      const watch = createIdleWatch(
        (reason) => {
          child.kill("SIGKILL");
          finish({
            error:
              reason === "max"
                ? "Download exceeded maximum duration"
                : "Download timed out (no progress)",
          });
        },
        { idleMs }
      );
      const emitPartial = (fileBytes: number, heartbeat: boolean) => {
        const transferred = doneBytes + fileBytes;
        const knownTotal =
          totalBytes > 0 ? totalBytes : Math.max(transferred, expected, 1);
        onProgress?.({
          transferred: Math.min(transferred, knownTotal),
          total: knownTotal,
          percent:
            knownTotal > 0
              ? Math.min(99, Math.round((transferred / knownTotal) * 100))
              : 0,
          currentName: name,
        });
        if (!heartbeat && fileBytes > lastLocalBytes) {
          lastLocalBytes = fileBytes;
          watch.touch();
        }
      };
      const poll = setInterval(() => {
        void stat(localPath)
          .then((st) => {
            if (settled) return;
            if (st.isFile()) emitPartial(st.size, false);
            else emitPartial(lastLocalBytes, true);
          })
          .catch(() => {
            if (!settled) emitPartial(lastLocalBytes, true);
          });
      }, 500);
      child.stderr.on("data", (d: Buffer) => {
        watch.touch();
        stderr += d.toString("utf8");
      });
      child.stdout?.on("data", () => watch.touch());
      child.on("error", (err) => finish({ error: err.message }));
      child.on("close", (code) => {
        if (code === 0) finish({ ok: true });
        else
          finish({
            error: (stderr || `scp exit ${code}`).trim().slice(0, 400),
          });
      });
    });
    if ("error" in one) return one;
    let finalSize = expected;
    try {
      finalSize = (await stat(localPath)).size;
    } catch {
      /* keep expected */
    }
    doneBytes += finalSize;
    onProgress?.({
      transferred: Math.min(doneBytes, totalBytes || doneBytes),
      total: totalBytes || doneBytes || 1,
      percent:
        totalBytes > 0
          ? Math.min(100, Math.round((doneBytes / totalBytes) * 100))
          : 100,
      currentName: name,
    });
  }
  return { ok: true };
  } finally {
    askpass?.cleanup();
  }
}

/**
 * Run with the account login shell (often zsh) so aliases like `ll` match an
 * interactive SSH session. Caller must request a TTY (`-tt`) or zsh/bash will
 * print ioctl / job-control noise and may skip interactive rc aliases.
 */
function wrapRemoteLoginCommand(cwd: string, command: string): string {
  const body = [
    `cd ${shellQuote(cwd)} 2>/dev/null || true`,
    command,
  ].join("; ");
  const quoted = shellQuote(body);
  // Prefer $SHELL (zsh on many hosts); bash fallback.
  return (
    `if [ -n "\${SHELL:-}" ] && [ -x "$SHELL" ]; then ` +
    `exec "$SHELL" -lic ${quoted}; ` +
    `elif [ -x /bin/zsh ]; then ` +
    `exec /bin/zsh -lic ${quoted}; ` +
    `else ` +
    `exec /bin/bash -lic ${quoted}; ` +
    `fi`
  );
}

function runSshExec(
  session: SavedSession,
  command: string,
  cwd: string,
  timeoutMs = 60_000,
  password?: string,
  stdin?: string | Buffer,
  onChunk?: (chunk: string) => void,
  abortSignal?: AbortSignal,
  onStdin?: (write: (data: string) => void) => void
): Promise<ExecResult> {
  const remote = wrapRemoteLoginCommand(cwd || "~", command);
  const askpass = createNonMuxAskpass(password);
  const passwordAuth = Boolean(askpass);
  // TTY required so login-shell rc/aliases load cleanly (same as `ssh host`).
  const base = buildSshArgs(
    { ...session, startDir: undefined },
    { tty: true, batch: !passwordAuth }
  );
  if (passwordAuth) {
    pushPasswordAuthOptions(base, {
      allowPublicKey: Boolean(session.identityFile?.trim()),
    });
  }
  base.push(remote);

  const env = askpass
    ? { ...cleanEnv(), ...askpass.env }
    : process.env;

  return new Promise((resolve) => {
    if (abortSignal?.aborted) {
      askpass?.cleanup();
      resolve({ stdout: "", stderr: "Aborted", exitCode: null });
      return;
    }
    const child = spawn(sshBinary(), base, {
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const push = (chunk: string, sink: "stdout" | "stderr") => {
      if (sink === "stdout") stdout += chunk;
      else stderr += chunk;
      onChunk?.(chunk);
    };
    const finish = (result: ExecResult, kill = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      if (kill) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
      askpass?.cleanup();
      resolve(result);
    };
    const onAbort = () =>
      finish({ stdout, stderr: stderr || "Aborted", exitCode: null }, true);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    onStdin?.((data) => {
      try {
        if (!settled) child.stdin.write(data);
      } catch {
        /* ignore */
      }
    });
    const timer = setTimeout(() => {
      finish({ stdout, stderr, exitCode: null, timedOut: true }, true);
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      push(d.toString("utf8"), "stdout");
    });
    child.stderr.on("data", (d: Buffer) => {
      push(d.toString("utf8"), "stderr");
    });
    child.on("error", (err) => {
      finish({
        stdout,
        stderr: stderr || err.message,
        exitCode: 1,
      });
    });
    child.on("close", (code) => {
      finish({ stdout, stderr, exitCode: code });
    });

    // Keep argv short (Windows CreateProcess ~8KB limit). Large editor
    // saves stream the payload on stdin instead of embedding in the command.
    const payload =
      stdin == null
        ? null
        : typeof stdin === "string"
          ? Buffer.from(stdin, "utf8")
          : stdin;
    // Keep stdin open for interactive answers from the flow card UI.
    if (onStdin && (!payload || payload.length === 0)) {
      return;
    }
    if (!payload || payload.length === 0) {
      child.stdin.end();
      return;
    }
    child.stdin.on("error", () => {
      /* ignore EPIPE after remote exit */
    });
    child.stdin.end(payload);
  });
}
