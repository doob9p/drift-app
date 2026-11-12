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
    yield {
      type: "text",
      text: `Cursor SDK call failed: ${err instanceof Error ? err.message : String(err)}\nFalling back to local proposer.\n`,
    };
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
    input.context?.terminalTail
      ? `Recent terminal output:\n${input.context.terminalTail}`
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
  const cwd =
    input.target.kind === "local" ? input.target.cwd : process.cwd();
  const modelId = input.modelId?.trim() || DEFAULT_MODEL;
  const chatMode = input.chatMode ?? "agent";
  const prompt = buildPrompt(input);

  const agent = await sdk.Agent.create({
    apiKey: input.apiKey,
    model: { id: modelId },
    mode: chatMode === "plan" ? "plan" : "agent",
    local: { cwd },
  });

  try {
    const run = await agent.send(prompt);
    let text = "";
    let lastUsage: TokenUsageSnapshot | undefined;

    for await (const event of run.stream()) {
      if (event.type === "assistant") {
        for (const block of event.message.content) {
          if (block.type === "text" && "text" in block) {
            text += block.text;
            yield { type: "text", text: block.text };
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

    const result = await run.wait();
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
        yield { type: "status", status: "waiting-approval" };
        yield { type: "propose", action: proposed };
      }
    }
    yield { type: "status", status: "done" };
  } finally {
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
