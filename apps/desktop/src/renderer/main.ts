import "./styles.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { DesktopApi, SessionUsageView } from "../../electron/preload";
import type {
  ChatMode,
  ModelOption,
  ProposedAction,
  SavedSession,
  TokenUsageSnapshot,
} from "@drift/core";
import { createChatController } from "./chat.js";
import {
  applyDomI18n,
  normalizeLocale,
  setLocale,
  t,
  type AppLocale,
} from "./i18n.js";
import { icons } from "./icons.js";
import { createFilesBrowser } from "./files-tree.js";

declare global {
  interface Window {
    cursorTerm: DesktopApi;
  }
}

const api = window.cursorTerm;

type TabView = {
  id: string;
  title: string;
  kind: "local" | "ssh";
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  lastCols: number;
  lastRows: number;
  fitTimer?: number;
  /** Ignore fit/resize until this time so the first prompt keeps a stable COLUMNS. */
  sizeFreezeUntil?: number;
};

/** Bundled MesloLGS NF — must match @font-face in styles.css. CJK fallbacks after. */
const TERM_FONT_FAMILY =
  '"Drift Mono", "MesloLGS NF", Menlo, "Apple SD Gothic Neo", "Noto Sans Mono CJK KR", monospace';
const TERM_FONT_SIZE = 13;

async function ensureTermFont(): Promise<void> {
  try {
    await document.fonts.load(`${TERM_FONT_SIZE}px "Drift Mono"`);
    await document.fonts.ready;
  } catch {
    /* system fallback fonts still work */
  }
}

const state = {
  sessions: [] as SavedSession[],
  tabs: new Map<string, TabView>(),
  activeTabId: null as string | null,
  hasKey: false,
  modelId: "composer-2.5",
  chatMode: "agent" as ChatMode,
  locale: "ko" as AppLocale,
  models: [] as ModelOption[],
  lastUsage: null as TokenUsageSnapshot | null,
  lastCostCents: null as number | null,
  sessionUsage: null as SessionUsageView | null,
  pendingApproval: null as null | {
    runId: string;
    tabId: string;
    action: ProposedAction;
  },
  generating: false,
  turnTokens: null as number | null,
  turnModel: null as string | null,
  turnCost: null as string | null,
  startedAssistant: false,
};

type NavId = "sessions" | "files" | "settings";
const tabCwds = new Map<string, string>();

if (/Mac|darwin/i.test(navigator.userAgent)) {
  document.documentElement.classList.add("is-mac");
}

const app = document.getElementById("app")!;
app.innerHTML = `
  <div class="shell">
    <header class="titlebar" id="status-strip">
      <div class="strip-left">
        <button type="button" class="chrome-btn" id="btn-toggle-nav" data-i18n-title="chrome.toggleNav" title="Toggle sidebar" aria-label="Toggle sidebar" aria-pressed="true">
          ${icons.panelLeft(16)}
        </button>
        <button type="button" class="strip-path" id="strip-path" title="">
          <span class="strip-path-ico">${icons.folder(13)}</span>
          <span id="strip-path-text">—</span>
        </button>
        <div class="strip-metric" id="strip-cpu" data-i18n-title="strip.cpuTitle" title="CPU load">
          <span class="strip-metric-ico ok">${icons.cpu(13)}</span>
          <span class="strip-metric-label" id="strip-cpu-label">CPU</span>
          <span class="strip-bar"><span id="strip-cpu-bar"></span></span>
          <span class="strip-metric-val" id="strip-cpu-val">—</span>
        </div>
        <div class="strip-metric" id="strip-mem" data-i18n-title="strip.memTitle" title="Free memory (RAM)">
          <span class="strip-metric-ico warn">${icons.memory(13)}</span>
          <span class="strip-metric-label" data-i18n="strip.mem">Mem</span>
          <span class="strip-bar warn"><span id="strip-mem-bar"></span></span>
          <span class="strip-metric-val" id="strip-mem-val">—</span>
        </div>
        <div class="strip-metric" id="strip-disk" data-i18n-title="strip.diskTitle" title="Root disk usage">
          <span class="strip-metric-ico">${icons.disk(13)}</span>
          <span class="strip-metric-label" data-i18n="strip.disk">Disk</span>
          <span class="strip-bar"><span id="strip-disk-bar"></span></span>
          <span class="strip-metric-val" id="strip-disk-val">—</span>
        </div>
        <div class="strip-metric hidden" id="strip-gpu" data-i18n-title="strip.gpuTitle" title="GPU utilization">
          <span class="strip-metric-ico">${icons.monitor(13)}</span>
          <span class="strip-metric-label" data-i18n="strip.gpu">GPU</span>
          <span class="strip-bar"><span id="strip-gpu-bar"></span></span>
          <span class="strip-metric-val" id="strip-gpu-val">—</span>
        </div>
      </div>
      <div class="strip-right">
        <span class="strip-pill" id="strip-shell">
          <span class="strip-dot" id="strip-shell-dot"></span>
          <span id="strip-shell-text" data-i18n="strip.shellIdle">Shell idle</span>
        </span>
        <span class="strip-pill" id="key-badge">
          <span class="strip-dot warn" id="key-dot"></span>
          <span id="key-badge-text">API key needed</span>
        </span>
        <button type="button" class="strip-stop hidden" id="btn-strip-stop" data-i18n-title="strip.stop" title="Stop" aria-label="Stop">
          ${icons.stop(11)}
          <span data-i18n="strip.stop">Stop</span>
        </button>
        <button type="button" class="chrome-btn" id="btn-toggle-agent" data-i18n-title="chrome.toggleAgent" title="Toggle chat panel" aria-label="Toggle chat panel" aria-pressed="true">
          ${icons.panelRight(16)}
        </button>
      </div>
    </header>

    <div class="layout">
      <nav class="rail" aria-label="Workspace">
        <div class="rail-top">
          <div class="rail-brand" title="Drift" aria-hidden="true">
            <img class="rail-brand-mark" src="/brand/logo-mark.png" alt="" width="22" height="13" draggable="false" />
          </div>
          <div class="rail-group">
            <button type="button" class="rail-btn active" data-nav="sessions" data-i18n-title="nav.sessions" title="Sessions" aria-label="Sessions">${icons.server(17)}</button>
            <button type="button" class="rail-btn" data-nav="files" data-i18n-title="nav.files" title="Files" aria-label="Files">${icons.folder(17)}</button>
          </div>
        </div>
        <div class="rail-group rail-group-bottom">
          <button type="button" class="rail-btn" data-nav="settings" data-i18n-title="nav.settings" title="Settings" aria-label="Settings">${icons.settings(17)}</button>
        </div>
      </nav>

      <aside class="nav-panel" id="nav-panel">
        <section class="nav-view" data-view="sessions">
          <div class="sidebar-tools">
            <button class="primary" id="btn-local">
              ${icons.terminal(14)}
              <span data-i18n="sidebar.local">Local terminal</span>
            </button>
            <div class="btn-row btn-row-ssh">
              <button type="button" id="btn-add-ssh" data-i18n="sidebar.addSsh">Add SSH</button>
              <button
                type="button"
                class="icon"
                id="btn-import-ssh"
                data-i18n-title="sidebar.import"
                title="Import config"
                aria-label="Import config"
              >${icons.importConfig(14)}</button>
            </div>
            <div class="sidebar-status hidden" id="import-ssh-status" role="status" aria-live="polite"></div>
          </div>
          <div class="section-label"><span data-i18n="sidebar.ssh">SSH sessions</span></div>
          <div class="session-empty" id="session-empty" data-i18n-html="sidebar.empty"></div>
          <ul class="session-list" id="session-list"></ul>
        </section>

        <section class="nav-view hidden" data-view="files">
          <div class="files-panel" id="files-panel">
            <div class="files-split">
              <section class="files-pane" data-scope="server">
                <button type="button" class="files-pane-head" data-collapse-toggle data-i18n-title="files.collapse" title="Collapse">
                  <span class="files-pane-chevron" aria-hidden="true">${icons.chevronDown(12)}</span>
                  <span class="files-pane-title" data-i18n="files.server">Server</span>
                  <span class="files-pane-host"></span>
                </button>
                <div class="files-pane-body">
                  <div class="files-pane-body-inner">
                    <button type="button" class="files-path" title=""></button>
                    <div class="files-toolbar">
                      <label class="files-filter-wrap">
                        <span class="files-filter-ico">${icons.search(12)}</span>
                        <input class="files-filter" type="search" data-i18n-placeholder="files.filter" placeholder="Filter by name" />
                      </label>
                      <button type="button" class="icon ghost" data-refresh data-i18n-title="files.refresh" title="Refresh">${icons.refresh(12)}</button>
                    </div>
                    <div class="files-tree"></div>
                    <div class="files-empty" data-i18n="files.serverEmpty">Connect an SSH session to browse the server</div>
                  </div>
                </div>
              </section>
              <section class="files-pane" data-scope="local">
                <button type="button" class="files-pane-head" data-collapse-toggle data-i18n-title="files.collapse" title="Collapse">
                  <span class="files-pane-chevron" aria-hidden="true">${icons.chevronDown(12)}</span>
                  <span class="files-pane-title" data-i18n="files.local">This Mac</span>
                  <span class="files-pane-host"></span>
                </button>
                <div class="files-pane-body">
                  <div class="files-pane-body-inner">
                    <button type="button" class="files-path" title=""></button>
                    <div class="files-toolbar">
                      <label class="files-filter-wrap">
                        <span class="files-filter-ico">${icons.search(12)}</span>
                        <input class="files-filter" type="search" data-i18n-placeholder="files.filter" placeholder="Filter by name" />
                      </label>
                      <button type="button" class="icon ghost" data-refresh data-i18n-title="files.refresh" title="Refresh">${icons.refresh(12)}</button>
                    </div>
                    <div class="files-tree"></div>
                    <div class="files-empty hidden"></div>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </section>

        <section class="nav-view hidden" data-view="settings">
          <div class="settings-panel">
            <div class="settings-brand">
              <img class="settings-brand-icon" src="/brand/icon.png" alt="" width="36" height="36" draggable="false" />
              <div class="settings-brand-text">
                <div class="settings-brand-name">Drift</div>
                <p class="settings-lead" data-i18n="settings.lead">API key is encrypted in the OS keychain. Sessions never store secrets.</p>
              </div>
            </div>
            <div class="form-grid settings-form">
              <label>
                <span class="settings-field-head">
                  <span data-i18n="settings.apiKey">Cursor API key</span>
                  <button type="button" class="ghost settings-inline-btn" id="btn-clear-key" data-i18n="settings.clearKey">Clear key</button>
                </span>
                <input id="api-key-input" type="password" autocomplete="off" placeholder="cursor_…" />
              </label>
              <label>
                <span data-i18n="settings.model">Default model</span>
                <div class="settings-field-row">
                  <select id="settings-model-select"></select>
                  <button type="button" class="ghost settings-inline-btn" id="btn-refresh-models" data-i18n="settings.refreshModels">Refresh</button>
                </div>
              </label>
              <label>
                <span data-i18n="settings.language">Language</span>
                <select id="settings-locale">
                  <option value="ko">한국어</option>
                  <option value="en">English</option>
                </select>
              </label>
            </div>
            <div class="settings-actions">
              <button type="button" class="primary" id="btn-save-key" data-i18n="settings.save">Save</button>
            </div>
          </div>
        </section>
      </aside>

      <section class="main">
        <div class="tabstrip">
          <div class="tabs" id="tabs"></div>
          <div class="tabs-empty" id="tabs-empty" data-i18n="tabs.empty"></div>
        </div>
        <div class="terminal-stage">
          <div class="terminal-frame">
            <div class="terminal-host" id="terminal-host"></div>
          </div>
        </div>
      </section>

      <aside class="agent" id="agent-panel">
        <div class="panel-head agent-top">
          <div class="agent-tools">
            <button type="button" class="agent-tool" id="btn-new-chat" data-i18n-title="chat.new" title="Reset chat" aria-label="Reset chat">${icons.restartChat(16)}</button>
          </div>
        </div>
        <div class="chat-thread" id="chat-thread"></div>
        <div class="agent-compose">
          <div class="composer" id="composer">
            <textarea id="agent-input" data-i18n-placeholder="chat.placeholder" placeholder="Plan, search, build anything…"></textarea>
            <div class="composer-foot">
              <div class="composer-left">
                <div class="mode-wrap">
                  <button type="button" class="mode-chip" id="btn-mode" aria-haspopup="listbox" aria-expanded="false">
                    <span class="mode-icon" id="mode-icon" aria-hidden="true"></span>
                    <span id="mode-label">Agent</span>
                    <span class="mode-caret" aria-hidden="true">${icons.chevronDown(12)}</span>
                  </button>
                  <div class="mode-popover hidden" id="mode-popover" role="listbox">
                    <button type="button" role="option" data-mode="agent" data-desc-key="mode.agent.desc">
                      <span class="mode-ico" data-ico="agent"></span>
                      <span class="mode-copy"><strong data-i18n="mode.agent">Agent</strong></span>
                      <span class="mode-check" data-check="agent"></span>
                    </button>
                    <button type="button" role="option" data-mode="plan" data-desc-key="mode.plan.desc">
                      <span class="mode-ico" data-ico="plan"></span>
                      <span class="mode-copy"><strong data-i18n="mode.plan">Plan</strong></span>
                      <span class="mode-check" data-check="plan"></span>
                    </button>
                    <button type="button" role="option" data-mode="ask" data-desc-key="mode.ask.desc">
                      <span class="mode-ico" data-ico="ask"></span>
                      <span class="mode-copy"><strong data-i18n="mode.ask">Ask</strong></span>
                      <span class="mode-check" data-check="ask"></span>
                    </button>
                    <div class="mode-tip hidden" id="mode-tip" role="tooltip"></div>
                  </div>
                </div>
                <div class="model-wrap">
                  <button type="button" class="model-chip" id="btn-model" aria-haspopup="listbox" aria-expanded="false">
                    <span id="model-label">Auto</span>
                    <span class="mode-caret" aria-hidden="true">${icons.chevronDown(12)}</span>
                  </button>
                  <div class="model-popover hidden" id="model-popover">
                    <div class="model-search">
                      ${icons.search(14)}
                      <input id="model-search" type="search" data-i18n-placeholder="model.search" placeholder="Search models" autocomplete="off" />
                    </div>
                    <div class="model-list" id="model-list" role="listbox"></div>
                  </div>
                </div>
                <span class="usage-mini hidden" id="usage-mini"></span>
              </div>
              <div class="composer-right">
                <button class="send-btn" id="btn-send" data-i18n-title="chat.send" title="Send" aria-label="Send">${icons.send(16)}</button>
              </div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  </div>

  <div class="toast-host" id="toast-host" aria-live="polite"></div>

  <div class="modal-backdrop hidden" id="modal-ssh">
    <div class="modal">
      <h2 data-i18n="ssh.title">SSH session</h2>
      <p class="lead" data-i18n="ssh.lead">Passwords are never saved. Use keys or enter credentials in the terminal.</p>
      <div class="form-grid two">
        <label><span data-i18n="ssh.name">Name</span> <input id="ssh-name" placeholder="prod-gpu" /></label>
        <label><span data-i18n="ssh.host">Host</span> <input id="ssh-host" placeholder="192.168.1.10" /></label>
        <label><span data-i18n="ssh.user">User</span> <input id="ssh-user" placeholder="ubuntu" /></label>
        <label><span data-i18n="ssh.port">Port</span> <input id="ssh-port" type="number" placeholder="22" /></label>
      </div>
      <div class="form-grid">
        <label><span data-i18n="ssh.identity">Identity file</span> <input id="ssh-identity" placeholder="~/.ssh/id_ed25519" /></label>
        <label><span data-i18n="ssh.jump">ProxyJump</span> <input id="ssh-jump" placeholder="bastion" /></label>
        <label><span data-i18n="ssh.dir">Start dir</span> <input id="ssh-dir" placeholder="/home/ubuntu" /></label>
      </div>
      <div class="actions">
        <button class="ghost" id="btn-cancel-ssh" data-i18n="ssh.cancel">Cancel</button>
        <button class="primary" id="btn-save-ssh" data-i18n="ssh.save">Save session</button>
      </div>
    </div>
  </div>

  <div class="modal-backdrop hidden" id="modal-update" role="dialog" aria-modal="true" aria-labelledby="update-title">
    <div class="modal modal-update">
      <h2 id="update-title" data-i18n="update.title">Update available</h2>
      <p class="lead" data-i18n="update.lead">A new version of Drift is ready.</p>
      <div class="update-versions">
        <div><span data-i18n="update.current">Current</span> <strong id="update-current">—</strong></div>
        <div><span data-i18n="update.latest">Latest</span> <strong id="update-latest">—</strong></div>
      </div>
      <p class="update-notes hidden" id="update-notes"></p>
      <div class="update-progress hidden" id="update-progress">
        <div class="update-progress-bar"><span id="update-progress-fill"></span></div>
        <div class="update-progress-label" id="update-progress-label"></div>
      </div>
      <p class="update-error hidden" id="update-error"></p>
      <div class="actions">
        <button type="button" class="ghost" id="btn-update-later" data-i18n="update.later">Later</button>
        <button type="button" class="primary" id="btn-update-action" data-i18n="update.download">Update</button>
      </div>
    </div>
  </div>

`;

const els = {
  sessionList: document.getElementById("session-list")!,
  sessionEmpty: document.getElementById("session-empty")!,
  tabs: document.getElementById("tabs")!,
  tabsEmpty: document.getElementById("tabs-empty")!,
  terminalHost: document.getElementById("terminal-host")!,
  chatThread: document.getElementById("chat-thread")!,
  agentInput: document.getElementById("agent-input") as HTMLTextAreaElement,
  composer: document.getElementById("composer")!,
  btnSend: document.getElementById("btn-send") as HTMLButtonElement,
  keyBadge: document.getElementById("key-badge")!,
  keyBadgeText: document.getElementById("key-badge-text")!,
  keyDot: document.getElementById("key-dot")!,
  stripPath: document.getElementById("strip-path") as HTMLButtonElement,
  stripPathText: document.getElementById("strip-path-text")!,
  stripCpu: document.getElementById("strip-cpu")!,
  stripCpuLabel: document.getElementById("strip-cpu-label")!,
  stripCpuBar: document.getElementById("strip-cpu-bar")!,
  stripCpuVal: document.getElementById("strip-cpu-val")!,
  stripMemBar: document.getElementById("strip-mem-bar")!,
  stripMemVal: document.getElementById("strip-mem-val")!,
  stripDisk: document.getElementById("strip-disk")!,
  stripDiskBar: document.getElementById("strip-disk-bar")!,
  stripDiskVal: document.getElementById("strip-disk-val")!,
  stripGpu: document.getElementById("strip-gpu")!,
  stripGpuBar: document.getElementById("strip-gpu-bar")!,
  stripGpuVal: document.getElementById("strip-gpu-val")!,
  stripShell: document.getElementById("strip-shell")!,
  stripShellDot: document.getElementById("strip-shell-dot")!,
  stripShellText: document.getElementById("strip-shell-text")!,
  btnStripStop: document.getElementById("btn-strip-stop") as HTMLButtonElement,
  modalSsh: document.getElementById("modal-ssh")!,
  modalUpdate: document.getElementById("modal-update")!,
  updateCurrent: document.getElementById("update-current")!,
  updateLatest: document.getElementById("update-latest")!,
  updateNotes: document.getElementById("update-notes")!,
  updateProgress: document.getElementById("update-progress")!,
  updateProgressFill: document.getElementById("update-progress-fill")!,
  updateProgressLabel: document.getElementById("update-progress-label")!,
  updateError: document.getElementById("update-error")!,
  btnUpdateLater: document.getElementById(
    "btn-update-later"
  ) as HTMLButtonElement,
  btnUpdateAction: document.getElementById(
    "btn-update-action"
  ) as HTMLButtonElement,
  apiKeyInput: document.getElementById("api-key-input") as HTMLInputElement,
  btnModel: document.getElementById("btn-model") as HTMLButtonElement,
  modelLabel: document.getElementById("model-label")!,
  modelPopover: document.getElementById("model-popover")!,
  modelSearch: document.getElementById("model-search") as HTMLInputElement,
  modelList: document.getElementById("model-list")!,
  settingsModelSelect: document.getElementById(
    "settings-model-select"
  ) as HTMLSelectElement,
  settingsLocale: document.getElementById("settings-locale") as HTMLSelectElement,
  usageMini: document.getElementById("usage-mini")!,
  btnMode: document.getElementById("btn-mode") as HTMLButtonElement,
  modePopover: document.getElementById("mode-popover")!,
  modeTip: document.getElementById("mode-tip")!,
  modeLabel: document.getElementById("mode-label")!,
  modeIcon: document.getElementById("mode-icon")!,
};

const MODE_ICONS: Record<ChatMode, string> = {
  agent: icons.bot(14),
  plan: icons.list(14),
  ask: icons.message(14),
};

const CHECK_ICON = icons.check(12);

function renderModeChip(): void {
  els.modeLabel.textContent = t(`mode.${state.chatMode}`);
  els.modeIcon.innerHTML = MODE_ICONS[state.chatMode];
  els.modePopover.querySelectorAll<HTMLElement>("[data-ico]").forEach((el) => {
    const key = el.dataset.ico as ChatMode;
    el.innerHTML = MODE_ICONS[key] ?? "";
  });
  els.modePopover.querySelectorAll<HTMLElement>("[data-check]").forEach((el) => {
    const on = el.dataset.check === state.chatMode;
    el.classList.toggle("on", on);
    el.innerHTML = on ? CHECK_ICON : "";
  });
}

function applyUiLocale(): void {
  applyDomI18n(document);
  renderModeChip();
  setKeyBadge(state.hasKey);
  refreshStatusStrip();
  if (!state.generating) {
    els.btnSend.innerHTML = icons.send(16);
    els.btnSend.title = t("chat.send");
    els.btnSend.setAttribute("aria-label", t("chat.send"));
  }
  els.settingsLocale.value = state.locale;
  // Refresh empty chat copy if still empty.
  if (els.chatThread.querySelector(".chat-empty")) {
    chat.showEmpty();
  }
  updateSessionEmpty();
  updateTabsEmpty();
}

async function applyLocale(next: AppLocale): Promise<void> {
  state.locale = next;
  setLocale(next);
  await api.setLocale(next);
  applyUiLocale();
  chat.addSystem(
    t("lang.changed", { lang: next === "ko" ? "한국어" : "English" })
  );
}

async function applyChatMode(mode: ChatMode): Promise<void> {
  state.chatMode = mode;
  await api.setChatMode(mode);
  renderModeChip();
  els.modePopover.classList.add("hidden");
  els.btnMode.setAttribute("aria-expanded", "false");
  hideModeTip();
  chat.addSystem(t("mode.changed", { mode: t(`mode.${mode}`) }));
}

function updateSessionEmpty(): void {
  els.sessionEmpty.classList.toggle("hidden", state.sessions.length > 0);
}

function updateTabsEmpty(): void {
  els.tabsEmpty.classList.toggle("hidden", state.tabs.size > 0);
}

const chat = createChatController(els.chatThread);
chat.showEmpty();

function setGenerating(on: boolean): void {
  state.generating = on;
  els.composer.classList.toggle("generating", on);
  els.btnSend.innerHTML = on ? icons.loading(16) : icons.send(16);
  els.btnSend.classList.toggle("busy", on);
  els.btnSend.disabled = on;
  els.agentInput.disabled = on;
  updateStripShell();
}

let homeDirCache = "";

function formatStripPath(cwd: string): string {
  if (!cwd) return "—";
  if (homeDirCache && (cwd === homeDirCache || cwd.startsWith(homeDirCache + "/"))) {
    return "~" + cwd.slice(homeDirCache.length);
  }
  return cwd;
}

function formatBytesShort(n: number): string {
  if (n < 1024 ** 2) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

function setKeyBadge(hasKey: boolean): void {
  state.hasKey = hasKey;
  els.keyBadgeText.textContent = hasKey ? t("status.ready") : t("status.needKey");
  els.keyBadge.classList.toggle("ok", hasKey);
  els.keyBadge.classList.toggle("warn", !hasKey);
  els.keyDot.classList.toggle("ok", hasKey);
  els.keyDot.classList.toggle("warn", !hasKey);
}

function updateStripPath(): void {
  const active = state.activeTabId
    ? state.tabs.get(state.activeTabId)
    : undefined;
  const cwd = active ? tabCwds.get(active.id) : undefined;
  const label = cwd ? formatStripPath(cwd) : active ? active.title : "—";
  els.stripPathText.textContent = label;
  els.stripPath.title = cwd || active?.title || "";
}

function updateStripShell(): void {
  const busy = state.generating;
  els.stripShell.classList.toggle("busy", busy);
  els.stripShellDot.classList.toggle("busy", busy);
  els.stripShellDot.classList.toggle("ok", !busy);
  els.stripShellText.textContent = busy
    ? t("strip.shellBusy")
    : t("strip.shellIdle");
  els.btnStripStop.classList.toggle("hidden", !busy);
}

let metricsInFlight = false;

function setMetricWarn(el: HTMLElement, hot: boolean): void {
  el.classList.toggle("hot", hot);
}

async function refreshStripMetrics(): Promise<void> {
  if (metricsInFlight) return;
  metricsInFlight = true;
  try {
    const active = state.activeTabId
      ? state.tabs.get(state.activeTabId)
      : undefined;
    const m = active
      ? await api.getTabMetrics(active.id)
      : await api.getLocalMetrics();
    const ssh = m.source === "ssh";
    els.stripCpuLabel.textContent = ssh ? t("strip.load") : t("strip.cpu");
    els.stripCpu.title = ssh ? t("strip.loadTitle") : t("strip.cpuTitle");
    if (ssh && m.load1 != null) {
      els.stripCpuVal.textContent = m.load1.toFixed(2);
      els.stripCpuVal.title = `${m.cpuPct}% · ${m.cores} cores`;
    } else {
      els.stripCpuVal.textContent = `${m.cpuPct}%`;
      els.stripCpuVal.title = "";
    }
    els.stripCpuBar.style.width = `${Math.max(4, m.cpuPct)}%`;
    setMetricWarn(els.stripCpu, m.cpuPct >= 85);

    const freePct = m.memTotalBytes
      ? Math.round((m.memFreeBytes / m.memTotalBytes) * 100)
      : 0;
    els.stripMemVal.textContent = m.memTotalBytes
      ? formatBytesShort(m.memFreeBytes)
      : "—";
    els.stripMemBar.style.width = `${Math.max(4, freePct)}%`;
    els.stripMemVal.title = m.memTotalBytes
      ? `${formatBytesShort(m.memUsedBytes)} / ${formatBytesShort(m.memTotalBytes)}`
      : m.error || "";
    setMetricWarn(
      document.getElementById("strip-mem")!,
      freePct > 0 && freePct <= 15
    );

    els.stripDiskVal.textContent = m.diskTotalBytes
      ? `${m.diskUsedPct}%`
      : "—";
    els.stripDiskBar.style.width = `${Math.max(4, m.diskUsedPct)}%`;
    els.stripDisk.title = m.diskTotalBytes
      ? `${t("strip.diskTitle")} (${m.diskMount}): ${formatBytesShort(m.diskUsedBytes)} / ${formatBytesShort(m.diskTotalBytes)}`
      : t("strip.diskTitle");
    setMetricWarn(els.stripDisk, m.diskUsedPct >= 85);

    const hasGpu = m.gpuPct != null;
    els.stripGpu.classList.toggle("hidden", !hasGpu);
    if (hasGpu) {
      const pct = m.gpuPct ?? 0;
      els.stripGpuVal.textContent = `${pct}%`;
      els.stripGpuBar.style.width = `${Math.max(4, pct)}%`;
      const bits = [m.gpuName, m.gpuMemPct != null ? `VRAM ${m.gpuMemPct}%` : ""]
        .filter(Boolean)
        .join(" · ");
      els.stripGpu.title = bits || t("strip.gpuTitle");
      setMetricWarn(els.stripGpu, pct >= 90 || (m.gpuMemPct ?? 0) >= 90);
    }
  } catch {
    /* ignore */
  } finally {
    metricsInFlight = false;
  }
}

function refreshStatusStrip(): void {
  updateStripPath();
  updateStripShell();
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCents(cents: number): string {
  if (!cents) return "$0";
  return `$${(cents / 100).toFixed(cents >= 100 ? 2 : 4)}`;
}

function renderUsage(): void {
  if (!state.sessionUsage || state.sessionUsage.turns === 0) {
    els.usageMini.textContent = "";
    els.usageMini.title = "";
    els.usageMini.classList.add("hidden");
    return;
  }
  const tok = formatTokens(state.sessionUsage.usage.totalTokens);
  const cost =
    state.sessionUsage.cost.chargedCents > 0
      ? ` · ${formatCents(state.sessionUsage.cost.chargedCents)}`
      : "";
  els.usageMini.textContent = `${tok}${cost}`;
  els.usageMini.title = `Session ${state.sessionUsage.turns} turns · last ${
    state.lastUsage ? formatTokens(state.lastUsage.totalTokens) : "-"
  }`;
  els.usageMini.classList.remove("hidden");
}

function modelOptions(): ModelOption[] {
  return state.models.length
    ? state.models
    : [{ id: state.modelId, displayName: state.modelId }];
}

function currentModelLabel(): string {
  const hit = modelOptions().find((m) => m.id === state.modelId);
  return hit?.displayName || state.modelId;
}

function modelBadge(m: ModelOption): string {
  const d = m.description?.trim();
  if (!d) return "";
  return d.length <= 18 ? d : "";
}

function fillSettingsModelSelect(): void {
  const options = modelOptions();
  const select = els.settingsModelSelect;
  select.innerHTML = "";
  for (const m of options) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.displayName || m.id;
    if (m.description) opt.title = m.description;
    select.append(opt);
  }
  select.value = state.modelId;
  if (select.value !== state.modelId && options[0]) {
    select.value = options[0].id;
  }
}

function renderModelPicker(filter = ""): void {
  els.modelLabel.textContent = currentModelLabel();
  const q = filter.trim().toLowerCase();
  const options = modelOptions().filter((m) => {
    if (!q) return true;
    return (
      m.id.toLowerCase().includes(q) ||
      m.displayName.toLowerCase().includes(q) ||
      (m.description ?? "").toLowerCase().includes(q)
    );
  });
  els.modelList.innerHTML = "";
  if (!options.length) {
    const empty = document.createElement("div");
    empty.className = "model-empty";
    empty.textContent = t("model.empty");
    els.modelList.append(empty);
    return;
  }
  for (const m of options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.role = "option";
    btn.dataset.modelId = m.id;
    const selected = m.id === state.modelId;
    btn.className = selected ? "selected" : "";
    btn.setAttribute("aria-selected", selected ? "true" : "false");
    const badge = modelBadge(m);
    btn.innerHTML = `
      <span class="model-row-name">${escapeHtml(m.displayName || m.id)}</span>
      <span class="model-row-meta">
        ${badge ? `<span class="model-badge">${escapeHtml(badge)}</span>` : ""}
        <span class="model-check">${selected ? CHECK_ICON : ""}</span>
      </span>
    `;
    if (m.description) btn.title = m.description;
    els.modelList.append(btn);
  }
}

function closeModelPopover(): void {
  els.modelPopover.classList.add("hidden");
  els.btnModel.setAttribute("aria-expanded", "false");
  els.modelSearch.value = "";
}

function openModelPopover(): void {
  els.modePopover.classList.add("hidden");
  els.btnMode.setAttribute("aria-expanded", "false");
  renderModelPicker();
  els.modelPopover.classList.remove("hidden");
  els.btnModel.setAttribute("aria-expanded", "true");
  requestAnimationFrame(() => els.modelSearch.focus());
}

async function refreshModels(): Promise<void> {
  state.models = await api.listModels();
  if (!state.models.some((m) => m.id === state.modelId) && state.models[0]) {
    state.modelId = state.models[0].id;
    await api.setModel(state.modelId);
  }
  fillSettingsModelSelect();
  renderModelPicker(els.modelSearch.value);
}

async function applyModel(modelId: string): Promise<void> {
  state.modelId = modelId;
  await api.setModel(modelId);
  fillSettingsModelSelect();
  renderModelPicker();
  closeModelPopover();
  const label = currentModelLabel();
  chat.addSystem(`${t("settings.model")} → ${label}`);
  renderUsage();
}

async function refreshSessions(): Promise<void> {
  state.sessions = await api.getSessions();
  els.sessionList.innerHTML = "";
  updateSessionEmpty();
  for (const s of state.sessions) {
    const li = document.createElement("li");
    li.className = "session-item";
    const open = document.createElement("button");
    open.className = "row";
    open.innerHTML = `<strong>${escapeHtml(s.name)}</strong><span class="meta">${escapeHtml(s.user)}@${escapeHtml(s.host)}${s.port && s.port !== 22 ? `:${s.port}` : ""}</span>`;
    open.onclick = () => void openSsh(s.id);
    const del = document.createElement("button");
    del.className = "del ghost";
    del.title = "Delete";
    del.setAttribute("aria-label", `Delete ${s.name}`);
    del.innerHTML = icons.trash(14);
    del.onclick = async () => {
      await api.deleteSession(s.id);
      await refreshSessions();
    };
    li.append(open, del);
    els.sessionList.append(li);
  }
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderTabs(): void {
  els.tabs.innerHTML = "";
  updateTabsEmpty();
  for (const tab of state.tabs.values()) {
    const btn = document.createElement("button");
    btn.className = `tab${tab.id === state.activeTabId ? " active" : ""}`;
    btn.innerHTML = `<span class="tab-title">${escapeHtml(tab.title)}</span>`;
    const close = document.createElement("span");
    close.className = "close";
    close.textContent = "×";
    close.onclick = (e) => {
      e.stopPropagation();
      void closeTab(tab.id);
    };
    btn.append(close);
    btn.onclick = () => activateTab(tab.id);
    els.tabs.append(btn);
  }
}

/** Keep xterm + PTY sizes locked together — never resize one without the other. */
function syncTerminalSize(tab: TabView, opts?: { force?: boolean }): void {
  if (tab.el.classList.contains("hidden")) return;
  if (
    !opts?.force &&
    tab.sizeFreezeUntil != null &&
    Date.now() < tab.sizeFreezeUntil
  ) {
    return;
  }
  tab.fit.fit();
  const cols = tab.term.cols;
  const rows = tab.term.rows;
  if (tab.lastCols === cols && tab.lastRows === rows) return;
  tab.lastCols = cols;
  tab.lastRows = rows;
  void api.resizeTerminal(tab.id, cols, rows);
}

function scheduleTerminalFit(tab: TabView, immediate = false): void {
  if (tab.fitTimer != null) window.clearTimeout(tab.fitTimer);
  const run = () => {
    tab.fitTimer = undefined;
    syncTerminalSize(tab);
  };
  if (immediate) {
    requestAnimationFrame(run);
    return;
  }
  tab.fitTimer = window.setTimeout(run, 80);
}

function activateTab(tabId: string): void {
  state.activeTabId = tabId;
  for (const tab of state.tabs.values()) {
    tab.el.classList.toggle("hidden", tab.id !== tabId);
  }
  renderTabs();
  const active = state.tabs.get(tabId);
  if (active) {
    requestAnimationFrame(() => {
      syncTerminalSize(active);
      active.term.focus();
    });
  }
  void syncFilesPanel();
  refreshStatusStrip();
  void refreshStripMetrics();
}

function orderedTabIds(): string[] {
  return [...state.tabs.keys()];
}

function focusTabAt(index: number): void {
  const ids = orderedTabIds();
  if (index < 0 || index >= ids.length) return;
  activateTab(ids[index]!);
}

function focusRelativeTab(delta: number): void {
  const ids = orderedTabIds();
  if (ids.length === 0) return;
  const current = state.activeTabId
    ? ids.indexOf(state.activeTabId)
    : 0;
  const next = (current + delta + ids.length) % ids.length;
  activateTab(ids[next]!);
}

function clearActiveTerminal(): void {
  const tab = state.activeTabId
    ? state.tabs.get(state.activeTabId)
    : undefined;
  tab?.term.clear();
}

function refitTerminals(): void {
  for (const tab of state.tabs.values()) {
    syncTerminalSize(tab);
  }
}

let activeNav: NavId = "sessions";

function setNav(id: NavId): void {
  activeNav = id;
  document.querySelectorAll<HTMLElement>(".rail-btn[data-nav]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.nav === id);
  });
  document.querySelectorAll<HTMLElement>(".nav-view[data-view]").forEach((view) => {
    view.classList.toggle("hidden", view.dataset.view !== id);
  });
  if (id === "files") void syncFilesPanel(true);
  requestAnimationFrame(() => refitTerminals());
}

function openSettings(): void {
  setNav("settings");
}

function closeTopModal(): boolean {
  if (!els.modalUpdate.classList.contains("hidden")) {
    void dismissUpdateModal();
    return true;
  }
  if (!els.modalSsh.classList.contains("hidden")) {
    els.modalSsh.classList.add("hidden");
    return true;
  }
  return false;
}

type UpdateModalPhase = "available" | "downloading" | "ready" | "error";

let updateModal = {
  version: "",
  currentVersion: "",
  phase: "available" as UpdateModalPhase,
};

function setUpdateProgress(percent: number): void {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  els.updateProgress.classList.remove("hidden");
  els.updateProgressFill.style.width = `${pct}%`;
  els.updateProgressLabel.textContent = t("update.downloading", {
    percent: String(pct),
  });
}

function renderUpdateAction(): void {
  els.btnUpdateLater.disabled = updateModal.phase === "downloading";
  els.btnUpdateAction.disabled = updateModal.phase === "downloading";
  if (updateModal.phase === "ready") {
    els.btnUpdateAction.textContent = t("update.install");
  } else if (updateModal.phase === "downloading") {
    els.btnUpdateAction.textContent = t("update.downloading", {
      percent: "…",
    });
  } else {
    els.btnUpdateAction.textContent = t("update.download");
  }
}

function showUpdateModal(payload: {
  version: string;
  currentVersion: string;
  releaseNotes?: string | null;
}): void {
  updateModal = {
    version: payload.version,
    currentVersion: payload.currentVersion,
    phase: "available",
  };
  els.updateCurrent.textContent = payload.currentVersion;
  els.updateLatest.textContent = payload.version;
  const notes = (payload.releaseNotes ?? "").trim();
  if (notes) {
    els.updateNotes.textContent = notes;
    els.updateNotes.classList.remove("hidden");
  } else {
    els.updateNotes.textContent = "";
    els.updateNotes.classList.add("hidden");
  }
  els.updateProgress.classList.add("hidden");
  els.updateProgressFill.style.width = "0%";
  els.updateError.classList.add("hidden");
  els.updateError.textContent = "";
  renderUpdateAction();
  els.modalUpdate.classList.remove("hidden");
}

async function dismissUpdateModal(): Promise<void> {
  const version = updateModal.version;
  els.modalUpdate.classList.add("hidden");
  if (version && updateModal.phase !== "ready") {
    await api.dismissUpdate(version);
  }
}

els.btnUpdateLater.onclick = () => {
  void dismissUpdateModal();
};

els.btnUpdateAction.onclick = () => {
  void (async () => {
    els.updateError.classList.add("hidden");
    if (updateModal.phase === "ready") {
      const result = await api.installUpdate();
      if (!result.ok) {
        els.updateError.textContent = t("update.error", {
          error: result.reason,
        });
        els.updateError.classList.remove("hidden");
      }
      return;
    }
    updateModal.phase = "downloading";
    renderUpdateAction();
    setUpdateProgress(0);
    const result = await api.downloadUpdate();
    if (!result.ok) {
      updateModal.phase = "error";
      renderUpdateAction();
      els.updateError.textContent = t("update.error", {
        error: result.message ?? result.reason,
      });
      els.updateError.classList.remove("hidden");
    }
  })();
};

api.onUpdateAvailable((payload) => {
  showUpdateModal(payload);
});

api.onUpdateProgress((payload) => {
  if (els.modalUpdate.classList.contains("hidden")) return;
  updateModal.phase = "downloading";
  renderUpdateAction();
  setUpdateProgress(payload.percent);
});

api.onUpdateDownloaded((payload) => {
  updateModal.version = payload.version;
  updateModal.currentVersion = payload.currentVersion;
  updateModal.phase = "ready";
  els.updateLatest.textContent = payload.version;
  setUpdateProgress(100);
  els.updateProgressLabel.textContent = t("update.install");
  renderUpdateAction();
  els.modalUpdate.classList.remove("hidden");
});

api.onUpdateError((payload) => {
  if (els.modalUpdate.classList.contains("hidden")) return;
  updateModal.phase = "error";
  renderUpdateAction();
  els.updateError.textContent = t("update.error", { error: payload.message });
  els.updateError.classList.remove("hidden");
});

function handleShortcut(payload: {
  action: string;
  index?: number;
}): void {
  switch (payload.action) {
    case "new-local":
      void openLocal();
      break;
    case "close-tab":
      if (state.activeTabId) void closeTab(state.activeTabId);
      break;
    case "clear":
      clearActiveTerminal();
      break;
    case "prev-tab":
      focusRelativeTab(-1);
      break;
    case "next-tab":
      focusRelativeTab(1);
      break;
    case "focus-tab":
      if (typeof payload.index === "number") focusTabAt(payload.index);
      break;
    case "settings":
      openSettings();
      break;
    case "refit-terminals":
      requestAnimationFrame(() => refitTerminals());
      break;
    default:
      break;
  }
}

async function ensureActiveLocalTab(): Promise<TabView> {
  const active = state.activeTabId
    ? state.tabs.get(state.activeTabId)
    : undefined;
  if (active?.kind === "local") return active;
  for (const tab of state.tabs.values()) {
    if (tab.kind === "local") {
      activateTab(tab.id);
      return tab;
    }
  }
  await openLocal();
  const tab = state.activeTabId
    ? state.tabs.get(state.activeTabId)
    : undefined;
  if (!tab || tab.kind !== "local") throw new Error("No local terminal tab");
  return tab;
}

/** Show the xterm scrollbar only while content overflows and the user hovers/scrolls. */
function wireTerminalScrollbar(host: HTMLElement, term: Terminal): void {
  const viewport = host.querySelector(".xterm-viewport") as HTMLElement | null;
  if (!viewport) return;

  let scrollTimer: number | undefined;
  const syncOverflow = () => {
    const canScroll = viewport.scrollHeight > viewport.clientHeight + 1;
    host.classList.toggle("term-can-scroll", canScroll);
    if (!canScroll) host.classList.remove("term-scrolling");
  };
  const onScroll = () => {
    syncOverflow();
    if (!host.classList.contains("term-can-scroll")) return;
    host.classList.add("term-scrolling");
    if (scrollTimer) window.clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(() => {
      host.classList.remove("term-scrolling");
      scrollTimer = undefined;
    }, 700);
  };

  viewport.addEventListener("scroll", onScroll, { passive: true });
  term.onRender(() => syncOverflow());
  term.onResize(() => syncOverflow());
  requestAnimationFrame(syncOverflow);
}

function createTermTheme(): ConstructorParameters<typeof Terminal>[0] {
  return {
    cursorBlink: true,
    fontFamily: TERM_FONT_FAMILY,
    fontSize: TERM_FONT_SIZE,
    lineHeight: 1,
    letterSpacing: 0,
    customGlyphs: false,
    rescaleOverlappingGlyphs: true,
    // Required to set term.unicode.activeVersion (Hangul width).
    allowProposedApi: true,
    theme: {
      background: "#0c0e12",
      foreground: "#d7dde6",
      cursor: "#5b9fd4",
      cursorAccent: "#0c0e12",
      selectionBackground: "rgba(91, 159, 212, 0.28)",
      black: "#1a1f28",
      red: "#d97884",
      green: "#3dbf7a",
      yellow: "#d4a35a",
      blue: "#5b9fd4",
      magenta: "#a78bfa",
      cyan: "#4ecdc4",
      white: "#d7dde6",
      brightBlack: "#6b7382",
      brightRed: "#e8a0a8",
      brightGreen: "#6fd49a",
      brightYellow: "#e0b87a",
      brightBlue: "#7eb6e0",
      brightMagenta: "#c4b5fd",
      brightCyan: "#7dddd7",
      brightWhite: "#f2f4f7",
    },
  };
}

function mountTabView(
  tabId: string,
  title: string,
  kind: "local" | "ssh"
): TabView {
  const el = document.createElement("div");
  el.style.height = "100%";
  els.terminalHost.append(el);

  const term = new Terminal(createTermTheme());
  const fit = new FitAddon();
  const unicode11 = new Unicode11Addon();
  term.loadAddon(fit);
  term.loadAddon(unicode11);
  term.loadAddon(new WebLinksAddon());
  term.open(el);
  try {
    // Hangul etc. must be width 2 like macOS zsh wcwidth, or wraps corrupt the prompt.
    term.unicode.activeVersion = "11";
  } catch (err) {
    console.warn("unicode11 activate failed", err);
  }
  wireTerminalScrollbar(el, term);

  term.onData((data) => {
    void api.writeTerminal(tabId, data);
  });

  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== "keydown") return true;
    const mod = ev.metaKey || ev.ctrlKey;
    if (!mod || ev.altKey) return true;
    const key = ev.key.toLowerCase();
    if (key === "k" && !ev.shiftKey) {
      term.clear();
      return false;
    }
    if (key === "c" && !ev.shiftKey && term.hasSelection()) {
      void navigator.clipboard.writeText(term.getSelection());
      return false;
    }
    return true;
  });

  const view: TabView = {
    id: tabId,
    title,
    kind,
    term,
    fit,
    el,
    lastCols: 0,
    lastRows: 0,
  };
  state.tabs.set(tabId, view);
  activateTab(tabId);
  return view;
}

async function waitFrames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }
}

async function openLocal(): Promise<void> {
  try {
    await ensureTermFont();
    const created = await api.createLocalTab();
    const view = mountTabView(created.tabId, created.title, "local");
    // Fit the real tab xterm, then start the PTY at that exact size — no later SIGWINCH
    // before the first prompt (that was wiping agnoster on the first long wrap).
    await waitFrames(2);
    view.fit.fit();
    const cols = Math.max(20, view.term.cols);
    const rows = Math.max(5, view.term.rows);
    view.lastCols = cols;
    view.lastRows = rows;
    view.sizeFreezeUntil = Date.now() + 2500;
    const started = await api.startLocalPty(created.tabId, { cols, rows });
    if ("error" in started) {
      chat.addError(`Local PTY error: ${started.error}`);
      await closeTab(created.tabId);
      return;
    }
    await api.readyTerminal(created.tabId);
  } catch (err) {
    chat.addError(
      `Local terminal failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function openSsh(sessionId: string): Promise<void> {
  await ensureTermFont();
  await waitFrames(1);
  const probeEl = document.createElement("div");
  probeEl.style.height = "100%";
  els.terminalHost.append(probeEl);
  const probeTerm = new Terminal(createTermTheme());
  const probeFit = new FitAddon();
  probeTerm.loadAddon(probeFit);
  probeTerm.open(probeEl);
  probeFit.fit();
  const size = {
    cols: Math.max(20, probeTerm.cols),
    rows: Math.max(5, probeTerm.rows),
  };
  probeTerm.dispose();
  probeEl.remove();

  const res = await api.openSsh(sessionId, size);
  if ("error" in res) {
    chat.addError(`SSH error: ${res.error}`);
    return;
  }
  const view = mountTabView(res.tabId, res.title, "ssh");
  view.lastCols = size.cols;
  view.lastRows = size.rows;
  view.sizeFreezeUntil = Date.now() + 2500;
  if (res.label) {
    view.term.writeln(`\x1b[90mConnecting ssh ${res.label}…\x1b[0m`);
  }
  await api.readyTerminal(res.tabId);
  setNav("files");
}

/** Escape a path for zsh/bash so spaces and quotes survive. */
function shellQuote(path: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(path)) return path;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

async function closeTab(tabId: string): Promise<void> {
  const tab = state.tabs.get(tabId);
  if (!tab) return;
  if (tab.fitTimer != null) window.clearTimeout(tab.fitTimer);
  tab.term.dispose();
  tab.el.remove();
  state.tabs.delete(tabId);
  tabCwds.delete(tabId);
  await api.closeTab(tabId);
  const next = state.tabs.keys().next().value as string | undefined;
  state.activeTabId = next ?? null;
  if (next) activateTab(next);
  else {
    renderTabs();
    void syncFilesPanel(true);
  }
}

function showApproval(payload: {
  runId: string;
  tabId: string;
  action: ProposedAction;
}): void {
  state.pendingApproval = payload;
  if (state.startedAssistant) {
    chat.finishAssistant({
      tokens: state.turnTokens ?? undefined,
      modelId: state.turnModel ?? undefined,
      cost: state.turnCost ?? undefined,
    });
    state.startedAssistant = false;
  }
  chat.setThinking(false);
  chat.addApproval({ runId: payload.runId, action: payload.action }, (d) => {
    void resolveApproval(d);
  });
}

async function resolveApproval(
  decision: "allow-once" | "allow-session" | "deny"
): Promise<void> {
  const pending = state.pendingApproval;
  if (!pending) return;
  state.pendingApproval = null;
  chat.resolveApprovalCard(decision);
  if (decision !== "deny") {
    chat.setThinking(true, t("thinking.running"));
  }
  await api.resolveApproval({
    runId: pending.runId,
    decision:
      decision === "deny"
        ? { type: "deny" }
        : decision === "allow-session"
          ? { type: "allow-session" }
          : { type: "allow-once" },
  });
}

let filesServerTabId: string | null = null;

const filesBrowser = createFilesBrowser({
  root: document.getElementById("files-panel")!,
  listLocal: (dirPath) => api.listDir(dirPath),
  listServer: async (dirPath) => {
    if (!filesServerTabId) {
      return { path: "", entries: [], error: "No SSH tab" };
    }
    return api.listTabDir(filesServerTabId, dirPath);
  },
  onLocalOpenDir: async (dirPath) => {
    const tab = await ensureActiveLocalTab();
    tabCwds.set(tab.id, dirPath);
    void filesBrowser.setLocalRoot(dirPath);
    await api.writeTerminal(tab.id, `cd ${shellQuote(dirPath)}\n`);
    tab.term.focus();
  },
  onLocalInsertPath: async (filePath) => {
    const tab = await ensureActiveLocalTab();
    await api.writeTerminal(tab.id, shellQuote(filePath));
    tab.term.focus();
  },
  onServerOpenDir: async (dirPath) => {
    if (!filesServerTabId) return;
    const tab = state.tabs.get(filesServerTabId);
    if (!tab) return;
    tabCwds.set(tab.id, dirPath);
    void filesBrowser.setServer({
      enabled: true,
      label: tab.title,
      rootPath: dirPath,
    });
    activateTab(tab.id);
    await api.writeTerminal(tab.id, `cd ${shellQuote(dirPath)}\n`);
    tab.term.focus();
  },
  onServerInsertPath: async (filePath) => {
    if (!filesServerTabId) return;
    const tab = state.tabs.get(filesServerTabId);
    if (!tab) return;
    activateTab(tab.id);
    await api.writeTerminal(tab.id, shellQuote(filePath));
    tab.term.focus();
  },
  resolveDropPaths: (files) => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      const p = api.getPathForFile(file).trim();
      if (!p || seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
    return out;
  },
  onLocalImport: (destDir, sources, transferId) =>
    api.copyFilesInto(destDir, sources, transferId),
  onServerImport: async (destDir, sources, transferId) => {
    if (!filesServerTabId) {
      return { error: "No SSH tab" };
    }
    return api.uploadFilesToTab(
      filesServerTabId,
      destDir,
      sources,
      transferId
    );
  },
  onServerDownload: async (sources, destDir, transferId) => {
    if (!filesServerTabId) {
      return { error: "No SSH tab" };
    }
    return api.downloadFilesFromTab(
      filesServerTabId,
      destDir,
      sources,
      transferId
    );
  },
  onLocalRename: (fromPath, toPath) => api.renamePath(fromPath, toPath),
  onLocalDelete: (targetPath) => api.deletePath(targetPath),
  onServerRename: async (fromPath, toPath) => {
    if (!filesServerTabId) return { error: "No SSH tab" };
    return api.renameTabPath(filesServerTabId, fromPath, toPath);
  },
  onServerDelete: async (targetPath) => {
    if (!filesServerTabId) return { error: "No SSH tab" };
    return api.deleteTabPath(filesServerTabId, targetPath);
  },
  onTransferProgress: (cb) => api.onTransferProgress(cb),
});

function resolveServerTab(): TabView | null {
  // Server tree follows only the active SSH tab — hide it on local tabs.
  const active = state.activeTabId
    ? state.tabs.get(state.activeTabId)
    : undefined;
  return active?.kind === "ssh" ? active : null;
}

function resolveLocalTab(): TabView | null {
  const active = state.activeTabId
    ? state.tabs.get(state.activeTabId)
    : undefined;
  if (active?.kind === "local") return active;
  for (const tab of state.tabs.values()) {
    if (tab.kind === "local") return tab;
  }
  return null;
}

async function cwdForTab(tabId: string): Promise<string | null> {
  const cached = tabCwds.get(tabId);
  if (cached) return cached;
  const res = await api.getTabCwd(tabId);
  if (res.cwd) tabCwds.set(tabId, res.cwd);
  return res.cwd;
}

async function applyCwdToFiles(tabId: string, cwd: string): Promise<void> {
  const tab = state.tabs.get(tabId);
  if (!tab || !cwd) return;
  tabCwds.set(tabId, cwd);
  if (state.activeTabId === tabId) updateStripPath();
  if (tab.kind === "local") {
    const follow = resolveLocalTab();
    if (follow?.id === tabId) {
      await filesBrowser.setLocalRoot(cwd);
    }
    return;
  }
  if (state.activeTabId === tabId) {
    filesServerTabId = tabId;
    await filesBrowser.setServer({
      enabled: true,
      label: tab.title,
      rootPath: cwd,
    });
  }
}

async function syncFilesPanel(_force = false): Promise<void> {
  const local = resolveLocalTab();
  if (local) {
    const cwd =
      (await cwdForTab(local.id)) ||
      (await api.getHomeDir());
    await filesBrowser.setLocalRoot(cwd);
  }

  const server = resolveServerTab();
  filesServerTabId = server?.id ?? null;
  if (!server) {
    await filesBrowser.setServer({
      enabled: false,
      label: "",
      message: t("files.serverEmpty"),
    });
    return;
  }
  const cwd = (await cwdForTab(server.id)) || "~";
  await filesBrowser.setServer({
    enabled: true,
    label: server.title,
    rootPath: cwd,
  });
}

// Wire UI
document.getElementById("btn-local")!.onclick = () => void openLocal();
document.getElementById("btn-add-ssh")!.onclick = () =>
  els.modalSsh.classList.remove("hidden");
document.getElementById("btn-cancel-ssh")!.onclick = () =>
  els.modalSsh.classList.add("hidden");
document.getElementById("btn-save-ssh")!.onclick = async () => {
  const name = (document.getElementById("ssh-name") as HTMLInputElement).value.trim();
  const host = (document.getElementById("ssh-host") as HTMLInputElement).value.trim();
  const user = (document.getElementById("ssh-user") as HTMLInputElement).value.trim();
  const portRaw = (document.getElementById("ssh-port") as HTMLInputElement).value;
  const identityFile = (document.getElementById("ssh-identity") as HTMLInputElement).value.trim();
  const proxyJump = (document.getElementById("ssh-jump") as HTMLInputElement).value.trim();
  const startDir = (document.getElementById("ssh-dir") as HTMLInputElement).value.trim();
  if (!name || !host || !user) return;
  await api.saveSession({
    name,
    host,
    user,
    port: portRaw ? Number(portRaw) : undefined,
    identityFile: identityFile || undefined,
    proxyJump: proxyJump || undefined,
    startDir: startDir || undefined,
  });
  els.modalSsh.classList.add("hidden");
  await refreshSessions();
};
const importSshStatus = document.getElementById("import-ssh-status")!;
let importSshStatusTimer: number | undefined;

function flashImportStatus(message: string, kind: "ok" | "muted" = "ok"): void {
  importSshStatus.textContent = message;
  importSshStatus.classList.toggle("muted", kind === "muted");
  importSshStatus.classList.remove("hidden");
  if (importSshStatusTimer != null) window.clearTimeout(importSshStatusTimer);
  importSshStatusTimer = window.setTimeout(() => {
    importSshStatus.classList.add("hidden");
  }, 3200);
}

document.getElementById("btn-import-ssh")!.onclick = async () => {
  const btn = document.getElementById("btn-import-ssh") as HTMLButtonElement;
  btn.disabled = true;
  try {
    const result = await api.importSshConfig();
    await refreshSessions();
    if (result.missingConfig) {
      flashImportStatus(t("ssh.importMissing"), "muted");
    } else if (result.found === 0) {
      flashImportStatus(t("ssh.importEmpty"), "muted");
    } else if (result.created === 0) {
      flashImportStatus(t("ssh.importUpdated", { count: String(result.updated) }));
    } else {
      flashImportStatus(
        t("ssh.importOk", {
          created: String(result.created),
          total: String(result.found),
        })
      );
    }
  } catch (err) {
    flashImportStatus(
      t("ssh.importFail", {
        error: err instanceof Error ? err.message : String(err),
      }),
      "muted"
    );
  } finally {
    btn.disabled = false;
  }
};

document.querySelectorAll<HTMLButtonElement>(".rail-btn[data-nav]").forEach((btn) => {
  btn.onclick = () => {
    const id = btn.dataset.nav as NavId | undefined;
    if (id) setNav(id);
  };
});

els.stripPath.onclick = () => setNav("files");
els.btnStripStop.onclick = () => {
  if (!state.activeTabId) return;
  void api.writeTerminal(state.activeTabId, "\u0003");
};

api.onShortcut((payload) => handleShortcut(payload));

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && closeTopModal()) {
    e.preventDefault();
  }
});
document.getElementById("btn-save-key")!.onclick = async () => {
  await api.setApiKey(els.apiKeyInput.value);
  els.apiKeyInput.value = "";
  const status = await api.getApiKeyStatus();
  setKeyBadge(status.hasKey);
  chat.addSystem(t("settings.keySaved"));
  await refreshModels();
};
document.getElementById("btn-clear-key")!.onclick = async () => {
  await api.clearApiKey();
  setKeyBadge(false);
  chat.addSystem(t("settings.keyCleared"));
};
els.settingsLocale.onchange = () => {
  void applyLocale(normalizeLocale(els.settingsLocale.value));
};
document.getElementById("btn-refresh-models")!.onclick = () =>
  void refreshModels();
els.settingsModelSelect.onchange = () =>
  void applyModel(els.settingsModelSelect.value);

els.btnModel.onclick = (e) => {
  e.stopPropagation();
  if (els.modelPopover.classList.contains("hidden")) openModelPopover();
  else closeModelPopover();
};
els.modelPopover.addEventListener("click", (e) => e.stopPropagation());
els.modelList.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest(
    "[data-model-id]"
  ) as HTMLElement | null;
  if (!btn?.dataset.modelId) return;
  void applyModel(btn.dataset.modelId);
});
els.modelSearch.addEventListener("input", () => {
  renderModelPicker(els.modelSearch.value);
});
els.modelSearch.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    closeModelPopover();
  }
});

function hideModeTip(): void {
  els.modeTip.classList.add("hidden");
  els.modeTip.textContent = "";
}

function showModeTip(btn: HTMLElement): void {
  const key = btn.dataset.descKey;
  if (!key) {
    hideModeTip();
    return;
  }
  els.modeTip.textContent = t(key);
  els.modeTip.classList.remove("hidden");
  const pop = els.modePopover.getBoundingClientRect();
  const row = btn.getBoundingClientRect();
  els.modeTip.style.top = `${row.top - pop.top + row.height / 2}px`;
}

els.btnMode.onclick = (e) => {
  e.stopPropagation();
  closeModelPopover();
  hideModeTip();
  const open = els.modePopover.classList.toggle("hidden") === false;
  els.btnMode.setAttribute("aria-expanded", open ? "true" : "false");
};
els.modePopover.addEventListener("click", (e) => {
  e.stopPropagation();
  const btn = (e.target as HTMLElement).closest(
    "[data-mode]"
  ) as HTMLElement | null;
  if (!btn?.dataset.mode) return;
  void applyChatMode(btn.dataset.mode as ChatMode);
});
els.modePopover.addEventListener("mouseover", (e) => {
  const btn = (e.target as HTMLElement).closest(
    "[data-mode]"
  ) as HTMLElement | null;
  if (!btn) {
    hideModeTip();
    return;
  }
  showModeTip(btn);
});
els.modePopover.addEventListener("mouseleave", () => hideModeTip());
document.addEventListener("click", () => {
  els.modePopover.classList.add("hidden");
  els.btnMode.setAttribute("aria-expanded", "false");
  hideModeTip();
  closeModelPopover();
});
let navCollapsed = false;
let agentCollapsed = false;

function applyPanelLayout(): void {
  const layout = document.querySelector(".layout");
  layout?.classList.toggle("nav-collapsed", navCollapsed);
  layout?.classList.toggle("agent-collapsed", agentCollapsed);
  const navBtn = document.getElementById("btn-toggle-nav");
  const agentBtn = document.getElementById("btn-toggle-agent");
  navBtn?.setAttribute("aria-pressed", navCollapsed ? "false" : "true");
  agentBtn?.setAttribute("aria-pressed", agentCollapsed ? "false" : "true");
  navBtn?.classList.toggle("active", !navCollapsed);
  agentBtn?.classList.toggle("active", !agentCollapsed);
  try {
    localStorage.setItem("drift.navCollapsed", navCollapsed ? "1" : "0");
    localStorage.setItem(
      "drift.agentCollapsed",
      agentCollapsed ? "1" : "0"
    );
  } catch {
    /* ignore */
  }
  requestAnimationFrame(() => refitTerminals());
}

try {
  navCollapsed = localStorage.getItem("drift.navCollapsed") === "1";
  agentCollapsed = localStorage.getItem("drift.agentCollapsed") === "1";
} catch {
  /* ignore */
}
applyPanelLayout();

document.getElementById("btn-toggle-nav")!.onclick = () => {
  navCollapsed = !navCollapsed;
  applyPanelLayout();
};
document.getElementById("btn-toggle-agent")!.onclick = () => {
  agentCollapsed = !agentCollapsed;
  applyPanelLayout();
};

document.getElementById("btn-new-chat")!.onclick = () => {
  if (state.generating) return;
  chat.clear();
  state.startedAssistant = false;
};

els.chatThread.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest(
    "[data-suggest]"
  ) as HTMLElement | null;
  if (!btn?.dataset.suggest) return;
  els.agentInput.value = btn.dataset.suggest;
  els.agentInput.focus();
});

async function sendCurrentPrompt(): Promise<void> {
  if (state.generating) return;
  if (!state.activeTabId) {
    chat.addError(t("error.openTab"));
    return;
  }
  const message = els.agentInput.value.trim();
  if (!message) return;
  els.agentInput.value = "";
  autoGrowInput();
  chat.addUser(message);
  state.startedAssistant = false;
  state.turnTokens = null;
  state.turnModel = state.modelId;
  state.turnCost = null;
  setGenerating(true);
  chat.setThinking(true, t("thinking"));
  const res = await api.sendAgent({ tabId: state.activeTabId, message });
  if ("error" in res) {
    chat.setThinking(false);
    chat.addError(res.error);
    setGenerating(false);
  }
}

function autoGrowInput(): void {
  const el = els.agentInput;
  el.style.height = "auto";
  el.style.height = `${Math.min(180, Math.max(64, el.scrollHeight))}px`;
}

els.btnSend.onclick = () => void sendCurrentPrompt();
els.agentInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void sendCurrentPrompt();
  }
});
els.agentInput.addEventListener("input", autoGrowInput);

api.onTerminalData(({ tabId, data }) => {
  state.tabs.get(tabId)?.term.write(data);
});

api.onTerminalCwd(({ tabId, cwd }) => {
  void applyCwdToFiles(tabId, cwd);
});

api.onAgentEvent(({ event }) => {
  if (event.type === "text") {
    chat.setThinking(false);
    if (!state.startedAssistant) {
      chat.beginAssistant();
      state.startedAssistant = true;
    }
    chat.appendAssistant(event.text);
  }
  if (event.type === "usage") {
    state.lastUsage = event.usage;
    state.lastCostCents = event.cost?.chargedCents ?? null;
    state.turnTokens = event.usage.totalTokens;
    state.turnModel = event.modelId ?? state.modelId;
    state.turnCost = event.cost
      ? formatCents(event.cost.chargedCents)
      : null;
    renderUsage();
  }
  if (event.type === "status") {
    if (event.status === "waiting-approval") {
      chat.setThinking(true, t("thinking.approval"));
    }
    if (event.status === "error") {
      chat.setThinking(false);
      if (state.startedAssistant) {
        chat.finishAssistant();
        state.startedAssistant = false;
      }
      chat.addError(event.detail || "unknown error");
      setGenerating(false);
    }
    if (event.status === "done") {
      chat.setThinking(false);
      if (state.startedAssistant) {
        chat.finishAssistant({
          tokens: state.turnTokens ?? undefined,
          modelId: state.turnModel ?? undefined,
          cost: state.turnCost ?? undefined,
        });
        state.startedAssistant = false;
      }
      setGenerating(false);
    }
    if (event.status === "running") {
      chat.setThinking(true, t("thinking"));
    }
  }
  if (event.type === "plan") {
    chat.setThinking(false);
    chat.addPlan(event.steps);
  }
  if (event.type === "propose") {
    // approval card arrives via onApprovalRequest
  }
});

api.onUsageUpdated(({ last, session }) => {
  state.lastUsage = last.usage;
  state.lastCostCents = last.cost?.chargedCents ?? null;
  state.sessionUsage = session;
  renderUsage();
});

api.onApprovalRequest((payload) => showApproval(payload));

window.addEventListener("resize", () => {
  if (!state.activeTabId) return;
  const tab = state.tabs.get(state.activeTabId);
  if (!tab) return;
  scheduleTerminalFit(tab);
});

void (async () => {
  await ensureTermFont();
  const settings = await api.getSettings();
  state.modelId = settings.modelId;
  state.chatMode = settings.chatMode ?? "agent";
  state.locale = normalizeLocale(settings.locale);
  setLocale(state.locale);
  const status = await api.getApiKeyStatus();
  state.hasKey = status.hasKey;
  state.sessionUsage = await api.getSessionUsage();
  applyUiLocale();
  renderUsage();
  await refreshModels();
  await refreshSessions();
  homeDirCache = await api.getHomeDir();
  await filesBrowser.setLocalRoot(homeDirCache);
  await syncFilesPanel();
  // Wait one frame so the terminal host has its final flex size.
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  await openLocal();
  refreshStatusStrip();
  void refreshStripMetrics();
  window.setInterval(() => void refreshStripMetrics(), 2500);
})();
