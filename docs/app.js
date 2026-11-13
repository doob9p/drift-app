const RELEASE_API =
  "https://api.github.com/repos/doob9p/drift-app/releases/latest";
const RELEASE_PAGE =
  "https://github.com/doob9p/drift-app/releases/latest";

const primary = document.getElementById("btn-primary");
const secondary = document.getElementById("btn-secondary");
const meta = document.getElementById("meta");

function platform() {
  const ua = navigator.userAgent || "";
  if (/Windows/i.test(ua)) return "win";
  if (/Mac/i.test(ua)) return "mac";
  return "other";
}

function pickAsset(assets, kind) {
  const list = Array.isArray(assets) ? assets : [];
  if (kind === "mac") {
    return (
      list.find((a) => /mac-arm64\.dmg$/i.test(a.name)) ||
      list.find((a) => /\.dmg$/i.test(a.name))
    );
  }
  if (kind === "win") {
    return (
      list.find((a) => /win-x64\.exe$/i.test(a.name)) ||
      list.find((a) => /\.exe$/i.test(a.name))
    );
  }
  return null;
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "";
  const mb = n / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

function setFallback() {
  primary.href = RELEASE_PAGE;
  primary.textContent = "릴리스에서 받기";
  secondary.href = RELEASE_PAGE;
  secondary.textContent = "GitHub Releases";
  meta.textContent = "플랫폼에 맞는 파일을 릴리스 페이지에서 골라 주세요.";
}

async function boot() {
  const kind = platform();

  try {
    const res = await fetch(RELEASE_API, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const tag = String(data.tag_name || "").replace(/^v/, "") || "latest";
    const assets = data.assets || [];

    const mac = pickAsset(assets, "mac");
    const win = pickAsset(assets, "win");

    if (kind === "mac" && mac) {
      primary.href = mac.browser_download_url;
      primary.textContent = "macOS 다운로드";
      secondary.href = win?.browser_download_url || RELEASE_PAGE;
      secondary.textContent = win ? "Windows 버전" : "다른 버전";
      meta.textContent = `v${tag} · ${mac.name}${
        mac.size ? ` · ${formatBytes(mac.size)}` : ""
      } · Apple Silicon`;
      return;
    }

    if (kind === "win" && win) {
      primary.href = win.browser_download_url;
      primary.textContent = "Windows 다운로드";
      secondary.href = mac?.browser_download_url || RELEASE_PAGE;
      secondary.textContent = mac ? "macOS 버전" : "다른 버전";
      meta.textContent = `v${tag} · ${win.name}${
        win.size ? ` · ${formatBytes(win.size)}` : ""
      } · x64`;
      return;
    }

    primary.href = RELEASE_PAGE;
    primary.textContent = "다운로드";
    secondary.href = RELEASE_PAGE;
    secondary.textContent = "모든 파일 보기";
    const bits = [`v${tag}`];
    if (mac) bits.push("macOS");
    if (win) bits.push("Windows");
    meta.textContent = bits.join(" · ");
  } catch {
    setFallback();
  }
}

boot();
