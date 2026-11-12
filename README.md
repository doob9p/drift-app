# Drift

macOS-first terminal app with saved SSH sessions and a Cursor agent panel.

> Repo folder: `drift-app`. npm packages: `@drift/*`.

## MVP

- Local PTY terminal
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

If the local terminal fails with `posix_spawnp`:

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

The release should include at least:

- `Drift-*-mac-*.dmg` (install)
- `Drift-*-mac-*.zip` (auto-update)
- `latest-mac.yml` (updater feed)

Packaged apps check for updates on launch (and every 4 hours). When a newer version exists, Drift shows an in-app modal: **Later** / **Update** → download progress → **Restart & install**.

### Code signing (later)

This project currently ships **without** Apple Developer ID signing / notarization (`identity: null`). Users may need to right-click the app → **Open** the first time (Gatekeeper). Auto-update still uses the GitHub zip channel; add signing + notarization before a wide public launch.

## Notes

- Set your Cursor API key in **Settings** (gear). Stored encrypted in the OS keychain.
- SSH sessions are saved without passwords; uses system `ssh` + IdentityFile / agent.
- Agent proposes commands → approve once / for session / deny → runs on the active host.
- Dev mode (`npm run dev`) does not check for updates.
