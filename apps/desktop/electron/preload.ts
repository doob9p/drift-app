import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AgentEvent,
  ApprovalDecision,
  AppLocale,
  AppSettings,
  ChatMode,
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
  closeTab: (tabId: string) => Promise<void>;
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
  listModels: () => Promise<ModelOption[]>;

  getSessionUsage: () => Promise<SessionUsageView>;
  resetSessionUsage: () => Promise<SessionUsageView>;
  onUsageUpdated: (
    cb: (payload: {
      last: Extract<AgentEvent, { type: "usage" }>;
      session: SessionUsageView;
    }) => void
  ) => () => void;

  sendAgent: (input: {
    tabId: string;
    message: string;
  }) => Promise<{ runId: string } | { error: string }>;
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
  onShortcut: (
    cb: (payload: { action: string; index?: number }) => void
  ) => () => void;
  getPathForFile: (file: File) => string;
  getHomeDir: () => Promise<string>;
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
    | { ok: true; versionInfo: string | null }
    | { ok: false; reason: "dev" | "error"; message?: string }
  >;
  downloadUpdate: () => Promise<
    | { ok: true }
    | { ok: false; reason: "dev" | "error"; message?: string }
  >;
  installUpdate: () => Promise<
    | { ok: true; version: string | null }
    | { ok: false; reason: "dev" }
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
};

const api: DesktopApi = {
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
  closeTab: (tabId) => ipcRenderer.invoke("term:close", tabId),
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
  listModels: () => ipcRenderer.invoke("settings:list-models"),

  getSessionUsage: () => ipcRenderer.invoke("usage:get-session"),
  resetSessionUsage: () => ipcRenderer.invoke("usage:reset-session"),
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
  getLocalMetrics: () => ipcRenderer.invoke("metrics:local"),
  getTabMetrics: (tabId) => ipcRenderer.invoke("metrics:tab", tabId),
  listDir: (dirPath) => ipcRenderer.invoke("fs:list", dirPath),
  listTabDir: (tabId, dirPath) =>
    ipcRenderer.invoke("fs:list-tab", { tabId, dirPath }),
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
};

contextBridge.exposeInMainWorld("cursorTerm", api);
