export type BoardCardBase = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
};

export type TerminalCard = BoardCardBase & {
  kind: "terminal";
  tabId: string;
  minimized: boolean;
  title: string;
};

export type PromptRunStatus =
  | "idle"
  | "running"
  | "waiting"
  | "done"
  | "error";

/** Chat turns stored with the prompt card so restart restores the thread. */
export type PersistedChatMessage =
  | {
      role: "user";
      text: string;
      refs?: { name: string; kind: "file" | "dir" }[];
      attachments?: { name: string; kind: "image" | "text" | "binary" }[];
    }
  | {
      role: "assistant";
      text: string;
      tokens?: number;
      modelId?: string;
      cost?: string;
      ts?: number;
    }
  | { role: "system"; text: string }
  | { role: "error"; text: string }
  | { role: "plan"; steps: string[] };

export type PromptCard = BoardCardBase & {
  kind: "prompt";
  tabId: string;
  title?: string;
  /** Parent prompt card id when this card is a subagent. */
  parentId?: string;
  runStatus?: PromptRunStatus;
  /** Cursor SDK agent for multi-turn resume across app restarts. */
  agentId?: string;
  agentStoreCwd?: string;
  /** Visible chat thread for this card. Cleared when the card is closed. */
  messages?: PersistedChatMessage[];
};

export type FlowCardRunStatus =
  | "idle"
  | "running"
  | "waiting"
  | "done"
  | "error";

export type FlowCardStepState = {
  stepId: string;
  label: string;
  kind: string;
  status: "pending" | "running" | "waiting" | "ok" | "fail" | "skipped";
  /** Shell command (local / ssh). */
  command?: string;
  cwd?: string;
  sessionId?: string;
  paths?: string[];
  remoteDir?: string;
  exitCode?: number | null;
  output?: string;
  error?: string;
};

/** Board card that runs a saved deploy/build flow. */
export type FlowCard = BoardCardBase & {
  kind: "flow";
  flowId: string;
  title: string;
  runStatus?: FlowCardRunStatus;
  runId?: string;
  steps?: FlowCardStepState[];
};

/** Detached step inspector linked to a flow card (n8n-style detail pane). */
export type FlowInspectCard = BoardCardBase & {
  kind: "flowInspect";
  flowCardId: string;
  stepId: string;
  title: string;
};

export type BoardCard = TerminalCard | PromptCard | FlowCard | FlowInspectCard;

export type BoardCamera = {
  x: number;
  y: number;
  zoom: number;
};

export type BoardPersistedState = {
  cards: BoardCard[];
  camera?: BoardCamera;
};

export type BoardFocus = {
  kind: "terminal" | "prompt" | "flow" | "flowInspect";
  cardId: string;
  tabId?: string;
} | null;
