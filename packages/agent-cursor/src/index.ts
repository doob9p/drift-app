import {
  classifyCommand,
  newId,
  type AgentEvent,
  type AppLocale,
  type ChatMode,
  type ModelOption,
  type ProposedAction,
  type TargetRef,
  type TokenUsageSnapshot,
  type UsageCostSnapshot,
} from "@drift/core";

export interface AgentSendInput {
  message: string;
  target: TargetRef;
  apiKey: string;
  modelId?: string;
  chatMode?: ChatMode;
  locale?: AppLocale;
  context?: { terminalTail?: string; notes?: string };
  /** When aborted, cancel the in-flight Cursor run (if any) and stop yielding. */
  signal?: AbortSignal;
}

function isAborted(signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted);
}

const DEFAULT_MODEL = "composer-2.5";

export async function listModels(apiKey: string): Promise<ModelOption[]> {
  if (!apiKey.trim()) return fallbackModels();
  try {
    const { Cursor } = await import("@cursor/sdk");
    const models = await Cursor.models.list({ apiKey });
    return models.map((m) => ({
      id: m.id,
      displayName: m.displayName || m.id,
      description: m.description,
    }));
  } catch {
    return fallbackModels();
  }
}

function fallbackModels(): ModelOption[] {
  return [
    { id: "auto", displayName: "Auto" },
    { id: DEFAULT_MODEL, displayName: "Composer 2.5" },
  ];
}

/**
 * Cursor-backed agent client.
 * Uses @cursor/sdk when available; falls back to a local proposer so the UI
 * works before a key / SDK version is fully wired.
 */
export async function* sendAgent(
  input: AgentSendInput
): AsyncGenerator<AgentEvent> {
  if (isAborted(input.signal)) {
    yield { type: "status", status: "cancelled", detail: "Stopped" };
    return;
  }
  yield { type: "status", status: "running" };

  if (!input.apiKey.trim()) {
    yield {
      type: "status",
      status: "error",
      detail: "Cursor API key is not set. Open Settings and paste your key.",
    };
    return;
  }

  try {
    const sdk = await import("@cursor/sdk").catch(() => null);
    if (sdk?.Agent) {
      yield* runWithCursorSdk(sdk, input);
      return;
    }
  } catch (err) {
    if (isAborted(input.signal) || (err instanceof Error && err.name === "AbortError")) {
      yield { type: "status", status: "cancelled", detail: "Stopped" };
      return;
    }
    yield {
      type: "text",
      text: `Cursor SDK call failed: ${err instanceof Error ? err.message : String(err)}\nFalling back to local proposer.\n`,
    };
  }

  if (isAborted(input.signal)) {
    yield { type: "status", status: "cancelled", detail: "Stopped" };
    return;
  }
  yield* runLocalProposer(input);
}

function buildPrompt(input: AgentSendInput): string {
  const mode = input.chatMode ?? "agent";
  const modeBlock =
    mode === "ask"
      ? [
          "Mode: Ask.",
          "Answer questions only. Explain and advise.",
          "Do NOT propose shell commands to run. Do NOT use propose blocks.",
        ]
      : mode === "plan"
        ? [
            "Mode: Plan.",
            "Produce a clear numbered plan (3–8 steps) for the request.",
            "Do NOT run or propose executable shell commands. Do NOT use propose blocks.",
            "Optionally end with a short ```plan block listing one step per line.",
          ]
        : [
            "Mode: Agent.",
            "If you need a shell command run on the user's active host, reply with a single fenced block:",
            "```propose",
            "summary: short reason",
            "command: exact shell command",
            "```",
            "Otherwise answer briefly in plain text.",
          ];

  const locale = input.locale === "en" ? "en" : "ko";
  const languageLine =
    locale === "ko"
      ? "Respond in Korean (한국어). Keep shell commands and code in their original form."
      : "Respond in English. Keep shell commands and code in their original form.";

  return [
    "You are assisting inside Drift, a terminal app.",
    languageLine,
    ...modeBlock,
    `Active target: ${JSON.stringify(input.target)}`,
    input.context?.notes ? `Context notes: ${input.context.notes}` : "",
    input.context?.terminalTail
      ? `Recent terminal output (scrollback tail):\n\`\`\`\n${input.context.terminalTail}\n\`\`\``
      : "",
    "",
    `User: ${input.message}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function extractPlanSteps(text: string): string[] | null {
  const fenced = text.match(/```plan\s*([\s\S]*?)```/i);
  const body = fenced?.[1] ?? text;
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:\d+[.)]\s+|[-*]\s+)/, "").trim())
    .filter((l) => l.length > 0 && l.length < 200);
  if (fenced && lines.length >= 2) return lines.slice(0, 10);
  const numbered = text
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*\d+[.)]\s+(.+)$/)?.[1]?.trim())
    .filter((x): x is string => Boolean(x));
  return numbered.length >= 2 ? numbered.slice(0, 10) : null;
}

async function* runWithCursorSdk(
  sdk: typeof import("@cursor/sdk"),
  input: AgentSendInput
): AsyncGenerator<AgentEvent> {
  // Cursor SDK local.cwd is a workspace root on this machine. For SSH tabs the
  // remote cwd lives in the prompt/target; keep a harmless local fallback.
  const cwd =
    input.target.kind === "local" && input.target.cwd.startsWith("/")
      ? input.target.cwd
      : process.cwd();
  const modelId = input.modelId?.trim() || DEFAULT_MODEL;
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
    local: { cwd },
  });

  let run: Awaited<ReturnType<typeof agent.send>> | null = null;
  const cancelRun = () => {
    if (!run) return;
    void run.cancel().catch(() => {
      /* ignore */
    });
  };

  try {
    if (isAborted(input.signal)) {
      yield { type: "status", status: "cancelled", detail: "Stopped" };
      return;
    }
    run = await agent.send(prompt);
    input.signal?.addEventListener("abort", cancelRun, { once: true });
    if (isAborted(input.signal)) {
      cancelRun();
      yield { type: "status", status: "cancelled", detail: "Stopped" };
      return;
    }

    let text = "";
    let lastUsage: TokenUsageSnapshot | undefined;
    let toolRuns = 0;
    let toolDone = 0;
    let searches = 0;
    let edits = 0;
    let commands = 0;

    const summaryLine = (): string | undefined => {
      const bits: string[] = [];
      if (toolDone > 0) bits.push(`${toolDone} tools`);
      if (searches > 0) bits.push(`${searches} searches`);
      if (edits > 0) bits.push(`${edits} edits`);
      if (commands > 0) bits.push(`${commands} commands`);
      return bits.length ? bits.join(" · ") : undefined;
    };

    yield {
      type: "progress",
      phase: "status",
      title: "Working",
      detail: "Starting…",
    };

    for await (const event of run.stream()) {
      if (isAborted(input.signal)) break;

      if (event.type === "thinking") {
        const snippet = event.text.trim().replace(/\s+/g, " ").slice(0, 140);
        yield {
          type: "progress",
          phase: "thinking",
          title: "Thinking",
          detail: snippet || undefined,
          summary: summaryLine(),
          done: Boolean(event.thinking_duration_ms),
        };
      }

      if (event.type === "task" && (event.text || event.status)) {
        yield {
          type: "progress",
          phase: "task",
          title: event.status?.trim() || "Working",
          detail: event.text?.trim().slice(0, 160) || undefined,
          summary: summaryLine(),
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
          done: event.status !== "running",
        };
      }

      if (event.type === "status" && event.message) {
        yield {
          type: "progress",
          phase: "status",
          title: event.status.toLowerCase(),
          detail: event.message.slice(0, 160),
          summary: summaryLine(),
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
                summary: summaryLine(),
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
              summary: summaryLine(),
            };
          }
        }
      }
      if (event.type === "usage") {
        const usage = normalizeUsage(event.usage);
        if (usage) {
          lastUsage = usage;
          yield { type: "usage", usage, modelId };
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

    const usageFromResult = normalizeUsage(result.usage ?? run.usage ?? lastUsage);
    let cost: UsageCostSnapshot | undefined;

    try {
      const billed = await agent.getUsage();
      if (billed.usage) {
        if (!usageFromResult && billed.usage) {
          lastUsage = normalizeUsage(billed.usage);
        }
        if (billed.cost) {
          cost = {
            rawCostCents: billed.cost.rawCostCents,
            chargedCents: billed.cost.chargedCents,
          };
        }
        const latest = billed.runs.at(-1);
        if (latest?.cost) {
          cost = {
            rawCostCents: latest.cost.rawCostCents,
            chargedCents: latest.cost.chargedCents,
          };
        }
        if (latest?.usage) {
          lastUsage = normalizeUsage(latest.usage);
        }
      }
    } catch {
      /* usage optional */
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
    input.signal?.removeEventListener("abort", cancelRun);
    agent.close();
  }
}

function normalizeUsage(
  usage:
    | {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        totalTokens: number;
        reasoningTokens?: number;
      }
    | undefined
): TokenUsageSnapshot | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    reasoningTokens: usage.reasoningTokens,
  };
}

async function* runLocalProposer(
  input: AgentSendInput
): AsyncGenerator<AgentEvent> {
  if (isAborted(input.signal)) {
    yield { type: "status", status: "cancelled", detail: "Stopped" };
    return;
  }
  const mode = input.chatMode ?? "agent";
  if (mode === "ask") {
    yield {
      type: "text",
      text: "Ask mode (local fallback): I can only answer in text here. Set a Cursor API key for full Ask replies.\n",
    };
    yield { type: "status", status: "done" };
    return;
  }
  if (mode === "plan") {
    yield {
      type: "text",
      text: "Plan mode (local fallback):\n1. Inspect current shell context\n2. Identify the failing step\n3. Propose a minimal fix\n4. Verify with a read-only check\n",
    };
    yield {
      type: "plan",
      steps: [
        "Inspect current shell context",
        "Identify the failing step",
        "Propose a minimal fix",
        "Verify with a read-only check",
      ],
    };
    yield { type: "status", status: "done" };
    return;
  }

  yield {
    type: "text",
    text: "Local proposer (SDK unavailable). Suggesting a safe read-only command.\n",
  };

  const cmd = guessReadonlyCommand(input.message);
  const action: ProposedAction = {
    id: newId(),
    target: input.target,
    effect: classifyCommand(cmd),
    summary: `Investigate: ${input.message.slice(0, 80)}`,
    command: cmd,
    reason: "local fallback proposer",
  };
  yield { type: "status", status: "waiting-approval" };
  yield { type: "propose", action };
  yield { type: "status", status: "done" };
}

function extractPropose(
  text: string,
  target: TargetRef
): ProposedAction | null {
  const match = text.match(/```propose\s*([\s\S]*?)```/i);
  if (!match) return null;
  const body = match[1];
  const summary =
    body.match(/summary:\s*(.+)/i)?.[1]?.trim() || "Proposed command";
  const command = body.match(/command:\s*(.+)/i)?.[1]?.trim();
  if (!command) return null;
  return {
    id: newId(),
    target,
    effect: classifyCommand(command),
    summary,
    command,
  };
}

function guessReadonlyCommand(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("port")) return "lsof -nP -iTCP -sTCP:LISTEN | head -n 40";
  if (m.includes("disk")) return "df -h";
  if (m.includes("process") || m.includes("cpu")) return "ps aux | head -n 30";
  if (m.includes("git")) return "git status -sb";
  return "pwd && ls -la";
}

type ToolKind = "search" | "edit" | "command" | "read" | "other";

function classifyToolName(name: string): ToolKind {
  const n = name.toLowerCase();
  if (
    n.includes("grep") ||
    n.includes("search") ||
    n.includes("find") ||
    n.includes("glob")
  ) {
    return "search";
  }
  if (
    n.includes("edit") ||
    n.includes("write") ||
    n.includes("apply") ||
    n.includes("patch") ||
    n.includes("strreplace")
  ) {
    return "edit";
  }
  if (
    n.includes("shell") ||
    n.includes("bash") ||
    n.includes("exec") ||
    n.includes("terminal") ||
    n.includes("command")
  ) {
    return "command";
  }
  if (n.includes("read") || n.includes("cat") || n.includes("open")) {
    return "read";
  }
  return "other";
}

function toolTitle(kind: ToolKind, name: string, status: string): string {
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

function toolDetail(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const o = args as Record<string, unknown>;
  for (const key of [
    "command",
    "cmd",
    "query",
    "pattern",
    "path",
    "file_path",
    "filePath",
    "target_file",
    "relative_workspace_path",
  ]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 140);
  }
  return undefined;
}
