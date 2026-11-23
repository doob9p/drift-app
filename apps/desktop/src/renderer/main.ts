import "./styles.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
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
import { askFsConfirm, askFsText, createFilesBrowser } from "./files-tree.js";
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
  SHORTCUT_CATEGORIES,
  SHORTCUTS,
  chordFor,
  isBoardChordEvent,
  isMacPlatform,
  type ShortcutCategory,
} from "./shortcuts.js";
import { copyText } from "./clipboard.js";
import {
  createBoardPane,
  MAX_PROMPT_SUBS,
  type BoardPane,
  type TerminalOverflowAction,
} from "./board-pane.js";
import type {
  BoardFocus,
  BoardPersistedState,
  PromptCard,
  TerminalCard,
} from "./board-types.js";
import {
  attachmentsToSdkImages,
  buildAttachmentPromptSuffix,
  fileToPromptAttachment,
  filesFromDataTransfer,
  formatAttachmentSize,
  MAX_PROMPT_ATTACHMENTS,
  type PromptAttachment,
} from "./prompt-attachments.js";

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
  search: SearchAddon;
  el: HTMLDivElement;
  findBar: HTMLDivElement;
  findInput: HTMLInputElement;
  lastCols: number;
  lastRows: number;
  fitTimer?: number;
  /** Watches the board term host so cols/rows track card resize / tile / arrange. */
  hostRo?: ResizeObserver;
  /** Ignore fit/resize until this time so the first prompt keeps a stable COLUMNS. */
  sizeFreezeUntil?: number;
};

const TERM_SEARCH_OPTS: ISearchOptions = {
  caseSensitive: false,
  incremental: true,
  decorations: {
    matchBackground: "rgba(212, 163, 90, 0.35)",
    matchOverviewRuler: "rgba(212, 163, 90, 0.7)",
    activeMatchBackground: "rgba(79, 143, 202, 0.55)",
    activeMatchColorOverviewRuler: "rgba(79, 143, 202, 0.9)",
  },
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
  christmasTheme: false,
  christmasSnowAmount: 0.55,
  christmasSnowSpeed: 0.5,
  christmasSnowSmooth: false,
  autumnTheme: false,
  autumnLeafAmount: 0.55,
  autumnLeafSpeed: 0.5,
  sakuraTheme: false,
  sakuraPetalAmount: 0.55,
  sakuraPetalSpeed: 0.5,
  rainTheme: false,
  rainAmount: 0.55,
  rainSpeed: 0.5,
  firefliesTheme: false,
  firefliesAmount: 0.55,
  firefliesSpeed: 0.5,
  appVersion: "" as string,
  appPackaged: false,
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
        <button type="button" class="chrome-btn" id="btn-toggle-nav" data-i18n-title="chrome.toggleNav" data-shortcut="toggle-nav" title="Toggle sidebar" aria-label="Toggle sidebar" aria-pressed="true">
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
            <button type="button" class="sidebar-add-ssh" id="btn-add-ssh" data-i18n="sidebar.addSsh">Add SSH</button>
          </div>
          <div class="section-label section-label-hosts">
            <span data-i18n="sidebar.ssh">Hosts</span>
            <div class="section-label-actions" role="group" aria-label="Host folders">
              <button
                type="button"
                class="icon ghost section-label-btn"
                id="btn-add-folder"
                data-i18n-title="sidebar.addFolder"
                title="New folder"
                aria-label="New folder"
              >${icons.folderPlus(14)}</button>
              <button
                type="button"
                class="icon ghost section-label-btn"
                id="btn-refresh-sessions"
                data-i18n-title="sidebar.refreshHosts"
                title="Refresh"
                aria-label="Refresh"
              >${icons.refresh(14)}</button>
              <button
                type="button"
                class="icon ghost section-label-btn"
                id="btn-collapse-folders"
                data-i18n-title="sidebar.collapseFolders"
                title="Collapse folders"
                aria-label="Collapse folders"
              >${icons.foldVertical(14)}</button>
            </div>
          </div>
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
                      <button type="button" class="icon ghost files-back" data-path-back data-i18n-title="files.up" title="Go up" aria-label="Go up" disabled>${icons.back(16)}</button>
                      <nav class="files-path" aria-label="Path"></nav>
                    </div>
                    <div class="files-toolbar">
                      <label class="files-filter-wrap">
                        <span class="files-filter-ico">${icons.search(12)}</span>
                        <input class="files-filter" type="search" data-i18n-placeholder="files.filter" placeholder="Filter" />
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
                      <button type="button" class="icon ghost files-back" data-path-back data-i18n-title="files.up" title="Go up" aria-label="Go up" disabled>${icons.back(16)}</button>
                      <nav class="files-path" aria-label="Path"></nav>
                      <button type="button" class="icon ghost files-open-folder" data-open-folder data-i18n-title="files.openFolder" title="Open folder" aria-label="Open folder">${icons.folderOpen(13)}</button>
                    </div>
                    <div class="files-toolbar">
                      <label class="files-filter-wrap">
                        <span class="files-filter-ico">${icons.search(12)}</span>
                        <input class="files-filter" type="search" data-i18n-placeholder="files.filter" placeholder="Filter" />
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
            <section class="settings-section">
              <div class="form-grid settings-form">
                <div class="settings-api-key">
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
                  <span class="settings-hint" data-i18n="settings.lead"
                    >API key is encrypted in the OS keychain. Sessions never store secrets.</span
                  >
                </div>
              </div>
            </section>
            <section class="settings-section">
              <div class="form-grid settings-form">
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
                <div class="settings-theme-block">
                  <label class="settings-board-theme" id="settings-board-theme-row">
                    <span data-i18n="settings.boardTheme">Board theme</span>
                    <select id="settings-board-theme">
                      <option value="off" data-i18n="settings.boardThemeOff">Off</option>
                      <option value="christmas" data-i18n="settings.boardThemeChristmas">Christmas snow</option>
                      <option value="autumn" data-i18n="settings.boardThemeAutumn">Autumn leaves</option>
                      <option value="sakura" data-i18n="settings.boardThemeSakura">Cherry blossoms</option>
                      <option value="rain" data-i18n="settings.boardThemeRain">Rain</option>
                      <option value="fireflies" data-i18n="settings.boardThemeFireflies">Fireflies</option>
                    </select>
                    <span class="settings-hint" id="settings-board-theme-hint" data-i18n="settings.boardThemeHintOff"
                      >Seasonal overlays for the board. Pick one theme at a time.</span
                    >
                  </label>
                  <div class="settings-snow-controls" id="settings-board-theme-controls" hidden>
                    <label class="settings-snow-slider" for="settings-theme-amount">
                      <span class="settings-snow-slider-label" data-i18n="settings.themeAmount">Amount</span>
                      <div class="settings-snow-slider-track">
                        <span class="settings-snow-end low" aria-hidden="true">···</span>
                        <input
                          type="range"
                          id="settings-theme-amount"
                          min="0"
                          max="100"
                          step="1"
                          value="55"
                        />
                        <span class="settings-snow-end high" aria-hidden="true">••••</span>
                      </div>
                    </label>
                    <label class="settings-snow-slider" for="settings-theme-speed">
                      <span class="settings-snow-slider-label" data-i18n="settings.themeSpeed">Speed</span>
                      <div class="settings-snow-slider-track">
                        <span class="settings-snow-end low" aria-hidden="true">›</span>
                        <input
                          type="range"
                          id="settings-theme-speed"
                          min="0"
                          max="100"
                          step="1"
                          value="50"
                        />
                        <span class="settings-snow-end high" aria-hidden="true">»</span>
                      </div>
                    </label>
                    <label
                      class="settings-toggle-row settings-snow-smooth"
                      for="settings-snow-smooth"
                      id="settings-snow-smooth-row"
                      hidden
                    >
                      <span class="settings-toggle-copy">
                        <span data-i18n="settings.christmasSnowSmooth">Smoother (uses more CPU)</span>
                      </span>
                      <input
                        type="checkbox"
                        id="settings-snow-smooth"
                        class="settings-toggle"
                      />
                    </label>
                    <button
                      type="button"
                      class="settings-snow-clear"
                      id="btn-clear-theme"
                      data-i18n="settings.themeClear"
                    >
                      Clear overlay
                    </button>
                  </div>
                </div>
              </div>
            </section>
            <section class="settings-section settings-about" id="settings-about" hidden>
              <div class="settings-about-head">
                <span class="settings-about-label" data-i18n="settings.about"
                  >Version</span
                >
                <p class="settings-version" id="settings-version"></p>
              </div>
              <p
                class="settings-update-status"
                id="settings-update-status"
                aria-live="polite"
              ></p>
              <div class="settings-about-actions">
                <button
                  type="button"
                  class="settings-update-check"
                  id="btn-check-update"
                  data-i18n="settings.checkUpdate"
                >
                  Check for updates
                </button>
                <button
                  type="button"
                  class="primary settings-update-go hidden"
                  id="btn-go-update"
                  data-i18n="update.download"
                >
                  Update
                </button>
              </div>
            </section>
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

  <div
    class="modal-backdrop hidden"
    id="modal-shortcuts"
    role="dialog"
    aria-modal="true"
    aria-labelledby="shortcuts-title"
  >
    <div class="modal modal-shortcuts">
      <header class="shortcuts-head">
        <div class="shortcuts-head-copy">
          <h2 id="shortcuts-title" data-i18n="shortcuts.title">Keyboard shortcuts</h2>
          <p class="lead" data-i18n="shortcuts.lead">
            Shortcuts for Drift. Menu items stay in sync with this list.
          </p>
        </div>
        <button
          type="button"
          class="ghost shortcuts-close"
          id="btn-shortcuts-close"
          data-i18n-title="shortcuts.close"
          title="Close"
          aria-label="Close"
        >${icons.close(14)}</button>
      </header>
      <input
        type="search"
        id="shortcuts-filter"
        class="shortcuts-filter"
        data-i18n-placeholder="shortcuts.filter"
        placeholder="Filter shortcuts"
        autocomplete="off"
        spellcheck="false"
      />
      <div class="shortcuts-list" id="shortcuts-list"></div>
    </div>
  </div>

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
          <span class="field-label"
            ><span data-i18n="ssh.password">Password</span
            ><abbr class="req" data-i18n-title="ssh.required" title="Required">*</abbr></span
          >
          <div class="ssh-password-row" id="ssh-password-unset">
            <input
              id="ssh-password"
              type="password"
              autocomplete="new-password"
              spellcheck="false"
              required
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
  modalShortcuts: document.getElementById("modal-shortcuts")!,
  shortcutsList: document.getElementById("shortcuts-list")!,
  shortcutsFilter: document.getElementById(
    "shortcuts-filter"
  ) as HTMLInputElement,
  btnShortcutsClose: document.getElementById(
    "btn-shortcuts-close"
  ) as HTMLButtonElement,
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
  settingsBoardTheme: document.getElementById(
    "settings-board-theme"
  ) as HTMLSelectElement,
  settingsBoardThemeHint: document.getElementById(
    "settings-board-theme-hint"
  ) as HTMLElement,
  settingsBoardThemeControls: document.getElementById(
    "settings-board-theme-controls"
  ) as HTMLElement,
  settingsThemeAmount: document.getElementById(
    "settings-theme-amount"
  ) as HTMLInputElement,
  settingsThemeSpeed: document.getElementById(
    "settings-theme-speed"
  ) as HTMLInputElement,
  settingsSnowSmoothRow: document.getElementById(
    "settings-snow-smooth-row"
  ) as HTMLElement,
  settingsSnowSmooth: document.getElementById(
    "settings-snow-smooth"
  ) as HTMLInputElement,
  btnClearTheme: document.getElementById(
    "btn-clear-theme"
  ) as HTMLButtonElement,
  settingsAbout: document.getElementById("settings-about") as HTMLElement,
  settingsVersion: document.getElementById("settings-version") as HTMLElement,
  settingsUpdateStatus: document.getElementById(
    "settings-update-status"
  ) as HTMLElement,
  btnCheckUpdate: document.getElementById(
    "btn-check-update"
  ) as HTMLButtonElement,
  btnGoUpdate: document.getElementById("btn-go-update") as HTMLButtonElement,
  modePopover: document.getElementById("mode-popover")!,
  modeTip: document.getElementById("mode-tip")!,
  composerPopovers: document.getElementById("composer-popovers")!,
};

const promptChats = new Map<string, ChatController>();
const promptAttachments = new Map<string, PromptAttachment[]>();
let activePromptCardId: string | null = null;
const runToPrompt = new Map<string, string>();
const generatingCards = new Set<string>();
/** Cursor SDK agent id per prompt card — follow-ups resume the same conversation. */
const promptAgentSessions = new Map<
  string,
  { agentId: string; storeCwd: string }
>();
/** Session events may arrive before runToPrompt is wired; hold by runId briefly. */
const pendingRunSessions = new Map<
  string,
  { agentId: string; storeCwd: string }
>();

function bindRunToPrompt(runId: string, cardId: string): void {
  runToPrompt.set(runId, cardId);
  const pending = pendingRunSessions.get(runId);
  if (pending) {
    promptAgentSessions.set(cardId, pending);
    pendingRunSessions.delete(runId);
    scheduleBoardSave();
  }
}

type QueuedPrompt = {
  id: string;
  message: string;
  payload: string;
  images?: Array<{ data: string; mimeType: string }>;
  refsForBubble: { name: string; kind: "file" | "dir" }[];
  attsForBubble: {
    name: string;
    kind: "image" | "text" | "binary";
    previewUrl?: string;
  }[];
};

const promptQueues = new Map<string, QueuedPrompt[]>();

function newQueueId(): string {
  return `q_${Math.random().toString(36).slice(2, 10)}`;
}

function getPromptQueue(cardId: string): QueuedPrompt[] {
  let q = promptQueues.get(cardId);
  if (!q) {
    q = [];
    promptQueues.set(cardId, q);
  }
  return q;
}

function clearPromptQueue(cardId: string): void {
  const chat = promptChats.get(cardId);
  for (const item of promptQueues.get(cardId) || []) {
    chat?.removeQueuedUser(item.id);
  }
  promptQueues.delete(cardId);
}
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
  pendingRunSessions.delete(runId);
  if (state.activeRunId === runId) state.activeRunId = null;
}

const noopChat: ChatController = {
  clear: () => {},
  showEmpty: () => {},
  addUser: () => null,
  setRunningUser: () => {},
  clearRunningUser: () => {},
  promoteQueuedUser: () => {},
  removeQueuedUser: () => {},
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
  getMessages: () => [],
  restoreMessages: () => {},
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

function flushPromptPersistIntoBoard(): void {
  for (const card of board.getCards()) {
    if (card.kind !== "prompt") continue;
    const ctrl = promptChats.get(card.id);
    if (ctrl) card.messages = ctrl.getMessages();
    const session = promptAgentSessions.get(card.id);
    if (session?.agentId && session.storeCwd) {
      card.agentId = session.agentId;
      card.agentStoreCwd = session.storeCwd;
    } else {
      delete card.agentId;
      delete card.agentStoreCwd;
    }
  }
}

function scheduleBoardSave(): void {
  if (boardSaveTimer != null) window.clearTimeout(boardSaveTimer);
  boardSaveTimer = window.setTimeout(() => {
    boardSaveTimer = undefined;
    flushPromptPersistIntoBoard();
    void api.saveBoard(board.toPersisted());
  }, 400);
}

const chat: ChatController = {
  clear: () => activeChat()?.clear(),
  showEmpty: (suggestions) => activeChat()?.showEmpty(suggestions),
  addUser: (text, refs, attachments, opts) =>
    activeChat()?.addUser(text, refs, attachments, opts) ?? null,
  setRunningUser: (onStop) => activeChat()?.setRunningUser(onStop),
  clearRunningUser: () => activeChat()?.clearRunningUser(),
  promoteQueuedUser: (queueId, onStop) =>
    activeChat()?.promoteQueuedUser(queueId, onStop),
  removeQueuedUser: (queueId) => activeChat()?.removeQueuedUser(queueId),
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
  getMessages: () => activeChat()?.getMessages() ?? [],
  restoreMessages: (messages) => activeChat()?.restoreMessages(messages),
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

type SettingsUpdateUi = {
  status: "idle" | "checking" | "latest" | "available" | "dev" | "error";
  latestVersion: string;
  error: string;
  update: {
    version: string;
    currentVersion: string;
    releaseName?: string | null;
    releaseNotes?: string | null;
  } | null;
};

let settingsUpdateUi: SettingsUpdateUi = {
  status: "idle",
  latestVersion: "",
  error: "",
  update: null,
};

function renderSettingsVersion(): void {
  const about = els.settingsAbout;
  const el = els.settingsVersion;
  if (!state.appVersion) {
    about.hidden = true;
    el.textContent = "";
    els.settingsUpdateStatus.textContent = "";
    els.btnGoUpdate.classList.add("hidden");
    return;
  }
  about.hidden = false;
  el.textContent = state.appPackaged
    ? t("settings.version", { version: state.appVersion })
    : t("settings.versionDev", { version: state.appVersion });
  renderSettingsUpdateUi();
}

function renderSettingsUpdateUi(): void {
  const status = els.settingsUpdateStatus;
  const checkBtn = els.btnCheckUpdate;
  const goBtn = els.btnGoUpdate;
  const checking = settingsUpdateUi.status === "checking";
  checkBtn.disabled = checking || !state.appPackaged;
  checkBtn.textContent = checking
    ? t("settings.checkingUpdate")
    : t("settings.checkUpdate");

  switch (settingsUpdateUi.status) {
    case "idle":
    case "dev":
      status.textContent = "";
      goBtn.classList.add("hidden");
      break;
    case "checking":
      status.textContent = t("settings.checkingUpdate");
      goBtn.classList.add("hidden");
      break;
    case "latest":
      status.textContent = t("settings.upToDate");
      goBtn.classList.add("hidden");
      break;
    case "available":
      status.textContent = t("settings.updateAvailable", {
        version: settingsUpdateUi.latestVersion,
      });
      goBtn.classList.remove("hidden");
      goBtn.textContent = t("update.download");
      break;
    case "error":
      status.textContent = t("update.error", {
        error: settingsUpdateUi.error || "unknown",
      });
      goBtn.classList.add("hidden");
      break;
  }
}

async function checkSettingsUpdate(): Promise<void> {
  settingsUpdateUi = {
    ...settingsUpdateUi,
    status: "checking",
    error: "",
  };
  renderSettingsUpdateUi();
  try {
    const result = await api.checkForUpdate();
    if (!result.ok) {
      settingsUpdateUi = {
        status: result.reason === "dev" ? "dev" : "error",
        latestVersion: "",
        error: result.message ?? result.reason,
        update: null,
      };
      renderSettingsUpdateUi();
      return;
    }
    const latest = result.versionInfo ?? "";
    const newer = !!latest && latest !== state.appVersion;
    if (newer) {
      const update =
        result.update ??
        ({
          version: latest,
          currentVersion: state.appVersion,
          releaseNotes: null,
        } as const);
      settingsUpdateUi = {
        status: "available",
        latestVersion: update.version,
        error: "",
        update,
      };
    } else {
      settingsUpdateUi = {
        status: "latest",
        latestVersion: latest || state.appVersion,
        error: "",
        update: null,
      };
    }
  } catch (err) {
    settingsUpdateUi = {
      status: "error",
      latestVersion: "",
      error: err instanceof Error ? err.message : String(err),
      update: null,
    };
  }
  renderSettingsUpdateUi();
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
  syncBoardThemeUi();
  renderSettingsVersion();
  if (!els.modalShortcuts.classList.contains("hidden")) {
    renderShortcutsPanel(els.shortcutsFilter.value);
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
    if (broadcastOn) syncBroadcastChrome();
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
  const prev = state.chatMode;
  state.chatMode = mode;
  await api.setChatMode(mode);
  renderModeChip();
  closeModePopover();
  // Cursor: each mode uses its own context — switching starts a fresh window.
  if (prev !== mode) {
    resetAgentSessionsForModeChange();
  }
  chat.addSystem(t("mode.changed", { mode: t(`mode.${mode}`) }));
}

/** Drop Cursor agent ids so the next send is Agent.create (new context), not resume. */
function resetAgentSessionsForModeChange(): void {
  promptAgentSessions.clear();
  pendingRunSessions.clear();
  for (const card of board.getCards()) {
    if (card.kind !== "prompt") continue;
    delete card.agentId;
    delete card.agentStoreCwd;
  }
  scheduleBoardSave();
}

const SSH_FOLDERS_KEY = "drift.sshFolders";
const SSH_FOLDERS_COLLAPSED_KEY = "drift.sshFoldersCollapsed";
const SESSION_DND_TYPE = "application/x-drift-session-id";
const FOLDER_DND_TYPE = "application/x-drift-folder-name";

function normalizeFolderName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

function folderKey(name: string): string {
  return name.toLocaleLowerCase("en");
}

function loadStoredFolderNames(): string[] {
  try {
    const raw = localStorage.getItem(SSH_FOLDERS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      const name = normalizeFolderName(item);
      if (!name) continue;
      const key = folderKey(name);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
    return out;
  } catch {
    return [];
  }
}

function saveStoredFolderNames(names: string[]): void {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = normalizeFolderName(raw);
    if (!name) continue;
    const key = folderKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  // Preserve caller order — folders can be reordered by drag.
  try {
    localStorage.setItem(SSH_FOLDERS_KEY, JSON.stringify(out));
  } catch {
    /* ignore quota */
  }
}

function mergedFolderNames(sessions: SavedSession[]): string[] {
  const names = loadStoredFolderNames();
  const seen = new Set(names.map(folderKey));
  let changed = false;
  for (const s of sessions) {
    const name = normalizeFolderName(s.folder ?? "");
    if (!name) continue;
    const key = folderKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    changed = true;
  }
  if (changed) saveStoredFolderNames(names);
  return names;
}

function clearFolderReorderMarks(): void {
  for (const el of els.sessionList.querySelectorAll(".session-folder")) {
    el.classList.remove("is-drop-before", "is-drop-after", "is-dragging");
  }
}

function reorderSshFolder(
  from: string,
  to: string,
  place: "before" | "after"
): void {
  if (folderKey(from) === folderKey(to)) return;
  const names = mergedFolderNames(state.sessions);
  const fromIdx = names.findIndex((n) => folderKey(n) === folderKey(from));
  if (fromIdx < 0) return;
  const [item] = names.splice(fromIdx, 1);
  if (!item) return;
  let insertAt = names.findIndex((n) => folderKey(n) === folderKey(to));
  if (insertAt < 0) return;
  if (place === "after") insertAt += 1;
  names.splice(insertAt, 0, item);
  saveStoredFolderNames(names);
  void refreshSessions();
}

function loadCollapsedFolders(): Set<string> {
  try {
    const raw = localStorage.getItem(SSH_FOLDERS_COLLAPSED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed
        .filter((x): x is string => typeof x === "string")
        .map((x) => folderKey(x))
    );
  } catch {
    return new Set();
  }
}

function saveCollapsedFolders(keys: Set<string>): void {
  try {
    localStorage.setItem(
      SSH_FOLDERS_COLLAPSED_KEY,
      JSON.stringify([...keys])
    );
  } catch {
    /* ignore */
  }
}

function isFolderCollapsed(name: string): boolean {
  return loadCollapsedFolders().has(folderKey(name));
}

function setFolderCollapsed(name: string, collapsed: boolean): void {
  const keys = loadCollapsedFolders();
  const key = folderKey(name);
  if (collapsed) keys.add(key);
  else keys.delete(key);
  saveCollapsedFolders(keys);
}

function findFolderName(
  names: string[],
  needle: string
): string | undefined {
  const key = folderKey(needle);
  return names.find((n) => folderKey(n) === key);
}

function sessionSaveInput(
  session: SavedSession,
  patch: Partial<SavedSession> = {}
): Omit<SavedSession, "id" | "createdAt" | "updatedAt"> & { id?: string } {
  const next = { ...session, ...patch };
  return {
    id: next.id,
    name: next.name,
    folder: next.folder,
    host: next.host,
    user: next.user,
    port: next.port,
    identityFile: next.identityFile,
    authorizedKeyIdentity: next.authorizedKeyIdentity,
    proxyJump: next.proxyJump,
    startDir: next.startDir,
    sshConfigHost: next.sshConfigHost,
  };
}

async function setSessionFolder(
  session: SavedSession,
  folder: string | undefined
): Promise<void> {
  const next = folder ? normalizeFolderName(folder) || undefined : undefined;
  const prev = normalizeFolderName(session.folder ?? "") || undefined;
  if (prev === next) return;
  await api.saveSession(sessionSaveInput(session, { folder: next }));
  await refreshSessions();
}

function updateSessionEmpty(): void {
  const hasFolders = loadStoredFolderNames().length > 0;
  const hasContent = state.sessions.length > 0 || hasFolders;
  els.sessionEmpty.classList.toggle("hidden", hasContent);
}

function setGenerating(on: boolean, cardId?: string | null): void {
  const id = cardId ?? activePromptCardId;
  if (id) {
    if (on) generatingCards.add(id);
    else generatingCards.delete(id);
    board.setPromptSendBusy(id, on);
    const input = board.getPromptEls(id)?.input;
    if (input) {
      input.contentEditable = "true";
      input.classList.remove("is-disabled");
    }
    const chat = promptChats.get(id);
    if (on) {
      chat?.setRunningUser(() => stopPromptAgent(id));
    } else {
      chat?.clearRunningUser();
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

function getPromptAttachments(cardId: string): PromptAttachment[] {
  return promptAttachments.get(cardId) ?? [];
}

function clearPromptAttachments(cardId: string): void {
  const list = promptAttachments.get(cardId) || [];
  for (const att of list) {
    if (att.previewUrl?.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(att.previewUrl);
      } catch {
        /* ignore */
      }
    }
  }
  promptAttachments.delete(cardId);
  renderPromptAttachments(cardId);
}

function renderPromptAttachments(cardId: string): void {
  const pe = promptEls(cardId);
  if (!pe?.attachments) return;
  const list = getPromptAttachments(cardId);
  pe.attachments.classList.toggle("hidden", list.length === 0);
  pe.attachments.innerHTML = list
    .map((att) => {
      const thumb =
        att.kind === "image" && att.previewUrl
          ? `<img class="composer-att-thumb" src="${escapeHtml(att.previewUrl)}" alt="" />`
          : `<span class="composer-att-file" aria-hidden="true">${icons.file(14)}</span>`;
      return `<div class="composer-att" data-att-id="${escapeHtml(att.id)}">
        ${thumb}
        <div class="composer-att-meta">
          <span class="composer-att-name" title="${escapeHtml(att.name)}">${escapeHtml(att.name)}</span>
          <span class="composer-att-size">${escapeHtml(formatAttachmentSize(att.size))}</span>
        </div>
        <button type="button" class="composer-att-remove" data-att-remove="${escapeHtml(att.id)}" title="${escapeHtml(t("chat.attach.remove"))}" aria-label="${escapeHtml(t("chat.attach.remove"))}">${icons.close(10)}</button>
      </div>`;
    })
    .join("");
}

async function addPromptAttachmentFiles(
  cardId: string,
  files: File[]
): Promise<void> {
  if (!files.length) return;
  const next = [...getPromptAttachments(cardId)];
  for (const file of files) {
    const result = await fileToPromptAttachment(file, next.length);
    if (!result.ok) {
      if (result.reason === "too_many") {
        showToast(t("chat.attach.tooMany"), "info");
        break;
      }
      if (result.reason === "too_large") {
        showToast(t("chat.attach.tooLarge", { name: result.name }), "info");
        continue;
      }
      showToast(t("chat.attach.readFail", { name: result.name }), "error");
      continue;
    }
    next.push(result.attachment);
  }
  promptAttachments.set(cardId, next.slice(0, MAX_PROMPT_ATTACHMENTS));
  renderPromptAttachments(cardId);
}

function removePromptAttachment(cardId: string, attId: string): void {
  const list = getPromptAttachments(cardId);
  const next: PromptAttachment[] = [];
  for (const att of list) {
    if (att.id === attId) {
      if (att.previewUrl?.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(att.previewUrl);
        } catch {
          /* ignore */
        }
      }
      continue;
    }
    next.push(att);
  }
  if (next.length) promptAttachments.set(cardId, next);
  else promptAttachments.delete(cardId);
  renderPromptAttachments(cardId);
}

/** Blocks accidental re-send / IME leftovers right after Enter submit. */
const composerSendGuardUntil = new Map<string, number>();

function armComposerSendGuard(cardId: string): void {
  composerSendGuardUntil.set(cardId, Date.now() + 400);
  const pe = promptEls(cardId);
  if (!pe) return;
  const sweep = () => {
    if (Date.now() > (composerSendGuardUntil.get(cardId) ?? 0)) return;
    // Hangul IME often re-inserts the last jamo into the emptied editor.
    if ((pe.input.textContent || "").replace(/\u200b/g, "").trim()) {
      pe.input.innerHTML = "";
      syncComposerEmpty(cardId);
      autoGrowInput(pe.input);
    }
  };
  requestAnimationFrame(sweep);
  window.setTimeout(sweep, 0);
  window.setTimeout(sweep, 40);
  window.setTimeout(sweep, 120);
}

function isComposerSendGuarded(cardId: string): boolean {
  return Date.now() < (composerSendGuardUntil.get(cardId) ?? 0);
}

function isImeComposingKey(e: KeyboardEvent): boolean {
  // keyCode 229 = IME processing (Chromium/Windows); isComposing covers macOS Hangul.
  return e.isComposing || e.keyCode === 229;
}

function clearComposer(cardId: string, opts?: { guardIme?: boolean }): void {
  const pe = promptEls(cardId);
  if (!pe) return;
  pe.input.innerHTML = "";
  clearPromptAttachments(cardId);
  syncComposerEmpty(cardId);
  autoGrowInput(pe.input);
  if (opts?.guardIme) armComposerSendGuard(cardId);
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

/** True when the open SSH modal already has an encrypted password on disk. */
let sshModalHasPassword = false;

function syncSshPasswordUi(hasSaved: boolean): void {
  const form = sshFormEls();
  const editing = Boolean(form.editId.value.trim());
  sshModalHasPassword = hasSaved;
  form.passwordUnset.classList.toggle("hidden", hasSaved);
  form.passwordSet.classList.toggle("hidden", !hasSaved);
  form.password.required = !hasSaved;
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
  requestAnimationFrame(() => {
    if (!form.name.value.trim()) form.name.focus();
    else if (!sshModalHasPassword) form.password.focus();
    else form.name.focus();
  });
}

function closeSshModal(): void {
  els.modalSsh.classList.add("hidden");
  const form = sshFormEls();
  form.editId.value = "";
  form.password.value = "";
  form.advanced.open = false;
  syncSshPasswordUi(false);
}

function createSessionListItem(s: SavedSession): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "session-item";
  li.draggable = true;
  li.dataset.sessionId = s.id;
  const open = document.createElement("button");
  open.className = "row";
  open.type = "button";
  const hostMeta = `${s.user}@${s.host}${s.port && s.port !== 22 ? `:${s.port}` : ""}`;
  open.innerHTML = `<strong title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</strong><span class="meta" title="${escapeHtml(hostMeta)}">${escapeHtml(hostMeta)}</span>`;
  open.onclick = () => void openSsh(s.id);
  const actions = document.createElement("div");
  actions.className = "session-actions";
  const edit = document.createElement("button");
  edit.className = "session-action ghost";
  edit.type = "button";
  edit.title = t("ssh.edit");
  edit.setAttribute("aria-label", `${t("ssh.edit")} ${s.name}`);
  edit.innerHTML = icons.pencil(14);
  edit.onclick = (e) => {
    e.stopPropagation();
    void openSshModal(s);
  };
  const del = document.createElement("button");
  del.className = "session-action ghost";
  del.type = "button";
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

  li.addEventListener("dragstart", (e) => {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData(SESSION_DND_TYPE, s.id);
    e.dataTransfer.setData("text/plain", s.id);
    e.dataTransfer.effectAllowed = "move";
    li.classList.add("is-dragging");
    els.sessionList.classList.add("is-dragging-session");
  });
  li.addEventListener("dragend", () => {
    li.classList.remove("is-dragging");
    els.sessionList.classList.remove("is-dragging-session");
    els.sessionList.classList.remove("is-drop-ungrouped");
    for (const el of els.sessionList.querySelectorAll(".is-drop-target")) {
      el.classList.remove("is-drop-target");
    }
    clearFolderReorderMarks();
  });

  return li;
}

let sessionListDropWired = false;

function wireFolderDropTarget(
  el: HTMLElement,
  folder: string | undefined
): void {
  el.addEventListener("dragover", (e) => {
    if (!els.sessionList.classList.contains("is-dragging-session")) return;
    e.preventDefault();
    // Folder targets must stop bubbling so the root list does not also
    // highlight as the ungrouped drop zone.
    if (folder) e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (folder) {
      el.classList.add("is-drop-target");
      els.sessionList.classList.remove("is-drop-ungrouped");
    } else {
      els.sessionList.classList.add("is-drop-ungrouped");
    }
  });
  el.addEventListener("dragleave", (e) => {
    const related = e.relatedTarget as Node | null;
    if (related && el.contains(related)) return;
    el.classList.remove("is-drop-target");
    if (!folder) els.sessionList.classList.remove("is-drop-ungrouped");
  });
  el.addEventListener("drop", (e) => {
    if (!els.sessionList.classList.contains("is-dragging-session")) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove("is-drop-target");
    els.sessionList.classList.remove("is-drop-ungrouped");
    const id =
      e.dataTransfer?.getData(SESSION_DND_TYPE) ||
      e.dataTransfer?.getData("text/plain");
    if (!id) return;
    const session = state.sessions.find((s) => s.id === id);
    if (!session) return;
    void setSessionFolder(session, folder);
  });
}

function createFolderElement(
  folderName: string,
  sessions: SavedSession[]
): HTMLLIElement {
  const collapsed = isFolderCollapsed(folderName);
  const li = document.createElement("li");
  li.className = `session-folder${collapsed ? " is-collapsed" : ""}`;
  li.dataset.folder = folderName;
  li.draggable = true;
  wireFolderDropTarget(li, folderName);

  li.addEventListener("dragstart", (e) => {
    // Nested host rows own their own drag; ignore those here.
    if ((e.target as HTMLElement | null)?.closest?.(".session-item")) return;
    if (!e.dataTransfer) return;
    e.dataTransfer.setData(FOLDER_DND_TYPE, folderName);
    e.dataTransfer.setData("text/plain", folderName);
    e.dataTransfer.effectAllowed = "move";
    li.classList.add("is-dragging");
    els.sessionList.classList.add("is-dragging-folder");
  });
  li.addEventListener("dragend", () => {
    li.classList.remove("is-dragging");
    els.sessionList.classList.remove("is-dragging-folder");
    clearFolderReorderMarks();
  });

  const head = document.createElement("div");
  head.className = "session-folder-head";

  li.addEventListener("dragover", (e) => {
    if (!els.sessionList.classList.contains("is-dragging-folder")) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const rect = li.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    for (const other of els.sessionList.querySelectorAll(".session-folder")) {
      if (other === li) continue;
      other.classList.remove("is-drop-before", "is-drop-after");
    }
    li.classList.toggle("is-drop-before", before);
    li.classList.toggle("is-drop-after", !before);
  });
  li.addEventListener("dragleave", (e) => {
    if (!els.sessionList.classList.contains("is-dragging-folder")) return;
    const related = e.relatedTarget as Node | null;
    if (related && li.contains(related)) return;
    li.classList.remove("is-drop-before", "is-drop-after");
  });
  li.addEventListener("drop", (e) => {
    if (!els.sessionList.classList.contains("is-dragging-folder")) return;
    e.preventDefault();
    e.stopPropagation();
    const from =
      e.dataTransfer?.getData(FOLDER_DND_TYPE) ||
      e.dataTransfer?.getData("text/plain") ||
      "";
    const place = li.classList.contains("is-drop-before") ? "before" : "after";
    clearFolderReorderMarks();
    els.sessionList.classList.remove("is-dragging-folder");
    if (!from) return;
    reorderSshFolder(from, folderName, place);
  });

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "session-folder-toggle";
  toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  toggle.innerHTML = `
    <span class="folder-chevron" aria-hidden="true">${icons.chevronDown(11)}</span>
    <span class="folder-ico" aria-hidden="true">${collapsed ? icons.folder(13) : icons.folderOpen(13)}</span>
    <span class="folder-name" title="${escapeHtml(folderName)}">${escapeHtml(folderName)}</span>
    <span class="folder-count">${sessions.length}</span>
  `;
  toggle.onclick = () => {
    const next = !isFolderCollapsed(folderName);
    setFolderCollapsed(folderName, next);
    void refreshSessions();
  };

  const actions = document.createElement("div");
  actions.className = "session-folder-actions";

  const openAll = document.createElement("button");
  openAll.type = "button";
  openAll.className = "session-action ghost";
  openAll.title = t("sidebar.folderOpenAll");
  openAll.setAttribute(
    "aria-label",
    `${t("sidebar.folderOpenAll")} ${folderName}`
  );
  openAll.innerHTML = icons.terminal(13);
  openAll.disabled = sessions.length === 0;
  openAll.onclick = (e) => {
    e.stopPropagation();
    void (async () => {
      for (const s of sessions) await openSsh(s.id);
    })();
  };

  const rename = document.createElement("button");
  rename.type = "button";
  rename.className = "session-action ghost";
  rename.title = t("sidebar.folderRename");
  rename.setAttribute(
    "aria-label",
    `${t("sidebar.folderRename")} ${folderName}`
  );
  rename.innerHTML = icons.pencil(13);
  rename.onclick = (e) => {
    e.stopPropagation();
    void renameSshFolder(folderName);
  };

  const del = document.createElement("button");
  del.type = "button";
  del.className = "session-action ghost";
  del.title = t("sidebar.folderDelete");
  del.setAttribute("aria-label", `${t("sidebar.folderDelete")} ${folderName}`);
  del.innerHTML = icons.trash(13);
  del.onclick = (e) => {
    e.stopPropagation();
    void deleteSshFolder(folderName);
  };

  actions.append(openAll, rename, del);
  head.append(toggle, actions);

  const list = document.createElement("ul");
  list.className = "session-folder-list";
  if (sessions.length === 0) {
    const empty = document.createElement("p");
    empty.className = "session-folder-empty";
    empty.textContent = t("sidebar.folderEmpty");
    list.append(empty);
  } else {
    for (const s of sessions) list.append(createSessionListItem(s));
  }

  li.append(head, list);
  return li;
}

async function createSshFolder(): Promise<void> {
  const raw = await askFsText({
    title: t("sidebar.folderNewTitle"),
    initial: "",
    okLabel: t("sidebar.folderCreate"),
    cancelLabel: t("files.dialogCancel"),
  });
  if (raw === null) return;
  const name = normalizeFolderName(raw);
  if (!name) {
    showToast(t("sidebar.folderNameRequired"), "info");
    return;
  }
  const folders = mergedFolderNames(state.sessions);
  if (findFolderName(folders, name)) {
    showToast(t("sidebar.folderExists"), "info");
    return;
  }
  folders.push(name);
  saveStoredFolderNames(folders);
  setFolderCollapsed(name, false);
  await refreshSessions();
}

async function renameSshFolder(from: string): Promise<void> {
  const raw = await askFsText({
    title: t("sidebar.folderRenameTitle"),
    initial: from,
    okLabel: t("sidebar.folderRename"),
    cancelLabel: t("files.dialogCancel"),
  });
  if (raw === null) return;
  const to = normalizeFolderName(raw);
  if (!to) {
    showToast(t("sidebar.folderNameRequired"), "info");
    return;
  }
  if (folderKey(to) === folderKey(from)) {
    // Same name ignoring case — still rewrite stored casing if changed.
    if (to === from) return;
  } else {
    const folders = mergedFolderNames(state.sessions);
    if (findFolderName(folders, to)) {
      showToast(t("sidebar.folderExists"), "info");
      return;
    }
  }

  const members = state.sessions.filter(
    (s) => folderKey(s.folder ?? "") === folderKey(from)
  );
  for (const s of members) {
    await api.saveSession(sessionSaveInput(s, { folder: to }));
  }

  const nextNames = loadStoredFolderNames().map((n) =>
    folderKey(n) === folderKey(from) ? to : n
  );
  if (!findFolderName(nextNames, to)) nextNames.push(to);
  saveStoredFolderNames(nextNames);

  const collapsed = loadCollapsedFolders();
  if (collapsed.delete(folderKey(from))) {
    collapsed.add(folderKey(to));
    saveCollapsedFolders(collapsed);
  }

  await refreshSessions();
}

async function deleteSshFolder(name: string): Promise<void> {
  const ok = await askFsConfirm({
    title: t("sidebar.folderDelete"),
    body: t("sidebar.folderDeleteConfirm"),
    okLabel: t("sidebar.folderDelete"),
    cancelLabel: t("files.dialogCancel"),
    danger: true,
  });
  if (!ok) return;

  const members = state.sessions.filter(
    (s) => folderKey(s.folder ?? "") === folderKey(name)
  );
  for (const s of members) {
    await api.saveSession(sessionSaveInput(s, { folder: undefined }));
  }

  saveStoredFolderNames(
    loadStoredFolderNames().filter((n) => folderKey(n) !== folderKey(name))
  );
  const collapsed = loadCollapsedFolders();
  collapsed.delete(folderKey(name));
  saveCollapsedFolders(collapsed);

  await refreshSessions();
}

async function refreshSessions(): Promise<void> {
  state.sessions = await api.getSessions();
  const folders = mergedFolderNames(state.sessions);
  els.sessionList.innerHTML = "";
  updateSessionEmpty();

  const byFolder = new Map<string, SavedSession[]>();
  for (const name of folders) byFolder.set(folderKey(name), []);
  const ungrouped: SavedSession[] = [];
  for (const s of state.sessions) {
    const name = normalizeFolderName(s.folder ?? "");
    if (!name) {
      ungrouped.push(s);
      continue;
    }
    const key = folderKey(name);
    const bucket = byFolder.get(key);
    if (bucket) bucket.push(s);
    else ungrouped.push(s);
  }

  for (const name of folders) {
    els.sessionList.append(
      createFolderElement(name, byFolder.get(folderKey(name)) ?? [])
    );
  }

  if (folders.length > 0 && ungrouped.length > 0) {
    const label = document.createElement("li");
    label.className = "session-ungrouped-label";
    label.textContent = t("sidebar.ungrouped");
    els.sessionList.append(label);
  }

  for (const s of ungrouped) {
    els.sessionList.append(createSessionListItem(s));
  }

  // Root list accepts drops → move to ungrouped.
  if (!sessionListDropWired) {
    wireFolderDropTarget(els.sessionList, undefined);
    sessionListDropWired = true;
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
  const { input, thread, composer, attachments, attachBtn, fileInput } = pe;
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
  renderPromptAttachments(cardId);

  attachBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    fileInput.click();
  });
  fileInput.addEventListener("change", () => {
    const files = [...(fileInput.files || [])];
    fileInput.value = "";
    void addPromptAttachmentFiles(cardId, files);
  });
  attachments.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest(
      "[data-att-remove]"
    ) as HTMLElement | null;
    const id = btn?.dataset.attRemove;
    if (!id) return;
    e.preventDefault();
    removePromptAttachment(cardId, id);
  });

  let dragDepth = 0;
  const onDragEnter = (e: DragEvent) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    dragDepth += 1;
    composer.classList.add("is-dragover");
  };
  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = (e: DragEvent) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) composer.classList.remove("is-dragover");
  };
  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth = 0;
    composer.classList.remove("is-dragover");
    void addPromptAttachmentFiles(cardId, filesFromDataTransfer(e.dataTransfer));
  };
  composer.addEventListener("dragenter", onDragEnter);
  composer.addEventListener("dragover", onDragOver);
  composer.addEventListener("dragleave", onDragLeave);
  composer.addEventListener("drop", onDrop);

  input.addEventListener("paste", (e) => {
    const files = filesFromDataTransfer(e.clipboardData);
    if (!files.length) return;
    // Prefer attaching clipboard files/images; keep plain-text paste otherwise.
    e.preventDefault();
    void addPromptAttachmentFiles(cardId, files);
    const text = e.clipboardData?.getData("text/plain")?.trim();
    if (text) {
      document.execCommand("insertText", false, text);
      syncComposerEmpty(cardId);
      autoGrowInput(input);
    }
  });
  input.addEventListener("compositionend", () => {
    if (!isComposerSendGuarded(cardId)) return;
    // Drop IME commit that landed after we already cleared+sent.
    if ((input.textContent || "").replace(/\u200b/g, "").trim()) {
      input.innerHTML = "";
      syncComposerEmpty(cardId);
      autoGrowInput(input);
    }
  });

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
  promptChats.set(card.id, ctrl);
  if (card.agentId?.trim() && card.agentStoreCwd?.trim()) {
    promptAgentSessions.set(card.id, {
      agentId: card.agentId.trim(),
      storeCwd: card.agentStoreCwd.trim(),
    });
  }
  if (card.messages?.length) {
    ctrl.restoreMessages(card.messages);
  } else {
    ctrl.showEmpty(buildChatSuggestions(card.tabId));
  }
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
    if (minimized) removeBroadcastMember(card.tabId);
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
      clearPromptAttachments(id);
      clearPromptQueue(id);
      promptAgentSessions.delete(id);
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
  onTerminalOverflowAction(tabId, action) {
    void handleTerminalOverflowAction(tabId, action);
  },
  onToggleBroadcast() {
    toggleBroadcastInput();
  },
  onToggleBroadcastMember(tabId) {
    toggleBroadcastMember(tabId);
  },
  onPromptSend(cardId) {
    void sendPrompt(cardId);
  },
  onPromptInputKeydown(cardId, e) {
    const pe = promptEls(cardId);
    const input = pe?.input;
    if (!input) return;
    if (
      isCardGenerating(cardId) &&
      (e.ctrlKey || e.metaKey) &&
      e.key.toLowerCase() === "c"
    ) {
      const sel = window.getSelection();
      const copying =
        sel &&
        !sel.isCollapsed &&
        sel.anchorNode &&
        input.contains(sel.anchorNode);
      if (!copying) {
        e.preventDefault();
        stopPromptAgent(cardId);
        return;
      }
    }
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
      // Don't submit while Hangul/IME is composing — Enter commits the jamo first.
      // A second Enter from the same keypress would otherwise queue the leftover.
      if (isImeComposingKey(e) || isComposerSendGuarded(cardId)) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
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

board.root.addEventListener("board:refit-terminals", () => {
  // Card width/height animate ~280ms; fit once early and again after settle.
  scheduleBoardTerminalRefit();
});

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
  // Measure after layout; FitAddon can under-report mid CSS transition.
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

/** Refit every open terminal after board layout (tile / arrange / unlock). */
function scheduleBoardTerminalRefit(): void {
  const run = () => refitTerminals({ force: true });
  requestAnimationFrame(() => {
    run();
    requestAnimationFrame(run);
  });
  window.setTimeout(run, 60);
  window.setTimeout(run, 320);
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

function refitTerminals(opts?: { force?: boolean }): void {
  for (const tab of state.tabs.values()) {
    syncTerminalSize(tab, { force: opts?.force });
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

function splitChordTokens(chord: string): string[] {
  // Keep compound / gesture chords as a single chip.
  if (
    chord.includes(" + ") ||
    chord.includes("…") ||
    /[←↑→↓]{2,}/.test(chord)
  ) {
    return [chord];
  }
  if (/[⌘⌥⇧]/.test(chord)) {
    const tokens: string[] = [];
    for (const ch of chord) {
      if ("⌘⌥⇧".includes(ch)) tokens.push(ch);
      else break;
    }
    const rest = chord.slice(tokens.length);
    if (rest) tokens.push(rest);
    return tokens.length ? tokens : [chord];
  }
  return chord
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean);
}

function renderShortcutsPanel(filterRaw = ""): void {
  const q = filterRaw.trim().toLowerCase();
  const list = els.shortcutsList;
  list.innerHTML = "";
  let shown = 0;
  for (const category of SHORTCUT_CATEGORIES) {
    const items = SHORTCUTS.filter((s) => s.category === category).filter(
      (s) => {
        if (!q) return true;
        const label = t(s.labelKey).toLowerCase();
        const chord = chordFor(s).toLowerCase();
        const cat = t(`shortcuts.cat.${category}`).toLowerCase();
        return label.includes(q) || chord.includes(q) || cat.includes(q);
      }
    );
    if (items.length === 0) continue;
    const group = document.createElement("section");
    group.className = "shortcuts-group";
    const title = document.createElement("h3");
    title.className = "shortcuts-group-title";
    title.textContent = t(`shortcuts.cat.${category as ShortcutCategory}`);
    group.append(title);
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "shortcuts-row";
      const label = document.createElement("span");
      label.className = "shortcuts-label";
      label.textContent = t(item.labelKey);
      const keys = document.createElement("span");
      keys.className = "shortcuts-keys";
      for (const token of splitChordTokens(chordFor(item))) {
        const kbd = document.createElement("kbd");
        kbd.className = "shortcuts-key";
        kbd.textContent = token;
        keys.append(kbd);
      }
      row.append(label, keys);
      group.append(row);
      shown += 1;
    }
    list.append(group);
  }
  if (shown === 0) {
    const empty = document.createElement("p");
    empty.className = "shortcuts-empty";
    empty.textContent = t("shortcuts.empty");
    list.append(empty);
  }
}

function openShortcutsPanel(): void {
  els.modalShortcuts.classList.remove("hidden");
  renderShortcutsPanel(els.shortcutsFilter.value);
  applyDomI18n(els.modalShortcuts);
  requestAnimationFrame(() => {
    els.shortcutsFilter.focus();
    els.shortcutsFilter.select();
  });
}

function closeShortcutsPanel(): void {
  els.modalShortcuts.classList.add("hidden");
}

function closeTopModal(): boolean {
  const splash = document.getElementById("app-splash");
  if (splash && !splash.classList.contains("is-done") && splash.classList.contains("is-updating")) {
    if (updateSplash.phase === "downloading") return true;
    void dismissUpdateSplash();
    return true;
  }
  if (!els.modalShortcuts.classList.contains("hidden")) {
    closeShortcutsPanel();
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
  settingsUpdateUi = {
    status: "available",
    latestVersion: payload.version,
    error: "",
    update: payload,
  };
  renderSettingsUpdateUi();
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
      if (editorPane.isFocused()) {
        editorPane.find();
      } else if (state.activeTabId && state.tabs.has(state.activeTabId)) {
        openTerminalFind(state.activeTabId);
      } else if (editorPane.isOpen()) {
        editorPane.find();
      }
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
    case "keyboard-shortcuts":
      openShortcutsPanel();
      break;
    case "refit-terminals":
      requestAnimationFrame(() => refitTerminals());
      break;
    case "arrange-cards":
      board.arrangeCards();
      break;
    case "tile-terminals":
      board.tileOpenTerminals();
      break;
    case "fit-terminals":
      board.fitOpenTerminals();
      break;
    case "broadcast-input":
      toggleBroadcastInput();
      break;
    default:
      break;
  }
}

let broadcastOn = false;
const broadcastMembers = new Set<string>();

function syncBroadcastChrome(): void {
  board.syncBroadcastUi(broadcastOn, broadcastMembers);
}

function setBroadcastInput(on: boolean): void {
  if (on === broadcastOn) {
    syncBroadcastChrome();
    return;
  }
  broadcastOn = on;
  if (on) {
    broadcastMembers.clear();
    for (const card of board.getCards()) {
      if (card.kind === "terminal" && !card.minimized) {
        broadcastMembers.add(card.tabId);
      }
    }
    showToast(t("board.broadcastOnToast"), "info");
  } else {
    broadcastMembers.clear();
  }
  syncBroadcastChrome();
}

let lastBroadcastToggleAt = 0;

function toggleBroadcastInput(): void {
  // Menu accelerator + xterm/window keydown can both fire for ⌥⌘B;
  // ignore the duplicate so we don't on→off in one keypress.
  const now = Date.now();
  if (now - lastBroadcastToggleAt < 250) return;
  lastBroadcastToggleAt = now;
  setBroadcastInput(!broadcastOn);
}

function toggleBroadcastMember(tabId: string): void {
  if (!broadcastOn) return;
  if (broadcastMembers.has(tabId)) broadcastMembers.delete(tabId);
  else broadcastMembers.add(tabId);
  syncBroadcastChrome();
}

function removeBroadcastMember(tabId: string): void {
  if (!broadcastMembers.has(tabId)) return;
  broadcastMembers.delete(tabId);
  if (broadcastOn) syncBroadcastChrome();
}

function fanoutBroadcastInput(sourceTabId: string, data: string): void {
  if (!broadcastOn || !broadcastMembers.has(sourceTabId)) return;
  for (const tabId of broadcastMembers) {
    if (tabId === sourceTabId) continue;
    if (!state.tabs.has(tabId)) continue;
    void api.writeTerminal(tabId, data);
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

/**
 * Board surface uses CSS `transform: scale(zoom)`. xterm maps mouse with
 * getBoundingClientRect (scaled) / css.cell (unscaled), so selection lands
 * on the wrong row/col whenever zoom ≠ 1. Recompute in layout space.
 */
function patchXtermMouseForCssTransform(term: Terminal): void {
  type RenderDims = {
    dimensions: {
      css: {
        cell: { width: number; height: number };
        canvas: { width: number; height: number };
      };
    };
  };
  type MouseSvc = {
    getCoords: (
      event: MouseEvent,
      element: HTMLElement,
      colCount: number,
      rowCount: number,
      isSelection?: boolean
    ) => [number, number] | undefined;
    getMouseReportCoords: (
      event: MouseEvent,
      element: HTMLElement
    ) =>
      | { col: number; row: number; x: number; y: number }
      | undefined;
    _renderService: RenderDims;
    _charSizeService: { hasValidSize: boolean };
  };
  const core = (
    term as unknown as {
      _core?: { _mouseService?: MouseSvc; _charSizeService?: { hasValidSize: boolean } };
    }
  )._core;
  const mouse = core?._mouseService;
  if (!mouse) return;

  const cssScale = (el: HTMLElement): number => {
    const layout = el.offsetWidth;
    if (layout <= 0) return 1;
    const visual = el.getBoundingClientRect().width;
    const s = visual / layout;
    return Number.isFinite(s) && s > 0.01 ? s : 1;
  };

  const localPoint = (
    event: MouseEvent,
    element: HTMLElement
  ): { x: number; y: number } => {
    const scale = cssScale(element);
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const padL = parseInt(style.paddingLeft, 10) || 0;
    const padT = parseInt(style.paddingTop, 10) || 0;
    // rect is scaled; computed padding is layout px — scale padding to match, then unscale.
    return {
      x: (event.clientX - rect.left - padL * scale) / scale,
      y: (event.clientY - rect.top - padT * scale) / scale,
    };
  };

  mouse.getCoords = (event, element, colCount, rowCount, isSelection) => {
    if (!mouse._charSizeService.hasValidSize) return undefined;
    const { x, y } = localPoint(event, element);
    const cellW = mouse._renderService.dimensions.css.cell.width;
    const cellH = mouse._renderService.dimensions.css.cell.height;
    if (cellW <= 0 || cellH <= 0) return undefined;
    let col = Math.ceil((x + (isSelection ? cellW / 2 : 0)) / cellW);
    let row = Math.ceil(y / cellH);
    col = Math.min(Math.max(col, 1), colCount + (isSelection ? 1 : 0));
    row = Math.min(Math.max(row, 1), rowCount);
    return [col, row];
  };

  mouse.getMouseReportCoords = (event, element) => {
    if (!mouse._charSizeService.hasValidSize) return undefined;
    const pt = localPoint(event, element);
    const cellW = mouse._renderService.dimensions.css.cell.width;
    const cellH = mouse._renderService.dimensions.css.cell.height;
    const canvasW = mouse._renderService.dimensions.css.canvas.width;
    const canvasH = mouse._renderService.dimensions.css.canvas.height;
    const x = Math.min(Math.max(pt.x, 0), canvasW - 1);
    const y = Math.min(Math.max(pt.y, 0), canvasH - 1);
    return {
      col: Math.floor(x / cellW),
      row: Math.floor(y / cellH),
      x: Math.floor(x),
      y: Math.floor(y),
    };
  };
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
    // Meslo / Powerline (agnoster) needs a bit of leading — lineHeight 1
    // clips the top of prompt segments like iTerm never does.
    lineHeight: 1.2,
    letterSpacing: 0,
    // Cleared box-drawing / block glyphs render closer to iTerm.
    customGlyphs: true,
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

function createTerminalFindBar(tabId: string): {
  bar: HTMLDivElement;
  input: HTMLInputElement;
} {
  const bar = document.createElement("div");
  bar.className = "term-find cm-simple-find hidden";
  bar.innerHTML = `
    <span class="cm-simple-find-ico" aria-hidden="true">${icons.search(14)}</span>
    <input class="cm-simple-find-input" type="text" data-i18n-placeholder="term.find" placeholder="${t("term.find")}" autocomplete="off" spellcheck="false" />
    <div class="cm-simple-find-actions">
      <button type="button" class="cm-simple-find-btn" data-find="prev" data-i18n-title="term.findPrev" title="${t("term.findPrev")}" aria-label="${t("term.findPrev")}">${icons.chevronUp(14)}</button>
      <button type="button" class="cm-simple-find-btn" data-find="next" data-i18n-title="term.findNext" title="${t("term.findNext")}" aria-label="${t("term.findNext")}">${icons.chevronDown(14)}</button>
      <button type="button" class="cm-simple-find-btn" data-find="close" data-i18n-title="term.findClose" title="${t("term.findClose")}" aria-label="${t("term.findClose")}">${icons.close(14)}</button>
    </div>
  `;
  const input = bar.querySelector(".cm-simple-find-input") as HTMLInputElement;

  const runSearch = (dir: "next" | "prev") => {
    const tab = state.tabs.get(tabId);
    if (!tab) return;
    const q = input.value;
    if (!q) {
      tab.search.clearDecorations();
      return;
    }
    if (dir === "prev") tab.search.findPrevious(q, TERM_SEARCH_OPTS);
    else tab.search.findNext(q, TERM_SEARCH_OPTS);
  };

  input.addEventListener("input", () => {
    const tab = state.tabs.get(tabId);
    if (!tab) return;
    const q = input.value;
    if (!q) {
      tab.search.clearDecorations();
      return;
    }
    tab.search.findNext(q, TERM_SEARCH_OPTS);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeTerminalFind(tabId);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      runSearch(e.shiftKey ? "prev" : "next");
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g") {
      e.preventDefault();
      e.stopPropagation();
      runSearch(e.shiftKey ? "prev" : "next");
    }
  });

  bar.addEventListener("mousedown", (e) => {
    if (e.target !== input) e.preventDefault();
  });

  bar.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest(
      "[data-find]"
    ) as HTMLElement | null;
    const action = btn?.dataset.find;
    if (!action) return;
    e.preventDefault();
    if (action === "prev") runSearch("prev");
    else if (action === "next") runSearch("next");
    else if (action === "close") closeTerminalFind(tabId);
    if (action !== "close") input.focus();
  });

  return { bar, input };
}

function openTerminalFind(tabId: string): void {
  const tab = state.tabs.get(tabId);
  if (!tab) return;
  // Only one terminal find bar at a time.
  for (const other of state.tabs.values()) {
    if (other.id !== tabId) closeTerminalFind(other.id, false);
  }
  tab.findBar.classList.remove("hidden");
  applyDomI18n(tab.findBar);
  requestAnimationFrame(() => {
    tab.findInput.focus();
    tab.findInput.select();
    if (tab.findInput.value) {
      tab.search.findNext(tab.findInput.value, TERM_SEARCH_OPTS);
    }
  });
}

function closeTerminalFind(tabId: string, focusTerm = true): void {
  const tab = state.tabs.get(tabId);
  if (!tab) return;
  tab.findBar.classList.add("hidden");
  tab.search.clearDecorations();
  if (focusTerm) {
    try {
      tab.term.focus();
    } catch {
      /* disposed */
    }
  }
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
  const { bar: findBar, input: findInput } = createTerminalFindBar(tabId);
  host.append(findBar);

  const term = new Terminal(createTermTheme());
  const fit = new FitAddon();
  const search = new SearchAddon();
  const unicode11 = new Unicode11Addon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(unicode11);
  term.loadAddon(new WebLinksAddon());
  term.open(el);
  patchXtermMouseForCssTransform(term);
  try {
    // Hangul etc. must be width 2 like macOS zsh wcwidth, or wraps corrupt the prompt.
    term.unicode.activeVersion = "11";
  } catch (err) {
    console.warn("unicode11 activate failed", err);
  }
  wireTerminalScrollbar(el, term);

  term.onData((data) => {
    void api.writeTerminal(tabId, data);
    fanoutBroadcastInput(tabId, data);
  });

  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== "keydown") return true;
    if (
      ev.key === "Escape" &&
      !ev.metaKey &&
      !ev.ctrlKey &&
      !ev.altKey
    ) {
      const openFind = state.tabs.get(tabId);
      if (openFind && !openFind.findBar.classList.contains("hidden")) {
        closeTerminalFind(tabId);
        return false;
      }
      if (broadcastOn) {
        setBroadcastInput(false);
        return false;
      }
    }
    if (isBoardChordEvent(ev)) {
      // View menu / board chords — swallow so the PTY never sees them
      // (and so we don't double-toggle with the accelerator).
      const k = ev.key.toLowerCase();
      const boardKeys = isMacPlatform()
        ? new Set(["a", "s", "f", "b"])
        : new Set(["a", "e", "g", "b"]);
      if (
        boardKeys.has(k) ||
        ev.key === "ArrowLeft" ||
        ev.key === "ArrowRight" ||
        ev.key === "ArrowUp" ||
        ev.key === "ArrowDown"
      ) {
        return false;
      }
    }
    const mod = ev.metaKey || ev.ctrlKey;
    if (!mod || ev.altKey) return true;
    const key = ev.key.toLowerCase();
    if (key === "f" && !ev.shiftKey) {
      // Menu accelerator also sends find; swallow so the PTY never sees ⌘F.
      openTerminalFind(tabId);
      return false;
    }
    if (key === "g") {
      const tab = state.tabs.get(tabId);
      if (tab && !tab.findBar.classList.contains("hidden") && tab.findInput.value) {
        if (ev.shiftKey) tab.search.findPrevious(tab.findInput.value, TERM_SEARCH_OPTS);
        else tab.search.findNext(tab.findInput.value, TERM_SEARCH_OPTS);
        return false;
      }
    }
    if (key === "k" && !ev.shiftKey) {
      term.clear();
      // Local UI clear — also wipe linked broadcast terminals' scrollback.
      if (broadcastOn && broadcastMembers.has(tabId)) {
        for (const otherId of broadcastMembers) {
          if (otherId === tabId) continue;
          state.tabs.get(otherId)?.term.clear();
        }
      }
      return false;
    }
    if (key === "c" && !ev.shiftKey && term.hasSelection()) {
      void copyText(term.getSelection());
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
    search,
    el,
    findBar,
    findInput,
    lastCols: 0,
    lastRows: 0,
  };
  // Board card resize / tile / arrange change the host box — keep PTY cols in sync.
  view.hostRo = new ResizeObserver(() => {
    scheduleTerminalFit(view);
  });
  view.hostRo.observe(host);
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
  const win = api.platform === "win32" || /Windows/i.test(navigator.userAgent);
  if (win) {
    // PowerShell: single-quoted string; double embedded quotes.
    if (/^[A-Za-z0-9_.:\\/@%+=,-]+$/.test(filePath)) return filePath;
    return `'${filePath.replace(/'/g, "''")}'`;
  }
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(filePath)) return filePath;
  return `'${filePath.replace(/'/g, `'\\''`)}'`;
}

/**
 * Files over the editor limit open in a pager (`less`) instead of CodeMirror.
 * Windows local shells may lack `less` — fall back to inserting the path.
 */
async function openLargeFileInPager(
  scope: "local" | "remote",
  filePath: string,
  tabId?: string
): Promise<void> {
  const quoted = shellQuote(filePath);
  if (scope === "remote") {
    if (!tabId) return;
    const tab = state.tabs.get(tabId);
    if (!tab) return;
    activateTab(tab.id);
    await api.writeTerminal(tab.id, `less -n -- ${quoted}\n`);
    tab.term.focus();
    showToast(t("editor.openedInTerminal"), "info");
    return;
  }
  const tab = await ensureActiveLocalTab();
  activateTab(tab.id);
  if (api.platform === "win32") {
    // Git Bash / some installs have less; otherwise leave the path for the user.
    await api.writeTerminal(
      tab.id,
      `if (Get-Command less -ErrorAction SilentlyContinue) { less -n -- ${quoted} } else { Write-Host ${quoted} }\n`
    );
    showToast(t("editor.openInTerminal"), "info");
  } else {
    await api.writeTerminal(tab.id, `less -n -- ${quoted}\n`);
    showToast(t("editor.openedInTerminal"), "info");
  }
  tab.term.focus();
}

async function closeTab(tabId: string): Promise<void> {
  const tab = state.tabs.get(tabId);
  if (!tab) return;
  if (tab.fitTimer != null) window.clearTimeout(tab.fitTimer);
  tab.hostRo?.disconnect();
  tab.search.clearDecorations();
  tab.findBar.remove();
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
    clearPromptAttachments(cardId);
    clearPromptQueue(cardId);
    promptAgentSessions.delete(cardId);
    for (const [runId, cid] of [...runToPrompt]) {
      if (cid === cardId) clearRun(runId);
    }
    generatingCards.delete(cardId);
    if (activePromptCardId === cardId) activePromptCardId = null;
  }
  removeBroadcastMember(tabId);
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

async function handleTerminalOverflowAction(
  tabId: string,
  action: TerminalOverflowAction
): Promise<void> {
  if (action === "open-cursor") {
    const tab = state.tabs.get(tabId);
    if (!tab) return;
    if (tab.kind !== "local") {
      showToast(t("board.menu.openCursor.ssh"), "info");
      return;
    }
    const cwd = (await cwdForTab(tabId)) || tabCwds.get(tabId);
    if (!cwd) {
      showToast(t("board.menu.openCursor.noCwd"), "error");
      return;
    }
    const res = await api.openInCursor(cwd);
    if (!res.ok) {
      showToast(t("board.menu.openCursor.fail"), "error");
      return;
    }
    showToast(t("board.menu.openCursor.ok"), "ok");
    return;
  }
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
  const session = promptAgentSessions.get(card.id);
  const res = await api.sendAgent({
    tabId: parent.tabId,
    message,
    agentId: session?.agentId,
    agentStoreCwd: session?.storeCwd,
  });
  if ("error" in res) {
    runChat.setThinking(false);
    runChat.addError(res.error);
    setGenerating(false, card.id);
    board.setPromptRunStatus(card.id, "error");
    notifyParentOfSub(card.id, "failed");
    return;
  }
  state.activeRunId = res.runId;
  bindRunToPrompt(res.runId, card.id);
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
  let sidebarRefitTimer: number | undefined;

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

  function scheduleSidebarRefit(delayMs = 120): void {
    if (sidebarRefitTimer != null) window.clearTimeout(sidebarRefitTimer);
    sidebarRefitTimer = window.setTimeout(() => {
      sidebarRefitTimer = undefined;
      refitTerminals();
    }, delayMs);
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
    // Card chrome can track live; PTY/xterm refit waits until the drag settles.
    scheduleSidebarRefit();
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
    scheduleSidebarRefit(0);
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
    // Panel already moved via goToDir — skip setLocalRoot so cwd echo
    // cannot race and wipe the Back stack.
    await api.writeTerminal(tab.id, `cd ${shellQuote(dirPath)}\n`);
    tab.term.focus();
  },
  onLocalInsertPath: async (filePath) => {
    const tab = await ensureActiveLocalTab();
    await api.writeTerminal(tab.id, shellQuote(filePath));
    tab.term.focus();
  },
  onLocalOpenFile: async (filePath) => {
    const result = await editorPane.openLocal(filePath);
    if (!result.ok && result.error === "too_large") {
      await openLargeFileInPager("local", filePath);
    }
  },
  onOpenLocalFolder: async (dirPath) => {
    const res = await api.openPath(dirPath);
    if (!res.ok) {
      showToast(t("files.openFolderFail"), "error", {
        detail: res.error,
      });
    }
  },
  onServerOpenDir: async (dirPath) => {
    if (!filesServerTabId) return;
    const tab = state.tabs.get(filesServerTabId);
    if (!tab) return;
    tabCwds.set(tab.id, dirPath);
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
    const result = await editorPane.openRemote(filesServerTabId, filePath);
    if (!result.ok && result.error === "too_large") {
      await openLargeFileInPager("remote", filePath, filesServerTabId);
    }
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
  pickDownloadDirectory: () =>
    api.pickDirectory({
      title: t("files.downloadPick"),
      defaultPath: homeDirCache || undefined,
    }),
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
  if (!terminalCardForTab(tabId)) {
    filesFollowTabId = null;
    filesBrowser.setIdle(t("files.noTerminal"));
    return;
  }
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  if (tab.kind === "local") {
    filesServerTabId = null;
    const cur = filesBrowser.localRootPath();
    if (cur && norm(cur) === norm(cwd)) return;
    await filesBrowser.setServer({ enabled: false });
    await filesBrowser.setLocal({ enabled: true, rootPath: cwd });
    return;
  }
  filesServerTabId = tabId;
  await filesBrowser.setLocal({ enabled: false });
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
  // Files follow a board terminal card — a live PTY without a card is ignored.
  const boardTerminal = tab ? terminalCardForTab(tab.id) : undefined;
  // Restore this terminal's pane collapse / tree expand before loading paths.
  filesBrowser.setFollowSession(boardTerminal ? filesFollowTabId : null);
  if (!tab || !boardTerminal) {
    filesServerTabId = null;
    if (filesFollowTabId && !boardTerminal) filesFollowTabId = null;
    filesBrowser.setIdle(t("files.noTerminal"));
    return;
  }

  if (tab.kind === "local") {
    filesServerTabId = null;
    const cwd =
      (await cwdForTab(tab.id)) ||
      homeDirCache ||
      (await api.getHomeDir());
    await filesBrowser.setServer({ enabled: false });
    await filesBrowser.setLocal({ enabled: true, rootPath: cwd });
    return;
  }

  filesServerTabId = tab.id;
  const cwd = (await cwdForTab(tab.id)) || "~";
  await filesBrowser.setLocal({ enabled: false });
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
document.getElementById("btn-add-folder")!.onclick = () => {
  void createSshFolder();
};
document.getElementById("btn-refresh-sessions")!.onclick = () => {
  void importSshHostsFromConfig();
};
document.getElementById("btn-collapse-folders")!.onclick = () => {
  const folders = mergedFolderNames(state.sessions);
  if (folders.length === 0) return;
  const collapsed = loadCollapsedFolders();
  for (const name of folders) collapsed.add(folderKey(name));
  saveCollapsedFolders(collapsed);
  void refreshSessions();
};
document.getElementById("btn-add-ssh")!.onclick = () => {
  void openSshModal();
};
document.getElementById("btn-cancel-ssh")!.onclick = () => closeSshModal();
els.btnShortcutsClose.onclick = () => closeShortcutsPanel();
els.modalShortcuts.addEventListener("click", (e) => {
  if (e.target === els.modalShortcuts) closeShortcutsPanel();
});
els.shortcutsFilter.addEventListener("input", () => {
  renderShortcutsPanel(els.shortcutsFilter.value);
});
els.shortcutsFilter.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    closeShortcutsPanel();
  }
});
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
  const password = form.password.value.trim();
  if (!name || !host || !user) {
    showToast(t("ssh.requiredHint"), "info");
    (!name ? form.name : !host ? form.host : form.user).focus();
    return;
  }
  // Password is required for create and edit (Windows file listing cannot
  // reuse the interactive login without a stored password).
  if (!sshModalHasPassword && !password) {
    showToast(t("ssh.passwordRequiredHint"), "info");
    syncSshPasswordUi(false);
    form.password.focus();
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
    // Keep folder grouping when editing from the modal.
    folder: existing?.folder,
    // Keep imported IdentityFile if present; the modal no longer edits keys.
    identityFile: existing?.identityFile,
    authorizedKeyIdentity: existing?.authorizedKeyIdentity,
    proxyJump: proxyJump || undefined,
    startDir: startDir || undefined,
  });
  if (password) {
    const result = await api.setSshPassword(saved.id, password);
    if (!result.ok) {
      showToast(t("ssh.passwordSaveFail"), "error");
      return;
    }
  }
  closeSshModal();
  await refreshSessions();
};
async function importSshHostsFromConfig(): Promise<void> {
  const btn = document.getElementById(
    "btn-refresh-sessions"
  ) as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
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
    if (btn) btn.disabled = false;
  }
}

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
  const ok = await askFsConfirm({
    title: t("settings.clearKey"),
    body: t("settings.clearKeyConfirm"),
    okLabel: t("settings.clearKey"),
    cancelLabel: t("files.dialogCancel"),
    danger: true,
  });
  if (!ok) return;
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
function clampUnitUi(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

type BoardThemeId =
  | "off"
  | "christmas"
  | "autumn"
  | "sakura"
  | "rain"
  | "fireflies";

function currentBoardTheme(): BoardThemeId {
  if (state.christmasTheme) return "christmas";
  if (state.autumnTheme) return "autumn";
  if (state.sakuraTheme) return "sakura";
  if (state.rainTheme) return "rain";
  if (state.firefliesTheme) return "fireflies";
  return "off";
}

function boardThemeHintKey(theme: BoardThemeId): string {
  if (theme === "christmas") return "settings.christmasThemeHint";
  if (theme === "autumn") return "settings.autumnThemeHint";
  if (theme === "sakura") return "settings.sakuraThemeHint";
  if (theme === "rain") return "settings.rainThemeHint";
  if (theme === "fireflies") return "settings.firefliesThemeHint";
  return "settings.boardThemeHintOff";
}

function themeAmount(theme: BoardThemeId): number {
  if (theme === "autumn") return state.autumnLeafAmount;
  if (theme === "sakura") return state.sakuraPetalAmount;
  if (theme === "rain") return state.rainAmount;
  if (theme === "fireflies") return state.firefliesAmount;
  return state.christmasSnowAmount;
}

function themeSpeed(theme: BoardThemeId): number {
  if (theme === "autumn") return state.autumnLeafSpeed;
  if (theme === "sakura") return state.sakuraPetalSpeed;
  if (theme === "rain") return state.rainSpeed;
  if (theme === "fireflies") return state.firefliesSpeed;
  return state.christmasSnowSpeed;
}

function setThemeAmount(theme: BoardThemeId, v: number): void {
  if (theme === "autumn") state.autumnLeafAmount = v;
  else if (theme === "sakura") state.sakuraPetalAmount = v;
  else if (theme === "rain") state.rainAmount = v;
  else if (theme === "fireflies") state.firefliesAmount = v;
  else state.christmasSnowAmount = v;
}

function setThemeSpeed(theme: BoardThemeId, v: number): void {
  if (theme === "autumn") state.autumnLeafSpeed = v;
  else if (theme === "sakura") state.sakuraPetalSpeed = v;
  else if (theme === "rain") state.rainSpeed = v;
  else if (theme === "fireflies") state.firefliesSpeed = v;
  else state.christmasSnowSpeed = v;
}

function themeClearKey(theme: BoardThemeId): string {
  if (theme === "autumn") return "settings.autumnLeafClear";
  if (theme === "sakura") return "settings.sakuraPetalClear";
  if (theme === "rain") return "settings.rainClear";
  if (theme === "fireflies") return "settings.firefliesClear";
  return "settings.christmasSnowClear";
}

function syncBoardThemeUi(): void {
  const theme = currentBoardTheme();
  els.settingsBoardTheme.value = theme;
  els.settingsBoardThemeHint.setAttribute("data-i18n", boardThemeHintKey(theme));
  els.settingsBoardThemeHint.textContent = t(boardThemeHintKey(theme));

  const on = theme !== "off";
  els.settingsBoardThemeControls.hidden = !on;
  els.settingsBoardThemeControls.classList.toggle("is-open", on);

  els.settingsThemeAmount.value = String(Math.round(themeAmount(theme) * 100));
  els.settingsThemeSpeed.value = String(Math.round(themeSpeed(theme) * 100));

  const isChristmas = theme === "christmas";
  els.settingsSnowSmoothRow.hidden = !isChristmas;
  els.settingsSnowSmooth.checked = state.christmasSnowSmooth;

  const clearKey = themeClearKey(theme);
  els.btnClearTheme.setAttribute("data-i18n", clearKey);
  els.btnClearTheme.textContent = t(clearKey);
}

function applySnowOptionsToBoard(): void {
  board?.setChristmasSnowOptions({
    amount: state.christmasSnowAmount,
    speed: state.christmasSnowSpeed,
    smooth: state.christmasSnowSmooth,
  });
}

function applyAutumnOptionsToBoard(): void {
  board?.setAutumnLeafOptions({
    amount: state.autumnLeafAmount,
    speed: state.autumnLeafSpeed,
  });
}

function applySakuraOptionsToBoard(): void {
  board?.setSakuraPetalOptions({
    amount: state.sakuraPetalAmount,
    speed: state.sakuraPetalSpeed,
  });
}

function applyRainOptionsToBoard(): void {
  board?.setRainOptions({
    amount: state.rainAmount,
    speed: state.rainSpeed,
  });
}

function applyFirefliesOptionsToBoard(): void {
  board?.setFirefliesOptions({
    amount: state.firefliesAmount,
    speed: state.firefliesSpeed,
  });
}

async function applyBoardTheme(theme: BoardThemeId): Promise<void> {
  const prev = currentBoardTheme();
  if (prev === theme) {
    syncBoardThemeUi();
    return;
  }

  state.christmasTheme = theme === "christmas";
  state.autumnTheme = theme === "autumn";
  state.sakuraTheme = theme === "sakura";
  state.rainTheme = theme === "rain";
  state.firefliesTheme = theme === "fireflies";
  syncBoardThemeUi();

  board.setChristmasTheme(state.christmasTheme);
  board.setAutumnTheme(state.autumnTheme);
  board.setSakuraTheme(state.sakuraTheme);
  board.setRainTheme(state.rainTheme);
  board.setFirefliesTheme(state.firefliesTheme);
  if (state.christmasTheme) applySnowOptionsToBoard();
  if (state.autumnTheme) applyAutumnOptionsToBoard();
  if (state.sakuraTheme) applySakuraOptionsToBoard();
  if (state.rainTheme) applyRainOptionsToBoard();
  if (state.firefliesTheme) applyFirefliesOptionsToBoard();

  if (theme === "christmas") {
    await api.setChristmasTheme(true);
  } else if (theme === "autumn") {
    await api.setAutumnTheme(true);
  } else if (theme === "sakura") {
    await api.setSakuraTheme(true);
  } else if (theme === "rain") {
    await api.setRainTheme(true);
  } else if (theme === "fireflies") {
    await api.setFirefliesTheme(true);
  } else if (prev === "christmas") {
    await api.setChristmasTheme(false);
  } else if (prev === "autumn") {
    await api.setAutumnTheme(false);
  } else if (prev === "sakura") {
    await api.setSakuraTheme(false);
  } else if (prev === "rain") {
    await api.setRainTheme(false);
  } else if (prev === "fireflies") {
    await api.setFirefliesTheme(false);
  }

  const onKey =
    theme === "christmas"
      ? "settings.christmasThemeOn"
      : theme === "autumn"
        ? "settings.autumnThemeOn"
        : theme === "sakura"
          ? "settings.sakuraThemeOn"
          : theme === "rain"
            ? "settings.rainThemeOn"
            : theme === "fireflies"
              ? "settings.firefliesThemeOn"
              : "settings.boardThemeCleared";
  chat.addSystem(t(onKey));
}

els.settingsBoardTheme.onchange = () => {
  const raw = els.settingsBoardTheme.value;
  const theme: BoardThemeId =
    raw === "christmas" ||
    raw === "autumn" ||
    raw === "sakura" ||
    raw === "rain" ||
    raw === "fireflies"
      ? raw
      : "off";
  void applyBoardTheme(theme);
};

let themePatchTimer: number | undefined;
function queueActiveThemePatch(): void {
  const theme = currentBoardTheme();
  if (theme === "christmas") {
    applySnowOptionsToBoard();
    window.clearTimeout(themePatchTimer);
    themePatchTimer = window.setTimeout(() => {
      void api.setChristmasSnow({
        amount: state.christmasSnowAmount,
        speed: state.christmasSnowSpeed,
        smooth: state.christmasSnowSmooth,
      });
    }, 180);
  } else if (theme === "autumn") {
    applyAutumnOptionsToBoard();
    window.clearTimeout(themePatchTimer);
    themePatchTimer = window.setTimeout(() => {
      void api.setAutumnLeaves({
        amount: state.autumnLeafAmount,
        speed: state.autumnLeafSpeed,
      });
    }, 180);
  } else if (theme === "sakura") {
    applySakuraOptionsToBoard();
    window.clearTimeout(themePatchTimer);
    themePatchTimer = window.setTimeout(() => {
      void api.setSakuraPetals({
        amount: state.sakuraPetalAmount,
        speed: state.sakuraPetalSpeed,
      });
    }, 180);
  } else if (theme === "rain") {
    applyRainOptionsToBoard();
    window.clearTimeout(themePatchTimer);
    themePatchTimer = window.setTimeout(() => {
      void api.setRain({
        amount: state.rainAmount,
        speed: state.rainSpeed,
      });
    }, 180);
  } else if (theme === "fireflies") {
    applyFirefliesOptionsToBoard();
    window.clearTimeout(themePatchTimer);
    themePatchTimer = window.setTimeout(() => {
      void api.setFireflies({
        amount: state.firefliesAmount,
        speed: state.firefliesSpeed,
      });
    }, 180);
  }
}

els.settingsThemeAmount.oninput = () => {
  const theme = currentBoardTheme();
  const v = clampUnitUi(Number(els.settingsThemeAmount.value) / 100, themeAmount(theme));
  setThemeAmount(theme, v);
  queueActiveThemePatch();
};
els.settingsThemeSpeed.oninput = () => {
  const theme = currentBoardTheme();
  const v = clampUnitUi(Number(els.settingsThemeSpeed.value) / 100, themeSpeed(theme));
  setThemeSpeed(theme, v);
  queueActiveThemePatch();
};
els.settingsSnowSmooth.onchange = () => {
  state.christmasSnowSmooth = els.settingsSnowSmooth.checked;
  queueActiveThemePatch();
};
els.btnClearTheme.onclick = () => {
  const theme = currentBoardTheme();
  if (theme === "autumn") {
    board.clearAutumnLeaves();
    chat.addSystem(t("settings.autumnLeafCleared"));
  } else if (theme === "sakura") {
    board.clearSakuraPetals();
    chat.addSystem(t("settings.sakuraPetalCleared"));
  } else if (theme === "rain") {
    board.clearRain();
    chat.addSystem(t("settings.rainCleared"));
  } else if (theme === "fireflies") {
    board.clearFireflies();
    chat.addSystem(t("settings.firefliesCleared"));
  } else {
    board.clearChristmasSnow();
    chat.addSystem(t("settings.christmasSnowCleared"));
  }
};
els.btnCheckUpdate.onclick = () => {
  void checkSettingsUpdate();
};
els.btnGoUpdate.onclick = () => {
  const update = settingsUpdateUi.update;
  if (!update) return;
  showUpdateSplash(update);
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

function cancelQueuedPrompt(cardId: string, queueId: string): void {
  const q = promptQueues.get(cardId);
  if (!q) return;
  const idx = q.findIndex((item) => item.id === queueId);
  if (idx < 0) return;
  q.splice(idx, 1);
  promptChats.get(cardId)?.removeQueuedUser(queueId);
  if (!q.length) promptQueues.delete(cardId);
}

function enqueuePromptFromComposer(cardId: string): boolean {
  const pe = promptEls(cardId);
  if (!pe) return false;
  const { text: message, refs } = readComposerFrom(pe.input);
  const staged = [...getPromptAttachments(cardId)];
  if (!message && !refs.length && !staged.length) return false;
  hideMentionMenu();
  const withRefs = enrichPromptWithRefs(message, refs);
  const attachSuffix = buildAttachmentPromptSuffix(staged);
  const payload = [withRefs, attachSuffix].filter(Boolean).join("\n\n");
  const images = attachmentsToSdkImages(staged);
  const refsForBubble = refs.map((r) => ({
    name: r.name.replace(/\/$/, ""),
    kind: r.kind,
  }));
  const attsForBubble = staged.map((a) => ({
    name: a.name,
    kind: a.kind,
    previewUrl: a.previewUrl,
  }));
  const item: QueuedPrompt = {
    id: newQueueId(),
    message,
    payload,
    images: images.length ? images : undefined,
    refsForBubble,
    attsForBubble,
  };
  getPromptQueue(cardId).push(item);
  clearComposer(cardId, { guardIme: true });
  const runChat = promptChats.get(cardId) ?? noopChat;
  runChat.addUser(message, refsForBubble, attsForBubble, {
    queued: true,
    queueId: item.id,
    onCancelQueue: (qid) => cancelQueuedPrompt(cardId, qid),
  });
  return true;
}

async function dispatchPrompt(
  cardId: string,
  opts: {
    message: string;
    payload: string;
    images?: Array<{ data: string; mimeType: string }>;
    refsForBubble: QueuedPrompt["refsForBubble"];
    attsForBubble: QueuedPrompt["attsForBubble"];
    queueId?: string;
  }
): Promise<void> {
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
  const runChat = promptChats.get(cardId) ?? noopChat;
  if (opts.queueId) {
    runChat.promoteQueuedUser(opts.queueId, () => stopPromptAgent(cardId));
  } else {
    runChat.addUser(opts.message, opts.refsForBubble, opts.attsForBubble, {
      onStop: () => stopPromptAgent(cardId),
    });
  }
  scheduleBoardSave();
  setGenerating(true, cardId);
  board.setPromptRunStatus(cardId, "running");
  runChat.setThinking(true, t("thinking"));
  const session = promptAgentSessions.get(cardId);
  const res = await api.sendAgent({
    tabId,
    message: opts.payload,
    images: opts.images,
    agentId: session?.agentId,
    agentStoreCwd: session?.storeCwd,
  });
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
    void drainPromptQueue(cardId);
    return;
  }
  state.activeRunId = res.runId;
  bindRunToPrompt(res.runId, cardId);
  runTurns.set(res.runId, {
    startedAssistant: false,
    turnTokens: null,
    turnModel: state.modelId,
    turnCost: null,
  });
}

async function drainPromptQueue(cardId: string): Promise<void> {
  if (isCardGenerating(cardId)) return;
  const q = promptQueues.get(cardId);
  if (!q?.length) return;
  const next = q.shift()!;
  if (!q.length) promptQueues.delete(cardId);
  await dispatchPrompt(cardId, {
    message: next.message,
    payload: next.payload,
    images: next.images,
    refsForBubble: next.refsForBubble,
    attsForBubble: next.attsForBubble,
    queueId: next.id,
  });
}

async function sendPrompt(cardId: string): Promise<void> {
  if (isCardGenerating(cardId)) {
    enqueuePromptFromComposer(cardId);
    return;
  }
  const pe = promptEls(cardId);
  if (!pe) return;
  const { text: message, refs } = readComposerFrom(pe.input);
  const staged = [...getPromptAttachments(cardId)];
  if (!message && !refs.length && !staged.length) return;
  hideMentionMenu();
  const withRefs = enrichPromptWithRefs(message, refs);
  const attachSuffix = buildAttachmentPromptSuffix(staged);
  const payload = [withRefs, attachSuffix].filter(Boolean).join("\n\n");
  const images = attachmentsToSdkImages(staged);
  const refsForBubble = refs.map((r) => ({
    name: r.name.replace(/\/$/, ""),
    kind: r.kind,
  }));
  const attsForBubble = staged.map((a) => ({
    name: a.name,
    kind: a.kind,
    previewUrl: a.previewUrl,
  }));
  clearComposer(cardId, { guardIme: true });
  await dispatchPrompt(cardId, {
    message,
    payload,
    images: images.length ? images : undefined,
    refsForBubble,
    attsForBubble,
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
  if (event.type === "session") {
    const session = {
      agentId: event.agentId,
      storeCwd: event.storeCwd,
    };
    if (cardId) {
      promptAgentSessions.set(cardId, session);
      scheduleBoardSave();
    } else pendingRunSessions.set(runId, session);
  }
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
      if (cardId) {
        scheduleBoardSave();
        void drainPromptQueue(cardId);
      }
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
      if (cardId) {
        scheduleBoardSave();
        void drainPromptQueue(cardId);
      }
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
      if (cardId) {
        scheduleBoardSave();
        void drainPromptQueue(cardId);
      }
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
    state.christmasTheme = settings.christmasTheme === true;
    state.christmasSnowAmount = clampUnitUi(
      settings.christmasSnowAmount,
      0.55
    );
    state.christmasSnowSpeed = clampUnitUi(settings.christmasSnowSpeed, 0.5);
    state.christmasSnowSmooth = settings.christmasSnowSmooth === true;
    state.autumnTheme = settings.autumnTheme === true;
    state.autumnLeafAmount = clampUnitUi(settings.autumnLeafAmount, 0.55);
    state.autumnLeafSpeed = clampUnitUi(settings.autumnLeafSpeed, 0.5);
    state.sakuraTheme = settings.sakuraTheme === true;
    state.sakuraPetalAmount = clampUnitUi(settings.sakuraPetalAmount, 0.55);
    state.sakuraPetalSpeed = clampUnitUi(settings.sakuraPetalSpeed, 0.5);
    state.rainTheme = settings.rainTheme === true;
    state.rainAmount = clampUnitUi(settings.rainAmount, 0.55);
    state.rainSpeed = clampUnitUi(settings.rainSpeed, 0.5);
    state.firefliesTheme = settings.firefliesTheme === true;
    state.firefliesAmount = clampUnitUi(settings.firefliesAmount, 0.55);
    state.firefliesSpeed = clampUnitUi(settings.firefliesSpeed, 0.5);
    const flags = [
      "christmasTheme",
      "autumnTheme",
      "sakuraTheme",
      "rainTheme",
      "firefliesTheme",
    ] as const;
    const active = flags.filter((k) => state[k]);
    if (active.length > 1) {
      for (const k of flags) state[k] = k === active[0];
    }
    setLocale(state.locale);
    const status = await api.getApiKeyStatus();
    state.hasKey = status.hasKey;
    state.sessionUsage = await api.getSessionUsage();
    try {
      const ver = await api.getAppVersion();
      state.appVersion = ver.version;
      state.appPackaged = ver.packaged;
    } catch {
      /* ignore */
    }
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
    applySnowOptionsToBoard();
    applyAutumnOptionsToBoard();
    applySakuraOptionsToBoard();
    applyRainOptionsToBoard();
    applyFirefliesOptionsToBoard();
    board.setChristmasTheme(state.christmasTheme);
    board.setAutumnTheme(state.autumnTheme);
    board.setSakuraTheme(state.sakuraTheme);
    board.setRainTheme(state.rainTheme);
    board.setFirefliesTheme(state.firefliesTheme);
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
      settingsUpdateUi = {
        status: "available",
        latestVersion: updateCheck.update.version,
        error: "",
        update: updateCheck.update,
      };
      renderSettingsUpdateUi();
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
