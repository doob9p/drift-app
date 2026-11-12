import type {
  ApprovalDecision,
  Effect,
  PermissionMode,
  ProposedAction,
  SessionRule,
} from "./types.js";

const DESTRUCTIVE =
  /\b(rm\s+-rf|rm\s+-r|dd\s+|mkfs|shutdown|reboot|git\s+push\s+--force|git\s+push\s+-f|drop\s+table|truncate\s+)\b/i;
const WRITE =
  /\b(rm\s+|mv\s+|cp\s+|mkdir\s+|touch\s+|chmod\s+|chown\s+|npm\s+i|npm\s+install|pnpm\s+i|yarn\s+add|pip\s+install|brew\s+install|apt\s+|docker\s+|kubectl\s+apply|git\s+commit|git\s+push|tee\s+|sed\s+-i|>\s*|>>\s*)\b/i;
const NETWORK =
  /\b(curl\s+|wget\s+|nc\s+|ssh\s+|scp\s+|rsync\s+|npm\s+publish|pip\s+upload)\b/i;
const READ =
  /^(ls|pwd|whoami|date|uname|cat|head|tail|less|more|echo|which|type|file|stat|df|du|ps|top|htop|git\s+status|git\s+diff|git\s+log|git\s+branch)\b/i;

export function classifyCommand(command: string): Effect {
  const trimmed = command.trim();
  if (!trimmed) return "unknown";
  if (DESTRUCTIVE.test(trimmed)) return "destructive";
  if (NETWORK.test(trimmed)) return "network";
  if (WRITE.test(trimmed)) return "write";
  if (READ.test(trimmed)) return "read";
  return "unknown";
}

export class ApprovalPolicy {
  mode: PermissionMode;
  sessionRules: SessionRule[];

  constructor(mode: PermissionMode = "ask") {
    this.mode = mode;
    this.sessionRules = [];
  }

  classify(command: string): Effect {
    return classifyCommand(command);
  }

  needsApproval(action: ProposedAction): boolean {
    if (this.mode === "read-only") {
      return action.effect !== "read";
    }
    if (action.effect === "read") return false;
    if (this.mode === "session-allow") {
      return !this.matchesRule(action);
    }
    // ask
    if (this.matchesRule(action)) return false;
    return true;
  }

  remember(action: ProposedAction, decision: ApprovalDecision): void {
    if (decision.type !== "allow-session") return;
    const sessionId =
      action.target.kind === "ssh" ? action.target.sessionId : undefined;
    this.sessionRules.push({
      sessionId,
      effect: action.effect,
      commandPrefix: action.command?.trim().split(/\s+/)[0],
    });
  }

  private matchesRule(action: ProposedAction): boolean {
    const sessionId =
      action.target.kind === "ssh" ? action.target.sessionId : undefined;
    return this.sessionRules.some((rule) => {
      if (rule.sessionId && rule.sessionId !== sessionId) return false;
      if (rule.effect !== action.effect && rule.effect !== "unknown") {
        // allow-session for write also covers same prefix
      }
      if (rule.commandPrefix && action.command) {
        return action.command.trim().startsWith(rule.commandPrefix);
      }
      return rule.effect === action.effect;
    });
  }
}
