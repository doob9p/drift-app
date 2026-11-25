import { spawn as ptySpawn, type IPty } from "node-pty";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  newId,
  type ExecResult,
  type LocalShellId,
  type TargetRef,
} from "@drift/core";

export type { LocalShellId };

export interface LocalPtyBackend {
  readonly id: string;
  readonly pid: number;
  readonly target: TargetRef;
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
      /** Called once the process is ready to accept typed input. */
      onStdin?: (write: (data: string) => void) => void;
    }
  ): Promise<ExecResult>;
  getCwd(): Promise<string>;
  dispose(): Promise<void>;
}

/** Env injected by Cursor agent / npm that must not leak into the user shell. */
const SANDBOX_ENV_RE = /cursor-sandbox-cache/i;
const STRIP_ENV_KEYS = new Set([
  "CURSOR_AGENT",
  "CURSOR_AGENT_STORE_FILES_DIR",
  "CURSOR_AGENT_STORE_SHARED_PATHS",
  "CURSOR_CONVERSATION_ID",
  "CURSOR_REQUEST_ID",
  "CURSOR_SPAWNED_BY_EXTENSION_ID",
  "CURSOR_SPAWN_CHAIN",
  "CI",
  // Electron/Vite set this for Drift itself; Next.js then warns and prerender
  // diverges from iTerm ("non-standard NODE_ENV"). Leave unset like a normal shell.
  "NODE_ENV",
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ASAR",
  "ELECTRON_NO_ATTACH_CONSOLE",
  "VITE_DEV_SERVER_URL",
  "VITE_CJS_IGNORE_WARNING",
  // npm/pnpm lifecycle — otherwise interactive PATH picks up this repo's bins.
  "INIT_CWD",
  "NODE_PATH",
  "npm_config_prefix",
  "npm_config_globalconfig",
  "npm_config_userconfig",
  "npm_config_cache",
  "npm_config_node_gyp",
  "npm_lifecycle_event",
  "npm_lifecycle_script",
  "npm_package_name",
  "npm_package_version",
  "npm_package_json",
  "PNPM_SCRIPT_SRC_DIR",
  "PNPM_PACKAGE_NAME",
  "npm_command",
  "npm_execpath",
  "npm_node_execpath",
]);
const STRIP_ENV_PREFIXES = ["npm_package_", "npm_config_", "npm_node_", "ELECTRON_"];
/** PATH entries injected while Drift itself was started via npm/pnpm. */
const PATH_POLLUTION_RE =
  /(?:^|[/\\])node_modules[/\\]\.bin(?:$|[/\\])|(?:^|[/\\])node-gyp-bin(?:$|[/\\])/i;

function isWin(): boolean {
  return process.platform === "win32";
}

function pathSep(): string {
  return isWin() ? ";" : ":";
}

/** Drop npm/pnpm lifecycle bins and keep first-seen order (iTerm-like). */
function scrubPathValue(raw: string): string {
  const sep = pathSep();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(sep)) {
    if (!part) continue;
    if (PATH_POLLUTION_RE.test(part)) continue;
    const key = isWin() ? part.toLowerCase() : part;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(part);
  }
  return out.join(sep);
}

let cachedLoginPath: string | null | undefined;

/**
 * PATH as a fresh login shell would see it — not Electron/npm's polluted PATH.
 * Cached: login startup is slow and stable for the app lifetime.
 */
function resolveLoginPath(): string | null {
  if (cachedLoginPath !== undefined) return cachedLoginPath;
  if (isWin()) {
    cachedLoginPath = null;
    return null;
  }
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const home = os.homedir();
    const user = os.userInfo().username;
    const result = spawnSync(shell, ["-l", "-c", "printenv PATH"], {
      encoding: "utf8",
      timeout: 8000,
      env: {
        HOME: home,
        USER: user,
        LOGNAME: user,
        SHELL: shell,
        TERM: "xterm-256color",
        // Minimal PATH so the login scripts rebuild like Terminal/iTerm.
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      },
    });
    const pathOut = (result.stdout || "").trim();
    cachedLoginPath = result.status === 0 && pathOut ? scrubPathValue(pathOut) : null;
  } catch {
    cachedLoginPath = null;
  }
  return cachedLoginPath;
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    // Cursor redirects Homebrew/npm caches into a sandbox dir. Interactive
    // shells then hit empty caches (e.g. "==> Downloading Homebrew API data")
    // while iTerm uses ~/Library/Caches/Homebrew and looks fine.
    if (STRIP_ENV_KEYS.has(key) || SANDBOX_ENV_RE.test(value)) continue;
    if (STRIP_ENV_PREFIXES.some((p) => key.startsWith(p))) continue;
    env[key] = value;
  }

  const pathKey = isWin() && env.Path && !env.PATH ? "Path" : "PATH";
  const inherited = scrubPathValue(env.PATH || env.Path || "");
  const loginPath = resolveLoginPath();
  if (loginPath || inherited) {
    // Login PATH first (Homebrew etc.), then scrubbed parent PATH so tools
    // from the launch shell (pnpm via corepack/nvm/fnm in .zshrc) remain
    // visible — login-only PATH often misses those.
    const sep = pathSep();
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const part of [...(loginPath || "").split(sep), ...inherited.split(sep)]) {
      if (!part) continue;
      const key = isWin() ? part.toLowerCase() : part;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(part);
    }
    env.PATH = merged.join(sep);
    if (isWin() && env.Path) delete env.Path;
  } else {
    env.PATH = isWin()
      ? [
          process.env.SystemRoot
            ? path.join(process.env.SystemRoot, "System32")
            : "",
          process.env.SystemRoot ?? "",
          process.env.SystemRoot
            ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0")
            : "",
        ]
          .filter(Boolean)
          .join(";")
      : "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  }

  // Electron/Cursor often sets TERM=dumb; a real PTY needs a usable TERM.
  if (!env.TERM || env.TERM === "dumb") env.TERM = "xterm-256color";
  if (!env.HOME) env.HOME = os.homedir();
  if (isWin() && !env.USERPROFILE) env.USERPROFILE = os.homedir();
  // Agnoster / powerline prompts need a UTF-8 locale for correct glyph width.
  if (!isWin()) {
    const lang = env.LC_ALL || env.LANG || "";
    if (!/utf-?8/i.test(lang)) {
      env.LANG = "en_US.UTF-8";
      if (env.LC_ALL) env.LC_ALL = "en_US.UTF-8";
    }
  }
  return env;
}

function firstExisting(paths: string[]): string | null {
  for (const p of paths) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

function powershellPath(): string {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  return (
    firstExisting([
      path.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
      ),
      path.join(
        systemRoot,
        "SysWOW64",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
      ),
    ]) || "powershell.exe"
  );
}

function cmdPath(): string {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  return (
    firstExisting([
      path.join(systemRoot, "System32", "cmd.exe"),
      path.join(systemRoot, "SysWOW64", "cmd.exe"),
    ]) || "cmd.exe"
  );
}

function gitBashPath(): string | null {
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA || "";
  return firstExisting([
    path.join(pf, "Git", "bin", "bash.exe"),
    path.join(pf, "Git", "usr", "bin", "bash.exe"),
    path.join(pf86, "Git", "bin", "bash.exe"),
    path.join(pf86, "Git", "usr", "bin", "bash.exe"),
    local ? path.join(local, "Programs", "Git", "bin", "bash.exe") : "",
  ]);
}

/** Resolve an absolute shell executable for the requested Windows shell. */
export function resolveWindowsShell(kind: LocalShellId): string {
  if (kind === "cmd") return cmdPath();
  if (kind === "gitbash") {
    return gitBashPath() || powershellPath();
  }
  return powershellPath();
}

export function detectWindowsShells(): Array<{
  id: LocalShellId;
  available: boolean;
  path: string | null;
}> {
  const bash = gitBashPath();
  return [
    { id: "powershell", available: true, path: powershellPath() },
    { id: "cmd", available: true, path: cmdPath() },
    { id: "gitbash", available: Boolean(bash), path: bash },
  ];
}

function defaultShell(kind?: LocalShellId): string {
  if (isWin()) {
    const override = process.env.DRIFT_SHELL;
    if (override) return override;
    return resolveWindowsShell(kind ?? "powershell");
  }
  const candidates = [process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"];
  for (const c of candidates) {
    if (c && c.startsWith("/")) return c;
  }
  return "/bin/zsh";
}

function shellBaseName(shell: string): string {
  return path.basename(shell).toLowerCase().replace(/\.exe$/, "");
}

function shellArgs(shell: string, kind?: LocalShellId): string[] {
  if (!isWin()) return ["-l"];
  if (kind === "gitbash" || shellBaseName(shell) === "bash") {
    return ["--login", "-i"];
  }
  const base = shellBaseName(shell);
  if (base === "powershell" || base === "pwsh") {
    return ["-NoLogo"];
  }
  if (base === "cmd") {
    return [];
  }
  return [];
}

function prepareUnixShellEnv(shell: string, id: string, env: Record<string, string>): void {
  // Bash: OSC 7 via PROMPT_COMMAND. zsh: tiny ZDOTDIR wrapper that sources ~/.zshrc.
  const osc =
    'printf "\\033]7;file://%s%s\\033\\\\" "localhost" "$PWD"';
  if (!env.PROMPT_COMMAND) {
    env.PROMPT_COMMAND = osc;
  } else if (!env.PROMPT_COMMAND.includes("]7;")) {
    env.PROMPT_COMMAND = `${osc}; ${env.PROMPT_COMMAND}`;
  }
  if (shellBaseName(shell) !== "zsh") return;

  const zdot = path.join(os.tmpdir(), `drift-zsh-${id}`);
  mkdirSync(zdot, { recursive: true });
  // ZDOTDIR would default HISTFILE to $ZDOTDIR/.zsh_history (empty each session).
  // Pin to the user's real history so ↑ / autosuggest match Terminal.app.
  writeFileSync(
    path.join(zdot, ".zshrc"),
    [
      // Prefer the usual home history before user config runs.
      'if [[ -f "$HOME/.zsh_history" ]]; then',
      '  HISTFILE="$HOME/.zsh_history"',
      'elif [[ -f "$HOME/.zhistory" ]]; then',
      '  HISTFILE="$HOME/.zhistory"',
      "else",
      '  HISTFILE="$HOME/.zsh_history"',
      "fi",
      // Source user config (oh-my-zsh may reset precmd hooks / HISTFILE).
      '[[ -f "$HOME/.zshrc" ]] && source "$HOME/.zshrc"',
      // If user config left HISTFILE under our temp ZDOTDIR, put it back.
      'if [[ -z "$HISTFILE" || "$HISTFILE" == "$ZDOTDIR"* ]]; then',
      '  if [[ -f "$HOME/.zsh_history" ]]; then',
      '    HISTFILE="$HOME/.zsh_history"',
      '  elif [[ -f "$HOME/.zhistory" ]]; then',
      '    HISTFILE="$HOME/.zhistory"',
      "  else",
      '    HISTFILE="$HOME/.zsh_history"',
      "  fi",
      "fi",
      // Reload global history into this interactive shell.
      '[[ -f "$HISTFILE" ]] && fc -R "$HISTFILE" 2>/dev/null || true',
      // Powerline prompts (agnoster) glitch on wrap if RPROMPT indent is off.
      "ZLE_RPROMPT_INDENT=${ZLE_RPROMPT_INDENT:-0}",
      // Emit OSC 7 after omz so cwd tracking survives theme init.
      'pwd_report(){ printf "\\033]7;file://localhost%s\\033\\\\" "$PWD"; }',
      "typeset -ga precmd_functions",
      'precmd_functions=("${(@)precmd_functions:#pwd_report}")',
      "precmd_functions+=(pwd_report)",
      "",
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    path.join(zdot, ".zprofile"),
    '[[ -f "$HOME/.zprofile" ]] && source "$HOME/.zprofile"\n',
    "utf8"
  );
  writeFileSync(
    path.join(zdot, ".zshenv"),
    '[[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv"\n',
    "utf8"
  );
  env.ZDOTDIR = zdot;
}

/** PowerShell profile snippet that emits OSC 7 for cwd tracking. */
function prepareWindowsPowerShellEnv(
  shell: string,
  id: string,
  env: Record<string, string>
): void {
  const base = shellBaseName(shell);
  if (base !== "powershell" && base !== "pwsh") return;

  const dir = path.join(os.tmpdir(), `drift-ps-${id}`);
  mkdirSync(dir, { recursive: true });
  const profilePath = path.join(dir, "profile.ps1");
  writeFileSync(
    profilePath,
    [
      "function prompt {",
      "  $cwd = (Get-Location).Path",
      "  $unix = ($cwd -replace '\\\\','/')",
      "  if ($unix -notmatch '^/') { $unix = '/' + $unix }",
      '  [Console]::Write(([char]27 + "]7;file://localhost" + $unix + [char]7))',
      '  "PS $cwd> "',
      "}",
      "",
    ].join("\n"),
    "utf8"
  );
  env.DRIFT_PS_PROFILE = profilePath;
}

/**
 * Interactive login shell. Optional `command` runs first (Patchbay-style),
 * then the shell stays open when the command exits.
 */
export function createLocalPty(opts?: {
  cwd?: string;
  cols?: number;
  rows?: number;
  /** Windows local shell preference. Ignored on macOS/Linux. */
  shellKind?: LocalShellId;
  /** Run once at start (e.g. `claude --resume …`), then keep the shell. */
  command?: string;
  /** Extra env merged after cleanEnv (overrides). */
  env?: Record<string, string>;
  /** Env keys to strip after cleanEnv (e.g. nested Claude session vars). */
  stripEnvKeys?: string[];
}): LocalPtyBackend {
  const shellKind = opts?.shellKind ?? "powershell";
  const shell = defaultShell(shellKind);
  const cwd =
    opts?.cwd ??
    (isWin()
      ? process.env.USERPROFILE || os.homedir()
      : process.env.HOME || os.homedir());
  const id = newId();
  const env = cleanEnv();
  for (const k of opts?.stripEnvKeys ?? []) delete env[k];
  if (opts?.env) Object.assign(env, opts.env);
  const base = shellBaseName(shell);
  const isPowerShell = base === "powershell" || base === "pwsh";
  const command = opts?.command?.trim() || "";

  if (isWin() && isPowerShell) {
    prepareWindowsPowerShellEnv(shell, id, env);
  } else if (!isWin()) {
    prepareUnixShellEnv(shell, id, env);
  }

  let args = shellArgs(shell, isWin() ? shellKind : undefined);
  if (command) {
    if (isWin() && isPowerShell) {
      const profileBoot = env.DRIFT_PS_PROFILE
        ? `if (Test-Path $env:DRIFT_PS_PROFILE) { . $env:DRIFT_PS_PROFILE }; `
        : "";
      args = ["-NoLogo", "-NoExit", "-Command", `${profileBoot}${command}`];
    } else if (!isWin()) {
      // Login interactive: run agent, then replace with a fresh interactive shell.
      args = ["-ilc", `${command}; exec ${shell} -il`];
    }
  } else if (isWin() && isPowerShell && env.DRIFT_PS_PROFILE) {
    // Load our OSC 7 prompt without replacing the user's default profile permanently.
    args = [
      "-NoLogo",
      "-NoExit",
      "-Command",
      `if (Test-Path $env:DRIFT_PS_PROFILE) { . $env:DRIFT_PS_PROFILE }`,
    ];
  }

  const pty: IPty = ptySpawn(shell, args, {
    name: "xterm-256color",
    cols: opts?.cols ?? 120,
    rows: opts?.rows ?? 30,
    cwd,
    env,
  });

  let disposed = false;
  let cwdGuess = cwd;
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
    get pid() {
      return pty.pid;
    },
    get target(): TargetRef {
      return { kind: "local", cwd: cwdGuess };
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
      const live = await readProcessCwd(pty.pid).catch(() => null);
      return runDetached(
        command,
        execOpts?.cwd ?? live ?? cwdGuess,
        execOpts?.timeoutMs,
        execOpts?.onChunk,
        execOpts?.abortSignal,
        execOpts?.onStdin
      );
    },
    async getCwd() {
      const live = await readProcessCwd(pty.pid).catch(() => null);
      if (live) cwdGuess = live;
      return cwdGuess;
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

/**
 * macOS `lsof -Fn` escapes non-ASCII path bytes as `\xNN` (literal).
 * Decode those runs as UTF-8 so Hangul / NFD names resolve on disk.
 */
export function decodeLsofPath(raw: string): string {
  const decoded = raw.replace(/(?:\\x[0-9a-fA-F]{2})+/g, (seq) => {
    const bytes = [...seq.matchAll(/\\x([0-9a-fA-F]{2})/g)].map((m) =>
      parseInt(m[1]!, 16)
    );
    return Buffer.from(bytes).toString("utf8");
  });
  // APFS stores Hangul as NFD; NFC is nicer in the UI and still opens.
  try {
    return decoded.normalize("NFC");
  } catch {
    return decoded;
  }
}

/** Resolve the shell process working directory when the OS exposes it. */
export async function readProcessCwd(pid: number): Promise<string | null> {
  if (!pid || pid < 1) return null;
  if (process.platform === "linux") {
    try {
      return await readlink(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    return await new Promise((resolve) => {
      const child = spawn("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
        env: process.env,
      });
      let out = "";
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString("utf8");
      });
      child.on("close", () => {
        const line = out.split("\n").find((l) => l.startsWith("n"));
        resolve(line ? decodeLsofPath(line.slice(1)) : null);
      });
      child.on("error", () => resolve(null));
    });
  }
  // Windows: rely on OSC 7 from the PowerShell prompt (parsed in the app).
  return null;
}

function runDetached(
  command: string,
  cwd: string,
  timeoutMs = 60_000,
  onChunk?: (chunk: string) => void,
  abortSignal?: AbortSignal,
  onStdin?: (write: (data: string) => void) => void
): Promise<ExecResult> {
  // Live flow logs need a real TTY — otherwise Next/pnpm block-buffer pipes
  // and chunks only arrive when the process exits.
  if (onChunk) {
    return runDetachedPty(
      command,
      cwd,
      timeoutMs,
      onChunk,
      abortSignal,
      onStdin
    );
  }
  return new Promise((resolve) => {
    // Same scrubbing as interactive PTYs — otherwise Electron/Vite NODE_ENV
    // (and npm lifecycle vars) leak into flow `pnpm build` / Next.js prerender.
    const env = cleanEnv();
    if (isWin()) {
      const child = spawn(
        process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
        ["/d", "/s", "/c", command],
        { cwd, env, windowsHide: true }
      );
      onStdin?.((data) => {
        try {
          child.stdin?.write(data);
        } catch {
          /* ignore */
        }
      });
      return settleDetached(child, timeoutMs, resolve, abortSignal);
    }

    // Interactive login so ~/.zshrc (nvm / fnm / corepack pnpm) loads — plain
    // `zsh -lc` skips .zshrc and then `pnpm` is missing even though the board
    // terminal finds it.
    const shell = defaultShell();
    const id = newId();
    prepareUnixShellEnv(shell, id, env);
    const base = shellBaseName(shell);
    const args =
      base === "zsh" || base === "bash" ? ["-ilc", command] : ["-lc", command];
    const child = spawn(shell, args, { cwd, env });
    onStdin?.((data) => {
      try {
        child.stdin?.write(data);
      } catch {
        /* ignore */
      }
    });
    return settleDetached(child, timeoutMs, resolve, abortSignal);
  });
}

function runDetachedPty(
  command: string,
  cwd: string,
  timeoutMs: number,
  onChunk: (chunk: string) => void,
  abortSignal?: AbortSignal,
  onStdin?: (write: (data: string) => void) => void
): Promise<ExecResult> {
  return new Promise((resolve) => {
    if (abortSignal?.aborted) {
      resolve({ stdout: "", stderr: "Aborted", exitCode: null });
      return;
    }
    const env = cleanEnv();
    const shell = defaultShell();
    const id = newId();
    // Avoid interactive ZDOTDIR wrappers (oh-my-zsh chatter). Quietly load the
    // user rc so PATH/aliases match a normal terminal, then run the command.
    if (isWin()) prepareWindowsPowerShellEnv(shell, id, env);

    const base = shellBaseName(shell);
    let args: string[];
    if (isWin() && (base === "powershell" || base === "pwsh")) {
      args = ["-NoLogo", "-Command", command];
    } else if (isWin() && base === "cmd") {
      args = ["/d", "/s", "/c", command];
    } else if (base === "zsh") {
      args = [
        "-lc",
        `source "$HOME/.zshrc" >/dev/null 2>&1 || true; ${command}`,
      ];
    } else if (base === "bash") {
      args = [
        "-lc",
        `eval "$(bash -ic 'alias -p' 2>/dev/null)"; shopt -s expand_aliases 2>/dev/null || true; ${command}`,
      ];
    } else {
      args = ["-lc", command];
    }

    let output = "";
    let settled = false;
    let pty: IPty;
    try {
      pty = ptySpawn(shell, args, {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd,
        env,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onChunk(message);
      resolve({ stdout: "", stderr: message, exitCode: 1 });
      return;
    }

    const finish = (exitCode: number | null, timedOut?: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      try {
        pty.kill();
      } catch {
        /* ignore */
      }
      resolve({
        stdout: output,
        stderr: "",
        exitCode,
        timedOut,
      });
    };

    const onAbort = () => finish(null);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    onStdin?.((data) => {
      try {
        if (!settled) pty.write(data);
      } catch {
        /* ignore */
      }
    });

    const timer = setTimeout(() => finish(null, true), timeoutMs);
    pty.onData((chunk) => {
      output += chunk;
      if (output.length > 100_000) output = output.slice(-100_000);
      onChunk(chunk);
    });
    pty.onExit(({ exitCode }) => finish(exitCode ?? 0));
  });
}

function settleDetached(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
  resolve: (result: ExecResult) => void,
  abortSignal?: AbortSignal
): void {
  let stdout = "";
  let stderr = "";
  let settled = false;
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
    resolve(result);
  };
  const onAbort = () =>
    finish({ stdout, stderr: stderr || "Aborted", exitCode: null }, true);
  if (abortSignal?.aborted) {
    onAbort();
    return;
  }
  abortSignal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    finish({ stdout, stderr, exitCode: null, timedOut: true }, true);
  }, timeoutMs);

  child.stdout?.on("data", (d: Buffer) => {
    stdout += d.toString("utf8");
  });
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString("utf8");
  });
  child.on("close", (code) => {
    finish({ stdout, stderr, exitCode: code });
  });
  child.on("error", (err) => {
    finish({
      stdout,
      stderr: stderr || (err instanceof Error ? err.message : String(err)),
      exitCode: null,
    });
  });
}
