import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { SavedSession } from "./types.js";

export class SessionStore {
  private filePath: string;
  private sessions: SavedSession[] = [];

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "sessions.json");
  }

  async load(): Promise<SavedSession[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as SavedSession[];
      this.sessions = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.sessions = [];
    }
    return this.list();
  }

  list(): SavedSession[] {
    return [...this.sessions].sort((a, b) =>
      a.name.localeCompare(b.name, "en")
    );
  }

  async upsert(
    input: Omit<SavedSession, "id" | "createdAt" | "updatedAt"> & {
      id?: string;
    }
  ): Promise<SavedSession> {
    const now = new Date().toISOString();
    if (input.id) {
      const idx = this.sessions.findIndex((s) => s.id === input.id);
      if (idx >= 0) {
        const next: SavedSession = {
          ...this.sessions[idx],
          ...input,
          id: input.id,
          updatedAt: now,
        };
        this.sessions[idx] = next;
        await this.persist();
        return next;
      }
    }
    const created: SavedSession = {
      id: input.id ?? randomUUID(),
      name: input.name,
      folder: input.folder,
      host: input.host,
      user: input.user,
      port: input.port,
      identityFile: input.identityFile,
      proxyJump: input.proxyJump,
      startDir: input.startDir,
      sshConfigHost: input.sshConfigHost,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.push(created);
    await this.persist();
    return created;
  }

  async remove(id: string): Promise<boolean> {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.sessions.length === before) return false;
    await this.persist();
    return true;
  }

  get(id: string): SavedSession | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      JSON.stringify(this.sessions, null, 2),
      "utf8"
    );
  }
}

/** Minimal ~/.ssh/config Host block parser (enough for MVP import). */
export function parseSshConfig(content: string): Array<{
  sshConfigHost: string;
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  proxyJump?: string;
}> {
  const lines = content.split(/\r?\n/);
  const results: Array<{
    sshConfigHost: string;
    host: string;
    user?: string;
    port?: number;
    identityFile?: string;
    proxyJump?: string;
  }> = [];

  let current: {
    sshConfigHost: string;
    host: string;
    user?: string;
    port?: number;
    identityFile?: string;
    proxyJump?: string;
  } | null = null;

  const flush = () => {
    if (current && current.sshConfigHost && !/[?*]/.test(current.sshConfigHost)) {
      results.push(current);
    }
    current = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [key, ...rest] = line.split(/\s+/);
    const value = rest.join(" ").trim();
    const k = key.toLowerCase();
    if (k === "host") {
      flush();
      const name = value.split(/\s+/)[0];
      current = {
        sshConfigHost: name,
        host: name,
      };
      continue;
    }
    if (!current) continue;
    if (k === "hostname") current.host = value;
    if (k === "user") current.user = value;
    if (k === "port") current.port = Number(value) || undefined;
    if (k === "identityfile") current.identityFile = value;
    if (k === "proxyjump") current.proxyJump = value;
  }
  flush();
  return results;
}
