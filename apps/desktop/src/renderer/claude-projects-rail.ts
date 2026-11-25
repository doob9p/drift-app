/**
 * Sessions sidebar: Claude projects / worktrees rail + import popover.
 */
import { icons } from "./icons.js";
import { t } from "./i18n.js";
import { askFsConfirm } from "./files-tree.js";

export type ProjectFolder = {
  path: string;
  branch?: string;
  worktreeOf?: string;
  changes?: number;
  ahead?: number;
  behind?: number;
  trusted?: boolean;
};

export type BoardClaudeRef = {
  cardId: string;
  tabId: string;
  cwd: string;
  title: string;
  sessionId: string;
  agentStatus?: string;
};

export type ClaudeTranscriptRow = {
  id: string;
  cwd: string;
  title: string;
  at: number;
  onBoard: boolean;
};

export type ProjectsRailApi = {
  listClaudeProjects: (input?: {
    extraCwds?: string[];
  }) => Promise<{ folders: ProjectFolder[] }>;
  listClaudeTranscripts: () => Promise<{ sessions: ClaudeTranscriptRow[] }>;
  deleteClaudeTranscript: (
    sessionId: string
  ) => Promise<{ ok: true; path: string } | { error: string }>;
  listGitBranches: (
    repo: string
  ) => Promise<{ branches: string[]; current: string | null }>;
  previewWorktree: (input: {
    repo: string;
    branch: string;
  }) => Promise<{ path: string } | { error: string }>;
  addWorktree: (input: {
    repo: string;
    branch: string;
    baseRef?: string;
  }) => Promise<{ path: string } | { error: string }>;
  removeWorktree: (
    worktreePath: string
  ) => Promise<{ ok: true } | { error: string }>;
  resolveGitRoot: (cwd: string) => Promise<{ root: string | null }>;
};

export type ProjectsRailHandlers = {
  getBoardClaudeCards: () => BoardClaudeRef[];
  openClaudeAt: (cwd: string, opts?: { title?: string }) => void | Promise<void>;
  focusClaudeCard: (cardId: string) => void;
  openClaudeResume: (input: {
    cwd: string;
    sessionId: string;
    title: string;
  }) => void | Promise<void>;
  pickDirectory: () => Promise<string | null>;
  showToast: (
    message: string,
    kind?: "info" | "ok" | "error",
    opts?: { detail?: string; ms?: number }
  ) => void;
  onActiveCwdChange?: (cwd: string | null) => void;
};

function basenamePath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
}

function agoLabel(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return t("projects.ago.justNow");
  if (min < 60) return t("projects.ago.minutes", { n: String(min) });
  if (min < 1440)
    return t("projects.ago.hours", { n: String(Math.round(min / 60)) });
  return t("projects.ago.days", { n: String(Math.round(min / 1440)) });
}

function statusRank(status: string | undefined): number {
  if (status === "waiting") return 3;
  if (status === "running") return 2;
  if (status === "done" || status === "error") return 1;
  return 0;
}

function aggregateStatus(cards: BoardClaudeRef[]): string | null {
  let best: string | null = null;
  let bestRank = -1;
  for (const c of cards) {
    const r = statusRank(c.agentStatus);
    if (r > bestRank) {
      bestRank = r;
      best = c.agentStatus || "idle";
    }
  }
  return best;
}

export function createProjectsRail(
  api: ProjectsRailApi,
  handlers: ProjectsRailHandlers
) {
  const railEl = document.getElementById("claude-projects-rail");
  const formEl = document.getElementById("claude-wt-form") as HTMLFormElement | null;
  const importPop = document.getElementById("claude-import-pop");
  const importList = document.getElementById("claude-import-list");
  const importSearch = document.getElementById(
    "claude-import-search"
  ) as HTMLInputElement | null;

  let folders: ProjectFolder[] = [];
  let collapsed = new Set<string>();
  let activeCwd: string | null = null;
  let highlightCwd: string | null = null;
  let highlightTimer = 0;
  let wtRepo: string | null = null;
  let importRows: ClaudeTranscriptRow[] = [];
  let refreshTimer = 0;

  function setActiveCwd(cwd: string | null): void {
    activeCwd = cwd;
    handlers.onActiveCwdChange?.(cwd);
    render();
  }

  function getActiveCwd(): string | null {
    return activeCwd;
  }

  function cardsAt(p: string): BoardClaudeRef[] {
    return handlers.getBoardClaudeCards().filter((c) => samePath(c.cwd, p));
  }

  function scheduleRefresh(): void {
    if (refreshTimer) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = 0;
      void refresh();
    }, 200);
  }

  async function refresh(): Promise<void> {
    if (!railEl) return;
    const extra = handlers.getBoardClaudeCards().map((c) => c.cwd);
    try {
      const res = await api.listClaudeProjects({ extraCwds: extra });
      folders = res.folders || [];
    } catch {
      folders = [];
    }
    render();
  }

  function openWorktreeForm(repo: string): void {
    if (!formEl) return;
    wtRepo = repo;
    formEl.classList.remove("hidden");
    const repoLabel = formEl.querySelector("[data-wt-repo]") as HTMLElement | null;
    const errEl = formEl.querySelector("[data-wt-error]") as HTMLElement | null;
    const branchInput = formEl.querySelector(
      "[data-wt-branch]"
    ) as HTMLInputElement | null;
    const baseSelect = formEl.querySelector(
      "[data-wt-base]"
    ) as HTMLSelectElement | null;
    const previewEl = formEl.querySelector(
      "[data-wt-preview]"
    ) as HTMLElement | null;
    if (repoLabel) {
      repoLabel.textContent = t("projects.worktree.addTo", {
        name: basenamePath(repo),
      });
    }
    if (errEl) errEl.textContent = "";
    if (branchInput) branchInput.value = "";
    if (previewEl) previewEl.textContent = "";
    void (async () => {
      if (!baseSelect) return;
      baseSelect.replaceChildren();
      const headOpt = document.createElement("option");
      headOpt.value = "HEAD";
      headOpt.textContent = "HEAD";
      baseSelect.append(headOpt);
      const { branches, current } = await api.listGitBranches(repo);
      for (const b of branches) {
        const opt = document.createElement("option");
        opt.value = b;
        opt.textContent = b;
        if (current && b === current) opt.selected = true;
        baseSelect.append(opt);
      }
      if (!current) baseSelect.value = "HEAD";
    })();
    branchInput?.focus();
    void updatePreview();
  }

  function closeWorktreeForm(): void {
    wtRepo = null;
    formEl?.classList.add("hidden");
  }

  async function updatePreview(): Promise<void> {
    if (!formEl || !wtRepo) return;
    const branchInput = formEl.querySelector(
      "[data-wt-branch]"
    ) as HTMLInputElement | null;
    const previewEl = formEl.querySelector(
      "[data-wt-preview]"
    ) as HTMLElement | null;
    const branch = branchInput?.value.trim() || "";
    if (!previewEl) return;
    if (!branch) {
      previewEl.textContent = "";
      return;
    }
    const res = await api.previewWorktree({ repo: wtRepo, branch });
    if ("error" in res) {
      previewEl.textContent = res.error;
      previewEl.classList.add("is-error");
    } else {
      previewEl.textContent = res.path;
      previewEl.classList.remove("is-error");
    }
  }

  async function submitWorktree(e: Event): Promise<void> {
    e.preventDefault();
    if (!formEl || !wtRepo) return;
    const branchInput = formEl.querySelector(
      "[data-wt-branch]"
    ) as HTMLInputElement | null;
    const baseSelect = formEl.querySelector(
      "[data-wt-base]"
    ) as HTMLSelectElement | null;
    const errEl = formEl.querySelector("[data-wt-error]") as HTMLElement | null;
    const submitBtn = formEl.querySelector(
      "[data-wt-submit]"
    ) as HTMLButtonElement | null;
    const branch = branchInput?.value.trim() || "";
    if (!branch) return;
    if (errEl) errEl.textContent = "";
    if (submitBtn) submitBtn.disabled = true;
    const res = await api.addWorktree({
      repo: wtRepo,
      branch,
      baseRef: baseSelect?.value || "HEAD",
    });
    if (submitBtn) submitBtn.disabled = false;
    if ("error" in res) {
      if (errEl) errEl.textContent = res.error;
      handlers.showToast(t("projects.worktree.fail"), "error", {
        detail: res.error,
        ms: 7000,
      });
      return;
    }
    closeWorktreeForm();
    setActiveCwd(res.path);
    await refresh();
    await handlers.openClaudeAt(res.path);
  }

  async function removeWt(path: string): Promise<void> {
    const ok = await askFsConfirm({
      title: t("projects.worktree.removeTitle"),
      body: t("projects.worktree.removeBody", { path }),
      okLabel: t("projects.worktree.remove"),
      cancelLabel: t("files.dialogCancel"),
      danger: true,
    });
    if (!ok) return;
    const res = await api.removeWorktree(path);
    if ("error" in res) {
      handlers.showToast(t("projects.worktree.removeFail"), "error", {
        detail: res.error,
        ms: 7000,
      });
      return;
    }
    if (activeCwd && samePath(activeCwd, path)) setActiveCwd(null);
    await refresh();
  }

  function renderRow(
    f: ProjectFolder,
    label: string,
    badge: string | null,
    repoForWt: string | null
  ): HTMLElement {
    const sessions = cardsAt(f.path);
    const row = document.createElement("div");
    row.className = "claude-proj-row";
    row.tabIndex = 0;
    row.dataset.path = f.path;
    row.title = f.path;
    if (activeCwd && samePath(activeCwd, f.path)) row.classList.add("is-active");
    if (highlightCwd && samePath(highlightCwd, f.path)) {
      row.classList.add("is-flash");
    }
    const st = aggregateStatus(sessions);
    if (st) row.classList.add(`st-${st}`);

    const top = document.createElement("div");
    top.className = "claude-proj-row-top";

    const main = document.createElement("div");
    main.className = "claude-proj-main";
    const line = document.createElement("div");
    line.className = "claude-proj-line";
    const name = document.createElement("span");
    name.className = "claude-proj-name";
    name.textContent = label;
    line.append(name);
    if (badge) {
      const b = document.createElement("span");
      b.className = "claude-proj-badge";
      b.textContent = badge;
      line.append(b);
    }
    main.append(line);

    const metaBits: string[] = [];
    if (f.branch && f.branch !== label) metaBits.push(f.branch);
    if (f.changes) metaBits.push(t("projects.git.changes", { n: String(f.changes) }));
    if (f.ahead) metaBits.push(`↑${f.ahead}`);
    if (f.behind) metaBits.push(`↓${f.behind}`);
    if (metaBits.length) {
      const meta = document.createElement("div");
      meta.className = "claude-proj-meta";
      meta.textContent = metaBits.join(" · ");
      main.append(meta);
    }

    const actions = document.createElement("div");
    actions.className = "claude-proj-actions";

    if (repoForWt) {
      const wtBtn = document.createElement("button");
      wtBtn.type = "button";
      wtBtn.className = "icon ghost claude-proj-action";
      wtBtn.title = t("projects.worktree.add");
      wtBtn.setAttribute("aria-label", t("projects.worktree.add"));
      wtBtn.innerHTML = icons.gitBranch(13);
      wtBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openWorktreeForm(repoForWt);
      });
      actions.append(wtBtn);
    }

    if (f.worktreeOf) {
      const rmBtn = document.createElement("button");
      rmBtn.type = "button";
      rmBtn.className = "icon ghost claude-proj-action";
      rmBtn.title = t("projects.worktree.remove");
      rmBtn.setAttribute("aria-label", t("projects.worktree.remove"));
      rmBtn.innerHTML = icons.trash(13);
      rmBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void removeWt(f.path);
      });
      actions.append(rmBtn);
    }

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "icon ghost claude-proj-action claude-proj-action-primary";
    openBtn.title = t("projects.openClaude");
    openBtn.setAttribute("aria-label", t("projects.openClaude"));
    openBtn.innerHTML = icons.bot(13);
    openBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setActiveCwd(f.path);
      void handlers.openClaudeAt(f.path);
    });
    actions.append(openBtn);

    top.append(main, actions);
    row.append(top);

    if (sessions.length) {
      const box = document.createElement("div");
      box.className = "claude-proj-sessions";
      for (const s of sessions) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "claude-proj-session-chip";
        if (s.agentStatus) chip.dataset.status = s.agentStatus;
        chip.title = s.title;
        chip.textContent = s.title.slice(0, 22);
        chip.addEventListener("click", (e) => {
          e.stopPropagation();
          setActiveCwd(f.path);
          handlers.focusClaudeCard(s.cardId);
        });
        box.append(chip);
      }
      row.append(box);
    }

    const pick = () => {
      setActiveCwd(f.path);
      if (sessions[0]) handlers.focusClaudeCard(sessions[0].cardId);
    };
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      pick();
    });
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        pick();
      }
    });

    return row;
  }

  function render(): void {
    if (!railEl) return;
    const roots = folders.filter((f) => !f.worktreeOf);
    const groups: HTMLElement[] = [];

    for (const root of roots) {
      const members = [
        root,
        ...folders.filter(
          (f) => f.worktreeOf && samePath(f.worktreeOf, root.path)
        ),
      ];
      const key = root.path.toLowerCase();
      const open = !collapsed.has(key);

      if (members.length === 1) {
        const section = document.createElement("section");
        section.className = "claude-proj-group";
        section.append(
          renderRow(root, basenamePath(root.path), null, root.path)
        );
        groups.push(section);
        continue;
      }

      const section = document.createElement("section");
      section.className = "claude-proj-group";
      const head = document.createElement("div");
      head.className = "claude-proj-group-head";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "claude-proj-group-toggle";
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.innerHTML = `<span class="claude-proj-chev" aria-hidden="true">${icons.chevronRight(10)}</span><span class="claude-proj-group-label">${basenamePath(root.path)}</span>`;
      toggle.addEventListener("click", () => {
        if (collapsed.has(key)) collapsed.delete(key);
        else collapsed.add(key);
        render();
      });
      head.append(toggle);
      const wtBtn = document.createElement("button");
      wtBtn.type = "button";
      wtBtn.className = "icon ghost claude-proj-action";
      wtBtn.title = t("projects.worktree.add");
      wtBtn.innerHTML = icons.gitBranch(13);
      wtBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openWorktreeForm(root.path);
      });
      head.append(wtBtn);
      section.append(head);
      if (open) {
        members.forEach((f, i) => {
          section.append(
            renderRow(
              f,
              i === 0 ? f.branch || basenamePath(f.path) : f.branch || basenamePath(f.path),
              i === 0 ? t("projects.badge.main") : t("projects.badge.worktree"),
              i === 0 ? root.path : null
            )
          );
        });
      }
      groups.push(section);
    }

    // Folders that are worktrees of unknown roots
    const orphanWts = folders.filter(
      (f) =>
        f.worktreeOf &&
        !roots.some((r) => samePath(r.path, f.worktreeOf!))
    );
    if (orphanWts.length) {
      const section = document.createElement("section");
      section.className = "claude-proj-group";
      for (const f of orphanWts) {
        section.append(
          renderRow(
            f,
            f.branch || basenamePath(f.path),
            t("projects.badge.worktree"),
            f.worktreeOf || null
          )
        );
      }
      groups.push(section);
    }

    if (!groups.length) {
      const empty = document.createElement("p");
      empty.className = "claude-proj-empty";
      empty.textContent = t("projects.empty");
      railEl.replaceChildren(empty);
      return;
    }
    railEl.replaceChildren(...groups);

    if (highlightCwd) {
      const rows = railEl.querySelectorAll(".claude-proj-row");
      for (const row of rows) {
        const el = row as HTMLElement;
        if (el.dataset.path && samePath(el.dataset.path, highlightCwd)) {
          el.scrollIntoView({ block: "nearest" });
          break;
        }
      }
    }
  }

  function highlightPath(cwd: string): void {
    highlightCwd = cwd;
    setActiveCwd(cwd);
    render();
    if (highlightTimer) window.clearTimeout(highlightTimer);
    highlightTimer = window.setTimeout(() => {
      highlightCwd = null;
      render();
    }, 1600);
  }

  function renderImportList(): void {
    if (!importList) return;
    const q = (importSearch?.value || "").trim().toLowerCase();
    const list = importRows.filter(
      (s) =>
        !q ||
        s.title.toLowerCase().includes(q) ||
        s.cwd.toLowerCase().includes(q)
    );
    if (!list.length) {
      const li = document.createElement("li");
      li.className = "claude-import-none";
      li.textContent = q
        ? t("projects.import.noneMatch")
        : t("projects.import.none");
      importList.replaceChildren(li);
      return;
    }
    importList.replaceChildren(
      ...list.map((s) => {
        const li = document.createElement("li");
        li.className = "claude-import-item";
        const body = document.createElement("button");
        body.type = "button";
        body.className = "claude-import-body";
        const name = document.createElement("span");
        name.className = "claude-import-name";
        name.textContent = s.title;
        const tag = document.createElement("span");
        tag.className = "claude-import-tag";
        if (s.onBoard) {
          tag.classList.add("is-open");
          tag.textContent = t("projects.import.onBoard");
        } else if (Date.now() - s.at < 120_000) {
          tag.textContent = t("projects.import.maybeBusy");
        } else {
          tag.textContent = agoLabel(s.at);
        }
        const pathEl = document.createElement("span");
        pathEl.className = "claude-import-path";
        pathEl.textContent = s.cwd || t("projects.import.noCwd");
        body.append(name, tag, pathEl);
        body.addEventListener("click", () => void openImported(s));

        const del = document.createElement("button");
        del.type = "button";
        del.className = "icon ghost claude-import-delete";
        del.title = t("projects.import.delete");
        del.setAttribute("aria-label", t("projects.import.delete"));
        del.innerHTML = icons.trash(13);
        if (s.onBoard) {
          del.disabled = true;
          del.title = t("projects.import.deleteOnBoard");
        }
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          void deleteImported(s);
        });

        li.append(body, del);
        return li;
      })
    );
  }

  async function deleteImported(s: ClaudeTranscriptRow): Promise<void> {
    if (s.onBoard) {
      handlers.showToast(t("projects.import.deleteOnBoard"), "error");
      return;
    }
    const ok = await askFsConfirm({
      title: t("projects.import.deleteTitle"),
      body: t("projects.import.deleteBody", { title: s.title }),
      okLabel: t("projects.import.delete"),
      cancelLabel: t("files.dialogCancel"),
      danger: true,
    });
    if (!ok) return;
    const res = await api.deleteClaudeTranscript(s.id);
    if ("error" in res) {
      handlers.showToast(t("projects.import.deleteFail"), "error", {
        detail: res.error,
        ms: 7000,
      });
      return;
    }
    importRows = importRows.filter((row) => row.id !== s.id);
    renderImportList();
  }

  async function openImported(s: ClaudeTranscriptRow): Promise<void> {
    closeImport();
    const onBoard = handlers
      .getBoardClaudeCards()
      .find((c) => c.sessionId.toLowerCase() === s.id.toLowerCase());
    if (onBoard) {
      handlers.focusClaudeCard(onBoard.cardId);
      return;
    }
    let cwd = s.cwd;
    if (!cwd) {
      cwd = (await handlers.pickDirectory()) || "";
      if (!cwd) return;
    }
    setActiveCwd(cwd);
    await handlers.openClaudeResume({
      cwd,
      sessionId: s.id,
      title: s.title,
    });
  }

  async function openImport(): Promise<void> {
    if (!importPop || !importList) return;
    closeWorktreeForm();
    importPop.classList.remove("hidden");
    importPop.setAttribute("aria-hidden", "false");
    if (importSearch) importSearch.value = "";
    importList.replaceChildren();
    const loading = document.createElement("li");
    loading.className = "claude-import-none";
    loading.textContent = t("projects.import.loading");
    importList.append(loading);
    importSearch?.focus();
    try {
      const res = await api.listClaudeTranscripts();
      const boardIds = new Set(
        handlers.getBoardClaudeCards().map((c) => c.sessionId.toLowerCase())
      );
      importRows = (res.sessions || []).map((s) => ({
        ...s,
        onBoard: s.onBoard || boardIds.has(s.id.toLowerCase()),
      }));
    } catch {
      importRows = [];
    }
    renderImportList();
  }

  function closeImport(): void {
    importPop?.classList.add("hidden");
    importPop?.setAttribute("aria-hidden", "true");
  }

  function isImportOpen(): boolean {
    return Boolean(importPop && !importPop.classList.contains("hidden"));
  }

  /** Open worktree form for a card cwd (resolves git root). */
  async function openWorktreeForCwd(cwd: string): Promise<void> {
    const { root } = await api.resolveGitRoot(cwd);
    if (!root) {
      handlers.showToast(t("projects.worktree.notGit"), "error");
      return;
    }
    openWorktreeForm(root);
  }

  // Wire form once
  if (formEl) {
    formEl.addEventListener("submit", (e) => void submitWorktree(e));
    formEl
      .querySelector("[data-wt-cancel]")
      ?.addEventListener("click", () => closeWorktreeForm());
    formEl
      .querySelector("[data-wt-branch]")
      ?.addEventListener("input", () => void updatePreview());
  }
  importSearch?.addEventListener("input", () => renderImportList());
  document
    .getElementById("btn-claude-import")
    ?.addEventListener("click", () => {
      if (isImportOpen()) closeImport();
      else void openImport();
    });
  document
    .getElementById("btn-refresh-projects")
    ?.addEventListener("click", () => void refresh());
  document
    .getElementById("btn-claude-import-close")
    ?.addEventListener("click", () => closeImport());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isImportOpen()) {
      closeImport();
    }
  });

  return {
    refresh,
    scheduleRefresh,
    getActiveCwd,
    setActiveCwd,
    highlightPath,
    openWorktreeForCwd,
    openImport,
    closeImport,
  };
}

export type ProjectsRailController = ReturnType<typeof createProjectsRail>;
