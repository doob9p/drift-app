export type TargetRef =
  | { kind: "local"; cwd: string }
  | { kind: "ssh"; sessionId: string; hostLabel: string; cwd: string };

export interface SavedSession {
  id: string;
  name: string;
  folder?: string;
  host: string;
  user: string;
  port?: number;
  identityFile?: string;
  /** Local identity path last installed to this host's authorized_keys (not verified remotely). */
  authorizedKeyIdentity?: string;
  proxyJump?: string;
  startDir?: string;
  sshConfigHost?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut?: boolean;
}

export type Effect =
  | "read"
  | "write"
  | "destructive"
  | "network"
  | "unknown";

export type PermissionMode = "ask" | "session-allow" | "read-only";

export interface ProposedAction {
  id: string;
  target: TargetRef;
  effect: Effect;
  summary: string;
  command?: string;
  diff?: string;
  reason?: string;
}

export type ApprovalDecision =
  | { type: "allow-once" }
  | { type: "allow-session" }
  | { type: "deny"; feedback?: string };

export interface SessionRule {
  sessionId?: string;
  effect: Effect;
  commandPrefix?: string;
}

export interface AuditEvent {
  id: string;
  at: string;
  target: TargetRef;
  action: ProposedAction;
  decision: ApprovalDecision | { type: "auto" };
  result?: Pick<ExecResult, "exitCode" | "timedOut">;
}

export interface TokenUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
}

export interface UsageCostSnapshot {
  /** Undiscounted model token cost, float cents. */
  rawCostCents: number;
  /** Amount charged after discounts / Cursor fee, float cents. */
  chargedCents: number;
}

export type AgentProgressPhase =
  | "thinking"
  | "tool"
  | "task"
  | "status"
  | "replying";

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "plan"; steps: string[] }
  | { type: "propose"; action: ProposedAction }
  | {
      /** Ask Drift to open a child prompt card and run this task in parallel. */
      type: "spawn";
      title: string;
      task: string;
    }
  | {
      type: "usage";
      usage: TokenUsageSnapshot;
      cost?: UsageCostSnapshot;
      modelId?: string;
    }
  | {
      type: "status";
      status: "running" | "waiting-approval" | "done" | "error" | "cancelled";
      detail?: string;
    }
  | {
      type: "progress";
      phase: AgentProgressPhase;
      /** Short headline, e.g. Thinking / Searching / Editing */
      title: string;
      /** Optional one-line detail (command, path, thought snippet). */
      detail?: string;
      /** Soft counters for a Cursor-like summary line. */
      summary?: string;
      done?: boolean;
    };

export interface ModelOption {
  id: string;
  displayName: string;
  description?: string;
}

/** Composer interaction mode (Cursor-like subset). */
export type ChatMode = "ask" | "agent" | "plan";

export type AppLocale = "ko" | "en";

/** Local terminal shell on Windows (ignored on macOS/Linux). */
export type LocalShellId = "powershell" | "cmd" | "gitbash";

export interface AppSettings {
  modelId: string;
  chatMode: ChatMode;
  locale: AppLocale;
  /** Preferred Windows local shell. Default: powershell. */
  localShell: LocalShellId;
  /** Seasonal board snow / Christmas overlay. Default: false. */
  christmasTheme: boolean;
  /** Snowfall amount 0–1 (SnowDesk-style). Default: 0.55. */
  christmasSnowAmount: number;
  /** Snowfall speed 0–1. Default: 0.5. */
  christmasSnowSpeed: number;
  /** Higher-quality snow (more CPU). Default: false. */
  christmasSnowSmooth: boolean;
  /** Autumn falling leaves board overlay. Default: false. */
  autumnTheme: boolean;
  /** Leaf fall amount 0–1. Default: 0.55. */
  autumnLeafAmount: number;
  /** Leaf fall / tumble speed 0–1. Default: 0.5. */
  autumnLeafSpeed: number;
  /** Sakura falling petals board overlay. Default: false. */
  sakuraTheme: boolean;
  /** Petal fall amount 0–1. Default: 0.55. */
  sakuraPetalAmount: number;
  /** Petal fall / flutter speed 0–1. Default: 0.5. */
  sakuraPetalSpeed: number;
  /** Rain board overlay. Default: false. */
  rainTheme: boolean;
  /** Rain amount 0–1. Default: 0.55. */
  rainAmount: number;
  /** Rain speed 0–1. Default: 0.5. */
  rainSpeed: number;
  /** Fireflies board overlay. Default: false. */
  firefliesTheme: boolean;
  /** Firefly density 0–1. Default: 0.55. */
  firefliesAmount: number;
  /** Firefly drift speed 0–1. Default: 0.5. */
  firefliesSpeed: number;
}

export interface TabState {
  id: string;
  title: string;
  target: TargetRef;
  backendId: string;
}
