import { app, BrowserWindow, ipcMain } from "electron";
import { autoUpdater } from "electron-updater";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type UpdateAvailablePayload = {
  version: string;
  currentVersion: string;
  releaseName?: string | null;
  releaseNotes?: string | null;
};

export type UpdateProgressPayload = {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
};

type DismissedState = {
  version?: string;
};

const CHECK_DELAY_MS = 4_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

let started = false;
let downloadedVersion: string | null = null;

function dismissedPath(): string {
  return path.join(app.getPath("userData"), "drift", "update-dismissed.json");
}

function readDismissed(): DismissedState {
  try {
    const file = dismissedPath();
    if (!existsSync(file)) return {};
    return JSON.parse(readFileSync(file, "utf8")) as DismissedState;
  } catch {
    return {};
  }
}

function writeDismissed(version: string): void {
  const file = dismissedPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version } satisfies DismissedState), "utf8");
}

function clearDismissed(): void {
  const file = dismissedPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({} satisfies DismissedState), "utf8");
}

function send(
  win: BrowserWindow | null,
  channel: string,
  payload?: unknown
): void {
  if (!win || win.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

export function initAutoUpdater(getWindow: () => BrowserWindow | null): void {
  if (started) return;
  started = true;

  ipcMain.handle("updater:get-version", () => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
  }));

  ipcMain.handle("updater:check", async () => {
    if (!app.isPackaged) return { ok: false as const, reason: "dev" as const };
    try {
      const result = await autoUpdater.checkForUpdates();
      return {
        ok: true as const,
        versionInfo: result?.updateInfo?.version ?? null,
      };
    } catch (err) {
      return {
        ok: false as const,
        reason: "error" as const,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle("updater:download", async () => {
    if (!app.isPackaged) return { ok: false as const, reason: "dev" as const };
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true as const };
    } catch (err) {
      return {
        ok: false as const,
        reason: "error" as const,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle("updater:install", () => {
    if (!app.isPackaged) return { ok: false as const, reason: "dev" as const };
    // isSilent=false, isForceRunAfter=true
    autoUpdater.quitAndInstall(false, true);
    return { ok: true as const, version: downloadedVersion };
  });

  ipcMain.handle("updater:dismiss", (_e, version: string) => {
    if (typeof version === "string" && version.length > 0) {
      writeDismissed(version);
    }
    return { ok: true as const };
  });

  // Dev / unpackaged: IPC only. No network update checks.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // Unsigned builds: still allow GitHub zip updates in this project phase.
  autoUpdater.allowPrerelease = false;

  autoUpdater.on("update-available", (info) => {
    const dismissed = readDismissed();
    if (dismissed.version && dismissed.version === info.version) {
      return;
    }
    const payload: UpdateAvailablePayload = {
      version: info.version,
      currentVersion: app.getVersion(),
      releaseName: info.releaseName,
      releaseNotes:
        typeof info.releaseNotes === "string"
          ? info.releaseNotes
          : Array.isArray(info.releaseNotes)
            ? info.releaseNotes.map((n) => n.note).join("\n")
            : null,
    };
    send(getWindow(), "updater:available", payload);
  });

  autoUpdater.on("download-progress", (progress) => {
    const payload: UpdateProgressPayload = {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    };
    send(getWindow(), "updater:progress", payload);
  });

  autoUpdater.on("update-downloaded", (info) => {
    downloadedVersion = info.version;
    clearDismissed();
    send(getWindow(), "updater:downloaded", {
      version: info.version,
      currentVersion: app.getVersion(),
    });
  });

  autoUpdater.on("error", (err) => {
    send(getWindow(), "updater:error", {
      message: err?.message || String(err),
    });
  });

  const runCheck = () => {
    void autoUpdater.checkForUpdates().catch(() => {
      /* surfaced via error event */
    });
  };

  setTimeout(runCheck, CHECK_DELAY_MS);
  setInterval(runCheck, CHECK_INTERVAL_MS);
}
