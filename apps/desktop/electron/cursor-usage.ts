import { spawn, spawnSync } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type CursorAccountUsage = {
  /** Percent of included quota already used (0–100+). */
  usedPercent: number;
  /** Percent remaining, clamped 0–100. */
  remainingPercent: number;
  apiPercentUsed: number | null;
  totalPercentUsed: number | null;
  membershipType: string | null;
  resetAt: string | null;
  displayMessage: string | null;
};

const SAFE_STORAGE_PREFIX = "cursor-safe-storage:v1:";

/** Process-lifetime cache so Keychain is not prompted every 5 minutes. */
let cachedMacMasterPassword: string | null | undefined;

function cursorStateDbPath(): string | null {
  if (process.platform === "darwin") {
    return path.join(
      homedir(),
      "Library/Application Support/Cursor/User/globalStorage/state.vscdb"
    );
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (!appData) return null;
    return path.join(appData, "Cursor/User/globalStorage/state.vscdb");
  }
  return path.join(
    homedir(),
    ".config/Cursor/User/globalStorage/state.vscdb"
  );
}

function cursorLocalStatePath(): string | null {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (!appData) return null;
    return path.join(appData, "Cursor/Local State");
  }
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library/Application Support/Cursor/Local State");
  }
  return path.join(homedir(), ".config/Cursor/Local State");
}

/** Prefer Node's built-in sqlite (works on Windows without sqlite3.exe). */
async function readSqliteValueNative(
  dbPath: string,
  key: string
): Promise<string | null> {
  try {
    const mod = (await import("node:sqlite")) as {
      DatabaseSync: new (
        path: string,
        opts?: { readOnly?: boolean }
      ) => {
        prepare: (sql: string) => {
          get: (...params: unknown[]) => { value?: unknown } | undefined;
        };
        close: () => void;
      };
    };
    const db = new mod.DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT value FROM ItemTable WHERE key = ?")
        .get(key);
      const value = row?.value;
      if (typeof value === "string" && value.trim()) return value.trim();
      if (value != null && typeof value !== "string") {
        const asText = String(value).trim();
        return asText || null;
      }
      return null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function readSqliteValueViaCli(
  dbPath: string,
  key: string
): Promise<string | null> {
  return new Promise((resolve) => {
    const sql = `SELECT value FROM ItemTable WHERE key = '${key.replace(/'/g, "''")}';`;
    const child = spawn("sqlite3", [dbPath, sql], {
      env: process.env,
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const value = out.trim();
      resolve(value || null);
    });
  });
}

async function readSqliteValue(
  dbPath: string,
  key: string
): Promise<string | null> {
  if (!existsSync(dbPath)) return null;
  const native = await readSqliteValueNative(dbPath, key);
  if (native != null) return native;
  return readSqliteValueViaCli(dbPath, key);
}

function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

function readMacSafeStoragePassword(): string | null {
  if (cachedMacMasterPassword !== undefined) return cachedMacMasterPassword;
  for (const account of ["Cursor Key", "Cursor"]) {
    const result = spawnSync(
      "security",
      ["find-generic-password", "-s", "Cursor Safe Storage", "-a", account, "-w"],
      { encoding: "utf8", timeout: 15_000, windowsHide: true }
    );
    if (result.status === 0) {
      const pw = (result.stdout || "").replace(/\r?\n$/, "");
      if (pw) {
        cachedMacMasterPassword = pw;
        return pw;
      }
    }
  }
  cachedMacMasterPassword = null;
  return null;
}

function decryptMacSafeStorageBlob(blob: Buffer): string | null {
  if (blob.length < 19 || blob.subarray(0, 3).toString("utf8") !== "v10") {
    return null;
  }
  const password = readMacSafeStoragePassword();
  if (!password) return null;
  try {
    const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
    const iv = Buffer.alloc(16, 0x20);
    const decipher = createDecipheriv("aes-128-cbc", key, iv);
    const plain = Buffer.concat([
      decipher.update(blob.subarray(3)),
      decipher.final(),
    ]);
    const text = plain.toString("utf8").replace(/\0+$/g, "").trim();
    return text || null;
  } catch {
    return null;
  }
}

function readWindowsOsCryptKey(): Buffer | null {
  const localStatePath = cursorLocalStatePath();
  if (!localStatePath || !existsSync(localStatePath)) return null;
  try {
    const localState = JSON.parse(readFileSync(localStatePath, "utf8")) as {
      os_crypt?: { encrypted_key?: string };
    };
    const encryptedKeyB64 = localState.os_crypt?.encrypted_key;
    if (!encryptedKeyB64) return null;
    const encryptedKey = Buffer.from(encryptedKeyB64, "base64");
    if (encryptedKey.length < 6) return null;
    if (encryptedKey.subarray(0, 5).toString("utf8") !== "DPAPI") return null;
    const protectedB64 = encryptedKey.subarray(5).toString("base64");
    const script = [
      "Add-Type -AssemblyName System.Security",
      `$p = [Convert]::FromBase64String('${protectedB64}')`,
      "$b = [System.Security.Cryptography.ProtectedData]::Unprotect($p, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
      "[Convert]::ToBase64String($b)",
    ].join("; ");
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", timeout: 15_000, windowsHide: true }
    );
    if (result.status !== 0) return null;
    const out = (result.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop();
    if (!out) return null;
    const key = Buffer.from(out, "base64");
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

function decryptWindowsSafeStorageBlob(blob: Buffer): string | null {
  if (blob.length < 3 + 12 + 16 || blob.subarray(0, 3).toString("utf8") !== "v10") {
    return null;
  }
  const key = readWindowsOsCryptKey();
  if (!key) return null;
  try {
    const nonce = blob.subarray(3, 15);
    const tag = blob.subarray(blob.length - 16);
    const ciphertext = blob.subarray(15, blob.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    const text = plain.toString("utf8").replace(/\0+$/g, "").trim();
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Cursor 3.27+ may store auth tokens as `cursor-safe-storage:v1:` + base64
 * Electron/Chromium OSCrypt ciphertext. Decrypt back to a JWT when possible.
 */
function unwrapCursorToken(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (!value.startsWith(SAFE_STORAGE_PREFIX)) {
    return value;
  }
  let blob: Buffer;
  try {
    blob = Buffer.from(value.slice(SAFE_STORAGE_PREFIX.length), "base64");
  } catch {
    return null;
  }
  if (process.platform === "darwin") {
    return decryptMacSafeStorageBlob(blob);
  }
  if (process.platform === "win32") {
    return decryptWindowsSafeStorageBlob(blob);
  }
  // Linux: try mac-style CBC with peanuts (basic_text) as a last resort.
  try {
    const key = pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
    const iv = Buffer.alloc(16, 0x20);
    if (blob.subarray(0, 3).toString("utf8") !== "v10") return null;
    const decipher = createDecipheriv("aes-128-cbc", key, iv);
    const plain = Buffer.concat([
      decipher.update(blob.subarray(3)),
      decipher.final(),
    ]);
    const text = plain.toString("utf8").replace(/\0+$/g, "").trim();
    return text || null;
  } catch {
    return null;
  }
}

async function readCursorAccessToken(): Promise<string | null> {
  const db = cursorStateDbPath();
  if (!db) return null;
  const raw = await readSqliteValue(db, "cursorAuth/accessToken");
  if (!raw) return null;
  const token = unwrapCursorToken(raw);
  if (!token) return null;
  // Encrypted blobs that failed to unwrap must not be sent as Bearer tokens.
  if (token.startsWith(SAFE_STORAGE_PREFIX)) return null;
  return token;
}

function jwtPayload(token: string): Record<string, unknown> | null {
  if (!looksLikeJwt(token)) return null;
  try {
    const json = Buffer.from(token.split(".")[1]!, "base64url").toString(
      "utf8"
    );
    const data = JSON.parse(json) as unknown;
    return data && typeof data === "object"
      ? (data as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function msToIso(value: unknown): string | null {
  const n = asNumber(value);
  if (n != null && n > 0) return new Date(n).toISOString();
  if (typeof value === "string" && value.includes("T")) return value;
  return null;
}

function normalizeUsage(raw: Record<string, unknown>): CursorAccountUsage | null {
  const planUsage = (raw.planUsage ??
    (raw.individualUsage as { plan?: unknown } | undefined)?.plan ??
    null) as Record<string, unknown> | null;

  const apiPercentUsed = asNumber(planUsage?.apiPercentUsed);
  const totalPercentUsed = asNumber(planUsage?.totalPercentUsed);
  const used =
    totalPercentUsed ??
    apiPercentUsed ??
    (() => {
      const usedAmt = asNumber(planUsage?.used);
      const limit = asNumber(planUsage?.limit);
      if (usedAmt != null && limit != null && limit > 0) {
        return (usedAmt / limit) * 100;
      }
      const remaining = asNumber(planUsage?.remaining);
      if (remaining != null && limit != null && limit > 0) {
        return ((limit - remaining) / limit) * 100;
      }
      const includedSpend = asNumber(planUsage?.includedSpend);
      const spendLimit = asNumber(planUsage?.limit);
      if (includedSpend != null && spendLimit != null && spendLimit > 0) {
        return (includedSpend / spendLimit) * 100;
      }
      return null;
    })();

  if (used == null || !Number.isFinite(used)) return null;

  const remainingPercent = Math.max(0, Math.min(100, Math.round(100 - used)));
  const membershipType =
    (typeof raw.membershipType === "string" && raw.membershipType) ||
    (typeof (raw.planInfo as { planName?: string } | undefined)?.planName ===
      "string" &&
      (raw.planInfo as { planName?: string }).planName) ||
    null;

  return {
    usedPercent: Math.max(0, used),
    remainingPercent,
    apiPercentUsed,
    totalPercentUsed,
    membershipType,
    resetAt:
      msToIso(raw.billingCycleEnd) ||
      msToIso((raw.planInfo as { billingCycleEnd?: unknown } | undefined)?.billingCycleEnd),
    displayMessage:
      (typeof raw.displayMessage === "string" && raw.displayMessage) ||
      (typeof raw.namedModelSelectedDisplayMessage === "string" &&
        raw.namedModelSelectedDisplayMessage) ||
      null,
  };
}

async function fetchJson(
  url: string,
  init: RequestInit
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, init);
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    if (!data || typeof data !== "object") return null;
    return data as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function fetchWithToken(token: string): Promise<CursorAccountUsage | null> {
  const connect = await fetchJson(
    "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: "{}",
    }
  );
  if (connect) {
    const normalized = normalizeUsage(connect);
    if (normalized) return normalized;
  }

  const summaryBearer = await fetchJson("https://cursor.com/api/usage-summary", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (summaryBearer) {
    const normalized = normalizeUsage(summaryBearer);
    if (normalized) return normalized;
  }

  const payload = jwtPayload(token);
  const sub = typeof payload?.sub === "string" ? payload.sub : null;
  if (sub) {
    const cookie = `WorkosCursorSessionToken=${encodeURIComponent(`${sub}::${token}`)}`;
    const summaryCookie = await fetchJson(
      "https://cursor.com/api/usage-summary",
      {
        method: "GET",
        headers: {
          Cookie: cookie,
          Accept: "application/json",
        },
      }
    );
    if (summaryCookie) {
      const normalized = normalizeUsage(summaryCookie);
      if (normalized) return normalized;
    }
  }

  return null;
}

/** Best-effort Cursor plan remaining usage. Hidden by the UI when null. */
export async function fetchCursorAccountUsage(
  apiKey?: string
): Promise<CursorAccountUsage | null> {
  const tokens: string[] = [];
  // Prefer the desktop session JWT — personal usage APIs reject most API keys.
  const desktopToken = await readCursorAccessToken();
  if (desktopToken) tokens.push(desktopToken);
  const key = apiKey?.trim();
  if (key && !tokens.includes(key)) tokens.push(key);

  for (const token of tokens) {
    const usage = await fetchWithToken(token);
    if (usage) return usage;
  }
  return null;
}
