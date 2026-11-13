"use strict";
const electron = require("electron");
const api = {
  getSessions: () => electron.ipcRenderer.invoke("sessions:list"),
  saveSession: (input) => electron.ipcRenderer.invoke("sessions:save", input),
  deleteSession: (id) => electron.ipcRenderer.invoke("sessions:delete", id),
  importSshConfig: () => electron.ipcRenderer.invoke("sessions:import-ssh-config"),
  createLocalTab: () => electron.ipcRenderer.invoke("term:create-local-tab"),
  startLocalPty: (tabId, size) => electron.ipcRenderer.invoke("term:start-local", { tabId, ...size }),
  openLocal: (size) => electron.ipcRenderer.invoke("term:open-local", size),
  openSsh: (sessionId, size) => electron.ipcRenderer.invoke("term:open-ssh", sessionId, size),
  closeTab: (tabId) => electron.ipcRenderer.invoke("term:close", tabId),
  readyTerminal: (tabId) => electron.ipcRenderer.invoke("term:ready", tabId),
  writeTerminal: (tabId, data) => electron.ipcRenderer.invoke("term:write", { tabId, data }),
  resizeTerminal: (tabId, cols, rows) => electron.ipcRenderer.invoke("term:resize", { tabId, cols, rows }),
  onTerminalData: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("term:data", listener);
    return () => electron.ipcRenderer.removeListener("term:data", listener);
  },
  getTabCwd: (tabId) => electron.ipcRenderer.invoke("term:get-cwd", tabId),
  onTerminalCwd: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("term:cwd", listener);
    return () => electron.ipcRenderer.removeListener("term:cwd", listener);
  },
  getApiKeyStatus: () => electron.ipcRenderer.invoke("settings:api-key-status"),
  setApiKey: (key) => electron.ipcRenderer.invoke("settings:set-api-key", key),
  clearApiKey: () => electron.ipcRenderer.invoke("settings:clear-api-key"),
  getSettings: () => electron.ipcRenderer.invoke("settings:get"),
  setModel: (modelId) => electron.ipcRenderer.invoke("settings:set-model", modelId),
  setChatMode: (mode) => electron.ipcRenderer.invoke("settings:set-chat-mode", mode),
  setLocale: (locale) => electron.ipcRenderer.invoke("settings:set-locale", locale),
  listModels: () => electron.ipcRenderer.invoke("settings:list-models"),
  getSessionUsage: () => electron.ipcRenderer.invoke("usage:get-session"),
  resetSessionUsage: () => electron.ipcRenderer.invoke("usage:reset-session"),
  getAccountUsage: () => electron.ipcRenderer.invoke("usage:get-account"),
  onUsageUpdated: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("usage:updated", listener);
    return () => electron.ipcRenderer.removeListener("usage:updated", listener);
  },
  sendAgent: (input) => electron.ipcRenderer.invoke("agent:send", input),
  stopAgent: (input) => electron.ipcRenderer.invoke("agent:stop", input),
  onAgentEvent: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("agent:event", listener);
    return () => electron.ipcRenderer.removeListener("agent:event", listener);
  },
  onApprovalRequest: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("agent:approval", listener);
    return () => electron.ipcRenderer.removeListener("agent:approval", listener);
  },
  resolveApproval: (input) => electron.ipcRenderer.invoke("agent:resolve-approval", input),
  openExternal: (url) => electron.ipcRenderer.invoke("shell:open-external", url),
  onShortcut: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("app:shortcut", listener);
    return () => electron.ipcRenderer.removeListener("app:shortcut", listener);
  },
  getPathForFile: (file) => {
    try {
      return electron.webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  getHomeDir: () => electron.ipcRenderer.invoke("fs:home"),
  getLocalMetrics: () => electron.ipcRenderer.invoke("metrics:local"),
  getTabMetrics: (tabId) => electron.ipcRenderer.invoke("metrics:tab", tabId),
  listDir: (dirPath) => electron.ipcRenderer.invoke("fs:list", dirPath),
  listTabDir: (tabId, dirPath) => electron.ipcRenderer.invoke("fs:list-tab", { tabId, dirPath }),
  readFile: (filePath) => electron.ipcRenderer.invoke("fs:read-file", filePath),
  writeFile: (filePath, content) => electron.ipcRenderer.invoke("fs:write-file", { path: filePath, content }),
  readTabFile: (tabId, filePath) => electron.ipcRenderer.invoke("fs:read-tab-file", { tabId, path: filePath }),
  writeTabFile: (tabId, filePath, content) => electron.ipcRenderer.invoke("fs:write-tab-file", {
    tabId,
    path: filePath,
    content
  }),
  copyFilesInto: (destDir, sources, transferId) => electron.ipcRenderer.invoke("fs:copy-into", { destDir, sources, transferId }),
  uploadFilesToTab: (tabId, destDir, sources, transferId) => electron.ipcRenderer.invoke("fs:upload-tab", {
    tabId,
    destDir,
    sources,
    transferId
  }),
  downloadFilesFromTab: (tabId, destDir, sources, transferId) => electron.ipcRenderer.invoke("fs:download-tab", {
    tabId,
    destDir,
    sources,
    transferId
  }),
  renamePath: (fromPath, toPath) => electron.ipcRenderer.invoke("fs:rename", { fromPath, toPath }),
  deletePath: (targetPath) => electron.ipcRenderer.invoke("fs:delete", { targetPath }),
  renameTabPath: (tabId, fromPath, toPath) => electron.ipcRenderer.invoke("fs:rename-tab", { tabId, fromPath, toPath }),
  deleteTabPath: (tabId, targetPath) => electron.ipcRenderer.invoke("fs:delete-tab", { tabId, targetPath }),
  onTransferProgress: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("fs:transfer-progress", listener);
    return () => electron.ipcRenderer.removeListener("fs:transfer-progress", listener);
  },
  getAppVersion: () => electron.ipcRenderer.invoke("updater:get-version"),
  checkForUpdate: () => electron.ipcRenderer.invoke("updater:check"),
  downloadUpdate: () => electron.ipcRenderer.invoke("updater:download"),
  installUpdate: () => electron.ipcRenderer.invoke("updater:install"),
  dismissUpdate: (version) => electron.ipcRenderer.invoke("updater:dismiss", version),
  onUpdateAvailable: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("updater:available", listener);
    return () => electron.ipcRenderer.removeListener("updater:available", listener);
  },
  onUpdateProgress: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("updater:progress", listener);
    return () => electron.ipcRenderer.removeListener("updater:progress", listener);
  },
  onUpdateDownloaded: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("updater:downloaded", listener);
    return () => electron.ipcRenderer.removeListener("updater:downloaded", listener);
  },
  onUpdateError: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("updater:error", listener);
    return () => electron.ipcRenderer.removeListener("updater:error", listener);
  },
  listMeetings: () => electron.ipcRenderer.invoke("meeting:list"),
  createMeeting: (title) => electron.ipcRenderer.invoke("meeting:create", title),
  getMeeting: (id) => electron.ipcRenderer.invoke("meeting:get", id),
  saveMeeting: (input) => electron.ipcRenderer.invoke("meeting:save", input),
  saveMeetingAudio: (id, data) => electron.ipcRenderer.invoke("meeting:save-audio", { id, data }),
  deleteMeeting: (id) => electron.ipcRenderer.invoke("meeting:delete", id),
  exportMeeting: (id) => electron.ipcRenderer.invoke("meeting:export", id),
  summarizeMeeting: (id) => electron.ipcRenderer.invoke("meeting:summarize", id)
};
electron.contextBridge.exposeInMainWorld("cursorTerm", api);
