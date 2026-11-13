# Drift

Terminal app with saved SSH sessions and a Cursor agent panel.

> Repo folder: `drift-app`. npm packages: `@drift/*`.

## MVP

- Local PTY terminal (macOS / Windows)
- Saved SSH sessions (no passwords stored)
- Cursor API key entered in-app (OS encrypted storage)
- Agent proposes commands → approve → run on the active host
- Auto-update from GitHub Releases (packaged builds)

## Develop

```bash
cd drift-app
npm install          # also rebuilds node-pty for Electron
npm run dev
```

If the local terminal fails with `posix_spawnp` (macOS) or a native module error:

```bash
npm run rebuild:native
```

## Release (macOS)

Packaging uses `electron-builder` + `electron-updater` with **GitHub Releases**.

1. Repo: [`doob9p/drift-app`](https://github.com/doob9p/drift-app) (publish owner already set).
2. Bump `"version"` in [`apps/desktop/package.json`](apps/desktop/package.json) (and root if you keep them in sync).
3. Export a token that can create releases:

```bash
export GH_TOKEN=ghp_...
```

4. Build locally (no upload):

```bash
npm run dist:mac
```

5. Build and publish to GitHub Releases:

```bash
npm run release:mac
```

The macOS release should include at least:

- `Drift-*-mac-*.dmg` (install)
- `Drift-*-mac-*.zip` (auto-update)
- `latest-mac.yml` (updater feed)

### Code signing (macOS, later)

This project currently ships **without** Apple Developer ID signing / notarization (`identity: null`). Users may need `xattr -cr` / Gatekeeper workarounds the first time. Add signing + notarization before a wide public launch.

## Release (Windows)

Windows installers must be built on Windows (native `node-pty`). From this Mac, use GitHub Actions:

```bash
# after pushing a version tag, or manually:
# Actions → “Release Windows” → Run workflow
```

Workflow: [`.github/workflows/release-windows.yml`](.github/workflows/release-windows.yml)

On a Windows machine locally:

```bash
# PowerShell / cmd — GH_TOKEN only needed for release:win
npm ci
npm run dist:win          # rebuilds node-pty, then builds NSIS + zip
npm run release:win       # publish to GitHub Releases (needs GH_TOKEN)
```

Windows notes:

- Local shell defaults to PowerShell (with OSC 7 cwd tracking).
- Meeting mic + live transcript use Chromium APIs; transcript may need network and can fall back to notes-only.
- Cursor usage can read the desktop login DB via built-in `node:sqlite` (no `sqlite3.exe` required).

Windows artifacts:

- `Drift-*-win-*-setup.exe` (NSIS installer)
- `Drift-*-win-*.zip` (portable / updater)
- `latest.yml` (updater feed)

Unsigned Windows builds may show SmartScreen warnings until Authenticode signing is added.

Packaged apps check for updates on launch (and every 4 hours). When a newer version exists, Drift shows an in-app modal: **Later** / **Update** → download progress → **Restart & install**.

## Notes

- Set your Cursor API key in **Settings** (gear). Stored encrypted in the OS keychain / credential store.
- SSH sessions are saved without passwords; uses system `ssh` + IdentityFile / agent (Windows: OpenSSH).
- Agent proposes commands → approve once / for session / deny → runs on the active host.
- Dev mode (`npm run dev`) does not check for updates.
