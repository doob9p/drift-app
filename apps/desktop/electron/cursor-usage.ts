import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
      const row = db.prepare(
        "SELECT value FROM ItemTable WHERE key = ?"
      ).get(key);
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

async function readCursorAccessToken(): Promise<string | null> {
  const db = cursorStateDbPath();
  if (!db) return null;
  return readSqliteValue(db, "cursorAuth/accessToken");
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

  const summary = await fetchJson("https://cursor.com/api/usage-summary", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (summary) {
    const normalized = normalizeUsage(summary);
    if (normalized) return normalized;
  }

  return null;
}

/** Best-effort Cursor plan remaining usage. Hidden by the UI when null. */
export async function fetchCursorAccountUsage(
  apiKey?: string
): Promise<CursorAccountUsage | null> {
  const tokens: string[] = [];
  const key = apiKey?.trim();
  if (key) tokens.push(key);
  const desktopToken = await readCursorAccessToken();
  if (desktopToken && !tokens.includes(desktopToken)) tokens.push(desktopToken);

  for (const token of tokens) {
    const usage = await fetchWithToken(token);
    if (usage) return usage;
  }
  return null;
}
