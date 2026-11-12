import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  dialog,
  shell,
  type MenuItemConstructorOptions,
  type NativeImage,
} from "electron";
import path from "node:path";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import {
  ApprovalPolicy,
  SessionStore,
  newId,
  parseSshConfig,
  type ApprovalDecision,
  type ProposedAction,
  type SavedSession,
} from "@drift/core";
import { createLocalPty, type LocalPtyBackend } from "@drift/host-local";
import {
  createSshPty,
  downloadFilesViaScp,
  uploadFilesViaScp,
  type SshPtyBackend,
} from "@drift/host-ssh";
import { listModels, sendAgent } from "@drift/agent-cursor";
import type {
  AppLocale,
  AppSettings,
  ChatMode,
  TokenUsageSnapshot,
  UsageCostSnapshot,
} from "@drift/core";
import { initAutoUpdater } from "./updater";

type Backend = LocalPtyBackend | SshPtyBackend;

type Tab = {
  id: string;
  title: string;
  backend: Backend | null;
  ready: boolean;
  buffer: string[];
  lastCwd?: string;
  lastCols?: number;
  lastRows?: number;
  oscBuf?: string;
  unsub?: () => void;
  unsubExit?: () => void;
};

let cwdPollTimer: NodeJS.Timeout | null = null;

type SessionUsage = {
  turns: number;
  usage: TokenUsageSnapshot;
  cost: UsageCostSnapshot;
};

let mainWindow: BrowserWindow | null = null;
let sessionStore: SessionStore;
const tabs = new Map<string, Tab>();
const policy = new ApprovalPolicy("ask");
const pendingApprovals = new Map<
  string,
  {
    resolve: (d: ApprovalDecision) => void;
    action: ProposedAction;
    tabId: string;
  }
>();
let appSettings: AppSettings = {
  modelId: "composer-2.5",
  chatMode: "agent",
  locale: "ko",
};

function applyChatModeToPolicy(mode: ChatMode): void {
  policy.mode = mode === "ask" ? "read-only" : "ask";
  if (mode !== "agent") {
    policy.sessionRules = [];
  }
}
let sessionUsage: SessionUsage = emptySessionUsage();

function emptySessionUsage(): SessionUsage {
  return {
    turns: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    },
    cost: { rawCostCents: 0, chargedCents: 0 },
  };
}

function dataDir(): string {
  return path.join(app.getPath("userData"), "drift");
}

function brandAsset(...parts: string[]): string {
  return path.join(__dirname, "../resources/brand", ...parts);
}

function loadAppIcon(): NativeImage | undefined {
  const candidates = [
    brandAsset("icon.icns"),
    brandAsset("icon.png"),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const image = nativeImage.createFromPath(file);
    if (!image.isEmpty()) return image;
  }
  return undefined;
}

function apiKeyPath(): string {
  return path.join(dataDir(), "api-key.bin");
}

function settingsPath(): string {
  return path.join(dataDir(), "settings.json");
}

async function loadApiKey(): Promise<string> {
  try {
    const { readFile: rf } = await import("node:fs/promises");
    const buf = await rf(apiKeyPath());
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(buf);
    }
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

async function saveApiKey(key: string): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(dataDir(), { recursive: true });
  if (safeStorage.isEncryptionAvailable()) {
    await writeFile(apiKeyPath(), safeStorage.encryptString(key));
  } else {
    await writeFile(apiKeyPath(), key, "utf8");
  }
}

async function clearApiKey(): Promise<void> {
  const { unlink } = await import("node:fs/promises");
  try {
    await unlink(apiKeyPath());
  } catch {
    /* ignore */
  }
}

function normalizeChatMode(value: unknown): ChatMode {
  return value === "ask" || value === "plan" || value === "agent"
    ? value
    : "agent";
}

function normalizeLocale(value: unknown): AppLocale {
  return value === "en" ? "en" : "ko";
}

async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await readFile(settingsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      modelId: parsed.modelId?.trim() || "composer-2.5",
      chatMode: normalizeChatMode(parsed.chatMode),
      locale: normalizeLocale(parsed.locale),
    };
  } catch {
    return {
      modelId: "composer-2.5",
      chatMode: "agent",
      locale: "ko",
    };
  }
}

async function saveSettings(next: AppSettings): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(dataDir(), { recursive: true });
  appSettings = next;
  await writeFile(settingsPath(), JSON.stringify(next, null, 2), "utf8");
}

function addUsage(
  usage: TokenUsageSnapshot,
  cost?: UsageCostSnapshot
): SessionUsage {
  sessionUsage = {
    turns: sessionUsage.turns + 1,
    usage: {
      inputTokens: sessionUsage.usage.inputTokens + usage.inputTokens,
      outputTokens: sessionUsage.usage.outputTokens + usage.outputTokens,
      cacheReadTokens:
        sessionUsage.usage.cacheReadTokens + usage.cacheReadTokens,
      cacheWriteTokens:
        sessionUsage.usage.cacheWriteTokens + usage.cacheWriteTokens,
      totalTokens: sessionUsage.usage.totalTokens + usage.totalTokens,
      reasoningTokens:
        (sessionUsage.usage.reasoningTokens ?? 0) +
        (usage.reasoningTokens ?? 0),
    },
    cost: {
      rawCostCents:
        sessionUsage.cost.rawCostCents + (cost?.rawCostCents ?? 0),
      chargedCents:
        sessionUsage.cost.chargedCents + (cost?.chargedCents ?? 0),
    },
  };
  return sessionUsage;
}

function sendShortcut(
  action: string,
  payload?: Record<string, unknown>
): void {
  mainWindow?.webContents.send("app:shortcut", { action, ...payload });
}

function setWindowZoom(factor: number): void {
  const wc = mainWindow?.webContents;
  if (!wc) return;
  const next = Math.min(2, Math.max(0.5, factor));
  wc.setZoomFactor(next);
  sendShortcut("refit-terminals");
}

function nudgeWindowZoom(delta: number): void {
  const wc = mainWindow?.webContents;
  if (!wc) return;
  setWindowZoom(wc.getZoomFactor() + delta);
}

function buildApplicationMenu(): void {
  const isMac = process.platform === "darwin";
  const tabItems: MenuItemConstructorOptions[] = [];
  for (let i = 1; i <= 9; i++) {
    tabItems.push({
      label: `Tab ${i}`,
      accelerator: `CmdOrCtrl+${i}`,
      click: () => sendShortcut("focus-tab", { index: i - 1 }),
    });
  }

  const fileMenu: MenuItemConstructorOptions = {
    label: "File",
    submenu: [
      {
        label: "Save",
        accelerator: "CmdOrCtrl+S",
        click: () => sendShortcut("save"),
      },
      {
        label: "Find",
        accelerator: "CmdOrCtrl+F",
        click: () => sendShortcut("find"),
      },
      { type: "separator" },
      {
        label: "Close Tab",
        accelerator: "CmdOrCtrl+W",
        click: () => sendShortcut("close-tab"),
      },
    ],
  };

  const shellMenu: MenuItemConstructorOptions = {
    label: "Shell",
    submenu: [
      {
        label: "New Local Terminal",
        accelerator: "CmdOrCtrl+T",
        click: () => sendShortcut("new-local"),
      },
      { type: "separator" },
      {
        label: "Clear Scrollback",
        accelerator: "CmdOrCtrl+K",
        click: () => sendShortcut("clear"),
      },
      { type: "separator" },
      {
        label: "Previous Tab",
        accelerator: "CmdOrCtrl+Shift+[",
        click: () => sendShortcut("prev-tab"),
      },
      {
        label: "Next Tab",
        accelerator: "CmdOrCtrl+Shift+]",
        click: () => sendShortcut("next-tab"),
      },
      { type: "separator" },
      ...tabItems,
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      {
        label: "Actual Size",
        accelerator: "CmdOrCtrl+0",
        click: () => setWindowZoom(1),
      },
      {
        label: "Zoom In",
        accelerator: "CmdOrCtrl+=",
        click: () => nudgeWindowZoom(0.1),
      },
      {
        label: "Zoom Out",
        accelerator: "CmdOrCtrl+-",
        click: () => nudgeWindowZoom(-0.1),
      },
      { type: "separator" },
      { role: "reload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: "Drift",
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              {
                label: "Settings…",
                accelerator: "CmdOrCtrl+,",
                click: () => sendShortcut("settings"),
              },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : [
          {
            label: "Drift",
            submenu: [
              {
                label: "Settings…",
                accelerator: "CmdOrCtrl+,",
                click: () => sendShortcut("settings"),
              },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]),
    fileMenu,
    shellMenu,
    { role: "editMenu" },
    viewMenu,
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [{ type: "separator" as const }, { role: "front" as const }]
          : [{ role: "close" as const }]),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  const icon = loadAppIcon();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: "Drift",
    backgroundColor: "#0a0c10",
    ...(icon ? { icon } : {}),
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 16, y: 14 },
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

function emitTabCwd(tabId: string, cwd: string): void {
  const tab = tabs.get(tabId);
  if (!tab || !cwd) return;
  if (tab.lastCwd === cwd) return;
  tab.lastCwd = cwd;
  if (
    tab.backend &&
    tab.backend.target.kind === "ssh" &&
    "setCwd" in tab.backend
  ) {
    tab.backend.setCwd(cwd);
  }
  mainWindow?.webContents.send("term:cwd", { tabId, cwd });
}

/** OSC 7: \x1b]7;file://host/path\x07 or ST-terminated. */
function consumeOsc7(tab: Tab, chunk: string): void {
  const merged = (tab.oscBuf ?? "") + chunk;
  tab.oscBuf = merged.length > 4000 ? merged.slice(-2000) : merged;
  const re = /\x1b\]7;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  let match: RegExpExecArray | null;
  let lastPath: string | null = null;
  while ((match = re.exec(tab.oscBuf))) {
    const path = osc7ToPath(match[1] ?? "");
    if (path) lastPath = path;
  }
  // Drop consumed complete sequences; keep a short tail for split packets.
  const lastBell = Math.max(
    tab.oscBuf.lastIndexOf("\x07"),
    tab.oscBuf.lastIndexOf("\x1b\\")
  );
  if (lastBell >= 0) {
    tab.oscBuf = tab.oscBuf.slice(lastBell + 1);
  }
  if (lastPath) emitTabCwd(tab.id, lastPath);
}

function normalizeFsPath(p: string): string {
  try {
    // macOS often reports Hangul as NFD; NFC matches what users expect in the UI.
    return p.normalize("NFC");
  } catch {
    return p;
  }
}

function osc7ToPath(uri: string): string | null {
  const raw = uri.trim();
  if (!raw) return null;
  try {
    if (raw.startsWith("file://")) {
      const u = new URL(raw);
      const decoded = decodeURIComponent(u.pathname || "");
      return decoded ? normalizeFsPath(decoded) : null;
    }
  } catch {
    /* fall through */
  }
  const withoutScheme = raw.replace(/^file:\/\//, "");
  const idx = withoutScheme.indexOf("/");
  if (idx >= 0) return normalizeFsPath(withoutScheme.slice(idx));
  return withoutScheme.startsWith("/")
    ? normalizeFsPath(withoutScheme)
    : null;
}

function attachBackend(tabId: string, backend: Backend): void {
  const tab = tabs.get(tabId);
  if (!tab) return;

  const unsub = backend.onData((data) => {
    consumeOsc7(tab, data);
    // Renderer mounts xterm after open returns; buffer early banner/password prompts.
    if (!tab.ready) {
      tab.buffer.push(data);
      if (tab.buffer.length > 200) {
        tab.buffer = tab.buffer.slice(-100);
      }
      return;
    }
    mainWindow?.webContents.send("term:data", { tabId, data });
  });
  const unsubExit = backend.onExit(({ exitCode, signal }) => {
    const msg =
      `\r\n\x1b[90m[session ended: exit ${exitCode}` +
      (signal != null ? `, signal ${signal}` : "") +
      `]\x1b[0m\r\n`;
    if (!tab.ready) {
      tab.buffer.push(msg);
      return;
    }
    mainWindow?.webContents.send("term:data", { tabId, data: msg });
  });
  tab.unsub = unsub;
  tab.unsubExit = unsubExit;
  void pollTabCwd(tabId);
  ensureCwdPolling();
}

async function pollTabCwd(tabId: string): Promise<void> {
  const tab = tabs.get(tabId);
  if (!tab?.backend || tab.backend.target.kind !== "local") return;
  try {
    const cwd = await tab.backend.getCwd();
    if (cwd) emitTabCwd(tabId, cwd);
  } catch {
    /* ignore */
  }
}

function ensureCwdPolling(): void {
  if (cwdPollTimer) return;
  cwdPollTimer = setInterval(() => {
    if (tabs.size === 0) {
      if (cwdPollTimer) clearInterval(cwdPollTimer);
      cwdPollTimer = null;
      return;
    }
    for (const id of tabs.keys()) {
      void pollTabCwd(id);
    }
  }, 600);
}

type FsListEntry = {
  name: string;
  path: string;
  kind: "dir" | "file";
  size?: number;
};

type FsListResult = {
  path: string;
  home?: string;
  entries: FsListEntry[];
  error?: string;
};

type TransferProgressPayload = {
  transferId: string;
  percent: number;
  transferred: number;
  total: number;
  currentName?: string;
};

function emitTransferProgress(payload: TransferProgressPayload): void {
  mainWindow?.webContents.send("fs:transfer-progress", payload);
}

type LocalCopyItem = {
  src: string;
  dest: string;
  size: number;
  name: string;
};

async function collectLocalCopyItems(
  sources: string[],
  destDir: string
): Promise<{ items: LocalCopyItem[]; total: number }> {
  const items: LocalCopyItem[] = [];
  let total = 0;

  async function walkFile(
    src: string,
    dest: string,
    name: string
  ): Promise<void> {
    const st = await stat(src);
    if (st.isFile()) {
      items.push({ src, dest, size: st.size, name });
      total += st.size;
      return;
    }
    if (!st.isDirectory()) return;
    await mkdir(dest, { recursive: true });
    const names = await readdir(src);
    for (const child of names) {
      if (child === "." || child === "..") continue;
      await walkFile(path.join(src, child), path.join(dest, child), child);
    }
  }

  const destReal = path.resolve(destDir);
  for (const src of sources) {
    const base = path.basename(src);
    if (!base || base === "." || base === "..") continue;
    const dest = path.join(destReal, base);
    const srcResolved = path.resolve(src);
    const destResolved = path.resolve(dest);
    if (
      srcResolved === destReal ||
      destResolved === srcResolved ||
      destResolved.startsWith(srcResolved + path.sep)
    ) {
      continue;
    }
    await walkFile(src, dest, base);
  }
  return { items, total };
}

async function copyLocalWithProgress(
  sources: string[],
  destDir: string,
  transferId: string
): Promise<{ ok: true; copied: string[] } | { error: string }> {
  try {
    await mkdir(destDir, { recursive: true });
    const destStat = await stat(destDir);
    if (!destStat.isDirectory()) return { error: "Not a directory" };
    const destReal = path.resolve(destDir);
    const { items, total } = await collectLocalCopyItems(sources, destDir);
    if (!items.length) return { error: "No files" };

    emitTransferProgress({
      transferId,
      percent: 0,
      transferred: 0,
      total: total || 1,
      currentName: items[0]?.name,
    });

    let transferred = 0;
    let lastEmitAt = 0;
    const emit = (force = false, currentName?: string) => {
      const now = Date.now();
      if (!force && now - lastEmitAt < 80) return;
      lastEmitAt = now;
      emitTransferProgress({
        transferId,
        percent:
          total > 0 ? Math.min(99, Math.round((transferred / total) * 100)) : 0,
        transferred: Math.min(transferred, total),
        total: total || 1,
        currentName,
      });
    };
    for (const item of items) {
      await mkdir(path.dirname(item.dest), { recursive: true });
      if (item.size === 0) {
        await pipeline(createReadStream(item.src), createWriteStream(item.dest));
        emit(true, item.name);
      } else {
        await new Promise<void>((resolve, reject) => {
          const read = createReadStream(item.src);
          const write = createWriteStream(item.dest);
          read.on("data", (chunk: string | Buffer) => {
            const n =
              typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
            transferred += n;
            emit(false, item.name);
          });
          read.on("error", reject);
          write.on("error", reject);
          write.on("finish", () => {
            emit(true, item.name);
            resolve();
          });
          read.pipe(write);
        });
      }
    }

    emitTransferProgress({
      transferId,
      percent: 100,
      transferred: total || transferred,
      total: total || Math.max(transferred, 1),
    });

    const copied = sources
      .map((s) => path.join(destReal, path.basename(s)))
      .filter((dest) =>
        items.some((i) => i.dest === dest || i.dest.startsWith(dest + path.sep))
      );

    return { ok: true, copied };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

type TabMetrics = {
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
};

async function readLocalDisk(
  mount = "/"
): Promise<{
  diskUsedPct: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  diskMount: string;
}> {
  try {
    const s = await statfs(mount);
    const bsize = Number(s.bsize) || 0;
    const total = Number(s.blocks) * bsize;
    const free = Number(s.bavail) * bsize;
    const used = Math.max(0, total - free);
    const diskUsedPct =
      total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
    return {
      diskUsedPct,
      diskUsedBytes: used,
      diskTotalBytes: total,
      diskMount: mount,
    };
  } catch {
    return {
      diskUsedPct: 0,
      diskUsedBytes: 0,
      diskTotalBytes: 0,
      diskMount: mount,
    };
  }
}

async function collectLocalMetrics(): Promise<TabMetrics> {
  const cpus = os.cpus();
  const load1 = os.loadavg()[0] ?? 0;
  const cores = cpus.length || 1;
  const cpuPct = Math.min(100, Math.round((load1 / cores) * 100));
  const memTotalBytes = os.totalmem();
  const memFreeBytes = os.freemem();
  const memUsedBytes = Math.max(0, memTotalBytes - memFreeBytes);
  const disk = await readLocalDisk("/");
  return {
    source: "local",
    cpuPct,
    load1,
    memUsedBytes,
    memFreeBytes,
    memTotalBytes,
    cores,
    ...disk,
    gpuPct: null,
    gpuMemPct: null,
    gpuName: null,
  };
}

const REMOTE_METRICS_SCRIPT = [
  "set +e",
  "LOAD=$(awk '{print $1}' /proc/loadavg 2>/dev/null)",
  "CORES=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)",
  "MEM_TOTAL=$(awk '/^MemTotal:/ {print $2*1024}' /proc/meminfo 2>/dev/null)",
  "MEM_AVAIL=$(awk '/^MemAvailable:/ {print $2*1024}' /proc/meminfo 2>/dev/null)",
  "if [ -z \"$MEM_AVAIL\" ]; then MEM_AVAIL=$(awk '/^MemFree:/ {print $2*1024}' /proc/meminfo 2>/dev/null); fi",
  "DISK=$(df -PB1 / 2>/dev/null | awk 'NR==2 {gsub(/%/,\"\",$5); print $2\" \"$3\" \"$5}')",
  "GPU=$(nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,name --format=csv,noheader,nounits 2>/dev/null | head -n 1)",
  'printf "load=%s\\n" "${LOAD:-0}"',
  'printf "cores=%s\\n" "${CORES:-1}"',
  'printf "mem_total=%s\\n" "${MEM_TOTAL:-0}"',
  'printf "mem_avail=%s\\n" "${MEM_AVAIL:-0}"',
  'printf "disk=%s\\n" "${DISK:-}"',
  'printf "gpu=%s\\n" "${GPU:-}"',
].join("; ");

function parseRemoteMetrics(
  stdout: string,
  hostLabel: string
): TabMetrics {
  const map = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    map.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const load1 = Number(map.get("load") || 0) || 0;
  const cores = Math.max(1, Number(map.get("cores") || 1) || 1);
  const memTotalBytes = Math.max(0, Number(map.get("mem_total") || 0) || 0);
  const memFreeBytes = Math.max(0, Number(map.get("mem_avail") || 0) || 0);
  const memUsedBytes = Math.max(0, memTotalBytes - memFreeBytes);
  const cpuPct = Math.min(100, Math.round((load1 / cores) * 100));

  let diskTotalBytes = 0;
  let diskUsedBytes = 0;
  let diskUsedPct = 0;
  const diskRaw = map.get("disk") || "";
  if (diskRaw) {
    const [t, u, p] = diskRaw.split(/\s+/);
    diskTotalBytes = Math.max(0, Number(t) || 0);
    diskUsedBytes = Math.max(0, Number(u) || 0);
    diskUsedPct = Math.min(100, Math.max(0, Number(p) || 0));
    if (!diskUsedPct && diskTotalBytes > 0) {
      diskUsedPct = Math.min(
        100,
        Math.round((diskUsedBytes / diskTotalBytes) * 100)
      );
    }
  }

  let gpuPct: number | null = null;
  let gpuMemPct: number | null = null;
  let gpuName: string | null = null;
  const gpuRaw = map.get("gpu") || "";
  if (gpuRaw && !/error|not found|failed/i.test(gpuRaw)) {
    const parts = gpuRaw.split(",").map((s) => s.trim());
    if (parts.length >= 3) {
      const util = Number(parts[0]);
      const memUsed = Number(parts[1]);
      const memTotal = Number(parts[2]);
      if (Number.isFinite(util)) gpuPct = Math.min(100, Math.max(0, Math.round(util)));
      if (Number.isFinite(memUsed) && Number.isFinite(memTotal) && memTotal > 0) {
        gpuMemPct = Math.min(100, Math.round((memUsed / memTotal) * 100));
      }
      if (parts[3]) gpuName = parts.slice(3).join(", ").trim() || null;
    }
  }

  return {
    source: "ssh",
    cpuPct,
    load1,
    memUsedBytes,
    memFreeBytes,
    memTotalBytes,
    cores,
    diskUsedPct,
    diskUsedBytes,
    diskTotalBytes,
    diskMount: "/",
    gpuPct,
    gpuMemPct,
    gpuName,
    hostLabel,
  };
}

async function collectRemoteMetrics(
  backend: SshPtyBackend
): Promise<TabMetrics> {
  const hostLabel =
    backend.session.name ||
    `${backend.session.user}@${backend.session.host}`;
  try {
    const res = await backend.exec(REMOTE_METRICS_SCRIPT, {
      cwd: "~",
      timeoutMs: 8_000,
    });
    if ((res.timedOut || res.exitCode !== 0) && !res.stdout.trim()) {
      return {
        source: "ssh",
        cpuPct: 0,
        load1: 0,
        memUsedBytes: 0,
        memFreeBytes: 0,
        memTotalBytes: 0,
        cores: 1,
        diskUsedPct: 0,
        diskUsedBytes: 0,
        diskTotalBytes: 0,
        diskMount: "/",
        gpuPct: null,
        gpuMemPct: null,
        gpuName: null,
        hostLabel,
        error: (
          res.timedOut
            ? "Metrics timed out"
            : res.stderr || `exit ${res.exitCode}`
        )
          .trim()
          .slice(0, 200),
      };
    }
    return parseRemoteMetrics(res.stdout || "", hostLabel);
  } catch (err) {
    return {
      source: "ssh",
      cpuPct: 0,
      load1: 0,
      memUsedBytes: 0,
      memFreeBytes: 0,
      memTotalBytes: 0,
      cores: 1,
      diskUsedPct: 0,
      diskUsedBytes: 0,
      diskTotalBytes: 0,
      diskMount: "/",
      gpuPct: null,
      gpuMemPct: null,
      gpuName: null,
      hostLabel,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const EDITOR_MAX_BYTES = 1_500_000;
const IMAGE_MAX_BYTES = 12_000_000;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};

type EditorReadResult =
  | { path: string; kind: "text"; content: string }
  | { path: string; kind: "image"; mime: string; dataUrl: string }
  | { error: string };

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function imageMimeFromPath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_MIME_BY_EXT[ext] ?? null;
}

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8000));
  if (sample.includes(0)) return true;
  let weird = 0;
  for (const b of sample) {
    if (b === 9 || b === 10 || b === 13) continue;
    if (b < 32) weird += 1;
  }
  return weird > sample.length * 0.05;
}

function toImageResult(
  target: string,
  mime: string,
  buf: Buffer
): EditorReadResult {
  return {
    path: target,
    kind: "image",
    mime,
    dataUrl: `data:${mime};base64,${buf.toString("base64")}`,
  };
}

async function readLocalTextFile(
  filePath?: string
): Promise<EditorReadResult> {
  const target = path.resolve((filePath || "").trim());
  if (!target) return { error: "No path" };
  try {
    const st = await stat(target);
    if (!st.isFile()) return { error: "Not a file" };
    const mime = imageMimeFromPath(target);
    const maxBytes = mime ? IMAGE_MAX_BYTES : EDITOR_MAX_BYTES;
    if (st.size > maxBytes) return { error: "too_large" };
    const buf = await readFile(target);
    if (mime) return toImageResult(target, mime, buf);
    if (looksBinary(buf)) return { error: "binary" };
    return { path: target, kind: "text", content: buf.toString("utf8") };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function writeLocalTextFile(
  filePath: string | undefined,
  content: string
): Promise<{ ok: true; path: string } | { error: string }> {
  const target = path.resolve((filePath || "").trim());
  if (!target) return { error: "No path" };
  try {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > EDITOR_MAX_BYTES) return { error: "too_large" };
    await writeFile(target, content, "utf8");
    return { ok: true, path: target };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function readRemoteTextFile(
  backend: Backend,
  filePath?: string
): Promise<EditorReadResult> {
  const target = (filePath || "").trim();
  if (!target) return { error: "No path" };
  const q = shellSingleQuote(target);
  const mime = imageMimeFromPath(target);
  const maxBytes = mime ? IMAGE_MAX_BYTES : EDITOR_MAX_BYTES;
  try {
    // `test`/`[` do not accept `--`; a quoted path is enough.
    const probe = await backend.exec(
      `if [ -f ${q} ]; then wc -c < ${q}; else exit 41; fi`,
      { timeoutMs: 12_000 }
    );
    if (probe.exitCode === 41) return { error: "Not a file" };
    const size = Number((probe.stdout || "").trim());
    if (Number.isFinite(size) && size > maxBytes) {
      return { error: "too_large" };
    }
    const result = await backend.exec(`base64 < ${q}`, { timeoutMs: 30_000 });
    if (result.timedOut) return { error: "Read timed out" };
    if (result.exitCode != null && result.exitCode !== 0) {
      return {
        error: (result.stderr || "").trim() || "Read failed",
      };
    }
    const buf = Buffer.from((result.stdout || "").replace(/\s+/g, ""), "base64");
    if (mime) return toImageResult(target, mime, buf);
    if (looksBinary(buf)) return { error: "binary" };
    return { path: target, kind: "text", content: buf.toString("utf8") };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function writeRemoteTextFile(
  backend: Backend,
  filePath: string | undefined,
  content: string
): Promise<{ ok: true; path: string } | { error: string }> {
  const target = (filePath || "").trim();
  if (!target) return { error: "No path" };
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > EDITOR_MAX_BYTES) return { error: "too_large" };
  const q = shellSingleQuote(target);
  const b64 = Buffer.from(content, "utf8").toString("base64");
  try {
    const result = await backend.exec(
      `(base64 -d 2>/dev/null || base64 -D) > ${q} <<'DRIFT_B64'\n${b64}\nDRIFT_B64`,
      { timeoutMs: 30_000 }
    );
    if (result.timedOut) return { error: "Write timed out" };
    if (result.exitCode != null && result.exitCode !== 0) {
      return {
        error: (result.stderr || "").trim() || "Write failed",
      };
    }
    return { ok: true, path: target };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function listLocalDir(dirPath?: string): Promise<FsListResult> {
  const home = os.homedir();
  const target = path.resolve(dirPath?.trim() || home);
  try {
    const info = await stat(target);
    if (!info.isDirectory()) {
      return { error: "Not a directory", path: target, entries: [] };
    }
    const names = await readdir(target);
    const entries: FsListEntry[] = [];
    for (const name of names) {
      if (name === "." || name === "..") continue;
      const full = path.join(target, name);
      try {
        const st = await stat(full);
        entries.push({
          name,
          path: full,
          kind: st.isDirectory() ? "dir" : "file",
          size: st.isDirectory() ? undefined : st.size,
        });
      } catch {
        /* skip unreadable */
      }
    }
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    return { path: target, home, entries };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
      path: target,
      home,
      entries: [],
    };
  }
}

async function listRemoteDir(
  backend: Backend,
  dirPath?: string
): Promise<FsListResult> {
  const target = (dirPath?.trim() || "~").replace(/\n/g, "") || "~";
  const quoted = `'${target.replace(/'/g, `'\"'\"'`)}'`;
  // Marker-based ls: works without python. Reuses SSH ControlMaster from the live tab.
  const command =
    `cd -- ${quoted} 2>/dev/null || exit 41; ` +
    `printf 'CTPWD:%s\\n' "$(pwd -P 2>/dev/null || pwd)"; ` +
    `printf 'CTHOME:%s\\n' "$HOME"; ` +
    `ls -1AF 2>/dev/null || ls -1Ap 2>/dev/null || ls -1A`;
  try {
    const result = await backend.exec(command, {
      cwd: "~",
      timeoutMs: 12_000,
    });
    const text = result.stdout || "";
    const errText = (result.stderr || "").trim();
    if (result.timedOut) {
      return { error: "Listing timed out", path: target, entries: [] };
    }
    if (result.exitCode === 41 || /exit 41/.test(errText)) {
      return { error: `Cannot open ${target}`, path: target, entries: [] };
    }
    if (
      !text.trim() &&
      (result.exitCode == null ||
        result.exitCode !== 0 ||
        /Permission denied|Connection refused|Connection reset|Broken pipe|No such file/i.test(
          errText
        ))
    ) {
      return {
        error:
          errText ||
          "SSH listing failed — keep the session connected (password sessions need the live tab)",
        path: target,
        entries: [],
      };
    }
    return parseRemoteLs(text, target);
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
      path: target,
      entries: [],
    };
  }
}

function parseRemoteLs(text: string, fallbackPath: string): FsListResult {
  const lines = text.split(/\r?\n/);
  let abs = fallbackPath;
  let home: string | undefined;
  const names: string[] = [];
  for (const line of lines) {
    if (line.startsWith("CTPWD:")) {
      abs = line.slice(6).trim() || abs;
      continue;
    }
    if (line.startsWith("CTHOME:")) {
      home = line.slice(7).trim() || undefined;
      continue;
    }
    if (!line || line === "." || line === "..") continue;
    // Drop shell noise / prompts that may leak into stdout.
    if (line.startsWith("CTPWD:") || line.startsWith("CTHOME:")) continue;
    if (/^\S+@\S+[:#]/.test(line)) continue;
    names.push(line);
  }
  const entries: FsListEntry[] = [];
  for (const raw of names) {
    const isDir = raw.endsWith("/");
    // ls -F marks: / dir, * exec, @ symlink, = socket, | fifo
    const name = (isDir ? raw.slice(0, -1) : raw).replace(/[*@=|]$/, "");
    if (!name || name === "." || name === "..") continue;
    const full = abs.endsWith("/") ? `${abs}${name}` : `${abs}/${name}`;
    entries.push({
      name,
      path: full,
      kind: isDir ? "dir" : "file",
    });
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  return { path: abs, home, entries };
}

function registerIpc(): void {
  ipcMain.handle("sessions:list", async () => sessionStore.list());

  ipcMain.handle(
    "sessions:save",
    async (
      _e,
      input: Omit<SavedSession, "id" | "createdAt" | "updatedAt"> & {
        id?: string;
      }
    ) => sessionStore.upsert(input)
  );

  ipcMain.handle("sessions:delete", async (_e, id: string) =>
    sessionStore.remove(id)
  );

  ipcMain.handle("sessions:import-ssh-config", async () => {
    const configPath = path.join(os.homedir(), ".ssh", "config");
    let content = "";
    try {
      content = await readFile(configPath, "utf8");
    } catch {
      return {
        sessions: sessionStore.list(),
        created: 0,
        updated: 0,
        found: 0,
        missingConfig: true as const,
      };
    }
    const parsed = parseSshConfig(content);
    let created = 0;
    let updated = 0;
    for (const item of parsed) {
      const name = item.sshConfigHost;
      const existing = sessionStore
        .list()
        .find((s) => s.sshConfigHost === name);
      await sessionStore.upsert({
        id: existing?.id,
        name,
        host: item.host,
        user: item.user || os.userInfo().username,
        port: item.port,
        identityFile: item.identityFile,
        proxyJump: item.proxyJump,
        sshConfigHost: item.sshConfigHost,
      });
      if (existing) updated += 1;
      else created += 1;
    }
    return {
      sessions: sessionStore.list(),
      created,
      updated,
      found: parsed.length,
      missingConfig: false as const,
    };
  });

  /** Phase 1: allocate a tab id so the renderer can mount/fit xterm first. */
  ipcMain.handle("term:create-local-tab", async () => {
    const tabId = newId();
    const title = "Local";
    tabs.set(tabId, {
      id: tabId,
      title,
      backend: null,
      ready: false,
      buffer: [],
    });
    return { tabId, title };
  });

  /** Phase 2: start the PTY only after xterm reports final cols/rows. */
  ipcMain.handle(
    "term:start-local",
    async (
      _e,
      payload: { tabId: string; cols: number; rows: number }
    ) => {
      const tab = tabs.get(payload.tabId);
      if (!tab) return { error: "Tab not found" };
      if (tab.backend) return { ok: true as const };
      try {
        const cols = Math.max(2, Math.floor(payload.cols));
        const rows = Math.max(1, Math.floor(payload.rows));
        const backend = createLocalPty({ cols, rows });
        tab.backend = backend;
        tab.lastCols = cols;
        tab.lastRows = rows;
        attachBackend(tab.id, backend);
        return { ok: true as const };
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  );

  ipcMain.handle(
    "term:open-local",
    async (_e, size?: { cols?: number; rows?: number }) => {
      try {
        const cols = Math.max(2, Math.floor(size?.cols ?? 120));
        const rows = Math.max(1, Math.floor(size?.rows ?? 30));
        const backend = createLocalPty({ cols, rows });
        const tabId = newId();
        const title = "Local";
        tabs.set(tabId, {
          id: tabId,
          title,
          backend,
          ready: false,
          buffer: [],
          lastCols: cols,
          lastRows: rows,
        });
        attachBackend(tabId, backend);
        return { tabId, title };
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  );

  ipcMain.handle(
    "term:open-ssh",
    async (
      _e,
      sessionId: string,
      size?: { cols?: number; rows?: number }
    ) => {
      const session = sessionStore.get(sessionId);
      if (!session) return { error: "Session not found" };
      try {
        const cols = Math.max(2, Math.floor(size?.cols ?? 120));
        const rows = Math.max(1, Math.floor(size?.rows ?? 30));
        const backend = createSshPty(session, { cols, rows });
        const tabId = newId();
        const title = session.name;
        tabs.set(tabId, {
          id: tabId,
          title,
          backend,
          ready: false,
          buffer: [],
          lastCols: cols,
          lastRows: rows,
        });
        attachBackend(tabId, backend);
        return {
          tabId,
          title,
          kind: "ssh" as const,
          label: `${session.user}@${session.host}`,
        };
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  );

  ipcMain.handle("term:close", async (_e, tabId: string) => {
    const tab = tabs.get(tabId);
    if (!tab) return;
    tab.unsub?.();
    tab.unsubExit?.();
    await tab.backend?.dispose();
    tabs.delete(tabId);
  });

  ipcMain.handle("term:ready", async (_e, tabId: string) => {
    const tab = tabs.get(tabId);
    if (!tab) return;
    tab.ready = true;
    const pending = tab.buffer.splice(0);
    for (const data of pending) {
      consumeOsc7(tab, data);
      mainWindow?.webContents.send("term:data", { tabId, data });
    }
    void pollTabCwd(tabId);
  });

  ipcMain.handle(
    "term:write",
    async (_e, payload: { tabId: string; data: string }) => {
      const tab = tabs.get(payload.tabId);
      if (!tab?.backend) return;
      tab.backend.write(payload.data);
      // After Enter / cd, refresh local cwd quickly.
      if (payload.data.includes("\n") || payload.data.includes("\r")) {
        setTimeout(() => void pollTabCwd(payload.tabId), 120);
        setTimeout(() => void pollTabCwd(payload.tabId), 400);
      }
    }
  );

  ipcMain.handle("term:get-cwd", async (_e, tabId: string) => {
    const tab = tabs.get(tabId);
    if (!tab) return { cwd: null as string | null };
    if (tab.lastCwd) return { cwd: tab.lastCwd };
    if (!tab.backend) return { cwd: null as string | null };
    try {
      const cwd = await tab.backend.getCwd();
      if (cwd) emitTabCwd(tabId, cwd);
      return { cwd };
    } catch {
      return { cwd: null as string | null };
    }
  });

  ipcMain.handle(
    "term:resize",
    async (_e, payload: { tabId: string; cols: number; rows: number }) => {
      const tab = tabs.get(payload.tabId);
      if (!tab?.backend) return;
      const cols = Math.max(2, Math.floor(payload.cols));
      const rows = Math.max(1, Math.floor(payload.rows));
      // Avoid redundant SIGWINCH — mid-line resize wipes powerline prompts.
      if (tab.lastCols === cols && tab.lastRows === rows) return;
      tab.lastCols = cols;
      tab.lastRows = rows;
      tab.backend.resize(cols, rows);
    }
  );

  ipcMain.handle("settings:api-key-status", async () => {
    const key = await loadApiKey();
    return { hasKey: Boolean(key.trim()) };
  });

  ipcMain.handle("settings:set-api-key", async (_e, key: string) => {
    await saveApiKey(key.trim());
    return { ok: true as const };
  });

  ipcMain.handle("settings:clear-api-key", async () => {
    await clearApiKey();
    return { ok: true as const };
  });

  ipcMain.handle("settings:get", async () => appSettings);

  ipcMain.handle(
    "settings:set-model",
    async (_e, modelId: string) => {
      await saveSettings({
        ...appSettings,
        modelId: modelId.trim() || "composer-2.5",
      });
      return appSettings;
    }
  );

  ipcMain.handle("settings:set-chat-mode", async (_e, chatMode: ChatMode) => {
    const mode = normalizeChatMode(chatMode);
    await saveSettings({ ...appSettings, chatMode: mode });
    applyChatModeToPolicy(mode);
    return appSettings;
  });

  ipcMain.handle("settings:set-locale", async (_e, locale: AppLocale) => {
    await saveSettings({
      ...appSettings,
      locale: normalizeLocale(locale),
    });
    return appSettings;
  });

  ipcMain.handle("settings:list-models", async () => {
    const apiKey = await loadApiKey();
    return listModels(apiKey);
  });

  ipcMain.handle("usage:get-session", async () => sessionUsage);

  ipcMain.handle("usage:reset-session", async () => {
    sessionUsage = emptySessionUsage();
    return sessionUsage;
  });

  ipcMain.handle("shell:open-external", async (_e, url: string) => {
    if (!/^https?:\/\//i.test(url)) return { ok: false as const };
    await shell.openExternal(url);
    return { ok: true as const };
  });

  ipcMain.handle("fs:home", async () => os.homedir());

  ipcMain.handle("metrics:local", async () => collectLocalMetrics());

  ipcMain.handle("metrics:tab", async (_e, tabId?: string) => {
    const id = typeof tabId === "string" ? tabId.trim() : "";
    if (!id) return collectLocalMetrics();
    const tab = tabs.get(id);
    if (!tab?.backend) return collectLocalMetrics();
    if (tab.backend.target.kind === "ssh" && "session" in tab.backend) {
      return collectRemoteMetrics(tab.backend as SshPtyBackend);
    }
    return collectLocalMetrics();
  });

  ipcMain.handle("fs:list", async (_e, dirPath?: string) => {
    return listLocalDir(dirPath);
  });

  ipcMain.handle(
    "fs:list-tab",
    async (_e, input: { tabId: string; dirPath?: string }) => {
      const tab = tabs.get(input.tabId);
      if (!tab?.backend) {
        return { error: "No tab", path: "", entries: [] as const };
      }
      if (tab.backend.target.kind === "local") {
        return listLocalDir(input.dirPath);
      }
      return listRemoteDir(tab.backend, input.dirPath);
    }
  );

  ipcMain.handle("fs:read-file", async (_e, filePath?: string) => {
    return readLocalTextFile(filePath);
  });

  ipcMain.handle(
    "fs:write-file",
    async (_e, input: { path?: string; content?: string }) => {
      return writeLocalTextFile(input?.path, input?.content ?? "");
    }
  );

  ipcMain.handle(
    "fs:read-tab-file",
    async (_e, input: { tabId: string; path?: string }) => {
      const tab = tabs.get(input.tabId);
      if (!tab?.backend) return { error: "No tab" };
      if (tab.backend.target.kind === "local") {
        return readLocalTextFile(input.path);
      }
      return readRemoteTextFile(tab.backend, input.path);
    }
  );

  ipcMain.handle(
    "fs:write-tab-file",
    async (_e, input: { tabId: string; path?: string; content?: string }) => {
      const tab = tabs.get(input.tabId);
      if (!tab?.backend) return { error: "No tab" };
      if (tab.backend.target.kind === "local") {
        return writeLocalTextFile(input.path, input.content ?? "");
      }
      return writeRemoteTextFile(tab.backend, input.path, input.content ?? "");
    }
  );

  /** Copy Finder/OS paths into a local directory (recursive) with progress. */
  ipcMain.handle(
    "fs:copy-into",
    async (
      _e,
      input: { destDir: string; sources: string[]; transferId?: string }
    ) => {
      const destDir = (input.destDir || "").trim();
      const sources = (input.sources || [])
        .map((s) => s.trim())
        .filter(Boolean);
      const transferId = (input.transferId || "").trim() || newId();
      if (!destDir) return { error: "No destination" };
      if (!sources.length) return { error: "No files" };
      return copyLocalWithProgress(sources, destDir, transferId);
    }
  );

  /** Upload local paths into the SSH tab's directory via ControlMaster. */
  ipcMain.handle(
    "fs:upload-tab",
    async (
      _e,
      input: {
        tabId: string;
        destDir: string;
        sources: string[];
        transferId?: string;
      }
    ) => {
      const tab = tabs.get(input.tabId);
      const backend = tab?.backend;
      if (!backend || backend.target.kind !== "ssh" || !("session" in backend)) {
        return { error: "No SSH tab" };
      }
      const destDir = (input.destDir || "").trim() || "~";
      const sources = (input.sources || [])
        .map((s) => s.trim())
        .filter(Boolean);
      const transferId = (input.transferId || "").trim() || newId();
      if (!sources.length) return { error: "No files" };
      return uploadFilesViaScp(
        (backend as SshPtyBackend).session,
        sources,
        destDir,
        {
          onProgress: (p) =>
            emitTransferProgress({
              transferId,
              percent: p.percent,
              transferred: p.transferred,
              total: p.total,
              currentName: p.currentName,
            }),
        }
      );
    }
  );

  /** Download remote paths from the SSH tab into a local directory. */
  ipcMain.handle(
    "fs:download-tab",
    async (
      _e,
      input: {
        tabId: string;
        destDir: string;
        sources: string[];
        transferId?: string;
      }
    ) => {
      const tab = tabs.get(input.tabId);
      const backend = tab?.backend;
      if (!backend || backend.target.kind !== "ssh" || !("session" in backend)) {
        return { error: "No SSH tab" };
      }
      const destDir = (input.destDir || "").trim();
      const sources = (input.sources || [])
        .map((s) => s.trim())
        .filter(Boolean);
      const transferId = (input.transferId || "").trim() || newId();
      if (!destDir) return { error: "No destination" };
      if (!sources.length) return { error: "No files" };
      try {
        await mkdir(destDir, { recursive: true });
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
        };
      }
      return downloadFilesViaScp(
        (backend as SshPtyBackend).session,
        sources,
        destDir,
        {
          onProgress: (p) =>
            emitTransferProgress({
              transferId,
              percent: p.percent,
              transferred: p.transferred,
              total: p.total,
              currentName: p.currentName,
            }),
        }
      );
    }
  );

  ipcMain.handle(
    "fs:rename",
    async (_e, input: { fromPath: string; toPath: string }) => {
      const fromPath = (input.fromPath || "").trim();
      const toPath = (input.toPath || "").trim();
      if (!fromPath || !toPath) return { error: "Missing path" };
      if (fromPath.includes("\0") || toPath.includes("\0")) {
        return { error: "Invalid path" };
      }
      try {
        await rename(fromPath, toPath);
        return { ok: true as const };
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  );

  ipcMain.handle(
    "fs:delete",
    async (_e, input: { targetPath: string }) => {
      const targetPath = (input.targetPath || "").trim();
      if (!targetPath) return { error: "Missing path" };
      if (targetPath.includes("\0")) return { error: "Invalid path" };
      try {
        await rm(targetPath, { recursive: true, force: false });
        return { ok: true as const };
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  );

  ipcMain.handle(
    "fs:rename-tab",
    async (
      _e,
      input: { tabId: string; fromPath: string; toPath: string }
    ) => {
      const tab = tabs.get(input.tabId);
      if (!tab?.backend) return { error: "No tab" };
      const fromPath = (input.fromPath || "").trim();
      const toPath = (input.toPath || "").trim();
      if (!fromPath || !toPath) return { error: "Missing path" };
      if (fromPath.includes("\0") || toPath.includes("\0")) {
        return { error: "Invalid path" };
      }
      if (tab.backend.target.kind === "local") {
        try {
          await rename(fromPath, toPath);
          return { ok: true as const };
        } catch (err) {
          return {
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
      const q = (p: string) => `'${p.replace(/'/g, `'\"'\"'`)}'`;
      const result = await tab.backend.exec(
        `mv -- ${q(fromPath)} ${q(toPath)}`,
        { cwd: "~", timeoutMs: 30_000 }
      );
      if (result.timedOut) return { error: "Rename timed out" };
      if (result.exitCode !== 0) {
        return {
          error: (result.stderr || result.stdout || "Rename failed")
            .trim()
            .slice(0, 400),
        };
      }
      return { ok: true as const };
    }
  );

  ipcMain.handle(
    "fs:delete-tab",
    async (_e, input: { tabId: string; targetPath: string }) => {
      const tab = tabs.get(input.tabId);
      if (!tab?.backend) return { error: "No tab" };
      const targetPath = (input.targetPath || "").trim();
      if (!targetPath) return { error: "Missing path" };
      if (targetPath.includes("\0")) return { error: "Invalid path" };
      if (targetPath === "/" || targetPath === "~" || targetPath === ".") {
        return { error: "Refusing to delete that path" };
      }
      if (tab.backend.target.kind === "local") {
        try {
          await rm(targetPath, { recursive: true, force: false });
          return { ok: true as const };
        } catch (err) {
          return {
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
      const q = (p: string) => `'${p.replace(/'/g, `'\"'\"'`)}'`;
      const result = await tab.backend.exec(`rm -rf -- ${q(targetPath)}`, {
        cwd: "~",
        timeoutMs: 60_000,
      });
      if (result.timedOut) return { error: "Delete timed out" };
      if (result.exitCode !== 0) {
        return {
          error: (result.stderr || result.stdout || "Delete failed")
            .trim()
            .slice(0, 400),
        };
      }
      return { ok: true as const };
    }
  );

  ipcMain.handle(
    "agent:send",
    async (_e, input: { tabId: string; message: string }) => {
      const tab = tabs.get(input.tabId);
      if (!tab?.backend) return { error: "No active terminal tab" };
      const backend = tab.backend;
      const apiKey = await loadApiKey();
      const runId = newId();
      let countedUsage = false;

      void (async () => {
        try {
          for await (const event of sendAgent({
            message: input.message,
            target: backend.target,
            apiKey,
            modelId: appSettings.modelId,
            chatMode: appSettings.chatMode,
            locale: appSettings.locale,
          })) {
            if (event.type === "usage" && !countedUsage) {
              countedUsage = true;
              const totals = addUsage(event.usage, event.cost);
              mainWindow?.webContents.send("usage:updated", {
                last: event,
                session: totals,
              });
            }

            mainWindow?.webContents.send("agent:event", {
              runId,
              tabId: input.tabId,
              event,
            });

            if (event.type === "propose") {
              // Ask / Plan never execute shell proposes.
              if (appSettings.chatMode !== "agent") {
                continue;
              }

              const decision = await requestApproval(
                runId,
                input.tabId,
                event.action
              );
              policy.remember(event.action, decision);

              if (decision.type === "deny") {
                mainWindow?.webContents.send("agent:event", {
                  runId,
                  tabId: input.tabId,
                  event: {
                    type: "text",
                    text: `\nDenied.${decision.feedback ? ` Feedback: ${decision.feedback}` : ""}\n`,
                  },
                });
                continue;
              }

              if (!event.action.command) continue;
              if (policy.mode === "read-only" && event.action.effect !== "read") {
                continue;
              }

              // Echo into the visible terminal then also capture via exec for result card.
              backend.write(`\n# agent: ${event.action.command}\n`);
              const result = await backend.exec(event.action.command);
              const out = [
                result.stdout,
                result.stderr,
                result.timedOut
                  ? "[timed out]"
                  : `[exit ${result.exitCode}]`,
              ]
                .filter(Boolean)
                .join("");
              mainWindow?.webContents.send("agent:event", {
                runId,
                tabId: input.tabId,
                event: { type: "text", text: `\n${out}\n` },
              });
            }
          }
        } catch (err) {
          mainWindow?.webContents.send("agent:event", {
            runId,
            tabId: input.tabId,
            event: {
              type: "status",
              status: "error",
              detail: err instanceof Error ? err.message : String(err),
            },
          });
        }
      })();

      return { runId };
    }
  );

  ipcMain.handle(
    "agent:resolve-approval",
    async (
      _e,
      input: { runId: string; decision: ApprovalDecision }
    ) => {
      const pending = pendingApprovals.get(input.runId);
      if (!pending) return;
      pendingApprovals.delete(input.runId);
      pending.resolve(input.decision);
    }
  );
}

function requestApproval(
  runId: string,
  tabId: string,
  action: ProposedAction
): Promise<ApprovalDecision> {
  if (!policy.needsApproval(action)) {
    return Promise.resolve({ type: "allow-once" });
  }
  return new Promise((resolve) => {
    pendingApprovals.set(runId, { resolve, action, tabId });
    mainWindow?.webContents.send("agent:approval", { runId, tabId, action });
  });
}

app.setName("Drift");

app.whenReady().then(async () => {
  const icon = loadAppIcon();
  const iconPath = existsSync(brandAsset("icon.png"))
    ? brandAsset("icon.png")
    : undefined;
  app.setAboutPanelOptions({
    applicationName: "Drift",
    applicationVersion: app.getVersion(),
    copyright: "Drift",
    ...(iconPath ? { iconPath } : {}),
  });
  if (process.platform === "darwin" && icon) {
    app.dock?.setIcon(icon);
  }

  sessionStore = new SessionStore(dataDir());
  await sessionStore.load();
  appSettings = await loadSettings();
  applyChatModeToPolicy(appSettings.chatMode);
  registerIpc();
  buildApplicationMenu();
  createWindow();
  initAutoUpdater(() => mainWindow);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  for (const tab of tabs.values()) {
    tab.unsub?.();
    void tab.backend?.dispose();
  }
  tabs.clear();
  if (process.platform !== "darwin") app.quit();
});

process.on("uncaughtException", (err) => {
  dialog.showErrorBox("Drift error", err.message);
});
