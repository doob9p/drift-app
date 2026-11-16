import "./styles.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { DesktopApi, SessionUsageView } from "../../electron/preload";
import type {
  ChatMode,
  LocalShellId,
  ModelOption,
  ProposedAction,
  SavedSession,
  TokenUsageSnapshot,
} from "@drift/core";
import { createChatController, type ChatController } from "./chat.js";
import {
  applyDomI18n,
  normalizeLocale,
  setLocale,
  t,
  type AppLocale,
} from "./i18n.js";
import { icons } from "./icons.js";
import { createEditorPane } from "./editor-pane.js";
import { createFilesBrowser } from "./files-tree.js";
import {
  createMeetingPane,
  type MeetingPaneController,
} from "./meeting-pane.js";
import {
  isApiKeyError,
  openCursorApiKeysPage,
} from "./cursor-api-key.js";
import { showToast } from "./toast.js";
import {
  createBoardPane,
  MAX_PROMPT_SUBS,
  type BoardPane,
} from "./board-pane.js";
import type {
  BoardFocus,
  BoardPersistedState,
  PromptCard,
  TerminalCard,
} from "./board-types.js";

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

type MeetingMetaView = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  durationMs: number;
  status: "idle" | "recording" | "paused" | "done";
  hasAudio: boolean;
  hasTranscript: boolean;
  hasNotes: boolean;
  hasSummary: boolean;
};

const meetingState = {
  list: [] as MeetingMetaView[],
  activeId: null as string | null,
  pane: null as MeetingPaneController | null,
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

const splashStartedAt = performance.now();
const SPLASH_MIN_MS = 700;
let splashPercent = 0;

/** Boot milestones — not wall-clock ETA, just weighted steps that fill 0→100. */
const SPLASH_AT = {
  start: 4,
  fonts: 14,
  settings: 32,
  models: 52,
  sessions: 68,
  files: 84,
  terminal: 96,
  ready: 100,
} as const;

let splashHeldForUpdate = false;

function setSplashProgress(
  percent: number,
  message?: string,
  opts?: { absolute?: boolean }
): void {
  const next = Math.min(100, Math.round(percent));
  splashPercent = opts?.absolute ? next : Math.max(splashPercent, next);
  const fill = document.getElementById("app-splash-fill");
  const bar = document.getElementById("app-splash-bar");
  const pct = document.getElementById("app-splash-pct");
  const status = document.getElementById("app-splash-status");
  if (fill) fill.style.width = `${splashPercent}%`;
  if (bar) bar.setAttribute("aria-valuenow", String(splashPercent));
  if (pct) pct.textContent = `${splashPercent}%`;
  if (message && status) status.textContent = message;
}

async function dismissSplash(): Promise<void> {
  const root = document.getElementById("app-splash");
  if (!root || root.classList.contains("is-done")) return;
  // Keep the intro visible when an update is already on screen.
  if (splashHeldForUpdate || root.classList.contains("is-updating")) return;
  setSplashProgress(100);
  const wait = Math.max(0, SPLASH_MIN_MS - (performance.now() - splashStartedAt));
  if (wait > 0) await new Promise((r) => window.setTimeout(r, wait));
  // Let the bar finish its CSS width transition before fading out.
  await new Promise((r) => window.setTimeout(r, 180));
  root.classList.add("is-done");
  root.setAttribute("aria-busy", "false");
}

const state = {
  sessions: [] as SavedSession[],
  tabs: new Map<string, TabView>(),
  activeTabId: null as string | null,
  hasKey: false,
  modelId: "composer-2.5",
  chatMode: "agent" as ChatMode,
  locale: "ko" as AppLocale,
  localShell: "powershell" as LocalShellId,
  models: [] as ModelOption[],
  lastUsage: null as TokenUsageSnapshot | null,
  lastCostCents: null as number | null,
  sessionUsage: null as SessionUsageView | null,
  generating: false,
  activeRunId: null as string | null,
  turnTokens: null as number | null,
  turnModel: null as string | null,
  turnCost: null as string | null,
  startedAssistant: false,
};

type NavId = "sessions" | "files" | "meetings" | "settings";
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
        <div class="strip-metric hidden" id="strip-api" data-i18n-title="strip.apiTitle" title="Cursor usage remaining">
          <span class="strip-metric-ico">${icons.sparkles(13)}</span>
          <span class="strip-metric-label" data-i18n="strip.api">Cursor</span>
          <span class="strip-bar"><span id="strip-api-bar"></span></span>
          <span class="strip-metric-val" id="strip-api-val">—</span>
        </div>
      </div>
    </header>

    <div class="layout">
      <nav class="rail" aria-label="Workspace">
        <div class="rail-top">
          <div class="rail-brand" title="Drift" aria-hidden="true">
            <img class="rail-brand-mark" src="./brand/logo-mark.png" alt="" width="22" height="13" draggable="false" />
          </div>
          <div class="rail-group">
            <button type="button" class="rail-btn active" data-nav="sessions" data-i18n-title="nav.sessions" title="Sessions" aria-label="Sessions">${icons.server(17)}</button>
            <button type="button" class="rail-btn" data-nav="files" data-i18n-title="nav.files" title="Files" aria-label="Files">${icons.folder(17)}</button>
          </div>
        </div>
        <div class="rail-group rail-group-bottom">
          <button type="button" class="rail-btn" data-nav="meetings" data-i18n-title="nav.meetings" title="Meetings" aria-label="Meetings">${icons.mic(17)}</button>
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
          </div>
          <div class="section-label"><span data-i18n="sidebar.ssh">Hosts</span></div>
          <div class="session-empty" id="session-empty" data-i18n-html="sidebar.empty"></div>
          <ul class="session-list" id="session-list"></ul>
        </section>

        <section class="nav-view hidden" data-view="meetings">
          <div class="sidebar-tools">
            <button class="primary" id="btn-new-meeting">
              ${icons.mic(14)}
              <span data-i18n="sidebar.meeting">Start meeting</span>
            </button>
          </div>
          <div class="section-label"><span data-i18n="meeting.list">Meetings</span></div>
          <div class="meeting-list-empty" id="meeting-list-empty" data-i18n="meeting.listEmpty">No meetings yet</div>
          <ul class="meeting-list" id="meeting-list"></ul>
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
                    <div class="files-pathbar">
                      <button type="button" class="icon ghost files-up" data-path-up data-i18n-title="files.up" title="Go up" aria-label="Go up">${icons.folderUp(12)}</button>
                      <nav class="files-path" aria-label="Path"></nav>
                    </div>
                    <div class="files-toolbar">
                      <label class="files-filter-wrap">
                        <span class="files-filter-ico">${icons.search(12)}</span>
                        <input class="files-filter" type="search" data-i18n-placeholder="files.filter" placeholder="Filter by name" />
                      </label>
                      <button type="button" class="icon ghost" data-show-hidden data-i18n-title="files.showHidden" title="Show hidden files" aria-pressed="false">${icons.eyeOff(12)}</button>
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
                  <span class="files-pane-title" data-i18n="files.local">This computer</span>
                  <span class="files-pane-host"></span>
                </button>
                <div class="files-pane-body">
                  <div class="files-pane-body-inner">
                    <div class="files-pathbar">
                      <button type="button" class="icon ghost files-up" data-path-up data-i18n-title="files.up" title="Go up" aria-label="Go up">${icons.folderUp(12)}</button>
                      <nav class="files-path" aria-label="Path"></nav>
                    </div>
                    <div class="files-toolbar">
                      <label class="files-filter-wrap">
                        <span class="files-filter-ico">${icons.search(12)}</span>
                        <input class="files-filter" type="search" data-i18n-placeholder="files.filter" placeholder="Filter by name" />
                      </label>
                      <button type="button" class="icon ghost" data-show-hidden data-i18n-title="files.showHidden" title="Show hidden files" aria-pressed="false">${icons.eyeOff(12)}</button>
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
            <p class="settings-lead" data-i18n="settings.lead">API key is encrypted in the OS keychain. Sessions never store secrets.</p>
            <div class="form-grid settings-form">
              <label>
                <span data-i18n="settings.apiKey">Cursor API key</span>
                <div class="settings-key-help" id="api-key-help">
                  <ol class="settings-key-steps">
                    <li data-i18n="settings.keyStep1">Open API Keys in the Cursor dashboard</li>
                    <li data-i18n="settings.keyStep2">Create a key and copy it once</li>
                    <li data-i18n="settings.keyStep3">Paste it below and save</li>
                  </ol>
                  <button type="button" class="settings-key-open" id="btn-open-api-keys" data-i18n="settings.openKeyPage">Open key page</button>
                </div>
                <div class="settings-key-row" id="api-key-unset">
                  <input id="api-key-input" type="password" autocomplete="off" placeholder="cursor_…" />
                  <button type="button" class="primary settings-key-save" id="btn-save-key" data-i18n="settings.save">Save</button>
                </div>
                <div class="settings-key-row hidden" id="api-key-set">
                  <button type="button" class="settings-key-clear" id="btn-clear-key" data-i18n-title="settings.clearKey" title="Delete">
                    <span class="settings-key-clear-idle" data-i18n="settings.keyConfigured">Configured</span>
                    <span class="settings-key-clear-hover" data-i18n="settings.clearKey">Delete</span>
                  </button>
                </div>
              </label>
              <label>
                <span data-i18n="settings.language">Language</span>
                <select id="settings-locale">
                  <option value="ko">한국어</option>
                  <option value="en">English</option>
                </select>
              </label>
              <label class="settings-shell hidden" id="settings-shell-row" hidden>
                <span data-i18n="settings.localShell">Local terminal</span>
                <select id="settings-local-shell">
                  <option value="powershell" data-i18n="settings.shell.powershell">PowerShell</option>
                  <option value="cmd" data-i18n="settings.shell.cmd">Command Prompt</option>
                  <option value="gitbash" data-i18n="settings.shell.gitbash">Git Bash</option>
                </select>
                <span class="settings-hint" data-i18n="settings.localShellHint"
                  >Applies to newly opened local terminals.</span
                >
              </label>
            </div>
          </div>
        </section>
      </aside>

      <div
        class="col-split"
        id="split-sidebar"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
      ></div>

      <section class="main">
        <div class="main-stage" id="main-stage">
          <div class="editor-pane hidden" id="editor-pane"></div>
          <div class="main-split hidden" id="main-split" role="separator" aria-orientation="horizontal"></div>
          <div class="board-stage" id="board-stage"></div>
          <div class="meeting-stage hidden" id="meeting-stage">
            <div class="meeting-stage-empty" id="meeting-stage-empty">
              <div class="meeting-stage-empty-ico">${icons.mic(28)}</div>
              <p data-i18n="meeting.stageEmpty">Start a meeting from the sidebar</p>
            </div>
            <div class="meeting-stage-host" id="meeting-stage-host"></div>
          </div>
        </div>
      </section>
    </div>
  </div>
  <div class="mention-menu hidden" id="mention-menu" role="listbox"></div>

  <div class="toast-host" id="toast-host" aria-live="polite"></div>

  <div class="modal-backdrop hidden" id="modal-ssh">
    <div class="modal modal-ssh">
      <header class="ssh-modal-head">
        <h2 id="ssh-modal-title" data-i18n="ssh.title">SSH session</h2>
      </header>
      <input type="hidden" id="ssh-edit-id" value="" />
      <section class="ssh-section">
        <div class="form-grid two">
          <label>
            <span class="field-label"
              ><span data-i18n="ssh.name">Name</span
              ><abbr class="req" data-i18n-title="ssh.required" title="Required">*</abbr></span
            >
            <input id="ssh-name" placeholder="prod-gpu" required autocomplete="off" />
          </label>
          <label>
            <span class="field-label"
              ><span data-i18n="ssh.host">Host</span
              ><abbr class="req" data-i18n-title="ssh.required" title="Required">*</abbr></span
            >
            <input id="ssh-host" placeholder="192.168.1.10" required autocomplete="off" />
          </label>
          <label>
            <span class="field-label"
              ><span data-i18n="ssh.user">User</span
              ><abbr class="req" data-i18n-title="ssh.required" title="Required">*</abbr></span
            >
            <input id="ssh-user" placeholder="ubuntu" required autocomplete="off" />
          </label>
          <label>
            <span class="field-label" data-i18n="ssh.port">Port</span>
            <input id="ssh-port" type="number" placeholder="22" autocomplete="off" />
          </label>
        </div>
        <div class="ssh-password-field">
          <span class="field-label" data-i18n="ssh.password">Password</span>
          <div class="ssh-password-row" id="ssh-password-unset">
            <input
              id="ssh-password"
              type="password"
              autocomplete="new-password"
              spellcheck="false"
              data-i18n-placeholder="ssh.passwordPlaceholder"
              placeholder="Stored encrypted on this device"
            />
            <button
              type="button"
              class="primary settings-key-save hidden"
              id="btn-ssh-password-save"
              data-i18n="ssh.passwordSave"
            >Save</button>
          </div>
          <div class="ssh-password-row hidden" id="ssh-password-set">
            <button
              type="button"
              class="settings-key-clear"
              id="btn-ssh-password-clear"
              data-i18n-title="ssh.passwordClear"
              title="Delete"
            >
              <span class="settings-key-clear-idle" data-i18n="ssh.passwordSaved">Saved</span>
              <span class="settings-key-clear-hover" data-i18n="ssh.passwordClear">Delete</span>
            </button>
          </div>
        </div>
      </section>
      <details class="ssh-fold" id="ssh-advanced">
        <summary data-i18n="ssh.advanced">Advanced</summary>
        <div class="form-grid ssh-fold-body">
          <label><span data-i18n="ssh.dir">Start dir</span> <input id="ssh-dir" placeholder="/home/ubuntu" /></label>
          <label><span data-i18n="ssh.jump">ProxyJump</span> <input id="ssh-jump" placeholder="bastion" /></label>
        </div>
      </details>
      <div class="actions">
        <button class="ghost" id="btn-cancel-ssh" data-i18n="ssh.cancel">Cancel</button>
        <button class="primary" id="btn-save-ssh" data-i18n="ssh.save">Save session</button>
      </div>
    </div>
  </div>

  <div id="composer-popovers" class="composer-popovers-host" aria-hidden="true">
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
    <div class="model-popover hidden" id="model-popover">
      <div class="model-search">
        ${icons.search(14)}
        <input id="model-search" type="search" data-i18n-placeholder="model.search" placeholder="Search models" autocomplete="off" />
      </div>
      <div class="model-list" id="model-list" role="listbox"></div>
    </div>
  </div>

`;

const els = {
  sessionList: document.getElementById("session-list")!,
  sessionEmpty: document.getElementById("session-empty")!,
  boardStage: document.getElementById("board-stage")!,
  meetingStage: document.getElementById("meeting-stage")!,
  meetingStageHost: document.getElementById("meeting-stage-host")!,
  meetingStageEmpty: document.getElementById("meeting-stage-empty")!,
  meetingList: document.getElementById("meeting-list")!,
  meetingListEmpty: document.getElementById("meeting-list-empty")!,
  mentionMenu: document.getElementById("mention-menu")!,
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
  stripApi: document.getElementById("strip-api")!,
  stripApiBar: document.getElementById("strip-api-bar")!,
  stripApiVal: document.getElementById("strip-api-val")!,
  modalSsh: document.getElementById("modal-ssh")!,
  splashUpdate: document.getElementById("app-splash-update")!,
  splashUpdateTitle: document.getElementById("app-splash-update-title")!,
  splashUpdateLead: document.getElementById("app-splash-update-lead")!,
  splashUpdateCurrentLabel: document.getElementById(
    "app-splash-update-current-label"
  )!,
  splashUpdateLatestLabel: document.getElementById(
    "app-splash-update-latest-label"
  )!,
  splashUpdateCurrent: document.getElementById("app-splash-update-current")!,
  splashUpdateLatest: document.getElementById("app-splash-update-latest")!,
  splashUpdateNotes: document.getElementById("app-splash-update-notes")!,
  splashUpdateError: document.getElementById("app-splash-update-error")!,
  btnSplashUpdateLater: document.getElementById(
    "btn-splash-update-later"
  ) as HTMLButtonElement,
  btnSplashUpdateAction: document.getElementById(
    "btn-splash-update-action"
  ) as HTMLButtonElement,
  apiKeyInput: document.getElementById("api-key-input") as HTMLInputElement,
  apiKeyUnset: document.getElementById("api-key-unset")!,
  apiKeySet: document.getElementById("api-key-set")!,
  apiKeyHelp: document.getElementById("api-key-help")!,
  btnSaveKey: document.getElementById("btn-save-key") as HTMLButtonElement,
  btnClearKey: document.getElementById("btn-clear-key") as HTMLButtonElement,
  btnOpenApiKeys: document.getElementById(
    "btn-open-api-keys"
  ) as HTMLButtonElement,
  modelPopover: document.getElementById("model-popover")!,
  modelSearch: document.getElementById("model-search") as HTMLInputElement,
  modelList: document.getElementById("model-list")!,
  settingsLocale: document.getElementById("settings-locale") as HTMLSelectElement,
  settingsShellRow: document.getElementById("settings-shell-row") as HTMLElement,
  settingsLocalShell: document.getElementById(
    "settings-local-shell"
  ) as HTMLSelectElement,
  modePopover: document.getElementById("mode-popover")!,
  modeTip: document.getElementById("mode-tip")!,
  composerPopovers: document.getElementById("composer-popovers")!,
};

const promptChats = new Map<string, ChatController>();
let activePromptCardId: string | null = null;
const runToPrompt = new Map<string, string>();
const generatingCards = new Set<string>();
type RunTurnState = {
  startedAssistant: boolean;
  turnTokens: number | null;
  turnModel: string | null;
  turnCost: string | null;
};
const runTurns = new Map<string, RunTurnState>();
let boardSaveTimer: number | undefined;
let board!: BoardPane;
let mentionCardId: string | null = null;

function isCardGenerating(cardId: string): boolean {
  return generatingCards.has(cardId);
}

function runIdForCard(cardId: string): string | null {
  for (const [runId, cid] of runToPrompt) {
    if (cid === cardId) return runId;
  }
  return null;
}

function ensureRunTurn(runId: string): RunTurnState {
  let turn = runTurns.get(runId);
  if (!turn) {
    turn = {
      startedAssistant: false,
      turnTokens: null,
      turnModel: state.modelId,
      turnCost: null,
    };
    runTurns.set(runId, turn);
  }
  return turn;
}

const pendingApprovalsByRun = new Map<
  string,
  { runId: string; tabId: string; action: ProposedAction }
>();

function clearRun(runId: string | null | undefined): void {
  if (!runId) return;
  runToPrompt.delete(runId);
  runTurns.delete(runId);
  pendingApprovalsByRun.delete(runId);
  if (state.activeRunId === runId) state.activeRunId = null;
}

const noopChat: ChatController = {
  clear: () => {},
  showEmpty: () => {},
  addUser: () => {},
  beginAssistant: () => {},
  appendAssistant: () => {},
  finishAssistant: () => {},
  setThinking: () => {},
  setActivity: () => {},
  addSystem: () => {},
  addError: (text, opts) => {
    showToast(text, "error");
    opts?.action?.onClick();
  },
  addPlan: () => {},
  addApproval: () => {},
  resolveApprovalCard: () => {},
  scrollToBottom: () => {},
};

function getPromptTabId(cardId: string): string {
  return board.findCard(cardId)?.tabId ?? "";
}

function activeChat(): ChatController | null {
  if (!activePromptCardId) return null;
  return promptChats.get(activePromptCardId) ?? null;
}

function activePromptInput(): HTMLDivElement | null {
  if (!activePromptCardId) return null;
  return board.getPromptEls(activePromptCardId)?.input ?? null;
}

function promptEls(cardId: string) {
  return board.getPromptEls(cardId);
}

function chatForRun(runId?: string | null): ChatController {
  const cardId = runId ? runToPrompt.get(runId) : undefined;
  if (cardId && promptChats.has(cardId)) return promptChats.get(cardId)!;
  return activeChat() ?? noopChat;
}

function scheduleBoardSave(): void {
  if (boardSaveTimer != null) window.clearTimeout(boardSaveTimer);
  boardSaveTimer = window.setTimeout(() => {
    boardSaveTimer = undefined;
    void api.saveBoard(board.toPersisted());
  }, 400);
}

const chat: ChatController = {
  clear: () => activeChat()?.clear(),
  showEmpty: (suggestions) => activeChat()?.showEmpty(suggestions),
  addUser: (text, refs) => activeChat()?.addUser(text, refs),
  beginAssistant: () => activeChat()?.beginAssistant(),
  appendAssistant: (chunk) => activeChat()?.appendAssistant(chunk),
  finishAssistant: (meta) => activeChat()?.finishAssistant(meta),
  setThinking: (on, label) => activeChat()?.setThinking(on, label),
  setActivity: (activity) => activeChat()?.setActivity(activity),
  addSystem: (text) => {
    const c = activeChat();
    if (c) c.addSystem(text);
  },
  addError: (text, opts) => {
    const c = activeChat();
    if (c) c.addError(text, opts);
    else showToast(text, "error");
  },
  addPlan: (steps) => activeChat()?.addPlan(steps),
  addApproval: (payload, onDecision) =>
    activeChat()?.addApproval(payload, onDecision),
  resolveApprovalCard: (decision) =>
    activeChat()?.resolveApprovalCard(decision),
  scrollToBottom: () => activeChat()?.scrollToBottom(),
};

const MODE_ICONS: Record<ChatMode, string> = {
  agent: icons.bot(14),
  plan: icons.list(14),
  ask: icons.message(14),
};

const CHECK_ICON = icons.check(12);

let modeAnchorBtn: HTMLButtonElement | null = null;
let modelAnchorBtn: HTMLButtonElement | null = null;

function renderModeChip(): void {
  const label = t(`mode.${state.chatMode}`);
  document.querySelectorAll("[data-mode-label]").forEach((el) => {
    el.textContent = label;
  });
  document.querySelectorAll("[data-mode-icon]").forEach((el) => {
    el.innerHTML = MODE_ICONS[state.chatMode];
  });
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

function syncModelChipLabels(): void {
  const label = currentModelLabel();
  document.querySelectorAll("[data-model-label]").forEach((el) => {
    el.textContent = label;
  });
}

async function syncLocalShellSettingsVisibility(): Promise<void> {
  try {
    const info = await api.listLocalShells();
    const onWindows = info.platform === "win32";
    els.settingsShellRow.classList.toggle("hidden", !onWindows);
    els.settingsShellRow.hidden = !onWindows;
    if (onWindows) {
      els.settingsLocalShell.value = state.localShell;
      for (const opt of Array.from(els.settingsLocalShell.options)) {
        const match = info.shells.find((s) => s.id === opt.value);
        if (!match) continue;
        opt.disabled = !match.available;
        if (!match.available && opt.selected) {
          els.settingsLocalShell.value = "powershell";
        }
      }
    }
  } catch {
    els.settingsShellRow.classList.add("hidden");
    els.settingsShellRow.hidden = true;
  }
}

function applyUiLocale(): void {
  applyDomI18n(document);
  renderModeChip();
  setKeyBadge(state.hasKey);
  refreshStatusStrip();
  els.settingsLocale.value = state.locale;
  if (!els.settingsShellRow.hidden) {
    els.settingsLocalShell.value = state.localShell;
  }
  if (board) {
    applyDomI18n(board.root);
    for (const card of board.getCards()) {
      if (card.kind !== "prompt") continue;
      const pe = board.getPromptEls(card.id);
      pe?.input.setAttribute("aria-label", t("chat.placeholder"));
    }
    for (const id of generatingCards) {
      board.setPromptSendBusy(id, true);
    }
  }
  hideMentionMenu();
  refreshChatEmptyIfNeeded();
  updateSessionEmpty();
  board?.syncEmpty();
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
  closeModePopover();
  chat.addSystem(t("mode.changed", { mode: t(`mode.${mode}`) }));
}

function updateSessionEmpty(): void {
  els.sessionEmpty.classList.toggle("hidden", state.sessions.length > 0);
}

function setGenerating(on: boolean, cardId?: string | null): void {
  const id = cardId ?? activePromptCardId;
  if (id) {
    if (on) generatingCards.add(id);
    else generatingCards.delete(id);
    board.setPromptSendBusy(id, on);
    const input = board.getPromptEls(id)?.input;
    if (input) {
      input.contentEditable = on ? "false" : "true";
      input.classList.toggle("is-disabled", on);
    }
  }
  state.generating = generatingCards.size > 0;
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

function syncApiKeySettingsUi(): void {
  const hasKey = state.hasKey;
  els.apiKeyUnset.classList.toggle("hidden", hasKey);
  els.apiKeySet.classList.toggle("hidden", !hasKey);
  els.apiKeyHelp.classList.toggle("hidden", hasKey);
  if (hasKey) els.apiKeyInput.value = "";
}

function setKeyBadge(hasKey: boolean): void {
  state.hasKey = hasKey;
  syncApiKeySettingsUi();
}

function updateStripPath(): void {
  if (activeNav === "meetings") {
    const title =
      meetingState.pane?.title ||
      meetingState.list.find((m) => m.id === meetingState.activeId)?.title ||
      t("nav.meetings");
    els.stripPathText.textContent = title;
    els.stripPath.title = title;
    syncPromptContexts();
    return;
  }
  const active = state.activeTabId
    ? state.tabs.get(state.activeTabId)
    : undefined;
  const cwd = active ? tabCwds.get(active.id) : undefined;
  const label = cwd ? formatStripPath(cwd) : active ? active.title : "—";
  els.stripPathText.textContent = label;
  els.stripPath.title = cwd || active?.title || "";
  syncPromptContexts();
}

function promptContextForTab(
  tabId: string
): { kind: string; path: string; title: string } {
  if (activeNav === "meetings") {
    const title =
      meetingState.pane?.title ||
      meetingState.list.find((m) => m.id === meetingState.activeId)?.title ||
      "";
    const sessionLabel = t("chat.context.meeting");
    return {
      kind: title ? sessionLabel : t("chat.context.none"),
      path: title,
      title: title
        ? `${sessionLabel} · ${title}`
        : t("chat.context.none"),
    };
  }
  const active = state.tabs.get(tabId);
  if (!active) {
    return {
      kind: t("chat.context.none"),
      path: "",
      title: t("chat.context.none"),
    };
  }
  const cwd = tabCwds.get(active.id);
  const pathLabel = cwd ? formatStripPath(cwd) : "";
  const sessionLabel =
    active.kind === "ssh"
      ? t("chat.context.sshSession", { name: active.title })
      : t("chat.context.localSession");
  const title = cwd ? `${sessionLabel} · ${cwd}` : sessionLabel;
  return { kind: sessionLabel, path: pathLabel, title };
}

function syncPromptContextForCard(cardId: string): void {
  const tabId = getPromptTabId(cardId);
  board.updatePromptContext(cardId, promptContextForTab(tabId));
}

function syncPromptContexts(): void {
  for (const card of board.getCards()) {
    if (card.kind === "prompt") syncPromptContextForCard(card.id);
  }
  refreshChatEmptyIfNeeded();
}

function pathBasename(p: string): string {
  const cleaned = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const i = cleaned.lastIndexOf("/");
  return i >= 0 ? cleaned.slice(i + 1) : cleaned;
}

type MentionItem = { path: string; name: string; kind: "file" | "dir" };

let mentionItems: MentionItem[] = [];
let mentionIndex = 0;
let mentionLoadToken = 0;
let cwdMentionCache: { key: string; items: MentionItem[] } | null = null;

type AtMentionState = {
  textNode: Text;
  atOffset: number;
  caretOffset: number;
  query: string;
};

function getAtMention(input: HTMLDivElement): AtMentionState | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!input.contains(range.startContainer)) return null;
  let textNode: Text | null = null;
  let caretOffset = 0;
  if (range.startContainer.nodeType === Node.TEXT_NODE) {
    textNode = range.startContainer as Text;
    caretOffset = range.startOffset;
  } else {
    return null;
  }
  const before = textNode.data.slice(0, caretOffset);
  const match = before.match(/(^|[\s\n\u200b])@([^\s@]*)$/);
  if (!match) return null;
  const query = match[2] ?? "";
  const atOffset = before.length - query.length - 1;
  return { textNode, atOffset, caretOffset, query };
}

function invalidateMentionCache(): void {
  cwdMentionCache = null;
}

async function loadCwdMentions(forTabId?: string | null): Promise<MentionItem[]> {
  const tabId = forTabId ?? state.activeTabId;
  const active = tabId ? state.tabs.get(tabId) : undefined;
  if (!active) return [];
  const cwd = tabCwds.get(active.id);
  if (!cwd) return [];
  const key = `${active.id}:${cwd}`;
  if (cwdMentionCache?.key === key) return cwdMentionCache.items;
  const res =
    active.kind === "ssh"
      ? await api.listTabDir(active.id, cwd)
      : await api.listDir(cwd);
  if (res.error) {
    cwdMentionCache = { key, items: [] };
    return [];
  }
  const items = res.entries
    .map((e) => ({
      path: e.path,
      name: e.kind === "dir" ? `${e.name}/` : e.name,
      kind: e.kind,
    }))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  cwdMentionCache = { key, items };
  return items;
}

function filterMentions(
  items: MentionItem[],
  query: string
): MentionItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice(0, 40);
  return items
    .filter(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        f.path.toLowerCase().includes(q)
    )
    .slice(0, 40);
}

let activeAtMention: AtMentionState | null = null;

function hideMentionMenu(): void {
  activeAtMention = null;
  mentionCardId = null;
  mentionItems = [];
  mentionIndex = 0;
  mentionLoadToken += 1;
  els.mentionMenu.classList.add("hidden");
  els.mentionMenu.innerHTML = "";
}

function renderMentionMenu(loading = false): void {
  els.mentionMenu.innerHTML = "";
  if (!activeAtMention) {
    els.mentionMenu.classList.add("hidden");
    return;
  }
  if (loading) {
    const empty = document.createElement("div");
    empty.className = "mention-empty";
    empty.textContent = t("chat.mention.loading");
    els.mentionMenu.append(empty);
    els.mentionMenu.classList.remove("hidden");
    return;
  }
  if (!mentionItems.length) {
    const empty = document.createElement("div");
    empty.className = "mention-empty";
    empty.textContent = t("chat.mention.empty");
    els.mentionMenu.append(empty);
    els.mentionMenu.classList.remove("hidden");
    return;
  }
  mentionItems.forEach((item, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.role = "option";
    btn.className = `mention-item${i === mentionIndex ? " active" : ""}`;
    btn.innerHTML = `<span class="mention-name">${escapeHtml(item.name)}</span><span class="mention-path">${escapeHtml(formatStripPath(item.path))}</span>`;
    btn.onmousedown = (e) => {
      e.preventDefault();
      applyMention(item);
    };
    els.mentionMenu.append(btn);
  });
  els.mentionMenu.classList.remove("hidden");
}

async function refreshMentionMenu(cardId: string): Promise<void> {
  const pe = promptEls(cardId);
  const input = pe?.input;
  if (!input) {
    hideMentionMenu();
    return;
  }
  mentionCardId = cardId;
  const at = getAtMention(input);
  if (!at) {
    hideMentionMenu();
    return;
  }
  activeAtMention = at;
  const token = ++mentionLoadToken;
  const cached =
    cwdMentionCache &&
    state.activeTabId &&
    cwdMentionCache.key.startsWith(`${state.activeTabId}:`);
  if (!cached) renderMentionMenu(true);
  const items = await loadCwdMentions(getPromptTabId(cardId));
  if (token !== mentionLoadToken) return;
  mentionItems = filterMentions(items, at.query);
  mentionIndex = Math.min(
    mentionIndex,
    Math.max(0, mentionItems.length - 1)
  );
  renderMentionMenu(false);
}

type AttachedRef = {
  path: string;
  name: string;
  kind: "file" | "dir";
};

function normalizeEmptyComposer(input: HTMLDivElement): boolean {
  // Browsers often insert <br> / ZWSP into an empty contenteditable.
  if (input.querySelector(".composer-inline-chip")) return false;
  const text = (input.textContent || "")
    .replace(/\u200b/g, "")
    .replace(/\u00a0/g, " ")
    .trim();
  if (text) return false;
  if (input.innerHTML !== "") {
    input.innerHTML = "";
  }
  return true;
}

function syncComposerEmpty(cardId: string): void {
  const pe = promptEls(cardId);
  if (!pe) return;
  const empty = normalizeEmptyComposer(pe.input);
  pe.input
    .closest("[data-prompt-wrap]")
    ?.classList.toggle("is-empty", empty);
  const wrap = pe.input.parentElement;
  if (wrap?.matches("[data-prompt-wrap]")) {
    wrap.classList.toggle("is-empty", empty);
  }
}

function clearComposer(cardId: string): void {
  const pe = promptEls(cardId);
  if (!pe) return;
  pe.input.innerHTML = "";
  syncComposerEmpty(cardId);
  autoGrowInput(pe.input);
}

function readComposerChips(input: HTMLDivElement): AttachedRef[] {
  return [...input.querySelectorAll(".composer-inline-chip")].map(
    (el) => {
      const node = el as HTMLElement;
      return {
        path: node.dataset.path || "",
        name: node.dataset.name || node.textContent?.trim() || "",
        kind: node.dataset.kind === "dir" ? "dir" : "file",
      };
    }
  );
}

function readComposerFrom(
  input: HTMLDivElement
): { text: string; refs: AttachedRef[] } {
  const refs = readComposerChips(input);
  let text = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += (node.textContent || "").replace(/\u200b/g, "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.classList.contains("composer-inline-chip")) return;
    if (el.tagName === "BR") {
      text += "\n";
      return;
    }
    if (el.tagName === "DIV" || el.tagName === "P") {
      if (text && !text.endsWith("\n")) text += "\n";
    }
    for (const child of el.childNodes) walk(child);
  };
  for (const child of input.childNodes) walk(child);
  return { text: text.replace(/\n{3,}/g, "\n\n").trim(), refs };
}

function enrichPromptWithRefs(message: string, refs: AttachedRef[]): string {
  if (!refs.length) return message;
  const lines = refs.map((r) => `- ${r.kind}: ${r.path}`);
  const block = `[Attached]\n${lines.join("\n")}`;
  return message.trim() ? `${message}\n\n${block}` : block;
}

function createInlineChip(
  item: MentionItem,
  input: HTMLDivElement,
  cardId: string
): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.className = "composer-inline-chip";
  chip.contentEditable = "false";
  chip.dataset.path = item.path;
  chip.dataset.kind = item.kind;
  chip.dataset.name = item.name.replace(/\/$/, "");
  chip.title = item.path;
  chip.innerHTML = `
    <span class="composer-chip-ico" aria-hidden="true">${
      item.kind === "dir" ? icons.folder(11) : icons.file(11)
    }</span>
    <span class="composer-chip-label">${escapeHtml(item.name.replace(/\/$/, ""))}</span>
    <button type="button" class="composer-chip-remove" aria-label="${escapeHtml(t("chat.ref.remove"))}">${icons.close(10)}</button>
  `;
  chip.querySelector(".composer-chip-remove")?.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  chip.querySelector(".composer-chip-remove")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const after = chip.nextSibling;
    chip.remove();
    input.focus();
    if (after?.nodeType === Node.TEXT_NODE) {
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.setStart(after, 0);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } else {
      placeCaretAtEnd(input);
    }
    syncComposerEmpty(cardId);
    autoGrowInput(input);
  });
  return chip;
}

function placeCaretAtEnd(el: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function applyMention(item: MentionItem): void {
  const cardId = mentionCardId;
  const input = cardId ? promptEls(cardId)?.input : null;
  if (!cardId || !input) return;
  const at = activeAtMention || getAtMention(input);
  if (!at) return;
  const { textNode, atOffset, caretOffset } = at;
  const before = textNode.data.slice(0, atOffset);
  const after = textNode.data.slice(caretOffset);
  const parent = textNode.parentNode;
  if (!parent) return;

  const beforeNode = document.createTextNode(before || "\u200b");
  const afterNode = document.createTextNode(after || "\u200b");
  const chip = createInlineChip(item, input, cardId);
  parent.insertBefore(beforeNode, textNode);
  parent.insertBefore(chip, textNode);
  parent.insertBefore(afterNode, textNode);
  parent.removeChild(textNode);

  hideMentionMenu();
  input.focus();
  const sel = window.getSelection();
  if (sel) {
    const range = document.createRange();
    range.setStart(afterNode, after ? 0 : afterNode.data.length);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  syncComposerEmpty(cardId);
  autoGrowInput(input);
}

function buildChatSuggestions(
  tabId?: string | null
): { label: string; prompt: string }[] {
  const effectiveTabId = tabId ?? state.activeTabId;
  const active = effectiveTabId
    ? state.tabs.get(effectiveTabId)
    : undefined;
  if (!active) {
    return [
      {
        label: t("chat.suggest.openTab"),
        prompt: t("chat.suggest.openTab.prompt"),
      },
    ];
  }
  const cwd = tabCwds.get(active.id) || "";
  const short = cwd ? formatStripPath(cwd) : active.title;
  const folder = cwd ? pathBasename(cwd) : active.title;
  if (active.kind === "ssh") {
    return [
      {
        label: t("chat.suggest.remoteStatus"),
        prompt: t("chat.suggest.remoteStatus.prompt", {
          host: active.title,
          path: short,
        }),
      },
      {
        label: t("chat.suggest.termTail"),
        prompt: t("chat.suggest.termTail.prompt"),
      },
      {
        label: t("chat.suggest.folder", { name: folder }),
        prompt: t("chat.suggest.folder.prompt", { path: short }),
      },
    ];
  }
  return [
    {
      label: t("chat.suggest.git"),
      prompt: t("chat.suggest.git.prompt", { path: short }),
    },
    {
      label: t("chat.suggest.termTail"),
      prompt: t("chat.suggest.termTail.prompt"),
    },
    {
      label: t("chat.suggest.folder", { name: folder }),
      prompt: t("chat.suggest.folder.prompt", { path: short }),
    },
  ];
}

function refreshChatEmptyIfNeeded(): void {
  const id = activePromptCardId;
  if (!id) return;
  const ctrl = promptChats.get(id);
  const pe = board.getPromptEls(id);
  if (!ctrl || !pe?.thread.querySelector(".chat-empty")) return;
  ctrl.showEmpty(buildChatSuggestions(getPromptTabId(id)));
}

let metricsInFlight = false;

function setMetricWarn(el: HTMLElement, hot: boolean): void {
  el.classList.toggle("hot", hot);
}

let accountUsageInFlight = false;

async function refreshAccountUsage(): Promise<void> {
  if (accountUsageInFlight) return;
  accountUsageInFlight = true;
  try {
    const res = await api.getAccountUsage();
    if (!res.ok) {
      els.stripApi.classList.add("hidden");
      return;
    }
    const { usage } = res;
    const left = usage.remainingPercent;
    const used = Math.max(0, Math.min(100, Math.round(usage.usedPercent)));
    els.stripApi.classList.remove("hidden");
    els.stripApiVal.textContent = `${left}%`;
    els.stripApiBar.style.width = `${Math.max(4, used)}%`;
    const reset = usage.resetAt
      ? new Date(usage.resetAt).toLocaleDateString()
      : "";
    const bits = [
      t("strip.apiTitle"),
      t("strip.apiLeft", { n: String(left) }),
      usage.membershipType || "",
      reset ? t("strip.apiReset", { date: reset }) : "",
    ].filter(Boolean);
    els.stripApi.title = bits.join(" · ");
    setMetricWarn(els.stripApi, used >= 85);
  } catch {
    els.stripApi.classList.add("hidden");
  } finally {
    accountUsageInFlight = false;
  }
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
  /* usage mini UI removed from titlebar */
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

function renderModelPicker(filter = ""): void {
  syncModelChipLabels();
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

const popoverHome = els.composerPopovers;

function positionAboveChip(
  pop: HTMLElement,
  chip: DOMRect,
  width: number,
  maxHeight: number
): void {
  const gap = 8;
  const margin = 8;
  const w = Math.min(width, window.innerWidth - margin * 2);
  let left = chip.left;
  left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));
  const bottom = Math.max(margin, window.innerHeight - chip.top + gap);
  const availableUp = window.innerHeight - bottom - margin;
  pop.style.left = `${Math.round(left)}px`;
  pop.style.right = "auto";
  pop.style.bottom = `${Math.round(bottom)}px`;
  pop.style.top = "auto";
  pop.style.width = `${Math.round(w)}px`;
  pop.style.maxHeight = `${Math.round(Math.min(maxHeight, availableUp))}px`;
}

function positionModelPopover(): void {
  if (els.modelPopover.classList.contains("hidden") || !modelAnchorBtn) return;
  positionAboveChip(
    els.modelPopover,
    modelAnchorBtn.getBoundingClientRect(),
    320,
    420
  );
}

function positionModePopover(): void {
  if (els.modePopover.classList.contains("hidden") || !modeAnchorBtn) return;
  positionAboveChip(
    els.modePopover,
    modeAnchorBtn.getBoundingClientRect(),
    176,
    280
  );
}

function closeModePopover(): void {
  els.modePopover.classList.add("hidden");
  modeAnchorBtn?.setAttribute("aria-expanded", "false");
  modeAnchorBtn = null;
  hideModeTip();
  els.modePopover.style.left = "";
  els.modePopover.style.bottom = "";
  els.modePopover.style.width = "";
  els.modePopover.style.maxHeight = "";
  if (popoverHome && els.modePopover.parentElement !== popoverHome) {
    popoverHome.appendChild(els.modePopover);
  }
}

function closeModelPopover(): void {
  els.modelPopover.classList.add("hidden");
  modelAnchorBtn?.setAttribute("aria-expanded", "false");
  modelAnchorBtn = null;
  els.modelSearch.value = "";
  els.modelPopover.style.left = "";
  els.modelPopover.style.bottom = "";
  els.modelPopover.style.width = "";
  els.modelPopover.style.maxHeight = "";
  if (popoverHome && els.modelPopover.parentElement !== popoverHome) {
    popoverHome.appendChild(els.modelPopover);
  }
}

function openModePopover(btn: HTMLButtonElement): void {
  closeModelPopover();
  hideModeTip();
  if (modeAnchorBtn === btn && !els.modePopover.classList.contains("hidden")) {
    closeModePopover();
    return;
  }
  modeAnchorBtn?.setAttribute("aria-expanded", "false");
  modeAnchorBtn = btn;
  if (els.modePopover.parentElement !== document.body) {
    document.body.appendChild(els.modePopover);
  }
  els.modePopover.classList.remove("hidden");
  btn.setAttribute("aria-expanded", "true");
  renderModeChip();
  positionModePopover();
  requestAnimationFrame(() => positionModePopover());
}

function openModelPopover(btn: HTMLButtonElement): void {
  closeModePopover();
  if (modelAnchorBtn === btn && !els.modelPopover.classList.contains("hidden")) {
    closeModelPopover();
    return;
  }
  modelAnchorBtn?.setAttribute("aria-expanded", "false");
  modelAnchorBtn = btn;
  renderModelPicker();
  if (els.modelPopover.parentElement !== document.body) {
    document.body.appendChild(els.modelPopover);
  }
  els.modelPopover.classList.remove("hidden");
  btn.setAttribute("aria-expanded", "true");
  positionModelPopover();
  requestAnimationFrame(() => {
    positionModelPopover();
    els.modelSearch.focus({ preventScroll: true });
  });
}

window.addEventListener(
  "resize",
  () => {
    if (!els.modelPopover.classList.contains("hidden")) positionModelPopover();
    if (!els.modePopover.classList.contains("hidden")) positionModePopover();
  },
  { passive: true }
);

async function refreshModels(): Promise<void> {
  state.models = await api.listModels();
  if (!state.models.some((m) => m.id === state.modelId) && state.models[0]) {
    state.modelId = state.models[0].id;
    await api.setModel(state.modelId);
  }
  renderModelPicker(els.modelSearch.value);
}

async function applyModel(modelId: string): Promise<void> {
  state.modelId = modelId;
  await api.setModel(modelId);
  renderModelPicker();
  closeModelPopover();
  const label = currentModelLabel();
  chat.addSystem(`${t("settings.model")} → ${label}`);
  renderUsage();
}

function sshFormEls() {
  return {
    editId: document.getElementById("ssh-edit-id") as HTMLInputElement,
    name: document.getElementById("ssh-name") as HTMLInputElement,
    host: document.getElementById("ssh-host") as HTMLInputElement,
    user: document.getElementById("ssh-user") as HTMLInputElement,
    port: document.getElementById("ssh-port") as HTMLInputElement,
    password: document.getElementById("ssh-password") as HTMLInputElement,
    passwordUnset: document.getElementById("ssh-password-unset")!,
    passwordSet: document.getElementById("ssh-password-set")!,
    passwordSave: document.getElementById(
      "btn-ssh-password-save"
    ) as HTMLButtonElement,
    passwordClear: document.getElementById(
      "btn-ssh-password-clear"
    ) as HTMLButtonElement,
    jump: document.getElementById("ssh-jump") as HTMLInputElement,
    dir: document.getElementById("ssh-dir") as HTMLInputElement,
    advanced: document.getElementById("ssh-advanced") as HTMLDetailsElement,
    title: document.getElementById("ssh-modal-title")!,
    save: document.getElementById("btn-save-ssh")!,
  };
}

function syncSshPasswordUi(hasSaved: boolean): void {
  const form = sshFormEls();
  const editing = Boolean(form.editId.value.trim());
  form.passwordUnset.classList.toggle("hidden", hasSaved);
  form.passwordSet.classList.toggle("hidden", !hasSaved);
  // Edit: save password immediately via the inline button (like settings API key).
  // Add: password is saved with the bottom session Save.
  form.passwordSave.classList.toggle("hidden", hasSaved || !editing);
  if (hasSaved) form.password.value = "";
}

async function openSshModal(session?: SavedSession): Promise<void> {
  const form = sshFormEls();
  const editing = Boolean(session?.id);
  form.editId.value = session?.id ?? "";
  form.name.value = session?.name ?? "";
  form.host.value = session?.host ?? "";
  form.user.value = session?.user ?? "";
  form.port.value =
    session?.port && session.port !== 22 ? String(session.port) : "";
  form.password.value = "";
  form.jump.value = session?.proxyJump ?? "";
  form.dir.value = session?.startDir ?? "";
  form.advanced.open = Boolean(form.jump.value || form.dir.value);
  form.title.textContent = editing ? t("ssh.editTitle") : t("ssh.title");
  form.title.dataset.i18n = editing ? "ssh.editTitle" : "ssh.title";
  form.save.textContent = editing ? t("ssh.saveEdit") : t("ssh.save");
  form.save.dataset.i18n = editing ? "ssh.saveEdit" : "ssh.save";
  syncSshPasswordUi(false);
  els.modalSsh.classList.remove("hidden");
  if (session?.id) {
    const status = await api.getSshPasswordStatus(session.id);
    if (form.editId.value === session.id) {
      syncSshPasswordUi(status.hasPassword);
    }
  }
  requestAnimationFrame(() => form.name.focus());
}

function closeSshModal(): void {
  els.modalSsh.classList.add("hidden");
  const form = sshFormEls();
  form.editId.value = "";
  form.password.value = "";
  form.advanced.open = false;
  syncSshPasswordUi(false);
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
    const hostMeta = `${s.user}@${s.host}${s.port && s.port !== 22 ? `:${s.port}` : ""}`;
    open.innerHTML = `<strong title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</strong><span class="meta" title="${escapeHtml(hostMeta)}">${escapeHtml(hostMeta)}</span>`;
    open.onclick = () => void openSsh(s.id);
    const actions = document.createElement("div");
    actions.className = "session-actions";
    const edit = document.createElement("button");
    edit.className = "session-action ghost";
    edit.title = t("ssh.edit");
    edit.setAttribute("aria-label", `${t("ssh.edit")} ${s.name}`);
    edit.innerHTML = icons.pencil(14);
    edit.onclick = (e) => {
      e.stopPropagation();
      void openSshModal(s);
    };
    const del = document.createElement("button");
    del.className = "session-action ghost";
    del.title = t("ssh.delete");
    del.setAttribute("aria-label", `${t("ssh.delete")} ${s.name}`);
    del.innerHTML = icons.trash(14);
    del.onclick = async (e) => {
      e.stopPropagation();
      await api.deleteSession(s.id);
      await refreshSessions();
    };
    actions.append(edit, del);
    li.append(open, actions);
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

function deleteChipBeforeCaret(input: HTMLDivElement, cardId: string): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType === Node.TEXT_NODE && range.startOffset === 0) {
    const prev = node.previousSibling as HTMLElement | null;
    if (prev?.classList?.contains("composer-inline-chip")) {
      prev.remove();
      syncComposerEmpty(cardId);
      autoGrowInput(input);
      return true;
    }
  }
  if (node === input && range.startOffset > 0) {
    const prev = input.childNodes[range.startOffset - 1] as
      | HTMLElement
      | undefined;
    if (prev?.classList?.contains("composer-inline-chip")) {
      prev.remove();
      syncComposerEmpty(cardId);
      autoGrowInput(input);
      return true;
    }
  }
  return false;
}

function wirePromptComposer(cardId: string): void {
  const pe = promptEls(cardId);
  if (!pe) return;
  const { input, thread } = pe;
  const cardEl = input.closest(".board-card-prompt");
  const modeBtn = cardEl?.querySelector(
    "[data-prompt-mode]"
  ) as HTMLButtonElement | null;
  const modelBtn = cardEl?.querySelector(
    "[data-prompt-model]"
  ) as HTMLButtonElement | null;
  modeBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    openModePopover(modeBtn);
  });
  modelBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    openModelPopover(modelBtn);
  });
  renderModeChip();
  syncModelChipLabels();
  thread.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest(
      "[data-suggest]"
    ) as HTMLElement | null;
    if (!btn?.dataset.suggest) return;
    clearComposer(cardId);
    input.textContent = btn.dataset.suggest;
    syncComposerEmpty(cardId);
    autoGrowInput(input);
    input.focus();
    placeCaretAtEnd(input);
  });
  input.addEventListener("focus", () => {
    activePromptCardId = cardId;
    if (normalizeEmptyComposer(input)) {
      input.parentElement?.classList.add("is-empty");
      placeCaretAtEnd(input);
    }
  });
  input.addEventListener("input", () => {
    syncComposerEmpty(cardId);
    autoGrowInput(input);
    void refreshMentionMenu(cardId);
  });
  input.addEventListener("keyup", () => {
    void refreshMentionMenu(cardId);
  });
  input.addEventListener("click", () => {
    void refreshMentionMenu(cardId);
  });
  input.addEventListener("blur", () => {
    syncComposerEmpty(cardId);
    window.setTimeout(() => hideMentionMenu(), 120);
  });
  const ctx = pe.context;
  ctx.onclick = () => {
    if (ctx.classList.contains("is-empty")) return;
    setNav("files");
  };
}

function restoreSavedPrompts(saved: BoardPersistedState): void {
  board.applyPersisted(saved, new Set(state.tabs.keys()));
  for (const card of board.getCards()) {
    if (card.kind !== "prompt") continue;
    attachPromptCard(card);
  }
}

function attachPromptCard(card: PromptCard): void {
  const pe = board.getPromptEls(card.id);
  if (!pe) return;
  const ctrl = createChatController(pe.thread);
  ctrl.showEmpty(buildChatSuggestions(card.tabId));
  promptChats.set(card.id, ctrl);
  wirePromptComposer(card.id);
  syncPromptContextForCard(card.id);
}

function terminalCardForTab(tabId: string): TerminalCard | undefined {
  return board
    .getCards()
    .find(
      (c): c is TerminalCard => c.kind === "terminal" && c.tabId === tabId
    );
}

function isTabTerminalExpanded(tabId: string): boolean {
  const card = terminalCardForTab(tabId);
  return Boolean(card && !card.minimized);
}

board = createBoardPane(els.boardStage, {
  onFocus(focus: BoardFocus) {
    if (!focus) {
      filesFollowTabId = null;
      void syncFilesPanel();
      refreshStatusStrip();
      return;
    }
    state.activeTabId = focus.tabId;
    if (focus.kind === "prompt") {
      activePromptCardId = focus.cardId;
      // Prompt focus is not a terminal selection — clear the files tree.
      filesFollowTabId = null;
      void syncFilesPanel();
    }
    syncPromptContexts();
    refreshStatusStrip();
    void refreshStripMetrics();
    // Files panel follows board terminal selection only.
    if (focus.kind === "terminal") {
      filesFollowTabId = focus.tabId;
      void syncFilesPanel();
      const tab = state.tabs.get(focus.tabId);
      if (tab) {
        requestAnimationFrame(() => {
          syncTerminalSize(tab, { force: true });
          tab.term.focus();
        });
      }
    }
  },
  onToggleMinimize(cardId) {
    const card = board.findCard(cardId);
    if (!card || card.kind !== "terminal") return;
    const minimized = !card.minimized;
    board.setMinimized(cardId, minimized);
    if (!minimized) activateTab(card.tabId);
  },
  onCloseTerminal(tabId) {
    void closeTab(tabId);
  },
  onClosePrompt(cardId) {
    const childIds = board
      .getCards()
      .filter((c) => c.kind === "prompt" && c.parentId === cardId)
      .map((c) => c.id);
    for (const id of [cardId, ...childIds]) {
      if (isCardGenerating(id)) stopPromptAgent(id);
      promptChats.delete(id);
      for (const [runId, cid] of [...runToPrompt]) {
        if (cid === id) clearRun(runId);
      }
      generatingCards.delete(id);
      if (activePromptCardId === id) activePromptCardId = null;
    }
    board.removeCard(cardId);
  },
  onAddSub(parentCardId) {
    void addManualSubPrompt(parentCardId);
  },
  onPromptSend(cardId) {
    if (isCardGenerating(cardId)) {
      stopPromptAgent(cardId);
      return;
    }
    void sendPrompt(cardId);
  },
  onPromptInputKeydown(cardId, e) {
    if (isCardGenerating(cardId)) {
      e.preventDefault();
      if (e.key === "Enter" && !e.shiftKey) stopPromptAgent(cardId);
      return;
    }
    const pe = promptEls(cardId);
    const input = pe?.input;
    if (!input) return;
    const mentionOpen = !els.mentionMenu.classList.contains("hidden");
    if (mentionOpen && mentionCardId === cardId) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (mentionItems.length) {
          mentionIndex = (mentionIndex + 1) % mentionItems.length;
          renderMentionMenu();
        }
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (mentionItems.length) {
          mentionIndex =
            (mentionIndex - 1 + mentionItems.length) % mentionItems.length;
          renderMentionMenu();
        }
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const item = mentionItems[mentionIndex];
        if (item) applyMention(item);
        else hideMentionMenu();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        hideMentionMenu();
        return;
      }
    }
    if (e.key === "Backspace" && deleteChipBeforeCaret(input, cardId)) {
      e.preventDefault();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (isCardGenerating(cardId)) {
        stopPromptAgent(cardId);
        return;
      }
      void sendPrompt(cardId);
    }
  },
  onLayoutChange: () => scheduleBoardSave(),
});

board.root.addEventListener("board:add-prompt", ((e: CustomEvent<{ tabId: string }>) => {
  const tabId = e.detail?.tabId;
  if (!tabId) return;
  attachPromptCard(board.addPrompt(tabId));
}) as EventListener);

/** Keep xterm + PTY sizes locked together — never resize one without the other. */
function syncTerminalSize(tab: TabView, opts?: { force?: boolean }): void {
  if (!isTabTerminalExpanded(tab.id)) return;
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
  filesFollowTabId = tabId;
  board.expandTerminal(tabId);
  const active = state.tabs.get(tabId);
  if (active) {
    requestAnimationFrame(() => {
      syncTerminalSize(active, { force: true });
      active.term.focus();
    });
  }
  invalidateMentionCache();
  void syncFilesPanel();
  refreshStatusStrip();
  syncPromptContexts();
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
  const meetings = id === "meetings";
  els.boardStage.classList.toggle("hidden", meetings);
  els.meetingStage.classList.toggle("hidden", !meetings);
  document.getElementById("main-stage")?.classList.toggle("mode-meetings", meetings);
  if (id === "files") void syncFilesPanel(true);
  if (meetings) {
    void refreshMeetingList();
    syncMeetingStageEmpty();
  } else {
    requestAnimationFrame(() => refitTerminals());
  }
  refreshStatusStrip();
}

function openSettings(): void {
  setNav("settings");
}

function closeTopModal(): boolean {
  const splash = document.getElementById("app-splash");
  if (splash && !splash.classList.contains("is-done") && splash.classList.contains("is-updating")) {
    if (updateSplash.phase === "downloading") return true;
    void dismissUpdateSplash();
    return true;
  }
  if (!els.modalSsh.classList.contains("hidden")) {
    closeSshModal();
    return true;
  }
  return false;
}

type UpdateSplashPhase = "available" | "downloading" | "ready" | "error";

let updateSplash = {
  version: "",
  currentVersion: "",
  phase: "available" as UpdateSplashPhase,
};

function plainReleaseNotes(raw: string | null | undefined): string {
  return (raw ?? "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .filter((line) => !/^\s*Co-authored-by:/i.test(line))
    .join("\n")
    .trim();
}

function setUpdateSplashProgress(percent: number): void {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  setSplashProgress(pct, undefined, { absolute: true });
  if (updateSplash.phase === "downloading") {
    els.splashUpdateLead.textContent = t("update.downloading", {
      percent: String(pct),
    });
    els.btnSplashUpdateAction.textContent = t("update.downloading", {
      percent: String(pct),
    });
  }
}

function renderUpdateSplashAction(): void {
  const busy = updateSplash.phase === "downloading";
  els.btnSplashUpdateLater.disabled = busy;
  els.btnSplashUpdateAction.disabled = busy;
  if (updateSplash.phase === "ready") {
    els.btnSplashUpdateAction.textContent = t("update.install");
    els.splashUpdateLead.textContent = t("update.ready");
  } else if (updateSplash.phase === "downloading") {
    els.btnSplashUpdateAction.textContent = t("update.downloading", {
      percent: String(splashPercent),
    });
  } else {
    els.btnSplashUpdateAction.textContent = t("update.download");
    els.splashUpdateLead.textContent = t("update.lead");
  }
}

function showUpdateSplash(payload: {
  version: string;
  currentVersion: string;
  releaseNotes?: string | null;
}): void {
  splashHeldForUpdate = true;
  updateSplash = {
    version: payload.version,
    currentVersion: payload.currentVersion,
    phase: "available",
  };
  const root = document.getElementById("app-splash");
  if (!root) return;
  root.classList.remove("is-done");
  root.classList.add("is-updating");
  root.setAttribute("aria-busy", "true");
  els.splashUpdate.hidden = false;
  els.splashUpdateTitle.textContent = t("update.title");
  els.splashUpdateLead.textContent = t("update.lead");
  els.splashUpdateCurrentLabel.textContent = t("update.current");
  els.splashUpdateLatestLabel.textContent = t("update.latest");
  els.splashUpdateCurrent.textContent = payload.currentVersion;
  els.splashUpdateLatest.textContent = payload.version;
  els.btnSplashUpdateLater.textContent = t("update.later");
  const notes = plainReleaseNotes(payload.releaseNotes);
  if (notes) {
    els.splashUpdateNotes.textContent = notes;
    els.splashUpdateNotes.classList.remove("hidden");
  } else {
    els.splashUpdateNotes.textContent = "";
    els.splashUpdateNotes.classList.add("hidden");
  }
  els.splashUpdateError.classList.add("hidden");
  els.splashUpdateError.textContent = "";
  setSplashProgress(0, undefined, { absolute: true });
  renderUpdateSplashAction();
}

async function dismissUpdateSplash(): Promise<void> {
  const version = updateSplash.version;
  const phase = updateSplash.phase;
  splashHeldForUpdate = false;
  const root = document.getElementById("app-splash");
  if (root) {
    root.classList.remove("is-updating");
    root.classList.add("is-done");
    root.setAttribute("aria-busy", "false");
  }
  els.splashUpdate.hidden = true;
  if (version && phase !== "ready") {
    await api.dismissUpdate(version);
  }
}

els.btnSplashUpdateLater.onclick = () => {
  void dismissUpdateSplash();
};

els.btnSplashUpdateAction.onclick = () => {
  void (async () => {
    els.splashUpdateError.classList.add("hidden");
    if (updateSplash.phase === "ready") {
      const result = await api.installUpdate();
      if (!result.ok) {
        updateSplash.phase = "error";
        renderUpdateSplashAction();
        els.splashUpdateError.textContent = t("update.error", {
          error:
            "message" in result && result.message
              ? result.message
              : result.reason,
        });
        els.splashUpdateError.classList.remove("hidden");
      }
      return;
    }
    updateSplash.phase = "downloading";
    renderUpdateSplashAction();
    setUpdateSplashProgress(0);
    const result = await api.downloadUpdate();
    if (!result.ok) {
      updateSplash.phase = "error";
      renderUpdateSplashAction();
      els.splashUpdateError.textContent = t("update.error", {
        error: result.message ?? result.reason,
      });
      els.splashUpdateError.classList.remove("hidden");
    }
  })();
};

api.onUpdateAvailable((payload) => {
  showUpdateSplash(payload);
});

api.onUpdateProgress((payload) => {
  const root = document.getElementById("app-splash");
  if (!root || !root.classList.contains("is-updating")) return;
  updateSplash.phase = "downloading";
  setUpdateSplashProgress(payload.percent);
  els.btnSplashUpdateLater.disabled = true;
  els.btnSplashUpdateAction.disabled = true;
});

api.onUpdateDownloaded((payload) => {
  const root = document.getElementById("app-splash");
  if (!root || !root.classList.contains("is-updating")) {
    showUpdateSplash({
      version: payload.version,
      currentVersion: payload.currentVersion,
      releaseNotes: null,
    });
  }
  updateSplash.version = payload.version;
  updateSplash.currentVersion = payload.currentVersion;
  updateSplash.phase = "ready";
  els.splashUpdateLatest.textContent = payload.version;
  els.splashUpdateTitle.textContent = t("update.title");
  setUpdateSplashProgress(100);
  renderUpdateSplashAction();
});

api.onUpdateError((payload) => {
  const root = document.getElementById("app-splash");
  if (!root || !root.classList.contains("is-updating")) return;
  updateSplash.phase = "error";
  renderUpdateSplashAction();
  els.splashUpdateError.textContent = t("update.error", {
    error: payload.message,
  });
  els.splashUpdateError.classList.remove("hidden");
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
      // Close the focused surface first (editor doc vs terminal tab).
      if (editorPane.isFocused()) {
        void editorPane.closeActive();
        break;
      }
      if (state.activeTabId) void closeTab(state.activeTabId);
      break;
    case "save":
      if (editorPane.isOpen()) void editorPane.saveActive();
      break;
    case "find":
      if (editorPane.isOpen()) editorPane.find();
      break;
    case "toggle-comment":
      if (editorPane.isOpen()) editorPane.toggleComment();
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
  const followed = filesFollowTabId
    ? state.tabs.get(filesFollowTabId)
    : undefined;
  if (followed?.kind === "local") return followed;
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
  board.upsertTerminal({ tabId, title, activate: true });
  const host = board.getTerminalHost(tabId);
  if (!host) throw new Error("Terminal host missing");
  const el = document.createElement("div");
  el.style.height = "100%";
  host.append(el);

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

function formatMeetingWhen(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(state.locale === "ko" ? "ko-KR" : "en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function syncMeetingStageEmpty(): void {
  const has = Boolean(meetingState.activeId && meetingState.pane);
  els.meetingStageEmpty.classList.toggle("hidden", has);
  els.meetingStageHost.classList.toggle("hidden", !has);
}

function renderMeetingList(): void {
  els.meetingList.innerHTML = "";
  const empty = meetingState.list.length === 0;
  els.meetingListEmpty.classList.toggle("hidden", !empty);
  for (const item of meetingState.list) {
    const li = document.createElement("li");
    li.className = `meeting-list-item${item.id === meetingState.activeId ? " active" : ""}`;
    li.innerHTML = `
      <button type="button" class="meeting-list-main" data-id="${escapeHtml(item.id)}">
        <span class="meeting-list-title">${escapeHtml(item.title)}</span>
        <span class="meeting-list-meta">${escapeHtml(formatMeetingWhen(item.createdAt))}</span>
      </button>
      <button type="button" class="meeting-list-del icon" data-del="${escapeHtml(item.id)}" data-i18n-title="meeting.delete" title="${escapeHtml(t("meeting.delete"))}" aria-label="${escapeHtml(t("meeting.delete"))}">${icons.trash(13)}</button>
    `;
    els.meetingList.append(li);
  }
}

async function refreshMeetingList(): Promise<void> {
  try {
    meetingState.list = await api.listMeetings();
  } catch {
    meetingState.list = [];
  }
  renderMeetingList();
}

function unloadActiveMeeting(): void {
  meetingState.pane?.dispose();
  meetingState.pane = null;
  meetingState.activeId = null;
  els.meetingStageHost.innerHTML = "";
  syncMeetingStageEmpty();
  renderMeetingList();
  refreshStatusStrip();
}

async function openMeetingById(id: string): Promise<void> {
  if (meetingState.activeId === id && meetingState.pane) {
    syncMeetingStageEmpty();
    renderMeetingList();
    return;
  }
  const record = await api.getMeeting(id);
  if (!record) {
    showToast(t("meeting.notFound"), "error");
    await refreshMeetingList();
    return;
  }
  meetingState.pane?.dispose();
  els.meetingStageHost.innerHTML = "";
  const pane = createMeetingPane({
    api,
    meetingId: record.meta.id,
    title: record.meta.title,
    transcript: record.transcript,
    notes: record.notes,
    summary: record.summary,
    durationMs: record.meta.durationMs,
    onTitleChange: (title) => {
      const hit = meetingState.list.find((m) => m.id === record.meta.id);
      if (hit) hit.title = title;
      renderMeetingList();
      if (activeNav === "meetings") updateStripPath();
    },
    onNeedApiKey: () => openSettings(),
  });
  pane.el.style.height = "100%";
  els.meetingStageHost.append(pane.el);
  meetingState.pane = pane;
  meetingState.activeId = record.meta.id;
  syncMeetingStageEmpty();
  renderMeetingList();
  refreshStatusStrip();
}

async function createAndOpenMeeting(): Promise<void> {
  try {
    const record = await api.createMeeting();
    await refreshMeetingList();
    // Keep the brand-new meeting at the top of the sidebar list.
    meetingState.list = [
      record.meta,
      ...meetingState.list.filter((m) => m.id !== record.meta.id),
    ];
    renderMeetingList();
    els.meetingList.scrollTop = 0;
    await openMeetingById(record.meta.id);
  } catch (err) {
    showToast(
      err instanceof Error ? err.message : String(err),
      "error"
    );
  }
}

async function deleteMeetingById(id: string): Promise<void> {
  const ok = window.confirm(t("meeting.deleteConfirm"));
  if (!ok) return;
  try {
    await api.deleteMeeting(id);
    if (meetingState.activeId === id) unloadActiveMeeting();
    await refreshMeetingList();
  } catch (err) {
    showToast(
      err instanceof Error ? err.message : String(err),
      "error"
    );
  }
}

async function waitFrames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }
}

async function openLocal(): Promise<void> {
  try {
    if (activeNav === "meetings") setNav("sessions");
    await ensureTermFont();
    const created = await api.createLocalTab();
    const view = mountTabView(created.tabId, created.title, "local");
    board.refreshTitles(created.tabId, created.title);
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
  if (activeNav === "meetings") setNav("sessions");
  await ensureTermFont();
  await waitFrames(1);
  const probeEl = document.createElement("div");
  probeEl.style.cssText =
    "position:fixed;left:-9999px;top:0;width:800px;height:400px;visibility:hidden;";
  document.body.append(probeEl);
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
  board.refreshTitles(res.tabId, res.title);
  view.lastCols = size.cols;
  view.lastRows = size.rows;
  view.sizeFreezeUntil = Date.now() + 2500;
  if (res.label) {
    view.term.writeln(`\x1b[90mConnecting ssh ${res.label}…\x1b[0m`);
  }
  await api.readyTerminal(res.tabId);
  setNav("files");
}

/** Escape a path for the active local shell (zsh/bash or PowerShell). */
function shellQuote(filePath: string): string {
  const win = /Windows/i.test(navigator.userAgent);
  if (win) {
    // PowerShell: single-quoted string; double embedded quotes.
    if (/^[A-Za-z0-9_.:\\/@%+=,-]+$/.test(filePath)) return filePath;
    return `'${filePath.replace(/'/g, "''")}'`;
  }
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(filePath)) return filePath;
  return `'${filePath.replace(/'/g, `'\\''`)}'`;
}

async function closeTab(tabId: string): Promise<void> {
  const tab = state.tabs.get(tabId);
  if (!tab) return;
  if (tab.fitTimer != null) window.clearTimeout(tab.fitTimer);
  tab.term.dispose();
  tab.el.remove();
  state.tabs.delete(tabId);
  tabCwds.delete(tabId);
  const promptIds = board
    .getCards()
    .filter((c) => c.kind === "prompt" && c.tabId === tabId)
    .map((c) => c.id);
  for (const cardId of promptIds) {
    if (isCardGenerating(cardId)) stopPromptAgent(cardId);
    promptChats.delete(cardId);
    for (const [runId, cid] of [...runToPrompt]) {
      if (cid === cardId) clearRun(runId);
    }
    generatingCards.delete(cardId);
    if (activePromptCardId === cardId) activePromptCardId = null;
  }
  board.removeTab(tabId);
  await api.closeTab(tabId);
  if (filesFollowTabId === tabId) filesFollowTabId = null;
  if (state.activeTabId === tabId) {
    state.activeTabId = null;
  }
  board.syncEmpty();
  refreshStatusStrip();
  void syncFilesPanel(true);
  scheduleBoardSave();
}

function showApproval(payload: {
  runId: string;
  tabId: string;
  action: ProposedAction;
}): void {
  pendingApprovalsByRun.set(payload.runId, payload);
  const cardId = runToPrompt.get(payload.runId);
  if (cardId) board.setPromptRunStatus(cardId, "waiting");
  const runChat = chatForRun(payload.runId);
  const turn = ensureRunTurn(payload.runId);
  if (turn.startedAssistant) {
    runChat.finishAssistant({
      tokens: turn.turnTokens ?? undefined,
      modelId: turn.turnModel ?? undefined,
      cost: turn.turnCost ?? undefined,
    });
    turn.startedAssistant = false;
  }
  runChat.setThinking(false);
  runChat.addApproval(
    { runId: payload.runId, action: payload.action },
    (d) => {
      void resolveApproval(payload.runId, d);
    }
  );
}

async function resolveApproval(
  runId: string,
  decision: "allow-once" | "allow-session" | "deny"
): Promise<void> {
  if (!pendingApprovalsByRun.has(runId)) return;
  pendingApprovalsByRun.delete(runId);
  const cardId = runToPrompt.get(runId);
  if (cardId) {
    board.setPromptRunStatus(
      cardId,
      decision === "deny" ? "error" : "running"
    );
  }
  chatForRun(runId).resolveApprovalCard(decision);
  if (decision !== "deny") {
    chatForRun(runId).setThinking(true, t("thinking.running"));
  }
  await api.resolveApproval({
    runId,
    decision:
      decision === "deny"
        ? { type: "deny" }
        : decision === "allow-session"
          ? { type: "allow-session" }
          : { type: "allow-once" },
  });
}

function notifyParentOfSub(
  childCardId: string,
  kind: "spawned" | "finished" | "failed"
): void {
  const child = board.findCard(childCardId);
  if (!child || child.kind !== "prompt" || !child.parentId) return;
  const parentChat = promptChats.get(child.parentId);
  if (!parentChat) return;
  const title = child.title || t("board.subPrompt");
  if (kind === "spawned") {
    parentChat.addSystem(t("board.subSpawned", { title }));
  } else if (kind === "finished") {
    parentChat.addSystem(t("board.subFinished", { title }));
  } else {
    parentChat.addSystem(t("board.subFailed", { title }));
  }
}

async function addManualSubPrompt(parentCardId: string): Promise<void> {
  const parent = board.findCard(parentCardId);
  if (!parent || parent.kind !== "prompt") return;
  if (parent.parentId) return;
  if (board.countPromptChildren(parentCardId) >= MAX_PROMPT_SUBS) {
    (promptChats.get(parentCardId) ?? noopChat).addSystem(
      t("board.subLimit", { n: String(MAX_PROMPT_SUBS) })
    );
    return;
  }
  const card = board.addPrompt(parent.tabId, t("board.subPrompt"), {
    parentId: parentCardId,
  });
  attachPromptCard(card);
  notifyParentOfSub(card.id, "spawned");
  scheduleBoardSave();
}

async function spawnSubFromAgent(
  parentCardId: string,
  spawn: { title: string; task: string }
): Promise<void> {
  const parent = board.findCard(parentCardId);
  if (!parent || parent.kind !== "prompt") return;
  // 1-hop only: ignore spawn requests from subagents.
  if (parent.parentId) return;
  if (board.countPromptChildren(parentCardId) >= MAX_PROMPT_SUBS) {
    (promptChats.get(parentCardId) ?? noopChat).addSystem(
      t("board.subLimit", { n: String(MAX_PROMPT_SUBS) })
    );
    return;
  }
  const card = board.addPrompt(parent.tabId, spawn.title, {
    parentId: parentCardId,
  });
  attachPromptCard(card);
  notifyParentOfSub(card.id, "spawned");
  const runChat = promptChats.get(card.id) ?? noopChat;
  const message = spawn.task.trim();
  runChat.addUser(message);
  setGenerating(true, card.id);
  board.setPromptRunStatus(card.id, "running");
  runChat.setThinking(true, t("thinking"));
  const res = await api.sendAgent({ tabId: parent.tabId, message });
  if ("error" in res) {
    runChat.setThinking(false);
    runChat.addError(res.error);
    setGenerating(false, card.id);
    board.setPromptRunStatus(card.id, "error");
    notifyParentOfSub(card.id, "failed");
    return;
  }
  state.activeRunId = res.runId;
  runToPrompt.set(res.runId, card.id);
  runTurns.set(res.runId, {
    startedAssistant: false,
    turnTokens: null,
    turnModel: state.modelId,
    turnCost: null,
  });
  scheduleBoardSave();
}

let filesServerTabId: string | null = null;
/** Files tree follows only the terminal last selected on the board. */
let filesFollowTabId: string | null = null;

const mainStage = document.getElementById("main-stage")!;
const mainSplit = document.getElementById("main-split")!;
let editorOpen = false;

function syncMainStageLayout(): void {
  const hasEditor = editorOpen;
  const hasTerminal = state.tabs.size > 0;
  mainStage.classList.toggle("has-editor", hasEditor);
  mainStage.classList.toggle("has-terminal", hasTerminal);
  mainStage.classList.toggle("editor-only", hasEditor && !hasTerminal);
  mainSplit.classList.toggle("hidden", !(hasEditor && hasTerminal));
  requestAnimationFrame(() => refitTerminals());
}

function setEditorVisible(open: boolean): void {
  editorOpen = open;
  syncMainStageLayout();
}

const editorPane = createEditorPane({
  root: document.getElementById("editor-pane")!,
  readLocal: (filePath) => api.readFile(filePath),
  writeLocal: (filePath, content) => api.writeFile(filePath, content),
  readRemote: (tabId, filePath) => api.readTabFile(tabId, filePath),
  writeRemote: (tabId, filePath, content) =>
    api.writeTabFile(tabId, filePath, content),
  onVisibilityChange: setEditorVisible,
});
{
  let dragging = false;
  mainSplit.addEventListener("mousedown", (e) => {
    if (
      !mainStage.classList.contains("has-editor") ||
      !mainStage.classList.contains("has-terminal")
    ) {
      return;
    }
    e.preventDefault();
    dragging = true;
    document.body.classList.add("is-resizing-editor");
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const rect = mainStage.getBoundingClientRect();
    if (rect.height < 80) return;
    const y = e.clientY - rect.top;
    const ratio = Math.min(0.75, Math.max(0.2, y / rect.height));
    mainStage.style.setProperty("--editor-ratio", `${ratio * 100}%`);
    refitTerminals();
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("is-resizing-editor");
  });
}

{
  const layoutEl = document.querySelector(".layout") as HTMLElement | null;
  const splitSidebar = document.getElementById("split-sidebar");
  const SIDEBAR_KEY = "drift.sidebarWidth";
  const SIDEBAR_MIN = 200;
  const SIDEBAR_MAX = 480;

  function clamp(n: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, n));
  }

  function applyStoredWidths(): void {
    if (!layoutEl) return;
    const side = Number(localStorage.getItem(SIDEBAR_KEY));
    if (Number.isFinite(side) && side > 0) {
      layoutEl.style.setProperty(
        "--sidebar",
        `${clamp(side, SIDEBAR_MIN, SIDEBAR_MAX)}px`
      );
    }
  }

  applyStoredWidths();

  type ColDrag = {
    kind: "sidebar";
    startX: number;
    startWidth: number;
  } | null;
  let colDrag: ColDrag = null;

  function currentVarPx(name: "--sidebar", fallback: number): number {
    if (!layoutEl) return fallback;
    const raw = getComputedStyle(layoutEl).getPropertyValue(name).trim();
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  function beginColDrag(handle: HTMLElement, e: MouseEvent): void {
    e.preventDefault();
    const startWidth = currentVarPx("--sidebar", 288);
    colDrag = { kind: "sidebar", startX: e.clientX, startWidth };
    handle.classList.add("is-active");
    document.body.classList.add("is-resizing-col");
  }

  splitSidebar?.addEventListener("mousedown", (e) => {
    if (layoutEl?.classList.contains("nav-collapsed")) return;
    beginColDrag(splitSidebar, e);
  });

  window.addEventListener("mousemove", (e) => {
    if (!colDrag || !layoutEl) return;
    const next = clamp(
      colDrag.startWidth + (e.clientX - colDrag.startX),
      SIDEBAR_MIN,
      SIDEBAR_MAX
    );
    layoutEl.style.setProperty("--sidebar", `${next}px`);
    refitTerminals();
  });

  window.addEventListener("mouseup", () => {
    if (!colDrag || !layoutEl) return;
    colDrag = null;
    splitSidebar?.classList.remove("is-active");
    document.body.classList.remove("is-resizing-col");
    localStorage.setItem(
      SIDEBAR_KEY,
      String(currentVarPx("--sidebar", 288))
    );
  });
}

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
  onLocalOpenFile: async (filePath) => {
    await editorPane.openLocal(filePath);
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
  onServerOpenFile: async (filePath) => {
    if (!filesServerTabId) return;
    await editorPane.openRemote(filesServerTabId, filePath);
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
  invalidateMentionCache();
  if (state.activeTabId === tabId) updateStripPath();
  // Only the board-selected terminal drives the files panel.
  if (filesFollowTabId !== tabId) return;
  if (tab.kind === "local") {
    filesServerTabId = null;
    await filesBrowser.setLocal({ enabled: true, rootPath: cwd });
    await filesBrowser.setServer({
      enabled: false,
      label: "",
      message: t("files.serverEmpty"),
    });
    return;
  }
  filesServerTabId = tabId;
  const home = homeDirCache || (await api.getHomeDir());
  await filesBrowser.setLocal({ enabled: true, rootPath: home });
  await filesBrowser.setServer({
    enabled: true,
    label: tab.title,
    rootPath: cwd,
  });
}

async function syncFilesPanel(_force = false): Promise<void> {
  const tab = filesFollowTabId
    ? state.tabs.get(filesFollowTabId)
    : undefined;
  // Restore this terminal's pane collapse / tree expand before loading paths.
  filesBrowser.setFollowSession(filesFollowTabId);
  if (!tab) {
    filesServerTabId = null;
    await filesBrowser.setLocal({
      enabled: false,
      message: t("files.noTerminal"),
    });
    await filesBrowser.setServer({
      enabled: false,
      label: "",
      message: t("files.noTerminal"),
    });
    return;
  }

  if (tab.kind === "local") {
    filesServerTabId = null;
    const cwd =
      (await cwdForTab(tab.id)) ||
      homeDirCache ||
      (await api.getHomeDir());
    await filesBrowser.setLocal({ enabled: true, rootPath: cwd });
    await filesBrowser.setServer({
      enabled: false,
      label: "",
      message: t("files.serverEmpty"),
    });
    return;
  }

  filesServerTabId = tab.id;
  const cwd = (await cwdForTab(tab.id)) || "~";
  const home = homeDirCache || (await api.getHomeDir());
  await filesBrowser.setLocal({ enabled: true, rootPath: home });
  await filesBrowser.setServer({
    enabled: true,
    label: tab.title,
    rootPath: cwd,
  });
}

// Wire UI
document.getElementById("btn-local")!.onclick = () => void openLocal();
document.getElementById("btn-new-meeting")!.onclick = () => {
  setNav("meetings");
  void createAndOpenMeeting();
};
els.meetingList.addEventListener("click", (e) => {
  const del = (e.target as HTMLElement).closest(
    "[data-del]"
  ) as HTMLElement | null;
  if (del?.dataset.del) {
    e.preventDefault();
    void deleteMeetingById(del.dataset.del);
    return;
  }
  const open = (e.target as HTMLElement).closest(
    "[data-id]"
  ) as HTMLElement | null;
  if (open?.dataset.id) void openMeetingById(open.dataset.id);
});
document.getElementById("btn-add-ssh")!.onclick = () => {
  void openSshModal();
};
document.getElementById("btn-cancel-ssh")!.onclick = () => closeSshModal();
document.getElementById("btn-ssh-password-save")!.onclick = () => {
  void (async () => {
    const form = sshFormEls();
    const sessionId = form.editId.value.trim();
    const value = form.password.value.trim();
    if (!sessionId) return;
    if (!value) {
      showToast(t("ssh.passwordSaveNeed"), "info");
      form.password.focus();
      return;
    }
    form.passwordSave.disabled = true;
    try {
      const result = await api.setSshPassword(sessionId, value);
      if (!result.ok) {
        showToast(t("ssh.passwordSaveFail"), "error");
        return;
      }
      syncSshPasswordUi(true);
      showToast(t("ssh.passwordSaveOk"), "ok");
    } finally {
      form.passwordSave.disabled = false;
    }
  })();
};
document.getElementById("btn-ssh-password-clear")!.onclick = () => {
  void (async () => {
    const form = sshFormEls();
    const sessionId = form.editId.value.trim();
    form.password.value = "";
    if (sessionId) {
      form.passwordClear.disabled = true;
      try {
        await api.clearSshPassword(sessionId);
      } finally {
        form.passwordClear.disabled = false;
      }
    }
    syncSshPasswordUi(false);
  })();
};
document.getElementById("btn-save-ssh")!.onclick = async () => {
  const form = sshFormEls();
  const name = form.name.value.trim();
  const host = form.host.value.trim();
  const user = form.user.value.trim();
  const portRaw = form.port.value;
  const proxyJump = form.jump.value.trim();
  const startDir = form.dir.value.trim();
  const password = form.password.value;
  if (!name || !host || !user) {
    showToast(t("ssh.requiredHint"), "info");
    (!name ? form.name : !host ? form.host : form.user).focus();
    return;
  }
  const editId = form.editId.value.trim();
  const existing = editId
    ? state.sessions.find((s) => s.id === editId)
    : undefined;
  const saved = await api.saveSession({
    id: editId || undefined,
    name,
    host,
    user,
    port: portRaw ? Number(portRaw) : undefined,
    // Keep imported IdentityFile if present; the modal no longer edits keys.
    identityFile: existing?.identityFile,
    authorizedKeyIdentity: existing?.authorizedKeyIdentity,
    proxyJump: proxyJump || undefined,
    startDir: startDir || undefined,
  });
  // Add flow: password is stored with the session. Edit flow uses the inline Save.
  if (!editId && password.trim()) {
    await api.setSshPassword(saved.id, password);
  }
  closeSshModal();
  await refreshSessions();
};
document.getElementById("btn-import-ssh")!.onclick = async () => {
  const btn = document.getElementById("btn-import-ssh") as HTMLButtonElement;
  btn.disabled = true;
  try {
    const result = await api.importSshConfig();
    await refreshSessions();
    if (result.missingConfig) {
      showToast(t("ssh.importMissing"), "info");
    } else if (result.found === 0) {
      showToast(t("ssh.importEmpty"), "info");
    } else if (result.created === 0) {
      showToast(
        t("ssh.importUpdated", { count: String(result.updated) }),
        "ok"
      );
    } else {
      showToast(
        t("ssh.importOk", {
          created: String(result.created),
          total: String(result.found),
        }),
        "ok"
      );
    }
  } catch (err) {
    showToast(
      t("ssh.importFail", {
        error: err instanceof Error ? err.message : String(err),
      }),
      "error"
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
api.onShortcut((payload) => handleShortcut(payload));

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && closeTopModal()) {
    e.preventDefault();
    return;
  }
  // ⌘B / Ctrl+B — toggle left sidebar (VS Code / Cursor style)
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "b") {
    e.preventDefault();
    toggleNavPanel();
  }
});
els.btnOpenApiKeys.onclick = () => openCursorApiKeysPage(api);
els.btnSaveKey.onclick = async () => {
  const value = els.apiKeyInput.value.trim();
  if (!value) return;
  await api.setApiKey(value);
  els.apiKeyInput.value = "";
  setKeyBadge(true);
  chat.addSystem(t("settings.keySaved"));
  await refreshModels();
  void refreshAccountUsage();
};
els.btnClearKey.onclick = async () => {
  await api.clearApiKey();
  setKeyBadge(false);
  chat.addSystem(t("settings.keyCleared"));
  void refreshAccountUsage();
};
els.apiKeyInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    els.btnSaveKey.click();
  }
});
els.settingsLocale.onchange = () => {
  void applyLocale(normalizeLocale(els.settingsLocale.value));
};
els.settingsLocalShell.onchange = async () => {
  const next = els.settingsLocalShell.value as LocalShellId;
  if (next !== "powershell" && next !== "cmd" && next !== "gitbash") return;
  state.localShell = next;
  await api.setLocalShell(next);
  chat.addSystem(t("settings.localShellSaved", { shell: t(`settings.shell.${next}`) }));
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
  closeModePopover();
  closeModelPopover();
});
let navCollapsed = false;

function applyPanelLayout(): void {
  const layout = document.querySelector(".layout");
  layout?.classList.toggle("nav-collapsed", navCollapsed);
  const navBtn = document.getElementById("btn-toggle-nav");
  navBtn?.setAttribute("aria-pressed", navCollapsed ? "false" : "true");
  navBtn?.classList.toggle("active", !navCollapsed);
  try {
    localStorage.setItem("drift.navCollapsed", navCollapsed ? "1" : "0");
  } catch {
    /* ignore */
  }
  requestAnimationFrame(() => refitTerminals());
}

try {
  navCollapsed = localStorage.getItem("drift.navCollapsed") === "1";
} catch {
  /* ignore */
}
applyPanelLayout();

function toggleNavPanel(): void {
  navCollapsed = !navCollapsed;
  applyPanelLayout();
}

document.getElementById("btn-toggle-nav")!.onclick = () => {
  toggleNavPanel();
};

async function sendPrompt(cardId: string): Promise<void> {
  if (isCardGenerating(cardId)) return;
  activePromptCardId = cardId;
  let tabId = getPromptTabId(cardId);
  if (!tabId || activeNav === "meetings") {
    try {
      const local = await ensureActiveLocalTab();
      tabId = local.id;
      if (activeNav === "meetings") setNav("sessions");
    } catch {
      (promptChats.get(cardId) ?? noopChat).addError(t("error.openTab"));
      return;
    }
  }
  const pe = promptEls(cardId);
  if (!pe) return;
  const { text: message, refs } = readComposerFrom(pe.input);
  if (!message && !refs.length) return;
  hideMentionMenu();
  const payload = enrichPromptWithRefs(message, refs);
  const refsForBubble = refs.map((r) => ({
    name: r.name.replace(/\/$/, ""),
    kind: r.kind,
  }));
  clearComposer(cardId);
  const runChat = promptChats.get(cardId) ?? noopChat;
  runChat.addUser(message, refsForBubble);
  setGenerating(true, cardId);
  board.setPromptRunStatus(cardId, "running");
  runChat.setThinking(true, t("thinking"));
  const res = await api.sendAgent({ tabId, message: payload });
  if ("error" in res) {
    runChat.setThinking(false);
    if (isApiKeyError(res.error)) {
      openSettings();
      runChat.addError(t("settings.needKeyToast"), {
        action: {
          label: t("settings.openKeyPage"),
          onClick: () => openCursorApiKeysPage(api),
        },
      });
    } else {
      runChat.addError(res.error);
    }
    setGenerating(false, cardId);
    board.setPromptRunStatus(cardId, "error");
    return;
  }
  state.activeRunId = res.runId;
  runToPrompt.set(res.runId, cardId);
  runTurns.set(res.runId, {
    startedAssistant: false,
    turnTokens: null,
    turnModel: state.modelId,
    turnCost: null,
  });
}

function autoGrowInput(el: HTMLDivElement): void {
  el.style.height = "auto";
  el.style.height = `${Math.min(180, Math.max(64, el.scrollHeight))}px`;
}

function stopPromptAgent(cardId?: string | null): void {
  const id = cardId ?? activePromptCardId;
  const runId = id ? runIdForCard(id) : state.activeRunId;
  const tabId = id ? getPromptTabId(id) : state.activeTabId;
  void api.stopAgent({
    runId: runId ?? undefined,
    tabId: tabId || undefined,
  });
}

api.onTerminalData(({ tabId, data }) => {
  state.tabs.get(tabId)?.term.write(data);
});

api.onTerminalCwd(({ tabId, cwd }) => {
  void applyCwdToFiles(tabId, cwd);
});

function localizeProgressTitle(title: string): string {
  const map: Record<string, string> = {
    Working: t("progress.working"),
    Thinking: t("progress.thinking"),
    Replying: t("progress.replying"),
    Searching: t("progress.searching"),
    Searched: t("progress.searched"),
    Editing: t("progress.editing"),
    Edited: t("progress.edited"),
    Reading: t("progress.reading"),
    Read: t("progress.read"),
    "Running command": t("progress.runningCommand"),
    "Ran command": t("progress.ranCommand"),
    "Starting…": t("progress.starting"),
  };
  return map[title] || title;
}

api.onAgentEvent(({ runId, event }) => {
  const agentChat = chatForRun(runId);
  const cardId = runToPrompt.get(runId) ?? null;
  const turn = ensureRunTurn(runId);
  if (event.type === "progress") {
    agentChat.setActivity({
      title: localizeProgressTitle(event.title),
      detail: event.detail,
      summary: event.summary,
      done: event.done,
    });
  }
  if (event.type === "text") {
    if (!turn.startedAssistant) {
      agentChat.beginAssistant();
      turn.startedAssistant = true;
    }
    agentChat.appendAssistant(event.text);
  }
  if (event.type === "usage") {
    state.lastUsage = event.usage;
    state.lastCostCents = event.cost?.chargedCents ?? null;
    turn.turnTokens = event.usage.totalTokens;
    turn.turnModel = event.modelId ?? state.modelId;
    turn.turnCost = event.cost
      ? formatCents(event.cost.chargedCents)
      : null;
    state.turnTokens = turn.turnTokens;
    state.turnModel = turn.turnModel;
    state.turnCost = turn.turnCost;
    renderUsage();
  }
  if (event.type === "spawn" && cardId) {
    void spawnSubFromAgent(cardId, {
      title: event.title,
      task: event.task,
    });
  }
  if (event.type === "status") {
    if (event.status === "waiting-approval") {
      agentChat.setThinking(true, t("thinking.approval"));
      if (cardId) board.setPromptRunStatus(cardId, "waiting");
    }
    if (event.status === "error") {
      const detail = event.detail || "unknown error";
      const missingKey = isApiKeyError(detail);
      if (pendingApprovalsByRun.has(runId)) {
        pendingApprovalsByRun.delete(runId);
      }
      agentChat.setThinking(false);
      if (turn.startedAssistant) {
        agentChat.finishAssistant();
        turn.startedAssistant = false;
      }
      if (missingKey) {
        openSettings();
        agentChat.addError(t("settings.needKeyToast"), {
          action: {
            label: t("settings.openKeyPage"),
            onClick: () => openCursorApiKeysPage(api),
          },
        });
      } else {
        agentChat.addError(detail);
      }
      setGenerating(false, cardId);
      if (cardId) {
        board.setPromptRunStatus(cardId, "error");
        notifyParentOfSub(cardId, "failed");
      }
      clearRun(runId);
    }
    if (event.status === "cancelled") {
      if (pendingApprovalsByRun.has(runId)) {
        pendingApprovalsByRun.delete(runId);
        agentChat.resolveApprovalCard("deny");
      }
      agentChat.setThinking(false);
      if (turn.startedAssistant) {
        agentChat.finishAssistant();
        turn.startedAssistant = false;
      }
      agentChat.addSystem(event.detail || t("chat.stopped"));
      setGenerating(false, cardId);
      if (cardId) {
        board.setPromptRunStatus(cardId, "idle");
        notifyParentOfSub(cardId, "failed");
      }
      clearRun(runId);
    }
    if (event.status === "done") {
      agentChat.setThinking(false);
      if (turn.startedAssistant) {
        agentChat.finishAssistant({
          tokens: turn.turnTokens ?? undefined,
          modelId: turn.turnModel ?? undefined,
          cost: turn.turnCost ?? undefined,
        });
        turn.startedAssistant = false;
      }
      setGenerating(false, cardId);
      if (cardId) {
        board.setPromptRunStatus(cardId, "done");
        notifyParentOfSub(cardId, "finished");
      }
      clearRun(runId);
      void refreshAccountUsage();
    }
    if (event.status === "running") {
      agentChat.setThinking(true, t("thinking"));
      if (cardId) board.setPromptRunStatus(cardId, "running");
    }
  }
  if (event.type === "plan") {
    agentChat.setThinking(false);
    agentChat.addPlan(event.steps);
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
  try {
    setSplashProgress(SPLASH_AT.start, t("splash.starting"));
    setSplashProgress(SPLASH_AT.fonts, t("splash.fonts"));
    await ensureTermFont();

    setSplashProgress(SPLASH_AT.settings, t("splash.settings"));
    const settings = await api.getSettings();
    state.modelId = settings.modelId;
    state.chatMode = settings.chatMode ?? "agent";
    state.locale = normalizeLocale(settings.locale);
    state.localShell =
      settings.localShell === "cmd" || settings.localShell === "gitbash"
        ? settings.localShell
        : "powershell";
    setLocale(state.locale);
    const status = await api.getApiKeyStatus();
    state.hasKey = status.hasKey;
    state.sessionUsage = await api.getSessionUsage();
    await syncLocalShellSettingsVisibility();
    applyUiLocale();
    renderUsage();
    // Locale may have changed splash copy — refresh current line.
    setSplashProgress(SPLASH_AT.models, t("splash.models"));

    await refreshModels();
    setSplashProgress(SPLASH_AT.sessions, t("splash.sessions"));
    await refreshSessions();

    setSplashProgress(SPLASH_AT.files, t("splash.files"));
    homeDirCache = await api.getHomeDir();
    await filesBrowser.setLocalRoot(homeDirCache);
    await syncFilesPanel();

    setSplashProgress(SPLASH_AT.terminal, t("splash.terminal"));
    let savedBoard: BoardPersistedState = { cards: [] };
    try {
      savedBoard = (await api.getBoard()) as BoardPersistedState;
    } catch {
      /* first launch */
    }
    // Wait one frame so the terminal host has its final flex size.
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    await openLocal();
    restoreSavedPrompts(savedBoard);
    refreshStatusStrip();
    void refreshStripMetrics();
    void refreshAccountUsage();
    window.setInterval(() => void refreshStripMetrics(), 2500);
    window.setInterval(() => void refreshAccountUsage(), 5 * 60_000);

    setSplashProgress(SPLASH_AT.ready, t("splash.updates"));
    // Check while intro is still up so Update / Later stay on the splash.
    const updateCheck = await Promise.race([
      api.checkForUpdate(),
      new Promise<null>((r) => window.setTimeout(() => r(null), 8_000)),
    ]);
    if (
      updateCheck &&
      updateCheck.ok &&
      updateCheck.available &&
      updateCheck.update
    ) {
      showUpdateSplash(updateCheck.update);
    }
    if (!splashHeldForUpdate) {
      setSplashProgress(SPLASH_AT.ready, t("splash.ready"));
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    setSplashProgress(splashPercent, detail || t("splash.starting"));
    console.error(err);
  } finally {
    await dismissSplash();
  }
})();
