/**
 * Christmas board snow — SnowDesk-aligned (from local REA of SnowDesk.app):
 *
 * Interaction (Localizable.strings / SnowController):
 * - Move mouse → carve/sweep piled snow
 * - ⌥ + move → gather / roll snowball (pushSnowballs then sweep)
 * - Cursor rolls balls ahead on the pile (with rotation), not a velocity shove
 * - Bump two snowballs → snowman; drag snowman
 * - Overlapping terminals: isHidden occlusion (back roof snow clipped by front cards)
 *
 * Pile look (SnowRenderer Metal + Pile):
 * - Column height field, column width ≈ 3
 * - add(amount, column) clamped by maxHeights
 * - relax(): avalanche when |h[i]-h[i+1]| > 1.3
 * - Mesh of white triangles (PileVertex position+color), not a soft gradient cap
 * - Flakes are soft point sprites (smoothstep disc)
 */

export type SnowRoof = {
  id: string;
  y: number;
  x: number;
  w: number;
  h: number;
  /** Higher = in front (matches board card z). */
  z: number;
};

export type SnowCamera = {
  x: number;
  y: number;
  zoom: number;
};

export type BoardSnowWorld = {
  x: number;
  y: number;
  w: number;
  h: number;
};

type Flake = {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  kind: "fall" | "ground";
  alpha: number;
  wobble: number;
  phase: number;
};

type Snowball = {
  id: string;
  x: number;
  y: number;
  r: number;
  /** Scooped pile mass (SnowDesk roll grows radius from this). */
  mass: number;
  /** Radians — SnowDesk roll: rotation += dx / radius. */
  rotation: number;
  vx: number;
  vy: number;
  roofId: string | null;
};

type SnowmanEntity = {
  id: string;
  x: number;
  y: number;
  scale: number;
  vx: number;
  vy: number;
  roofId: string | null;
};

/** SnowDesk Pile: discrete columns + repose avalanche. */
type Pile = {
  roofId: string;
  /** Column heights (world px-ish). */
  heights: Float32Array;
  /** Per-column cap (from SurfaceSpec-style init). */
  maxHeights: Float32Array;
  dirty: boolean;
};

export type BoardSnowOptions = {
  /** 0–1 snowfall density. */
  amount: number;
  /** 0–1 fall speed. */
  speed: number;
  /** Denser flakes / higher caps (more CPU). */
  smooth: boolean;
};

export type BoardSnow = {
  setEnabled: (on: boolean) => void;
  setOptions: (next: Partial<BoardSnowOptions>) => void;
  clearAll: () => void;
  isEnabled: () => boolean;
  shake: (roofId: string, impulseX: number) => void;
  dump: (roofId: string) => void;
  destroy: () => void;
};

// --- SnowDesk-derived constants (from Pile.add / Pile.relax / init) ---
const COL_W = 3; // ceil(width / 3) columns
const REPOSE = 1.3; // max adjacent height delta before avalanche
const RELAX_K = 0.25; // fraction of excess transferred
const RELAX_EPS = 0.001;
const MAX_FALL_BASE = 220;
const GROUND_Y_PAD = 18;
/**
 * SnowDesk VisibleWindows.surfaces desk SurfaceSpec (id -1, isFloor).
 * Board-world floor is the same kind of pile — not loose flakes.
 */
const GROUND_ID = "__board_ground__";
/** SnowDesk desk SurfaceSpec capacity field (0x42200000). */
const GROUND_MAX_H = 40;
/**
 * SnowDesk uses AppKit-ish Y-up with a fixed -50 carve bias toward the ledge.
 * Drift is Y-down: roofs keep a small lift; desk reaches toward the pile top
 * only when the cursor is above it (so on-snow cursor still carves).
 */
const CARVE_Y_BIAS_ROOF = -8;
/** Max downward reach (px) when the cursor is above the desk pile. */
const CARVE_Y_REACH_DESK = 56;
const BALL_MIN_R = 7;
const BALL_MAX_R = 38;
const MAX_BALLS = 14;
const MAX_MEN = 10;
const SWEEP_R = 22;
const GATHER_R = 26;
/** SnowDesk fall gravity (~900). */
const BALL_GRAVITY = 900;
/** SnowDesk fall: impact vy ≥ 700 → shatter on landing (not mid-air). */
const BALL_SHATTER_VY = 700;
/** SnowDesk sweep: spawn after enough gather travel + mass, mostly-horizontal. */
const GATHER_SPAWN_TRAVEL = 120;
const GATHER_SPAWN_MASS = 6;
/** SnowDesk pushSnowballs: roll target sits ahead of cursor by 0.75·r. */
const PUSH_AHEAD = 0.75;
/** SnowDesk pushSnowballs speed gate (~1350 px/s). */
const PUSH_MAX_SPEED = 1350;
/** Idle Option gap that clears gatherTravel / gathered (SnowDesk ~1s). */
const GATHER_IDLE_RESET = 1;

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function loadImage(src: string): HTMLImageElement {
  const img = new Image();
  img.decoding = "async";
  img.src = src;
  return img;
}

function columnCount(width: number): number {
  return Math.max(2, Math.ceil(width / COL_W));
}

/**
 * SnowDesk Pile.init maxHeights:
 * (0.8 + seed*0.14 + 0.06*sin) * surfaceHeight * sqrt(edgeTaper)
 * plus a circular mound term from SurfaceSpec radius.
 */
function buildMaxHeights(n: number, width: number, seed: number): Float32Array {
  const maxH = new Float32Array(n);
  const seedF = seed % 97;
  const surfaceH = 46 + (seed % 10); // thick ledge (SnowDesk SurfaceSpec height)
  const taperDiv = 22;
  const radius = Math.min(width * 0.52, 140 + (seed % 36));
  const cx = width * 0.5;
  for (let i = 0; i < n; i++) {
    const x = Math.min(width, i * COL_W + COL_W * 0.5);
    const edge = Math.min(x, width - x);
    const taper = Math.min(1, edge / taperDiv);
    // Mild variation — seed term kept small in our pixel space
    const wavy =
      0.86 +
      (seedF / 97) * 0.12 +
      0.06 * Math.sin(x * 0.031 + seedF) +
      0.05 * Math.sin(x * 0.083 + seedF * 1.7);
    const domeDx = x - cx;
    let circle = 0.9;
    if (Math.abs(domeDx) < radius) {
      const rise =
        radius - Math.sqrt(Math.max(0, radius * radius - domeDx * domeDx));
      circle = 0.78 + (rise / Math.max(1, radius)) * 0.5;
    }
    maxH[i] =
      surfaceH * Math.sqrt(Math.max(0.1, taper)) * wavy * circle;
  }
  return maxH;
}

function ballRadiusFromMass(mass: number): number {
  return Math.min(BALL_MAX_R, Math.max(BALL_MIN_R, Math.sqrt(Math.max(0, mass)) * 1.05));
}

/** Seat the ball fully on top of the pile / ledge (not sunk into the card). */
function seatBallY(roofY: number, pileH: number, r: number): number {
  return roofY - pileH - r;
}

function createPile(roof: SnowRoof): Pile {
  const n = columnCount(roof.w);
  const seed = Math.abs(
    Math.floor(roof.x * 12.9898 + roof.y * 78.233)
  );
  return {
    roofId: roof.id,
    heights: new Float32Array(n),
    maxHeights: buildMaxHeights(n, roof.w, seed),
    dirty: false,
  };
}

/** SnowDesk Pile.add(_:at:) — returns whether height increased. */
function pileAdd(pile: Pile, amount: number, col: number): boolean {
  if (col < 0 || col >= pile.heights.length) return false;
  const cap = pile.maxHeights[col]!;
  const prev = pile.heights[col]!;
  const next = Math.min(cap, prev + amount);
  if (next <= prev) return false;
  pile.heights[col] = next;
  pile.dirty = true;
  return true;
}

/** SnowDesk Pile.relax() — avalanche across steep neighbors. */
function pileRelax(pile: Pile): boolean {
  if (!pile.dirty) return false;
  const h = pile.heights;
  const caps = pile.maxHeights;
  const n = h.length;
  if (n < 2) {
    pile.dirty = false;
    return false;
  }
  let changed = false;
  for (let i = 0; i < n - 1; i++) {
    const a = h[i]!;
    const b = h[i + 1]!;
    const diff = Math.abs(a - b);
    if (diff <= REPOSE) continue;
    const high = a > b ? i : i + 1;
    const low = a > b ? i + 1 : i;
    let move = (diff - REPOSE) * RELAX_K;
    const room = caps[low]! - h[low]!;
    if (room < move) move = room;
    if (move <= RELAX_EPS) continue;
    h[high]! -= move;
    h[low]! += move;
    changed = true;
  }
  pile.dirty = changed;
  return changed;
}

function pileTotal(pile: Pile): number {
  let s = 0;
  for (let i = 0; i < pile.heights.length; i++) s += pile.heights[i]!;
  return s;
}

function pileColAt(pile: Pile, along: number): number {
  const n = pile.heights.length;
  return Math.min(n - 1, Math.max(0, Math.floor(along / COL_W)));
}

function pileHeightAt(pile: Pile, along: number): number {
  const n = pile.heights.length;
  if (n < 1) return 0;
  const x = along / COL_W;
  const i = Math.min(n - 2, Math.max(0, Math.floor(x)));
  if (n === 1) return pile.heights[0]!;
  const f = Math.min(1, Math.max(0, x - i));
  return pile.heights[i]! * (1 - f) + pile.heights[i + 1]! * f;
}

export function createBoardSnow(opts: {
  viewport: HTMLElement;
  world: BoardSnowWorld;
  getCamera: () => SnowCamera;
  getRoofs: () => SnowRoof[];
}): BoardSnow {
  const back = document.createElement("canvas");
  back.className = "board-snow-canvas board-snow-back";
  back.setAttribute("aria-hidden", "true");
  const front = document.createElement("canvas");
  front.className = "board-snow-canvas board-snow-front";
  front.setAttribute("aria-hidden", "true");
  opts.viewport.appendChild(back);
  opts.viewport.appendChild(front);
  const backCtx = back.getContext("2d");
  const frontCtx = front.getContext("2d");

  const ballImg = loadImage("/christmas/snowball.png");
  const manImg = loadImage("/christmas/snowman.png");

  let enabled = false;
  let raf = 0;
  let lastT = 0;
  let spawnAcc = 0;
  const flakes: Flake[] = [];
  const balls: Snowball[] = [];
  const men: SnowmanEntity[] = [];
  const piles = new Map<string, Pile>();
  let dpr = 1;
  let altHeld = false;
  let lastMouse: { x: number; y: number } | null = null;
  let gatherTravel = 0;
  let gatherMass = 0;
  let lastGatherTime = 0;
  let lastPointerT = 0;
  let dragMan: { id: string; ox: number; oy: number } | null = null;
  let snowOpts: BoardSnowOptions = {
    amount: 0.55,
    speed: 0.5,
    smooth: false,
  };

  function clamp01(n: number): number {
    return Math.min(1, Math.max(0, n));
  }

  function maxFallCap(): number {
    const base = snowOpts.smooth ? 320 : MAX_FALL_BASE;
    return Math.max(40, Math.floor(base * (0.35 + snowOpts.amount * 0.9)));
  }

  function spawnInterval(): number {
    // Sparse → dense (SnowDesk amount slider)
    return 0.22 - snowOpts.amount * 0.175;
  }

  function speedMul(): number {
    return 0.45 + snowOpts.speed * 1.15;
  }

  function resizeCanvas(canvas: HTMLCanvasElement): void {
    const rect = opts.viewport.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
  }

  function resize(): void {
    resizeCanvas(back);
    resizeCanvas(front);
  }

  /** Board-world floor (fixed), not the viewport bottom. */
  function groundY(): number {
    return opts.world.y + opts.world.h - GROUND_Y_PAD;
  }

  function groundRoof(): SnowRoof {
    return {
      id: GROUND_ID,
      x: opts.world.x,
      y: groundY(),
      w: opts.world.w,
      h: 64,
      z: -100,
    };
  }

  function roofMap(): Map<string, SnowRoof> {
    const m = new Map<string, SnowRoof>();
    for (const r of opts.getRoofs()) m.set(r.id, r);
    return m;
  }

  /** Board floor first, then terminals — later carve hits win `hitRoof`. */
  function allSnowRoofs(): SnowRoof[] {
    return [groundRoof(), ...opts.getRoofs()];
  }

  /** SnowDesk desk pile: capacity 40, soft edge taper, no window corner mound. */
  function createGroundPile(): Pile {
    const roof = groundRoof();
    const n = columnCount(roof.w);
    const maxHeights = new Float32Array(n);
    const taperDiv = 22; // SnowDesk Pile.init edge taper when cornerRadius == 0
    for (let i = 0; i < n; i++) {
      const x = Math.min(roof.w, i * COL_W + COL_W * 0.5);
      const edge = Math.min(x, roof.w - x);
      const taper = Math.min(1, edge / taperDiv);
      const wavy = 0.86 + 0.08 * Math.sin(i * 0.07) + 0.05 * Math.sin(i * 0.19);
      maxHeights[i] =
        GROUND_MAX_H * Math.sqrt(Math.max(0.12, taper)) * wavy;
    }
    return {
      roofId: GROUND_ID,
      heights: new Float32Array(n),
      maxHeights,
      dirty: false,
    };
  }

  function roofById(id: string | null | undefined): SnowRoof | null {
    if (!id) return null;
    if (id === GROUND_ID) return groundRoof();
    return opts.getRoofs().find((r) => r.id === id) ?? null;
  }

  function ensurePile(roof: SnowRoof): Pile {
    let p = piles.get(roof.id);
    const n = columnCount(roof.w);
    if (!p || p.heights.length !== n) {
      const next =
        roof.id === GROUND_ID ? createGroundPile() : createPile(roof);
      if (p) {
        // Preserve mass roughly when resizing
        const scale = n / Math.max(1, p.heights.length);
        for (let i = 0; i < n; i++) {
          const src = Math.min(
            p.heights.length - 1,
            Math.floor(i / Math.max(scale, 0.001))
          );
          next.heights[i] = Math.min(
            next.maxHeights[i]!,
            p.heights[src]!
          );
        }
        next.dirty = true;
      }
      piles.set(roof.id, next);
      p = next;
    }
    return p;
  }

  function ensureGroundPile(): Pile {
    return ensurePile(groundRoof());
  }

  function syncPiles(roofs: Map<string, SnowRoof>): void {
    for (const id of [...piles.keys()]) {
      if (id !== GROUND_ID && !roofs.has(id)) piles.delete(id);
    }
    for (const roof of roofs.values()) ensurePile(roof);
    ensureGroundPile();
  }

  function clientToWorld(clientX: number, clientY: number): {
    x: number;
    y: number;
  } {
    const rect = opts.viewport.getBoundingClientRect();
    const cam = opts.getCamera();
    return {
      x: (clientX - rect.left - cam.x) / cam.zoom,
      y: (clientY - rect.top - cam.y) / cam.zoom,
    };
  }

  /**
   * SnowDesk isHidden(_:_:behind:) — point covered by a front-er terminal
   * than `behindZ` should not receive carve / push / visible snow.
   */
  function isHidden(wx: number, wy: number, behindZ: number): boolean {
    for (const roof of opts.getRoofs()) {
      if (roof.z <= behindZ) continue;
      if (
        wx >= roof.x &&
        wx <= roof.x + roof.w &&
        wy >= roof.y &&
        wy <= roof.y + roof.h
      ) {
        return true;
      }
    }
    return false;
  }

  /** Roof ledge under a front terminal — no land / relax / draw there. */
  function isLedgeHidden(roof: SnowRoof, worldX: number): boolean {
    return isHidden(worldX, roof.y + 1, roof.z);
  }

  function isPileColHidden(roof: SnowRoof, col: number): boolean {
    const colX = roof.x + col * COL_W + COL_W * 0.5;
    return isLedgeHidden(roof, colX);
  }

  /**
   * Drop snow that flowed under a front card (pileRelax / neighbor land).
   * Must run after every relax so occluded columns stay empty.
   */
  function clearOccludedPileColumns(roof: SnowRoof, pile: Pile): boolean {
    let cleared = false;
    for (let c = 0; c < pile.heights.length; c++) {
      if (!isPileColHidden(roof, c)) continue;
      if (pile.heights[c]! <= 0) continue;
      pile.heights[c] = 0;
      cleared = true;
    }
    if (cleared) pile.dirty = true;
    return cleared;
  }

  function roofsFrontToBack(): SnowRoof[] {
    return [...opts.getRoofs()].sort((a, b) => a.z - b.z);
  }

  /** Clip so snow on a back roof cannot paint through a front terminal. */
  function clipAgainstFrontRoofs(
    ctx: CanvasRenderingContext2D,
    roof: SnowRoof,
    cam: SnowCamera,
    cssW: number,
    cssH: number
  ): void {
    ctx.beginPath();
    ctx.rect(0, 0, cssW, cssH);
    const z = cam.zoom;
    for (const other of opts.getRoofs()) {
      if (other.z <= roof.z) continue;
      ctx.rect(
        cam.x + other.x * z,
        cam.y + other.y * z,
        other.w * z,
        other.h * z
      );
    }
    ctx.clip("evenodd");
  }

  function spawnFall(count: number): void {
    const cam = opts.getCamera();
    const vw = opts.viewport.clientWidth || 1;
    const viewLeft = -cam.x / cam.zoom;
    const viewTop = -cam.y / cam.zoom;
    const viewW = vw / cam.zoom;
    const cap = maxFallCap();
    const sm = speedMul();
    let falling = 0;
    for (const f of flakes) if (f.kind === "fall") falling += 1;
    for (let i = 0; i < count; i++) {
      if (falling >= cap) break;
      falling += 1;
      const r = snowOpts.smooth
        ? 0.45 + Math.random() * 1.35
        : 0.7 + Math.random() * 1.6;
      flakes.push({
        x: viewLeft + Math.random() * viewW * 1.1 - viewW * 0.05,
        y: viewTop - 12 - Math.random() * 36,
        r,
        vx: (Math.random() - 0.5) * 12 * sm,
        vy: (20 + Math.random() * 34) * sm,
        kind: "fall",
        alpha: 0.55 + Math.random() * 0.4,
        wobble: 5 + Math.random() * 12,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  function landOnRoof(f: Flake, roof: SnowRoof): void {
    const pile = ensurePile(roof);
    const along = Math.max(0, Math.min(roof.w - 0.1, f.x - roof.x));
    const col = pileColAt(pile, along);
    const amount = 0.85 + f.r * 0.7;
    const tryAdd = (c: number, frac: number): boolean => {
      if (c < 0 || c >= pile.heights.length) return false;
      if (isPileColHidden(roof, c)) return false;
      return pileAdd(pile, amount * frac, c);
    };
    // SnowDesk land → Pile.add: center 0.5, neighbors 0.25 each.
    let added = tryAdd(col, 0.5);
    added = tryAdd(col - 1, 0.25) || added;
    added = tryAdd(col + 1, 0.25) || added;
    if (!added) {
      f.y = roof.y + 2;
      f.vy = 30 + Math.random() * 20;
      f.vx = (Math.random() - 0.5) * 30;
      return;
    }
    const idx = flakes.indexOf(f);
    if (idx >= 0) flakes.splice(idx, 1);
    for (let k = 0; k < 6; k++) {
      if (!pileRelax(pile)) break;
    }
    clearOccludedPileColumns(roof, pile);
  }

  /** SnowDesk: desk is just another SurfaceSpec — same land path as windows. */
  function landOnGround(f: Flake): void {
    landOnRoof(f, groundRoof());
  }

  /**
   * SnowDesk carve(at:radius:velocity:isGathering:) —
   * circular bite into the pile profile (not a wide rectangular wipe).
   * Gathering still sprays a few flakes; most mass goes into `gathered`.
   */
  function carveAt(
    wx: number,
    wy: number,
    moveX: number,
    moveY: number,
    gathering: boolean,
    radius = SWEEP_R
  ): {
    gained: number;
    roof: SnowRoof | null;
    pile: Pile | null;
    ground: boolean;
  } {
    let gained = 0;
    let hitRoof: SnowRoof | null = null;
    let hitPile: Pile | null = null;
    let hitGround = false;
    const r2 = radius * radius;
    // SnowDesk: fminnm(0.4 * vel.y, 0); then bias toward the ledge.
    const velBias = Math.min(0, 0.4 * moveY);
    for (const roof of allSnowRoofs()) {
      if (wx < roof.x - radius || wx > roof.x + roof.w + radius) continue;
      if (isHidden(wx, wy, roof.z)) continue;
      const pile = ensurePile(roof);
      const center = pileColAt(pile, wx - roof.x);
      const span = Math.ceil(radius / COL_W) + 1;
      // Desk: only reach downward when the cursor is above the local pile top.
      // Fixed +50 forced "hover above snow"; on-snow should carve like roofs.
      let yBias = velBias + CARVE_Y_BIAS_ROOF;
      if (roof.id === GROUND_ID) {
        const surface = roof.y - pileHeightAt(pile, wx - roof.x);
        const above = surface - wy;
        yBias =
          velBias +
          (above > 0
            ? Math.min(CARVE_Y_REACH_DESK, above)
            : CARVE_Y_BIAS_ROOF);
      }
      let local = 0;
      for (let c = center - span; c <= center + span; c++) {
        if (c < 0 || c >= pile.heights.length) continue;
        const h = pile.heights[c]!;
        if (h <= 0.05) continue;
        const colX = roof.x + c * COL_W + COL_W * 0.5;
        const dx = colX - wx;
        const dx2 = dx * dx;
        if (dx2 >= r2) continue;
        const top = roof.y - h;
        // Circle in world space (y grows downward): dig the surface down to biteBot.
        const half = Math.sqrt(r2 - dx2);
        const biteTop = wy + yBias - half;
        const biteBot = wy + yBias + half;
        // Desk: also accept a vertical band near the pile so on-snow strokes hit.
        const deskBand =
          roof.id === GROUND_ID &&
          wy >= top - radius * 1.35 &&
          wy <= roof.y + radius * 0.6;
        if (
          !deskBand &&
          (biteBot < top - 2 || biteTop > roof.y + 4)
        ) {
          continue;
        }
        // Ledge under a front card — don't carve (or refill via relax) there.
        if (isPileColHidden(roof, c)) continue;

        // New surface = bottom of the brush disc, clamped into the column.
        // (Previously used biteTop and residual stayed ≈ h, so take was always 0.)
        const newTop = Math.min(roof.y, Math.max(top, biteBot));
        const residual = Math.max(0, roof.y - newTop);
        const take = h - residual;
        if (take <= 0.05) continue;
        pile.heights[c] = residual;
        pile.dirty = true;
        local += take;

        // Gathering: a few flakes + mass. Sweep: more spray. Never silent-delete.
        const sprayN = gathering
          ? Math.min(2, Math.floor(take * 0.35) + (take > 0.5 ? 1 : 0))
          : Math.min(6, Math.floor(take * 0.45) + 1);
        for (let k = 0; k < sprayN; k++) {
          flakes.push({
            x: colX + (Math.random() - 0.5) * COL_W,
            y: top + 2,
            r: 0.55 + Math.random() * 0.85,
            vx: moveX * 8 + (Math.random() - 0.5) * (gathering ? 16 : 28),
            vy: -10 - Math.random() * (gathering ? 14 : 22) + moveY * 4,
            kind: "fall",
            alpha: 0.7,
            wobble: 7,
            phase: Math.random() * Math.PI * 2,
          });
        }
      }
      if (local > 0) {
        // SnowDesk adds taken * columnWidth into gathered.
        gained += gathering ? local * (COL_W * 0.45) : local;
        hitRoof = roof;
        hitPile = pile;
        if (roof.id === GROUND_ID) hitGround = true;
        for (let k = 0; k < 3; k++) {
          if (!pileRelax(pile)) break;
        }
        clearOccludedPileColumns(roof, pile);
      }
    }
    return { gained, roof: hitRoof, pile: hitPile, ground: hitGround };
  }

  /** Prefer a visible seat near `preferX` on a roof; null if none. */
  function visibleSeatOnRoof(
    roof: SnowRoof,
    pile: Pile,
    preferX: number,
    r: number
  ): number | null {
    const minX = roof.x + r;
    const maxX = roof.x + roof.w - r;
    if (maxX < minX) return null;
    const clampX = Math.max(minX, Math.min(maxX, preferX));
    if (!isLedgeHidden(roof, clampX)) return clampX;
    const span = Math.max(1, Math.ceil((maxX - minX) / COL_W));
    for (let step = 1; step <= span; step++) {
      for (const dir of [-1, 1]) {
        const x = clampX + dir * step * COL_W;
        if (x < minX || x > maxX) continue;
        if (!isLedgeHidden(roof, x)) return x;
      }
    }
    return null;
  }

  /**
   * Tip off a roof edge — keep momentum, don't launch.
   * Place just outside settleBody's hit-box so it can't snap back.
   */
  function dropBallOffRoof(
    ball: Snowball,
    roof: SnowRoof,
    towardX: number,
    dx: number
  ): void {
    const mid = roof.x + roof.w * 0.5;
    const offLeft = towardX < mid || (towardX === mid && dx < 0);
    const dir = offLeft ? -1 : 1;
    ball.x = offLeft ? roof.x - ball.r - 2 : roof.x + roof.w + ball.r + 2;
    // Carry roll speed; add only a small outward nudge.
    const carry = Math.abs(ball.vx) > 8 ? Math.abs(ball.vx) : Math.abs(dx) * 10;
    ball.vx = dir * Math.max(28, Math.min(110, carry * 0.85 + 18));
    ball.vy = Math.max(12, Math.min(45, Math.abs(dx) * 1.5 + 14));
    if (ball.r > 0.5) ball.rotation += dir * 0.35;
    ball.roofId = null;
  }

  /**
   * SnowDesk SnowWorld.shatter — burst into flakes.
   * flakeCount ≈ clamp(floor(radius * 1.6) + 2, 2..40).
   */
  function shatterBall(ball: Snowball): void {
    const n = Math.max(
      2,
      Math.min(40, Math.floor(ball.r * 1.6) + 2)
    );
    const spray = Math.max(40, ball.r * 0.32 * 140);
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 30 + Math.random() * spray * 0.35;
      flakes.push({
        x: ball.x + Math.cos(ang) * ball.r * 0.35 * Math.random(),
        y: ball.y + Math.sin(ang) * ball.r * 0.35 * Math.random(),
        r: 0.7 + Math.random() * 1.3,
        vx: ball.vx * 0.35 + Math.cos(ang) * spd + (Math.random() - 0.5) * 40,
        vy: Math.min(220, ball.vy * 0.25) + Math.sin(ang) * spd * 0.55 + 20 + Math.random() * 50,
        kind: "fall",
        alpha: 0.65 + Math.random() * 0.3,
        wobble: 6 + Math.random() * 10,
        phase: Math.random() * Math.PI * 2,
      });
    }
    const idx = balls.indexOf(ball);
    if (idx >= 0) balls.splice(idx, 1);
  }

  /**
   * SnowDesk SnowWorld.roll — scoop along the path, grow mass/radius,
   * spin: rotation += dx / radius. Past the ledge → detach (fall).
   */
  function rollBall(ball: Snowball, roof: SnowRoof, pile: Pile, toX: number): void {
    const prevX = ball.x;
    const edgePad = Math.max(4, ball.r * 0.4);
    const minX = roof.x + edgePad;
    const maxX = roof.x + roof.w - edgePad;
    const dxIntent = toX - prevX;
    const isDesk = roof.id === GROUND_ID;

    // Pushing past the usable ledge → fall off (SnowDesk windows).
    // Desk SurfaceSpec spans the screen — clamp at the board edge instead.
    if (
      !isDesk &&
      ((toX < minX && dxIntent <= 0) ||
        (toX > maxX && dxIntent >= 0) ||
        toX < roof.x ||
        toX > roof.x + roof.w)
    ) {
      dropBallOffRoof(
        ball,
        roof,
        toX,
        dxIntent || (toX < midOr(roof) ? -1 : 1)
      );
      return;
    }

    const nextX = Math.max(minX, Math.min(maxX, toX));
    const dx = nextX - prevX;
    if (Math.abs(dx) < 0.02) {
      const h0 = pileHeightAt(pile, ball.x - roof.x);
      ball.y = seatBallY(roof.y, h0, ball.r);
      return;
    }
    const pad = ball.r * 0.65;
    const lo = Math.min(prevX, nextX) - pad;
    const hi = Math.max(prevX, nextX) + pad;
    const c0 = pileColAt(pile, lo - roof.x);
    const c1 = pileColAt(pile, hi - roof.x);
    let scooped = 0;
    for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++) {
      if (c < 0 || c >= pile.heights.length) continue;
      if (pile.maxHeights[c]! <= 0) continue;
      if (isPileColHidden(roof, c)) continue;
      const h = pile.heights[c]!;
      if (h <= 0.08) continue;
      const colX = roof.x + c * COL_W + COL_W * 0.5;
      const under = Math.abs(colX - nextX) <= ball.r * 0.45;
      const take = under
        ? Math.min(h, Math.max(0.15, h * 0.18 + Math.abs(dx) * 0.03))
        : Math.min(h, Math.max(0.25, h * 0.55 + Math.abs(dx) * 0.06));
      pile.heights[c] = h - take;
      pile.dirty = true;
      scooped += take;
    }
    if (scooped > 0) {
      ball.mass += scooped;
      ball.r = ballRadiusFromMass(ball.mass);
      for (let k = 0; k < 3; k++) {
        if (!pileRelax(pile)) break;
      }
      clearOccludedPileColumns(roof, pile);
    }
    if (ball.r > 0.5) ball.rotation += dx / ball.r;
    ball.x = nextX;
    if (!isDesk && isLedgeHidden(roof, ball.x)) {
      dropBallOffRoof(ball, roof, ball.x, dx || ball.vx || 1);
      return;
    }
    const h = pileHeightAt(pile, ball.x - roof.x);
    ball.y = seatBallY(roof.y, h, ball.r);
    ball.roofId = roof.id;
    ball.vx = dx * 10;
    ball.vy = 0;
  }

  function midOr(roof: SnowRoof): number {
    return roof.x + roof.w * 0.5;
  }

  /**
   * SnowDesk SnowWorld.pushSnowballs(from:to:dt:) —
   * Option+cursor rolls a ball ahead of the pointer; past the edge drops it.
   */
  function pushSnowballs(
    from: { x: number; y: number },
    to: { x: number; y: number },
    dt: number
  ): boolean {
    const moveX = to.x - from.x;
    const moveY = to.y - from.y;
    const dist = Math.hypot(moveX, moveY);
    if (dist < 0.15) return false;
    const safeDt = Math.max(dt, 1 / 120);
    const speed = dist / safeDt;
    if (speed > PUSH_MAX_SPEED) return false;
    const sign = moveX >= 0 ? 1 : -1;
    let pushed = false;
    const minX = Math.min(from.x, to.x);
    const maxX = Math.max(from.x, to.x);
    const minY = Math.min(from.y, to.y);
    const maxY = Math.max(from.y, to.y);
    for (const b of balls) {
      const hitR = b.r + 14;
      const left = b.x - hitR;
      const right = b.x + hitR;
      const desired = to.x + sign * b.r * PUSH_AHEAD;
      const maxStep = Math.max(Math.abs(moveX) * 1.6, dist * 1.15, 3);
      const delta = Math.max(-maxStep, Math.min(maxStep, desired - b.x));

      if (!b.roofId) continue;
      const roof = roofById(b.roofId);
      if (!roof) continue;
      if (isHidden(b.x, b.y, roof.z)) continue;
      const pile = piles.get(b.roofId) ?? ensurePile(roof);
      const isDesk = roof.id === GROUND_ID;
      // Include the ball body and the pile surface under it (not only above).
      const pileH = pileHeightAt(pile, b.x - roof.x);
      const snowTop = roof.y - pileH;
      const top = isDesk
        ? Math.min(b.y - b.r - 28, snowTop - 36)
        : b.y - b.r - 12;
      const bottom = isDesk
        ? Math.max(b.y + b.r + 10, roof.y + 20)
        : roof.y + 22;
      const nearX = maxX >= left && minX <= right;
      const nearY = maxY >= top && minY <= bottom;
      const nearLeftEdge =
        !isDesk &&
        b.x <= roof.x + b.r * 2.2 &&
        to.x <= roof.x + b.r * 1.5 &&
        moveX <= 0.15;
      const nearRightEdge =
        !isDesk &&
        b.x >= roof.x + roof.w - b.r * 2.2 &&
        to.x >= roof.x + roof.w - b.r * 1.5 &&
        moveX >= -0.15;
      if ((!nearX || !nearY) && !nearLeftEdge && !nearRightEdge) continue;
      const into =
        (sign > 0 && to.x + 6 >= b.x - b.r) ||
        (sign < 0 && to.x - 6 <= b.x + b.r) ||
        nearLeftEdge ||
        nearRightEdge ||
        (isDesk && Math.abs(to.x - b.x) <= b.r + 18);
      if (!into && Math.abs(moveX) < (isDesk ? 0.35 : 0.5)) continue;

      // Cursor past / on the ledge while the ball is there → tip off.
      if (nearLeftEdge || nearRightEdge) {
        dropBallOffRoof(b, roof, to.x, moveX || (nearLeftEdge ? -1 : 1));
        pushed = true;
        continue;
      }

      // SnowDesk roll(_:on:to:) — same for windows and desk pile.
      rollBall(b, roof, pile, b.x + delta);
      pushed = true;
    }
    return pushed;
  }

  function tryMergeBalls(): void {
    for (let i = 0; i < balls.length; i++) {
      for (let j = i + 1; j < balls.length; j++) {
        const a = balls[i]!;
        const b = balls[j]!;
        if (a.r < BALL_MIN_R + 3 || b.r < BALL_MIN_R + 3) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const need = (a.r + b.r) * 0.82;
        if (dx * dx + dy * dy > need * need) continue;
        if (men.length >= MAX_MEN) return;
        men.push({
          id: uid("man"),
          x: (a.x + b.x) / 2,
          y: Math.min(a.y, b.y) - 4,
          scale: Math.min(1.4, 0.75 + (a.r + b.r) / 64),
          vx: 0,
          vy: 0,
          roofId: a.roofId ?? b.roofId,
        });
        balls.splice(j, 1);
        balls.splice(i, 1);
        return;
      }
    }
  }

  function dump(roofId: string): void {
    const pile = piles.get(roofId);
    const roof = opts.getRoofs().find((r) => r.id === roofId);
    if (pile && roof) {
      for (let c = 0; c < pile.heights.length; c++) {
        const h = pile.heights[c]!;
        if (h < 0.4) continue;
        const n = Math.min(8, Math.ceil(h / 2));
        for (let k = 0; k < n; k++) {
          flakes.push({
            x: roof.x + c * COL_W + Math.random() * COL_W,
            y: roof.y - Math.random() * h,
            r: 0.9 + Math.random() * 1.4,
            vx: (Math.random() - 0.5) * 50,
            vy: 45 + Math.random() * 40,
            kind: "fall",
            alpha: 0.75,
            wobble: 8,
            phase: Math.random() * Math.PI * 2,
          });
        }
        pile.heights[c] = 0;
      }
      pile.dirty = false;
    }
    for (const b of balls) {
      if (b.roofId === roofId) {
        b.roofId = null;
        b.vy = 40 + Math.random() * 30;
        b.vx = (Math.random() - 0.5) * 40;
      }
    }
    for (const m of men) {
      if (m.roofId === roofId) {
        m.roofId = null;
        m.vy = 35 + Math.random() * 25;
        m.vx = (Math.random() - 0.5) * 30;
      }
    }
  }

  function shake(roofId: string, impulseX: number): void {
    if (!Number.isFinite(impulseX) || Math.abs(impulseX) < 0.4) return;
    const strength = Math.min(80, Math.abs(impulseX));
    const pile = piles.get(roofId);
    const roof = opts.getRoofs().find((r) => r.id === roofId);
    if (pile && roof) {
      // Shift mass sideways then relax — looks like SnowDesk throwOff-lite
      const shift = Math.round(impulseX * 0.35);
      if (shift !== 0) {
        const next = new Float32Array(pile.heights.length);
        for (let i = 0; i < pile.heights.length; i++) {
          const j = i - shift;
          if (j >= 0 && j < next.length) next[j] = pile.heights[i]!;
          else if (pile.heights[i]! > 0.3) {
            flakes.push({
              x: roof.x + i * COL_W,
              y: roof.y - pile.heights[i]!,
              r: 1,
              vx: impulseX * 1.5,
              vy: 20 + Math.random() * 25,
              kind: "fall",
              alpha: 0.7,
              wobble: 8,
              phase: Math.random() * Math.PI * 2,
            });
          }
        }
        for (let i = 0; i < next.length; i++) {
          pile.heights[i] = Math.min(pile.maxHeights[i]!, next[i]!);
        }
        pile.dirty = true;
      }
      if (strength > 12) {
        for (let i = 0; i < pile.heights.length; i++) {
          if (Math.random() > strength / 160) continue;
          const h = pile.heights[i]!;
          if (h < 1) continue;
          const take = Math.min(h, 0.8 + Math.random());
          pile.heights[i] = h - take;
          flakes.push({
            x: roof.x + i * COL_W + Math.random() * COL_W,
            y: roof.y - h,
            r: 0.9 + Math.random(),
            vx: impulseX * 1.2 + (Math.random() - 0.5) * 20,
            vy: 30 + Math.random() * 30,
            kind: "fall",
            alpha: 0.75,
            wobble: 8,
            phase: Math.random() * Math.PI * 2,
          });
          pile.dirty = true;
        }
      }
      for (let k = 0; k < 6; k++) pileRelax(pile);
    }
    for (const b of balls) {
      if (b.roofId !== roofId) continue;
      b.x += impulseX * 0.2;
      if (strength > 14 && Math.random() < strength / 120) {
        b.roofId = null;
        b.vy = 30 + Math.random() * 30;
        b.vx = impulseX * 1.4;
      }
    }
    for (const m of men) {
      if (m.roofId !== roofId) continue;
      m.x += impulseX * 0.15;
      if (strength > 20 && Math.random() < 0.3) {
        m.roofId = null;
        m.vy = 28 + Math.random() * 24;
        m.vx = impulseX;
      }
    }
  }

  function hitRoofTop(
    prevY: number,
    f: Flake,
    roof: SnowRoof
  ): boolean {
    if (f.vy <= 0) return false;
    if (f.x < roof.x + 1 || f.x > roof.x + roof.w - 1) return false;
    // Occlusion is on the ledge (roof.y), not the pile tip — otherwise snow
    // that relaxed under a front card grows tall enough to accept more flakes.
    if (isLedgeHidden(roof, f.x)) return false;
    const pile = piles.get(roof.id);
    const h = pile ? pileHeightAt(pile, f.x - roof.x) : 0;
    const top = roof.y - h;
    return prevY <= top + 1 && f.y >= top - 2;
  }

  function settleBody(
    body: { x: number; y: number; r: number; roofId: string | null; vy: number },
    roofs: Map<string, SnowRoof>
  ): void {
    // Prefer front-most roof when several overlap under the body.
    const ordered = [...roofs.values()].sort((a, b) => b.z - a.z);
    for (const roof of ordered) {
      if (body.x < roof.x + 4 || body.x > roof.x + roof.w - 4) continue;
      if (isHidden(body.x, roof.y + 1, roof.z)) continue;
      const pile = ensurePile(roof);
      const h = pileHeightAt(pile, body.x - roof.x);
      const top = seatBallY(roof.y, h, body.r);
      if (body.y >= top - 2 && body.y <= roof.y + body.r && body.vy >= 0) {
        body.y = top;
        body.vy = 0;
        body.roofId = roof.id;
        return;
      }
    }
  }

  function hitMan(wx: number, wy: number): SnowmanEntity | null {
    for (let i = men.length - 1; i >= 0; i--) {
      const m = men[i]!;
      const dx = m.x - wx;
      const dy = m.y - 8 * m.scale - wy;
      const hitR = 14 * m.scale;
      if (dx * dx + dy * dy <= hitR * hitR) return m;
    }
    return null;
  }

  /** Dissolve undergrown balls when Option is released. */
  function shatterTinyBalls(): void {
    for (let i = balls.length - 1; i >= 0; i--) {
      const b = balls[i]!;
      if (b.mass >= GATHER_SPAWN_MASS * 0.55 && b.r >= BALL_MIN_R + 0.8) {
        continue;
      }
      shatterBall(b);
    }
  }

  function endGather(): void {
    gatherTravel = 0;
    gatherMass = 0;
    lastGatherTime = 0;
    shatterTinyBalls();
  }

  function step(dt: number): void {
    const roofs = roofMap();
    syncPiles(roofs);
    for (const roof of allSnowRoofs()) {
      const pile = piles.get(roof.id);
      if (!pile) continue;
      if (pile.dirty) {
        for (let k = 0; k < 3; k++) {
          if (!pileRelax(pile)) break;
        }
      }
      // Interaction / avalanche must not refill columns under a front card.
      clearOccludedPileColumns(roof, pile);
    }

    if (snowOpts.amount > 0.01) {
      const interval = spawnInterval();
      spawnAcc += dt;
      while (spawnAcc >= interval) {
        spawnAcc -= interval;
        const extraChance =
          0.2 + snowOpts.amount * 0.35 + (snowOpts.smooth ? 0.2 : 0);
        const batch =
          1 +
          (Math.random() < extraChance ? 1 : 0) +
          (snowOpts.smooth && snowOpts.amount > 0.7 && Math.random() < 0.35
            ? 1
            : 0);
        spawnFall(batch);
      }
    } else {
      spawnAcc = 0;
    }

    const gy = groundY();
    const grav = 18 * speedMul();
    // Copy list because landOnRoof may splice
    for (let i = flakes.length - 1; i >= 0; i--) {
      const f = flakes[i];
      if (!f || f.kind !== "fall") continue;
      const prevY = f.y;
      f.phase += dt * 2.2;
      f.x += (f.vx + Math.sin(f.phase) * f.wobble) * dt;
      f.y += f.vy * dt;
      f.vy += grav * dt;

      let landed = false;
      // Front-most roof wins when terminals overlap.
      const landRoofs = [...roofs.values()].sort((a, b) => b.z - a.z);
      for (const roof of landRoofs) {
        if (!hitRoofTop(prevY, f, roof)) continue;
        if (prevY > roof.y + 6) continue;
        landOnRoof(f, roof);
        landed = true;
        break;
      }
      if (landed) continue;
      if (f.y >= gy) {
        landOnGround(f);
        continue;
      }
      if (
        f.y > opts.world.y + opts.world.h + 80 ||
        f.x < opts.world.x - 200 ||
        f.x > opts.world.x + opts.world.w + 200
      ) {
        f.y = opts.world.y - 40;
        f.x = opts.world.x + Math.random() * opts.world.w;
        f.vy = 28 + Math.random() * 30;
      }
    }

    for (let bi = balls.length - 1; bi >= 0; bi--) {
      const b = balls[bi]!;
      const seatedRoof = roofById(b.roofId);
      if (seatedRoof) {
        const roof = seatedRoof;
        const isDesk = roof.id === GROUND_ID;
        // Covered by a front card — detach and fall instead of freezing invisible.
        if (isHidden(b.x, b.y, roof.z)) {
          if (isDesk) {
            b.vx = 0;
          } else {
            b.roofId = null;
            b.vy = Math.max(40, Math.abs(b.vx) * 0.35 + 20);
          }
          continue;
        }
        const slide = b.vx * dt;
        b.x += slide;
        if (Math.abs(slide) > 0.001 && b.r > 0.5) {
          b.rotation += slide / b.r;
        }
        b.vx *= isDesk ? 0.94 : 0.92;
        b.vy = 0;
        if (
          !isDesk &&
          (b.x < roof.x + b.r * 0.45 || b.x > roof.x + roof.w - b.r * 0.45)
        ) {
          dropBallOffRoof(b, roof, b.x, slide || b.vx || 1);
          continue;
        }
        const pile = ensurePile(roof);
        const h = pileHeightAt(pile, b.x - roof.x);
        b.x = Math.max(
          roof.x + b.r * (isDesk ? 1 : 0.5),
          Math.min(roof.x + roof.w - b.r * (isDesk ? 1 : 0.5), b.x)
        );
        b.y = seatBallY(roof.y, h, b.r);
        continue;
      }

      // Free fall (SnowDesk fall): gravity 900; shatter only on impact.
      b.roofId = null;
      b.vy += BALL_GRAVITY * dt;
      const airSlide = b.vx * dt;
      b.x += airSlide;
      if (Math.abs(airSlide) > 0.001 && b.r > 0.5) {
        b.rotation += airSlide / b.r;
      }
      b.y += b.vy * dt;
      b.vx *= 0.997;

      const vyBefore = b.vy;
      settleBody(b, roofs);
      if (b.roofId) {
        if (vyBefore >= BALL_SHATTER_VY) {
          shatterBall(b);
          continue;
        }
        b.vy = 0;
        b.vx *= 0.55;
        continue;
      }
      if (b.y + b.r >= gy) {
        if (vyBefore >= BALL_SHATTER_VY) {
          shatterBall(b);
          continue;
        }
        const roof = groundRoof();
        const pile = ensureGroundPile();
        const h = pileHeightAt(pile, b.x - roof.x);
        b.y = seatBallY(roof.y, h, b.r);
        b.roofId = GROUND_ID;
        b.vy = 0;
        b.vx *= 0.7;
      }
    }

    for (const m of men) {
      if (dragMan && dragMan.id === m.id) continue;
      if (m.roofId === GROUND_ID || (m.roofId && roofs.has(m.roofId))) {
        const roof =
          m.roofId === GROUND_ID ? groundRoof() : roofs.get(m.roofId!)!;
        const pile = ensurePile(roof);
        const h = pileHeightAt(pile, m.x - roof.x);
        m.x = Math.max(roof.x + 12, Math.min(roof.x + roof.w - 12, m.x));
        m.y = roof.y - h - 2;
        m.vx *= 0.85;
        m.vy = 0;
        if (isHidden(m.x, m.y, roof.z)) m.vx = 0;
        continue;
      }
      m.roofId = null;
      m.vy += 220 * dt;
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      m.vx *= 0.985;
      const proxy = {
        x: m.x,
        y: m.y,
        r: 10 * m.scale,
        roofId: m.roofId,
        vy: m.vy,
      };
      settleBody(proxy, roofs);
      m.roofId = proxy.roofId;
      m.y = proxy.y;
      m.vy = proxy.vy;
      if (!m.roofId && m.y >= gy - 4) {
        m.y = gy - 4;
        m.roofId = GROUND_ID;
        m.vy = 0;
        m.vx *= 0.72;
      }
    }

    tryMergeBalls();
  }

  /**
   * SnowDesk fillPileVertices: per-column quads (triangle strip),
   * solid white with slight slope shading — not a soft blob.
   */
  function drawPile(
    ctx: CanvasRenderingContext2D,
    roof: SnowRoof,
    pile: Pile,
    cam: SnowCamera
  ): void {
    if (pileTotal(pile) < 0.35) return;
    const z = cam.zoom;
    const n = pile.heights.length;
    const baseY = cam.y + roof.y * z;
    const left = cam.x + roof.x * z;
    const colW = COL_W * z;

    // Contact shade under the ledge
    ctx.beginPath();
    ctx.moveTo(left, baseY + 1.4 * z);
    for (let i = 0; i < n; i++) {
      if (isPileColHidden(roof, i)) continue;
      const h = pile.heights[i]!;
      if (h < 0.15) continue;
      ctx.lineTo(left + (i + 0.5) * colW, baseY - Math.min(h, 3) * z + 1.5 * z);
    }
    ctx.lineTo(left + roof.w * z, baseY + 1.4 * z);
    ctx.closePath();
    ctx.fillStyle = "rgba(120, 145, 170, 0.14)";
    ctx.fill();

    for (let i = 0; i < n; i++) {
      if (isPileColHidden(roof, i)) continue;
      const h = pile.heights[i]!;
      if (h < 0.12) continue;
      const x0 = left + i * colW;
      const x1 = x0 + colW + 0.35 * z; // slight overlap kills gaps
      const yTop = baseY - h * z;
      const prev = i > 0 ? pile.heights[i - 1]! : h;
      const next = i + 1 < n ? pile.heights[i + 1]! : h;
      const slope = (next - prev) / (COL_W * 2);
      // SnowDesk PileVertex color ~ white with tiny slope tint
      const shade = Math.max(0.88, Math.min(1, 0.96 + slope * 0.04));
      const g = Math.round(255 * shade);
      const b = Math.round(252 * shade);
      ctx.fillStyle = `rgb(${g},${g},${b})`;
      ctx.fillRect(x0, yTop, x1 - x0, baseY - yTop + 0.6 * z);

      // Crisp top lip
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.fillRect(x0, yTop, x1 - x0, Math.max(1, 1.15 * z));
    }
  }

  /** SnowDesk flakeFragment: soft disc via smoothstep. */
  function drawFlakeDisc(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    size: number,
    alpha: number
  ): void {
    const r = Math.max(0.8, size);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    // approximate smoothstep(0.55,1.0) falloff as white alpha disc
    g.addColorStop(0, `rgba(255,255,255,${alpha})`);
    g.addColorStop(0.55, `rgba(255,255,255,${alpha * 0.85})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawSprite(
    ctx: CanvasRenderingContext2D,
    img: HTMLImageElement,
    x: number,
    y: number,
    w: number,
    h: number,
    rotation = 0
  ): void {
    ctx.save();
    ctx.translate(x, y);
    if (rotation) ctx.rotate(rotation);
    if (!img.complete || img.naturalWidth < 1) {
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.beginPath();
      ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  function clearLayer(
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D | null
  ): void {
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function paint(): void {
    if (!backCtx || !frontCtx) return;
    const cam = opts.getCamera();
    const cssW = back.width / dpr;
    const cssH = back.height / dpr;
    clearLayer(back, backCtx);
    clearLayer(front, frontCtx);
    backCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    frontCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const toScreen = (wx: number, wy: number) => ({
      x: cam.x + wx * cam.zoom,
      y: cam.y + wy * cam.zoom,
    });

    // Falling + ground flakes (behind cards) — soft points like flakeFragment
    for (const f of flakes) {
      const p = toScreen(f.x, f.y);
      const size = (f.r * 2 + 1.5) * Math.min(1.4, cam.zoom);
      if (p.x < -10 || p.y < -10 || p.x > cssW + 10 || p.y > cssH + 10) continue;
      drawFlakeDisc(
        backCtx,
        p.x,
        p.y,
        size,
        f.kind === "fall" ? f.alpha : f.alpha * 0.9
      );
    }

    // Board floor pile + ground balls (behind terminal roofs).
    {
      const gRoof = groundRoof();
      const gPile = piles.get(GROUND_ID) ?? ensureGroundPile();
      frontCtx.save();
      clipAgainstFrontRoofs(frontCtx, gRoof, cam, cssW, cssH);
      drawPile(frontCtx, gRoof, gPile, cam);
      for (const b of balls) {
        if (b.roofId !== GROUND_ID) continue;
        if (isHidden(b.x, b.y, gRoof.z)) continue;
        const p = toScreen(b.x, b.y);
        const s = b.r * 2 * cam.zoom;
        drawSprite(frontCtx, ballImg, p.x, p.y, s, s, b.rotation);
      }
      for (const m of men) {
        if (m.roofId !== GROUND_ID) continue;
        if (isHidden(m.x, m.y, gRoof.z)) continue;
        const p = toScreen(m.x, m.y);
        const w = 24 * m.scale * cam.zoom;
        const h = 28 * m.scale * cam.zoom;
        drawSprite(frontCtx, manImg, p.x, p.y - h * 0.15, w, h);
      }
      frontCtx.restore();
    }

    // Back → front so higher-z roofs paint above lower ones, each clipped
    // against terminals in front (SnowDesk isHidden occlusion).
    const orderedRoofs = roofsFrontToBack();
    for (const roof of orderedRoofs) {
      const pile = piles.get(roof.id);
      if (!pile) continue;
      frontCtx.save();
      clipAgainstFrontRoofs(frontCtx, roof, cam, cssW, cssH);
      drawPile(frontCtx, roof, pile, cam);
      for (const b of balls) {
        if (b.roofId !== roof.id) continue;
        if (isHidden(b.x, b.y, roof.z)) continue;
        const p = toScreen(b.x, b.y);
        const s = b.r * 2 * cam.zoom;
        drawSprite(frontCtx, ballImg, p.x, p.y, s, s, b.rotation);
      }
      for (const m of men) {
        if (m.roofId !== roof.id) continue;
        if (isHidden(m.x, m.y, roof.z)) continue;
        const p = toScreen(m.x, m.y);
        const w = 24 * m.scale * cam.zoom;
        const h = 28 * m.scale * cam.zoom;
        drawSprite(frontCtx, manImg, p.x, p.y - h * 0.15, w, h);
      }
      frontCtx.restore();
    }

    // Free-falling balls / snowmen (no roof) — still hide under front cards.
    for (const b of balls) {
      if (b.roofId === GROUND_ID) continue;
      if (b.roofId && orderedRoofs.some((r) => r.id === b.roofId)) continue;
      const coverZ = -1;
      if (isHidden(b.x, b.y, coverZ)) continue;
      const p = toScreen(b.x, b.y);
      const s = b.r * 2 * cam.zoom;
      drawSprite(frontCtx, ballImg, p.x, p.y, s, s, b.rotation);
    }
    for (const m of men) {
      if (m.roofId === GROUND_ID) continue;
      if (m.roofId && orderedRoofs.some((r) => r.id === m.roofId)) continue;
      if (isHidden(m.x, m.y, -1)) continue;
      const p = toScreen(m.x, m.y);
      const w = 24 * m.scale * cam.zoom;
      const h = 28 * m.scale * cam.zoom;
      drawSprite(frontCtx, manImg, p.x, p.y - h * 0.15, w, h);
    }
  }

  function frame(t: number): void {
    if (!enabled) return;
    const dt = Math.min(0.05, (t - lastT) / 1000 || 0.016);
    lastT = t;
    step(dt);
    paint();
    raf = window.requestAnimationFrame(frame);
  }

  function start(): void {
    if (raf) return;
    resize();
    lastT = performance.now();
    raf = window.requestAnimationFrame(frame);
  }

  function stop(): void {
    if (raf) window.cancelAnimationFrame(raf);
    raf = 0;
    flakes.length = 0;
    balls.length = 0;
    men.length = 0;
    piles.clear();
    gatherTravel = 0;
    gatherMass = 0;
    lastGatherTime = 0;
    lastPointerT = 0;
    dragMan = null;
    lastMouse = null;
    spawnAcc = 0;
    clearLayer(back, backCtx);
    clearLayer(front, frontCtx);
    opts.viewport.classList.remove("is-snow-gather");
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Alt") {
      altHeld = true;
      if (enabled) opts.viewport.classList.add("is-snow-gather");
    }
  }
  function onKeyUp(e: KeyboardEvent): void {
    if (e.key === "Alt") {
      altHeld = false;
      opts.viewport.classList.remove("is-snow-gather");
      endGather();
    }
  }

  function onPointerMove(e: PointerEvent): void {
    if (!enabled) return;
    if (dragMan) {
      const w = clientToWorld(e.clientX, e.clientY);
      const m = men.find((x) => x.id === dragMan!.id);
      if (m) {
        m.x = w.x - dragMan.ox;
        m.y = w.y - dragMan.oy;
        m.roofId = null;
        m.vx = 0;
        m.vy = 0;
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    const rect = opts.viewport.getBoundingClientRect();
    if (
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom
    ) {
      return;
    }

    const w = clientToWorld(e.clientX, e.clientY);
    const prev = lastMouse;
    const moveX = prev ? w.x - prev.x : 0;
    const moveY = prev ? w.y - prev.y : 0;
    const dist = Math.hypot(moveX, moveY);
    lastMouse = w;

    const gathering = e.altKey || altHeld;
    opts.viewport.classList.toggle("is-snow-gather", gathering);
    const now = performance.now() / 1000;
    const frameDt = Math.max(
      1 / 120,
      Math.min(1 / 15, lastPointerT > 0 ? now - lastPointerT : 1 / 60)
    );
    lastPointerT = now;

    if (gathering) {
      if (lastGatherTime > 0 && now - lastGatherTime > GATHER_IDLE_RESET) {
        gatherTravel = 0;
        gatherMass = 0;
      }
      lastGatherTime = now;
      if (dist < 0.2) return;

      // SnowDesk update: pushSnowballs first; only sweep if nothing was rolled.
      const from = prev ?? w;
      if (pushSnowballs(from, w, frameDt)) {
        return;
      }

      // SnowDesk sweep: subdivide by dist/7, max 12 steps; radius eases in.
      const steps = Math.min(12, Math.max(1, Math.ceil(dist / 7)));
      let lastHit: { roof: SnowRoof; pile: Pile } | null = null;
      let gatheredGround = false;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const sx = from.x + moveX * t;
        const sy = from.y + moveY * t;
        const rad = GATHER_R * (0.55 + 0.45 * t);
        const { gained, roof, pile, ground } = carveAt(
          sx,
          sy,
          moveX / steps,
          moveY / steps,
          true,
          rad
        );
        gatherTravel += dist / steps;
        gatherMass += gained;
        if (roof && pile) lastHit = { roof, pile };
        if (ground) gatheredGround = true;
      }

      // Spawn once — on a roof pile, or on the board floor pile.
      // If the seat is occluded, keep gather progress and retry next stroke.
      const deskGather =
        gatheredGround || (lastHit != null && lastHit.roof.id === GROUND_ID);
      const travelNeed = deskGather
        ? GATHER_SPAWN_TRAVEL * 0.5
        : GATHER_SPAWN_TRAVEL;
      const massNeed = deskGather ? GATHER_SPAWN_MASS * 0.7 : GATHER_SPAWN_MASS;
      const horizontalEnough =
        Math.abs(moveX) * 1.5 > Math.abs(moveY) ||
        (deskGather && Math.abs(moveX) > 0.35);
      if (
        balls.length < MAX_BALLS &&
        gatherTravel >= travelNeed &&
        gatherMass >= massNeed &&
        horizontalEnough
      ) {
        const mass = Math.max(gatherMass, massNeed);
        const r = ballRadiusFromMass(mass);
        const dir = moveX >= 0 ? 1 : -1;
        let spawned = false;
        const hit =
          lastHit ??
          (gatheredGround
            ? { roof: groundRoof(), pile: ensureGroundPile() }
            : null);
        if (hit) {
          const bx = visibleSeatOnRoof(hit.roof, hit.pile, w.x, r);
          if (bx != null) {
            balls.push({
              id: uid("ball"),
              x: bx,
              y: seatBallY(
                hit.roof.y,
                pileHeightAt(hit.pile, bx - hit.roof.x),
                r
              ),
              r,
              mass,
              rotation: 0,
              vx: dir * 12,
              vy: 0,
              roofId: hit.roof.id,
            });
            spawned = true;
          }
        }
        if (spawned) {
          gatherTravel = 0;
          gatherMass = 0;
        }
      }
      return;
    }

    if (gatherTravel > 0 || gatherMass > 0) endGather();
    // Normal cursor: carve only (SnowDesk does not velocity-shove balls here).
    if (dist > 0.15) {
      const steps = Math.min(12, Math.max(1, Math.ceil(dist / 7)));
      const from = prev ?? w;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        carveAt(
          from.x + moveX * t,
          from.y + moveY * t,
          moveX / steps,
          moveY / steps,
          false,
          SWEEP_R * (0.7 + 0.3 * (s / steps))
        );
      }
    }
  }

  function onPointerDown(e: PointerEvent): void {
    if (!enabled || e.button !== 0) return;
    const w = clientToWorld(e.clientX, e.clientY);
    const man = hitMan(w.x, w.y);
    if (!man) return;
    dragMan = { id: man.id, ox: w.x - man.x, oy: w.y - man.y };
    man.roofId = null;
    man.vx = 0;
    man.vy = 0;
    e.preventDefault();
    e.stopPropagation();
  }

  function onPointerUp(): void {
    dragMan = null;
  }

  const ro = new ResizeObserver(() => {
    if (enabled) resize();
  });
  ro.observe(opts.viewport);

  opts.viewport.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  function clearAll(): void {
    flakes.length = 0;
    balls.length = 0;
    men.length = 0;
    piles.clear();
    gatherTravel = 0;
    gatherMass = 0;
    lastGatherTime = 0;
    lastPointerT = 0;
    dragMan = null;
    spawnAcc = 0;
    clearLayer(back, backCtx);
    clearLayer(front, frontCtx);
  }

  return {
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      opts.viewport.classList.toggle("is-christmas", on);
      if (on) start();
      else stop();
    },
    setOptions(next) {
      if (typeof next.amount === "number" && Number.isFinite(next.amount)) {
        snowOpts.amount = clamp01(next.amount);
      }
      if (typeof next.speed === "number" && Number.isFinite(next.speed)) {
        snowOpts.speed = clamp01(next.speed);
      }
      if (typeof next.smooth === "boolean") {
        snowOpts.smooth = next.smooth;
      }
    },
    clearAll,
    isEnabled: () => enabled,
    shake,
    dump,
    destroy() {
      stop();
      ro.disconnect();
      opts.viewport.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      back.remove();
      front.remove();
    },
  };
}
