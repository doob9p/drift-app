import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AgentEvent,
  ApprovalDecision,
  AppLocale,
  AppSettings,
  ChatMode,
  FlowDef,
  FlowEvent,
  FlowStep,
  LocalShellId,
  ModelOption,
  ProposedAction,
  SavedSession,
  TokenUsageSnapshot,
  UsageCostSnapshot,
} from "@drift/core";

export type SessionUsageView = {
  turns: number;
  usage: TokenUsageSnapshot;
  cost: UsageCostSnapshot;
};

export type DesktopApi = {
  /** Node process.platform from the preload (darwin | win32 | linux | …). */
  platform: NodeJS.Platform;
  getSessions: () => Promise<SavedSession[]>;
  saveSession: (
    input: Omit<SavedSession, "id" | "createdAt" | "updatedAt"> & {
      id?: string;
    }
  ) => Promise<SavedSession>;
  deleteSession: (id: string) => Promise<boolean>;
  importSshConfig: () => Promise<{
    sessions: SavedSession[];
    created: number;
    updated: number;
    found: number;
    missingConfig: boolean;
  }>;

  createLocalTab: () => Promise<{ tabId: string; title: string }>;
  startLocalPty: (
    tabId: string,
    size: { cols: number; rows: number }
  ) => Promise<{ ok: true } | { error: string }>;
  openLocal: (size?: {
    cols: number;
    rows: number;
  }) => Promise<{ tabId: string; title: string } | { error: string }>;
  openSsh: (
    sessionId: string,
    size?: { cols: number; rows: number }
  ) => Promise<
    | { tabId: string; title: string; kind?: "ssh"; label?: string }
    | { error: string }
  >;
  detectClaude: () => Promise<
    | { ok: true; path: string; source: "path" | "bundled" }
    | { ok: false; error: string }
  >;
  openClaude: (input: {
    cwd: string;
    cardId?: string;
    sessionId?: string;
    title?: string;
    cols?: number;
    rows?: number;
  }) => Promise<
    | {
        tabId: string;
        cardId: string;
        sessionId: string;
        title: string;
        cwd: string;
      }
    | { error: string }
  >;
  updateClaudeSession: (input: {
    cardId: string;
    title?: string;
    status?: "idle" | "running" | "waiting" | "done" | "error";
  }) => Promise<{ ok: boolean }>;
  listClaudeSessions: () => Promise<{
    sessions: Array<{
      cardId: string;
      tabId: string;
      title: string;
      cwd: string;
      sessionId: string;
      status: string;
    }>;
  }>;
  listClaudeProjects: (input?: { extraCwds?: string[] }) => Promise<{
    folders: Array<{
      path: string;
      branch?: string;
      worktreeOf?: string;
      changes?: number;
      ahead?: number;
      behind?: number;
      trusted?: boolean;
    }>;
  }>;
  listClaudeTranscripts: () => Promise<{
    sessions: Array<{
      id: string;
      cwd: string;
      title: string;
      at: number;
      onBoard: boolean;
    }>;
  }>;
  deleteClaudeTranscript: (
    sessionId: string
  ) => Promise<{ ok: true; path: string } | { error: string }>;
  resolveGitRoot: (cwd: string) => Promise<{ root: string | null }>;
  listGitBranches: (
    repo: string
  ) => Promise<{ branches: string[]; current: string | null }>;
  previewWorktree: (input: {
    repo: string;
    branch: string;
  }) => Promise<{ path: string } | { error: string }>;
  addWorktree: (input: {
    repo: string;
    branch: string;
    baseRef?: string;
  }) => Promise<{ path: string } | { error: string }>;
  removeWorktree: (
    worktreePath: string
  ) => Promise<{ ok: true } | { error: string }>;
  sendToClaudeSession: (input: {
    fromCardId?: string;
    toCardId: string;
    message: string;
  }) => Promise<{ ok: true } | { error: string }>;
  onClaudeHook: (
    cb: (payload: {
      cardId: string;
      event: string;
      status: "idle" | "running" | "waiting" | "done" | "error";
      raw?: unknown;
    }) => void
  ) => () => void;
  onClaudeUsage: (
    cb: (payload: {
      cardId: string;
      fiveHour?: { usedPercent: number; resetsAt?: number };
      sevenDay?: { usedPercent: number; resetsAt?: number };
      contextPercent?: number | null;
      modelId?: string;
      modelLabel?: string;
      effortLevel?: string;
      updatedAt: number;
    }) => void
  ) => () => void;
  closeTab: (tabId: string) => Promise<void>;
  /** Local PTY only: true when the shell has a child process running. */
  isTabBusy: (tabId: string) => Promise<boolean>;
  readyTerminal: (tabId: string) => Promise<void>;
  writeTerminal: (tabId: string, data: string) => Promise<void>;
  resizeTerminal: (
    tabId: string,
    cols: number,
    rows: number
  ) => Promise<void>;
  onTerminalData: (
    cb: (payload: { tabId: string; data: string }) => void
  ) => () => void;
  getTabCwd: (tabId: string) => Promise<{ cwd: string | null }>;
  onTerminalCwd: (
    cb: (payload: { tabId: string; cwd: string }) => void
  ) => () => void;

  getApiKeyStatus: () => Promise<{ hasKey: boolean }>;
  setApiKey: (key: string) => Promise<{ ok: true }>;
  clearApiKey: () => Promise<{ ok: true }>;
  getSettings: () => Promise<AppSettings>;
  setModel: (modelId: string) => Promise<AppSettings>;
  setChatMode: (mode: ChatMode) => Promise<AppSettings>;
  setLocale: (locale: AppLocale) => Promise<AppSettings>;
  setLocalShell: (shell: LocalShellId) => Promise<AppSettings>;
  setChristmasTheme: (enabled: boolean) => Promise<AppSettings>;
  setChristmasSnow: (patch: {
    amount?: number;
    speed?: number;
    smooth?: boolean;
  }) => Promise<AppSettings>;
  setAutumnTheme: (enabled: boolean) => Promise<AppSettings>;
  setAutumnLeaves: (patch: {
    amount?: number;
    speed?: number;
  }) => Promise<AppSettings>;
  setSakuraTheme: (enabled: boolean) => Promise<AppSettings>;
  setSakuraPetals: (patch: {
    amount?: number;
    speed?: number;
  }) => Promise<AppSettings>;
  setRainTheme: (enabled: boolean) => Promise<AppSettings>;
  setRain: (patch: {
    amount?: number;
    speed?: number;
  }) => Promise<AppSettings>;
  setFirefliesTheme: (enabled: boolean) => Promise<AppSettings>;
  setFireflies: (patch: {
    amount?: number;
    speed?: number;
  }) => Promise<AppSettings>;
  listLocalShells: () => Promise<{
    platform: string;
    current: LocalShellId;
    shells: Array<{
      id: LocalShellId;
      available: boolean;
      path: string | null;
    }>;
  }>;
  listModels: () => Promise<ModelOption[]>;
  getBoard: () => Promise<unknown>;
  saveBoard: (state: unknown) => Promise<{ ok: true }>;
  listFlows: () => Promise<FlowDef[]>;
  getFlow: (id: string) => Promise<FlowDef | null>;
  upsertFlow: (input: {
    id?: string;
    name: string;
    steps: FlowStep[];
    folder?: string | null;
  }) => Promise<FlowDef>;
  deleteFlow: (id: string) => Promise<{ ok: boolean }>;
  runFlow: (input: {
    flowId: string;
    cardId?: string;
  }) => Promise<{ runId: string } | { error: string }>;
  approveFlowStep: (input: {
    runId: string;
    stepId: string;
  }) => Promise<{ ok: true } | { error: string }>;
  abortFlow: (runId?: string) => Promise<{ stopped: string[] }>;
  writeFlowStdin: (input: {
    runId: string;
    data: string;
  }) => Promise<{ ok: true } | { error: string }>;
  onFlowEvent: (cb: (event: FlowEvent) => void) => () => void;

  getSessionUsage: () => Promise<SessionUsageView>;
  resetSessionUsage: () => Promise<SessionUsageView>;
  getAccountUsage: () => Promise<
    | {
        ok: true;
        usage: {
          usedPercent: number;
          remainingPercent: number;
          apiPercentUsed: number | null;
          totalPercentUsed: number | null;
          membershipType: string | null;
          resetAt: string | null;
          displayMessage: string | null;
        };
      }
    | { ok: false }
  >;
  onUsageUpdated: (
    cb: (payload: {
      last: Extract<AgentEvent, { type: "usage" }>;
      session: SessionUsageView;
    }) => void
  ) => () => void;

  sendAgent: (input: {
    tabId: string;
    message: string;
    images?: Array<{ data: string; mimeType: string }>;
    /** Resume Cursor SDK agent for multi-turn history on this prompt card. */
    agentId?: string;
    agentStoreCwd?: string;
  }) => Promise<{ runId: string } | { error: string }>;
  stopAgent: (input?: {
    runId?: string;
    tabId?: string;
  }) => Promise<{ ok: true; stopped: string[] }>;
  onAgentEvent: (
    cb: (payload: {
      runId: string;
      tabId: string;
      event: AgentEvent;
    }) => void
  ) => () => void;
  onApprovalRequest: (
    cb: (payload: {
      runId: string;
      tabId: string;
      action: ProposedAction;
    }) => void
  ) => () => void;
  resolveApproval: (input: {
    runId: string;
    decision: ApprovalDecision;
  }) => Promise<void>;
  openExternal: (url: string) => Promise<{ ok: boolean }>;
  openPath: (
    targetPath: string
  ) => Promise<{ ok: true } | { ok: false; error?: string }>;
  /** Open a local folder in the Cursor desktop editor. */
  openInCursor: (
    targetPath: string
  ) => Promise<{ ok: true } | { ok: false; error?: string }>;
  onShortcut: (
    cb: (payload: { action: string; index?: number }) => void
  ) => () => void;
  getPathForFile: (file: File) => string;
  getHomeDir: () => Promise<string>;
  pickDirectory: (opts?: {
    title?: string;
    defaultPath?: string;
  }) => Promise<string | null>;
  listSshIdentities: () => Promise<
    Array<{ path: string; label: string; hasPublicKey: boolean }>
  >;
  defaultSshIdentity: () => Promise<string | null>;
  pickSshIdentity: () => Promise<string | null>;
  readSshPublicKey: (
    identityPath: string
  ) => Promise<
    { ok: true; content: string; path: string } | { ok: false; reason: string }
  >;
  copySshPublicKey: (
    identityPath: string
  ) => Promise<
    | { ok: true; path: string }
    | { ok: false; reason: string }
  >;
  writeClipboardText: (text: string) => Promise<{ ok: boolean }>;
  generateSshIdentity: (nameHint?: string) => Promise<
    | { ok: true; path: string; publicKeyPath: string }
    | { ok: false; reason: string; detail?: string }
  >;
  getSshPasswordStatus: (
    sessionId: string
  ) => Promise<{ hasPassword: boolean }>;
  setSshPassword: (
    sessionId: string,
    password: string
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  clearSshPassword: (sessionId: string) => Promise<{ ok: true }>;
  installSshPublicKey: (input: {
    sessionId?: string;
    identityPath: string;
    password?: string;
    session?: {
      name?: string;
      host: string;
      user: string;
      port?: number;
      proxyJump?: string;
    };
  }) => Promise<
    { ok: true } | { ok: false; reason: string; detail?: string }
  >;
  getLocalMetrics: () => Promise<{
    source: "local" | "ssh";
    cpuPct: number;
    load1: number;
    memUsedBytes: number;
    memFreeBytes: number;
    memTotalBytes: number;
    cores: number;
    diskUsedPct: number;
    diskUsedBytes: number;
    diskTotalBytes: number;
    diskMount: string;
    gpuPct: number | null;
    gpuMemPct: number | null;
    gpuName: string | null;
    hostLabel?: string;
    error?: string;
  }>;
  getTabMetrics: (tabId?: string) => Promise<{
    source: "local" | "ssh";
    cpuPct: number;
    load1: number;
    memUsedBytes: number;
    memFreeBytes: number;
    memTotalBytes: number;
    cores: number;
    diskUsedPct: number;
    diskUsedBytes: number;
    diskTotalBytes: number;
    diskMount: string;
    gpuPct: number | null;
    gpuMemPct: number | null;
    gpuName: string | null;
    hostLabel?: string;
    error?: string;
  }>;
  listDir: (dirPath?: string) => Promise<{
    path: string;
    home?: string;
    entries: Array<{
      name: string;
      path: string;
      kind: "dir" | "file";
      size?: number;
    }>;
    error?: string;
  }>;
  listTabDir: (
    tabId: string,
    dirPath?: string
  ) => Promise<{
    path: string;
    home?: string;
    entries: Array<{
      name: string;
      path: string;
      kind: "dir" | "file";
      size?: number;
    }>;
    error?: string;
  }>;
  readFile: (
    filePath: string
  ) => Promise<
    | { path: string; kind: "text"; content: string }
    | { path: string; kind: "image"; mime: string; dataUrl: string }
    | { error: string }
  >;
  writeFile: (
    filePath: string,
    content: string
  ) => Promise<{ ok: true; path: string } | { error: string }>;
  readTabFile: (
    tabId: string,
    filePath: string
  ) => Promise<
    | { path: string; kind: "text"; content: string }
    | { path: string; kind: "image"; mime: string; dataUrl: string }
    | { error: string }
  >;
  writeTabFile: (
    tabId: string,
    filePath: string,
    content: string
  ) => Promise<{ ok: true; path: string } | { error: string }>;
  copyFilesInto: (
    destDir: string,
    sources: string[],
    transferId?: string
  ) => Promise<{ ok?: true; copied?: string[]; error?: string }>;
  uploadFilesToTab: (
    tabId: string,
    destDir: string,
    sources: string[],
    transferId?: string
  ) => Promise<{ ok?: true; error?: string }>;
  downloadFilesFromTab: (
    tabId: string,
    destDir: string,
    sources: string[],
    transferId?: string
  ) => Promise<{ ok?: true; error?: string }>;
  renamePath: (
    fromPath: string,
    toPath: string
  ) => Promise<{ ok?: true; error?: string }>;
  deletePath: (targetPath: string) => Promise<{ ok?: true; error?: string }>;
  renameTabPath: (
    tabId: string,
    fromPath: string,
    toPath: string
  ) => Promise<{ ok?: true; error?: string }>;
  deleteTabPath: (
    tabId: string,
    targetPath: string
  ) => Promise<{ ok?: true; error?: string }>;
  onTransferProgress: (
    cb: (payload: {
      transferId: string;
      percent: number;
      transferred: number;
      total: number;
      currentName?: string;
    }) => void
  ) => () => void;

  getAppVersion: () => Promise<{ version: string; packaged: boolean }>;
  checkForUpdate: () => Promise<
    | {
        ok: true;
        versionInfo: string | null;
        available: boolean;
        update: {
          version: string;
          currentVersion: string;
          releaseName?: string | null;
          releaseNotes?: string | null;
        } | null;
      }
    | { ok: false; reason: "dev" | "error"; message?: string }
  >;
  downloadUpdate: () => Promise<
    | { ok: true }
    | { ok: false; reason: "dev" | "error"; message?: string }
  >;
  installUpdate: () => Promise<
    | { ok: true; version: string | null }
    | { ok: false; reason: "dev" | "error"; message?: string }
  >;
  dismissUpdate: (version: string) => Promise<{ ok: true }>;
  onUpdateAvailable: (
    cb: (payload: {
      version: string;
      currentVersion: string;
      releaseName?: string | null;
      releaseNotes?: string | null;
    }) => void
  ) => () => void;
  onUpdateProgress: (
    cb: (payload: {
      percent: number;
      bytesPerSecond: number;
      transferred: number;
      total: number;
    }) => void
  ) => () => void;
  onUpdateDownloaded: (
    cb: (payload: { version: string; currentVersion: string }) => void
  ) => () => void;
  onUpdateError: (cb: (payload: { message: string }) => void) => () => void;

  listMeetings: () => Promise<
    Array<{
      id: string;
      title: string;
      createdAt: string;
      updatedAt: string;
      durationMs: number;
      status: "idle" | "recording" | "paused" | "done";
      hasAudio: boolean;
      hasTranscript: boolean;
      hasNotes: boolean;
      hasSummary: boolean;
    }>
  >;
  createMeeting: (title?: string) => Promise<{
    meta: {
      id: string;
      title: string;
      createdAt: string;
      updatedAt: string;
      durationMs: number;
      status: "idle" | "recording" | "paused" | "done";
      hasAudio: boolean;
      hasTranscript: boolean;
      hasNotes: boolean;
      hasSummary: boolean;
    };
    transcript: string;
    notes: string;
    summary: string;
    audioPath: string | null;
  }>;
  getMeeting: (id: string) => Promise<{
    meta: {
      id: string;
      title: string;
      createdAt: string;
      updatedAt: string;
      durationMs: number;
      status: "idle" | "recording" | "paused" | "done";
      hasAudio: boolean;
      hasTranscript: boolean;
      hasNotes: boolean;
      hasSummary: boolean;
    };
    transcript: string;
    notes: string;
    summary: string;
    audioPath: string | null;
  } | null>;
  saveMeeting: (input: {
    id: string;
    title?: string;
    durationMs?: number;
    status?: "idle" | "recording" | "paused" | "done";
    transcript?: string;
    notes?: string;
    summary?: string;
  }) => Promise<{
    meta: {
      id: string;
      title: string;
      createdAt: string;
      updatedAt: string;
      durationMs: number;
      status: "idle" | "recording" | "paused" | "done";
      hasAudio: boolean;
      hasTranscript: boolean;
      hasNotes: boolean;
      hasSummary: boolean;
    };
    transcript: string;
    notes: string;
    summary: string;
    audioPath: string | null;
  } | null>;
  saveMeetingAudio: (
    id: string,
    data: ArrayBuffer | Uint8Array
  ) => Promise<{
    meta: {
      id: string;
      title: string;
      createdAt: string;
      updatedAt: string;
      durationMs: number;
      status: "idle" | "recording" | "paused" | "done";
      hasAudio: boolean;
      hasTranscript: boolean;
      hasNotes: boolean;
      hasSummary: boolean;
    };
    transcript: string;
    notes: string;
    summary: string;
    audioPath: string | null;
  } | null>;
  deleteMeeting: (id: string) => Promise<{ ok: true }>;
  exportMeeting: (
    id: string
  ) => Promise<
    | { ok: true; path: string }
    | { ok: false; canceled?: boolean; error?: string }
  >;
  summarizeMeeting: (
    id: string
  ) => Promise<
    | {
        ok: true;
        summary: string;
        meeting: {
          meta: {
            id: string;
            title: string;
            createdAt: string;
            updatedAt: string;
            durationMs: number;
            status: "idle" | "recording" | "paused" | "done";
            hasAudio: boolean;
            hasTranscript: boolean;
            hasNotes: boolean;
            hasSummary: boolean;
          };
          transcript: string;
          notes: string;
          summary: string;
          audioPath: string | null;
        } | null;
        runId: string;
      }
    | { error: string; runId?: string }
  >;
};

const api: DesktopApi = {
  platform: process.platform,
  getSessions: () => ipcRenderer.invoke("sessions:list"),
  saveSession: (input) => ipcRenderer.invoke("sessions:save", input),
  deleteSession: (id) => ipcRenderer.invoke("sessions:delete", id),
  importSshConfig: () => ipcRenderer.invoke("sessions:import-ssh-config"),

  createLocalTab: () => ipcRenderer.invoke("term:create-local-tab"),
  startLocalPty: (tabId, size) =>
    ipcRenderer.invoke("term:start-local", { tabId, ...size }),
  openLocal: (size) => ipcRenderer.invoke("term:open-local", size),
  openSsh: (sessionId, size) =>
    ipcRenderer.invoke("term:open-ssh", sessionId, size),
  detectClaude: () => ipcRenderer.invoke("claude:detect"),
  openClaude: (input) => ipcRenderer.invoke("claude:open", input),
  updateClaudeSession: (input) =>
    ipcRenderer.invoke("claude:update-session", input),
  listClaudeSessions: () => ipcRenderer.invoke("claude:list-sessions"),
  listClaudeProjects: (input) =>
    ipcRenderer.invoke("claude:list-projects", input ?? {}),
  listClaudeTranscripts: () => ipcRenderer.invoke("claude:list-transcripts"),
  deleteClaudeTranscript: (sessionId) =>
    ipcRenderer.invoke("claude:delete-transcript", sessionId),
  resolveGitRoot: (cwd) => ipcRenderer.invoke("git:resolve-root", cwd),
  listGitBranches: (repo) => ipcRenderer.invoke("git:branches", repo),
  previewWorktree: (input) => ipcRenderer.invoke("git:worktree-preview", input),
  addWorktree: (input) => ipcRenderer.invoke("git:worktree-add", input),
  removeWorktree: (worktreePath) =>
    ipcRenderer.invoke("git:worktree-remove", worktreePath),
  sendToClaudeSession: (input) =>
    ipcRenderer.invoke("claude:send-to-session", input),
  onClaudeHook: (cb) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      payload: {
        cardId: string;
        event: string;
        status: "idle" | "running" | "waiting" | "done" | "error";
        raw?: unknown;
      }
    ) => cb(payload);
    ipcRenderer.on("claude:hook", listener);
    return () => ipcRenderer.removeListener("claude:hook", listener);
  },
  onClaudeUsage: (cb) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      payload: {
        cardId: string;
        fiveHour?: { usedPercent: number; resetsAt?: number };
        sevenDay?: { usedPercent: number; resetsAt?: number };
        contextPercent?: number | null;
        updatedAt: number;
      }
    ) => cb(payload);
    ipcRenderer.on("claude:usage", listener);
    return () => ipcRenderer.removeListener("claude:usage", listener);
  },
  closeTab: (tabId) => ipcRenderer.invoke("term:close", tabId),
  isTabBusy: (tabId) => ipcRenderer.invoke("term:is-busy", tabId),
  readyTerminal: (tabId) => ipcRenderer.invoke("term:ready", tabId),
  writeTerminal: (tabId, data) =>
    ipcRenderer.invoke("term:write", { tabId, data }),
  resizeTerminal: (tabId, cols, rows) =>
    ipcRenderer.invoke("term:resize", { tabId, cols, rows }),
  onTerminalData: (cb) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      payload: { tabId: string; data: string }
    ) => cb(payload);
    ipcRenderer.on("term:data", listener);
    return () => ipcRenderer.removeListener("term:data", listener);
  },
  getTabCwd: (tabId) => ipcRenderer.invoke("term:get-cwd", tabId),
  onTerminalCwd: (cb) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      payload: { tabId: string; cwd: string }
    ) => cb(payload);
    ipcRenderer.on("term:cwd", listener);
    return () => ipcRenderer.removeListener("term:cwd", listener);
  },

  getApiKeyStatus: () => ipcRenderer.invoke("settings:api-key-status"),
  setApiKey: (key) => ipcRenderer.invoke("settings:set-api-key", key),
  clearApiKey: () => ipcRenderer.invoke("settings:clear-api-key"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setModel: (modelId) => ipcRenderer.invoke("settings:set-model", modelId),
  setChatMode: (mode) => ipcRenderer.invoke("settings:set-chat-mode", mode),
  setLocale: (locale) => ipcRenderer.invoke("settings:set-locale", locale),
  setLocalShell: (shell) =>
    ipcRenderer.invoke("settings:set-local-shell", shell),
  setChristmasTheme: (enabled) =>
    ipcRenderer.invoke("settings:set-christmas-theme", enabled),
  setChristmasSnow: (patch) =>
    ipcRenderer.invoke("settings:set-christmas-snow", patch),
  setAutumnTheme: (enabled) =>
    ipcRenderer.invoke("settings:set-autumn-theme", enabled),
  setAutumnLeaves: (patch) =>
    ipcRenderer.invoke("settings:set-autumn-leaves", patch),
  setSakuraTheme: (enabled) =>
    ipcRenderer.invoke("settings:set-sakura-theme", enabled),
  setSakuraPetals: (patch) =>
    ipcRenderer.invoke("settings:set-sakura-petals", patch),
  setRainTheme: (enabled) =>
    ipcRenderer.invoke("settings:set-rain-theme", enabled),
  setRain: (patch) => ipcRenderer.invoke("settings:set-rain", patch),
  setFirefliesTheme: (enabled) =>
    ipcRenderer.invoke("settings:set-fireflies-theme", enabled),
  setFireflies: (patch) => ipcRenderer.invoke("settings:set-fireflies", patch),
  listLocalShells: () => ipcRenderer.invoke("settings:list-local-shells"),
  listModels: () => ipcRenderer.invoke("settings:list-models"),
  getBoard: () => ipcRenderer.invoke("board:get"),
  saveBoard: (state) => ipcRenderer.invoke("board:save", state),
  listFlows: () => ipcRenderer.invoke("flows:list"),
  getFlow: (id) => ipcRenderer.invoke("flows:get", id),
  upsertFlow: (input) => ipcRenderer.invoke("flows:upsert", input),
  deleteFlow: (id) => ipcRenderer.invoke("flows:delete", id),
  runFlow: (input) => ipcRenderer.invoke("flows:run", input),
  approveFlowStep: (input) => ipcRenderer.invoke("flows:approve", input),
  abortFlow: (runId) => ipcRenderer.invoke("flows:abort", runId),
  writeFlowStdin: (input) => ipcRenderer.invoke("flows:stdin", input),
  onFlowEvent: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, event: FlowEvent) =>
      cb(event);
    ipcRenderer.on("flows:event", listener);
    return () => ipcRenderer.removeListener("flows:event", listener);
  },

  getSessionUsage: () => ipcRenderer.invoke("usage:get-session"),
  resetSessionUsage: () => ipcRenderer.invoke("usage:reset-session"),
  getAccountUsage: () => ipcRenderer.invoke("usage:get-account"),
  onUsageUpdated: (cb) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      payload: {
        last: Extract<AgentEvent, { type: "usage" }>;
        session: SessionUsageView;
      }
    ) => cb(payload);
    ipcRenderer.on("usage:updated", listener);
    return () => ipcRenderer.removeListener("usage:updated", listener);
  },

  sendAgent: (input) => ipcRenderer.invoke("agent:send", input),
  stopAgent: (input) => ipcRenderer.invoke("agent:stop", input),
  onAgentEvent: (cb) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      payload: {
        runId: string;
        tabId: string;
        event: AgentEvent;
      }
    ) => cb(payload);
    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.removeListener("agent:event", listener);
  },
  onApprovalRequest: (cb) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      payload: {
        runId: string;
        tabId: string;
        action: ProposedAction;
      }
    ) => cb(payload);
    ipcRenderer.on("agent:approval", listener);
    return () => ipcRenderer.removeListener("agent:approval", listener);
  },
  resolveApproval: (input) =>
    ipcRenderer.invoke("agent:resolve-approval", input),
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  openPath: (targetPath) => ipcRenderer.invoke("shell:open-path", targetPath),
  openInCursor: (targetPath) =>
    ipcRenderer.invoke("shell:open-in-cursor", targetPath),
  onShortcut: (cb) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      payload: { action: string; index?: number }
    ) => cb(payload);
    ipcRenderer.on("app:shortcut", listener);
    return () => ipcRenderer.removeListener("app:shortcut", listener);
  },
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  getHomeDir: () => ipcRenderer.invoke("fs:home"),
  pickDirectory: (opts) => ipcRenderer.invoke("fs:pick-directory", opts),
  listSshIdentities: () => ipcRenderer.invoke("ssh:list-identities"),
  defaultSshIdentity: () => ipcRenderer.invoke("ssh:default-identity"),
  pickSshIdentity: () => ipcRenderer.invoke("ssh:pick-identity"),
  readSshPublicKey: (identityPath) =>
    ipcRenderer.invoke("ssh:read-public-key", identityPath),
  copySshPublicKey: (identityPath) =>
    ipcRenderer.invoke("ssh:copy-public-key", identityPath),
  writeClipboardText: (text) =>
    ipcRenderer.invoke("clipboard:write-text", text),
  generateSshIdentity: (nameHint) =>
    ipcRenderer.invoke("ssh:generate-identity", nameHint),
  getSshPasswordStatus: (sessionId) =>
    ipcRenderer.invoke("ssh:password-status", sessionId),
  setSshPassword: (sessionId, password) =>
    ipcRenderer.invoke("ssh:set-password", { sessionId, password }),
  clearSshPassword: (sessionId) =>
    ipcRenderer.invoke("ssh:clear-password", sessionId),
  installSshPublicKey: (input) =>
    ipcRenderer.invoke("ssh:install-public-key", input),
  getLocalMetrics: () => ipcRenderer.invoke("metrics:local"),
  getTabMetrics: (tabId) => ipcRenderer.invoke("metrics:tab", tabId),
  listDir: (dirPath) => ipcRenderer.invoke("fs:list", dirPath),
  listTabDir: (tabId, dirPath) =>
    ipcRenderer.invoke("fs:list-tab", { tabId, dirPath }),
  readFile: (filePath) => ipcRenderer.invoke("fs:read-file", filePath),
  writeFile: (filePath, content) =>
    ipcRenderer.invoke("fs:write-file", { path: filePath, content }),
  readTabFile: (tabId, filePath) =>
    ipcRenderer.invoke("fs:read-tab-file", { tabId, path: filePath }),
  writeTabFile: (tabId, filePath, content) =>
    ipcRenderer.invoke("fs:write-tab-file", {
      tabId,
      path: filePath,
      content,
    }),
  copyFilesInto: (destDir, sources, transferId) =>
    ipcRenderer.invoke("fs:copy-into", { destDir, sources, transferId }),
  uploadFilesToTab: (tabId, destDir, sources, transferId) =>
    ipcRenderer.invoke("fs:upload-tab", {
      tabId,
      destDir,
      sources,
      transferId,
    }),
  downloadFilesFromTab: (tabId, destDir, sources, transferId) =>
    ipcRenderer.invoke("fs:download-tab", {
      tabId,
      destDir,
      sources,
      transferId,
    }),
  renamePath: (fromPath, toPath) =>
    ipcRenderer.invoke("fs:rename", { fromPath, toPath }),
  deletePath: (targetPath) => ipcRenderer.invoke("fs:delete", { targetPath }),
  renameTabPath: (tabId, fromPath, toPath) =>
    ipcRenderer.invoke("fs:rename-tab", { tabId, fromPath, toPath }),
  deleteTabPath: (tabId, targetPath) =>
    ipcRenderer.invoke("fs:delete-tab", { tabId, targetPath }),
  onTransferProgress: (cb) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      payload: {
        transferId: string;
        percent: number;
        transferred: number;
        total: number;
        currentName?: string;
      }
    ) => cb(payload);
    ipcRenderer.on("fs:transfer-progress", listener);
    return () => ipcRenderer.removeListener("fs:transfer-progress", listener);
  },

  getAppVersion: () => ipcRenderer.invoke("updater:get-version"),
  checkForUpdate: () => ipcRenderer.invoke("updater:check"),
  downloadUpdate: () => ipcRenderer.invoke("updater:download"),
  installUpdate: () => ipcRenderer.invoke("updater:install"),
  dismissUpdate: (version) => ipcRenderer.invoke("updater:dismiss", version),
  onUpdateAvailable: (cb) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      payload: {
        version: string;
        currentVersion: string;
        releaseName?: string | null;
        releaseNotes?: string | null;
      }
    ) => cb(payload);
    ipcRenderer.on("updater:available", listener);
    return () => ipcRenderer.removeListener("updater:available", listener);
  },
  onUpdateProgress: (cb) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      payload: {
        percent: number;
        bytesPerSecond: number;
        transferred: number;
        total: number;
      }
    ) => cb(payload);
    ipcRenderer.on("updater:progress", listener);
    return () => ipcRenderer.removeListener("updater:progress", listener);
  },
  onUpdateDownloaded: (cb) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      payload: { version: string; currentVersion: string }
    ) => cb(payload);
    ipcRenderer.on("updater:downloaded", listener);
    return () => ipcRenderer.removeListener("updater:downloaded", listener);
  },
  onUpdateError: (cb) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      payload: { message: string }
    ) => cb(payload);
    ipcRenderer.on("updater:error", listener);
    return () => ipcRenderer.removeListener("updater:error", listener);
  },

  listMeetings: () => ipcRenderer.invoke("meeting:list"),
  createMeeting: (title) => ipcRenderer.invoke("meeting:create", title),
  getMeeting: (id) => ipcRenderer.invoke("meeting:get", id),
  saveMeeting: (input) => ipcRenderer.invoke("meeting:save", input),
  saveMeetingAudio: (id, data) =>
    ipcRenderer.invoke("meeting:save-audio", { id, data }),
  deleteMeeting: (id) => ipcRenderer.invoke("meeting:delete", id),
  exportMeeting: (id) => ipcRenderer.invoke("meeting:export", id),
  summarizeMeeting: (id) => ipcRenderer.invoke("meeting:summarize", id),
};

contextBridge.exposeInMainWorld("cursorTerm", api);
