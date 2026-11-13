"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
const electron = require("electron");
const path = require("node:path");
const node_fs = require("node:fs");
const promises = require("node:fs/promises");
const promises$1 = require("node:stream/promises");
const os = require("node:os");
const node_crypto = require("node:crypto");
const nodePty = require("node-pty");
const node_child_process = require("node:child_process");
const electronUpdater = require("electron-updater");
const node_stream = require("node:stream");
const DESTRUCTIVE = /\b(rm\s+-rf|rm\s+-r|dd\s+|mkfs|shutdown|reboot|git\s+push\s+--force|git\s+push\s+-f|drop\s+table|truncate\s+)\b/i;
const WRITE = /\b(rm\s+|mv\s+|cp\s+|mkdir\s+|touch\s+|chmod\s+|chown\s+|npm\s+i|npm\s+install|pnpm\s+i|yarn\s+add|pip\s+install|brew\s+install|apt\s+|docker\s+|kubectl\s+apply|git\s+commit|git\s+push|tee\s+|sed\s+-i|>\s*|>>\s*)\b/i;
const NETWORK = /\b(curl\s+|wget\s+|nc\s+|ssh\s+|scp\s+|rsync\s+|npm\s+publish|pip\s+upload)\b/i;
const READ = /^(ls|pwd|whoami|date|uname|cat|head|tail|less|more|echo|which|type|file|stat|df|du|ps|top|htop|git\s+status|git\s+diff|git\s+log|git\s+branch)\b/i;
function classifyCommand(command) {
  const trimmed = command.trim();
  if (!trimmed) return "unknown";
  if (DESTRUCTIVE.test(trimmed)) return "destructive";
  if (NETWORK.test(trimmed)) return "network";
  if (WRITE.test(trimmed)) return "write";
  if (READ.test(trimmed)) return "read";
  return "unknown";
}
class ApprovalPolicy {
  constructor(mode = "ask") {
    __publicField(this, "mode");
    __publicField(this, "sessionRules");
    this.mode = mode;
    this.sessionRules = [];
  }
  classify(command) {
    return classifyCommand(command);
  }
  needsApproval(action) {
    if (this.mode === "read-only") {
      return action.effect !== "read";
    }
    if (action.effect === "read") return false;
    if (this.mode === "session-allow") {
      return !this.matchesRule(action);
    }
    if (this.matchesRule(action)) return false;
    return true;
  }
  remember(action, decision) {
    var _a;
    if (decision.type !== "allow-session") return;
    const sessionId = action.target.kind === "ssh" ? action.target.sessionId : void 0;
    this.sessionRules.push({
      sessionId,
      effect: action.effect,
      commandPrefix: (_a = action.command) == null ? void 0 : _a.trim().split(/\s+/)[0]
    });
  }
  matchesRule(action) {
    const sessionId = action.target.kind === "ssh" ? action.target.sessionId : void 0;
    return this.sessionRules.some((rule) => {
      if (rule.sessionId && rule.sessionId !== sessionId) return false;
      if (rule.effect !== action.effect && rule.effect !== "unknown") ;
      if (rule.commandPrefix && action.command) {
        return action.command.trim().startsWith(rule.commandPrefix);
      }
      return rule.effect === action.effect;
    });
  }
}
class SessionStore {
  constructor(dataDir2) {
    __publicField(this, "filePath");
    __publicField(this, "sessions", []);
    this.filePath = path.join(dataDir2, "sessions.json");
  }
  async load() {
    try {
      const raw = await promises.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.sessions = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.sessions = [];
    }
    return this.list();
  }
  list() {
    return [...this.sessions].sort(
      (a, b) => a.name.localeCompare(b.name, "en")
    );
  }
  async upsert(input) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    if (input.id) {
      const idx = this.sessions.findIndex((s) => s.id === input.id);
      if (idx >= 0) {
        const next = {
          ...this.sessions[idx],
          ...input,
          id: input.id,
          updatedAt: now
        };
        this.sessions[idx] = next;
        await this.persist();
        return next;
      }
    }
    const created = {
      id: input.id ?? node_crypto.randomUUID(),
      name: input.name,
      folder: input.folder,
      host: input.host,
      user: input.user,
      port: input.port,
      identityFile: input.identityFile,
      proxyJump: input.proxyJump,
      startDir: input.startDir,
      sshConfigHost: input.sshConfigHost,
      createdAt: now,
      updatedAt: now
    };
    this.sessions.push(created);
    await this.persist();
    return created;
  }
  async remove(id) {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.sessions.length === before) return false;
    await this.persist();
    return true;
  }
  get(id) {
    return this.sessions.find((s) => s.id === id);
  }
  async persist() {
    await promises.mkdir(path.dirname(this.filePath), { recursive: true });
    await promises.writeFile(
      this.filePath,
      JSON.stringify(this.sessions, null, 2),
      "utf8"
    );
  }
}
function parseSshConfig(content) {
  const lines = content.split(/\r?\n/);
  const results = [];
  let current = null;
  const flush = () => {
    if (current && current.sshConfigHost && !/[?*]/.test(current.sshConfigHost)) {
      results.push(current);
    }
    current = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [key, ...rest] = line.split(/\s+/);
    const value = rest.join(" ").trim();
    const k = key.toLowerCase();
    if (k === "host") {
      flush();
      const name = value.split(/\s+/)[0];
      current = {
        sshConfigHost: name,
        host: name
      };
      continue;
    }
    if (!current) continue;
    if (k === "hostname") current.host = value;
    if (k === "user") current.user = value;
    if (k === "port") current.port = Number(value) || void 0;
    if (k === "identityfile") current.identityFile = value;
    if (k === "proxyjump") current.proxyJump = value;
  }
  flush();
  return results;
}
function newId() {
  return node_crypto.randomUUID();
}
const SANDBOX_ENV_RE = /cursor-sandbox-cache/i;
const STRIP_ENV_KEYS = /* @__PURE__ */ new Set([
  "CURSOR_AGENT",
  "CURSOR_AGENT_STORE_FILES_DIR",
  "CURSOR_AGENT_STORE_SHARED_PATHS",
  "CURSOR_CONVERSATION_ID",
  "CURSOR_REQUEST_ID",
  "CURSOR_SPAWNED_BY_EXTENSION_ID",
  "CURSOR_SPAWN_CHAIN",
  "CI"
]);
function isWin() {
  return process.platform === "win32";
}
function cleanEnv$1() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    if (STRIP_ENV_KEYS.has(key) || SANDBOX_ENV_RE.test(value)) continue;
    env[key] = value;
  }
  if (!env.PATH && !env.Path) {
    env.PATH = isWin() ? [
      process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32") : "",
      process.env.SystemRoot ?? "",
      process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0") : ""
    ].filter(Boolean).join(";") : "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  }
  if (!env.TERM || env.TERM === "dumb") env.TERM = "xterm-256color";
  if (!env.HOME) env.HOME = os.homedir();
  if (isWin() && !env.USERPROFILE) env.USERPROFILE = os.homedir();
  if (!isWin()) {
    const lang = env.LC_ALL || env.LANG || "";
    if (!/utf-?8/i.test(lang)) {
      env.LANG = "en_US.UTF-8";
      if (env.LC_ALL) env.LC_ALL = "en_US.UTF-8";
    }
  }
  return env;
}
function defaultShell() {
  if (isWin()) {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const candidates2 = [
      process.env.DRIFT_SHELL,
      process.env.SHELL,
      path.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
      ),
      path.join(systemRoot, "System32", "cmd.exe"),
      "powershell.exe"
    ].filter((c) => Boolean(c));
    for (const c of candidates2) {
      if (c.includes("\\") || c.includes("/")) {
        if (node_fs.existsSync(c)) return c;
      } else {
        return c;
      }
    }
    return "powershell.exe";
  }
  const candidates = [process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"];
  for (const c of candidates) {
    if (c && c.startsWith("/")) return c;
  }
  return "/bin/zsh";
}
function shellBaseName(shell) {
  return path.basename(shell).toLowerCase().replace(/\.exe$/, "");
}
function shellArgs(shell) {
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
function prepareUnixShellEnv(shell, id, env) {
  const osc = 'printf "\\033]7;file://%s%s\\033\\\\" "localhost" "$PWD"';
  if (!env.PROMPT_COMMAND) {
    env.PROMPT_COMMAND = osc;
  } else if (!env.PROMPT_COMMAND.includes("]7;")) {
    env.PROMPT_COMMAND = `${osc}; ${env.PROMPT_COMMAND}`;
  }
  if (shellBaseName(shell) !== "zsh") return;
  const zdot = path.join(os.tmpdir(), `drift-zsh-${id}`);
  node_fs.mkdirSync(zdot, { recursive: true });
  node_fs.writeFileSync(
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
      ""
    ].join("\n"),
    "utf8"
  );
  node_fs.writeFileSync(
    path.join(zdot, ".zprofile"),
    '[[ -f "$HOME/.zprofile" ]] && source "$HOME/.zprofile"\n',
    "utf8"
  );
  env.ZDOTDIR = zdot;
}
function prepareWindowsPowerShellEnv(shell, id, env) {
  const base = shellBaseName(shell);
  if (base !== "powershell" && base !== "pwsh") return;
  const dir = path.join(os.tmpdir(), `drift-ps-${id}`);
  node_fs.mkdirSync(dir, { recursive: true });
  const profilePath = path.join(dir, "profile.ps1");
  node_fs.writeFileSync(
    profilePath,
    [
      "function prompt {",
      "  $cwd = (Get-Location).Path",
      "  $unix = ($cwd -replace '\\\\','/')",
      "  if ($unix -notmatch '^/') { $unix = '/' + $unix }",
      '  [Console]::Write(([char]27 + "]7;file://localhost" + $unix + [char]7))',
      '  "PS $cwd> "',
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
  env.DRIFT_PS_PROFILE = profilePath;
}
function createLocalPty(opts) {
  const shell = defaultShell();
  const cwd = (opts == null ? void 0 : opts.cwd) ?? (isWin() ? process.env.USERPROFILE || os.homedir() : process.env.HOME || os.homedir());
  const id = newId();
  const env = cleanEnv$1();
  if (isWin()) {
    prepareWindowsPowerShellEnv(shell, id, env);
  } else {
    prepareUnixShellEnv(shell, id, env);
  }
  let args = shellArgs(shell);
  if (isWin() && env.DRIFT_PS_PROFILE) {
    args = [
      "-NoLogo",
      "-NoExit",
      "-Command",
      `if (Test-Path $env:DRIFT_PS_PROFILE) { . $env:DRIFT_PS_PROFILE }`
    ];
  }
  const pty = nodePty.spawn(shell, args, {
    name: "xterm-256color",
    cols: (opts == null ? void 0 : opts.cols) ?? 120,
    rows: (opts == null ? void 0 : opts.rows) ?? 30,
    cwd,
    env
  });
  let disposed = false;
  let cwdGuess = cwd;
  const listeners = /* @__PURE__ */ new Set();
  const exitListeners = /* @__PURE__ */ new Set();
  pty.onData((data) => {
    for (const cb of listeners) cb(data);
  });
  pty.onExit(({ exitCode, signal }) => {
    for (const cb of exitListeners) {
      cb({ exitCode, signal: signal ?? void 0 });
    }
  });
  return {
    id,
    get pid() {
      return pty.pid;
    },
    get target() {
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
        (execOpts == null ? void 0 : execOpts.cwd) ?? live ?? cwdGuess,
        execOpts == null ? void 0 : execOpts.timeoutMs
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
      }
    }
  };
}
function decodeLsofPath(raw) {
  const decoded = raw.replace(/(?:\\x[0-9a-fA-F]{2})+/g, (seq) => {
    const bytes = [...seq.matchAll(/\\x([0-9a-fA-F]{2})/g)].map(
      (m) => parseInt(m[1], 16)
    );
    return Buffer.from(bytes).toString("utf8");
  });
  try {
    return decoded.normalize("NFC");
  } catch {
    return decoded;
  }
}
async function readProcessCwd(pid) {
  if (!pid || pid < 1) return null;
  if (process.platform === "linux") {
    try {
      return await promises.readlink(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    return await new Promise((resolve) => {
      const child = node_child_process.spawn("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
        env: process.env
      });
      let out = "";
      child.stdout.on("data", (d) => {
        out += d.toString("utf8");
      });
      child.on("close", () => {
        const line = out.split("\n").find((l) => l.startsWith("n"));
        resolve(line ? decodeLsofPath(line.slice(1)) : null);
      });
      child.on("error", () => resolve(null));
    });
  }
  return null;
}
function runDetached(command, cwd, timeoutMs = 6e4) {
  return new Promise((resolve) => {
    var _a, _b;
    const child = isWin() ? node_child_process.spawn(
      process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
      ["/d", "/s", "/c", command],
      { cwd, env: process.env, windowsHide: true }
    ) : node_child_process.spawn(process.env.SHELL || "/bin/zsh", ["-lc", command], {
      cwd,
      env: process.env
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
      }
      resolve({ stdout, stderr, exitCode: null, timedOut: true });
    }, timeoutMs);
    (_a = child.stdout) == null ? void 0 : _a.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    (_b = child.stderr) == null ? void 0 : _b.on("data", (d) => {
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
        exitCode: null
      });
    });
  });
}
function cleanEnv() {
  const env = {};
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
function sshControlPath(session) {
  const dir = path.join(os.homedir(), ".ssh", "drift");
  node_fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "cm-%C");
}
function buildSshArgs(session, opts) {
  const args = [];
  if ((opts == null ? void 0 : opts.tty) !== false) args.push("-tt");
  if (session.port) args.push("-p", String(session.port));
  if (session.identityFile) args.push("-i", expandHome(session.identityFile));
  if (session.proxyJump) args.push("-J", session.proxyJump);
  args.push("-o", "StrictHostKeyChecking=accept-new");
  args.push("-o", "ControlMaster=auto");
  args.push("-o", `ControlPath=${sshControlPath()}`);
  args.push("-o", "ControlPersist=600");
  if (opts == null ? void 0 : opts.batch) args.push("-o", "BatchMode=yes");
  args.push(`${session.user}@${session.host}`);
  return args;
}
function expandHome(p) {
  if (p === "~") return process.env.HOME || os.homedir();
  if (p.startsWith("~/")) {
    return `${process.env.HOME || os.homedir()}${p.slice(1)}`;
  }
  return p;
}
function sshBinary() {
  return process.platform === "win32" ? "ssh" : "/usr/bin/ssh";
}
function buildRemoteShellCommand(startDir) {
  const cd = startDir ? `cd ${shellQuote(startDir)} 2>/dev/null || true; ` : "";
  return cd + `shell=\${SHELL:-/bin/bash}; base=\${shell##*/}; if [ "$base" = zsh ]; then exec "$shell" -i -c "pwd_report(){ printf '\\033]7;file://%s%s\\033\\\\' \\"\\\${HOST:-localhost}\\" \\"\\$PWD\\"; }; precmd_functions+=(pwd_report); [[ -f ~/.zshrc ]] && source ~/.zshrc; exec zsh -i"; else export PROMPT_COMMAND='printf "\\033]7;file://%s%s\\033\\\\" "\${HOSTNAME:-\${HOST:-localhost}}" "$PWD"'; exec "$shell" -i; fi`;
}
function createSshPty(session, opts) {
  const id = newId();
  const args = buildSshArgs(session, { tty: true });
  args.push(buildRemoteShellCommand(session.startDir));
  const pty = nodePty.spawn(sshBinary(), args, {
    name: "xterm-256color",
    cols: (opts == null ? void 0 : opts.cols) ?? 120,
    rows: (opts == null ? void 0 : opts.rows) ?? 30,
    cwd: process.env.HOME || os.homedir(),
    env: cleanEnv()
  });
  let disposed = false;
  let cwdGuess = session.startDir || "~";
  const listeners = /* @__PURE__ */ new Set();
  const exitListeners = /* @__PURE__ */ new Set();
  pty.onData((data) => {
    for (const cb of listeners) cb(data);
  });
  pty.onExit(({ exitCode, signal }) => {
    for (const cb of exitListeners) {
      cb({ exitCode, signal: signal ?? void 0 });
    }
  });
  return {
    id,
    session,
    get target() {
      return {
        kind: "ssh",
        sessionId: session.id,
        hostLabel: session.name || `${session.user}@${session.host}`,
        cwd: cwdGuess
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
        (execOpts == null ? void 0 : execOpts.cwd) ?? cwdGuess,
        execOpts == null ? void 0 : execOpts.timeoutMs
      );
    },
    async getCwd() {
      return cwdGuess;
    },
    setCwd(cwd) {
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
      }
    }
  };
}
function shellQuote(s) {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}
function scpBinary() {
  return process.platform === "win32" ? "scp" : "/usr/bin/scp";
}
function buildScpArgs(session) {
  const args = ["-r"];
  if (session.port) args.push("-P", String(session.port));
  if (session.identityFile) args.push("-i", expandHome(session.identityFile));
  if (session.proxyJump) args.push("-o", `ProxyJump=${session.proxyJump}`);
  args.push("-o", "StrictHostKeyChecking=accept-new");
  args.push("-o", "ControlMaster=auto");
  args.push("-o", `ControlPath=${sshControlPath()}`);
  args.push("-o", "ControlPersist=600");
  args.push("-o", "BatchMode=yes");
  return args;
}
function rsyncBinary() {
  if (process.platform === "win32") return "rsync";
  for (const candidate of [
    "/opt/homebrew/bin/rsync",
    "/usr/local/bin/rsync",
    "/usr/bin/rsync"
  ]) {
    if (node_fs.existsSync(candidate)) return candidate;
  }
  return "rsync";
}
let progress2Support = null;
function rsyncSupportsProgress2(bin) {
  var _a;
  if (progress2Support != null) return progress2Support;
  const probe = node_child_process.spawnSync(bin, ["--info=progress2"], {
    encoding: "utf8",
    timeout: 3e3
  });
  const err = `${probe.stderr || ""}${probe.stdout || ""}${((_a = probe.error) == null ? void 0 : _a.message) || ""}`;
  progress2Support = !/unrecognized option|--info/i.test(err);
  return progress2Support;
}
function buildRsyncShell(session) {
  const parts = [sshBinary()];
  if (session.port) parts.push("-p", String(session.port));
  if (session.identityFile) parts.push("-i", expandHome(session.identityFile));
  if (session.proxyJump) parts.push("-o", `ProxyJump=${session.proxyJump}`);
  parts.push("-o", "StrictHostKeyChecking=accept-new");
  parts.push("-o", "ControlMaster=auto");
  parts.push("-o", `ControlPath=${sshControlPath()}`);
  parts.push("-o", "ControlPersist=600");
  parts.push("-o", "BatchMode=yes");
  return parts.map((p) => /\s/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p).join(" ");
}
function parseProgress2(chunk) {
  const text = chunk.replace(/\r/g, "\n");
  let best = null;
  for (const line of text.split("\n")) {
    const m = line.match(/([\d,]+)\s+(\d+)%/);
    if (!m) continue;
    best = {
      transferred: Number(m[1].replace(/,/g, "")),
      percent: Math.min(100, Number(m[2]))
    };
  }
  return best;
}
function applyClassicProgress(state, chunk, total) {
  const text = chunk.replace(/\r/g, "\n");
  let latest = null;
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
      const percent = total > 0 ? Math.min(99, Math.round(transferred / total * 100)) : filePct;
      latest = {
        transferred: Number.isFinite(transferred) ? transferred : fileBytes,
        total: total || fileBytes || 1,
        percent,
        currentName: state.currentName
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
    if (!line.includes("%") && !line.startsWith("rsync:") && !line.startsWith("building") && !line.startsWith("sent ") && !line.startsWith("total ") && !/^opening /i.test(line)) {
      state.currentName = path.basename(line.replace(/\/$/, ""));
      state.currentFileStart = state.completedBytes;
    }
  }
  return latest;
}
async function totalLocalBytes(paths) {
  let total = 0;
  async function walk(p) {
    let st;
    try {
      st = await promises.stat(p);
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
      entries = await promises.readdir(p);
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
async function uploadFilesViaScp(session, localPaths, remoteDir, opts) {
  const cleaned = localPaths.map((p) => p.trim()).filter(Boolean);
  if (!cleaned.length) return { error: "No files" };
  const timeoutMs = (opts == null ? void 0 : opts.timeoutMs) ?? 12e4;
  const onProgress = opts == null ? void 0 : opts.onProgress;
  const remote = remoteDir.trim() || "~";
  const dest = `${session.user}@${session.host}:${remote.replace(/\/?$/, "/")}`;
  const total = await totalLocalBytes(cleaned);
  onProgress == null ? void 0 : onProgress({
    transferred: 0,
    total,
    percent: 0,
    currentName: path.basename(cleaned[0] || "")
  });
  const tryRsync = (progressMode) => new Promise((resolve) => {
    const args = [
      "-a",
      ...progressMode === "progress2" ? ["--info=progress2"] : ["--progress"],
      "-e",
      buildRsyncShell(session),
      ...cleaned,
      dest
    ];
    const child = node_child_process.spawn(rsyncBinary(), args, { env: process.env });
    let stderr = "";
    let settled = false;
    const classicState = {
      completedBytes: 0,
      currentFileStart: 0,
      currentName: path.basename(cleaned[0] || "")
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ error: "Upload timed out" });
    }, timeoutMs);
    const onChunk = (d) => {
      const text = d.toString("utf8");
      stderr += text;
      if (!onProgress) return;
      if (progressMode === "progress2") {
        const parsed = parseProgress2(text);
        if (!parsed) return;
        const transferred = parsed.transferred;
        const percent = total > 0 ? Math.min(99, Math.round(transferred / total * 100)) : parsed.percent;
        onProgress({
          transferred: total > 0 ? Math.min(transferred, total) : transferred,
          total: total || transferred || 1,
          percent,
          currentName: classicState.currentName
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
      if (err.code === "ENOENT") resolve("missing");
      else resolve({ error: err.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        onProgress == null ? void 0 : onProgress({
          transferred: total,
          total: total || 1,
          percent: 100
        });
        resolve({ ok: true });
        return;
      }
      const errText = (stderr || `rsync exit ${code}`).trim();
      if (progressMode === "progress2" && /unrecognized option|--info/i.test(errText)) {
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
  let doneBytes = 0;
  for (const src of cleaned) {
    let size = 0;
    try {
      size = await totalLocalBytes([src]);
    } catch {
      size = 0;
    }
    onProgress == null ? void 0 : onProgress({
      transferred: doneBytes,
      total: total || 1,
      percent: total > 0 ? Math.min(99, Math.round(doneBytes / total * 100)) : 0,
      currentName: path.basename(src)
    });
    const args = [...buildScpArgs(session), src, dest];
    const one = await new Promise((resolve) => {
      const child = node_child_process.spawn(scpBinary(), args, { env: process.env });
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        resolve({ error: "Upload timed out" });
      }, timeoutMs);
      child.stderr.on("data", (d) => {
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
            error: (stderr || `scp exit ${code}`).trim().slice(0, 400)
          });
      });
    });
    if ("error" in one) return one;
    doneBytes += size;
    onProgress == null ? void 0 : onProgress({
      transferred: Math.min(doneBytes, total || doneBytes),
      total: total || doneBytes || 1,
      percent: total > 0 ? Math.min(100, Math.round(doneBytes / total * 100)) : 100,
      currentName: path.basename(src)
    });
  }
  return { ok: true };
}
async function downloadFilesViaScp(session, remotePaths, localDir, opts) {
  const cleaned = remotePaths.map((p) => p.trim()).filter(Boolean);
  if (!cleaned.length) return { error: "No files" };
  const destDir = localDir.trim();
  if (!destDir) return { error: "No destination" };
  const timeoutMs = (opts == null ? void 0 : opts.timeoutMs) ?? 12e4;
  const onProgress = opts == null ? void 0 : opts.onProgress;
  const remotes = cleaned.map(
    (p) => `${session.user}@${session.host}:${p}`
  );
  const dest = destDir.replace(/\/?$/, "/");
  onProgress == null ? void 0 : onProgress({
    transferred: 0,
    total: cleaned.length,
    percent: 0,
    currentName: path.basename(cleaned[0] || "")
  });
  const tryRsync = (progressMode) => new Promise((resolve) => {
    const args = [
      "-a",
      ...progressMode === "progress2" ? ["--info=progress2"] : ["--progress"],
      "-e",
      buildRsyncShell(session),
      ...remotes,
      dest
    ];
    const child = node_child_process.spawn(rsyncBinary(), args, { env: process.env });
    let stderr = "";
    let settled = false;
    const classicState = {
      completedBytes: 0,
      currentFileStart: 0,
      currentName: path.basename(cleaned[0] || "")
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ error: "Download timed out" });
    }, timeoutMs);
    const onChunk = (d) => {
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
          currentName: classicState.currentName
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
      if (err.code === "ENOENT") resolve("missing");
      else resolve({ error: err.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        onProgress == null ? void 0 : onProgress({
          transferred: cleaned.length,
          total: cleaned.length,
          percent: 100
        });
        resolve({ ok: true });
        return;
      }
      const errText = (stderr || `rsync exit ${code}`).trim();
      if (progressMode === "progress2" && /unrecognized option|--info/i.test(errText)) {
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
    onProgress == null ? void 0 : onProgress({
      transferred: done,
      total: cleaned.length,
      percent: cleaned.length > 0 ? Math.min(99, Math.round(done / cleaned.length * 100)) : 0,
      currentName: name
    });
    const args = [...buildScpArgs(session), remote, dest];
    const one = await new Promise((resolve) => {
      const child = node_child_process.spawn(scpBinary(), args, { env: process.env });
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        resolve({ error: "Download timed out" });
      }, timeoutMs);
      child.stderr.on("data", (d) => {
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
            error: (stderr || `scp exit ${code}`).trim().slice(0, 400)
          });
      });
    });
    if ("error" in one) return one;
    done += 1;
    onProgress == null ? void 0 : onProgress({
      transferred: done,
      total: cleaned.length,
      percent: cleaned.length > 0 ? Math.min(100, Math.round(done / cleaned.length * 100)) : 100,
      currentName: name
    });
  }
  return { ok: true };
}
function runSshExec(session, command, cwd, timeoutMs = 6e4) {
  const remote = `cd ${shellQuote(cwd)} 2>/dev/null; ${command}`;
  const base = buildSshArgs(
    { ...session },
    { tty: false, batch: true }
  );
  base.push(remote);
  return new Promise((resolve) => {
    const child = node_child_process.spawn(sshBinary(), base, {
      env: process.env
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
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
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
function isAborted(signal) {
  return Boolean(signal == null ? void 0 : signal.aborted);
}
const DEFAULT_MODEL = "composer-2.5";
async function listModels(apiKey) {
  if (!apiKey.trim()) return fallbackModels();
  try {
    const { Cursor } = await import("@cursor/sdk");
    const models = await Cursor.models.list({ apiKey });
    return models.map((m) => ({
      id: m.id,
      displayName: m.displayName || m.id,
      description: m.description
    }));
  } catch {
    return fallbackModels();
  }
}
function fallbackModels() {
  return [
    { id: "auto", displayName: "Auto" },
    { id: DEFAULT_MODEL, displayName: "Composer 2.5" }
  ];
}
async function* sendAgent(input) {
  if (isAborted(input.signal)) {
    yield { type: "status", status: "cancelled", detail: "Stopped" };
    return;
  }
  yield { type: "status", status: "running" };
  if (!input.apiKey.trim()) {
    yield {
      type: "status",
      status: "error",
      detail: "Cursor API key is not set. Open Settings and paste your key."
    };
    return;
  }
  try {
    const sdk = await import("@cursor/sdk").catch(() => null);
    if (sdk == null ? void 0 : sdk.Agent) {
      yield* runWithCursorSdk(sdk, input);
      return;
    }
  } catch (err) {
    if (isAborted(input.signal) || err instanceof Error && err.name === "AbortError") {
      yield { type: "status", status: "cancelled", detail: "Stopped" };
      return;
    }
    yield {
      type: "text",
      text: `Cursor SDK call failed: ${err instanceof Error ? err.message : String(err)}
Falling back to local proposer.
`
    };
  }
  if (isAborted(input.signal)) {
    yield { type: "status", status: "cancelled", detail: "Stopped" };
    return;
  }
  yield* runLocalProposer(input);
}
function buildPrompt(input) {
  var _a, _b;
  const mode = input.chatMode ?? "agent";
  const modeBlock = mode === "ask" ? [
    "Mode: Ask.",
    "Answer questions only. Explain and advise.",
    "Do NOT propose shell commands to run. Do NOT use propose blocks."
  ] : mode === "plan" ? [
    "Mode: Plan.",
    "Produce a clear numbered plan (3–8 steps) for the request.",
    "Do NOT run or propose executable shell commands. Do NOT use propose blocks.",
    "Optionally end with a short ```plan block listing one step per line."
  ] : [
    "Mode: Agent.",
    "If you need a shell command run on the user's active host, reply with a single fenced block:",
    "```propose",
    "summary: short reason",
    "command: exact shell command",
    "```",
    "Otherwise answer briefly in plain text."
  ];
  const locale = input.locale === "en" ? "en" : "ko";
  const languageLine = locale === "ko" ? "Respond in Korean (한국어). Keep shell commands and code in their original form." : "Respond in English. Keep shell commands and code in their original form.";
  return [
    "You are assisting inside Drift, a terminal app.",
    languageLine,
    ...modeBlock,
    `Active target: ${JSON.stringify(input.target)}`,
    ((_a = input.context) == null ? void 0 : _a.notes) ? `Context notes: ${input.context.notes}` : "",
    ((_b = input.context) == null ? void 0 : _b.terminalTail) ? `Recent terminal output (scrollback tail):
\`\`\`
${input.context.terminalTail}
\`\`\`` : "",
    "",
    `User: ${input.message}`
  ].filter(Boolean).join("\n");
}
function extractPlanSteps(text) {
  const fenced = text.match(/```plan\s*([\s\S]*?)```/i);
  const body = (fenced == null ? void 0 : fenced[1]) ?? text;
  const lines = body.split(/\r?\n/).map((l) => l.replace(/^\s*(?:\d+[.)]\s+|[-*]\s+)/, "").trim()).filter((l) => l.length > 0 && l.length < 200);
  if (fenced && lines.length >= 2) return lines.slice(0, 10);
  const numbered = text.split(/\r?\n/).map((l) => {
    var _a, _b;
    return (_b = (_a = l.match(/^\s*\d+[.)]\s+(.+)$/)) == null ? void 0 : _a[1]) == null ? void 0 : _b.trim();
  }).filter((x) => Boolean(x));
  return numbered.length >= 2 ? numbered.slice(0, 10) : null;
}
async function* runWithCursorSdk(sdk, input) {
  var _a, _b, _c, _d, _e;
  const cwd = input.target.kind === "local" && input.target.cwd.startsWith("/") ? input.target.cwd : process.cwd();
  const modelId = ((_a = input.modelId) == null ? void 0 : _a.trim()) || DEFAULT_MODEL;
  const chatMode = input.chatMode ?? "agent";
  const prompt = buildPrompt(input);
  if (isAborted(input.signal)) {
    yield { type: "status", status: "cancelled", detail: "Stopped" };
    return;
  }
  const agent = await sdk.Agent.create({
    apiKey: input.apiKey,
    model: { id: modelId },
    mode: chatMode === "plan" ? "plan" : "agent",
    local: { cwd }
  });
  let run = null;
  const cancelRun = () => {
    if (!run) return;
    void run.cancel().catch(() => {
    });
  };
  try {
    if (isAborted(input.signal)) {
      yield { type: "status", status: "cancelled", detail: "Stopped" };
      return;
    }
    run = await agent.send(prompt);
    (_b = input.signal) == null ? void 0 : _b.addEventListener("abort", cancelRun, { once: true });
    if (isAborted(input.signal)) {
      cancelRun();
      yield { type: "status", status: "cancelled", detail: "Stopped" };
      return;
    }
    let text = "";
    let lastUsage;
    let toolRuns = 0;
    let toolDone = 0;
    let searches = 0;
    let edits = 0;
    let commands = 0;
    const summaryLine = () => {
      const bits = [];
      if (toolDone > 0) bits.push(`${toolDone} tools`);
      if (searches > 0) bits.push(`${searches} searches`);
      if (edits > 0) bits.push(`${edits} edits`);
      if (commands > 0) bits.push(`${commands} commands`);
      return bits.length ? bits.join(" · ") : void 0;
    };
    yield {
      type: "progress",
      phase: "status",
      title: "Working",
      detail: "Starting…"
    };
    for await (const event of run.stream()) {
      if (isAborted(input.signal)) break;
      if (event.type === "thinking") {
        const snippet = event.text.trim().replace(/\s+/g, " ").slice(0, 140);
        yield {
          type: "progress",
          phase: "thinking",
          title: "Thinking",
          detail: snippet || void 0,
          summary: summaryLine(),
          done: Boolean(event.thinking_duration_ms)
        };
      }
      if (event.type === "task" && (event.text || event.status)) {
        yield {
          type: "progress",
          phase: "task",
          title: ((_c = event.status) == null ? void 0 : _c.trim()) || "Working",
          detail: ((_d = event.text) == null ? void 0 : _d.trim().slice(0, 160)) || void 0,
          summary: summaryLine()
        };
      }
      if (event.type === "tool_call") {
        if (event.status === "running") toolRuns += 1;
        if (event.status === "completed" || event.status === "error") {
          toolDone += 1;
        }
        const kind = classifyToolName(event.name);
        if (event.status === "running") {
          if (kind === "search") searches += 1;
          if (kind === "edit") edits += 1;
          if (kind === "command") commands += 1;
        }
        yield {
          type: "progress",
          phase: "tool",
          title: toolTitle(kind, event.name, event.status),
          detail: toolDetail(event.args) || event.name,
          summary: summaryLine(),
          done: event.status !== "running"
        };
      }
      if (event.type === "status" && event.message) {
        yield {
          type: "progress",
          phase: "status",
          title: event.status.toLowerCase(),
          detail: event.message.slice(0, 160),
          summary: summaryLine()
        };
      }
      if (event.type === "assistant") {
        for (const block of event.message.content) {
          if (block.type === "text" && "text" in block) {
            if (!text) {
              yield {
                type: "progress",
                phase: "replying",
                title: "Replying",
                summary: summaryLine()
              };
            }
            text += block.text;
            yield { type: "text", text: block.text };
          }
          if (block.type === "tool_use") {
            const kind = classifyToolName(block.name);
            yield {
              type: "progress",
              phase: "tool",
              title: toolTitle(kind, block.name, "running"),
              detail: toolDetail(block.input) || block.name,
              summary: summaryLine()
            };
          }
        }
      }
      if (event.type === "usage") {
        const usage2 = normalizeUsage$1(event.usage);
        if (usage2) {
          lastUsage = usage2;
          yield { type: "usage", usage: usage2, modelId };
        }
      }
    }
    if (isAborted(input.signal) || run.status === "cancelled") {
      yield { type: "status", status: "cancelled", detail: "Stopped" };
      return;
    }
    const result = await run.wait();
    if (isAborted(input.signal) || result.status === "cancelled") {
      yield { type: "status", status: "cancelled", detail: "Stopped" };
      return;
    }
    const usageFromResult = normalizeUsage$1(result.usage ?? run.usage ?? lastUsage);
    let cost;
    try {
      const billed = await agent.getUsage();
      if (billed.usage) {
        if (!usageFromResult && billed.usage) {
          lastUsage = normalizeUsage$1(billed.usage);
        }
        if (billed.cost) {
          cost = {
            rawCostCents: billed.cost.rawCostCents,
            chargedCents: billed.cost.chargedCents
          };
        }
        const latest = billed.runs.at(-1);
        if (latest == null ? void 0 : latest.cost) {
          cost = {
            rawCostCents: latest.cost.rawCostCents,
            chargedCents: latest.cost.chargedCents
          };
        }
        if (latest == null ? void 0 : latest.usage) {
          lastUsage = normalizeUsage$1(latest.usage);
        }
      }
    } catch {
    }
    const usage = usageFromResult ?? lastUsage;
    if (usage) {
      yield { type: "usage", usage, cost, modelId };
    }
    if (chatMode === "plan") {
      const steps = extractPlanSteps(text);
      if (steps) yield { type: "plan", steps };
    } else if (chatMode === "agent") {
      const proposed = extractPropose(text, input.target);
      if (proposed) {
        if (isAborted(input.signal)) {
          yield { type: "status", status: "cancelled", detail: "Stopped" };
          return;
        }
        yield { type: "status", status: "waiting-approval" };
        yield { type: "propose", action: proposed };
      }
    }
    yield { type: "status", status: "done" };
  } finally {
    (_e = input.signal) == null ? void 0 : _e.removeEventListener("abort", cancelRun);
    agent.close();
  }
}
function normalizeUsage$1(usage) {
  if (!usage) return void 0;
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    reasoningTokens: usage.reasoningTokens
  };
}
async function* runLocalProposer(input) {
  if (isAborted(input.signal)) {
    yield { type: "status", status: "cancelled", detail: "Stopped" };
    return;
  }
  const mode = input.chatMode ?? "agent";
  if (mode === "ask") {
    yield {
      type: "text",
      text: "Ask mode (local fallback): I can only answer in text here. Set a Cursor API key for full Ask replies.\n"
    };
    yield { type: "status", status: "done" };
    return;
  }
  if (mode === "plan") {
    yield {
      type: "text",
      text: "Plan mode (local fallback):\n1. Inspect current shell context\n2. Identify the failing step\n3. Propose a minimal fix\n4. Verify with a read-only check\n"
    };
    yield {
      type: "plan",
      steps: [
        "Inspect current shell context",
        "Identify the failing step",
        "Propose a minimal fix",
        "Verify with a read-only check"
      ]
    };
    yield { type: "status", status: "done" };
    return;
  }
  yield {
    type: "text",
    text: "Local proposer (SDK unavailable). Suggesting a safe read-only command.\n"
  };
  const cmd = guessReadonlyCommand(input.message);
  const action = {
    id: newId(),
    target: input.target,
    effect: classifyCommand(cmd),
    summary: `Investigate: ${input.message.slice(0, 80)}`,
    command: cmd,
    reason: "local fallback proposer"
  };
  yield { type: "status", status: "waiting-approval" };
  yield { type: "propose", action };
  yield { type: "status", status: "done" };
}
function extractPropose(text, target) {
  var _a, _b, _c, _d;
  const match = text.match(/```propose\s*([\s\S]*?)```/i);
  if (!match) return null;
  const body = match[1];
  const summary = ((_b = (_a = body.match(/summary:\s*(.+)/i)) == null ? void 0 : _a[1]) == null ? void 0 : _b.trim()) || "Proposed command";
  const command = (_d = (_c = body.match(/command:\s*(.+)/i)) == null ? void 0 : _c[1]) == null ? void 0 : _d.trim();
  if (!command) return null;
  return {
    id: newId(),
    target,
    effect: classifyCommand(command),
    summary,
    command
  };
}
function guessReadonlyCommand(message) {
  const m = message.toLowerCase();
  if (m.includes("port")) return "lsof -nP -iTCP -sTCP:LISTEN | head -n 40";
  if (m.includes("disk")) return "df -h";
  if (m.includes("process") || m.includes("cpu")) return "ps aux | head -n 30";
  if (m.includes("git")) return "git status -sb";
  return "pwd && ls -la";
}
function classifyToolName(name) {
  const n = name.toLowerCase();
  if (n.includes("grep") || n.includes("search") || n.includes("find") || n.includes("glob")) {
    return "search";
  }
  if (n.includes("edit") || n.includes("write") || n.includes("apply") || n.includes("patch") || n.includes("strreplace")) {
    return "edit";
  }
  if (n.includes("shell") || n.includes("bash") || n.includes("exec") || n.includes("terminal") || n.includes("command")) {
    return "command";
  }
  if (n.includes("read") || n.includes("cat") || n.includes("open")) {
    return "read";
  }
  return "other";
}
function toolTitle(kind, name, status) {
  const running = status === "running";
  switch (kind) {
    case "search":
      return running ? "Searching" : "Searched";
    case "edit":
      return running ? "Editing" : "Edited";
    case "command":
      return running ? "Running command" : "Ran command";
    case "read":
      return running ? "Reading" : "Read";
    default:
      return running ? name : `${name} done`;
  }
}
function toolDetail(args) {
  if (!args || typeof args !== "object") return void 0;
  const o = args;
  for (const key of [
    "command",
    "cmd",
    "query",
    "pattern",
    "path",
    "file_path",
    "filePath",
    "target_file",
    "relative_workspace_path"
  ]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 140);
  }
  return void 0;
}
function cursorStateDbPath() {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library/Application Support/Cursor/User/globalStorage/state.vscdb"
    );
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (!appData) return null;
    return path.join(appData, "Cursor/User/globalStorage/state.vscdb");
  }
  return path.join(
    os.homedir(),
    ".config/Cursor/User/globalStorage/state.vscdb"
  );
}
async function readSqliteValueNative(dbPath, key) {
  try {
    const mod = await import("node:sqlite");
    const db = new mod.DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare(
        "SELECT value FROM ItemTable WHERE key = ?"
      ).get(key);
      const value = row == null ? void 0 : row.value;
      if (typeof value === "string" && value.trim()) return value.trim();
      if (value != null && typeof value !== "string") {
        const asText = String(value).trim();
        return asText || null;
      }
      return null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
function readSqliteValueViaCli(dbPath, key) {
  return new Promise((resolve) => {
    const sql = `SELECT value FROM ItemTable WHERE key = '${key.replace(/'/g, "''")}';`;
    const child = node_child_process.spawn("sqlite3", [dbPath, sql], {
      env: process.env,
      windowsHide: true
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString("utf8");
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const value = out.trim();
      resolve(value || null);
    });
  });
}
async function readSqliteValue(dbPath, key) {
  if (!node_fs.existsSync(dbPath)) return null;
  const native = await readSqliteValueNative(dbPath, key);
  if (native != null) return native;
  return readSqliteValueViaCli(dbPath, key);
}
async function readCursorAccessToken() {
  const db = cursorStateDbPath();
  if (!db) return null;
  return readSqliteValue(db, "cursorAuth/accessToken");
}
function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}
function msToIso(value) {
  const n = asNumber(value);
  if (n != null && n > 0) return new Date(n).toISOString();
  if (typeof value === "string" && value.includes("T")) return value;
  return null;
}
function normalizeUsage(raw) {
  var _a, _b, _c;
  const planUsage = raw.planUsage ?? ((_a = raw.individualUsage) == null ? void 0 : _a.plan) ?? null;
  const apiPercentUsed = asNumber(planUsage == null ? void 0 : planUsage.apiPercentUsed);
  const totalPercentUsed = asNumber(planUsage == null ? void 0 : planUsage.totalPercentUsed);
  const used = totalPercentUsed ?? apiPercentUsed ?? (() => {
    const usedAmt = asNumber(planUsage == null ? void 0 : planUsage.used);
    const limit = asNumber(planUsage == null ? void 0 : planUsage.limit);
    if (usedAmt != null && limit != null && limit > 0) {
      return usedAmt / limit * 100;
    }
    const remaining = asNumber(planUsage == null ? void 0 : planUsage.remaining);
    if (remaining != null && limit != null && limit > 0) {
      return (limit - remaining) / limit * 100;
    }
    return null;
  })();
  if (used == null || !Number.isFinite(used)) return null;
  const remainingPercent = Math.max(0, Math.min(100, Math.round(100 - used)));
  const membershipType = typeof raw.membershipType === "string" && raw.membershipType || typeof ((_b = raw.planInfo) == null ? void 0 : _b.planName) === "string" && raw.planInfo.planName || null;
  return {
    usedPercent: Math.max(0, used),
    remainingPercent,
    apiPercentUsed,
    totalPercentUsed,
    membershipType,
    resetAt: msToIso(raw.billingCycleEnd) || msToIso((_c = raw.planInfo) == null ? void 0 : _c.billingCycleEnd),
    displayMessage: typeof raw.displayMessage === "string" && raw.displayMessage || typeof raw.namedModelSelectedDisplayMessage === "string" && raw.namedModelSelectedDisplayMessage || null
  };
}
async function fetchJson(url, init) {
  try {
    const res = await fetch(url, init);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data !== "object") return null;
    return data;
  } catch {
    return null;
  }
}
async function fetchWithToken(token) {
  const connect = await fetchJson(
    "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1"
      },
      body: "{}"
    }
  );
  if (connect) {
    const normalized = normalizeUsage(connect);
    if (normalized) return normalized;
  }
  const summary = await fetchJson("https://cursor.com/api/usage-summary", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  });
  if (summary) {
    const normalized = normalizeUsage(summary);
    if (normalized) return normalized;
  }
  return null;
}
async function fetchCursorAccountUsage(apiKey) {
  const tokens = [];
  const key = apiKey == null ? void 0 : apiKey.trim();
  if (key) tokens.push(key);
  const desktopToken = await readCursorAccessToken();
  if (desktopToken && !tokens.includes(desktopToken)) tokens.push(desktopToken);
  for (const token of tokens) {
    const usage = await fetchWithToken(token);
    if (usage) return usage;
  }
  return null;
}
function meetingsRoot() {
  return path.join(electron.app.getPath("userData"), "drift", "meetings");
}
function meetingDir(id) {
  return path.join(meetingsRoot(), id);
}
async function ensureRoot() {
  await promises.mkdir(meetingsRoot(), { recursive: true });
}
async function readJson(file) {
  try {
    return JSON.parse(await promises.readFile(file, "utf8"));
  } catch {
    return null;
  }
}
async function writeText(file, content) {
  await promises.writeFile(file, content, "utf8");
}
async function readText(file) {
  try {
    return await promises.readFile(file, "utf8");
  } catch {
    return "";
  }
}
function defaultTitle(when = /* @__PURE__ */ new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `Meeting ${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`;
}
async function refreshFlags(meta) {
  const dir = meetingDir(meta.id);
  const next = {
    ...meta,
    hasAudio: false,
    hasTranscript: false,
    hasNotes: false,
    hasSummary: false
  };
  try {
    const files = await promises.readdir(dir);
    next.hasAudio = files.includes("audio.webm");
    next.hasTranscript = files.includes("transcript.txt");
    next.hasNotes = files.includes("notes.md");
    next.hasSummary = files.includes("summary.md");
  } catch {
  }
  return next;
}
async function listMeetings() {
  await ensureRoot();
  const ids = await promises.readdir(meetingsRoot()).catch(() => []);
  const items = [];
  for (const id of ids) {
    const meta = await readJson(path.join(meetingDir(id), "meta.json"));
    if (meta) items.push(await refreshFlags(meta));
  }
  items.sort((a, b) => {
    const byUpdated = b.updatedAt.localeCompare(a.updatedAt);
    if (byUpdated !== 0) return byUpdated;
    return b.createdAt.localeCompare(a.createdAt);
  });
  return items;
}
async function createMeeting(title) {
  await ensureRoot();
  const id = newId();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const dir = meetingDir(id);
  await promises.mkdir(dir, { recursive: true });
  const meta = {
    id,
    title: (title == null ? void 0 : title.trim()) || defaultTitle(),
    createdAt: now,
    updatedAt: now,
    durationMs: 0,
    status: "idle",
    hasAudio: false,
    hasTranscript: false,
    hasNotes: false,
    hasSummary: false
  };
  await writeText(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  await writeText(path.join(dir, "transcript.txt"), "");
  await writeText(path.join(dir, "notes.md"), "");
  await writeText(path.join(dir, "summary.md"), "");
  return {
    meta,
    transcript: "",
    notes: "",
    summary: "",
    audioPath: null
  };
}
async function getMeeting(id) {
  const dir = meetingDir(id);
  const meta = await readJson(path.join(dir, "meta.json"));
  if (!meta) return null;
  const refreshed = await refreshFlags(meta);
  return {
    meta: refreshed,
    transcript: await readText(path.join(dir, "transcript.txt")),
    notes: await readText(path.join(dir, "notes.md")),
    summary: await readText(path.join(dir, "summary.md")),
    audioPath: refreshed.hasAudio ? path.join(dir, "audio.webm") : null
  };
}
async function saveMeeting(id, patch) {
  var _a;
  const current = await getMeeting(id);
  if (!current) return null;
  const dir = meetingDir(id);
  const meta = {
    ...current.meta,
    title: ((_a = patch.title) == null ? void 0 : _a.trim()) || current.meta.title,
    durationMs: patch.durationMs != null ? patch.durationMs : current.meta.durationMs,
    status: patch.status ?? current.meta.status,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  if (patch.transcript != null) {
    await writeText(path.join(dir, "transcript.txt"), patch.transcript);
  }
  if (patch.notes != null) {
    await writeText(path.join(dir, "notes.md"), patch.notes);
  }
  if (patch.summary != null) {
    await writeText(path.join(dir, "summary.md"), patch.summary);
  }
  const refreshed = await refreshFlags(meta);
  await writeText(path.join(dir, "meta.json"), JSON.stringify(refreshed, null, 2));
  return getMeeting(id);
}
async function saveMeetingAudio(id, data) {
  const current = await getMeeting(id);
  if (!current) return null;
  const dir = meetingDir(id);
  await promises.writeFile(path.join(dir, "audio.webm"), Buffer.from(data));
  return saveMeeting(id, { status: "done" });
}
async function deleteMeeting(id) {
  await promises.rm(meetingDir(id), { recursive: true, force: true });
  return { ok: true };
}
async function exportMeeting(id, parentWindow) {
  const meeting = await getMeeting(id);
  if (!meeting) return { ok: false, error: "Meeting not found" };
  const safeTitle = meeting.meta.title.replace(/[\\/:*?"<>|]+/g, "-").trim().slice(0, 80);
  const result = parentWindow ? await electron.dialog.showSaveDialog(parentWindow, {
    title: "Export meeting",
    defaultPath: safeTitle || `meeting-${id.slice(0, 8)}`,
    buttonLabel: "Export",
    properties: ["createDirectory", "showOverwriteConfirmation"]
  }) : await electron.dialog.showSaveDialog({
    title: "Export meeting",
    defaultPath: safeTitle || `meeting-${id.slice(0, 8)}`,
    buttonLabel: "Export",
    properties: ["createDirectory", "showOverwriteConfirmation"]
  });
  if (result.canceled || !result.filePath) {
    return { ok: false, canceled: true };
  }
  const dest = result.filePath;
  await promises.mkdir(dest, { recursive: true });
  const dir = meetingDir(id);
  const copies = [
    ["meta.json", "meta.json"],
    ["transcript.txt", "transcript.txt"],
    ["notes.md", "notes.md"],
    ["summary.md", "summary.md"]
  ];
  if (meeting.meta.hasAudio) {
    copies.push(["audio.webm", "audio.webm"]);
  }
  for (const [srcName, destName] of copies) {
    try {
      await promises.copyFile(path.join(dir, srcName), path.join(dest, destName));
    } catch {
    }
  }
  const bundle = [
    `# ${meeting.meta.title}`,
    "",
    `Created: ${meeting.meta.createdAt}`,
    `Duration: ${Math.round(meeting.meta.durationMs / 1e3)}s`,
    "",
    "## Summary",
    "",
    meeting.summary.trim() || "_(no summary)_",
    "",
    "## Notes",
    "",
    meeting.notes.trim() || "_(no notes)_",
    "",
    "## Transcript",
    "",
    meeting.transcript.trim() || "_(no transcript)_",
    ""
  ].join("\n");
  await writeText(path.join(dest, "meeting.md"), bundle);
  return { ok: true, path: dest };
}
const CHECK_DELAY_MS = 4e3;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1e3;
const GITHUB_OWNER = "doob9p";
const GITHUB_REPO = "drift-app";
let started = false;
let downloadedVersion = null;
let pendingInfo = null;
let downloadedZipPath = null;
function dismissedPath() {
  return path.join(electron.app.getPath("userData"), "drift", "update-dismissed.json");
}
function readDismissed() {
  try {
    const file = dismissedPath();
    if (!node_fs.existsSync(file)) return {};
    return JSON.parse(node_fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}
function writeDismissed(version) {
  const file = dismissedPath();
  node_fs.mkdirSync(path.dirname(file), { recursive: true });
  node_fs.writeFileSync(file, JSON.stringify({ version }), "utf8");
}
function toPlainReleaseNotes(raw) {
  const parts = [];
  if (typeof raw === "string") {
    parts.push(raw);
  } else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string") parts.push(item);
      else if (item && typeof item === "object" && "note" in item) {
        const note = item.note;
        if (typeof note === "string") parts.push(note);
      }
    }
  }
  const joined = parts.join("\n").trim();
  if (!joined) return null;
  const text = joined.replace(/<\s*br\s*\/?\s*>/gi, "\n").replace(/<\/\s*p\s*>/gi, "\n").replace(/<\/\s*div\s*>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").split("\n").filter((line) => !/^\s*Co-authored-by:/i.test(line)).join("\n").trim();
  return text || null;
}
function clearDismissed() {
  const file = dismissedPath();
  node_fs.mkdirSync(path.dirname(file), { recursive: true });
  node_fs.writeFileSync(file, JSON.stringify({}), "utf8");
}
function send(win, channel, payload) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send(channel, payload);
}
function appBundlePath() {
  return path.resolve(process.execPath, "../../..");
}
function pickMacZip(info) {
  const files = info.files ?? [];
  const zip = files.find((f) => /\.zip$/i.test(f.url)) ?? (/\.zip$/i.test(info.path ?? "") ? { url: info.path, sha512: info.sha512, size: void 0 } : void 0);
  if (!(zip == null ? void 0 : zip.url) || !zip.sha512) {
    throw new Error("No macOS zip asset found in update feed");
  }
  const fileName = path.basename(zip.url);
  return { fileName, sha512: zip.sha512, size: zip.size };
}
function releaseAssetUrl(version, fileName) {
  return `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/v${version}/${fileName}`;
}
async function sha512File(filePath) {
  const hash = node_crypto.createHash("sha512");
  const { createReadStream } = await import("node:fs");
  await promises$1.pipeline(createReadStream(filePath), hash);
  return hash.digest("base64");
}
async function downloadToFile(url, dest, onProgress) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (${res.status})`);
  }
  const total = Number(res.headers.get("content-length") || 0);
  let transferred = 0;
  let lastTs = Date.now();
  let lastBytes = 0;
  await promises.mkdir(path.dirname(dest), { recursive: true });
  const partial = `${dest}.partial`;
  const nodeStream = node_stream.Readable.fromWeb(res.body);
  nodeStream.on("data", (chunk) => {
    transferred += chunk.length;
    const now = Date.now();
    const dt = Math.max(1, now - lastTs);
    const bytesPerSecond = (transferred - lastBytes) * 1e3 / dt;
    if (now - lastTs >= 200 || transferred === total) {
      lastTs = now;
      lastBytes = transferred;
      onProgress({
        percent: total > 0 ? transferred / total * 100 : 0,
        bytesPerSecond,
        transferred,
        total
      });
    }
  });
  await promises$1.pipeline(nodeStream, node_fs.createWriteStream(partial));
  node_fs.renameSync(partial, dest);
}
async function downloadMacUpdate(getWindow) {
  if (!pendingInfo) {
    throw new Error("No pending update");
  }
  const version = pendingInfo.version;
  const { fileName, sha512 } = pickMacZip(pendingInfo);
  const url = releaseAssetUrl(version, fileName);
  const dest = path.join(
    electron.app.getPath("temp"),
    "drift-updates",
    `Drift-${version}-mac-arm64.zip`
  );
  if (node_fs.existsSync(dest)) {
    node_fs.rmSync(dest, { force: true });
  }
  await downloadToFile(url, dest, (progress) => {
    send(getWindow(), "updater:progress", progress);
  });
  const actual = await sha512File(dest);
  if (actual !== sha512) {
    node_fs.rmSync(dest, { force: true });
    throw new Error("Update archive checksum mismatch");
  }
  downloadedZipPath = dest;
  downloadedVersion = version;
  clearDismissed();
  send(getWindow(), "updater:downloaded", {
    version,
    currentVersion: electron.app.getVersion()
  });
}
async function installMacUpdate() {
  if (!downloadedZipPath || !node_fs.existsSync(downloadedZipPath)) {
    throw new Error("Update archive missing — download again");
  }
  const appPath = appBundlePath();
  if (!appPath.endsWith(".app") || !node_fs.existsSync(appPath)) {
    throw new Error(`Cannot locate Drift.app (${appPath})`);
  }
  const work = await promises.mkdtemp(path.join(os.tmpdir(), "drift-install-"));
  const scriptPath = path.join(work, "install.sh");
  const logPath = path.join(electron.app.getPath("logs"), "drift-update.log");
  const script = `#!/bin/bash
set -euo pipefail
APP_PATH=${JSON.stringify(appPath)}
ZIP_PATH=${JSON.stringify(downloadedZipPath)}
LOG=${JSON.stringify(logPath)}
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) install start"

# Wait until this Drift process exits (and release file locks).
for i in $(seq 1 60); do
  if ! pgrep -f "$APP_PATH/Contents/MacOS/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
sleep 1

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# ditto preserves macOS metadata / symlinks better than unzip.
ditto -x -k "$ZIP_PATH" "$TMP"
NEW_APP=$(find "$TMP" -maxdepth 2 -name "*.app" -print | head -n 1)
if [ -z "$NEW_APP" ] || [ ! -d "$NEW_APP" ]; then
  echo "no .app in zip"
  exit 1
fi

BACKUP="\${APP_PATH}.drift-bak"
rm -rf "$BACKUP"
mv "$APP_PATH" "$BACKUP"
if ! mv "$NEW_APP" "$APP_PATH"; then
  mv "$BACKUP" "$APP_PATH"
  echo "replace failed; restored backup"
  exit 1
fi

# Unsigned builds: clear quarantine so Gatekeeper does not block relaunch.
xattr -cr "$APP_PATH" || true
rm -rf "$BACKUP"
rm -f "$ZIP_PATH"
open "$APP_PATH"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) install done"
`;
  await promises.writeFile(scriptPath, script, { mode: 493 });
  await promises.chmod(scriptPath, 493);
  const child = node_child_process.spawn("/bin/bash", [scriptPath], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  setTimeout(() => electron.app.quit(), 300);
}
function initAutoUpdater(getWindow) {
  if (started) return;
  started = true;
  electron.ipcMain.handle("updater:get-version", () => ({
    version: electron.app.getVersion(),
    packaged: electron.app.isPackaged
  }));
  electron.ipcMain.handle("updater:check", async () => {
    var _a;
    if (!electron.app.isPackaged) return { ok: false, reason: "dev" };
    try {
      const result = await electronUpdater.autoUpdater.checkForUpdates();
      return {
        ok: true,
        versionInfo: ((_a = result == null ? void 0 : result.updateInfo) == null ? void 0 : _a.version) ?? null
      };
    } catch (err) {
      return {
        ok: false,
        reason: "error",
        message: err instanceof Error ? err.message : String(err)
      };
    }
  });
  electron.ipcMain.handle("updater:download", async () => {
    if (!electron.app.isPackaged) return { ok: false, reason: "dev" };
    try {
      if (process.platform === "darwin") {
        await downloadMacUpdate(getWindow);
      } else {
        await electronUpdater.autoUpdater.downloadUpdate();
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        reason: "error",
        message: err instanceof Error ? err.message : String(err)
      };
    }
  });
  electron.ipcMain.handle("updater:install", async () => {
    if (!electron.app.isPackaged) return { ok: false, reason: "dev" };
    try {
      if (process.platform === "darwin") {
        await installMacUpdate();
        return { ok: true, version: downloadedVersion };
      }
      electronUpdater.autoUpdater.quitAndInstall(false, true);
      return { ok: true, version: downloadedVersion };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send(getWindow(), "updater:error", { message });
      return {
        ok: false,
        reason: "error",
        message
      };
    }
  });
  electron.ipcMain.handle("updater:dismiss", (_e, version) => {
    if (typeof version === "string" && version.length > 0) {
      writeDismissed(version);
    }
    return { ok: true };
  });
  if (!electron.app.isPackaged) return;
  electronUpdater.autoUpdater.autoDownload = false;
  electronUpdater.autoUpdater.autoInstallOnAppQuit = process.platform !== "darwin";
  electronUpdater.autoUpdater.allowPrerelease = false;
  electronUpdater.autoUpdater.on("update-available", (info) => {
    pendingInfo = info;
    const dismissed = readDismissed();
    if (dismissed.version && dismissed.version === info.version) {
      return;
    }
    const payload = {
      version: info.version,
      currentVersion: electron.app.getVersion(),
      releaseName: info.releaseName,
      releaseNotes: toPlainReleaseNotes(info.releaseNotes)
    };
    send(getWindow(), "updater:available", payload);
  });
  electronUpdater.autoUpdater.on("download-progress", (progress) => {
    if (process.platform === "darwin") return;
    const payload = {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total
    };
    send(getWindow(), "updater:progress", payload);
  });
  electronUpdater.autoUpdater.on("update-downloaded", (info) => {
    if (process.platform === "darwin") return;
    downloadedVersion = info.version;
    clearDismissed();
    send(getWindow(), "updater:downloaded", {
      version: info.version,
      currentVersion: electron.app.getVersion()
    });
  });
  electronUpdater.autoUpdater.on("error", (err) => {
    send(getWindow(), "updater:error", {
      message: (err == null ? void 0 : err.message) || String(err)
    });
  });
  const runCheck = () => {
    void electronUpdater.autoUpdater.checkForUpdates().catch(() => {
    });
  };
  setTimeout(runCheck, CHECK_DELAY_MS);
  setInterval(runCheck, CHECK_INTERVAL_MS);
}
const SCROLLBACK_MAX_CHARS = 48e3;
const AGENT_TAIL_MAX_CHARS = 8e3;
function stripAnsi(s) {
  return s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, "").replace(/\x1b./g, "");
}
function appendScrollback(tab, data) {
  tab.scrollback += data;
  if (tab.scrollback.length > SCROLLBACK_MAX_CHARS) {
    tab.scrollback = tab.scrollback.slice(-SCROLLBACK_MAX_CHARS);
  }
}
function terminalTailForAgent(tab) {
  const plain = stripAnsi(tab.scrollback).replace(/\r/g, "");
  if (plain.length <= AGENT_TAIL_MAX_CHARS) return plain.trimEnd();
  return plain.slice(-AGENT_TAIL_MAX_CHARS).replace(/^[^\n]*\n/, "").trimEnd();
}
let cwdPollTimer = null;
let mainWindow = null;
let sessionStore;
const tabs = /* @__PURE__ */ new Map();
const policy = new ApprovalPolicy("ask");
const pendingApprovals = /* @__PURE__ */ new Map();
const activeAgentRuns = /* @__PURE__ */ new Map();
let appSettings = {
  modelId: "composer-2.5",
  chatMode: "agent",
  locale: "ko"
};
function stopAgentRuns(runId) {
  const stopped = [];
  for (const [id, pending] of [...pendingApprovals.entries()]) {
    if (runId && id !== runId) continue;
    pendingApprovals.delete(id);
    pending.resolve({ type: "deny", feedback: "Stopped by user" });
    if (!stopped.includes(id)) stopped.push(id);
  }
  for (const [id, controller] of [...activeAgentRuns.entries()]) {
    if (runId && id !== runId) continue;
    if (!controller.signal.aborted) controller.abort();
    if (!stopped.includes(id)) stopped.push(id);
  }
  return { stopped };
}
function applyChatModeToPolicy(mode) {
  policy.mode = mode === "ask" ? "read-only" : "ask";
  if (mode !== "agent") {
    policy.sessionRules = [];
  }
}
let sessionUsage = emptySessionUsage();
function emptySessionUsage() {
  return {
    turns: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0
    },
    cost: { rawCostCents: 0, chargedCents: 0 }
  };
}
function dataDir() {
  return path.join(electron.app.getPath("userData"), "drift");
}
function brandAsset(...parts) {
  return path.join(__dirname, "../resources/brand", ...parts);
}
function loadAppIcon() {
  const candidates = [
    brandAsset("icon.icns"),
    brandAsset("icon.png")
  ];
  for (const file of candidates) {
    if (!node_fs.existsSync(file)) continue;
    const image = electron.nativeImage.createFromPath(file);
    if (!image.isEmpty()) return image;
  }
  return void 0;
}
function apiKeyPath() {
  return path.join(dataDir(), "api-key.bin");
}
function settingsPath() {
  return path.join(dataDir(), "settings.json");
}
async function loadApiKey() {
  try {
    const { readFile: rf } = await import("node:fs/promises");
    const buf = await rf(apiKeyPath());
    if (electron.safeStorage.isEncryptionAvailable()) {
      return electron.safeStorage.decryptString(buf);
    }
    return buf.toString("utf8");
  } catch {
    return "";
  }
}
async function saveApiKey(key) {
  const { mkdir: mkdir2, writeFile: writeFile2 } = await import("node:fs/promises");
  await mkdir2(dataDir(), { recursive: true });
  if (electron.safeStorage.isEncryptionAvailable()) {
    await writeFile2(apiKeyPath(), electron.safeStorage.encryptString(key));
  } else {
    await writeFile2(apiKeyPath(), key, "utf8");
  }
}
async function clearApiKey() {
  const { unlink } = await import("node:fs/promises");
  try {
    await unlink(apiKeyPath());
  } catch {
  }
}
function normalizeChatMode(value) {
  return value === "ask" || value === "plan" || value === "agent" ? value : "agent";
}
function normalizeLocale(value) {
  return value === "en" ? "en" : "ko";
}
async function loadSettings() {
  var _a;
  try {
    const raw = await promises.readFile(settingsPath(), "utf8");
    const parsed = JSON.parse(raw);
    return {
      modelId: ((_a = parsed.modelId) == null ? void 0 : _a.trim()) || "composer-2.5",
      chatMode: normalizeChatMode(parsed.chatMode),
      locale: normalizeLocale(parsed.locale)
    };
  } catch {
    return {
      modelId: "composer-2.5",
      chatMode: "agent",
      locale: "ko"
    };
  }
}
async function saveSettings(next) {
  const { mkdir: mkdir2, writeFile: writeFile2 } = await import("node:fs/promises");
  await mkdir2(dataDir(), { recursive: true });
  appSettings = next;
  await writeFile2(settingsPath(), JSON.stringify(next, null, 2), "utf8");
}
function addUsage(usage, cost) {
  sessionUsage = {
    turns: sessionUsage.turns + 1,
    usage: {
      inputTokens: sessionUsage.usage.inputTokens + usage.inputTokens,
      outputTokens: sessionUsage.usage.outputTokens + usage.outputTokens,
      cacheReadTokens: sessionUsage.usage.cacheReadTokens + usage.cacheReadTokens,
      cacheWriteTokens: sessionUsage.usage.cacheWriteTokens + usage.cacheWriteTokens,
      totalTokens: sessionUsage.usage.totalTokens + usage.totalTokens,
      reasoningTokens: (sessionUsage.usage.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0)
    },
    cost: {
      rawCostCents: sessionUsage.cost.rawCostCents + ((cost == null ? void 0 : cost.rawCostCents) ?? 0),
      chargedCents: sessionUsage.cost.chargedCents + ((cost == null ? void 0 : cost.chargedCents) ?? 0)
    }
  };
  return sessionUsage;
}
function sendShortcut(action, payload) {
  mainWindow == null ? void 0 : mainWindow.webContents.send("app:shortcut", { action, ...payload });
}
function setWindowZoom(factor) {
  const wc = mainWindow == null ? void 0 : mainWindow.webContents;
  if (!wc) return;
  const next = Math.min(2, Math.max(0.5, factor));
  wc.setZoomFactor(next);
  sendShortcut("refit-terminals");
}
function nudgeWindowZoom(delta) {
  const wc = mainWindow == null ? void 0 : mainWindow.webContents;
  if (!wc) return;
  setWindowZoom(wc.getZoomFactor() + delta);
}
function buildApplicationMenu() {
  const isMac = process.platform === "darwin";
  const tabItems = [];
  for (let i = 1; i <= 9; i++) {
    tabItems.push({
      label: `Tab ${i}`,
      accelerator: `CmdOrCtrl+${i}`,
      click: () => sendShortcut("focus-tab", { index: i - 1 })
    });
  }
  const fileMenu = {
    label: "File",
    submenu: [
      {
        label: "Save",
        accelerator: "CmdOrCtrl+S",
        click: () => sendShortcut("save")
      },
      {
        label: "Find",
        accelerator: "CmdOrCtrl+F",
        click: () => sendShortcut("find")
      },
      { type: "separator" },
      {
        label: "Close Tab",
        accelerator: "CmdOrCtrl+W",
        click: () => sendShortcut("close-tab")
      }
    ]
  };
  const editMenu = {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      ...isMac ? [{ role: "pasteAndMatchStyle" }] : [],
      { role: "delete" },
      { role: "selectAll" },
      { type: "separator" },
      {
        label: "Toggle Line Comment",
        accelerator: "CmdOrCtrl+/",
        click: () => sendShortcut("toggle-comment")
      }
    ]
  };
  const shellMenu = {
    label: "Shell",
    submenu: [
      {
        label: "New Local Terminal",
        accelerator: "CmdOrCtrl+T",
        click: () => sendShortcut("new-local")
      },
      { type: "separator" },
      {
        label: "Clear Scrollback",
        accelerator: "CmdOrCtrl+K",
        click: () => sendShortcut("clear")
      },
      { type: "separator" },
      {
        label: "Previous Tab",
        accelerator: "CmdOrCtrl+Shift+[",
        click: () => sendShortcut("prev-tab")
      },
      {
        label: "Next Tab",
        accelerator: "CmdOrCtrl+Shift+]",
        click: () => sendShortcut("next-tab")
      },
      { type: "separator" },
      ...tabItems
    ]
  };
  const viewMenu = {
    label: "View",
    submenu: [
      {
        label: "Actual Size",
        accelerator: "CmdOrCtrl+0",
        click: () => setWindowZoom(1)
      },
      {
        label: "Zoom In",
        accelerator: "CmdOrCtrl+=",
        click: () => nudgeWindowZoom(0.1)
      },
      {
        label: "Zoom Out",
        accelerator: "CmdOrCtrl+-",
        click: () => nudgeWindowZoom(-0.1)
      },
      { type: "separator" },
      { role: "reload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "togglefullscreen" }
    ]
  };
  const template = [
    ...isMac ? [
      {
        label: "Drift",
        submenu: [
          { role: "about" },
          { type: "separator" },
          {
            label: "Settings…",
            accelerator: "CmdOrCtrl+,",
            click: () => sendShortcut("settings")
          },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" }
        ]
      }
    ] : [
      {
        label: "Drift",
        submenu: [
          {
            label: "Settings…",
            accelerator: "CmdOrCtrl+,",
            click: () => sendShortcut("settings")
          },
          { type: "separator" },
          { role: "quit" }
        ]
      }
    ],
    fileMenu,
    editMenu,
    shellMenu,
    viewMenu,
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...isMac ? [{ type: "separator" }, { role: "front" }] : [{ role: "close" }]
      ]
    }
  ];
  electron.Menu.setApplicationMenu(electron.Menu.buildFromTemplate(template));
}
function createWindow() {
  const icon = loadAppIcon();
  mainWindow = new electron.BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: "Drift",
    backgroundColor: "#0a0c10",
    ...icon ? { icon } : {},
    ...process.platform === "darwin" ? {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 14 }
    } : {},
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  electron.session.defaultSession.setPermissionRequestHandler(
    (_wc, permission, callback) => {
      callback(permission === "media");
    }
  );
  electron.session.defaultSession.setPermissionCheckHandler(
    (_wc, permission) => permission === "media"
  );
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}
function emitTabCwd(tabId, cwd) {
  const tab = tabs.get(tabId);
  if (!tab || !cwd) return;
  if (tab.lastCwd === cwd) return;
  tab.lastCwd = cwd;
  if (tab.backend && tab.backend.target.kind === "ssh" && "setCwd" in tab.backend) {
    tab.backend.setCwd(cwd);
  }
  mainWindow == null ? void 0 : mainWindow.webContents.send("term:cwd", { tabId, cwd });
}
function consumeOsc7(tab, chunk) {
  const merged = (tab.oscBuf ?? "") + chunk;
  tab.oscBuf = merged.length > 4e3 ? merged.slice(-2e3) : merged;
  const re = /\x1b\]7;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  let match;
  let lastPath = null;
  while (match = re.exec(tab.oscBuf)) {
    const path2 = osc7ToPath(match[1] ?? "");
    if (path2) lastPath = path2;
  }
  const lastBell = Math.max(
    tab.oscBuf.lastIndexOf("\x07"),
    tab.oscBuf.lastIndexOf("\x1B\\")
  );
  if (lastBell >= 0) {
    tab.oscBuf = tab.oscBuf.slice(lastBell + 1);
  }
  if (lastPath) emitTabCwd(tab.id, lastPath);
}
function normalizeFsPath(p) {
  try {
    return p.normalize("NFC");
  } catch {
    return p;
  }
}
function osc7ToPath(uri) {
  const raw = uri.trim();
  if (!raw) return null;
  try {
    if (raw.startsWith("file://")) {
      const u = new URL(raw);
      const decoded = decodeURIComponent(u.pathname || "");
      return decoded ? normalizeFsPath(decoded) : null;
    }
  } catch {
  }
  const withoutScheme = raw.replace(/^file:\/\//, "");
  const idx = withoutScheme.indexOf("/");
  if (idx >= 0) return normalizeFsPath(withoutScheme.slice(idx));
  return withoutScheme.startsWith("/") ? normalizeFsPath(withoutScheme) : null;
}
function attachBackend(tabId, backend) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const unsub = backend.onData((data) => {
    consumeOsc7(tab, data);
    appendScrollback(tab, data);
    if (!tab.ready) {
      tab.buffer.push(data);
      if (tab.buffer.length > 200) {
        tab.buffer = tab.buffer.slice(-100);
      }
      return;
    }
    mainWindow == null ? void 0 : mainWindow.webContents.send("term:data", { tabId, data });
  });
  const unsubExit = backend.onExit(({ exitCode, signal }) => {
    const msg = `\r
\x1B[90m[session ended: exit ${exitCode}` + (signal != null ? `, signal ${signal}` : "") + `]\x1B[0m\r
`;
    appendScrollback(tab, msg);
    if (!tab.ready) {
      tab.buffer.push(msg);
      return;
    }
    mainWindow == null ? void 0 : mainWindow.webContents.send("term:data", { tabId, data: msg });
  });
  tab.unsub = unsub;
  tab.unsubExit = unsubExit;
  void pollTabCwd(tabId);
  ensureCwdPolling();
}
async function pollTabCwd(tabId) {
  const tab = tabs.get(tabId);
  if (!(tab == null ? void 0 : tab.backend) || tab.backend.target.kind !== "local") return;
  try {
    const cwd = await tab.backend.getCwd();
    if (cwd) emitTabCwd(tabId, cwd);
  } catch {
  }
}
function ensureCwdPolling() {
  if (cwdPollTimer) return;
  cwdPollTimer = setInterval(() => {
    if (tabs.size === 0) {
      if (cwdPollTimer) clearInterval(cwdPollTimer);
      cwdPollTimer = null;
      return;
    }
    for (const id of tabs.keys()) {
      void pollTabCwd(id);
    }
  }, 600);
}
function emitTransferProgress(payload) {
  mainWindow == null ? void 0 : mainWindow.webContents.send("fs:transfer-progress", payload);
}
async function collectLocalCopyItems(sources, destDir) {
  const items = [];
  let total = 0;
  async function walkFile(src, dest, name) {
    const st = await promises.stat(src);
    if (st.isFile()) {
      items.push({ src, dest, size: st.size, name });
      total += st.size;
      return;
    }
    if (!st.isDirectory()) return;
    await promises.mkdir(dest, { recursive: true });
    const names = await promises.readdir(src);
    for (const child of names) {
      if (child === "." || child === "..") continue;
      await walkFile(path.join(src, child), path.join(dest, child), child);
    }
  }
  const destReal = path.resolve(destDir);
  for (const src of sources) {
    const base = path.basename(src);
    if (!base || base === "." || base === "..") continue;
    const dest = path.join(destReal, base);
    const srcResolved = path.resolve(src);
    const destResolved = path.resolve(dest);
    if (srcResolved === destReal || destResolved === srcResolved || destResolved.startsWith(srcResolved + path.sep)) {
      continue;
    }
    await walkFile(src, dest, base);
  }
  return { items, total };
}
async function copyLocalWithProgress(sources, destDir, transferId) {
  var _a;
  try {
    await promises.mkdir(destDir, { recursive: true });
    const destStat = await promises.stat(destDir);
    if (!destStat.isDirectory()) return { error: "Not a directory" };
    const destReal = path.resolve(destDir);
    const { items, total } = await collectLocalCopyItems(sources, destDir);
    if (!items.length) return { error: "No files" };
    emitTransferProgress({
      transferId,
      percent: 0,
      transferred: 0,
      total: total || 1,
      currentName: (_a = items[0]) == null ? void 0 : _a.name
    });
    let transferred = 0;
    let lastEmitAt = 0;
    const emit = (force = false, currentName) => {
      const now = Date.now();
      if (!force && now - lastEmitAt < 80) return;
      lastEmitAt = now;
      emitTransferProgress({
        transferId,
        percent: total > 0 ? Math.min(99, Math.round(transferred / total * 100)) : 0,
        transferred: Math.min(transferred, total),
        total: total || 1,
        currentName
      });
    };
    for (const item of items) {
      await promises.mkdir(path.dirname(item.dest), { recursive: true });
      if (item.size === 0) {
        await promises$1.pipeline(node_fs.createReadStream(item.src), node_fs.createWriteStream(item.dest));
        emit(true, item.name);
      } else {
        await new Promise((resolve, reject) => {
          const read = node_fs.createReadStream(item.src);
          const write = node_fs.createWriteStream(item.dest);
          read.on("data", (chunk) => {
            const n = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
            transferred += n;
            emit(false, item.name);
          });
          read.on("error", reject);
          write.on("error", reject);
          write.on("finish", () => {
            emit(true, item.name);
            resolve();
          });
          read.pipe(write);
        });
      }
    }
    emitTransferProgress({
      transferId,
      percent: 100,
      transferred: total || transferred,
      total: total || Math.max(transferred, 1)
    });
    const copied = sources.map((s) => path.join(destReal, path.basename(s))).filter(
      (dest) => items.some((i) => i.dest === dest || i.dest.startsWith(dest + path.sep))
    );
    return { ok: true, copied };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
async function readLocalDisk(mount = "/") {
  try {
    const s = await promises.statfs(mount);
    const bsize = Number(s.bsize) || 0;
    const total = Number(s.blocks) * bsize;
    const free = Number(s.bavail) * bsize;
    const used = Math.max(0, total - free);
    const diskUsedPct = total > 0 ? Math.min(100, Math.round(used / total * 100)) : 0;
    return {
      diskUsedPct,
      diskUsedBytes: used,
      diskTotalBytes: total,
      diskMount: mount
    };
  } catch {
    return {
      diskUsedPct: 0,
      diskUsedBytes: 0,
      diskTotalBytes: 0,
      diskMount: mount
    };
  }
}
async function collectLocalMetrics() {
  const cpus = os.cpus();
  const load1 = os.loadavg()[0] ?? 0;
  const cores = cpus.length || 1;
  const cpuPct = Math.min(100, Math.round(load1 / cores * 100));
  const memTotalBytes = os.totalmem();
  const memFreeBytes = os.freemem();
  const memUsedBytes = Math.max(0, memTotalBytes - memFreeBytes);
  const disk = await readLocalDisk("/");
  return {
    source: "local",
    cpuPct,
    load1,
    memUsedBytes,
    memFreeBytes,
    memTotalBytes,
    cores,
    ...disk,
    gpuPct: null,
    gpuMemPct: null,
    gpuName: null
  };
}
const REMOTE_METRICS_SCRIPT = [
  "set +e",
  "LOAD=$(awk '{print $1}' /proc/loadavg 2>/dev/null)",
  "CORES=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)",
  "MEM_TOTAL=$(awk '/^MemTotal:/ {print $2*1024}' /proc/meminfo 2>/dev/null)",
  "MEM_AVAIL=$(awk '/^MemAvailable:/ {print $2*1024}' /proc/meminfo 2>/dev/null)",
  `if [ -z "$MEM_AVAIL" ]; then MEM_AVAIL=$(awk '/^MemFree:/ {print $2*1024}' /proc/meminfo 2>/dev/null); fi`,
  `DISK=$(df -PB1 / 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $2" "$3" "$5}')`,
  "GPU=$(nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,name --format=csv,noheader,nounits 2>/dev/null | head -n 1)",
  'printf "load=%s\\n" "${LOAD:-0}"',
  'printf "cores=%s\\n" "${CORES:-1}"',
  'printf "mem_total=%s\\n" "${MEM_TOTAL:-0}"',
  'printf "mem_avail=%s\\n" "${MEM_AVAIL:-0}"',
  'printf "disk=%s\\n" "${DISK:-}"',
  'printf "gpu=%s\\n" "${GPU:-}"'
].join("; ");
function parseRemoteMetrics(stdout, hostLabel) {
  const map = /* @__PURE__ */ new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    map.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const load1 = Number(map.get("load") || 0) || 0;
  const cores = Math.max(1, Number(map.get("cores") || 1) || 1);
  const memTotalBytes = Math.max(0, Number(map.get("mem_total") || 0) || 0);
  const memFreeBytes = Math.max(0, Number(map.get("mem_avail") || 0) || 0);
  const memUsedBytes = Math.max(0, memTotalBytes - memFreeBytes);
  const cpuPct = Math.min(100, Math.round(load1 / cores * 100));
  let diskTotalBytes = 0;
  let diskUsedBytes = 0;
  let diskUsedPct = 0;
  const diskRaw = map.get("disk") || "";
  if (diskRaw) {
    const [t, u, p] = diskRaw.split(/\s+/);
    diskTotalBytes = Math.max(0, Number(t) || 0);
    diskUsedBytes = Math.max(0, Number(u) || 0);
    diskUsedPct = Math.min(100, Math.max(0, Number(p) || 0));
    if (!diskUsedPct && diskTotalBytes > 0) {
      diskUsedPct = Math.min(
        100,
        Math.round(diskUsedBytes / diskTotalBytes * 100)
      );
    }
  }
  let gpuPct = null;
  let gpuMemPct = null;
  let gpuName = null;
  const gpuRaw = map.get("gpu") || "";
  if (gpuRaw && !/error|not found|failed/i.test(gpuRaw)) {
    const parts = gpuRaw.split(",").map((s) => s.trim());
    if (parts.length >= 3) {
      const util = Number(parts[0]);
      const memUsed = Number(parts[1]);
      const memTotal = Number(parts[2]);
      if (Number.isFinite(util)) gpuPct = Math.min(100, Math.max(0, Math.round(util)));
      if (Number.isFinite(memUsed) && Number.isFinite(memTotal) && memTotal > 0) {
        gpuMemPct = Math.min(100, Math.round(memUsed / memTotal * 100));
      }
      if (parts[3]) gpuName = parts.slice(3).join(", ").trim() || null;
    }
  }
  return {
    source: "ssh",
    cpuPct,
    load1,
    memUsedBytes,
    memFreeBytes,
    memTotalBytes,
    cores,
    diskUsedPct,
    diskUsedBytes,
    diskTotalBytes,
    diskMount: "/",
    gpuPct,
    gpuMemPct,
    gpuName,
    hostLabel
  };
}
async function collectRemoteMetrics(backend) {
  const hostLabel = backend.session.name || `${backend.session.user}@${backend.session.host}`;
  try {
    const res = await backend.exec(REMOTE_METRICS_SCRIPT, {
      cwd: "~",
      timeoutMs: 8e3
    });
    if ((res.timedOut || res.exitCode !== 0) && !res.stdout.trim()) {
      return {
        source: "ssh",
        cpuPct: 0,
        load1: 0,
        memUsedBytes: 0,
        memFreeBytes: 0,
        memTotalBytes: 0,
        cores: 1,
        diskUsedPct: 0,
        diskUsedBytes: 0,
        diskTotalBytes: 0,
        diskMount: "/",
        gpuPct: null,
        gpuMemPct: null,
        gpuName: null,
        hostLabel,
        error: (res.timedOut ? "Metrics timed out" : res.stderr || `exit ${res.exitCode}`).trim().slice(0, 200)
      };
    }
    return parseRemoteMetrics(res.stdout || "", hostLabel);
  } catch (err) {
    return {
      source: "ssh",
      cpuPct: 0,
      load1: 0,
      memUsedBytes: 0,
      memFreeBytes: 0,
      memTotalBytes: 0,
      cores: 1,
      diskUsedPct: 0,
      diskUsedBytes: 0,
      diskTotalBytes: 0,
      diskMount: "/",
      gpuPct: null,
      gpuMemPct: null,
      gpuName: null,
      hostLabel,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
const EDITOR_MAX_BYTES = 15e5;
const IMAGE_MAX_BYTES = 12e6;
const IMAGE_MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".svg": "image/svg+xml"
};
function shellSingleQuote(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function imageMimeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_MIME_BY_EXT[ext] ?? null;
}
function looksBinary(buf) {
  const sample = buf.subarray(0, Math.min(buf.length, 8e3));
  if (sample.includes(0)) return true;
  let weird = 0;
  for (const b of sample) {
    if (b === 9 || b === 10 || b === 13) continue;
    if (b < 32) weird += 1;
  }
  return weird > sample.length * 0.05;
}
function toImageResult(target, mime, buf) {
  return {
    path: target,
    kind: "image",
    mime,
    dataUrl: `data:${mime};base64,${buf.toString("base64")}`
  };
}
async function readLocalTextFile(filePath) {
  const target = path.resolve((filePath || "").trim());
  if (!target) return { error: "No path" };
  try {
    const st = await promises.stat(target);
    if (!st.isFile()) return { error: "Not a file" };
    const mime = imageMimeFromPath(target);
    const maxBytes = mime ? IMAGE_MAX_BYTES : EDITOR_MAX_BYTES;
    if (st.size > maxBytes) return { error: "too_large" };
    const buf = await promises.readFile(target);
    if (mime) return toImageResult(target, mime, buf);
    if (looksBinary(buf)) return { error: "binary" };
    return { path: target, kind: "text", content: buf.toString("utf8") };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
async function writeLocalTextFile(filePath, content) {
  const target = path.resolve((filePath || "").trim());
  if (!target) return { error: "No path" };
  try {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > EDITOR_MAX_BYTES) return { error: "too_large" };
    await promises.writeFile(target, content, "utf8");
    return { ok: true, path: target };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
async function readRemoteTextFile(backend, filePath) {
  const target = (filePath || "").trim();
  if (!target) return { error: "No path" };
  const q = shellSingleQuote(target);
  const mime = imageMimeFromPath(target);
  const maxBytes = mime ? IMAGE_MAX_BYTES : EDITOR_MAX_BYTES;
  try {
    const probe = await backend.exec(
      `if [ -f ${q} ]; then wc -c < ${q}; else exit 41; fi`,
      { timeoutMs: 12e3 }
    );
    if (probe.exitCode === 41) return { error: "Not a file" };
    const size = Number((probe.stdout || "").trim());
    if (Number.isFinite(size) && size > maxBytes) {
      return { error: "too_large" };
    }
    const result = await backend.exec(`base64 < ${q}`, { timeoutMs: 3e4 });
    if (result.timedOut) return { error: "Read timed out" };
    if (result.exitCode != null && result.exitCode !== 0) {
      return {
        error: (result.stderr || "").trim() || "Read failed"
      };
    }
    const buf = Buffer.from((result.stdout || "").replace(/\s+/g, ""), "base64");
    if (mime) return toImageResult(target, mime, buf);
    if (looksBinary(buf)) return { error: "binary" };
    return { path: target, kind: "text", content: buf.toString("utf8") };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
async function writeRemoteTextFile(backend, filePath, content) {
  const target = (filePath || "").trim();
  if (!target) return { error: "No path" };
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > EDITOR_MAX_BYTES) return { error: "too_large" };
  const q = shellSingleQuote(target);
  const b64 = Buffer.from(content, "utf8").toString("base64");
  try {
    const result = await backend.exec(
      `(base64 -d 2>/dev/null || base64 -D) > ${q} <<'DRIFT_B64'
${b64}
DRIFT_B64`,
      { timeoutMs: 3e4 }
    );
    if (result.timedOut) return { error: "Write timed out" };
    if (result.exitCode != null && result.exitCode !== 0) {
      return {
        error: (result.stderr || "").trim() || "Write failed"
      };
    }
    return { ok: true, path: target };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
async function listLocalDir(dirPath) {
  const home = os.homedir();
  const target = path.resolve((dirPath == null ? void 0 : dirPath.trim()) || home);
  try {
    const info = await promises.stat(target);
    if (!info.isDirectory()) {
      return { error: "Not a directory", path: target, entries: [] };
    }
    const names = await promises.readdir(target);
    const entries = [];
    for (const name of names) {
      if (name === "." || name === "..") continue;
      const full = path.join(target, name);
      try {
        const st = await promises.stat(full);
        entries.push({
          name,
          path: full,
          kind: st.isDirectory() ? "dir" : "file",
          size: st.isDirectory() ? void 0 : st.size
        });
      } catch {
      }
    }
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name, void 0, { sensitivity: "base" });
    });
    return { path: target, home, entries };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
      path: target,
      home,
      entries: []
    };
  }
}
async function listRemoteDir(backend, dirPath) {
  const target = ((dirPath == null ? void 0 : dirPath.trim()) || "~").replace(/\n/g, "") || "~";
  const quoted = `'${target.replace(/'/g, `'"'"'`)}'`;
  const command = `cd -- ${quoted} 2>/dev/null || exit 41; printf 'CTPWD:%s\\n' "$(pwd -P 2>/dev/null || pwd)"; printf 'CTHOME:%s\\n' "$HOME"; ls -1AF 2>/dev/null || ls -1Ap 2>/dev/null || ls -1A`;
  try {
    const result = await backend.exec(command, {
      cwd: "~",
      timeoutMs: 12e3
    });
    const text = result.stdout || "";
    const errText = (result.stderr || "").trim();
    if (result.timedOut) {
      return { error: "Listing timed out", path: target, entries: [] };
    }
    if (result.exitCode === 41 || /exit 41/.test(errText)) {
      return { error: `Cannot open ${target}`, path: target, entries: [] };
    }
    if (!text.trim() && (result.exitCode == null || result.exitCode !== 0 || /Permission denied|Connection refused|Connection reset|Broken pipe|No such file/i.test(
      errText
    ))) {
      return {
        error: errText || "SSH listing failed — keep the session connected (password sessions need the live tab)",
        path: target,
        entries: []
      };
    }
    return parseRemoteLs(text, target);
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
      path: target,
      entries: []
    };
  }
}
function parseRemoteLs(text, fallbackPath) {
  const lines = text.split(/\r?\n/);
  let abs = fallbackPath;
  let home;
  const names = [];
  for (const line of lines) {
    if (line.startsWith("CTPWD:")) {
      abs = line.slice(6).trim() || abs;
      continue;
    }
    if (line.startsWith("CTHOME:")) {
      home = line.slice(7).trim() || void 0;
      continue;
    }
    if (!line || line === "." || line === "..") continue;
    if (line.startsWith("CTPWD:") || line.startsWith("CTHOME:")) continue;
    if (/^\S+@\S+[:#]/.test(line)) continue;
    names.push(line);
  }
  const entries = [];
  for (const raw of names) {
    const isDir = raw.endsWith("/");
    const name = (isDir ? raw.slice(0, -1) : raw).replace(/[*@=|]$/, "");
    if (!name || name === "." || name === "..") continue;
    const full = abs.endsWith("/") ? `${abs}${name}` : `${abs}/${name}`;
    entries.push({
      name,
      path: full,
      kind: isDir ? "dir" : "file"
    });
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, void 0, { sensitivity: "base" });
  });
  return { path: abs, home, entries };
}
function registerIpc() {
  electron.ipcMain.handle("sessions:list", async () => sessionStore.list());
  electron.ipcMain.handle(
    "sessions:save",
    async (_e, input) => sessionStore.upsert(input)
  );
  electron.ipcMain.handle(
    "sessions:delete",
    async (_e, id) => sessionStore.remove(id)
  );
  electron.ipcMain.handle("sessions:import-ssh-config", async () => {
    const configPath = path.join(os.homedir(), ".ssh", "config");
    let content = "";
    try {
      content = await promises.readFile(configPath, "utf8");
    } catch {
      return {
        sessions: sessionStore.list(),
        created: 0,
        updated: 0,
        found: 0,
        missingConfig: true
      };
    }
    const parsed = parseSshConfig(content);
    let created = 0;
    let updated = 0;
    for (const item of parsed) {
      const name = item.sshConfigHost;
      const existing = sessionStore.list().find((s) => s.sshConfigHost === name);
      await sessionStore.upsert({
        id: existing == null ? void 0 : existing.id,
        name,
        host: item.host,
        user: item.user || os.userInfo().username,
        port: item.port,
        identityFile: item.identityFile,
        proxyJump: item.proxyJump,
        sshConfigHost: item.sshConfigHost
      });
      if (existing) updated += 1;
      else created += 1;
    }
    return {
      sessions: sessionStore.list(),
      created,
      updated,
      found: parsed.length,
      missingConfig: false
    };
  });
  electron.ipcMain.handle("term:create-local-tab", async () => {
    const tabId = newId();
    const title = "Local";
    tabs.set(tabId, {
      id: tabId,
      title,
      backend: null,
      ready: false,
      buffer: [],
      scrollback: ""
    });
    return { tabId, title };
  });
  electron.ipcMain.handle(
    "term:start-local",
    async (_e, payload) => {
      const tab = tabs.get(payload.tabId);
      if (!tab) return { error: "Tab not found" };
      if (tab.backend) return { ok: true };
      try {
        const cols = Math.max(2, Math.floor(payload.cols));
        const rows = Math.max(1, Math.floor(payload.rows));
        const backend = createLocalPty({ cols, rows });
        tab.backend = backend;
        tab.lastCols = cols;
        tab.lastRows = rows;
        attachBackend(tab.id, backend);
        return { ok: true };
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err)
        };
      }
    }
  );
  electron.ipcMain.handle(
    "term:open-local",
    async (_e, size) => {
      try {
        const cols = Math.max(2, Math.floor((size == null ? void 0 : size.cols) ?? 120));
        const rows = Math.max(1, Math.floor((size == null ? void 0 : size.rows) ?? 30));
        const backend = createLocalPty({ cols, rows });
        const tabId = newId();
        const title = "Local";
        tabs.set(tabId, {
          id: tabId,
          title,
          backend,
          ready: false,
          buffer: [],
          scrollback: "",
          lastCols: cols,
          lastRows: rows
        });
        attachBackend(tabId, backend);
        return { tabId, title };
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err)
        };
      }
    }
  );
  electron.ipcMain.handle(
    "term:open-ssh",
    async (_e, sessionId, size) => {
      const session2 = sessionStore.get(sessionId);
      if (!session2) return { error: "Session not found" };
      try {
        const cols = Math.max(2, Math.floor((size == null ? void 0 : size.cols) ?? 120));
        const rows = Math.max(1, Math.floor((size == null ? void 0 : size.rows) ?? 30));
        const backend = createSshPty(session2, { cols, rows });
        const tabId = newId();
        const title = session2.name;
        tabs.set(tabId, {
          id: tabId,
          title,
          backend,
          ready: false,
          buffer: [],
          scrollback: "",
          lastCols: cols,
          lastRows: rows
        });
        attachBackend(tabId, backend);
        return {
          tabId,
          title,
          kind: "ssh",
          label: `${session2.user}@${session2.host}`
        };
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err)
        };
      }
    }
  );
  electron.ipcMain.handle("term:close", async (_e, tabId) => {
    var _a, _b, _c;
    const tab = tabs.get(tabId);
    if (!tab) return;
    (_a = tab.unsub) == null ? void 0 : _a.call(tab);
    (_b = tab.unsubExit) == null ? void 0 : _b.call(tab);
    await ((_c = tab.backend) == null ? void 0 : _c.dispose());
    tabs.delete(tabId);
  });
  electron.ipcMain.handle("term:ready", async (_e, tabId) => {
    const tab = tabs.get(tabId);
    if (!tab) return;
    tab.ready = true;
    const pending = tab.buffer.splice(0);
    for (const data of pending) {
      consumeOsc7(tab, data);
      mainWindow == null ? void 0 : mainWindow.webContents.send("term:data", { tabId, data });
    }
    void pollTabCwd(tabId);
  });
  electron.ipcMain.handle(
    "term:write",
    async (_e, payload) => {
      const tab = tabs.get(payload.tabId);
      if (!(tab == null ? void 0 : tab.backend)) return;
      tab.backend.write(payload.data);
      if (payload.data.includes("\n") || payload.data.includes("\r")) {
        setTimeout(() => void pollTabCwd(payload.tabId), 120);
        setTimeout(() => void pollTabCwd(payload.tabId), 400);
      }
    }
  );
  electron.ipcMain.handle("term:get-cwd", async (_e, tabId) => {
    const tab = tabs.get(tabId);
    if (!tab) return { cwd: null };
    if (tab.lastCwd) return { cwd: tab.lastCwd };
    if (!tab.backend) return { cwd: null };
    try {
      const cwd = await tab.backend.getCwd();
      if (cwd) emitTabCwd(tabId, cwd);
      return { cwd };
    } catch {
      return { cwd: null };
    }
  });
  electron.ipcMain.handle(
    "term:resize",
    async (_e, payload) => {
      const tab = tabs.get(payload.tabId);
      if (!(tab == null ? void 0 : tab.backend)) return;
      const cols = Math.max(2, Math.floor(payload.cols));
      const rows = Math.max(1, Math.floor(payload.rows));
      if (tab.lastCols === cols && tab.lastRows === rows) return;
      tab.lastCols = cols;
      tab.lastRows = rows;
      tab.backend.resize(cols, rows);
    }
  );
  electron.ipcMain.handle("settings:api-key-status", async () => {
    const key = await loadApiKey();
    return { hasKey: Boolean(key.trim()) };
  });
  electron.ipcMain.handle("settings:set-api-key", async (_e, key) => {
    await saveApiKey(key.trim());
    return { ok: true };
  });
  electron.ipcMain.handle("settings:clear-api-key", async () => {
    await clearApiKey();
    return { ok: true };
  });
  electron.ipcMain.handle("settings:get", async () => appSettings);
  electron.ipcMain.handle(
    "settings:set-model",
    async (_e, modelId) => {
      await saveSettings({
        ...appSettings,
        modelId: modelId.trim() || "composer-2.5"
      });
      return appSettings;
    }
  );
  electron.ipcMain.handle("settings:set-chat-mode", async (_e, chatMode) => {
    const mode = normalizeChatMode(chatMode);
    await saveSettings({ ...appSettings, chatMode: mode });
    applyChatModeToPolicy(mode);
    return appSettings;
  });
  electron.ipcMain.handle("settings:set-locale", async (_e, locale) => {
    await saveSettings({
      ...appSettings,
      locale: normalizeLocale(locale)
    });
    return appSettings;
  });
  electron.ipcMain.handle("settings:list-models", async () => {
    const apiKey = await loadApiKey();
    return listModels(apiKey);
  });
  electron.ipcMain.handle("usage:get-session", async () => sessionUsage);
  electron.ipcMain.handle("usage:reset-session", async () => {
    sessionUsage = emptySessionUsage();
    return sessionUsage;
  });
  electron.ipcMain.handle("usage:get-account", async () => {
    const apiKey = await loadApiKey();
    const usage = await fetchCursorAccountUsage(apiKey);
    return usage ? { ok: true, usage } : { ok: false };
  });
  electron.ipcMain.handle("shell:open-external", async (_e, url) => {
    if (!/^https?:\/\//i.test(url)) return { ok: false };
    await electron.shell.openExternal(url);
    return { ok: true };
  });
  electron.ipcMain.handle("fs:home", async () => os.homedir());
  electron.ipcMain.handle("metrics:local", async () => collectLocalMetrics());
  electron.ipcMain.handle("metrics:tab", async (_e, tabId) => {
    const id = typeof tabId === "string" ? tabId.trim() : "";
    if (!id) return collectLocalMetrics();
    const tab = tabs.get(id);
    if (!(tab == null ? void 0 : tab.backend)) return collectLocalMetrics();
    if (tab.backend.target.kind === "ssh" && "session" in tab.backend) {
      return collectRemoteMetrics(tab.backend);
    }
    return collectLocalMetrics();
  });
  electron.ipcMain.handle("fs:list", async (_e, dirPath) => {
    return listLocalDir(dirPath);
  });
  electron.ipcMain.handle(
    "fs:list-tab",
    async (_e, input) => {
      const tab = tabs.get(input.tabId);
      if (!(tab == null ? void 0 : tab.backend)) {
        return { error: "No tab", path: "", entries: [] };
      }
      if (tab.backend.target.kind === "local") {
        return listLocalDir(input.dirPath);
      }
      return listRemoteDir(tab.backend, input.dirPath);
    }
  );
  electron.ipcMain.handle("fs:read-file", async (_e, filePath) => {
    return readLocalTextFile(filePath);
  });
  electron.ipcMain.handle(
    "fs:write-file",
    async (_e, input) => {
      return writeLocalTextFile(input == null ? void 0 : input.path, (input == null ? void 0 : input.content) ?? "");
    }
  );
  electron.ipcMain.handle(
    "fs:read-tab-file",
    async (_e, input) => {
      const tab = tabs.get(input.tabId);
      if (!(tab == null ? void 0 : tab.backend)) return { error: "No tab" };
      if (tab.backend.target.kind === "local") {
        return readLocalTextFile(input.path);
      }
      return readRemoteTextFile(tab.backend, input.path);
    }
  );
  electron.ipcMain.handle(
    "fs:write-tab-file",
    async (_e, input) => {
      const tab = tabs.get(input.tabId);
      if (!(tab == null ? void 0 : tab.backend)) return { error: "No tab" };
      if (tab.backend.target.kind === "local") {
        return writeLocalTextFile(input.path, input.content ?? "");
      }
      return writeRemoteTextFile(tab.backend, input.path, input.content ?? "");
    }
  );
  electron.ipcMain.handle(
    "fs:copy-into",
    async (_e, input) => {
      const destDir = (input.destDir || "").trim();
      const sources = (input.sources || []).map((s) => s.trim()).filter(Boolean);
      const transferId = (input.transferId || "").trim() || newId();
      if (!destDir) return { error: "No destination" };
      if (!sources.length) return { error: "No files" };
      return copyLocalWithProgress(sources, destDir, transferId);
    }
  );
  electron.ipcMain.handle(
    "fs:upload-tab",
    async (_e, input) => {
      const tab = tabs.get(input.tabId);
      const backend = tab == null ? void 0 : tab.backend;
      if (!backend || backend.target.kind !== "ssh" || !("session" in backend)) {
        return { error: "No SSH tab" };
      }
      const destDir = (input.destDir || "").trim() || "~";
      const sources = (input.sources || []).map((s) => s.trim()).filter(Boolean);
      const transferId = (input.transferId || "").trim() || newId();
      if (!sources.length) return { error: "No files" };
      return uploadFilesViaScp(
        backend.session,
        sources,
        destDir,
        {
          onProgress: (p) => emitTransferProgress({
            transferId,
            percent: p.percent,
            transferred: p.transferred,
            total: p.total,
            currentName: p.currentName
          })
        }
      );
    }
  );
  electron.ipcMain.handle(
    "fs:download-tab",
    async (_e, input) => {
      const tab = tabs.get(input.tabId);
      const backend = tab == null ? void 0 : tab.backend;
      if (!backend || backend.target.kind !== "ssh" || !("session" in backend)) {
        return { error: "No SSH tab" };
      }
      const destDir = (input.destDir || "").trim();
      const sources = (input.sources || []).map((s) => s.trim()).filter(Boolean);
      const transferId = (input.transferId || "").trim() || newId();
      if (!destDir) return { error: "No destination" };
      if (!sources.length) return { error: "No files" };
      try {
        await promises.mkdir(destDir, { recursive: true });
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err)
        };
      }
      return downloadFilesViaScp(
        backend.session,
        sources,
        destDir,
        {
          onProgress: (p) => emitTransferProgress({
            transferId,
            percent: p.percent,
            transferred: p.transferred,
            total: p.total,
            currentName: p.currentName
          })
        }
      );
    }
  );
  electron.ipcMain.handle(
    "fs:rename",
    async (_e, input) => {
      const fromPath = (input.fromPath || "").trim();
      const toPath = (input.toPath || "").trim();
      if (!fromPath || !toPath) return { error: "Missing path" };
      if (fromPath.includes("\0") || toPath.includes("\0")) {
        return { error: "Invalid path" };
      }
      try {
        await promises.rename(fromPath, toPath);
        return { ok: true };
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err)
        };
      }
    }
  );
  electron.ipcMain.handle(
    "fs:delete",
    async (_e, input) => {
      const targetPath = (input.targetPath || "").trim();
      if (!targetPath) return { error: "Missing path" };
      if (targetPath.includes("\0")) return { error: "Invalid path" };
      try {
        await promises.rm(targetPath, { recursive: true, force: false });
        return { ok: true };
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err)
        };
      }
    }
  );
  electron.ipcMain.handle(
    "fs:rename-tab",
    async (_e, input) => {
      const tab = tabs.get(input.tabId);
      if (!(tab == null ? void 0 : tab.backend)) return { error: "No tab" };
      const fromPath = (input.fromPath || "").trim();
      const toPath = (input.toPath || "").trim();
      if (!fromPath || !toPath) return { error: "Missing path" };
      if (fromPath.includes("\0") || toPath.includes("\0")) {
        return { error: "Invalid path" };
      }
      if (tab.backend.target.kind === "local") {
        try {
          await promises.rename(fromPath, toPath);
          return { ok: true };
        } catch (err) {
          return {
            error: err instanceof Error ? err.message : String(err)
          };
        }
      }
      const q = (p) => `'${p.replace(/'/g, `'"'"'`)}'`;
      const result = await tab.backend.exec(
        `mv -- ${q(fromPath)} ${q(toPath)}`,
        { cwd: "~", timeoutMs: 3e4 }
      );
      if (result.timedOut) return { error: "Rename timed out" };
      if (result.exitCode !== 0) {
        return {
          error: (result.stderr || result.stdout || "Rename failed").trim().slice(0, 400)
        };
      }
      return { ok: true };
    }
  );
  electron.ipcMain.handle(
    "fs:delete-tab",
    async (_e, input) => {
      const tab = tabs.get(input.tabId);
      if (!(tab == null ? void 0 : tab.backend)) return { error: "No tab" };
      const targetPath = (input.targetPath || "").trim();
      if (!targetPath) return { error: "Missing path" };
      if (targetPath.includes("\0")) return { error: "Invalid path" };
      if (targetPath === "/" || targetPath === "~" || targetPath === ".") {
        return { error: "Refusing to delete that path" };
      }
      if (tab.backend.target.kind === "local") {
        try {
          await promises.rm(targetPath, { recursive: true, force: false });
          return { ok: true };
        } catch (err) {
          return {
            error: err instanceof Error ? err.message : String(err)
          };
        }
      }
      const q = (p) => `'${p.replace(/'/g, `'"'"'`)}'`;
      const result = await tab.backend.exec(`rm -rf -- ${q(targetPath)}`, {
        cwd: "~",
        timeoutMs: 6e4
      });
      if (result.timedOut) return { error: "Delete timed out" };
      if (result.exitCode !== 0) {
        return {
          error: (result.stderr || result.stdout || "Delete failed").trim().slice(0, 400)
        };
      }
      return { ok: true };
    }
  );
  electron.ipcMain.handle(
    "agent:send",
    async (_e, input) => {
      const tab = tabs.get(input.tabId);
      if (!(tab == null ? void 0 : tab.backend)) return { error: "No active terminal tab" };
      const backend = tab.backend;
      const apiKey = await loadApiKey();
      const runId = newId();
      const abort = new AbortController();
      activeAgentRuns.set(runId, abort);
      let countedUsage = false;
      let sawTerminalStatus = false;
      void (async () => {
        try {
          if (backend.target.kind === "local") {
            await pollTabCwd(input.tabId);
          } else if (tab.lastCwd && backend.target.kind === "ssh" && "setCwd" in backend) {
            backend.setCwd(tab.lastCwd);
          }
          const target = backend.target;
          const terminalTail = terminalTailForAgent(tab);
          const notes = target.kind === "ssh" ? `Active session is SSH (${target.hostLabel}). Remote working directory: ${target.cwd}. Shell proposes run on that remote host.` : `Active session is local. Working directory: ${target.cwd}.`;
          for await (const event of sendAgent({
            message: input.message,
            target,
            apiKey,
            modelId: appSettings.modelId,
            chatMode: appSettings.chatMode,
            locale: appSettings.locale,
            signal: abort.signal,
            context: {
              notes,
              ...terminalTail ? { terminalTail } : {}
            }
          })) {
            if (abort.signal.aborted) break;
            if (event.type === "status" && (event.status === "done" || event.status === "error" || event.status === "cancelled")) {
              sawTerminalStatus = true;
            }
            if (event.type === "usage" && !countedUsage) {
              countedUsage = true;
              const totals = addUsage(event.usage, event.cost);
              mainWindow == null ? void 0 : mainWindow.webContents.send("usage:updated", {
                last: event,
                session: totals
              });
            }
            mainWindow == null ? void 0 : mainWindow.webContents.send("agent:event", {
              runId,
              tabId: input.tabId,
              event
            });
            if (event.type === "propose") {
              if (appSettings.chatMode !== "agent") {
                continue;
              }
              if (abort.signal.aborted) break;
              const decision = await requestApproval(
                runId,
                input.tabId,
                event.action
              );
              if (abort.signal.aborted) break;
              policy.remember(event.action, decision);
              if (decision.type === "deny") {
                mainWindow == null ? void 0 : mainWindow.webContents.send("agent:event", {
                  runId,
                  tabId: input.tabId,
                  event: {
                    type: "text",
                    text: `
Denied.${decision.feedback ? ` Feedback: ${decision.feedback}` : ""}
`
                  }
                });
                continue;
              }
              if (!event.action.command) continue;
              if (policy.mode === "read-only" && event.action.effect !== "read") {
                continue;
              }
              if (abort.signal.aborted) break;
              backend.write(`
# agent: ${event.action.command}
`);
              const result = await backend.exec(event.action.command);
              if (abort.signal.aborted) break;
              const out = [
                result.stdout,
                result.stderr,
                result.timedOut ? "[timed out]" : `[exit ${result.exitCode}]`
              ].filter(Boolean).join("");
              mainWindow == null ? void 0 : mainWindow.webContents.send("agent:event", {
                runId,
                tabId: input.tabId,
                event: { type: "text", text: `
${out}
` }
              });
            }
          }
          if (abort.signal.aborted && !sawTerminalStatus) {
            mainWindow == null ? void 0 : mainWindow.webContents.send("agent:event", {
              runId,
              tabId: input.tabId,
              event: {
                type: "status",
                status: "cancelled",
                detail: "Stopped"
              }
            });
          }
        } catch (err) {
          const cancelled = abort.signal.aborted || err instanceof Error && err.name === "AbortError";
          mainWindow == null ? void 0 : mainWindow.webContents.send("agent:event", {
            runId,
            tabId: input.tabId,
            event: cancelled ? {
              type: "status",
              status: "cancelled",
              detail: "Stopped"
            } : {
              type: "status",
              status: "error",
              detail: err instanceof Error ? err.message : String(err)
            }
          });
        } finally {
          activeAgentRuns.delete(runId);
        }
      })();
      return { runId };
    }
  );
  electron.ipcMain.handle(
    "agent:stop",
    async (_e, input) => {
      const result = stopAgentRuns(input == null ? void 0 : input.runId);
      return { ok: true, ...result };
    }
  );
  electron.ipcMain.handle(
    "agent:resolve-approval",
    async (_e, input) => {
      const pending = pendingApprovals.get(input.runId);
      if (!pending) return;
      pendingApprovals.delete(input.runId);
      pending.resolve(input.decision);
    }
  );
  electron.ipcMain.handle("meeting:list", async () => listMeetings());
  electron.ipcMain.handle(
    "meeting:create",
    async (_e, title) => createMeeting(title)
  );
  electron.ipcMain.handle("meeting:get", async (_e, id) => getMeeting(id));
  electron.ipcMain.handle(
    "meeting:save",
    async (_e, input) => {
      const { id, ...patch } = input;
      return saveMeeting(id, patch);
    }
  );
  electron.ipcMain.handle(
    "meeting:save-audio",
    async (_e, input) => {
      const bytes = input.data instanceof Uint8Array ? input.data : new Uint8Array(input.data);
      return saveMeetingAudio(input.id, bytes);
    }
  );
  electron.ipcMain.handle(
    "meeting:delete",
    async (_e, id) => deleteMeeting(id)
  );
  electron.ipcMain.handle(
    "meeting:export",
    async (_e, id) => exportMeeting(id, mainWindow)
  );
  electron.ipcMain.handle("meeting:summarize", async (_e, id) => {
    const meeting = await getMeeting(id);
    if (!meeting) return { error: "not_found" };
    const apiKey = await loadApiKey();
    if (!apiKey.trim()) {
      return { error: "no_api_key" };
    }
    const transcript = meeting.transcript.trim();
    const notes = meeting.notes.trim();
    if (!transcript && !notes) {
      return { error: "no_content" };
    }
    const locale = appSettings.locale;
    const prompt = locale === "ko" ? [
      "아래 회의 받아쓰기와 메모를 한국어로 요약하세요.",
      "마크다운만 출력하세요. 셸 명령은 실행하지 마세요.",
      "",
      "## 받아쓰기",
      transcript || "(없음)",
      "",
      "## 메모",
      notes || "(없음)",
      "",
      "포함할 내용:",
      "- 한 줄 개요",
      "- 핵심 결정",
      "- 액션 아이템 (담당/기한 있으면 포함)",
      "- 미결 질문"
    ].join("\n") : [
      "Summarize the meeting transcript and notes below.",
      "Reply with markdown only. Do not run shell commands.",
      "",
      "## Transcript",
      transcript || "(none)",
      "",
      "## Notes",
      notes || "(none)",
      "",
      "Include:",
      "- One-line overview",
      "- Key decisions",
      "- Action items (owner/due if present)",
      "- Open questions"
    ].join("\n");
    const runId = newId();
    const abort = new AbortController();
    activeAgentRuns.set(runId, abort);
    const parts = [];
    let countedUsage = false;
    let errorDetail = null;
    try {
      for await (const event of sendAgent({
        message: prompt,
        target: { kind: "local", cwd: os.homedir() },
        apiKey,
        modelId: appSettings.modelId,
        chatMode: "ask",
        locale: appSettings.locale,
        signal: abort.signal,
        context: {
          notes: "Meeting summarization only. Do not propose or run shell commands."
        }
      })) {
        if (abort.signal.aborted) break;
        if (event.type === "text") parts.push(event.text);
        if (event.type === "usage" && !countedUsage) {
          countedUsage = true;
          const totals = addUsage(event.usage, event.cost);
          mainWindow == null ? void 0 : mainWindow.webContents.send("usage:updated", {
            last: event,
            session: totals
          });
        }
        if (event.type === "status" && event.status === "error") {
          errorDetail = event.detail || "failed";
        }
        if (event.type === "status" && event.status === "cancelled") {
          return { error: "cancelled", runId };
        }
      }
    } catch (err) {
      activeAgentRuns.delete(runId);
      return {
        error: err instanceof Error ? err.message : String(err),
        runId
      };
    } finally {
      activeAgentRuns.delete(runId);
    }
    if (errorDetail) {
      const keyMissing = /api key is not set|api key/i.test(errorDetail) && /not set|settings/i.test(errorDetail);
      return {
        error: keyMissing ? "no_api_key" : errorDetail,
        runId
      };
    }
    const summary = parts.join("").trim();
    if (!summary) return { error: "empty", runId };
    const saved = await saveMeeting(id, { summary, status: "done" });
    return { ok: true, summary, meeting: saved, runId };
  });
}
function requestApproval(runId, tabId, action) {
  if (!policy.needsApproval(action)) {
    return Promise.resolve({ type: "allow-once" });
  }
  return new Promise((resolve) => {
    pendingApprovals.set(runId, { resolve, action, tabId });
    mainWindow == null ? void 0 : mainWindow.webContents.send("agent:approval", { runId, tabId, action });
  });
}
electron.app.setName("Drift");
if (process.platform === "win32") {
  electron.app.setAppUserModelId("app.drift.desktop");
}
electron.app.whenReady().then(async () => {
  var _a;
  const icon = loadAppIcon();
  const iconPath = node_fs.existsSync(brandAsset("icon.png")) ? brandAsset("icon.png") : void 0;
  electron.app.setAboutPanelOptions({
    applicationName: "Drift",
    applicationVersion: electron.app.getVersion(),
    copyright: "Drift",
    ...iconPath ? { iconPath } : {}
  });
  if (process.platform === "darwin" && icon) {
    (_a = electron.app.dock) == null ? void 0 : _a.setIcon(icon);
  }
  sessionStore = new SessionStore(dataDir());
  await sessionStore.load();
  appSettings = await loadSettings();
  applyChatModeToPolicy(appSettings.chatMode);
  registerIpc();
  buildApplicationMenu();
  createWindow();
  initAutoUpdater(() => mainWindow);
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
electron.app.on("window-all-closed", () => {
  var _a, _b;
  for (const tab of tabs.values()) {
    (_a = tab.unsub) == null ? void 0 : _a.call(tab);
    void ((_b = tab.backend) == null ? void 0 : _b.dispose());
  }
  tabs.clear();
  if (process.platform !== "darwin") electron.app.quit();
});
process.on("uncaughtException", (err) => {
  electron.dialog.showErrorBox("Drift error", err.message);
});
