import { icons } from "./icons.js";
import { t } from "./i18n.js";
import {
  createBoardSnow,
  type BoardSnow,
  type BoardSnowOptions,
} from "./board-snow.js";
import {
  createBoardLeaves,
  type BoardLeaves,
  type BoardLeavesOptions,
} from "./board-leaves.js";
import {
  createBoardSakura,
  type BoardSakura,
  type BoardSakuraOptions,
} from "./board-sakura.js";
import {
  createBoardRain,
  type BoardRain,
  type BoardRainOptions,
} from "./board-rain.js";
import {
  createBoardFireflies,
  type BoardFireflies,
  type BoardFirefliesOptions,
} from "./board-fireflies.js";
import type {
  BoardCamera,
  BoardCard,
  BoardFocus,
  BoardPersistedState,
  PromptCard,
  PromptRunStatus,
  TerminalCard,
} from "./board-types.js";

export type BoardPaneHandlers = {
  onFocus: (focus: BoardFocus) => void;
  onLayoutChange: () => void;
  onCloseTerminal: (tabId: string) => void;
  onClosePrompt: (cardId: string) => void;
  onToggleMinimize: (cardId: string) => void;
  onPromptSend: (cardId: string) => void;
  onPromptInputKeydown: (cardId: string, e: KeyboardEvent) => void;
  onAddSub: (parentCardId: string) => void;
  onToggleBroadcast: () => void;
  onToggleBroadcastMember: (tabId: string) => void;
};

export type BoardPane = {
  root: HTMLElement;
  surface: HTMLElement;
  getCards: () => BoardCard[];
  getFocus: () => BoardFocus;
  setFocus: (focus: BoardFocus) => void;
  upsertTerminal: (input: {
    tabId: string;
    title: string;
    activate?: boolean;
  }) => TerminalCard;
  getTerminalHost: (tabId: string) => HTMLElement | null;
  minimizeOtherTerminals: (exceptTabId: string) => void;
  expandTerminal: (tabId: string) => void;
  removeTab: (tabId: string) => void;
  addPrompt: (
    tabId: string,
    title?: string,
    opts?: { parentId?: string }
  ) => PromptCard;
  getPromptEls: (cardId: string) => {
    thread: HTMLElement;
    input: HTMLDivElement;
    send: HTMLButtonElement;
    context: HTMLElement;
    composer: HTMLElement;
    attachments: HTMLElement;
    attachBtn: HTMLButtonElement;
    fileInput: HTMLInputElement;
  } | null;
  updatePromptContext: (
    cardId: string,
    info: { kind: string; path: string; title: string }
  ) => void;
  setPromptSendBusy: (cardId: string, busy: boolean) => void;
  setPromptRunStatus: (cardId: string, status: PromptRunStatus) => void;
  countPromptChildren: (parentId: string) => number;
  applyPersisted: (state: BoardPersistedState, liveTabIds: Set<string>) => void;
  toPersisted: () => BoardPersistedState;
  refreshTitles: (tabId: string, title: string) => void;
  syncEmpty: () => void;
  bringToFront: (cardId: string) => void;
  setMinimized: (cardId: string, minimized: boolean) => void;
  findCard: (cardId: string) => BoardCard | undefined;
  removeCard: (cardId: string) => void;
  setChristmasTheme: (enabled: boolean) => void;
  setChristmasSnowOptions: (opts: Partial<BoardSnowOptions>) => void;
  clearChristmasSnow: () => void;
  setAutumnTheme: (enabled: boolean) => void;
  setAutumnLeafOptions: (opts: Partial<BoardLeavesOptions>) => void;
  clearAutumnLeaves: () => void;
  setSakuraTheme: (enabled: boolean) => void;
  setSakuraPetalOptions: (opts: Partial<BoardSakuraOptions>) => void;
  clearSakuraPetals: () => void;
  setRainTheme: (enabled: boolean) => void;
  setRainOptions: (opts: Partial<BoardRainOptions>) => void;
  clearRain: () => void;
  setFirefliesTheme: (enabled: boolean) => void;
  setFirefliesOptions: (opts: Partial<BoardFirefliesOptions>) => void;
  clearFireflies: () => void;
  arrangeCards: () => void;
  tileOpenTerminals: () => void;
  fitOpenTerminals: () => void;
  /** Sync broadcast mode + member tab ids onto card chrome. */
  syncBroadcastUi: (active: boolean, memberTabIds: Iterable<string>) => void;
};

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

const TERM_W = 720;
const TERM_H = 420;
const PROMPT_W = 380;
const PROMPT_H = 520;
const SUB_PROMPT_W = 320;
const SUB_PROMPT_H = 420;
const CHIP_W = 200;
const CHIP_H = 36;
export const MAX_PROMPT_SUBS = 4;
const ZOOM_ABS_MIN = 0.15;
const ZOOM_MAX = 4;
const ZOOM_BTN_STEP = 1.25;
const GRID_BASE = 24;
/**
 * Fixed canvas bounds (Figma-style hard edge).
 * Keep modest: a huge painted DOM layer trips Chromium tile memory limits
 * ("tile memory limits exceeded") when zooming with terminal canvases.
 */
const WORLD = { x: 0, y: 0, w: 2400, h: 1600 };

function wheelDeltaY(e: WheelEvent): number {
  let dy = e.deltaY;
  if (e.deltaMode === 1) dy *= 16;
  else if (e.deltaMode === 2) dy *= 800;
  return dy;
}

function cardScrollSurface(target: Element): HTMLElement | null {
  const thread = target.closest(".board-prompt-thread");
  if (thread instanceof HTMLElement) return thread;
  const term =
    target.closest(".xterm-viewport") ??
    target.closest(".xterm")?.querySelector(".xterm-viewport");
  return term instanceof HTMLElement ? term : null;
}

/** True when `el` can still move in the wheel's vertical direction. */
function canScrollVertically(el: HTMLElement, dy: number): boolean {
  const max = el.scrollHeight - el.clientHeight;
  if (max <= 1) return false;
  if (dy < 0) return el.scrollTop > 0;
  if (dy > 0) return el.scrollTop < max - 1;
  return false;
}

type MapFrame = {
  worldX: number;
  worldY: number;
  scale: number;
  ox: number;
  oy: number;
};

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable
  );
}

function cardTitle(card: BoardCard): string {
  if (card.kind === "terminal") return card.title;
  return card.title || "Prompt";
}

function cardSize(card: BoardCard): { w: number; h: number } {
  if (card.kind === "terminal" && card.minimized) {
    return { w: CHIP_W, h: CHIP_H };
  }
  return { w: card.w, h: card.h };
}

export function createBoardPane(
  root: HTMLElement,
  handlers: BoardPaneHandlers
): BoardPane {
  let cards: BoardCard[] = [];
  let focus: BoardFocus = null;
  let zCounter = 1;
  const cardEls = new Map<string, HTMLElement>();
  let camera: BoardCamera = { x: 0, y: 0, zoom: 1 };
  let spaceHeld = false;
  let panning = false;
  /** When true, pan/zoom (trackpad, Space-drag, minimap, shortcuts) are frozen. */
  let viewLocked = false;
  let mapFrame: MapFrame = { worldX: 0, worldY: 0, scale: 1, ox: 0, oy: 0 };
  let mapCollapsed = false;
  let minimapDirty = true;
  let persistTimer: number | null = null;

  root.innerHTML = `
    <div class="board-viewport" id="board-viewport" tabindex="-1">
      <div class="board-grid" id="board-grid" aria-hidden="true"></div>
      <div class="board-surface" id="board-surface">
        <svg class="board-links" id="board-links" aria-hidden="true"></svg>
      </div>
      <div class="board-chrome" id="board-chrome">
        <div class="board-tools-hud" id="board-tools-hud" role="group" aria-label="Board tools">
          <button type="button" class="icon ghost" id="btn-board-arrange" data-i18n-title="board.arrange" title="${t("board.arrange")}" aria-label="${t("board.arrange")}">${icons.arrange(14)}</button>
          <button type="button" class="icon ghost" id="btn-board-tile-fill" data-i18n-title="board.tileFill" title="${t("board.tileFill")}" aria-label="${t("board.tileFill")}">${icons.tileFill(14)}</button>
          <button type="button" class="icon ghost" id="btn-board-tile-fit" data-i18n-title="board.tileFit" title="${t("board.tileFit")}" aria-label="${t("board.tileFit")}">${icons.tileFit(14)}</button>
          <button type="button" class="icon ghost" id="btn-board-lock" data-i18n-title="board.lockView" title="${t("board.lockView")}" aria-label="${t("board.lockView")}" aria-pressed="false">${icons.lockView(14)}</button>
          <button type="button" class="icon ghost" id="btn-board-broadcast" data-i18n-title="board.broadcast" title="${t("board.broadcast")}" aria-label="${t("board.broadcast")}" aria-pressed="false">${icons.broadcast(14)}</button>
        </div>
        <aside class="board-minimap" id="board-minimap" aria-label="${t("board.minimap")}">
          <header class="board-minimap-head">
            <span class="board-minimap-title" data-i18n="board.minimap">Map</span>
            <div class="board-minimap-actions">
              <button type="button" class="icon ghost" id="btn-board-map-toggle" data-i18n-title="board.minimapToggle" title="Toggle map">${icons.chevronDown(12)}</button>
            </div>
          </header>
          <div class="board-minimap-body" id="board-minimap-body">
            <div class="board-minimap-world" id="board-minimap-world"></div>
            <div class="board-minimap-view" id="board-minimap-view"></div>
          </div>
          <div class="board-minimap-zoom" role="group" aria-label="Zoom">
            <button type="button" class="icon ghost" id="btn-board-zoom-out" data-i18n-title="board.zoomOut" title="Zoom out">${icons.zoomOut(14)}</button>
            <button type="button" class="board-zoom-label" id="btn-board-zoom-reset" data-i18n-title="board.zoomReset" title="Reset zoom">100%</button>
            <button type="button" class="icon ghost" id="btn-board-zoom-in" data-i18n-title="board.zoomIn" title="Zoom in">${icons.zoomIn(14)}</button>
          </div>
        </aside>
      </div>
    </div>
  `;

  const viewport = root.querySelector("#board-viewport") as HTMLElement;
  const grid = root.querySelector("#board-grid") as HTMLElement;
  const surface = root.querySelector("#board-surface") as HTMLElement;
  const linksSvg = root.querySelector("#board-links") as SVGSVGElement;
  const zoomLabel = root.querySelector(
    "#btn-board-zoom-reset"
  ) as HTMLButtonElement;
  const lockBtn = root.querySelector("#btn-board-lock") as HTMLButtonElement;
  const broadcastBtn = root.querySelector(
    "#btn-board-broadcast"
  ) as HTMLButtonElement;
  let broadcastActive = false;
  const broadcastMembers = new Set<string>();
  const zoomInBtn = root.querySelector(
    "#btn-board-zoom-in"
  ) as HTMLButtonElement;
  const zoomOutBtn = root.querySelector(
    "#btn-board-zoom-out"
  ) as HTMLButtonElement;
  const minimap = root.querySelector("#board-minimap") as HTMLElement;
  const minimapBody = root.querySelector("#board-minimap-body") as HTMLElement;
  const minimapWorld = root.querySelector(
    "#board-minimap-world"
  ) as HTMLElement;
  const minimapView = root.querySelector("#board-minimap-view") as HTMLElement;
  const mapToggleBtn = root.querySelector(
    "#btn-board-map-toggle"
  ) as HTMLButtonElement;

  function syncViewLockUi(): void {
    viewport.classList.toggle("is-view-locked", viewLocked);
    lockBtn.classList.toggle("is-active", viewLocked);
    lockBtn.setAttribute("aria-pressed", viewLocked ? "true" : "false");
    const label = viewLocked ? t("board.unlockView") : t("board.lockView");
    lockBtn.title = label;
    lockBtn.setAttribute("aria-label", label);
    lockBtn.setAttribute("data-i18n-title", viewLocked ? "board.unlockView" : "board.lockView");
    lockBtn.innerHTML = viewLocked ? icons.unlockView(14) : icons.lockView(14);
    for (const btn of [zoomInBtn, zoomOutBtn, zoomLabel]) {
      btn.disabled = viewLocked;
      btn.toggleAttribute("aria-disabled", viewLocked);
    }
  }

  function setViewLocked(locked: boolean): void {
    if (viewLocked === locked) {
      syncViewLockUi();
      return;
    }
    viewLocked = locked;
    if (locked) {
      panning = false;
      spaceHeld = false;
      viewport.classList.remove("is-panning", "is-space");
    }
    syncViewLockUi();
  }

  const roofProvider = () =>
    cards
      .filter(
        (c): c is TerminalCard => c.kind === "terminal" && !c.minimized
      )
      .map((c) => {
        const { w, h } = cardSize(c);
        return { id: c.id, x: c.x, y: c.y, w, h, z: c.z };
      });

  const snow: BoardSnow = createBoardSnow({
    viewport,
    world: WORLD,
    getCamera: () => camera,
    getRoofs: roofProvider,
  });

  const leaves: BoardLeaves = createBoardLeaves({
    viewport,
    world: WORLD,
    getCamera: () => camera,
    getRoofs: roofProvider,
  });

  const sakura: BoardSakura = createBoardSakura({
    viewport,
    world: WORLD,
    getCamera: () => camera,
    getRoofs: roofProvider,
  });

  const rain: BoardRain = createBoardRain({
    viewport,
    world: WORLD,
    getCamera: () => camera,
    getRoofs: roofProvider,
  });

  const fireflies: BoardFireflies = createBoardFireflies({
    viewport,
    world: WORLD,
    getCamera: () => camera,
    getRoofs: roofProvider,
  });

  function disableSeasonalExcept(
    keep: "snow" | "leaves" | "sakura" | "rain" | "fireflies" | null
  ): void {
    if (keep !== "snow") snow.setEnabled(false);
    if (keep !== "leaves") leaves.setEnabled(false);
    if (keep !== "sakura") sakura.setEnabled(false);
    if (keep !== "rain") rain.setEnabled(false);
    if (keep !== "fireflies") fireflies.setEnabled(false);
  }

  function nextZ(): number {
    zCounter += 1;
    return zCounter;
  }

  function syncEmpty(): void {}

  function cardRect(card: BoardCard): {
    x: number;
    y: number;
    w: number;
    h: number;
  } {
    const { w, h } = cardSize(card);
    return { x: card.x, y: card.y, w, h };
  }

  function linkAnchors(
    fromCard: BoardCard,
    toCard: BoardCard
  ): {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  } {
    const a = cardRect(fromCard);
    const b = cardRect(toCard);
    const acx = a.x + a.w / 2;
    const acy = a.y + a.h / 2;
    const bcx = b.x + b.w / 2;
    const bcy = b.y + b.h / 2;
    if (Math.abs(bcx - acx) >= Math.abs(bcy - acy)) {
      if (bcx >= acx) {
        return { x1: a.x + a.w, y1: acy, x2: b.x, y2: bcy };
      }
      return { x1: a.x, y1: acy, x2: b.x + b.w, y2: bcy };
    }
    if (bcy >= acy) {
      return { x1: acx, y1: a.y + a.h, x2: bcx, y2: b.y };
    }
    return { x1: acx, y1: a.y, x2: bcx, y2: b.y + b.h };
  }

  function pushBezierLink(
    parts: string[],
    from: BoardCard,
    to: BoardCard,
    active: boolean,
    kind: "term" | "sub"
  ): void {
    const { x1, y1, x2, y2 } = linkAnchors(from, to);
    const dx = Math.max(48, Math.abs(x2 - x1) * 0.45);
    const dy = Math.max(48, Math.abs(y2 - y1) * 0.45);
    const horizontal = Math.abs(x2 - x1) >= Math.abs(y2 - y1);
    const c1x = horizontal ? x1 + Math.sign(x2 - x1 || 1) * dx : x1;
    const c1y = horizontal ? y1 : y1 + Math.sign(y2 - y1 || 1) * dy;
    const c2x = horizontal ? x2 - Math.sign(x2 - x1 || 1) * dx : x2;
    const c2y = horizontal ? y2 : y2 - Math.sign(y2 - y1 || 1) * dy;
    const base = kind === "sub" ? "board-link board-link-sub" : "board-link";
    const cls = active ? `${base} is-active` : base;
    parts.push(
      `<path class="${cls}" d="M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}" />`,
      `<circle class="board-link-dot${active ? " is-active" : ""}${kind === "sub" ? " is-sub" : ""}" cx="${x1}" cy="${y1}" r="3.5" />`,
      `<circle class="board-link-dot${active ? " is-active" : ""}${kind === "sub" ? " is-sub" : ""}" cx="${x2}" cy="${y2}" r="3.5" />`
    );
  }

  function updateLinks(): void {
    linksSvg.setAttribute("width", String(WORLD.w));
    linksSvg.setAttribute("height", String(WORLD.h));
    linksSvg.setAttribute("viewBox", `0 0 ${WORLD.w} ${WORLD.h}`);

    const parts: string[] = [];
    for (const prompt of cards) {
      if (prompt.kind !== "prompt") continue;
      const term = cards.find(
        (c): c is TerminalCard =>
          c.kind === "terminal" && c.tabId === prompt.tabId
      );
      // Root prompts link to terminal; subs mainly link to parent (term link only for roots).
      if (term && !prompt.parentId) {
        const active =
          focus?.cardId === prompt.id ||
          focus?.cardId === term.id ||
          (focus?.tabId === prompt.tabId && focus.kind === "prompt");
        pushBezierLink(parts, term, prompt, active, "term");
      }
      if (prompt.parentId) {
        const parent = cards.find(
          (c): c is PromptCard =>
            c.kind === "prompt" && c.id === prompt.parentId
        );
        if (parent) {
          const active =
            focus?.cardId === prompt.id || focus?.cardId === parent.id;
          pushBezierLink(parts, parent, prompt, active, "sub");
        }
      }
    }
    linksSvg.innerHTML = parts.join("");
  }

  function resolvePromptTabId(): string | null {
    if (focus?.tabId) return focus.tabId;
    return (
      cards.find((c) => c.kind === "terminal" && !c.minimized)?.tabId ??
      cards.find((c) => c.kind === "terminal")?.tabId ??
      null
    );
  }

  function requestAddPrompt(tabId?: string | null): void {
    const id = tabId || resolvePromptTabId();
    if (!id) return;
    root.dispatchEvent(
      new CustomEvent("board:add-prompt", { detail: { tabId: id } })
    );
  }

  function syncAddPromptEnabled(): void {
    const targetTab = resolvePromptTabId();
    for (const card of cards) {
      if (card.kind !== "terminal") continue;
      const el = cardEls.get(card.id);
      const btn = el?.querySelector(
        ".board-card-add-prompt"
      ) as HTMLButtonElement | null;
      if (!btn) continue;
      // Show on the terminal that would receive the new prompt.
      const show = !card.minimized && Boolean(targetTab) && card.tabId === targetTab;
      btn.classList.toggle("is-hidden", !show);
      btn.disabled = false;
    }
  }

  function schedulePersist(): void {
    if (persistTimer != null) window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
      persistTimer = null;
      handlers.onLayoutChange();
    }, 180);
  }

  function contentExtents(): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  } | null {
    if (cards.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const card of cards) {
      const { w, h } = cardSize(card);
      minX = Math.min(minX, card.x);
      minY = Math.min(minY, card.y);
      maxX = Math.max(maxX, card.x + w);
      maxY = Math.max(maxY, card.y + h);
    }
    return { minX, minY, maxX, maxY };
  }

  function contentBounds(): {
    x: number;
    y: number;
    w: number;
    h: number;
  } {
    const ext = contentExtents();
    if (!ext) {
      return { x: WORLD.x, y: WORLD.y, w: WORLD.w, h: WORLD.h };
    }
    const pad = 64;
    return {
      x: ext.minX - pad,
      y: ext.minY - pad,
      w: Math.max(320, ext.maxX - ext.minX + pad * 2),
      h: Math.max(240, ext.maxY - ext.minY + pad * 2),
    };
  }

  /**
   * Cover the viewport at min zoom (no letterbox margin outside the canvas).
   * max(vw/W, vh/H) → canvas always fills the screen when fully zoomed out.
   */
  function canvasMinZoom(): number {
    const vw = Math.max(1, viewport.clientWidth);
    const vh = Math.max(1, viewport.clientHeight);
    const cover = Math.max(vw / WORLD.w, vh / WORLD.h);
    return Math.max(ZOOM_ABS_MIN, cover);
  }

  function clampZoom(z: number): number {
    return clamp(z, canvasMinZoom(), ZOOM_MAX);
  }

  /** Hard stop at canvas edges — same idea as Figma's ±65k wall. */
  function clampCamera(): void {
    const vw = viewport.clientWidth || 1;
    const vh = viewport.clientHeight || 1;
    const viewW = vw / camera.zoom;
    const viewH = vh / camera.zoom;

    let viewLeft = -camera.x / camera.zoom;
    let viewTop = -camera.y / camera.zoom;

    // With canvasMinZoom, view should not exceed the world; keep a safe branch anyway.
    if (viewW >= WORLD.w - 0.5) {
      viewLeft = WORLD.x + (WORLD.w - viewW) / 2;
    } else {
      viewLeft = clamp(viewLeft, WORLD.x, WORLD.x + WORLD.w - viewW);
    }
    if (viewH >= WORLD.h - 0.5) {
      viewTop = WORLD.y + (WORLD.h - viewH) / 2;
    } else {
      viewTop = clamp(viewTop, WORLD.y, WORLD.y + WORLD.h - viewH);
    }

    camera.x = -viewLeft * camera.zoom;
    camera.y = -viewTop * camera.zoom;
  }

  function clampCardInWorld(card: BoardCard): void {
    const { w, h } = cardSize(card);
    card.x = clamp(card.x, WORLD.x, WORLD.x + WORLD.w - w);
    card.y = clamp(card.y, WORLD.y, WORLD.y + WORLD.h - h);
  }

  function mapLayout(): {
    scale: number;
    ox: number;
    oy: number;
    bodyW: number;
    bodyH: number;
  } {
    const bodyW = minimapBody.clientWidth || 160;
    const bodyH = minimapBody.clientHeight || 96;
    const scale = Math.min(bodyW / WORLD.w, bodyH / WORLD.h);
    const drawW = WORLD.w * scale;
    const drawH = WORLD.h * scale;
    return {
      scale,
      ox: (bodyW - drawW) / 2,
      oy: (bodyH - drawH) / 2,
      bodyW,
      bodyH,
    };
  }

  function rebuildMinimapCards(): void {
    const { scale, ox, oy } = mapLayout();
    minimapWorld.innerHTML = "";

    const matEl = document.createElement("div");
    matEl.className = "board-minimap-mat";
    matEl.style.left = `${ox}px`;
    matEl.style.top = `${oy}px`;
    matEl.style.width = `${WORLD.w * scale}px`;
    matEl.style.height = `${WORLD.h * scale}px`;
    minimapWorld.append(matEl);

    for (const card of cards) {
      const { w, h } = cardSize(card);
      const node = document.createElement("div");
      node.className = `board-minimap-card board-minimap-card-${card.kind}${
        focus?.cardId === card.id ? " is-focused" : ""
      }${card.kind === "terminal" && card.minimized ? " is-chip" : ""}`;
      node.dataset.cardId = card.id;
      node.style.left = `${ox + (card.x - WORLD.x) * scale}px`;
      node.style.top = `${oy + (card.y - WORLD.y) * scale}px`;
      node.style.width = `${Math.max(3, w * scale)}px`;
      node.style.height = `${Math.max(3, h * scale)}px`;
      if (w * scale >= 28 && h * scale >= 14) {
        const label = document.createElement("span");
        label.className = "board-minimap-card-label";
        label.textContent = cardTitle(card);
        node.append(label);
      }
      minimapWorld.append(node);
    }
    minimapDirty = false;
  }

  function updateMinimap(): void {
    if (mapCollapsed) return;
    if (minimapDirty) rebuildMinimapCards();

    const { scale, ox, oy } = mapLayout();
    const vw = viewport.clientWidth || 1;
    const vh = viewport.clientHeight || 1;
    const viewX = -camera.x / camera.zoom;
    const viewY = -camera.y / camera.zoom;
    const viewW = vw / camera.zoom;
    const viewH = vh / camera.zoom;

    mapFrame = { worldX: WORLD.x, worldY: WORLD.y, scale, ox, oy };

    // Keep mat size in sync without rebuilding cards every pan
    const matEl = minimapWorld.querySelector(
      ".board-minimap-mat"
    ) as HTMLElement | null;
    if (matEl) {
      matEl.style.left = `${ox}px`;
      matEl.style.top = `${oy}px`;
      matEl.style.width = `${WORLD.w * scale}px`;
      matEl.style.height = `${WORLD.h * scale}px`;
    }

    for (const node of minimapWorld.children) {
      const el = node as HTMLElement;
      if (el.classList.contains("board-minimap-mat")) continue;
      el.classList.toggle("is-focused", el.dataset.cardId === focus?.cardId);
    }

    minimapView.style.left = `${ox + (viewX - WORLD.x) * scale}px`;
    minimapView.style.top = `${oy + (viewY - WORLD.y) * scale}px`;
    minimapView.style.width = `${Math.max(8, Math.min(viewW * scale, WORLD.w * scale))}px`;
    minimapView.style.height = `${Math.max(8, Math.min(viewH * scale, WORLD.h * scale))}px`;
  }

  function applyCamera(persist = false): void {
    camera.zoom = clampZoom(camera.zoom);
    clampCamera();
    surface.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`;

    const cell = Math.max(10, GRID_BASE * camera.zoom);
    grid.style.backgroundSize = `${cell}px ${cell}px`;
    grid.style.backgroundPosition = `${camera.x}px ${camera.y}px`;

    zoomLabel.textContent = `${Math.round(camera.zoom * 100)}%`;
    updateMinimap();
    if (persist) schedulePersist();
  }

  function zoomAt(nextZoom: number, clientX: number, clientY: number): void {
    if (viewLocked) return;
    const rect = viewport.getBoundingClientRect();
    const vx = clientX - rect.left;
    const vy = clientY - rect.top;
    const wx = (vx - camera.x) / camera.zoom;
    const wy = (vy - camera.y) / camera.zoom;
    camera.zoom = clampZoom(nextZoom);
    camera.x = vx - wx * camera.zoom;
    camera.y = vy - wy * camera.zoom;
    applyCamera(true);
  }

  function zoomByFactor(factor: number): void {
    if (viewLocked) return;
    const rect = viewport.getBoundingClientRect();
    zoomAt(
      camera.zoom * factor,
      rect.left + rect.width / 2,
      rect.top + rect.height / 2
    );
  }

  function fitAll(): void {
    if (viewLocked) return;
    const bounds = contentBounds();
    const vw = viewport.clientWidth || 1;
    const vh = viewport.clientHeight || 1;
    const pad = 72;
    camera.zoom = clampZoom(
      Math.min((vw - pad * 2) / bounds.w, (vh - pad * 2) / bounds.h)
    );
    camera.x = (vw - bounds.w * camera.zoom) / 2 - bounds.x * camera.zoom;
    camera.y = (vh - bounds.h * camera.zoom) / 2 - bounds.y * camera.zoom;
    applyCamera(true);
  }

  /**
   * Pack open (non-minimized) terminals into the viewport.
   * - fill: edge-to-edge, no gaps (flush chrome)
   * - fit: small outer margin + gaps so every terminal is visible at once
   */
  function layoutOpenTerminals(mode: "fill" | "fit"): void {
    const terms = cards.filter(
      (c): c is TerminalCard => c.kind === "terminal" && !c.minimized
    );
    if (terms.length === 0) return;

    const vw = Math.max(1, viewport.clientWidth);
    const vh = Math.max(1, viewport.clientHeight);
    const n = terms.length;
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const pad = mode === "fit" ? 20 : 0;
    const gap = mode === "fit" ? 12 : 0;
    const usableW = Math.max(1, vw - pad * 2);
    const usableH = Math.max(1, vh - pad * 2);

    // Keep the tile block inside the world canvas at zoom 1.
    const maxOriginX = Math.max(WORLD.x, WORLD.x + WORLD.w - vw);
    const maxOriginY = Math.max(WORLD.y, WORLD.y + WORLD.h - vh);
    const originX = clamp(WORLD.x + 24, WORLD.x, maxOriginX);
    const originY = clamp(WORLD.y + 24, WORLD.y, maxOriginY);

    camera.zoom = 1;
    camera.x = -originX;
    camera.y = -originY;

    for (const card of cards) {
      if (card.kind === "terminal") {
        cardEls.get(card.id)?.classList.remove("is-tiled");
      }
    }

    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / cols);
      const rowStart = row * cols;
      const itemsInRow = Math.min(cols, n - rowStart);
      const col = i - rowStart;
      const cellW =
        (usableW - gap * Math.max(0, itemsInRow - 1)) / itemsInRow;
      const cellH = (usableH - gap * Math.max(0, rows - 1)) / rows;
      const term = terms[i]!;
      term.x = originX + pad + col * (cellW + gap);
      term.y = originY + pad + row * (cellH + gap);
      term.w = cellW;
      term.h = cellH;
      term.z = nextZ();
      clampCardInWorld(term);
    }

    for (const term of terms) {
      const el = cardEls.get(term.id);
      el?.classList.add("is-arranging");
      if (mode === "fill") el?.classList.add("is-tiled");
    }
    void surface.offsetWidth;
    applyCamera(true);
    for (const term of terms) {
      layoutCard(term);
    }
    window.setTimeout(() => {
      for (const term of terms) {
        cardEls.get(term.id)?.classList.remove("is-arranging");
      }
    }, 320);

    updateLinks();
    markMinimapDirty();
    schedulePersist();
    setViewLocked(true);
    root.dispatchEvent(
      new CustomEvent("board:refit-terminals", { bubbles: true })
    );
  }

  function tileOpenTerminals(): void {
    layoutOpenTerminals("fill");
  }

  function fitOpenTerminals(): void {
    layoutOpenTerminals("fit");
  }

  /** Tidy cards by session: terminal left, linked prompts stacked to the right. */
  function arrangeCards(): void {
    if (cards.length === 0) return;

    setViewLocked(false);
    for (const card of cards) {
      if (card.kind === "terminal") {
        cardEls.get(card.id)?.classList.remove("is-tiled");
      }
    }

    const GAP_X = 56;
    const GAP_Y = 40;
    const GROUP_GAP_X = 80;
    const GROUP_GAP_Y = 72;
    const ORIGIN_X = 80;
    const ORIGIN_Y = 80;

    type Group = {
      terminal?: TerminalCard;
      prompts: PromptCard[];
    };
    const groups: Group[] = [];
    const seen = new Set<string>();

    for (const card of cards) {
      if (card.kind !== "terminal") continue;
      seen.add(card.tabId);
      groups.push({
        terminal: card,
        prompts: cards.filter(
          (c): c is PromptCard => c.kind === "prompt" && c.tabId === card.tabId
        ),
      });
    }
    for (const card of cards) {
      if (card.kind !== "prompt" || seen.has(card.tabId)) continue;
      seen.add(card.tabId);
      groups.push({
        prompts: cards.filter(
          (c): c is PromptCard => c.kind === "prompt" && c.tabId === card.tabId
        ),
      });
    }

    let colX = ORIGIN_X;
    let y = ORIGIN_Y;
    let colW = 0;

    for (const group of groups) {
      const term = group.terminal;
      const termSize = term
        ? term.minimized
          ? { w: CHIP_W, h: CHIP_H }
          : { w: term.w, h: term.h }
        : { w: 0, h: 0 };
      const roots = group.prompts.filter((p) => !p.parentId);
      const childrenOf = (parentId: string) =>
        group.prompts.filter((p) => p.parentId === parentId);

      let stackH = 0;
      let stackW = 0;
      for (const root of roots) {
        const kids = childrenOf(root.id);
        const kidsH =
          kids.length === 0
            ? 0
            : kids.reduce((sum, p, i) => sum + p.h + (i > 0 ? GAP_Y : 0), 0);
        const kidsW = kids.reduce((m, p) => Math.max(m, p.w), 0);
        const blockH = Math.max(root.h, kidsH || 0);
        const blockW = root.w + (kids.length ? GAP_X + kidsW : 0);
        stackH += (stackH > 0 ? GAP_Y : 0) + blockH;
        stackW = Math.max(stackW, blockW);
      }
      const groupW =
        termSize.w + (term && roots.length ? GAP_X : 0) + stackW;
      const groupH = Math.max(termSize.h, stackH, 1);

      if (y > ORIGIN_Y && y + groupH > WORLD.y + WORLD.h - 48) {
        colX += colW + GROUP_GAP_X;
        y = ORIGIN_Y;
        colW = 0;
      }

      let x = colX;
      if (term) {
        term.x = x;
        term.y = y;
        clampCardInWorld(term);
        x += termSize.w + (roots.length ? GAP_X : 0);
      }
      let py = y;
      for (const root of roots) {
        root.x = x;
        root.y = py;
        clampCardInWorld(root);
        const kids = childrenOf(root.id);
        let cy = py;
        const cx = x + root.w + GAP_X;
        for (const child of kids) {
          child.x = cx;
          child.y = cy;
          clampCardInWorld(child);
          cy += child.h + GAP_Y;
        }
        const blockH = Math.max(
          root.h,
          kids.length ? cy - py - GAP_Y : root.h
        );
        py += blockH + GAP_Y;
      }

      colW = Math.max(colW, groupW);
      y += groupH + GROUP_GAP_Y;
    }

    for (const card of cards) {
      cardEls.get(card.id)?.classList.add("is-arranging");
    }
    // Force a style flush so the transition starts from the old transform.
    void surface.offsetWidth;
    for (const card of cards) {
      layoutCard(card);
    }
    window.setTimeout(() => {
      for (const card of cards) {
        cardEls.get(card.id)?.classList.remove("is-arranging");
      }
    }, 320);

    updateLinks();
    markMinimapDirty();
    fitAll();
    schedulePersist();
    root.dispatchEvent(
      new CustomEvent("board:refit-terminals", { bubbles: true })
    );
  }

  function resetZoom(): void {
    const rect = viewport.getBoundingClientRect();
    zoomAt(1, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  function clientToWorldOnMap(
    clientX: number,
    clientY: number
  ): { x: number; y: number } {
    const rect = minimapBody.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    return {
      x: mapFrame.worldX + (mx - mapFrame.ox) / mapFrame.scale,
      y: mapFrame.worldY + (my - mapFrame.oy) / mapFrame.scale,
    };
  }

  function centerCameraOnWorld(worldX: number, worldY: number): void {
    if (viewLocked) return;
    const vw = viewport.clientWidth || 1;
    const vh = viewport.clientHeight || 1;
    camera.x = vw / 2 - worldX * camera.zoom;
    camera.y = vh / 2 - worldY * camera.zoom;
    applyCamera(true);
  }

  function setFocus(next: BoardFocus): void {
    focus = next;
    for (const [id, el] of cardEls) {
      el.classList.toggle("is-focused", Boolean(next && next.cardId === id));
    }
    if (broadcastActive) syncBroadcastUi(true, broadcastMembers);
    syncAddPromptEnabled();
    updateLinks();
    updateMinimap();
    handlers.onFocus(next);
  }

  function bringToFront(cardId: string): void {
    const card = cards.find((c) => c.id === cardId);
    if (!card) return;
    card.z = nextZ();
    const el = cardEls.get(cardId);
    if (el) el.style.zIndex = String(card.z);
  }

  function cardCenter(card: BoardCard): { x: number; y: number } {
    const { w, h } = cardSize(card);
    return { x: card.x + w / 2, y: card.y + h / 2 };
  }

  function viewportWorldCenter(): { x: number; y: number } {
    const vw = viewport.clientWidth || 1;
    const vh = viewport.clientHeight || 1;
    return {
      x: (-camera.x + vw / 2) / camera.zoom,
      y: (-camera.y + vh / 2) / camera.zoom,
    };
  }

  function ensureCardVisible(card: BoardCard): void {
    const { w, h } = cardSize(card);
    const vw = viewport.clientWidth || 1;
    const vh = viewport.clientHeight || 1;
    const viewLeft = -camera.x / camera.zoom;
    const viewTop = -camera.y / camera.zoom;
    const viewRight = viewLeft + vw / camera.zoom;
    const viewBottom = viewTop + vh / camera.zoom;
    const pad = 48 / camera.zoom;
    if (
      card.x < viewLeft + pad ||
      card.y < viewTop + pad ||
      card.x + w > viewRight - pad ||
      card.y + h > viewBottom - pad
    ) {
      centerCameraOnWorld(card.x + w / 2, card.y + h / 2);
    }
  }

  /** Move focus to the nearest card in a screen-direction (⌥⌘ + arrows). */
  function focusNeighbor(
    dir: "left" | "right" | "up" | "down"
  ): boolean {
    if (cards.length === 0) return false;
    const current = focus
      ? cards.find((c) => c.id === focus!.cardId)
      : undefined;
    const origin = current ? cardCenter(current) : viewportWorldCenter();

    let best: BoardCard | null = null;
    let bestScore = Infinity;
    for (const card of cards) {
      if (current && card.id === current.id) continue;
      const c = cardCenter(card);
      const dx = c.x - origin.x;
      const dy = c.y - origin.y;
      let primary = 0;
      let secondary = 0;
      if (dir === "right") {
        primary = dx;
        secondary = Math.abs(dy);
      } else if (dir === "left") {
        primary = -dx;
        secondary = Math.abs(dy);
      } else if (dir === "down") {
        primary = dy;
        secondary = Math.abs(dx);
      } else {
        primary = -dy;
        secondary = Math.abs(dx);
      }
      // Must be clearly in that direction (centers).
      if (primary <= 8) continue;
      const score = primary + secondary * 2.5;
      if (score < bestScore) {
        bestScore = score;
        best = card;
      }
    }
    if (!best) return false;

    bringToFront(best.id);
    setFocus({ kind: best.kind, cardId: best.id, tabId: best.tabId });
    ensureCardVisible(best);
    const el = cardEls.get(best.id);
    if (best.kind === "prompt") {
      const input = el?.querySelector(
        "[data-prompt-input]"
      ) as HTMLElement | null;
      input?.focus({ preventScroll: true });
    } else {
      el?.focus({ preventScroll: true });
    }
    return true;
  }

  function layoutCard(card: BoardCard): void {
    const el = cardEls.get(card.id);
    if (!el) return;
    const minimized = card.kind === "terminal" && card.minimized;
    const w = minimized ? CHIP_W : card.w;
    const h = minimized ? CHIP_H : card.h;
    el.style.transform = `translate(${card.x}px, ${card.y}px)`;
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    el.style.zIndex = String(card.z);
    el.classList.toggle("is-minimized", minimized);
    if (card.kind === "terminal") {
      const minBtn = el.querySelector(
        ".board-card-min"
      ) as HTMLButtonElement | null;
      if (minBtn) {
        const label = minimized ? t("board.expand") : t("board.minimize");
        minBtn.title = label;
        minBtn.setAttribute("aria-label", label);
      }
      syncAddPromptEnabled();
    }
    updateLinks();
  }

  function markMinimapDirty(): void {
    minimapDirty = true;
    updateMinimap();
    updateLinks();
  }

  function wireDrag(el: HTMLElement, cardId: string): void {
    const head = el.querySelector(".board-card-head") as HTMLElement | null;
    if (!head) return;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;
    let lastCardX = 0;

    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const card = cards.find((c) => c.id === cardId);
      if (!card) return;
      card.x = originX + (e.clientX - startX) / camera.zoom;
      card.y = originY + (e.clientY - startY) / camera.zoom;
      clampCardInWorld(card);
      if (card.kind === "terminal" && !card.minimized) {
        snow.shake(card.id, card.x - lastCardX);
        leaves.shake(card.id, card.x - lastCardX);
        sakura.shake(card.id, card.x - lastCardX);
        rain.shake(card.id, card.x - lastCardX);
        fireflies.shake(card.id, card.x - lastCardX);
      }
      lastCardX = card.x;
      layoutCard(card);
      markMinimapDirty();
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      schedulePersist();
    };

    head.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      if (spaceHeld || e.button === 1) return;
      const card = cards.find((c) => c.id === cardId);
      if (!card) return;
      dragging = true;
      el.classList.remove("is-tiled");
      startX = e.clientX;
      startY = e.clientY;
      originX = card.x;
      originY = card.y;
      lastCardX = card.x;
      bringToFront(cardId);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      e.preventDefault();
    });
  }

  function wireResize(el: HTMLElement, cardId: string): void {
    const handle = el.querySelector(".board-card-resize") as HTMLElement | null;
    if (!handle) return;
    let resizing = false;
    let startX = 0;
    let startY = 0;
    let originW = 0;
    let originH = 0;

    const onMove = (e: PointerEvent) => {
      if (!resizing) return;
      const card = cards.find((c) => c.id === cardId);
      if (!card || (card.kind === "terminal" && card.minimized)) return;
      const minW = card.kind === "prompt" ? 300 : 280;
      const minH = card.kind === "prompt" ? 280 : 200;
      card.w = Math.max(minW, originW + (e.clientX - startX) / camera.zoom);
      card.h = Math.max(minH, originH + (e.clientY - startY) / camera.zoom);
      card.w = Math.min(card.w, WORLD.x + WORLD.w - card.x);
      card.h = Math.min(card.h, WORLD.y + WORLD.h - card.y);
      layoutCard(card);
      markMinimapDirty();
    };
    const onUp = () => {
      if (!resizing) return;
      resizing = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      schedulePersist();
      if (cards.find((c) => c.id === cardId)?.kind === "terminal") {
        root.dispatchEvent(
          new CustomEvent("board:refit-terminals", { bubbles: true })
        );
      }
    };

    handle.addEventListener("pointerdown", (e) => {
      const card = cards.find((c) => c.id === cardId);
      if (!card || (card.kind === "terminal" && card.minimized)) return;
      if (e.button !== 0) return;
      resizing = true;
      el.classList.remove("is-tiled");
      startX = e.clientX;
      startY = e.clientY;
      originW = card.w;
      originH = card.h;
      bringToFront(cardId);
      handle.setPointerCapture?.(e.pointerId);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      e.preventDefault();
      e.stopPropagation();
    });
  }

  function buildTerminalCard(card: TerminalCard): HTMLElement {
    const el = document.createElement("article");
    el.className = "board-card board-card-terminal";
    el.tabIndex = -1;
    el.dataset.cardId = card.id;
    el.dataset.tabId = card.tabId;
    el.innerHTML = `
      <header class="board-card-head">
        <button type="button" class="board-card-broadcast-chip" data-broadcast-member data-i18n-title="board.broadcastMember" title="${t("board.broadcastMember")}" aria-label="${t("board.broadcastMember")}" aria-pressed="false">${icons.broadcastMember(12)}</button>
        <span class="board-card-ico" aria-hidden="true">${icons.terminal(13)}</span>
        <span class="board-card-title"></span>
        <span class="board-card-broadcast-badge is-hidden" data-broadcast-badge aria-hidden="true"></span>
        <div class="board-card-actions">
          <button type="button" class="icon ghost board-card-add-prompt" data-i18n-title="board.addPrompt" title="${t("board.addPrompt")}" aria-label="${t("board.addPrompt")}">${icons.addPrompt(13)}</button>
          <button type="button" class="icon ghost board-card-min" data-i18n-title="board.minimize" title="Minimize">${icons.chevronDown(12)}</button>
          <button type="button" class="icon ghost board-card-close" data-i18n-title="board.close" title="Close">×</button>
        </div>
      </header>
      <div class="board-card-body">
        <div class="board-term-host" data-term-host></div>
      </div>
      <div class="board-card-resize" aria-hidden="true"></div>
    `;
    (el.querySelector(".board-card-title") as HTMLElement).textContent =
      card.title;
    el.addEventListener("pointerdown", (e) => {
      if (spaceHeld || e.button !== 0) return;
      if ((e.target as HTMLElement).closest("button")) return;
      bringToFront(card.id);
      setFocus({ kind: "terminal", cardId: card.id, tabId: card.tabId });
      // Minimized chips stay collapsed — expand only via the chevron button.
    });
    el.querySelector("[data-broadcast-member]")!.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      handlers.onToggleBroadcastMember(card.tabId);
    });
    el.querySelector(".board-card-add-prompt")!.addEventListener("click", (e) => {
      e.stopPropagation();
      requestAddPrompt(card.tabId);
    });
    el.querySelector(".board-card-min")!.addEventListener("click", (e) => {
      e.stopPropagation();
      handlers.onToggleMinimize(card.id);
    });
    el.querySelector(".board-card-close")!.addEventListener("click", (e) => {
      e.stopPropagation();
      handlers.onCloseTerminal(card.tabId);
    });
    wireDrag(el, card.id);
    wireResize(el, card.id);
    return el;
  }

  function syncBroadcastUi(
    active: boolean,
    memberTabIds: Iterable<string>
  ): void {
    broadcastActive = active;
    // Snapshot first — callers often pass `broadcastMembers` itself; clearing
    // that live Set before iterating would wipe every member (focus changes).
    const nextMembers = new Set(memberTabIds);
    broadcastMembers.clear();
    for (const id of nextMembers) broadcastMembers.add(id);
    viewport.classList.toggle("is-broadcast", active);
    broadcastBtn.classList.toggle("is-active", active);
    broadcastBtn.setAttribute("aria-pressed", active ? "true" : "false");
    const label = active ? t("board.broadcastOff") : t("board.broadcast");
    broadcastBtn.title = label;
    broadcastBtn.setAttribute("aria-label", label);
    broadcastBtn.setAttribute(
      "data-i18n-title",
      active ? "board.broadcastOff" : "board.broadcast"
    );
    const sourceTabId =
      focus?.kind === "terminal" ? focus.tabId : null;
    for (const card of cards) {
      if (card.kind !== "terminal") continue;
      const el = cardEls.get(card.id);
      if (!el) continue;
      const member = active && broadcastMembers.has(card.tabId);
      const source = member && sourceTabId === card.tabId;
      el.classList.toggle("is-broadcast", member);
      el.classList.toggle("is-broadcast-source", Boolean(source));
      const chip = el.querySelector(
        "[data-broadcast-member]"
      ) as HTMLButtonElement | null;
      if (chip) {
        chip.classList.toggle("is-member", member);
        chip.setAttribute("aria-pressed", member ? "true" : "false");
        const chipLabel = member
          ? t("board.broadcastMemberOff")
          : t("board.broadcastMember");
        chip.title = chipLabel;
        chip.setAttribute("aria-label", chipLabel);
        chip.setAttribute(
          "data-i18n-title",
          member ? "board.broadcastMemberOff" : "board.broadcastMember"
        );
      }
      const badge = el.querySelector(
        "[data-broadcast-badge]"
      ) as HTMLElement | null;
      if (badge) {
        badge.classList.toggle("is-hidden", !member);
        badge.classList.toggle("is-source", Boolean(source));
        badge.textContent = member
          ? source
            ? t("board.broadcastBadgeSource")
            : t("board.broadcastBadge")
          : "";
        badge.setAttribute("aria-hidden", member ? "false" : "true");
      }
    }
  }

  function syncPromptStatusBadge(card: PromptCard): void {
    const el = cardEls.get(card.id);
    if (!el) return;
    const badge = el.querySelector(
      "[data-prompt-status]"
    ) as HTMLElement | null;
    if (!badge) return;
    const status = card.runStatus || "idle";
    badge.dataset.status = status;
    badge.classList.toggle("is-hidden", status === "idle");
    const label =
      status === "running"
        ? t("board.subRunning")
        : status === "waiting"
          ? t("board.subWaiting")
          : status === "done"
            ? t("board.subDone")
            : status === "error"
              ? t("board.subError")
              : "";
    badge.textContent = label;
  }

  function buildPromptCard(card: PromptCard, sessionTitle: string): HTMLElement {
    const el = document.createElement("article");
    el.className = `board-card board-card-prompt${card.parentId ? " is-sub" : ""}`;
    el.tabIndex = -1;
    el.dataset.cardId = card.id;
    el.dataset.tabId = card.tabId;
    if (card.parentId) el.dataset.parentId = card.parentId;
    const canAddSub = !card.parentId;
    el.innerHTML = `
      <header class="board-card-head">
        <span class="board-card-ico" aria-hidden="true">${card.parentId ? icons.addSub(13) : icons.message(13)}</span>
        <span class="board-card-title"></span>
        <span class="board-card-status is-hidden" data-prompt-status data-status="idle"></span>
        <span class="board-card-bind"></span>
        <div class="board-card-actions">
          ${
            canAddSub
              ? `<button type="button" class="icon ghost board-card-add-sub" data-i18n-title="board.addSub" title="${t("board.addSub")}" aria-label="${t("board.addSub")}">${icons.addSub(13)}</button>`
              : ""
          }
          <button type="button" class="icon ghost board-card-close" data-i18n-title="board.close" title="Close">×</button>
        </div>
      </header>
      <div class="board-card-body board-prompt-body">
        <div class="chat-thread board-prompt-thread" data-prompt-thread></div>
        <div class="agent-compose board-prompt-compose">
          <div class="composer" data-prompt-composer>
            <button type="button" class="composer-context is-empty" data-prompt-context title="">
              <span class="composer-context-ico" aria-hidden="true">${icons.terminal(12)}</span>
              <span class="composer-context-kind" data-prompt-kind></span>
              <span class="composer-context-sep" aria-hidden="true">·</span>
              <span class="composer-context-path" data-prompt-path></span>
            </button>
            <div class="composer-attachments hidden" data-prompt-attachments aria-live="polite"></div>
            <div class="composer-input-wrap is-empty" data-prompt-wrap>
              <div class="composer-placeholder" data-i18n="chat.placeholder" aria-hidden="true">${t("chat.placeholder")}</div>
              <div class="composer-editor" contenteditable="true" role="textbox" aria-multiline="true" data-prompt-input></div>
            </div>
            <div class="composer-drop-hint" data-prompt-drop-hint data-i18n="chat.attach.dropHint" aria-hidden="true">${t("chat.attach.dropHint")}</div>
            <div class="composer-foot">
              <div class="composer-left">
                <div class="mode-wrap">
                  <button type="button" class="mode-chip" data-prompt-mode aria-haspopup="listbox" aria-expanded="false">
                    <span class="mode-icon" data-mode-icon aria-hidden="true"></span>
                    <span data-mode-label>Agent</span>
                    <span class="mode-caret" aria-hidden="true">${icons.chevronDown(12)}</span>
                  </button>
                </div>
                <div class="model-wrap">
                  <button type="button" class="model-chip" data-prompt-model aria-haspopup="listbox" aria-expanded="false">
                    <span data-model-label>Auto</span>
                    <span class="mode-caret" aria-hidden="true">${icons.chevronDown(12)}</span>
                  </button>
                </div>
              </div>
              <div class="composer-right">
                <input type="file" class="composer-file-input" data-prompt-file-input multiple hidden />
                <button type="button" class="icon ghost composer-attach-btn" data-prompt-attach data-i18n-title="chat.attach" title="${t("chat.attach")}" aria-label="${t("chat.attach")}">${icons.attach(15)}</button>
                <button class="send-btn" data-prompt-send data-i18n-title="chat.send" title="${t("chat.send")}" aria-label="${t("chat.send")}">${icons.send(16)}</button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="board-card-resize" aria-hidden="true"></div>
    `;
    (el.querySelector(".board-card-title") as HTMLElement).textContent =
      card.title || (card.parentId ? t("board.subPrompt") : t("board.prompt"));
    (el.querySelector(".board-card-bind") as HTMLElement).textContent =
      card.parentId ? t("board.subOf", { title: sessionTitle }) : sessionTitle;

    const input = el.querySelector("[data-prompt-input]") as HTMLDivElement;
    const wrap = el.querySelector("[data-prompt-wrap]") as HTMLElement;
    const placeholder = el.querySelector(".composer-placeholder") as HTMLElement;
    const syncComposerEmpty = () => {
      const empty = !(input.textContent || "").trim();
      wrap.classList.toggle("is-empty", empty);
      placeholder.classList.toggle("hidden", !empty);
    };
    input.addEventListener("input", syncComposerEmpty);
    input.addEventListener("keydown", (e) =>
      handlers.onPromptInputKeydown(card.id, e)
    );
    el.querySelector("[data-prompt-send]")!.addEventListener("click", () => {
      handlers.onPromptSend(card.id);
    });
    el.addEventListener("mousedown", () => {
      if (spaceHeld) return;
      bringToFront(card.id);
      setFocus({ kind: "prompt", cardId: card.id, tabId: card.tabId });
    });
    el.querySelector(".board-card-add-sub")?.addEventListener("click", (e) => {
      e.stopPropagation();
      handlers.onAddSub(card.id);
    });
    el.querySelector(".board-card-close")!.addEventListener("click", (e) => {
      e.stopPropagation();
      handlers.onClosePrompt(card.id);
    });
    wireDrag(el, card.id);
    wireResize(el, card.id);
    return el;
  }

  function mountCard(card: BoardCard): void {
    const sessionTitle =
      cards.find((c) => c.kind === "terminal" && c.tabId === card.tabId)
        ?.title ?? card.tabId;
    const el =
      card.kind === "terminal"
        ? buildTerminalCard(card)
        : buildPromptCard(card, sessionTitle);
    cardEls.set(card.id, el);
    surface.append(el);
    layoutCard(card);
    if (card.kind === "prompt") syncPromptStatusBadge(card);
    markMinimapDirty();
  }

  function removeCardEl(cardId: string): void {
    cardEls.get(cardId)?.remove();
    cardEls.delete(cardId);
    markMinimapDirty();
  }

  function cascadeOrigin(): { x: number; y: number } {
    const n = cards.filter((c) => c.kind === "terminal").length;
    const col = n % 3;
    const row = Math.floor(n / 3) % 3;
    return {
      x: 48 + col * 56 + row * 12,
      y: 48 + row * 48 + col * 16,
    };
  }

  function startPan(e: PointerEvent): void {
    if (viewLocked) return;
    panning = true;
    const startX = e.clientX;
    const startY = e.clientY;
    const originX = camera.x;
    const originY = camera.y;
    viewport.classList.add("is-panning");
    const onMove = (ev: PointerEvent) => {
      if (!panning || viewLocked) return;
      camera.x = originX + (ev.clientX - startX);
      camera.y = originY + (ev.clientY - startY);
      applyCamera();
    };
    const onUp = () => {
      panning = false;
      viewport.classList.remove("is-panning");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      schedulePersist();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    e.preventDefault();
  }

  // Capture phase so Space / middle-mouse win over card drag
  viewport.addEventListener(
    "pointerdown",
    (e) => {
      const target = e.target as HTMLElement;
      if (target.closest(".board-chrome")) return;
      const overCard = Boolean(target.closest(".board-card"));
      if (viewLocked) {
        if (e.button === 0 && !overCard) setFocus(null);
        return;
      }
      const wantPan =
        e.button === 1 || spaceHeld || (e.button === 0 && !overCard);
      if (!wantPan) return;
      if (e.button === 0 && !overCard && !spaceHeld) {
        setFocus(null);
      }
      startPan(e);
      e.stopPropagation();
    },
    true
  );

  // Capture for board pan/zoom. Focused card scrolls vertically only while
  // content can move; otherwise (and for horizontal) the board pans.
  viewport.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        if (viewLocked) return;
        const dy = wheelDeltaY(e);
        // Trackpad pinch sends tiny deltas; mouse notches are ~100.
        const intensity = Math.abs(dy) < 12 ? 0.014 : 0.0032;
        zoomAt(camera.zoom * Math.exp(-dy * intensity), e.clientX, e.clientY);
        return;
      }
      const target = e.target;
      if (target instanceof Element && focus) {
        const cardEl = cardEls.get(focus.cardId);
        const scrollSurface =
          cardEl?.contains(target) ? cardScrollSurface(target) : null;
        if (scrollSurface) {
          const dx = e.deltaX;
          const dy = wheelDeltaY(e);
          // Shift+wheel or sideways-dominant trackpad → pan board left/right.
          if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
            e.preventDefault();
            e.stopPropagation();
            if (viewLocked) return;
            camera.x -= e.shiftKey ? dy : dx;
            applyCamera(true);
            return;
          }
          if (canScrollVertically(scrollSurface, dy)) {
            return;
          }
          // No more vertical room — fall through to board pan.
        }
      }

      e.preventDefault();
      e.stopPropagation();
      if (viewLocked) return;
      camera.x -= e.deltaX;
      camera.y -= wheelDeltaY(e);
      applyCamera(true);
    },
    { passive: false, capture: true }
  );

  window.addEventListener("keydown", (e) => {
    if (!root.isConnected || root.closest(".hidden")) return;

    // ⌥⌘←↑→↓ (Ctrl+Alt on Windows): focus nearest card in that direction
    // Layout shortcuts ⌥⌘A / ⌥⌘S are registered on the app View menu so they
    // still work while a terminal has focus.
    if (e.altKey && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
      const dirs = {
        ArrowLeft: "left",
        ArrowRight: "right",
        ArrowUp: "up",
        ArrowDown: "down",
      } as const;
      const dir = dirs[e.key as keyof typeof dirs];
      if (dir) {
        if (focusNeighbor(dir)) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      // ⌥⌘B broadcast is owned by the View menu (same as arrange/tile), so
      // do not toggle here — that double-fires with the accelerator.
    }

    if (
      broadcastActive &&
      e.key === "Escape" &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !isTypingTarget(e.target)
    ) {
      e.preventDefault();
      handlers.onToggleBroadcast();
      return;
    }

    if (isTypingTarget(e.target)) return;

    if (e.code === "Space" && !e.repeat) {
      if (viewLocked) return;
      spaceHeld = true;
      viewport.classList.add("is-space");
      e.preventDefault();
      return;
    }

    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === "0") {
      if (!viewLocked) resetZoom();
      e.preventDefault();
      return;
    }
    if (mod && e.key === "1") {
      if (!viewLocked) fitAll();
      e.preventDefault();
      return;
    }
    if (e.key === "=" || e.key === "+") {
      if (!viewLocked) zoomByFactor(ZOOM_BTN_STEP);
      e.preventDefault();
      return;
    }
    if (e.key === "-" || e.key === "_") {
      if (!viewLocked) zoomByFactor(1 / ZOOM_BTN_STEP);
      e.preventDefault();
      return;
    }
    if (e.key === "0" && !mod) {
      if (!viewLocked) resetZoom();
      e.preventDefault();
      return;
    }
    if (e.key === "1" && !mod) {
      if (!viewLocked) fitAll();
      e.preventDefault();
    }
  });

  window.addEventListener("keyup", (e) => {
    if (e.code !== "Space") return;
    spaceHeld = false;
    viewport.classList.remove("is-space");
  });

  // Minimap: click / drag to move camera; drag view rect feels like Figma
  let mapDragging = false;
  minimapBody.addEventListener("pointerdown", (e) => {
    if (mapCollapsed || viewLocked) return;
    mapDragging = true;
    minimap.classList.add("is-dragging");
    const world = clientToWorldOnMap(e.clientX, e.clientY);
    centerCameraOnWorld(world.x, world.y);
    const onMove = (ev: PointerEvent) => {
      if (!mapDragging || viewLocked) return;
      const next = clientToWorldOnMap(ev.clientX, ev.clientY);
      centerCameraOnWorld(next.x, next.y);
    };
    const onUp = () => {
      mapDragging = false;
      minimap.classList.remove("is-dragging");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    e.preventDefault();
    e.stopPropagation();
  });

  minimapBody.addEventListener("dblclick", (e) => {
    if (!viewLocked) fitAll();
    e.preventDefault();
  });

  root.querySelector("#btn-board-arrange")!.addEventListener("click", () => {
    arrangeCards();
  });
  root.querySelector("#btn-board-tile-fill")!.addEventListener("click", () => {
    tileOpenTerminals();
  });
  root.querySelector("#btn-board-tile-fit")!.addEventListener("click", () => {
    fitOpenTerminals();
  });
  lockBtn.addEventListener("click", () => {
    setViewLocked(!viewLocked);
  });
  broadcastBtn.addEventListener("click", () => {
    handlers.onToggleBroadcast();
  });
  root.querySelector("#btn-board-zoom-in")!.addEventListener("click", () => {
    zoomByFactor(ZOOM_BTN_STEP);
  });
  root.querySelector("#btn-board-zoom-out")!.addEventListener("click", () => {
    zoomByFactor(1 / ZOOM_BTN_STEP);
  });
  zoomLabel.addEventListener("click", () => {
    resetZoom();
  });
  mapToggleBtn.addEventListener("click", () => {
    mapCollapsed = !mapCollapsed;
    minimap.classList.toggle("is-collapsed", mapCollapsed);
    mapToggleBtn.innerHTML = mapCollapsed
      ? icons.chevronUp(12)
      : icons.chevronDown(12);
    if (!mapCollapsed) {
      minimapDirty = true;
      updateMinimap();
    }
  });

  const resizeObserver = new ResizeObserver(() => {
    minimapDirty = true;
    applyCamera();
  });
  resizeObserver.observe(viewport);
  resizeObserver.observe(minimapBody);

  const api: BoardPane = {
    root,
    surface,
    getCards: () => cards,
    getFocus: () => focus,
    setFocus,
    upsertTerminal({ tabId, title, activate = true }) {
      let card = cards.find(
        (c): c is TerminalCard => c.kind === "terminal" && c.tabId === tabId
      );
      if (!card) {
        const origin = cascadeOrigin();
        card = {
          id: uid("term"),
          kind: "terminal",
          tabId,
          title,
          minimized: false,
          x: origin.x,
          y: origin.y,
          w: TERM_W,
          h: TERM_H,
          z: nextZ(),
        };
        cards = [...cards, card];
        mountCard(card);
      } else {
        card.title = title;
        const el = cardEls.get(card.id);
        const titleEl = el?.querySelector(".board-card-title");
        if (titleEl) titleEl.textContent = title;
        markMinimapDirty();
      }
      if (activate) {
        // Keep other terminals open — exclusive minimize buried chips under the
        // new card and made the previous session impossible to restore.
        card.minimized = false;
        card.z = nextZ();
        layoutCard(card);
        setFocus({ kind: "terminal", cardId: card.id, tabId });
      }
      syncEmpty();
      markMinimapDirty();
      schedulePersist();
      return card;
    },
    getTerminalHost(tabId) {
      const card = cards.find(
        (c): c is TerminalCard => c.kind === "terminal" && c.tabId === tabId
      );
      if (!card) return null;
      const el = cardEls.get(card.id);
      return (
        (el?.querySelector("[data-term-host]") as HTMLElement | null) ?? null
      );
    },
    minimizeOtherTerminals(exceptTabId) {
      for (const c of cards) {
        if (c.kind === "terminal" && c.tabId !== exceptTabId) {
          if (!c.minimized) {
            snow.dump(c.id);
            leaves.dump(c.id);
            sakura.dump(c.id);
            rain.dump(c.id);
            fireflies.dump(c.id);
          }
          c.minimized = true;
          layoutCard(c);
        }
      }
      markMinimapDirty();
      schedulePersist();
    },
    expandTerminal(tabId) {
      const card = cards.find(
        (c): c is TerminalCard => c.kind === "terminal" && c.tabId === tabId
      );
      if (!card) return;
      card.minimized = false;
      bringToFront(card.id);
      layoutCard(card);
      setFocus({ kind: "terminal", cardId: card.id, tabId });
      markMinimapDirty();
      schedulePersist();
    },
    removeTab(tabId) {
      const removeIds = cards
        .filter((c) => c.tabId === tabId)
        .map((c) => c.id);
      for (const id of removeIds) {
        snow.dump(id);
        leaves.dump(id);
        sakura.dump(id);
        rain.dump(id);
        fireflies.dump(id);
      }
      cards = cards.filter((c) => c.tabId !== tabId);
      for (const id of removeIds) removeCardEl(id);
      // Closing the focused terminal clears selection — do not auto-pick
      // another card (that would keep the Files "This computer" pane open).
      if (focus && focus.tabId === tabId) {
        setFocus(null);
      }
      syncEmpty();
      markMinimapDirty();
      schedulePersist();
    },
    addPrompt(tabId, title, opts) {
      const parentId = opts?.parentId;
      const parent =
        parentId &&
        cards.find(
          (c): c is PromptCard => c.kind === "prompt" && c.id === parentId
        );
      const siblings = parentId
        ? cards.filter(
            (c): c is PromptCard =>
              c.kind === "prompt" && c.parentId === parentId
          )
        : [];
      const origin = cascadeOrigin();
      let x = origin.x + 40;
      let y = origin.y + 40;
      let w = PROMPT_W;
      let h = PROMPT_H;
      if (parent) {
        w = SUB_PROMPT_W;
        h = SUB_PROMPT_H;
        x = parent.x + parent.w + 56;
        y =
          parent.y +
          siblings.reduce((sum, s) => sum + s.h + 40, 0);
      }
      const card: PromptCard = {
        id: uid("prompt"),
        kind: "prompt",
        tabId,
        title:
          title ||
          (parentId ? t("board.subPrompt") : t("board.prompt")),
        parentId,
        runStatus: "idle",
        x,
        y,
        w,
        h,
        z: nextZ(),
      };
      clampCardInWorld(card);
      cards = [...cards, card];
      mountCard(card);
      syncPromptStatusBadge(card);
      setFocus({ kind: "prompt", cardId: card.id, tabId });
      syncEmpty();
      updateLinks();
      schedulePersist();
      return card;
    },
    setPromptRunStatus(cardId, status) {
      const card = cards.find(
        (c): c is PromptCard => c.kind === "prompt" && c.id === cardId
      );
      if (!card) return;
      card.runStatus = status;
      syncPromptStatusBadge(card);
      markMinimapDirty();
    },
    countPromptChildren(parentId) {
      return cards.filter(
        (c) => c.kind === "prompt" && c.parentId === parentId
      ).length;
    },
    getPromptEls(cardId) {
      const el = cardEls.get(cardId);
      if (!el) return null;
      return {
        thread: el.querySelector("[data-prompt-thread]") as HTMLElement,
        input: el.querySelector("[data-prompt-input]") as HTMLDivElement,
        send: el.querySelector("[data-prompt-send]") as HTMLButtonElement,
        context: el.querySelector("[data-prompt-context]") as HTMLElement,
        composer: el.querySelector("[data-prompt-composer]") as HTMLElement,
        attachments: el.querySelector(
          "[data-prompt-attachments]"
        ) as HTMLElement,
        attachBtn: el.querySelector(
          "[data-prompt-attach]"
        ) as HTMLButtonElement,
        fileInput: el.querySelector(
          "[data-prompt-file-input]"
        ) as HTMLInputElement,
      };
    },
    updatePromptContext(cardId, info) {
      const el = cardEls.get(cardId);
      if (!el) return;
      const kind = el.querySelector("[data-prompt-kind]") as HTMLElement | null;
      const path = el.querySelector("[data-prompt-path]") as HTMLElement | null;
      const ctx = el.querySelector(
        "[data-prompt-context]"
      ) as HTMLElement | null;
      if (kind) kind.textContent = info.kind;
      if (path) path.textContent = info.path;
      if (ctx) {
        ctx.title = info.title;
        ctx.classList.toggle("is-empty", !info.path && !info.kind);
      }
      const bind = el.querySelector(".board-card-bind");
      if (bind) bind.textContent = info.kind || info.title;
    },
    setPromptSendBusy(cardId, busy) {
      const els = api.getPromptEls(cardId);
      if (!els) return;
      const ph = els.composer.querySelector(
        ".composer-placeholder"
      ) as HTMLElement | null;
      const phKey = busy ? "chat.followUp" : "chat.placeholder";
      const sendKey = busy ? "chat.queue" : "chat.send";
      if (ph) {
        ph.setAttribute("data-i18n", phKey);
        ph.textContent = t(phKey);
      }
      els.input.setAttribute("aria-label", t(phKey));
      els.send.innerHTML = icons.send(16);
      els.send.classList.remove("is-stop");
      els.send.title = t(sendKey);
      els.send.setAttribute("aria-label", t(sendKey));
      els.composer.classList.toggle("is-follow-up", busy);
    },
    applyPersisted(state, liveTabIds) {
      // Keep live terminal cards (openLocal may already have mounted them).
      // Only replace prompt cards from disk — never wipe active terminals.
      const keptTerminals = cards.filter(
        (c): c is TerminalCard =>
          c.kind === "terminal" && liveTabIds.has(c.tabId)
      );
      for (const [id, el] of [...cardEls]) {
        const existing = cards.find((c) => c.id === id);
        if (existing?.kind === "terminal" && liveTabIds.has(existing.tabId)) {
          continue;
        }
        el.remove();
        cardEls.delete(id);
      }
      cards = [...keptTerminals];
      zCounter = Math.max(1, ...keptTerminals.map((c) => c.z), 1);

      for (const raw of state.cards) {
        if (raw.kind !== "prompt") continue;
        if (!liveTabIds.has(raw.tabId)) continue;
        const card: PromptCard = {
          ...raw,
          kind: "prompt",
          parentId: raw.parentId,
          runStatus: raw.runStatus || "idle",
          z: nextZ(),
        };
        cards.push(card);
      }
      // Drop parentId when parent was not restored.
      const ids = new Set(cards.map((c) => c.id));
      for (const card of cards) {
        if (card.kind !== "prompt" || !card.parentId) continue;
        if (!ids.has(card.parentId)) delete card.parentId;
      }
      for (const card of cards) {
        if (card.kind !== "prompt") continue;
        mountCard(card);
        syncPromptStatusBadge(card);
      }
      if (state.camera) {
        camera = {
          x: state.camera.x ?? 0,
          y: state.camera.y ?? 0,
          zoom: clampZoom(state.camera.zoom ?? 1),
        };
      }
      applyCamera();
      // Saved camera can leave the new terminal off-screen — bring focus into view.
      const focused =
        (focus && cards.find((c) => c.id === focus!.cardId)) ||
        keptTerminals[0];
      if (focused) {
        ensureCardVisible(focused);
        if (!focus || focus.cardId !== focused.id) {
          if (focused.kind === "terminal") {
            setFocus({
              kind: "terminal",
              cardId: focused.id,
              tabId: focused.tabId,
            });
          }
        } else {
          markMinimapDirty();
          updateMinimap();
        }
      } else {
        setFocus(null);
      }
      syncEmpty();
      updateLinks();
      markMinimapDirty();
      updateMinimap();
    },
    toPersisted() {
      return {
        cards: cards.map((c) => ({ ...c })),
        camera: { ...camera },
      };
    },
    refreshTitles(tabId, title) {
      for (const c of cards) {
        if (c.kind === "terminal" && c.tabId === tabId) {
          c.title = title;
          const el = cardEls.get(c.id);
          const titleEl = el?.querySelector(".board-card-title");
          if (titleEl) titleEl.textContent = title;
        }
        if (c.kind === "prompt" && c.tabId === tabId) {
          const el = cardEls.get(c.id);
          const bind = el?.querySelector(".board-card-bind");
          if (bind) bind.textContent = title;
        }
      }
      markMinimapDirty();
    },
    syncEmpty,
    bringToFront,
    setMinimized(cardId, minimized) {
      const card = cards.find((c) => c.id === cardId);
      if (!card || card.kind !== "terminal") return;
      if (minimized && !card.minimized) {
        snow.dump(cardId);
        leaves.dump(cardId);
        sakura.dump(cardId);
        rain.dump(cardId);
        fireflies.dump(cardId);
      }
      card.minimized = minimized;
      layoutCard(card);
      markMinimapDirty();
      schedulePersist();
    },
    findCard(cardId) {
      return cards.find((c) => c.id === cardId);
    },
    setChristmasTheme(enabled) {
      if (enabled) disableSeasonalExcept("snow");
      snow.setEnabled(enabled);
    },
    setChristmasSnowOptions(opts) {
      snow.setOptions(opts);
    },
    clearChristmasSnow() {
      snow.clearAll();
    },
    setAutumnTheme(enabled) {
      if (enabled) disableSeasonalExcept("leaves");
      leaves.setEnabled(enabled);
    },
    setAutumnLeafOptions(opts) {
      leaves.setOptions(opts);
    },
    clearAutumnLeaves() {
      leaves.clearAll();
    },
    setSakuraTheme(enabled) {
      if (enabled) disableSeasonalExcept("sakura");
      sakura.setEnabled(enabled);
    },
    setSakuraPetalOptions(opts) {
      sakura.setOptions(opts);
    },
    clearSakuraPetals() {
      sakura.clearAll();
    },
    setRainTheme(enabled) {
      if (enabled) disableSeasonalExcept("rain");
      rain.setEnabled(enabled);
    },
    setRainOptions(opts) {
      rain.setOptions(opts);
    },
    clearRain() {
      rain.clearAll();
    },
    setFirefliesTheme(enabled) {
      if (enabled) disableSeasonalExcept("fireflies");
      fireflies.setEnabled(enabled);
    },
    setFirefliesOptions(opts) {
      fireflies.setOptions(opts);
    },
    clearFireflies() {
      fireflies.clearAll();
    },
    arrangeCards() {
      arrangeCards();
    },
    tileOpenTerminals() {
      tileOpenTerminals();
    },
    fitOpenTerminals() {
      fitOpenTerminals();
    },
    syncBroadcastUi,
    removeCard(cardId) {
      const removeIds = [
        cardId,
        ...cards
          .filter((c) => c.kind === "prompt" && c.parentId === cardId)
          .map((c) => c.id),
      ];
      if (!cards.some((c) => c.id === cardId)) return;
      for (const id of removeIds) {
        snow.dump(id);
        leaves.dump(id);
        sakura.dump(id);
        rain.dump(id);
        fireflies.dump(id);
      }
      cards = cards.filter((c) => !removeIds.includes(c.id));
      for (const id of removeIds) removeCardEl(id);
      if (focus && removeIds.includes(focus.cardId)) {
        const next = cards[0];
        setFocus(
          next
            ? { kind: next.kind, cardId: next.id, tabId: next.tabId }
            : null
        );
      }
      syncEmpty();
      syncAddPromptEnabled();
      updateLinks();
      schedulePersist();
    },
  };

  syncEmpty();
  syncAddPromptEnabled();
  syncViewLockUi();
  applyCamera();
  return api;
}
