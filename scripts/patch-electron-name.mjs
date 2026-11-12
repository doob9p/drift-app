/**
 * Dev Electron.app ships branded as "Electron" (menu bar, About, Force Quit).
 * Rewrite bundle identity + dock icon so local runs show "Drift".
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "Drift";
const BUNDLE_ID = "app.drift.desktop";
const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

if (process.platform !== "darwin") {
  process.exit(0);
}

let electronRoot;
try {
  electronRoot = path.dirname(require.resolve("electron/package.json"));
} catch {
  console.warn("[patch-electron-name] electron package not found; skip");
  process.exit(0);
}

const plist = path.join(
  electronRoot,
  "dist",
  "Electron.app",
  "Contents",
  "Info.plist"
);

if (!existsSync(plist)) {
  console.warn(`[patch-electron-name] missing ${plist}; skip`);
  process.exit(0);
}

function setPlistString(key, value) {
  const replace = spawnSync(
    "plutil",
    ["-replace", key, "-string", value, plist],
    { encoding: "utf8" }
  );
  if (replace.status === 0) return;
  const insert = spawnSync(
    "plutil",
    ["-insert", key, "-string", value, plist],
    { encoding: "utf8" }
  );
  if (insert.status !== 0) {
    console.warn(
      `[patch-electron-name] failed ${key}: ${insert.stderr || replace.stderr}`
    );
  }
}

setPlistString("CFBundleName", NAME);
setPlistString("CFBundleDisplayName", NAME);
setPlistString("CFBundleIdentifier", BUNDLE_ID);

const iconSrc = path.join(
  scriptDir,
  "../apps/desktop/resources/brand/icon.icns"
);
const electronIcns = path.join(
  electronRoot,
  "dist",
  "Electron.app",
  "Contents",
  "Resources",
  "electron.icns"
);
if (existsSync(iconSrc) && existsSync(path.dirname(electronIcns))) {
  copyFileSync(iconSrc, electronIcns);
  console.log(`[patch-electron-name] icon → ${electronIcns}`);
}

console.log(`[patch-electron-name] ${plist} → ${NAME} (${BUNDLE_ID})`);
