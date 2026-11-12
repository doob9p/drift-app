import { app, BrowserWindow, ipcMain } from "electron";
import { autoUpdater, type UpdateInfo } from "electron-updater";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";

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
const GITHUB_OWNER = "doob9p";
const GITHUB_REPO = "drift-app";

let started = false;
let downloadedVersion: string | null = null;
let pendingInfo: UpdateInfo | null = null;
let downloadedZipPath: string | null = null;

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

/** GitHub release bodies often arrive as HTML; the UI shows plain text. */
function toPlainReleaseNotes(raw: unknown): string | null {
  const parts: string[] = [];
  if (typeof raw === "string") {
    parts.push(raw);
  } else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string") parts.push(item);
      else if (item && typeof item === "object" && "note" in item) {
        const note = (item as { note?: unknown }).note;
        if (typeof note === "string") parts.push(note);
      }
    }
  }
  const joined = parts.join("\n").trim();
  if (!joined) return null;

  const text = joined
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*p\s*>/gi, "\n")
    .replace(/<\/\s*div\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .filter((line) => !/^\s*Co-authored-by:/i.test(line))
    .join("\n")
    .trim();

  return text || null;
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

function appBundlePath(): string {
  // .../Drift.app/Contents/MacOS/Drift → .../Drift.app
  return path.resolve(process.execPath, "../../..");
}

function pickMacZip(info: UpdateInfo): { fileName: string; sha512: string; size?: number } {
  const files = info.files ?? [];
  const zip =
    files.find((f) => /\.zip$/i.test(f.url)) ??
    (/\.zip$/i.test(info.path ?? "")
      ? { url: info.path!, sha512: info.sha512, size: undefined }
      : undefined);
  if (!zip?.url || !zip.sha512) {
    throw new Error("No macOS zip asset found in update feed");
  }
  const fileName = path.basename(zip.url);
  return { fileName, sha512: zip.sha512, size: zip.size };
}

function releaseAssetUrl(version: string, fileName: string): string {
  return `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/v${version}/${fileName}`;
}

async function sha512File(filePath: string): Promise<string> {
  const hash = createHash("sha512");
  const { createReadStream } = await import("node:fs");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("base64");
}

async function downloadToFile(
  url: string,
  dest: string,
  onProgress: (payload: UpdateProgressPayload) => void
): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (${res.status})`);
  }
  const total = Number(res.headers.get("content-length") || 0);
  let transferred = 0;
  let lastTs = Date.now();
  let lastBytes = 0;

  await mkdir(path.dirname(dest), { recursive: true });
  const partial = `${dest}.partial`;
  const nodeStream = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  nodeStream.on("data", (chunk: Buffer) => {
    transferred += chunk.length;
    const now = Date.now();
    const dt = Math.max(1, now - lastTs);
    const bytesPerSecond = ((transferred - lastBytes) * 1000) / dt;
    if (now - lastTs >= 200 || transferred === total) {
      lastTs = now;
      lastBytes = transferred;
      onProgress({
        percent: total > 0 ? (transferred / total) * 100 : 0,
        bytesPerSecond,
        transferred,
        total,
      });
    }
  });
  await pipeline(nodeStream, createWriteStream(partial));
  renameSync(partial, dest);
}

/**
 * Squirrel.Mac / ShipIt rejects unsigned (identity: null) builds.
 * Download the zip ourselves, verify sha512, then swap the .app via a helper script.
 */
async function downloadMacUpdate(
  getWindow: () => BrowserWindow | null
): Promise<void> {
  if (!pendingInfo) {
    throw new Error("No pending update");
  }
  const version = pendingInfo.version;
  const { fileName, sha512 } = pickMacZip(pendingInfo);
  const url = releaseAssetUrl(version, fileName);
  const dest = path.join(
    app.getPath("temp"),
    "drift-updates",
    `Drift-${version}-mac-arm64.zip`
  );

  if (existsSync(dest)) {
    rmSync(dest, { force: true });
  }

  await downloadToFile(url, dest, (progress) => {
    send(getWindow(), "updater:progress", progress);
  });

  const actual = await sha512File(dest);
  if (actual !== sha512) {
    rmSync(dest, { force: true });
    throw new Error("Update archive checksum mismatch");
  }

  downloadedZipPath = dest;
  downloadedVersion = version;
  clearDismissed();
  send(getWindow(), "updater:downloaded", {
    version,
    currentVersion: app.getVersion(),
  });
}

async function installMacUpdate(): Promise<void> {
  if (!downloadedZipPath || !existsSync(downloadedZipPath)) {
    throw new Error("Update archive missing — download again");
  }
  const appPath = appBundlePath();
  if (!appPath.endsWith(".app") || !existsSync(appPath)) {
    throw new Error(`Cannot locate Drift.app (${appPath})`);
  }

  const work = await mkdtemp(path.join(tmpdir(), "drift-install-"));
  const scriptPath = path.join(work, "install.sh");
  const logPath = path.join(app.getPath("logs"), "drift-update.log");

  const script = `#!/bin/bash
set -euo pipefail
APP_PATH=${JSON.stringify(appPath)}
ZIP_PATH=${JSON.stringify(downloadedZipPath)}
LOG=${JSON.stringify(logPath)}
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) install start"

# Wait until this Drift process exits (and release file locks).
for i in $(seq 1 60); do
  if ! pgrep -f "$APP_PATH/Contents/MacOS/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
sleep 1

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# ditto preserves macOS metadata / symlinks better than unzip.
ditto -x -k "$ZIP_PATH" "$TMP"
NEW_APP=$(find "$TMP" -maxdepth 2 -name "*.app" -print | head -n 1)
if [ -z "$NEW_APP" ] || [ ! -d "$NEW_APP" ]; then
  echo "no .app in zip"
  exit 1
fi

BACKUP="\${APP_PATH}.drift-bak"
rm -rf "$BACKUP"
mv "$APP_PATH" "$BACKUP"
if ! mv "$NEW_APP" "$APP_PATH"; then
  mv "$BACKUP" "$APP_PATH"
  echo "replace failed; restored backup"
  exit 1
fi

# Unsigned builds: clear quarantine so Gatekeeper does not block relaunch.
xattr -cr "$APP_PATH" || true
rm -rf "$BACKUP"
rm -f "$ZIP_PATH"
open "$APP_PATH"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) install done"
`;

  await writeFile(scriptPath, script, { mode: 0o755 });
  await chmod(scriptPath, 0o755);

  const child = spawn("/bin/bash", [scriptPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  // Give the helper a moment to start before we tear down.
  setTimeout(() => app.quit(), 300);
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
      if (process.platform === "darwin") {
        await downloadMacUpdate(getWindow);
      } else {
        await autoUpdater.downloadUpdate();
      }
      return { ok: true as const };
    } catch (err) {
      return {
        ok: false as const,
        reason: "error" as const,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle("updater:install", async () => {
    if (!app.isPackaged) return { ok: false as const, reason: "dev" as const };
    try {
      if (process.platform === "darwin") {
        await installMacUpdate();
        return { ok: true as const, version: downloadedVersion };
      }
      autoUpdater.quitAndInstall(false, true);
      return { ok: true as const, version: downloadedVersion };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send(getWindow(), "updater:error", { message });
      return {
        ok: false as const,
        reason: "error" as const,
        message,
      };
    }
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
  autoUpdater.autoInstallOnAppQuit = process.platform !== "darwin";
  autoUpdater.allowPrerelease = false;

  autoUpdater.on("update-available", (info) => {
    pendingInfo = info;
    const dismissed = readDismissed();
    if (dismissed.version && dismissed.version === info.version) {
      return;
    }
    const payload: UpdateAvailablePayload = {
      version: info.version,
      currentVersion: app.getVersion(),
      releaseName: info.releaseName,
      releaseNotes: toPlainReleaseNotes(info.releaseNotes),
    };
    send(getWindow(), "updater:available", payload);
  });

  autoUpdater.on("download-progress", (progress) => {
    if (process.platform === "darwin") return;
    const payload: UpdateProgressPayload = {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    };
    send(getWindow(), "updater:progress", payload);
  });

  autoUpdater.on("update-downloaded", (info) => {
    if (process.platform === "darwin") return;
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
