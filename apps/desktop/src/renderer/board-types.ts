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

export type PromptCard = BoardCardBase & {
  kind: "prompt";
  tabId: string;
  title?: string;
  /** Parent prompt card id when this card is a subagent. */
  parentId?: string;
  runStatus?: PromptRunStatus;
};

export type BoardCard = TerminalCard | PromptCard;

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
  kind: "terminal" | "prompt";
  cardId: string;
  tabId: string;
} | null;
