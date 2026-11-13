export type ToastKind = "info" | "ok" | "error";

let host: HTMLElement | null = null;

function ensureHost(): HTMLElement {
  if (host?.isConnected) return host;
  host = document.getElementById("toast-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "toast-host";
    host.className = "toast-host";
    host.setAttribute("aria-live", "polite");
    document.body.append(host);
  }
  return host;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Short user-facing toast; keep technical detail out of the Files header. */
export function showToast(
  message: string,
  kind: ToastKind = "info",
  opts?: {
    detail?: string;
    ms?: number;
    action?: { label: string; onClick: () => void };
  }
): void {
  const root = ensureHost();
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  const detail = opts?.detail?.trim();
  const parts = [
    `<div class="toast-title">${escapeHtml(message)}</div>`,
  ];
  if (detail) {
    parts.push(
      `<div class="toast-detail">${escapeHtml(detail)}</div>`
    );
  }
  if (opts?.action) {
    parts.push(
      `<button type="button" class="toast-action">${escapeHtml(opts.action.label)}</button>`
    );
  }
  el.innerHTML = parts.join("");
  const actionBtn = el.querySelector(".toast-action") as HTMLButtonElement | null;
  if (actionBtn && opts?.action) {
    actionBtn.onclick = (e) => {
      e.stopPropagation();
      opts.action?.onClick();
      el.classList.remove("show");
      window.setTimeout(() => el.remove(), 220);
    };
  }
  root.append(el);
  requestAnimationFrame(() => el.classList.add("show"));
  const ms = opts?.ms ?? (kind === "error" ? 5200 : 2600);
  window.setTimeout(() => {
    el.classList.remove("show");
    window.setTimeout(() => el.remove(), 220);
  }, ms);
}
