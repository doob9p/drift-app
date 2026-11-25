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
    actions?: Array<{ label: string; onClick: () => void }>;
  }
): void {
  const root = ensureHost();
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  const detail = opts?.detail?.trim();
  const actions = opts?.actions?.length
    ? opts.actions
    : opts?.action
      ? [opts.action]
      : [];
  const parts = [
    `<div class="toast-title">${escapeHtml(message)}</div>`,
  ];
  if (detail) {
    parts.push(
      `<div class="toast-detail">${escapeHtml(detail)}</div>`
    );
  }
  if (actions.length) {
    parts.push(
      `<div class="toast-actions">${actions
        .map(
          (a, i) =>
            `<button type="button" class="toast-action" data-toast-action="${i}">${escapeHtml(a.label)}</button>`
        )
        .join("")}</div>`
    );
  }
  el.innerHTML = parts.join("");
  for (const btn of el.querySelectorAll("[data-toast-action]")) {
    const idx = Number((btn as HTMLElement).dataset.toastAction);
    const action = actions[idx];
    if (!action) continue;
    (btn as HTMLButtonElement).onclick = (e) => {
      e.stopPropagation();
      action.onClick();
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
