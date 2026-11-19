#!/usr/bin/env node
/**
 * Download portable Win32-OpenSSH (x64) into apps/desktop/resources/win-openssh.
 * Used by Windows packaging so Drift can SSH without a system OpenSSH install.
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile, mkdtemp } from "node:fs/promises";
import https from "node:https";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const TAG = "10.4.0.0p1-Preview";
const ASSET = "OpenSSH-Win64.zip";
const URL = `https://github.com/PowerShell/Win32-OpenSSH/releases/download/${TAG}/${ASSET}`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "apps/desktop/resources/win-openssh");
const stampPath = path.join(outDir, ".version");

const KEEP_EXACT = new Set([
  "ssh.exe",
  "scp.exe",
  "sftp.exe",
  "ssh-add.exe",
  "ssh-agent.exe",
  "ssh-keygen.exe",
  "ssh-keyscan.exe",
]);

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(
      url,
      { headers: { "User-Agent": "drift-fetch-win-openssh" } },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          download(res.headers.location, dest).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed HTTP ${res.statusCode} for ${url}`));
          res.resume();
          return;
        }
        pipeline(res, createWriteStream(dest)).then(resolve, reject);
      }
    );
    req.on("error", reject);
  });
}

function unzip(zipPath, dest) {
  mkdirSync(dest, { recursive: true });
  if (process.platform === "win32") {
    // Prefer tar: Expand-Archive on PowerShell 7 can fail with
    // ZipFileExtensions.ExtractToDirectory overload errors on GHA runners.
    try {
      execFileSync("tar.exe", ["-xf", zipPath, "-C", dest], {
        stdio: "inherit",
      });
      return;
    } catch {
      /* fall through to .NET ZipFile (2-arg) */
    }
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        [
          "Add-Type -AssemblyName System.IO.Compression.FileSystem;",
          `$z = '${zipPath.replace(/'/g, "''")}';`,
          `$d = '${dest.replace(/'/g, "''")}';`,
          "if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force };",
          "New-Item -ItemType Directory -Path $d | Out-Null;",
          "[System.IO.Compression.ZipFile]::ExtractToDirectory($z, $d);",
        ].join(" "),
      ],
      { stdio: "inherit" }
    );
    return;
  }
  execFileSync("unzip", ["-o", zipPath, "-d", dest], { stdio: "inherit" });
}

function findFiles(dir, acc = []) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) findFiles(p, acc);
    else acc.push(p);
  }
  return acc;
}

function shouldKeep(base) {
  if (KEEP_EXACT.has(base)) return true;
  return /\.dll$/i.test(base);
}

async function main() {
  if (existsSync(path.join(outDir, "ssh.exe")) && existsSync(stampPath)) {
    const version = (await readFile(stampPath, "utf8")).trim();
    if (version === TAG) {
      console.log(`win-openssh already present (${TAG})`);
      return;
    }
  }

  await mkdir(outDir, { recursive: true });
  const tmp = await mkdtemp(path.join(os.tmpdir(), "drift-openssh-"));
  const zipPath = path.join(tmp, ASSET);
  const extractDir = path.join(tmp, "extract");

  try {
    console.log(`Downloading ${URL}`);
    await download(URL, zipPath);
    unzip(zipPath, extractDir);

    for (const name of readdirSync(outDir)) {
      if (name === "README.md" || name === ".gitkeep") continue;
      await rm(path.join(outDir, name), { recursive: true, force: true });
    }

    const files = findFiles(extractDir);
    let copied = 0;
    for (const file of files) {
      const base = path.basename(file);
      if (!shouldKeep(base)) continue;
      await copyFile(file, path.join(outDir, base));
      copied += 1;
    }

    if (!existsSync(path.join(outDir, "ssh.exe"))) {
      throw new Error("ssh.exe missing after extract — OpenSSH zip layout changed?");
    }
    if (!existsSync(path.join(outDir, "scp.exe"))) {
      throw new Error("scp.exe missing after extract — OpenSSH zip layout changed?");
    }

    await writeFile(stampPath, `${TAG}\n`, "utf8");
    console.log(`Installed ${copied} OpenSSH files → ${outDir} (${TAG})`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
