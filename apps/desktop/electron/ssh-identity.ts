import { dialog, type BrowserWindow } from "electron";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SavedSession } from "@drift/core";
import { installAuthorizedKey } from "@drift/host-ssh";

export type SshIdentityInfo = {
  path: string;
  label: string;
  hasPublicKey: boolean;
};

const PREFERRED = [
  "id_ed25519",
  "id_ecdsa",
  "id_rsa",
  "id_ed25519_sk",
  "id_ecdsa_sk",
] as const;

const SKIP_NAMES = new Set([
  "config",
  "known_hosts",
  "known_hosts.old",
  "authorized_keys",
  "authorized_keys2",
]);

function sshDir(): string {
  return path.join(os.homedir(), ".ssh");
}

export function toSshDisplayPath(absPath: string): string {
  const home = os.homedir();
  const normalized = path.resolve(absPath);
  if (normalized === home) return "~";
  if (normalized.startsWith(home + path.sep)) {
    return `~/${normalized.slice(home.length + 1).split(path.sep).join("/")}`;
  }
  return normalized;
}

export function expandSshPath(p: string): string {
  const trimmed = p.trim();
  if (!trimmed) return trimmed;
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function preferredRank(name: string): number {
  const idx = PREFERRED.indexOf(name as (typeof PREFERRED)[number]);
  return idx === -1 ? PREFERRED.length + 1 : idx;
}

async function looksLikePrivateKey(filePath: string, name: string): Promise<boolean> {
  if (PREFERRED.includes(name as (typeof PREFERRED)[number]) || name.startsWith("id_")) {
    return true;
  }
  try {
    const head = (await readFile(filePath, { encoding: "utf8" })).slice(0, 120);
    return /BEGIN .*PRIVATE KEY|BEGIN OPENSSH PRIVATE KEY/i.test(head);
  } catch {
    return false;
  }
}

export async function listSshIdentities(): Promise<SshIdentityInfo[]> {
  const dir = sshDir();
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const out: SshIdentityInfo[] = [];
  for (const name of names) {
    if (name.endsWith(".pub") || name.startsWith(".")) continue;
    if (SKIP_NAMES.has(name)) continue;
    const full = path.join(dir, name);
    try {
      const st = await stat(full);
      if (!st.isFile()) continue;
      if (!(await looksLikePrivateKey(full, name))) continue;
    } catch {
      continue;
    }
    out.push({
      path: toSshDisplayPath(full),
      label: `~/.ssh/${name}`,
      hasPublicKey: existsSync(`${full}.pub`),
    });
  }

  out.sort((a, b) => {
    const an = path.basename(expandSshPath(a.path));
    const bn = path.basename(expandSshPath(b.path));
    const rank = preferredRank(an) - preferredRank(bn);
    if (rank !== 0) return rank;
    return an.localeCompare(bn);
  });
  return out;
}

export async function defaultSshIdentity(): Promise<string | null> {
  const list = await listSshIdentities();
  return list[0]?.path ?? null;
}

export async function pickSshIdentity(
  parent: BrowserWindow | null
): Promise<string | null> {
  const dir = sshDir();
  const opts = {
    title: "Select SSH private key",
    defaultPath: existsSync(dir) ? dir : os.homedir(),
    properties: ["openFile", "treatPackageAsDirectory"] as Array<
      "openFile" | "treatPackageAsDirectory"
    >,
  };
  const result = parent
    ? await dialog.showOpenDialog(parent, opts)
    : await dialog.showOpenDialog(opts);
  if (result.canceled || !result.filePaths[0]) return null;
  return toSshDisplayPath(result.filePaths[0]);
}

export async function readSshPublicKey(
  identityPath: string
): Promise<{ ok: true; content: string; path: string } | { ok: false; reason: string }> {
  const privatePath = expandSshPath(identityPath);
  if (!privatePath) return { ok: false, reason: "empty" };
  const pubPath = privatePath.endsWith(".pub")
    ? privatePath
    : `${privatePath}.pub`;
  if (!existsSync(pubPath)) return { ok: false, reason: "missing" };
  try {
    const content = (await readFile(pubPath, "utf8")).trim();
    if (!content) return { ok: false, reason: "empty" };
    return { ok: true, content, path: toSshDisplayPath(pubPath) };
  } catch {
    return { ok: false, reason: "read_failed" };
  }
}

function sshKeygenBinary(): string {
  if (process.platform === "win32") {
    const sysRoot = process.env.SystemRoot || "C:\\Windows";
    const system = path.join(sysRoot, "System32", "OpenSSH", "ssh-keygen.exe");
    if (existsSync(system)) return system;
    return "ssh-keygen";
  }
  return "/usr/bin/ssh-keygen";
}

function safeKeyStem(nameHint?: string): string {
  const raw = (nameHint || "drift").trim().toLowerCase() || "drift";
  const cleaned = raw.replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return (cleaned || "drift").slice(0, 32);
}

export async function generateSshIdentity(
  nameHint?: string
): Promise<
  { ok: true; path: string; publicKeyPath: string } | { ok: false; reason: string; detail?: string }
> {
  const dir = sshDir();
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return {
      ok: false,
      reason: "mkdir_failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const stem = safeKeyStem(nameHint);
  let base = path.join(dir, `drift_${stem}_ed25519`);
  let n = 0;
  while (existsSync(base) || existsSync(`${base}.pub`)) {
    n += 1;
    base = path.join(dir, `drift_${stem}_ed25519_${n}`);
  }

  const bin = sshKeygenBinary();
  const result = spawnSync(
    bin,
    ["-t", "ed25519", "-N", "", "-f", base, "-C", `drift@${os.hostname()}`],
    { encoding: "utf8", windowsHide: true }
  );
  if (result.status !== 0 || !existsSync(base) || !existsSync(`${base}.pub`)) {
    return {
      ok: false,
      reason: "keygen_failed",
      detail: (result.stderr || result.stdout || result.error?.message || "").trim(),
    };
  }
  return {
    ok: true,
    path: toSshDisplayPath(base),
    publicKeyPath: toSshDisplayPath(`${base}.pub`),
  };
}

export async function installSshPublicKey(input: {
  session: SavedSession;
  identityPath: string;
  password: string;
}): Promise<{ ok: true } | { ok: false; reason: string; detail?: string }> {
  const pub = await readSshPublicKey(input.identityPath);
  if (!pub.ok) return { ok: false, reason: pub.reason };
  const result = await installAuthorizedKey(
    input.session,
    pub.content,
    input.password
  );
  if (result.ok) return { ok: true };
  return { ok: false, reason: "install_failed", detail: result.message };
}
