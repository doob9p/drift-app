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
      <div class="strip-right">
        <button type="button" class="chrome-btn" id="btn-toggle-agent" data-i18n-title="chrome.toggleAgent" title="Toggle chat panel" aria-label="Toggle chat panel" aria-pressed="true">
          ${icons.panelRight(16)}
        </button>
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
          <div class="section-label"><span data-i18n="sidebar.ssh">SSH sessions</span></div>
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
          <div class="terminal-stage" id="terminal-stage">
            <div class="tabstrip">
              <div class="tabs" id="tabs"></div>
              <div class="tabs-empty" id="tabs-empty" data-i18n="tabs.empty"></div>
            </div>
            <div class="terminal-frame">
              <div class="terminal-host" id="terminal-host"></div>
            </div>
          </div>
          <div class="meeting-stage hidden" id="meeting-stage">
            <div class="meeting-stage-empty" id="meeting-stage-empty">
              <div class="meeting-stage-empty-ico">${icons.mic(28)}</div>
              <p data-i18n="meeting.stageEmpty">Start a meeting from the sidebar</p>
            </div>
            <div class="meeting-stage-host" id="meeting-stage-host"></div>
          </div>
        </div>
      </section>

      <div
        class="col-split"
        id="split-agent"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize agent panel"
      ></div>

      <aside class="agent" id="agent-panel">
        <div class="panel-head agent-top">
          <span class="usage-mini hidden" id="usage-mini"></span>
          <div class="agent-tools">
            <button type="button" class="agent-tool" id="btn-new-chat" data-i18n-title="chat.new" title="Reset chat" aria-label="Reset chat">${icons.restartChat(16)}</button>
          </div>
        </div>
        <div class="chat-thread" id="chat-thread"></div>
        <div class="agent-compose">
          <div class="composer" id="composer">
            <button type="button" class="composer-context is-empty" id="composer-context" title="">
              <span class="composer-context-ico" id="composer-context-ico" aria-hidden="true">${icons.terminal(12)}</span>
              <span class="composer-context-kind" id="composer-context-kind"></span>
              <span class="composer-context-sep hidden" id="composer-context-sep" aria-hidden="true">·</span>
              <span class="composer-context-path" id="composer-context-path"></span>
            </button>
            <div class="composer-input-wrap is-empty" id="composer-input-wrap">
              <div
                class="composer-placeholder"
                id="composer-placeholder"
                data-i18n="chat.placeholder"
                aria-hidden="true"
              >Plan, search, build anything…</div>
              <div
                id="agent-input"
                class="composer-editor"
                contenteditable="true"
                role="textbox"
                aria-multiline="true"
                aria-label="Plan, search, build anything…"
              ></div>
              <div class="mention-menu hidden" id="mention-menu" role="listbox"></div>
            </div>
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
  terminalStage: document.getElementById("terminal-stage")!,
  meetingStage: document.getElementById("meeting-stage")!,
  meetingStageHost: document.getElementById("meeting-stage-host")!,
  meetingStageEmpty: document.getElementById("meeting-stage-empty")!,
  meetingList: document.getElementById("meeting-list")!,
  meetingListEmpty: document.getElementById("meeting-list-empty")!,
  chatThread: document.getElementById("chat-thread")!,
  agentInput: document.getElementById("agent-input") as HTMLDivElement,
  composerInputWrap: document.getElementById("composer-input-wrap")!,
  composerPlaceholder: document.getElementById("composer-placeholder")!,
  composer: document.getElementById("composer")!,
  composerContext: document.getElementById("composer-context") as HTMLButtonElement,
  composerContextIco: document.getElementById("composer-context-ico")!,
  composerContextKind: document.getElementById("composer-context-kind")!,
  composerContextSep: document.getElementById("composer-context-sep")!,
  composerContextPath: document.getElementById("composer-context-path")!,
  mentionMenu: document.getElementById("mention-menu")!,
  btnSend: document.getElementById("btn-send") as HTMLButtonElement,
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
  apiKeyUnset: document.getElementById("api-key-unset")!,
  apiKeySet: document.getElementById("api-key-set")!,
  apiKeyHelp: document.getElementById("api-key-help")!,
  btnSaveKey: document.getElementById("btn-save-key") as HTMLButtonElement,
  btnClearKey: document.getElementById("btn-clear-key") as HTMLButtonElement,
  btnOpenApiKeys: document.getElementById(
    "btn-open-api-keys"
  ) as HTMLButtonElement,
  btnModel: document.getElementById("btn-model") as HTMLButtonElement,
  modelLabel: document.getElementById("model-label")!,
  modelPopover: document.getElementById("model-popover")!,
  modelSearch: document.getElementById("model-search") as HTMLInputElement,
  modelList: document.getElementById("model-list")!,
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
  if (state.generating) {
    els.btnSend.innerHTML = icons.stop(16);
    els.btnSend.title = t("strip.stop");
    els.btnSend.setAttribute("aria-label", t("strip.stop"));
  } else {
    els.btnSend.innerHTML = icons.send(16);
    els.btnSend.title = t("chat.send");
    els.btnSend.setAttribute("aria-label", t("chat.send"));
  }
  els.settingsLocale.value = state.locale;
  els.composerPlaceholder.textContent = t("chat.placeholder");
  els.agentInput.setAttribute("aria-label", t("chat.placeholder"));
  hideMentionMenu();
  refreshChatEmptyIfNeeded();
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
  syncMainStageLayout();
}

const chat = createChatController(els.chatThread);
chat.showEmpty();

function setGenerating(on: boolean): void {
  state.generating = on;
  els.composer.classList.toggle("generating", on);
  els.btnSend.innerHTML = on ? icons.stop(16) : icons.send(16);
  els.btnSend.classList.toggle("busy", on);
  els.btnSend.classList.toggle("is-stop", on);
  els.btnSend.disabled = false;
  els.btnSend.title = on ? t("strip.stop") : t("chat.send");
  els.btnSend.setAttribute("aria-label", on ? t("strip.stop") : t("chat.send"));
  els.btnSend.dataset.i18nTitle = on ? "strip.stop" : "chat.send";
  els.agentInput.contentEditable = on ? "false" : "true";
  els.agentInput.classList.toggle("is-disabled", on);
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
    updateComposerContext();
    return;
  }
  const active = state.activeTabId
    ? state.tabs.get(state.activeTabId)
    : undefined;
  const cwd = active ? tabCwds.get(active.id) : undefined;
  const label = cwd ? formatStripPath(cwd) : active ? active.title : "—";
  els.stripPathText.textContent = label;
  els.stripPath.title = cwd || active?.title || "";
  updateComposerContext();
}

function updateComposerContext(): void {
  if (activeNav === "meetings") {
    const title =
      meetingState.pane?.title ||
      meetingState.list.find((m) => m.id === meetingState.activeId)?.title ||
      "";
    const sessionLabel = t("chat.context.meeting");
    els.composerContext.classList.toggle("is-empty", !title);
    els.composerContext.classList.remove("is-ssh");
    els.composerContextIco.innerHTML = icons.mic(12);
    els.composerContextKind.textContent = title
      ? sessionLabel
      : t("chat.context.none");
    if (title) {
      els.composerContextPath.textContent = title;
      els.composerContextSep.classList.remove("hidden");
      els.composerContext.title = `${sessionLabel} · ${title}`;
    } else {
      els.composerContextPath.textContent = "";
      els.composerContextSep.classList.add("hidden");
      els.composerContext.title = t("chat.context.none");
    }
    refreshChatEmptyIfNeeded();
    return;
  }
  const active = state.activeTabId
    ? state.tabs.get(state.activeTabId)
    : undefined;
  if (!active) {
    els.composerContext.classList.add("is-empty");
    els.composerContext.classList.remove("is-ssh");
    els.composerContextIco.innerHTML = icons.terminal(12);
    els.composerContextKind.textContent = t("chat.context.none");
    els.composerContextPath.textContent = "";
    els.composerContextSep.classList.add("hidden");
    els.composerContext.title = t("chat.context.none");
    refreshChatEmptyIfNeeded();
    return;
  }
  const cwd = tabCwds.get(active.id);
  const pathLabel = cwd ? formatStripPath(cwd) : "";
  const sessionLabel =
    active.kind === "ssh"
      ? t("chat.context.sshSession", { name: active.title })
      : t("chat.context.localSession");
  els.composerContext.classList.remove("is-empty");
  els.composerContext.classList.toggle("is-ssh", active.kind === "ssh");
  els.composerContextIco.innerHTML =
    active.kind === "ssh" ? icons.server(12) : icons.monitor(12);
  els.composerContextKind.textContent = sessionLabel;
  if (pathLabel) {
    els.composerContextPath.textContent = pathLabel;
    els.composerContextSep.classList.remove("hidden");
  } else {
    els.composerContextPath.textContent = "";
    els.composerContextSep.classList.add("hidden");
  }
  els.composerContext.title = cwd
    ? `${sessionLabel} · ${cwd}`
    : sessionLabel;
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

function getAtMention(): AtMentionState | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!els.agentInput.contains(range.startContainer)) return null;
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

async function loadCwdMentions(): Promise<MentionItem[]> {
  const active = state.activeTabId
    ? state.tabs.get(state.activeTabId)
    : undefined;
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

async function refreshMentionMenu(): Promise<void> {
  const at = getAtMention();
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
  const items = await loadCwdMentions();
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

function normalizeEmptyComposer(): boolean {
  // Browsers often insert <br> / ZWSP into an empty contenteditable.
  if (els.agentInput.querySelector(".composer-inline-chip")) return false;
  const text = (els.agentInput.textContent || "")
    .replace(/\u200b/g, "")
    .replace(/\u00a0/g, " ")
    .trim();
  if (text) return false;
  if (els.agentInput.innerHTML !== "") {
    els.agentInput.innerHTML = "";
  }
  return true;
}

function syncComposerEmpty(): void {
  const empty = normalizeEmptyComposer();
  els.composerInputWrap.classList.toggle("is-empty", empty);
}

function clearComposer(): void {
  els.agentInput.innerHTML = "";
  syncComposerEmpty();
  autoGrowInput();
}

function readComposerChips(): AttachedRef[] {
  return [...els.agentInput.querySelectorAll(".composer-inline-chip")].map(
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

function readComposer(): { text: string; refs: AttachedRef[] } {
  const refs = readComposerChips();
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
  for (const child of els.agentInput.childNodes) walk(child);
  return { text: text.replace(/\n{3,}/g, "\n\n").trim(), refs };
}

function enrichPromptWithRefs(message: string, refs: AttachedRef[]): string {
  if (!refs.length) return message;
  const lines = refs.map((r) => `- ${r.kind}: ${r.path}`);
  const block = `[Attached]\n${lines.join("\n")}`;
  return message.trim() ? `${message}\n\n${block}` : block;
}

function createInlineChip(item: MentionItem): HTMLSpanElement {
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
    els.agentInput.focus();
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
      placeCaretAtEnd(els.agentInput);
    }
    syncComposerEmpty();
    autoGrowInput();
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
  const at = activeAtMention || getAtMention();
  if (!at) return;
  const { textNode, atOffset, caretOffset } = at;
  const before = textNode.data.slice(0, atOffset);
  const after = textNode.data.slice(caretOffset);
  const parent = textNode.parentNode;
  if (!parent) return;

  const beforeNode = document.createTextNode(before || "\u200b");
  const afterNode = document.createTextNode(after || "\u200b");
  const chip = createInlineChip(item);
  parent.insertBefore(beforeNode, textNode);
  parent.insertBefore(chip, textNode);
  parent.insertBefore(afterNode, textNode);
  parent.removeChild(textNode);

  hideMentionMenu();
  els.agentInput.focus();
  const sel = window.getSelection();
  if (sel) {
    const range = document.createRange();
    range.setStart(afterNode, after ? 0 : afterNode.data.length);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  syncComposerEmpty();
  autoGrowInput();
}

function buildChatSuggestions(): { label: string; prompt: string }[] {
  const active = state.activeTabId
    ? state.tabs.get(state.activeTabId)
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
  if (!els.chatThread.querySelector(".chat-empty")) return;
  chat.showEmpty(buildChatSuggestions());
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

const modelPopoverHome = els.modelPopover.parentElement;

function positionModelPopover(): void {
  if (els.modelPopover.classList.contains("hidden")) return;
  const gap = 8;
  const margin = 8;
  const chip = els.btnModel.getBoundingClientRect();
  const agent = document.getElementById("agent-panel");
  const agentRect = agent?.getBoundingClientRect();
  const width = Math.min(320, window.innerWidth - margin * 2);
  const maxHeight = Math.min(420, window.innerHeight * 0.6);

  // Cursor-style: sit above the chip, prefer spilling left over the main pane.
  let left = chip.right - width;
  if (agentRect) {
    left = Math.min(left, agentRect.right - width - 10);
  }
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));

  const bottom = Math.max(margin, window.innerHeight - chip.top + gap);
  const availableUp = window.innerHeight - bottom - margin;

  els.modelPopover.style.left = `${Math.round(left)}px`;
  els.modelPopover.style.right = "auto";
  els.modelPopover.style.bottom = `${Math.round(bottom)}px`;
  els.modelPopover.style.top = "auto";
  els.modelPopover.style.width = `${Math.round(width)}px`;
  els.modelPopover.style.maxHeight = `${Math.round(Math.min(maxHeight, availableUp))}px`;
}

function closeModelPopover(): void {
  els.modelPopover.classList.add("hidden");
  els.btnModel.setAttribute("aria-expanded", "false");
  els.modelSearch.value = "";
  els.modelPopover.style.left = "";
  els.modelPopover.style.bottom = "";
  els.modelPopover.style.width = "";
  els.modelPopover.style.maxHeight = "";
  if (modelPopoverHome && els.modelPopover.parentElement !== modelPopoverHome) {
    modelPopoverHome.appendChild(els.modelPopover);
  }
}

function openModelPopover(): void {
  els.modePopover.classList.add("hidden");
  els.btnMode.setAttribute("aria-expanded", "false");
  renderModelPicker();
  if (els.modelPopover.parentElement !== document.body) {
    document.body.appendChild(els.modelPopover);
  }
  els.modelPopover.classList.remove("hidden");
  els.btnModel.setAttribute("aria-expanded", "true");
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
  invalidateMentionCache();
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
  const meetings = id === "meetings";
  els.terminalStage.classList.toggle("hidden", meetings);
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
  // Always plain text (never innerHTML) — release notes may still contain markup.
  const notes = (payload.releaseNotes ?? "")
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
          error: "message" in result && result.message ? result.message : result.reason,
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
  await api.closeTab(tabId);
  const next = state.tabs.keys().next().value as string | undefined;
  state.activeTabId = next ?? null;
  if (next) activateTab(next);
  else {
    renderTabs();
    refreshStatusStrip();
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
  const splitAgent = document.getElementById("split-agent");
  const SIDEBAR_KEY = "drift.sidebarWidth";
  const AGENT_KEY = "drift.agentWidth";
  const SIDEBAR_MIN = 200;
  const SIDEBAR_MAX = 480;
  const AGENT_MIN = 280;
  const AGENT_MAX = 560;

  function clamp(n: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, n));
  }

  function applyStoredWidths(): void {
    if (!layoutEl) return;
    const side = Number(localStorage.getItem(SIDEBAR_KEY));
    const agent = Number(localStorage.getItem(AGENT_KEY));
    if (Number.isFinite(side) && side > 0) {
      layoutEl.style.setProperty(
        "--sidebar",
        `${clamp(side, SIDEBAR_MIN, SIDEBAR_MAX)}px`
      );
    }
    if (Number.isFinite(agent) && agent > 0) {
      layoutEl.style.setProperty(
        "--agent",
        `${clamp(agent, AGENT_MIN, AGENT_MAX)}px`
      );
    }
  }

  applyStoredWidths();

  type ColDrag = {
    kind: "sidebar" | "agent";
    startX: number;
    startWidth: number;
  } | null;
  let colDrag: ColDrag = null;

  function currentVarPx(name: "--sidebar" | "--agent", fallback: number): number {
    if (!layoutEl) return fallback;
    const raw = getComputedStyle(layoutEl).getPropertyValue(name).trim();
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  function beginColDrag(
    kind: "sidebar" | "agent",
    handle: HTMLElement,
    e: MouseEvent
  ): void {
    e.preventDefault();
    const startWidth =
      kind === "sidebar"
        ? currentVarPx("--sidebar", 288)
        : currentVarPx("--agent", 380);
    colDrag = { kind, startX: e.clientX, startWidth };
    handle.classList.add("is-active");
    document.body.classList.add("is-resizing-col");
  }

  splitSidebar?.addEventListener("mousedown", (e) => {
    if (layoutEl?.classList.contains("nav-collapsed")) return;
    beginColDrag("sidebar", splitSidebar, e);
  });
  splitAgent?.addEventListener("mousedown", (e) => {
    if (layoutEl?.classList.contains("agent-collapsed")) return;
    beginColDrag("agent", splitAgent, e);
  });

  window.addEventListener("mousemove", (e) => {
    if (!colDrag || !layoutEl) return;
    if (colDrag.kind === "sidebar") {
      const next = clamp(
        colDrag.startWidth + (e.clientX - colDrag.startX),
        SIDEBAR_MIN,
        SIDEBAR_MAX
      );
      layoutEl.style.setProperty("--sidebar", `${next}px`);
    } else {
      const next = clamp(
        colDrag.startWidth - (e.clientX - colDrag.startX),
        AGENT_MIN,
        AGENT_MAX
      );
      layoutEl.style.setProperty("--agent", `${next}px`);
    }
    refitTerminals();
  });

  window.addEventListener("mouseup", () => {
    if (!colDrag || !layoutEl) return;
    const kind = colDrag.kind;
    colDrag = null;
    splitSidebar?.classList.remove("is-active");
    splitAgent?.classList.remove("is-active");
    document.body.classList.remove("is-resizing-col");
    if (kind === "sidebar") {
      localStorage.setItem(
        SIDEBAR_KEY,
        String(currentVarPx("--sidebar", 288))
      );
    } else {
      localStorage.setItem(AGENT_KEY, String(currentVarPx("--agent", 380)));
    }
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
  invalidateMentionCache();
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
els.composerContext.onclick = () => {
  if (els.composerContext.classList.contains("is-empty")) return;
  setNav("files");
};
api.onShortcut((payload) => handleShortcut(payload));

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && closeTopModal()) {
    e.preventDefault();
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
  clearComposer();
  hideMentionMenu();
  chat.clear();
  state.startedAssistant = false;
  chat.showEmpty(buildChatSuggestions());
};

els.chatThread.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest(
    "[data-suggest]"
  ) as HTMLElement | null;
  if (!btn?.dataset.suggest) return;
  clearComposer();
  els.agentInput.textContent = btn.dataset.suggest;
  syncComposerEmpty();
  autoGrowInput();
  els.agentInput.focus();
  placeCaretAtEnd(els.agentInput);
});

async function sendCurrentPrompt(): Promise<void> {
  if (state.generating) return;
  let tabId = state.activeTabId;
  if (!tabId || activeNav === "meetings") {
    try {
      const local = await ensureActiveLocalTab();
      tabId = local.id;
      if (activeNav === "meetings") setNav("sessions");
    } catch {
      chat.addError(t("error.openTab"));
      return;
    }
  }
  if (!tabId) {
    chat.addError(t("error.openTab"));
    return;
  }
  const { text: message, refs } = readComposer();
  if (!message && !refs.length) return;
  hideMentionMenu();
  const payload = enrichPromptWithRefs(message, refs);
  const refsForBubble = refs.map((r) => ({
    name: r.name.replace(/\/$/, ""),
    kind: r.kind,
  }));
  clearComposer();
  chat.addUser(message, refsForBubble);
  state.startedAssistant = false;
  state.turnTokens = null;
  state.turnModel = state.modelId;
  state.turnCost = null;
  setGenerating(true);
  chat.setThinking(true, t("thinking"));
  const res = await api.sendAgent({ tabId, message: payload });
  if ("error" in res) {
    state.activeRunId = null;
    chat.setThinking(false);
    if (isApiKeyError(res.error)) {
      openSettings();
      chat.addError(t("settings.needKeyToast"), {
        action: {
          label: t("settings.openKeyPage"),
          onClick: () => openCursorApiKeysPage(api),
        },
      });
    } else {
      chat.addError(res.error);
    }
    setGenerating(false);
    return;
  }
  state.activeRunId = res.runId;
}

function autoGrowInput(): void {
  const el = els.agentInput;
  el.style.height = "auto";
  el.style.height = `${Math.min(180, Math.max(64, el.scrollHeight))}px`;
}

function deleteChipBeforeCaret(): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType === Node.TEXT_NODE && range.startOffset === 0) {
    const prev = node.previousSibling as HTMLElement | null;
    if (prev?.classList?.contains("composer-inline-chip")) {
      prev.remove();
      syncComposerEmpty();
      autoGrowInput();
      return true;
    }
  }
  if (node === els.agentInput && range.startOffset > 0) {
    const prev = els.agentInput.childNodes[range.startOffset - 1] as
      | HTMLElement
      | undefined;
    if (prev?.classList?.contains("composer-inline-chip")) {
      prev.remove();
      syncComposerEmpty();
      autoGrowInput();
      return true;
    }
  }
  return false;
}

function stopCurrentAgent(): void {
  void api.stopAgent({
    runId: state.activeRunId ?? undefined,
    tabId: state.activeTabId ?? undefined,
  });
}

els.btnSend.onclick = () => {
  if (state.generating) {
    stopCurrentAgent();
    return;
  }
  void sendCurrentPrompt();
};
els.agentInput.addEventListener("keydown", (e) => {
  if (state.generating) {
    e.preventDefault();
    return;
  }
  const mentionOpen = !els.mentionMenu.classList.contains("hidden");
  if (mentionOpen) {
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
  if (e.key === "Backspace" && deleteChipBeforeCaret()) {
    e.preventDefault();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (state.generating) {
      stopCurrentAgent();
      return;
    }
    void sendCurrentPrompt();
  }
});
els.agentInput.addEventListener("focus", () => {
  if (normalizeEmptyComposer()) {
    els.composerInputWrap.classList.add("is-empty");
    placeCaretAtEnd(els.agentInput);
  }
});
els.agentInput.addEventListener("input", () => {
  syncComposerEmpty();
  autoGrowInput();
  void refreshMentionMenu();
});
els.agentInput.addEventListener("keyup", () => {
  void refreshMentionMenu();
});
els.agentInput.addEventListener("click", () => {
  void refreshMentionMenu();
});
els.agentInput.addEventListener("blur", () => {
  syncComposerEmpty();
  window.setTimeout(() => hideMentionMenu(), 120);
});

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

api.onAgentEvent(({ event }) => {
  if (event.type === "progress") {
    chat.setActivity({
      title: localizeProgressTitle(event.title),
      detail: event.detail,
      summary: event.summary,
      done: event.done,
    });
  }
  if (event.type === "text") {
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
      const detail = event.detail || "unknown error";
      const missingKey = isApiKeyError(detail);
      state.activeRunId = null;
      state.pendingApproval = null;
      chat.setThinking(false);
      if (state.startedAssistant) {
        chat.finishAssistant();
        state.startedAssistant = false;
      }
      if (missingKey) {
        openSettings();
        chat.addError(t("settings.needKeyToast"), {
          action: {
            label: t("settings.openKeyPage"),
            onClick: () => openCursorApiKeysPage(api),
          },
        });
      } else {
        chat.addError(detail);
      }
      setGenerating(false);
    }
    if (event.status === "cancelled") {
      state.activeRunId = null;
      if (state.pendingApproval) {
        state.pendingApproval = null;
        chat.resolveApprovalCard("deny");
      }
      chat.setThinking(false);
      if (state.startedAssistant) {
        chat.finishAssistant();
        state.startedAssistant = false;
      }
      chat.addSystem(event.detail || t("chat.stopped"));
      setGenerating(false);
    }
    if (event.status === "done") {
      state.activeRunId = null;
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
      void refreshAccountUsage();
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
  void refreshAccountUsage();
  window.setInterval(() => void refreshStripMetrics(), 2500);
  window.setInterval(() => void refreshAccountUsage(), 5 * 60_000);
})();
