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

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "plan"; steps: string[] }
  | { type: "propose"; action: ProposedAction }
  | {
      type: "usage";
      usage: TokenUsageSnapshot;
      cost?: UsageCostSnapshot;
      modelId?: string;
    }
  | {
      type: "status";
      status: "running" | "waiting-approval" | "done" | "error";
      detail?: string;
    };

export interface ModelOption {
  id: string;
  displayName: string;
  description?: string;
}

/** Composer interaction mode (Cursor-like subset). */
export type ChatMode = "ask" | "agent" | "plan";

export type AppLocale = "ko" | "en";

export interface AppSettings {
  modelId: string;
  chatMode: ChatMode;
  locale: AppLocale;
}

export interface TabState {
  id: string;
  title: string;
  target: TargetRef;
  backendId: string;
}
