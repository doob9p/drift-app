import { spawn as ptySpawn, type IPty } from "node-pty";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { readlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { newId, type ExecResult, type TargetRef } from "@drift/core";

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
    opts?: { cwd?: string; timeoutMs?: number }
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
]);

function isWin(): boolean {
  return process.platform === "win32";
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    // Cursor redirects Homebrew/npm caches into a sandbox dir. Interactive
    // shells then hit empty caches (e.g. "==> Downloading Homebrew API data")
    // while iTerm uses ~/Library/Caches/Homebrew and looks fine.
    if (STRIP_ENV_KEYS.has(key) || SANDBOX_ENV_RE.test(value)) continue;
    env[key] = value;
  }
  if (!env.PATH && !env.Path) {
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

function defaultShell(): string {
  if (isWin()) {
    // Prefer PowerShell for interactive local terminals (not cmd via COMSPEC).
    return (
      process.env.DRIFT_SHELL ||
      process.env.SHELL ||
      "powershell.exe"
    );
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

function shellArgs(shell: string): string[] {
  if (!isWin()) return ["-l"];
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
  writeFileSync(
    path.join(zdot, ".zshrc"),
    [
      // Source user config first (oh-my-zsh may reset precmd hooks).
      '[[ -f "$HOME/.zshrc" ]] && source "$HOME/.zshrc"',
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

export function createLocalPty(opts?: {
  cwd?: string;
  cols?: number;
  rows?: number;
}): LocalPtyBackend {
  const shell = defaultShell();
  const cwd = opts?.cwd ?? process.env.HOME ?? os.homedir();
  const id = newId();
  const env = cleanEnv();

  if (isWin()) {
    prepareWindowsPowerShellEnv(shell, id, env);
  } else {
    prepareUnixShellEnv(shell, id, env);
  }

  let args = shellArgs(shell);
  if (isWin() && env.DRIFT_PS_PROFILE) {
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
        execOpts?.timeoutMs
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
  timeoutMs = 60_000
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = isWin()
      ? spawn(
          process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
          ["/d", "/s", "/c", command],
          { cwd, env: process.env, windowsHide: true }
        )
      : spawn(process.env.SHELL || "/bin/zsh", ["-lc", command], {
          cwd,
          env: process.env,
        });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve({ stdout, stderr, exitCode: null, timedOut: true });
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr || (err instanceof Error ? err.message : String(err)),
        exitCode: null,
      });
    });
  });
}
