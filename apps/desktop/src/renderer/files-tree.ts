import { icons } from "./icons.js";
import { t } from "./i18n.js";
import { showToast } from "./toast.js";

export type FsEntry = {
  name: string;
  path: string;
  kind: "dir" | "file";
  size?: number;
};

export type ListDirResult = {
  path: string;
  entries: FsEntry[];
  home?: string;
  error?: string;
};

type ListDir = (dirPath?: string) => Promise<ListDirResult>;

type PaneScope = "local" | "server";

type ImportResult = { error?: string } | void;

export type TransferProgress = {
  transferId: string;
  percent: number;
  transferred: number;
  total: number;
  currentName?: string;
};

export type TransferHistoryEntry = {
  id: string;
  at: number;
  direction: "upload" | "download" | "copy" | "rename" | "delete";
  name: string;
  ok: boolean;
  detail?: string;
};

type PaneCallbacks = {
  listDir: ListDir;
  onOpenDir: (dirPath: string) => void | Promise<void>;
  onInsertPath: (filePath: string) => void | Promise<void>;
  onOpenFile?: (filePath: string) => void | Promise<void>;
  resolveDropPaths?: (files: File[]) => string[];
  onImportFiles?: (
    destDir: string,
    sources: string[],
    transferId: string
  ) => Promise<ImportResult>;
  onDownloadPaths?: (
    sources: string[],
    transferId: string
  ) => Promise<ImportResult>;
  onRenamePath?: (
    fromPath: string,
    toPath: string
  ) => Promise<ImportResult>;
  onDeletePath?: (targetPath: string) => Promise<ImportResult>;
  onTransferProgress?: (
    cb: (payload: TransferProgress) => void
  ) => () => void;
  onHistory?: (entry: TransferHistoryEntry) => void;
  /** i18n keys differ slightly for local copy vs SSH upload */
  importBusyKey?: string;
  importOkKey?: string;
  importFailKey?: string;
  downloadBusyKey?: string;
  downloadOkKey?: string;
  downloadFailKey?: string;
};

function hasFilePayload(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  if (dt.files && dt.files.length > 0) return true;
  return Array.from(dt.types || []).some(
    (t) => t === "Files" || t === "public.file-url" || t === "text/uri-list"
  );
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatSize(n?: number): string {
  if (n == null || !Number.isFinite(n)) return "";
  if (n < 1000) return `${n} B`;
  if (n < 1000 * 1000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} KB`;
  if (n < 1000 * 1000 * 1000)
    return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)} MB`;
  return `${(n / 1_000_000_000).toFixed(1)} GB`;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

function pathBasename(p: string): string {
  const cleaned = normalizePath(p).replace(/\/+$/, "");
  const i = cleaned.lastIndexOf("/");
  return i >= 0 ? cleaned.slice(i + 1) : cleaned;
}

function pathDirname(p: string): string {
  const cleaned = normalizePath(p).replace(/\/+$/, "");
  if (!cleaned || cleaned === "/") return "/";
  // Windows drive root: C: or C:/
  if (/^[A-Za-z]:$/.test(cleaned)) return cleaned + "/";
  const i = cleaned.lastIndexOf("/");
  if (i < 0) return "/";
  if (i === 0) return "/";
  const parent = cleaned.slice(0, i);
  if (/^[A-Za-z]:$/.test(parent)) return parent + "/";
  return parent || "/";
}

function canGoUp(p: string, home?: string): boolean {
  const cur = normalizePath(p).replace(/\/+$/, "") || "/";
  if (cur === "/" || /^[A-Za-z]:$/.test(cur)) return false;
  const parent = pathDirname(cur);
  const parentNorm = normalizePath(parent).replace(/\/+$/, "") || "/";
  if (parentNorm === cur) return false;
  // Optional: stop at home as soft root? No — allow above home.
  void home;
  return true;
}

type PathCrumb = { label: string; path: string; current: boolean };

function buildBreadcrumbs(absPath: string, home?: string): PathCrumb[] {
  const raw = normalizePath(absPath);
  const cleaned = raw.replace(/\/+$/, "") || "/";
  const h = home ? normalizePath(home).replace(/\/+$/, "") : "";

  const crumbs: PathCrumb[] = [];
  if (h && (cleaned === h || cleaned.startsWith(h + "/"))) {
    crumbs.push({ label: "~", path: h, current: cleaned === h });
    if (cleaned !== h) {
      const rest = cleaned.slice(h.length + 1).split("/").filter(Boolean);
      let acc = h;
      rest.forEach((seg, i) => {
        acc = `${acc}/${seg}`;
        crumbs.push({
          label: seg,
          path: acc,
          current: i === rest.length - 1,
        });
      });
    }
    return crumbs;
  }

  if (/^[A-Za-z]:/.test(cleaned)) {
    const drive = cleaned.slice(0, 2);
    const drivePath = `${drive}/`;
    crumbs.push({
      label: drive,
      path: drivePath,
      current: cleaned === drive || cleaned === drivePath.replace(/\/$/, ""),
    });
    const rest = cleaned.slice(2).replace(/^\//, "").split("/").filter(Boolean);
    let acc = drive;
    rest.forEach((seg, i) => {
      acc = `${acc}/${seg}`;
      crumbs.push({
        label: seg,
        path: acc,
        current: i === rest.length - 1,
      });
    });
    return crumbs;
  }

  crumbs.push({ label: "/", path: "/", current: cleaned === "/" });
  if (cleaned !== "/") {
    const rest = cleaned.replace(/^\//, "").split("/").filter(Boolean);
    let acc = "";
    rest.forEach((seg, i) => {
      acc = `${acc}/${seg}`;
      crumbs.push({
        label: seg,
        path: acc,
        current: i === rest.length - 1,
      });
    });
  }
  return crumbs;
}

function pathJoin(parent: string, name: string): string {
  if (!parent || parent === "/") return `/${name}`.replace(/\/{2,}/g, "/");
  return `${parent.replace(/\/+$/, "")}/${name}`;
}

function newTransferId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `xfer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

let sharedMenu: HTMLElement | null = null;
let sharedDialog: HTMLElement | null = null;

function hideFsMenu(): void {
  sharedMenu?.classList.add("hidden");
}

function ensureFsMenu(): HTMLElement {
  if (sharedMenu?.isConnected) return sharedMenu;
  sharedMenu = document.createElement("div");
  sharedMenu.className = "fs-menu hidden";
  sharedMenu.setAttribute("role", "menu");
  document.body.append(sharedMenu);
  document.addEventListener("click", () => hideFsMenu());
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") hideFsMenu();
    },
    true
  );
  return sharedMenu;
}

function ensureFsDialog(): HTMLElement {
  if (sharedDialog?.isConnected) return sharedDialog;
  sharedDialog = document.createElement("div");
  sharedDialog.className = "fs-dialog-backdrop hidden";
  sharedDialog.innerHTML = `
    <div class="fs-dialog" role="dialog" aria-modal="true">
      <div class="fs-dialog-title"></div>
      <p class="fs-dialog-body hidden"></p>
      <input class="fs-dialog-input hidden" type="text" autocomplete="off" spellcheck="false" />
      <div class="fs-dialog-actions">
        <button type="button" class="fs-dialog-cancel"></button>
        <button type="button" class="fs-dialog-ok primary"></button>
      </div>
    </div>
  `;
  document.body.append(sharedDialog);
  return sharedDialog;
}

function closeFsDialog(): void {
  sharedDialog?.classList.add("hidden");
}

/** Electron blocks window.prompt / window.confirm — use an in-app dialog. */
function askFsText(opts: {
  title: string;
  initial: string;
  okLabel: string;
  cancelLabel: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const root = ensureFsDialog();
    const titleEl = root.querySelector(".fs-dialog-title") as HTMLElement;
    const bodyEl = root.querySelector(".fs-dialog-body") as HTMLElement;
    const input = root.querySelector(".fs-dialog-input") as HTMLInputElement;
    const cancelBtn = root.querySelector(
      ".fs-dialog-cancel"
    ) as HTMLButtonElement;
    const okBtn = root.querySelector(".fs-dialog-ok") as HTMLButtonElement;
    titleEl.textContent = opts.title;
    bodyEl.classList.add("hidden");
    bodyEl.textContent = "";
    input.classList.remove("hidden");
    input.value = opts.initial;
    cancelBtn.textContent = opts.cancelLabel;
    okBtn.textContent = opts.okLabel;
    okBtn.classList.add("primary");
    okBtn.classList.remove("danger");
    root.classList.remove("hidden");

    const finish = (value: string | null) => {
      cancelBtn.onclick = null;
      okBtn.onclick = null;
      input.onkeydown = null;
      root.onclick = null;
      closeFsDialog();
      resolve(value);
    };

    cancelBtn.onclick = () => finish(null);
    okBtn.onclick = () => finish(input.value);
    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(input.value);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
      }
    };
    root.onclick = (e) => {
      if (e.target === root) finish(null);
    };
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  });
}

function askFsConfirm(opts: {
  title: string;
  body: string;
  okLabel: string;
  cancelLabel: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const root = ensureFsDialog();
    const titleEl = root.querySelector(".fs-dialog-title") as HTMLElement;
    const bodyEl = root.querySelector(".fs-dialog-body") as HTMLElement;
    const input = root.querySelector(".fs-dialog-input") as HTMLInputElement;
    const cancelBtn = root.querySelector(
      ".fs-dialog-cancel"
    ) as HTMLButtonElement;
    const okBtn = root.querySelector(".fs-dialog-ok") as HTMLButtonElement;
    titleEl.textContent = opts.title;
    bodyEl.classList.remove("hidden");
    bodyEl.textContent = opts.body;
    input.classList.add("hidden");
    cancelBtn.textContent = opts.cancelLabel;
    okBtn.textContent = opts.okLabel;
    okBtn.classList.toggle("danger", Boolean(opts.danger));
    okBtn.classList.toggle("primary", !opts.danger);
    root.classList.remove("hidden");

    const finish = (value: boolean) => {
      cancelBtn.onclick = null;
      okBtn.onclick = null;
      root.onclick = null;
      closeFsDialog();
      resolve(value);
    };

    cancelBtn.onclick = () => finish(false);
    okBtn.onclick = () => finish(true);
    root.onclick = (e) => {
      if (e.target === root) finish(false);
    };
    requestAnimationFrame(() => okBtn.focus());
  });
}

type PaneApi = {
  setEnabled: (on: boolean, message?: string) => void;
  setMeta: (label: string) => void;
  setRoot: (rootPath: string) => Promise<void>;
  refresh: () => Promise<void>;
  rootPath: () => string;
};

function collapseStorageKey(scope: PaneScope): string {
  return `drift.files.collapsed.${scope}`;
}

const SHOW_HIDDEN_KEY = "drift.files.showHidden";
const showHiddenListeners = new Set<() => void>();

function readShowHidden(): boolean {
  try {
    return localStorage.getItem(SHOW_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

let showHidden = readShowHidden();

function setShowHidden(on: boolean): void {
  showHidden = on;
  try {
    localStorage.setItem(SHOW_HIDDEN_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
  for (const fn of showHiddenListeners) fn();
}

function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}

function createPane(
  root: HTMLElement,
  scope: PaneScope,
  opts: PaneCallbacks
): PaneApi {
  const headBtn = root.querySelector(
    "[data-collapse-toggle]"
  ) as HTMLButtonElement | null;
  const titleEl = root.querySelector(".files-pane-title") as HTMLElement;
  const hostEl = root.querySelector(".files-pane-host") as HTMLElement;
  const pathEl = root.querySelector(".files-path") as HTMLElement;
  const upBtn = root.querySelector("[data-path-up]") as HTMLButtonElement | null;
  const filterEl = root.querySelector(".files-filter") as HTMLInputElement;
  const treeEl = root.querySelector(".files-tree") as HTMLElement;
  const emptyEl = root.querySelector(".files-empty") as HTMLElement;
  const refreshBtn = root.querySelector("[data-refresh]") as HTMLButtonElement | null;
  const showHiddenBtn = root.querySelector(
    "[data-show-hidden]"
  ) as HTMLButtonElement | null;

  const bodyEl = root.querySelector(".files-pane-body") as HTMLElement | null;
  const expanded = new Set<string>();
  const cache = new Map<string, FsEntry[]>();
  const errors = new Map<string, string>();
  let home = "";
  let rootPath = "";
  let filter = "";
  let enabled = true;
  let emptyMessage = "";
  let metaLabel = "";
  let dragDepth = 0;
  let importing = false;

  const busyKey = opts.importBusyKey ?? "files.dropping";
  const okKey = opts.importOkKey ?? "files.dropOk";
  const failKey = opts.importFailKey ?? "files.dropFail";

  const transferEl = document.createElement("div");
  transferEl.className = "files-transfer hidden";
  transferEl.innerHTML = `
    <div class="files-transfer-meta">
      <span class="files-transfer-label"></span>
    </div>
    <div class="files-transfer-bar" aria-hidden="true">
      <div class="files-transfer-fill"></div>
    </div>
  `;
  const transferLabel = transferEl.querySelector(
    ".files-transfer-label"
  ) as HTMLElement;
  const transferFill = transferEl.querySelector(
    ".files-transfer-fill"
  ) as HTMLElement;
  const toolbarEl = root.querySelector(".files-toolbar");
  if (toolbarEl?.parentElement) {
    toolbarEl.insertAdjacentElement("afterend", transferEl);
  }

  function restoreHostMeta(): void {
    hostEl.textContent = metaLabel;
    hostEl.title = metaLabel;
    hostEl.classList.remove("is-status");
  }

  function showTransferProgress(p: {
    percent: number;
    currentName?: string;
  }): void {
    const pct = Math.max(0, Math.min(100, Math.round(p.percent)));
    transferEl.classList.remove("hidden");
    transferFill.style.width = `${pct}%`;
    const label = p.currentName
      ? t("files.progressNamed", { percent: String(pct), name: p.currentName })
      : t("files.progress", { percent: String(pct) });
    transferLabel.textContent = label;
  }

  function hideTransferProgress(): void {
    transferEl.classList.add("hidden");
    transferFill.style.width = "0%";
    transferLabel.textContent = "";
    restoreHostMeta();
  }

  function clearDirDropTargets(): void {
    root
      .querySelectorAll(".fs-row.drop-target")
      .forEach((el) => el.classList.remove("drop-target"));
  }

  function clearPaneDrop(): void {
    dragDepth = 0;
    bodyEl?.classList.remove("drop-target");
    clearDirDropTargets();
  }

  function destFromPoint(clientX: number, clientY: number): string | null {
    const hit = document.elementFromPoint(clientX, clientY);
    const row = hit?.closest?.(
      '.fs-row[data-kind="dir"]'
    ) as HTMLElement | null;
    if (row?.dataset.path) return row.dataset.path;
    return rootPath || null;
  }

  function applyCollapsed(on: boolean): void {
    root.classList.toggle("collapsed", on);
    if (headBtn) {
      headBtn.title = on ? t("files.expand") : t("files.collapse");
      headBtn.setAttribute("aria-expanded", on ? "false" : "true");
    }
    try {
      localStorage.setItem(collapseStorageKey(scope), on ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  try {
    if (localStorage.getItem(collapseStorageKey(scope)) === "1") {
      applyCollapsed(true);
    }
  } catch {
    /* ignore */
  }

  headBtn?.addEventListener("click", () => {
    applyCollapsed(!root.classList.contains("collapsed"));
  });

  function goToDir(next: string): void {
    if (!next || next === rootPath || !enabled) return;
    rootPath = next;
    void opts.onOpenDir(rootPath);
    void render();
  }

  function renderPathBar(): void {
    pathEl.setAttribute("aria-label", t("files.breadcrumb"));
    pathEl.title = rootPath || "";
    if (!rootPath) {
      pathEl.innerHTML = "";
      if (upBtn) upBtn.disabled = true;
      return;
    }
    const crumbs = buildBreadcrumbs(rootPath, home || undefined);
    pathEl.innerHTML = crumbs
      .map((c, i) => {
        const sep =
          i === 0
            ? ""
            : `<span class="files-crumb-sep" aria-hidden="true">${icons.chevronRight(10)}</span>`;
        if (c.current) {
          return `${sep}<span class="files-crumb is-current" title="${escapeHtml(c.path)}">${escapeHtml(c.label)}</span>`;
        }
        return `${sep}<button type="button" class="files-crumb" data-crumb-path="${escapeHtml(c.path)}" title="${escapeHtml(c.path)}">${escapeHtml(c.label)}</button>`;
      })
      .join("");
    if (upBtn) {
      const enabledUp = canGoUp(rootPath, home || undefined);
      upBtn.disabled = !enabledUp;
      upBtn.title = t("files.up");
      upBtn.setAttribute("aria-label", t("files.up"));
    }
    // Keep the current (rightmost) crumb visible when the trail overflows.
    requestAnimationFrame(() => {
      pathEl.scrollLeft = pathEl.scrollWidth;
    });
  }

  function showEmpty(msg: string): void {
    emptyEl.textContent = msg;
    emptyEl.classList.remove("hidden");
    treeEl.classList.add("hidden");
    pathEl.innerHTML = "";
    if (upBtn) upBtn.disabled = true;
  }

  function showTree(): void {
    emptyEl.classList.add("hidden");
    treeEl.classList.remove("hidden");
  }

  async function load(dir: string): Promise<FsEntry[]> {
    if (cache.has(dir)) return cache.get(dir)!;
    const res = await opts.listDir(dir);
    if (res.home) home = res.home;
    if (res.path && res.path !== dir) {
      // Remote ls may resolve to a canonical path.
    }
    if (res.error) {
      errors.set(dir, res.error);
      cache.set(dir, []);
      return [];
    }
    errors.delete(dir);
    cache.set(dir, res.entries);
    return res.entries;
  }

  function matchesFilter(name: string): boolean {
    if (!showHidden && isHiddenName(name)) return false;
    if (!filter) return true;
    return name.toLowerCase().includes(filter);
  }

  function syncShowHiddenBtn(): void {
    if (!showHiddenBtn) return;
    showHiddenBtn.setAttribute("aria-pressed", showHidden ? "true" : "false");
    showHiddenBtn.classList.toggle("is-on", showHidden);
    showHiddenBtn.title = showHidden
      ? t("files.hideHidden")
      : t("files.showHidden");
    showHiddenBtn.innerHTML = showHidden
      ? icons.eye(12)
      : icons.eyeOff(12);
  }

  syncShowHiddenBtn();
  const onShowHiddenChange = (): void => {
    syncShowHiddenBtn();
    void render();
  };
  showHiddenListeners.add(onShowHiddenChange);

  function rowHtml(entry: FsEntry, depth: number, open: boolean): string {
    const pad = 4 + depth * 12;
    const size =
      entry.kind === "file" ? formatSize(entry.size) : "";
    if (entry.kind === "dir") {
      return `
        <div class="fs-row" data-kind="dir" data-path="${escapeHtml(entry.path)}" style="padding-left:${pad}px">
          <button type="button" class="fs-twist" data-twist aria-label="Toggle">${open ? icons.chevronDown(11) : icons.chevronRight(11)}</button>
          <button type="button" class="fs-name" data-select-path>
            <span class="fs-ico">${open ? icons.folderOpen(13) : icons.folder(13)}</span>
            <span class="fs-label">${escapeHtml(entry.name)}</span>
          </button>
          <span class="fs-size"></span>
        </div>
        <div class="fs-children${open ? "" : " hidden"}" data-parent="${escapeHtml(entry.path)}"></div>
      `;
    }
    return `
      <div class="fs-row" data-kind="file" data-path="${escapeHtml(entry.path)}" style="padding-left:${pad + 16}px">
        <button type="button" class="fs-name" data-select-path>
          <span class="fs-ico">${icons.file(13)}</span>
          <span class="fs-label">${escapeHtml(entry.name)}</span>
        </button>
        <span class="fs-size">${escapeHtml(size)}</span>
      </div>
    `;
  }

  function childOf(container: HTMLElement, parentPath: string): HTMLElement | null {
    for (const el of container.children) {
      if (!(el instanceof HTMLElement)) continue;
      if (el.classList.contains("fs-children") && el.dataset.parent === parentPath) {
        return el;
      }
    }
    return null;
  }

  async function fill(container: HTMLElement, dir: string, depth: number): Promise<void> {
    const entries = (await load(dir)).filter((e) => matchesFilter(e.name));
    const err = errors.get(dir);
    if (err && entries.length === 0) {
      container.innerHTML = `<div class="fs-muted fs-error">${escapeHtml(err)}</div>`;
      return;
    }
    const parts: string[] = [];
    for (const e of entries) {
      const open = e.kind === "dir" && expanded.has(e.path);
      parts.push(rowHtml(e, depth, open));
    }
    container.innerHTML =
      parts.join("") ||
      `<div class="fs-muted">${filter ? "No matches" : "Empty"}</div>`;
    for (const e of entries) {
      if (e.kind !== "dir" || !expanded.has(e.path)) continue;
      const child = childOf(container, e.path);
      if (child) await fill(child, e.path, depth + 1);
    }
  }

  async function render(focusPath?: string): Promise<void> {
    if (!enabled) {
      showEmpty(emptyMessage || "Unavailable");
      return;
    }
    if (!rootPath) {
      showEmpty(emptyMessage || "…");
      return;
    }
    showTree();
    renderPathBar();
    const top = treeEl.scrollTop;
    treeEl.innerHTML = `<div class="fs-children" data-parent="${escapeHtml(rootPath)}"></div>`;
    const child = childOf(treeEl, rootPath);
    if (child) await fill(child, rootPath, 0);
    treeEl.scrollTop = top;
    if (focusPath) {
      treeEl.querySelectorAll(".fs-row.active").forEach((el) => el.classList.remove("active"));
      for (const el of treeEl.querySelectorAll(".fs-row")) {
        if (el instanceof HTMLElement && el.dataset.path === focusPath) {
          el.classList.add("active");
          break;
        }
      }
    }
  }

  function selectRow(path: string): void {
    treeEl.querySelectorAll(".fs-row.active").forEach((el) => el.classList.remove("active"));
    for (const el of treeEl.querySelectorAll(".fs-row")) {
      if (el instanceof HTMLElement && el.dataset.path === path) {
        el.classList.add("active");
        break;
      }
    }
  }

  treeEl.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const twist = target.closest("[data-twist]") as HTMLElement | null;
    const select = target.closest("[data-select-path]") as HTMLElement | null;

    if (twist) {
      e.preventDefault();
      e.stopPropagation();
      const row = twist.closest(".fs-row") as HTMLElement | null;
      const p = row?.dataset.path;
      if (!p) return;
      if (expanded.has(p)) expanded.delete(p);
      else expanded.add(p);
      void render(p);
      return;
    }

    if (select) {
      e.preventDefault();
      const row = select.closest("[data-path]") as HTMLElement | null;
      const p = row?.dataset.path;
      if (!p) return;
      selectRow(p);
    }
  });

  treeEl.addEventListener("dblclick", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-twist]")) return;
    const select = target.closest("[data-select-path]") as HTMLElement | null;
    const row = (select?.closest("[data-path]") ||
      target.closest(".fs-row[data-path]")) as HTMLElement | null;
    const p = row?.dataset.path;
    const kind = row?.dataset.kind;
    if (!p || !kind) return;
    e.preventDefault();
    selectRow(p);
    if (kind === "dir") {
      expanded.add(p);
      void opts.onOpenDir(p);
      void render(p);
      return;
    }
    if (opts.onOpenFile) {
      void opts.onOpenFile(p);
    } else {
      void opts.onInsertPath(p);
    }
  });

  treeEl.addEventListener("contextmenu", (e) => {
    if (!enabled || importing) return;
    const row = (e.target as HTMLElement).closest(
      ".fs-row[data-path]"
    ) as HTMLElement | null;
    if (!row?.dataset.path) return;
    e.preventDefault();
    e.stopPropagation();
    const targetPath = row.dataset.path;
    const kind = (row.dataset.kind as "file" | "dir") || "file";
    const name = pathBasename(targetPath);
    const menu = ensureFsMenu();
    const items: Array<{
      id: string;
      label: string;
      danger?: boolean;
      disabled?: boolean;
    }> = [];
    items.push({ id: "insert", label: t("files.insertPath") });
    if (kind === "file" && opts.onOpenFile) {
      items.push({ id: "open", label: t("files.openEditor") });
    }
    if (opts.onDownloadPaths) {
      items.push({ id: "download", label: t("files.download") });
    }
    if (opts.onRenamePath) {
      items.push({ id: "rename", label: t("files.rename") });
    }
    items.push({ id: "copy", label: t("files.copyPath") });
    if (opts.onDeletePath) {
      items.push({ id: "delete", label: t("files.delete"), danger: true });
    }
    if (!items.length) return;
    menu.innerHTML = items
      .map(
        (it) =>
          `<button type="button" class="fs-menu-item${it.danger ? " danger" : ""}" data-action="${it.id}" role="menuitem">${escapeHtml(it.label)}</button>`
      )
      .join("");
    menu.classList.remove("hidden");
    const pad = 8;
    const rect = menu.getBoundingClientRect();
    const w = rect.width || 160;
    const h = rect.height || items.length * 32;
    let left = e.clientX;
    let top = e.clientY;
    if (left + w > window.innerWidth - pad) left = window.innerWidth - w - pad;
    if (top + h > window.innerHeight - pad) top = window.innerHeight - h - pad;
    menu.style.left = `${Math.max(pad, left)}px`;
    menu.style.top = `${Math.max(pad, top)}px`;

    menu.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((btn) => {
      btn.onclick = (ev) => {
        ev.stopPropagation();
        hideFsMenu();
        const action = btn.dataset.action;
        if (action === "insert") {
          void opts.onInsertPath(targetPath);
          return;
        }
        if (action === "open" && opts.onOpenFile) {
          void opts.onOpenFile(targetPath);
          return;
        }
        if (action === "copy") {
          void navigator.clipboard?.writeText(targetPath).then(
            () => showToast(t("files.pathCopied"), "ok"),
            () => showToast(t("files.pathCopyFail"), "error")
          );
          return;
        }
        if (action === "rename" && opts.onRenamePath) {
          void askFsText({
            title: t("files.rename"),
            initial: name,
            okLabel: t("files.rename"),
            cancelLabel: t("files.dialogCancel"),
          }).then((next) => {
            if (next == null) return;
            const trimmed = next.trim();
            if (!trimmed || trimmed === name) return;
            if (trimmed.includes("/") || trimmed.includes("\\")) {
              showToast(t("files.renameInvalid"), "error");
              return;
            }
            const toPath = pathJoin(pathDirname(targetPath), trimmed);
            void opts.onRenamePath!(targetPath, toPath).then(async (res) => {
              if (res && "error" in res && res.error) {
                showToast(t("files.renameFail"), "error", {
                  detail: res.error,
                });
                opts.onHistory?.({
                  id: newTransferId(),
                  at: Date.now(),
                  direction: "rename",
                  name,
                  ok: false,
                  detail: res.error,
                });
                return;
              }
              showToast(t("files.renameOk"), "ok");
              opts.onHistory?.({
                id: newTransferId(),
                at: Date.now(),
                direction: "rename",
                name: `${name} → ${trimmed}`,
                ok: true,
              });
              cache.clear();
              errors.clear();
              await render(toPath);
            });
          });
          return;
        }
        if (action === "delete" && opts.onDeletePath) {
          void askFsConfirm({
            title: t("files.delete"),
            body: t("files.deleteConfirm", {
              name,
              kind: kind === "dir" ? t("files.kindDir") : t("files.kindFile"),
            }),
            okLabel: t("files.delete"),
            cancelLabel: t("files.dialogCancel"),
            danger: true,
          }).then((ok) => {
            if (!ok) return;
            void opts.onDeletePath!(targetPath).then(async (res) => {
              if (res && "error" in res && res.error) {
                showToast(t("files.deleteFail"), "error", {
                  detail: res.error,
                });
                opts.onHistory?.({
                  id: newTransferId(),
                  at: Date.now(),
                  direction: "delete",
                  name,
                  ok: false,
                  detail: res.error,
                });
                return;
              }
              showToast(t("files.deleteOk"), "ok");
              opts.onHistory?.({
                id: newTransferId(),
                at: Date.now(),
                direction: "delete",
                name,
                ok: true,
              });
              cache.clear();
              errors.clear();
              await render();
            });
          });
          return;
        }
        if (action === "download" && opts.onDownloadPaths) {
          const transferId = newTransferId();
          importing = true;
          showTransferProgress({
            percent: 0,
            currentName: t(opts.downloadBusyKey ?? "files.downloading"),
          });
          const stopProgress = opts.onTransferProgress?.((payload) => {
            if (payload.transferId !== transferId) return;
            showTransferProgress({
              percent: payload.percent,
              currentName: payload.currentName,
            });
          });
          void opts
            .onDownloadPaths([targetPath], transferId)
            .then(async (res) => {
              if (res && "error" in res && res.error) {
                hideTransferProgress();
                showToast(t(opts.downloadFailKey ?? "files.downloadFail"), "error", {
                  detail: res.error,
                });
                opts.onHistory?.({
                  id: transferId,
                  at: Date.now(),
                  direction: "download",
                  name,
                  ok: false,
                  detail: res.error,
                });
                return;
              }
              showTransferProgress({ percent: 100 });
              showToast(t(opts.downloadOkKey ?? "files.downloadOk"), "ok");
              opts.onHistory?.({
                id: transferId,
                at: Date.now(),
                direction: "download",
                name,
                ok: true,
              });
              window.setTimeout(() => hideTransferProgress(), 500);
            })
            .catch((err: unknown) => {
              hideTransferProgress();
              const detail = err instanceof Error ? err.message : String(err);
              showToast(t(opts.downloadFailKey ?? "files.downloadFail"), "error", {
                detail,
              });
              opts.onHistory?.({
                id: transferId,
                at: Date.now(),
                direction: "download",
                name,
                ok: false,
                detail,
              });
            })
            .finally(() => {
              stopProgress?.();
              importing = false;
            });
        }
      };
    });
  });

  filterEl.addEventListener("input", () => {
    filter = filterEl.value.trim().toLowerCase();
    void render();
  });

  showHiddenBtn?.addEventListener("click", () => {
    setShowHidden(!showHidden);
  });

  refreshBtn?.addEventListener("click", () => {
    void api.refresh();
  });

  pathEl.addEventListener("click", (e) => {
    if (!rootPath || !enabled) return;
    const crumb = (e.target as HTMLElement).closest(
      "[data-crumb-path]"
    ) as HTMLElement | null;
    const next = crumb?.dataset.crumbPath;
    if (!next) return;
    goToDir(next);
  });

  upBtn?.addEventListener("click", () => {
    if (!rootPath || !enabled || upBtn.disabled) return;
    const parent = pathDirname(rootPath);
    if (parent && parent !== rootPath) goToDir(parent);
  });

  if (bodyEl && opts.onImportFiles && opts.resolveDropPaths) {
    bodyEl.dataset.dropHint = t("files.dropHint");

    bodyEl.addEventListener("dragenter", (e) => {
      if (!enabled || importing || !hasFilePayload(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      bodyEl.dataset.dropHint = t("files.dropHint");
      dragDepth += 1;
      bodyEl.classList.add("drop-target");
    });

    bodyEl.addEventListener("dragleave", (e) => {
      if (!enabled) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) {
        bodyEl.classList.remove("drop-target");
        clearDirDropTargets();
      }
    });

    bodyEl.addEventListener("dragover", (e) => {
      if (!enabled || importing || !hasFilePayload(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      clearDirDropTargets();
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const row = hit?.closest?.(
        '.fs-row[data-kind="dir"]'
      ) as HTMLElement | null;
      row?.classList.add("drop-target");
    });

    bodyEl.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const dt = e.dataTransfer;
      clearPaneDrop();
      if (!enabled || importing || !dt || !opts.onImportFiles || !opts.resolveDropPaths) {
        return;
      }
      const dest = destFromPoint(e.clientX, e.clientY);
      if (!dest) return;
      const sources = opts.resolveDropPaths(Array.from(dt.files || []));
      if (!sources.length) {
        showToast(t("files.dropNoPath"), "error");
        return;
      }
      importing = true;
      const transferId = newTransferId();
      const labelName =
        sources.length === 1
          ? pathBasename(sources[0]!)
          : t("files.manyItems", { count: String(sources.length) });
      const direction = scope === "server" ? "upload" : "copy";
      showTransferProgress({ percent: 0, currentName: t(busyKey) });
      const stopProgress = opts.onTransferProgress?.((payload) => {
        if (payload.transferId !== transferId) return;
        showTransferProgress({
          percent: payload.percent,
          currentName: payload.currentName,
        });
      });
      void opts
        .onImportFiles(dest, sources, transferId)
        .then(async (res) => {
          if (res && "error" in res && res.error) {
            hideTransferProgress();
            showToast(t(failKey), "error", { detail: res.error });
            opts.onHistory?.({
              id: transferId,
              at: Date.now(),
              direction,
              name: labelName,
              ok: false,
              detail: res.error,
            });
            return;
          }
          showTransferProgress({ percent: 100 });
          showToast(t(okKey), "ok");
          opts.onHistory?.({
            id: transferId,
            at: Date.now(),
            direction,
            name: labelName,
            ok: true,
          });
          window.setTimeout(() => hideTransferProgress(), 500);
          cache.clear();
          await api.refresh();
        })
        .catch((err: unknown) => {
          hideTransferProgress();
          const detail = err instanceof Error ? err.message : String(err);
          showToast(t(failKey), "error", { detail });
          opts.onHistory?.({
            id: transferId,
            at: Date.now(),
            direction,
            name: labelName,
            ok: false,
            detail,
          });
        })
        .finally(() => {
          stopProgress?.();
          importing = false;
        });
    });
  }

  const api: PaneApi = {
    setEnabled(on, message) {
      enabled = on;
      emptyMessage = message ?? "";
      root.classList.toggle("disabled", !on);
      if (!on) {
        clearPaneDrop();
        showEmpty(emptyMessage);
        return;
      }
      // Re-show the tree after coming back from the disabled empty state
      // (e.g. local tab → SSH tab) without waiting for a manual refresh.
      if (rootPath) void render();
    },
    setMeta(label) {
      metaLabel = label;
      restoreHostMeta();
      titleEl.dataset.scope = scope;
    },
    async setRoot(next) {
      if (!next) return;
      if (rootPath === next && cache.has(next) && !errors.has(next)) {
        // Same path — still re-render so a prior showEmpty() is cleared.
        await render();
        return;
      }
      rootPath = next;
      expanded.clear();
      expanded.add(next);
      cache.clear();
      errors.clear();
      const res = await opts.listDir(next);
      if (res.home) home = res.home;
      if (res.error) errors.set(res.path || next, res.error);
      else cache.set(res.path || next, res.entries);
      rootPath = res.path || next;
      if (res.path && res.path !== next) {
        cache.set(next, res.entries);
        if (res.error) errors.set(next, res.error);
      }
      await render();
    },
    async refresh() {
      cache.clear();
      errors.clear();
      await render();
    },
    rootPath: () => rootPath,
  };

  return api;
}

export type FilesBrowser = {
  refresh: () => Promise<void>;
  setLocalRoot: (path: string) => Promise<void>;
  localRootPath: () => string;
  setServer: (opts: {
    enabled: boolean;
    label?: string;
    rootPath?: string;
    message?: string;
  }) => Promise<void>;
};

export function createFilesBrowser(opts: {
  root: HTMLElement;
  listLocal: ListDir;
  listServer: ListDir;
  onLocalOpenDir: (dirPath: string) => void | Promise<void>;
  onLocalInsertPath: (filePath: string) => void | Promise<void>;
  onLocalOpenFile?: (filePath: string) => void | Promise<void>;
  onServerOpenDir: (dirPath: string) => void | Promise<void>;
  onServerInsertPath: (filePath: string) => void | Promise<void>;
  onServerOpenFile?: (filePath: string) => void | Promise<void>;
  resolveDropPaths?: (files: File[]) => string[];
  onLocalImport?: (
    destDir: string,
    sources: string[],
    transferId: string
  ) => Promise<ImportResult>;
  onServerImport?: (
    destDir: string,
    sources: string[],
    transferId: string
  ) => Promise<ImportResult>;
  onServerDownload?: (
    sources: string[],
    destDir: string,
    transferId: string
  ) => Promise<ImportResult>;
  onLocalRename?: (
    fromPath: string,
    toPath: string
  ) => Promise<ImportResult>;
  onLocalDelete?: (targetPath: string) => Promise<ImportResult>;
  onServerRename?: (
    fromPath: string,
    toPath: string
  ) => Promise<ImportResult>;
  onServerDelete?: (targetPath: string) => Promise<ImportResult>;
  onTransferProgress?: (
    cb: (payload: TransferProgress) => void
  ) => () => void;
}): FilesBrowser {
  const localRoot = opts.root.querySelector(
    '[data-scope="local"]'
  ) as HTMLElement;
  const serverRoot = opts.root.querySelector(
    '[data-scope="server"]'
  ) as HTMLElement;

  const history: TransferHistoryEntry[] = [];
  const historyEl = document.createElement("div");
  historyEl.className = "files-history hidden";
  historyEl.innerHTML = `
    <div class="files-history-head">
      <span data-i18n="files.history">${escapeHtml(t("files.history"))}</span>
    </div>
    <ul class="files-history-list"></ul>
  `;
  opts.root.append(historyEl);
  const historyList = historyEl.querySelector(
    ".files-history-list"
  ) as HTMLElement;

  function pushHistory(entry: TransferHistoryEntry): void {
    history.unshift(entry);
    if (history.length > 8) history.length = 8;
    historyEl.classList.toggle("hidden", history.length === 0);
    historyList.innerHTML = history
      .map((h) => {
        const when = new Date(h.at).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
        const dirLabel = t(`files.history.${h.direction}`);
        return `<li class="${h.ok ? "ok" : "fail"}"><span class="files-history-dir">${escapeHtml(dirLabel)}</span><span class="files-history-name">${escapeHtml(h.name)}</span><span class="files-history-time">${escapeHtml(when)}</span></li>`;
      })
      .join("");
  }

  const local = createPane(localRoot, "local", {
    listDir: opts.listLocal,
    onOpenDir: opts.onLocalOpenDir,
    onInsertPath: opts.onLocalInsertPath,
    onOpenFile: opts.onLocalOpenFile,
    resolveDropPaths: opts.resolveDropPaths,
    onImportFiles: opts.onLocalImport,
    onRenamePath: opts.onLocalRename,
    onDeletePath: opts.onLocalDelete,
    onTransferProgress: opts.onTransferProgress,
    onHistory: pushHistory,
    importBusyKey: "files.dropping",
    importOkKey: "files.dropOk",
    importFailKey: "files.dropFail",
  });
  const server = createPane(serverRoot, "server", {
    listDir: opts.listServer,
    onOpenDir: opts.onServerOpenDir,
    onInsertPath: opts.onServerInsertPath,
    onOpenFile: opts.onServerOpenFile,
    resolveDropPaths: opts.resolveDropPaths,
    onImportFiles: opts.onServerImport,
    onDownloadPaths: opts.onServerDownload
      ? async (sources, transferId) => {
          const dest = local.rootPath();
          if (!dest) return { error: t("files.noLocalDest") };
          const res = await opts.onServerDownload!(sources, dest, transferId);
          if (!(res && "error" in res && res.error)) {
            await local.refresh();
          }
          return res;
        }
      : undefined,
    onRenamePath: opts.onServerRename,
    onDeletePath: opts.onServerDelete,
    onTransferProgress: opts.onTransferProgress,
    onHistory: pushHistory,
    importBusyKey: "files.uploading",
    importOkKey: "files.uploadOk",
    importFailKey: "files.uploadFail",
    downloadBusyKey: "files.downloading",
    downloadOkKey: "files.downloadOk",
    downloadFailKey: "files.downloadFail",
  });

  return {
    refresh: async () => {
      await Promise.all([local.refresh(), server.refresh()]);
    },
    setLocalRoot: (path) => local.setRoot(path),
    localRootPath: () => local.rootPath(),
    setServer: async ({ enabled, label, rootPath, message }) => {
      if (label != null) server.setMeta(label);
      opts.root.classList.toggle("has-server", enabled);
      if (!enabled) {
        server.setEnabled(false, message ?? "Connect an SSH session to browse the server");
        return;
      }
      server.setEnabled(true);
      if (rootPath) {
        await server.setRoot(rootPath);
      } else {
        // Keep previous root if any; just leave the disabled empty state.
        await server.refresh();
      }
    },
  };
}
