import { app, safeStorage } from "electron";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

function secretsDir(): string {
  return path.join(app.getPath("userData"), "drift", "ssh-secrets");
}

function passwordPath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(secretsDir(), `${safe}.bin`);
}

export async function hasSshPassword(sessionId: string): Promise<boolean> {
  if (!sessionId.trim()) return false;
  return existsSync(passwordPath(sessionId));
}

export async function loadSshPassword(sessionId: string): Promise<string> {
  if (!sessionId.trim()) return "";
  try {
    const buf = await readFile(passwordPath(sessionId));
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(buf);
    }
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

export async function saveSshPassword(
  sessionId: string,
  password: string
): Promise<void> {
  const id = sessionId.trim();
  if (!id) throw new Error("Missing session id");
  const value = password.trim();
  if (!value) {
    await clearSshPassword(id);
    return;
  }
  await mkdir(secretsDir(), { recursive: true });
  const file = passwordPath(id);
  if (safeStorage.isEncryptionAvailable()) {
    await writeFile(file, safeStorage.encryptString(value));
  } else {
    await writeFile(file, value, { encoding: "utf8", mode: 0o600 });
  }
}

export async function clearSshPassword(sessionId: string): Promise<void> {
  if (!sessionId.trim()) return;
  try {
    await unlink(passwordPath(sessionId));
  } catch {
    /* ignore */
  }
}
