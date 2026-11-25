/** User-authored deploy / build pipelines (mini flow runner). */

export type FlowStepKind = "local" | "ssh" | "approve" | "upload";

export type FlowStep = {
  id: string;
  kind: FlowStepKind;
  /** Short label shown in the editor and board. */
  label: string;
  /** Shell command for local / ssh steps. */
  command?: string;
  /** Working directory for local / ssh / upload (local base) steps. */
  cwd?: string;
  /** Saved SSH session id for ssh / upload steps. */
  sessionId?: string;
  /**
   * Local files or folders to upload (absolute, or relative to cwd).
   * Used by upload steps — uses the session’s saved password like SSH login.
   */
  paths?: string[];
  /** Remote destination directory for upload steps. */
  remoteDir?: string;
  /**
   * Lines to send automatically when a local/ssh step waits for input
   * (account name, yes/no, passwords, …). One answer per line, in order.
   */
  autoInputs?: string[];
  timeoutMs?: number;
};

export type FlowDef = {
  id: string;
  name: string;
  steps: FlowStep[];
  /** Optional sidebar folder name (same idea as SSH host folders). */
  folder?: string;
  createdAt: string;
  updatedAt: string;
};

export type FlowStepRunStatus =
  | "pending"
  | "running"
  | "waiting"
  | "ok"
  | "fail"
  | "skipped";

export type FlowRunStatus =
  | "idle"
  | "running"
  | "waiting"
  | "done"
  | "error";

export type FlowStepRuntime = {
  stepId: string;
  status: FlowStepRunStatus;
  exitCode?: number | null;
  output?: string;
  error?: string;
};

export type FlowEvent =
  | {
      type: "started";
      runId: string;
      flowId: string;
      cardId?: string;
    }
  | {
      type: "step";
      runId: string;
      flowId: string;
      cardId?: string;
      stepId: string;
      status: FlowStepRunStatus;
      exitCode?: number | null;
      output?: string;
      error?: string;
    }
  | {
      /** Live stdout/stderr chunk while a step is running. */
      type: "output";
      runId: string;
      flowId: string;
      cardId?: string;
      stepId: string;
      chunk: string;
    }
  | {
      type: "waiting";
      runId: string;
      flowId: string;
      cardId?: string;
      stepId: string;
      label: string;
    }
  | {
      type: "finished";
      runId: string;
      flowId: string;
      cardId?: string;
      status: "done" | "error";
      error?: string;
    }
  | {
      type: "aborted";
      runId: string;
      flowId: string;
      cardId?: string;
    };
