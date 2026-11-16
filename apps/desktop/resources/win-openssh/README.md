# Bundled Win32-OpenSSH (x64)

Windows builds ship a portable OpenSSH client here so Drift can open SSH
sessions without requiring the user to install the optional Windows feature.

Populate with:

```bash
node scripts/fetch-win-openssh.mjs
```

`dist:win` / `release:win` run that script automatically. Binaries are not
committed to git.
