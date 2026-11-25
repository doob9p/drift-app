import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createLocalPty, type LocalPtyBackend } from "@drift/host-local";

/** Written to userData so ELECTRON_RUN_AS_NODE can load it without packaging gymnastics. */
const MCP_SESSIONS_SOURCE = `/**
 * Drift MCP (stdio) — list_sessions / send_to_session
 * Env: DRIFT_HOOK_PORT, DRIFT_CARD_ID
 */
const http = require("node:http");
const PORT = process.env.DRIFT_HOOK_PORT;
const CARD = encodeURIComponent(process.env.DRIFT_CARD_ID || "");
function call(method, route, body) {
  return new Promise((resolve) => {
    if (!PORT) { resolve({ error: "DRIFT_HOOK_PORT is not set" }); return; }
    const data = body ? JSON.stringify(body) : "";
    const req = http.request({
      host: "127.0.0.1", port: PORT,
      path: "/mcp/" + CARD + "/" + route, method,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    }, (res) => {
      let out = "";
      res.on("data", (c) => { out += c; });
      res.on("end", () => { try { resolve(JSON.parse(out)); } catch { resolve({ error: "Could not parse Drift response" }); } });
    });
    req.on("error", () => resolve({ error: "Could not reach Drift. Is the app still open?" }));
    req.end(data);
  });
}
const TOOLS = [
  { name: "list_sessions", description: "List other Claude sessions on the Drift board.", inputSchema: { type: "object", properties: {} } },
  { name: "send_to_session", description: "Send a message into another Claude session on the Drift board.", inputSchema: { type: "object", properties: { session: { type: "string" }, message: { type: "string" }, wait_for_reply: { type: "boolean" } }, required: ["session", "message"] } },
];
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
const text = (t, isError) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return;
  if (method === "initialize") return reply(id, { protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "drift", version: "0.1.0" } });
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "tools/call") {
    const args = params?.arguments || {};
    if (params?.name === "list_sessions") {
      const r = await call("GET", "sessions");
      if (r.error) return reply(id, text(r.error, true));
      const sessions = Array.isArray(r.sessions) ? r.sessions : [];
      if (!sessions.length) return reply(id, text("No other Claude sessions on the Drift board."));
      return reply(id, text(sessions.map((s) => "- " + s.name + ": folder " + (s.folder || "?") + ", status " + (s.state || "?")).join("\\n")));
    }
    if (params?.name === "send_to_session") {
      const r = await call("POST", "send", { session: args.session, message: args.message, wait: args.wait_for_reply === true });
      if (r.error) return reply(id, text(r.error, true));
      return reply(id, text(r.reply ?? r.result ?? "sent"));
    }
    return process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown tool: " + params?.name } }) + "\\n");
  }
  if (method === "ping") return reply(id, {});
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unsupported method: " + method } }) + "\\n");
}
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { void handle(JSON.parse(line)); } catch { /* ignore */ }
  }
});
`;

const PARENT_SESSION_VARS = [
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
];

export type ClaudeAgentStatus =
  | "idle"
  | "running"
  | "waiting"
  | "done"
  | "error";

export type ClaudeSessionRecord = {
  cardId: string;
  tabId: string;
  title: string;
  cwd: string;
  sessionId: string;
  status: ClaudeAgentStatus;
};

export type ClaudeHookPayload = {
  cardId: string;
  event: string;
  status: ClaudeAgentStatus;
  raw?: unknown;
};

export type ClaudeRateWindow = {
  usedPercent: number;
  resetsAt?: number;
};

export type ClaudeUsagePayload = {
  cardId: string;
  fiveHour?: ClaudeRateWindow;
  sevenDay?: ClaudeRateWindow;
  contextPercent?: number | null;
  modelId?: string;
  modelLabel?: string;
  effortLevel?: string;
  updatedAt: number;
};

type ClaudeHostDeps = {
  hooksDir: () => string;
  userDataDir: () => string;
  /** Resolve shell size prefs for Windows. */
  localShellKind?: () => "powershell" | "cmd" | "gitbash" | undefined;
  onHook: (payload: ClaudeHookPayload) => void;
  onUsage: (payload: ClaudeUsagePayload) => void;
  /** Write into a Claude tab's PTY (bracketed paste + Enter). */
  writeToTab: (tabId: string, data: string) => boolean;
  listOtherSessions: (fromCardId: string) => ClaudeSessionRecord[];
};

const STATUSLINE_RELAY_SOURCE = `const http = require("node:http");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { buf += c; });
process.stdin.on("end", () => {
  const port = process.env.DRIFT_HOOK_PORT;
  const card = encodeURIComponent(process.env.DRIFT_CARD_ID || "");
  if (!port || !card) { process.exit(0); return; }
  const req = http.request({
    host: "127.0.0.1",
    port,
    path: "/hook/" + card + "/statusline",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(buf),
    },
  }, (res) => { res.resume(); res.on("end", () => process.exit(0)); });
  req.on("error", () => process.exit(0));
  req.end(buf || "{}");
});
`;

function parseRateWindow(raw: unknown): ClaudeRateWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const used =
    typeof o.used_percentage === "number"
      ? o.used_percentage
      : typeof o.usedPercent === "number"
        ? o.usedPercent
        : null;
  if (used == null || !Number.isFinite(used)) return undefined;
  const resets =
    typeof o.resets_at === "number"
      ? o.resets_at
      : typeof o.resetsAt === "number"
        ? o.resetsAt
        : undefined;
  return {
    usedPercent: Math.max(0, Math.min(100, used)),
    resetsAt: resets && Number.isFinite(resets) ? resets : undefined,
  };
}

function parseStatuslineUsage(
  cardId: string,
  raw: unknown
): ClaudeUsagePayload | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;
  const limits =
    root.rate_limits && typeof root.rate_limits === "object"
      ? (root.rate_limits as Record<string, unknown>)
      : root.rateLimits && typeof root.rateLimits === "object"
        ? (root.rateLimits as Record<string, unknown>)
        : null;
  const fiveHour = limits
    ? parseRateWindow(limits.five_hour ?? limits.fiveHour)
    : undefined;
  const sevenDay = limits
    ? parseRateWindow(limits.seven_day ?? limits.sevenDay)
    : undefined;
  const ctx =
    root.context_window && typeof root.context_window === "object"
      ? (root.context_window as Record<string, unknown>)
      : root.contextWindow && typeof root.contextWindow === "object"
        ? (root.contextWindow as Record<string, unknown>)
        : null;
  let contextPercent: number | null | undefined;
  if (ctx) {
    const v = ctx.used_percentage ?? ctx.usedPercent;
    if (typeof v === "number" && Number.isFinite(v)) {
      contextPercent = Math.max(0, Math.min(100, v));
    } else if (v === null) {
      contextPercent = null;
    }
  }
  const model =
    root.model && typeof root.model === "object"
      ? (root.model as Record<string, unknown>)
      : null;
  const modelId =
    typeof model?.id === "string" && model.id.trim()
      ? model.id.trim()
      : undefined;
  const modelLabel =
    typeof model?.display_name === "string" && model.display_name.trim()
      ? model.display_name.trim()
      : typeof model?.displayName === "string" && model.displayName.trim()
        ? model.displayName.trim()
        : undefined;
  const effortObj =
    root.effort && typeof root.effort === "object"
      ? (root.effort as Record<string, unknown>)
      : null;
  const effortLevel =
    typeof effortObj?.level === "string" && effortObj.level.trim()
      ? effortObj.level.trim()
      : typeof root.effortLevel === "string" && root.effortLevel.trim()
        ? root.effortLevel.trim()
        : undefined;
  if (
    !fiveHour &&
    !sevenDay &&
    contextPercent === undefined &&
    !modelId &&
    !modelLabel &&
    !effortLevel
  ) {
    return null;
  }
  return {
    cardId,
    fiveHour,
    sevenDay,
    contextPercent,
    modelId,
    modelLabel,
    effortLevel,
    updatedAt: Date.now(),
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function claudeProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

export function hasClaudeTranscript(sessionId: string): boolean {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return false;
  try {
    const root = claudeProjectsDir();
    if (!existsSync(root)) return false;
    return readdirSync(root).some((dir) =>
      existsSync(path.join(root, dir, `${sessionId}.jsonl`))
    );
  } catch {
    return false;
  }
}

function isExecutableFile(p: string): boolean {
  try {
    if (!existsSync(p)) return false;
    // Skip Linux ELF VM binaries shipped next to the macOS app bundle.
    if (process.platform === "darwin" && p.includes(`${path.sep}claude-code-vm${path.sep}`)) {
      return false;
    }
    execFileSync(p, ["--version"], {
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
      env: process.env,
    });
    return true;
  } catch {
    return false;
  }
}

/** Claude Desktop ships Claude Code under Application Support (not always on PATH). */
function findBundledClaudeCli(): string | null {
  if (process.platform === "darwin") {
    const root = path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Claude",
      "claude-code"
    );
    if (!existsSync(root)) return null;
    try {
      const versions = readdirSync(root)
        .filter((name) => /^\d/.test(name))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const ver of versions) {
        const verDir = path.join(root, ver);
        let hashes: string[] = [];
        try {
          hashes = readdirSync(verDir);
        } catch {
          continue;
        }
        for (const hash of hashes) {
          const candidate = path.join(
            verDir,
            hash,
            "claude.app",
            "Contents",
            "MacOS",
            "claude"
          );
          if (isExecutableFile(candidate)) return candidate;
        }
      }
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") {
    const root = path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "AnthropicClaude"
    );
    const candidates = [
      path.join(root, "claude.exe"),
      path.join(root, "claude-code", "claude.exe"),
    ];
    for (const c of candidates) {
      if (isExecutableFile(c)) return c;
    }
  }
  return null;
}

export type ClaudeCliDetect =
  | { ok: true; path: string; source: "path" | "bundled" }
  | { ok: false; error: string; bundledPath?: string };

/**
 * Prefer a PATH-installed `claude` (what `which claude` finds).
 * Claude Desktop’s bundled binary is noted separately so the UI can ask
 * the user to install the CLI instead of silently opening a folder picker.
 */
export function detectClaudeCli(): ClaudeCliDetect {
  try {
    const which = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(which, ["claude"], {
      encoding: "utf8",
      timeout: 5000,
      env: process.env,
    })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);
    if (out && isExecutableFile(out)) {
      return { ok: true, path: out, source: "path" };
    }
  } catch {
    /* fall through */
  }
  const bundled = findBundledClaudeCli();
  if (bundled) {
    // Still return path for spawn/resume, but mark source so UI can require PATH install.
    return { ok: true, path: bundled, source: "bundled" };
  }
  return { ok: false, error: "not_found" };
}

function mapHookToStatus(eventName: string): ClaudeAgentStatus {
  const e = eventName.toLowerCase();
  if (e.includes("notification") || e.includes("permission") || e.includes("elicitation") || e.includes("needs_input")) {
    return "waiting";
  }
  if (e === "stop" || e === "sessionend") return "done";
  if (e === "subagentstart" || e === "userpromptsubmit" || e === "sessionstart" || e === "pretooluse") {
    return "running";
  }
  if (e === "subagentstop" || e === "posttooluse") return "running";
  return "running";
}

function extractHookEvent(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "unknown";
  const o = raw as Record<string, unknown>;
  if (typeof o.hook_event_name === "string") return o.hook_event_name;
  if (typeof o.event === "string") return o.event;
  if (typeof o.type === "string") return o.type;
  return "unknown";
}

export function createClaudeHost(deps: ClaudeHostDeps) {
  let server: Server | null = null;
  let hookPort = 0;

  function ensureHooksDir(): string {
    const dir = deps.hooksDir();
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function mcpScriptPath(): string {
    const dest = path.join(deps.userDataDir(), "claude-mcp-sessions.cjs");
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, MCP_SESSIONS_SOURCE, "utf8");
    return dest;
  }

  function statuslineScriptPath(): string {
    const dest = path.join(deps.userDataDir(), "claude-statusline-relay.cjs");
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, STATUSLINE_RELAY_SOURCE, "utf8");
    return dest;
  }

  function writeMcpConfig(cardId: string): string {
    const dir = ensureHooksDir();
    const script = mcpScriptPath();
    const file = path.join(dir, `${cardId}.mcp.json`);
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          drift: {
            type: "stdio",
            command: process.execPath,
            args: [script],
            env: {
              ELECTRON_RUN_AS_NODE: "1",
              DRIFT_HOOK_PORT: String(hookPort),
              DRIFT_CARD_ID: cardId,
            },
          },
        },
      }),
      "utf8"
    );
    return file;
  }

  function quoteForShell(p: string): string {
    if (process.platform === "win32") {
      return `'${p.replace(/'/g, "''")}'`;
    }
    return `'${p.replace(/'/g, `'\\''`)}'`;
  }

  function writeHookSettings(cardId: string): string {
    const dir = ensureHooksDir();
    const hook = [
      {
        type: "http",
        url: `http://127.0.0.1:${hookPort}/hook/${encodeURIComponent(cardId)}`,
        timeout: 3,
      },
    ];
    const statusline = statuslineScriptPath();
    // Claude Code runs statusLine with JSON on stdin (rate_limits, context_window).
    const statusCmd =
      process.platform === "win32"
        ? `set ELECTRON_RUN_AS_NODE=1&& set DRIFT_HOOK_PORT=${hookPort}&& set DRIFT_CARD_ID=${cardId}&& "${process.execPath}" "${statusline}"`
        : `ELECTRON_RUN_AS_NODE=1 DRIFT_HOOK_PORT=${hookPort} DRIFT_CARD_ID=${quoteForShell(cardId)} ${quoteForShell(process.execPath)} ${quoteForShell(statusline)}`;
    const file = path.join(dir, `${cardId}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        permissions: {
          allow: [
            "mcp__drift",
            "mcp__drift__*",
            "mcp__drift__list_sessions",
            "mcp__drift__send_to_session",
          ],
        },
        statusLine: {
          type: "command",
          command: statusCmd,
        },
        hooks: {
          PreToolUse: [{ matcher: "*", hooks: hook }],
          PostToolUse: [{ matcher: "Agent", hooks: hook }],
          PostToolUseFailure: [{ matcher: "Agent", hooks: hook }],
          SubagentStart: [{ hooks: hook }],
          SubagentStop: [{ hooks: hook }],
          SessionStart: [{ hooks: hook }],
          UserPromptSubmit: [{ hooks: hook }],
          Stop: [{ hooks: hook }],
          Notification: [
            {
              matcher: "permission_prompt|elicitation_dialog|agent_needs_input",
              hooks: hook,
            },
          ],
        },
      }),
      "utf8"
    );
    return file;
  }

  function buildClaudeCommand(
    cardId: string,
    sessionId: string,
    claudePath: string
  ): string {
    const settings = writeHookSettings(cardId);
    const mcp = writeMcpConfig(cardId);
    const sid = /^[0-9a-f-]{36}$/i.test(sessionId) ? sessionId : randomUUID();
    const sessionFlag = hasClaudeTranscript(sid)
      ? `--resume ${sid}`
      : `--session-id ${sid}`;
    return `${quoteForShell(claudePath)} ${sessionFlag} --settings ${quoteForShell(settings)} --mcp-config ${quoteForShell(mcp)}`;
  }

  async function handleHookPost(
    cardId: string,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    try {
      const rawText = await readBody(req);
      let raw: unknown = rawText;
      try {
        raw = JSON.parse(rawText);
      } catch {
        /* keep string */
      }
      const event = extractHookEvent(raw);
      const status = mapHookToStatus(event);
      deps.onHook({ cardId, event, status, raw });
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleStatuslinePost(
    cardId: string,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    try {
      const rawText = await readBody(req);
      let raw: unknown = {};
      try {
        raw = JSON.parse(rawText || "{}");
      } catch {
        raw = {};
      }
      const usage = parseStatuslineUsage(cardId, raw);
      if (usage) deps.onUsage(usage);
      // statusLine scripts should exit 0 quickly; empty stdout is fine.
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("");
    } catch {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("");
    }
  }

  async function handleMcp(
    cardId: string,
    route: string,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    try {
      if (route === "sessions" && req.method === "GET") {
        const sessions = deps.listOtherSessions(cardId).map((s) => ({
          name: s.title,
          folder: s.cwd,
          state: s.status,
          cardId: s.cardId,
        }));
        sendJson(res, 200, { sessions });
        return;
      }
      if (route === "send" && req.method === "POST") {
        const rawText = await readBody(req);
        const body = JSON.parse(rawText || "{}") as {
          session?: string;
          message?: string;
        };
        const targetName = (body.session || "").trim();
        const message = body.message ?? "";
        if (!targetName || !message) {
          sendJson(res, 400, { error: "session and message are required" });
          return;
        }
        const peers = deps.listOtherSessions(cardId);
        const hit =
          peers.find((p) => p.title === targetName) ||
          peers.find((p) => p.cardId === targetName);
        if (!hit) {
          sendJson(res, 404, { error: `Session not found: ${targetName}` });
          return;
        }
        // Bracketed paste + Enter (same idea as Patchbay).
        const paste = `\x1b[200~${message}\x1b[201~\r`;
        const ok = deps.writeToTab(hit.tabId, paste);
        if (!ok) {
          sendJson(res, 500, { error: "Target session PTY is not available" });
          return;
        }
        sendJson(res, 200, { result: "sent" });
        return;
      }
      sendJson(res, 404, { error: "unknown route" });
    } catch (err) {
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function startServer(): Promise<number> {
    if (server && hookPort) return Promise.resolve(hookPort);
    return new Promise((resolve, reject) => {
      server = createServer((req, res) => {
        const url = new URL(req.url || "/", "http://127.0.0.1");
        const statusMatch = url.pathname.match(
          /^\/hook\/([^/]+)\/statusline$/
        );
        if (statusMatch && req.method === "POST") {
          void handleStatuslinePost(
            decodeURIComponent(statusMatch[1]!),
            req,
            res
          );
          return;
        }
        const hookMatch = url.pathname.match(/^\/hook\/([^/]+)$/);
        if (hookMatch && req.method === "POST") {
          void handleHookPost(decodeURIComponent(hookMatch[1]!), req, res);
          return;
        }
        const mcpMatch = url.pathname.match(/^\/mcp\/([^/]+)\/([^/]+)$/);
        if (mcpMatch) {
          void handleMcp(
            decodeURIComponent(mcpMatch[1]!),
            mcpMatch[2]!,
            req,
            res
          );
          return;
        }
        sendJson(res, 404, { error: "not found" });
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server!.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("hook server failed to bind"));
          return;
        }
        hookPort = addr.port;
        resolve(hookPort);
      });
      server.on("error", reject);
    });
  }

  async function openSession(input: {
    cardId: string;
    cwd: string;
    sessionId?: string;
    cols: number;
    rows: number;
  }): Promise<
    | { ok: true; tabId: string; sessionId: string; backend: LocalPtyBackend }
    | { ok: false; error: string }
  > {
    const cli = detectClaudeCli();
    if (!cli.ok) {
      return {
        ok: false,
        error:
          "Claude Code CLI (`claude`) was not found. Install with: npm install -g @anthropic-ai/claude-code",
      };
    }
    const cwd = path.resolve(input.cwd);
    if (!existsSync(cwd)) {
      return { ok: false, error: `Working folder not found: ${input.cwd}` };
    }
    await startServer();
    const sessionId =
      input.sessionId && /^[0-9a-f-]{36}$/i.test(input.sessionId)
        ? input.sessionId
        : randomUUID();
    const command = buildClaudeCommand(input.cardId, sessionId, cli.path);
    try {
      const backend = createLocalPty({
        cwd,
        cols: input.cols,
        rows: input.rows,
        shellKind:
          process.platform === "win32"
            ? deps.localShellKind?.() ?? "powershell"
            : undefined,
        command,
        stripEnvKeys: PARENT_SESSION_VARS,
        env: {
          DRIFT_HOOK_PORT: String(hookPort),
          DRIFT_CARD_ID: input.cardId,
        },
      });
      return {
        ok: true,
        tabId: backend.id,
        sessionId,
        backend,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  function stop(): void {
    try {
      server?.close();
    } catch {
      /* ignore */
    }
    server = null;
    hookPort = 0;
  }

  return {
    startServer,
    openSession,
    detectClaudeCli,
    hasClaudeTranscript,
    getHookPort: () => hookPort,
    stop,
  };
}

export type ClaudeHost = ReturnType<typeof createClaudeHost>;
