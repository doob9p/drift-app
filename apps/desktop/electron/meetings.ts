import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { app, dialog, BrowserWindow } from "electron";
import { newId } from "@drift/core";

export type MeetingStatus = "idle" | "recording" | "paused" | "done";

export type MeetingMeta = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  durationMs: number;
  status: MeetingStatus;
  hasAudio: boolean;
  hasTranscript: boolean;
  hasNotes: boolean;
  hasSummary: boolean;
};

export type MeetingRecord = {
  meta: MeetingMeta;
  transcript: string;
  notes: string;
  summary: string;
  audioPath: string | null;
};

function meetingsRoot(): string {
  return path.join(app.getPath("userData"), "drift", "meetings");
}

function meetingDir(id: string): string {
  return path.join(meetingsRoot(), id);
}

async function ensureRoot(): Promise<void> {
  await mkdir(meetingsRoot(), { recursive: true });
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeText(file: string, content: string): Promise<void> {
  await writeFile(file, content, "utf8");
}

async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

function defaultTitle(when = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Meeting ${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

async function refreshFlags(meta: MeetingMeta): Promise<MeetingMeta> {
  const dir = meetingDir(meta.id);
  const next: MeetingMeta = {
    ...meta,
    hasAudio: false,
    hasTranscript: false,
    hasNotes: false,
    hasSummary: false,
  };
  try {
    const files = await readdir(dir);
    next.hasAudio = files.includes("audio.webm");
    next.hasTranscript = files.includes("transcript.txt");
    next.hasNotes = files.includes("notes.md");
    next.hasSummary = files.includes("summary.md");
  } catch {
    /* ignore */
  }
  return next;
}

export async function listMeetings(): Promise<MeetingMeta[]> {
  await ensureRoot();
  const ids = await readdir(meetingsRoot()).catch(() => [] as string[]);
  const items: MeetingMeta[] = [];
  for (const id of ids) {
    const meta = await readJson<MeetingMeta>(path.join(meetingDir(id), "meta.json"));
    if (meta) items.push(await refreshFlags(meta));
  }
  items.sort((a, b) => {
    const byUpdated = b.updatedAt.localeCompare(a.updatedAt);
    if (byUpdated !== 0) return byUpdated;
    return b.createdAt.localeCompare(a.createdAt);
  });
  return items;
}

export async function createMeeting(title?: string): Promise<MeetingRecord> {
  await ensureRoot();
  const id = newId();
  const now = new Date().toISOString();
  const dir = meetingDir(id);
  await mkdir(dir, { recursive: true });
  const meta: MeetingMeta = {
    id,
    title: title?.trim() || defaultTitle(),
    createdAt: now,
    updatedAt: now,
    durationMs: 0,
    status: "idle",
    hasAudio: false,
    hasTranscript: false,
    hasNotes: false,
    hasSummary: false,
  };
  await writeText(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  await writeText(path.join(dir, "transcript.txt"), "");
  await writeText(path.join(dir, "notes.md"), "");
  await writeText(path.join(dir, "summary.md"), "");
  return {
    meta,
    transcript: "",
    notes: "",
    summary: "",
    audioPath: null,
  };
}

export async function getMeeting(id: string): Promise<MeetingRecord | null> {
  const dir = meetingDir(id);
  const meta = await readJson<MeetingMeta>(path.join(dir, "meta.json"));
  if (!meta) return null;
  const refreshed = await refreshFlags(meta);
  return {
    meta: refreshed,
    transcript: await readText(path.join(dir, "transcript.txt")),
    notes: await readText(path.join(dir, "notes.md")),
    summary: await readText(path.join(dir, "summary.md")),
    audioPath: refreshed.hasAudio ? path.join(dir, "audio.webm") : null,
  };
}

export async function saveMeeting(
  id: string,
  patch: {
    title?: string;
    durationMs?: number;
    status?: MeetingStatus;
    transcript?: string;
    notes?: string;
    summary?: string;
  }
): Promise<MeetingRecord | null> {
  const current = await getMeeting(id);
  if (!current) return null;
  const dir = meetingDir(id);
  const meta: MeetingMeta = {
    ...current.meta,
    title: patch.title?.trim() || current.meta.title,
    durationMs:
      patch.durationMs != null ? patch.durationMs : current.meta.durationMs,
    status: patch.status ?? current.meta.status,
    updatedAt: new Date().toISOString(),
  };
  if (patch.transcript != null) {
    await writeText(path.join(dir, "transcript.txt"), patch.transcript);
  }
  if (patch.notes != null) {
    await writeText(path.join(dir, "notes.md"), patch.notes);
  }
  if (patch.summary != null) {
    await writeText(path.join(dir, "summary.md"), patch.summary);
  }
  const refreshed = await refreshFlags(meta);
  await writeText(path.join(dir, "meta.json"), JSON.stringify(refreshed, null, 2));
  return getMeeting(id);
}

export async function saveMeetingAudio(
  id: string,
  data: Uint8Array
): Promise<MeetingRecord | null> {
  const current = await getMeeting(id);
  if (!current) return null;
  const dir = meetingDir(id);
  await writeFile(path.join(dir, "audio.webm"), Buffer.from(data));
  return saveMeeting(id, { status: "done" });
}

export async function deleteMeeting(id: string): Promise<{ ok: true }> {
  await rm(meetingDir(id), { recursive: true, force: true });
  return { ok: true };
}

export async function exportMeeting(
  id: string,
  parentWindow: BrowserWindow | null
): Promise<{ ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }> {
  const meeting = await getMeeting(id);
  if (!meeting) return { ok: false, error: "Meeting not found" };
  const safeTitle = meeting.meta.title
    .replace(/[\\/:*?"<>|]+/g, "-")
    .trim()
    .slice(0, 80);
  const result = parentWindow
    ? await dialog.showSaveDialog(parentWindow, {
        title: "Export meeting",
        defaultPath: safeTitle || `meeting-${id.slice(0, 8)}`,
        buttonLabel: "Export",
        properties: ["createDirectory", "showOverwriteConfirmation"],
      })
    : await dialog.showSaveDialog({
        title: "Export meeting",
        defaultPath: safeTitle || `meeting-${id.slice(0, 8)}`,
        buttonLabel: "Export",
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
  if (result.canceled || !result.filePath) {
    return { ok: false, canceled: true };
  }
  const dest = result.filePath;
  await mkdir(dest, { recursive: true });
  const dir = meetingDir(id);
  const copies: Array<[string, string]> = [
    ["meta.json", "meta.json"],
    ["transcript.txt", "transcript.txt"],
    ["notes.md", "notes.md"],
    ["summary.md", "summary.md"],
  ];
  if (meeting.meta.hasAudio) {
    copies.push(["audio.webm", "audio.webm"]);
  }
  for (const [srcName, destName] of copies) {
    try {
      await copyFile(path.join(dir, srcName), path.join(dest, destName));
    } catch {
      /* optional files */
    }
  }
  // Friendly combined markdown for sharing
  const bundle = [
    `# ${meeting.meta.title}`,
    "",
    `Created: ${meeting.meta.createdAt}`,
    `Duration: ${Math.round(meeting.meta.durationMs / 1000)}s`,
    "",
    "## Summary",
    "",
    meeting.summary.trim() || "_(no summary)_",
    "",
    "## Notes",
    "",
    meeting.notes.trim() || "_(no notes)_",
    "",
    "## Transcript",
    "",
    meeting.transcript.trim() || "_(no transcript)_",
    "",
  ].join("\n");
  await writeText(path.join(dest, "meeting.md"), bundle);
  return { ok: true, path: dest };
}
