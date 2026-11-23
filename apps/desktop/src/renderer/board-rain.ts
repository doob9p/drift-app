/**
 * Rain board overlay — slanted streaks, roof beads, cursor sweep.
 * ⌥ / Alt held → umbrella follows the cursor and sheds falling rain.
 */

export type RainRoof = {
  id: string;
  y: number;
  x: number;
  w: number;
  h: number;
  z: number;
};

export type RainCamera = {
  x: number;
  y: number;
  zoom: number;
};

export type BoardRainWorld = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type BoardRainOptions = {
  amount: number;
  speed: number;
};

export type BoardRain = {
  setEnabled: (on: boolean) => void;
  setOptions: (next: Partial<BoardRainOptions>) => void;
  clearAll: () => void;
  isEnabled: () => boolean;
  shake: (roofId: string, impulseX: number) => void;
  dump: (roofId: string) => void;
  destroy: () => void;
};

const GROUND_Y_PAD = 18;
const GROUND_ID = "__board_ground__";
const MAX_FALL = 280;
const MAX_BEADS = 360;
const SWEEP_R = 32;
const SLANT = 0.22; // dx per dy — slight wind slant
/** Canopy hit ellipse in world px (aligned to the cartoon dome). */
const UMBRELLA_RX = 56;
const UMBRELLA_RY = 24;
/** Canopy center above the grip (cursor / handle). */
const UMBRELLA_LIFT = 70;
const UMBRELLA_PANELS = 8;

type Drop = {
  x: number;
  y: number;
  len: number;
  vx: number;
  vy: number;
  thick: number;
  alpha: number;
  kind: "fall" | "bead";
  roofId: string | null;
  seatY: number;
  r: number;
};

type Umbrella = {
  x: number;
  y: number;
};

export function createBoardRain(opts: {
  viewport: HTMLElement;
  world: BoardRainWorld;
  getCamera: () => RainCamera;
  getRoofs: () => RainRoof[];
}): BoardRain {
  const back = document.createElement("canvas");
  back.className = "board-rain-canvas board-rain-back";
  back.setAttribute("aria-hidden", "true");
  const front = document.createElement("canvas");
  front.className = "board-rain-canvas board-rain-front";
  front.setAttribute("aria-hidden", "true");
  opts.viewport.appendChild(back);
  opts.viewport.appendChild(front);
  const backCtx = back.getContext("2d");
  const frontCtx = front.getContext("2d");

  let enabled = false;
  let raf = 0;
  let lastT = 0;
  let spawnAcc = 0;
  const drops: Drop[] = [];
  let dpr = 1;
  let lastMouse: { x: number; y: number } | null = null;
  let altHeld = false;
  let umbrella: Umbrella | null = null;
  let rainOpts: BoardRainOptions = { amount: 0.55, speed: 0.5 };

  function umbrellaOpen(): boolean {
    return altHeld && umbrella != null;
  }

  function syncUmbrellaClass(): void {
    opts.viewport.classList.toggle("is-rain-umbrella", enabled && umbrellaOpen());
  }

  function canopyCenter(u: Umbrella): { x: number; y: number } {
    return { x: u.x, y: u.y - UMBRELLA_LIFT };
  }

  /** Top surface y of the canopy ellipse at world x, or null if outside. */
  function canopyTopY(u: Umbrella, wx: number): number | null {
    const c = canopyCenter(u);
    const nx = (wx - c.x) / UMBRELLA_RX;
    if (Math.abs(nx) > 0.98) return null;
    return c.y - UMBRELLA_RY * Math.sqrt(Math.max(0, 1 - nx * nx));
  }

  function clamp01(n: number): number {
    return Math.min(1, Math.max(0, n));
  }

  function spawnInterval(): number {
    return 0.045 - rainOpts.amount * 0.032;
  }

  function speedMul(): number {
    return 0.65 + rainOpts.speed * 1.35;
  }

  function maxFallCap(): number {
    return Math.max(60, Math.floor(MAX_FALL * (0.4 + rainOpts.amount * 0.9)));
  }

  function maxBeadCap(): number {
    return Math.max(80, Math.floor(MAX_BEADS * (0.4 + rainOpts.amount * 0.85)));
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

  function groundY(): number {
    return opts.world.y + opts.world.h - GROUND_Y_PAD;
  }

  function groundRoof(): RainRoof {
    return {
      id: GROUND_ID,
      x: opts.world.x,
      y: groundY(),
      w: opts.world.w,
      h: 64,
      z: -100,
    };
  }

  function allRoofs(): RainRoof[] {
    return [groundRoof(), ...opts.getRoofs()];
  }

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

  function spawnDrop(): void {
    const fallCount = drops.filter((d) => d.kind === "fall").length;
    if (fallCount >= maxFallCap()) return;
    const w = opts.world.w;
    const sm = speedMul();
    drops.push({
      x: opts.world.x + Math.random() * w * 1.08 - w * 0.04,
      y: opts.world.y - 20 - Math.random() * 60,
      len: 10 + Math.random() * 16,
      vx: 40 + Math.random() * 50,
      vy: (320 + Math.random() * 220) * sm,
      thick: 0.7 + Math.random() * 0.9,
      alpha: 0.28 + Math.random() * 0.35,
      kind: "fall",
      roofId: null,
      seatY: 0,
      r: 0,
    });
  }

  function trimBeads(): void {
    const cap = maxBeadCap();
    let beads = 0;
    for (const d of drops) if (d.kind === "bead") beads += 1;
    if (beads <= cap) return;
    let remove = beads - cap;
    for (let i = 0; i < drops.length && remove > 0; i++) {
      if (drops[i]!.kind === "bead") {
        drops.splice(i, 1);
        i -= 1;
        remove -= 1;
      }
    }
  }

  /** Returns true if the drop was consumed (bead or absorbed). */
  function tryLand(drop: Drop, index: number): boolean {
    const roofs = allRoofs().slice().sort((a, b) => a.z - b.z);
    for (const roof of roofs) {
      if (drop.x < roof.x - 2 || drop.x > roof.x + roof.w + 2) continue;
      const top = roof.y + (roof.id === GROUND_ID ? 0 : 1);
      if (drop.y < top - 4 || drop.y > top + 14) continue;
      if (isHidden(drop.x, top + 2, roof.z)) continue;
      // Not every streak leaves a bead — keeps roofs from flooding.
      if (Math.random() > 0.42) {
        drops.splice(index, 1);
        return true;
      }
      drop.kind = "bead";
      drop.roofId = roof.id;
      drop.y = top + Math.random() * 2;
      drop.seatY = drop.y - roof.y;
      drop.vx = 0;
      drop.vy = 0;
      drop.r = 1.2 + Math.random() * 2.4;
      drop.alpha = 0.35 + Math.random() * 0.35;
      return true;
    }
    return false;
  }

  function sweepAt(wx: number, wy: number, dx: number, dy: number): void {
    const speed = Math.hypot(dx, dy);
    if (speed < 0.35) return;
    const push = Math.min(360, 70 + speed * 7);
    const nx = dx / speed;
    const ny = dy / speed;
    for (const drop of drops) {
      if (drop.kind !== "bead") continue;
      const d = Math.hypot(drop.x - wx, drop.y - wy);
      if (d > SWEEP_R) continue;
      const roof =
        drop.roofId === GROUND_ID
          ? groundRoof()
          : opts.getRoofs().find((r) => r.id === drop.roofId);
      if (roof && isHidden(drop.x, drop.y, roof.z)) continue;
      drop.kind = "fall";
      drop.roofId = null;
      drop.len = 8 + Math.random() * 10;
      drop.thick = 0.8;
      drop.vx = nx * push * (0.5 + Math.random() * 0.5);
      drop.vy = Math.max(80, ny * push * 0.2 + 120 + Math.random() * 80);
    }
  }

  /** Knock a falling streak off the canopy toward the nearer rim. */
  function shedFromUmbrella(drop: Drop, u: Umbrella): void {
    const c = canopyCenter(u);
    const side = drop.x >= c.x ? 1 : -1;
    drop.x = c.x + side * (UMBRELLA_RX + 2 + Math.random() * 4);
    drop.y = c.y + 2 + Math.random() * 6;
    drop.len = 7 + Math.random() * 10;
    drop.thick = 0.75 + Math.random() * 0.5;
    drop.vx = side * (70 + Math.random() * 55);
    drop.vy = 90 + Math.random() * 110;
    drop.alpha = Math.min(0.7, drop.alpha + 0.08);
    drop.kind = "fall";
    drop.roofId = null;
  }

  function hitUmbrella(drop: Drop, u: Umbrella, prevY: number): boolean {
    const top = canopyTopY(u, drop.x);
    if (top == null) return false;
    // Crossing or resting on the dome from above.
    if (prevY > top + 6) return false;
    if (drop.y < top - 2) return false;
    if (drop.y > top + 10) return false;
    return true;
  }

  function onPointerMove(e: PointerEvent): void {
    if (!enabled) return;
    const w = clientToWorld(e.clientX, e.clientY);
    const gathering = e.altKey || altHeld;
    if (gathering) {
      umbrella = { x: w.x, y: w.y };
      altHeld = true;
      syncUmbrellaClass();
      lastMouse = w;
      return;
    }
    umbrella = null;
    syncUmbrellaClass();
    if (lastMouse) {
      sweepAt(w.x, w.y, w.x - lastMouse.x, w.y - lastMouse.y);
    }
    lastMouse = w;
  }

  function onPointerLeave(): void {
    lastMouse = null;
    // Keep umbrella if Alt is still held — pointer may re-enter.
    if (!altHeld) {
      umbrella = null;
      syncUmbrellaClass();
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== "Alt") return;
    altHeld = true;
    if (enabled && lastMouse) {
      umbrella = { x: lastMouse.x, y: lastMouse.y };
    }
    syncUmbrellaClass();
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (e.key !== "Alt") return;
    altHeld = false;
    umbrella = null;
    syncUmbrellaClass();
  }

  function worldToScreen(wx: number, wy: number): { x: number; y: number } {
    const cam = opts.getCamera();
    return {
      x: (wx * cam.zoom + cam.x) * dpr,
      y: (wy * cam.zoom + cam.y) * dpr,
    };
  }

  function drawFall(
    ctx: CanvasRenderingContext2D,
    drop: Drop,
    camZoom: number
  ): void {
    const a = worldToScreen(drop.x, drop.y);
    const b = worldToScreen(
      drop.x - drop.len * SLANT,
      drop.y - drop.len
    );
    ctx.strokeStyle = `rgba(170, 200, 230, ${drop.alpha})`;
    ctx.lineWidth = Math.max(0.6, drop.thick * camZoom * dpr);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  function drawBead(
    ctx: CanvasRenderingContext2D,
    drop: Drop,
    camZoom: number
  ): void {
    const scr = worldToScreen(drop.x, drop.y);
    const r = drop.r * camZoom * dpr;
    const g = ctx.createRadialGradient(scr.x, scr.y, 0, scr.x, scr.y, r * 1.4);
    g.addColorStop(0, `rgba(210, 230, 245, ${Math.min(0.85, drop.alpha + 0.25)})`);
    g.addColorStop(0.55, `rgba(140, 180, 220, ${drop.alpha})`);
    g.addColorStop(1, "rgba(100, 140, 180, 0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(scr.x, scr.y, r * 1.15, r * 0.75, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawUmbrella(
    ctx: CanvasRenderingContext2D,
    u: Umbrella,
    camZoom: number
  ): void {
    const z = camZoom * dpr;
    const c = canopyCenter(u);
    const tip = worldToScreen(c.x, c.y - UMBRELLA_RY);
    const mid = worldToScreen(c.x, c.y);
    const grip = worldToScreen(u.x, u.y);
    const rx = UMBRELLA_RX * z;
    const ry = UMBRELLA_RY * z;
    const scallop = 7 * z;
    const shaftTopY = mid.y + scallop * 0.15;
    const shaftX = mid.x;

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    // Soft ground shadow under the grip.
    ctx.fillStyle = "rgba(0, 0, 0, 0.12)";
    ctx.beginPath();
    ctx.ellipse(grip.x + 2 * z, grip.y + 3 * z, 14 * z, 4 * z, 0, 0, Math.PI * 2);
    ctx.fill();

    // Shaft + J-handle (drawn under canopy).
    const handleR = 11 * z;
    ctx.strokeStyle = "#6b4a32";
    ctx.lineWidth = Math.max(2.2, 3.4 * z);
    ctx.beginPath();
    ctx.moveTo(shaftX, shaftTopY);
    ctx.lineTo(shaftX, grip.y - handleR * 0.15);
    ctx.quadraticCurveTo(
      shaftX,
      grip.y + handleR * 0.95,
      shaftX - handleR,
      grip.y + handleR * 0.55
    );
    ctx.quadraticCurveTo(
      shaftX - handleR * 1.35,
      grip.y + handleR * 0.15,
      shaftX - handleR * 0.75,
      grip.y - handleR * 0.05
    );
    ctx.stroke();
    // Warm wood highlight on the shaft.
    ctx.strokeStyle = "rgba(210, 168, 120, 0.45)";
    ctx.lineWidth = Math.max(1, 1.35 * z);
    ctx.beginPath();
    ctx.moveTo(shaftX - 1.1 * z, shaftTopY + 4 * z);
    ctx.lineTo(shaftX - 1.1 * z, grip.y - handleR * 0.4);
    ctx.stroke();

    // Scalloped cartoon canopy path.
    const rimY = mid.y;
    ctx.beginPath();
    ctx.moveTo(mid.x - rx, rimY);
    for (let i = 0; i < UMBRELLA_PANELS; i++) {
      const x0 = mid.x - rx + (rx * 2 * i) / UMBRELLA_PANELS;
      const x1 = mid.x - rx + (rx * 2 * (i + 1)) / UMBRELLA_PANELS;
      const xm = (x0 + x1) / 2;
      ctx.quadraticCurveTo(xm, rimY + scallop, x1, rimY);
    }
    // Soft dome up to the tip.
    ctx.quadraticCurveTo(mid.x + rx * 0.55, tip.y + ry * 0.15, tip.x, tip.y);
    ctx.quadraticCurveTo(mid.x - rx * 0.55, tip.y + ry * 0.15, mid.x - rx, rimY);
    ctx.closePath();

    const canopyFill = ctx.createLinearGradient(
      mid.x - rx * 0.2,
      tip.y,
      mid.x + rx * 0.35,
      rimY + scallop
    );
    canopyFill.addColorStop(0, "#ff8a9a");
    canopyFill.addColorStop(0.45, "#e85d6f");
    canopyFill.addColorStop(1, "#c43b52");
    ctx.fillStyle = canopyFill;
    ctx.fill();

    // Panel seams (gentle Disney ribs).
    ctx.strokeStyle = "rgba(120, 28, 48, 0.28)";
    ctx.lineWidth = Math.max(1, 1.15 * z);
    for (let i = 1; i < UMBRELLA_PANELS; i++) {
      const t = i / UMBRELLA_PANELS;
      const bx = mid.x - rx + rx * 2 * t;
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y + 3 * z);
      ctx.quadraticCurveTo(
        mid.x + (bx - mid.x) * 0.35,
        tip.y + ry * 0.7,
        bx,
        rimY + scallop * 0.35
      );
      ctx.stroke();
    }

    // Outer outline.
    ctx.strokeStyle = "rgba(90, 24, 40, 0.55)";
    ctx.lineWidth = Math.max(1.4, 1.8 * z);
    ctx.beginPath();
    ctx.moveTo(mid.x - rx, rimY);
    for (let i = 0; i < UMBRELLA_PANELS; i++) {
      const x0 = mid.x - rx + (rx * 2 * i) / UMBRELLA_PANELS;
      const x1 = mid.x - rx + (rx * 2 * (i + 1)) / UMBRELLA_PANELS;
      const xm = (x0 + x1) / 2;
      ctx.quadraticCurveTo(xm, rimY + scallop, x1, rimY);
    }
    ctx.quadraticCurveTo(mid.x + rx * 0.55, tip.y + ry * 0.15, tip.x, tip.y);
    ctx.quadraticCurveTo(mid.x - rx * 0.55, tip.y + ry * 0.15, mid.x - rx, rimY);
    ctx.stroke();

    // Specular sheen on the left panels.
    ctx.beginPath();
    ctx.moveTo(mid.x - rx * 0.78, rimY + scallop * 0.1);
    ctx.quadraticCurveTo(
      mid.x - rx * 0.45,
      tip.y + ry * 0.55,
      tip.x - 4 * z,
      tip.y + 8 * z
    );
    ctx.quadraticCurveTo(
      mid.x - rx * 0.55,
      tip.y + ry * 0.85,
      mid.x - rx * 0.25,
      rimY + scallop * 0.2
    );
    ctx.closePath();
    ctx.fillStyle = "rgba(255, 230, 236, 0.28)";
    ctx.fill();

    // Cute tip finial.
    const tipR = 3.2 * z;
    const tipGrad = ctx.createRadialGradient(
      tip.x - tipR * 0.25,
      tip.y - tipR * 0.2,
      tipR * 0.1,
      tip.x,
      tip.y,
      tipR * 1.4
    );
    tipGrad.addColorStop(0, "#ffe7a8");
    tipGrad.addColorStop(0.55, "#f0c45a");
    tipGrad.addColorStop(1, "#c9922e");
    ctx.fillStyle = tipGrad;
    ctx.beginPath();
    ctx.arc(tip.x, tip.y - tipR * 0.15, tipR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(120, 80, 20, 0.45)";
    ctx.lineWidth = Math.max(0.8, 1 * z);
    ctx.stroke();

    ctx.restore();
  }

  function paint(): void {
    if (!backCtx || !frontCtx) return;
    backCtx.setTransform(1, 0, 0, 1, 0, 0);
    frontCtx.setTransform(1, 0, 0, 1, 0, 0);
    backCtx.clearRect(0, 0, back.width, back.height);
    frontCtx.clearRect(0, 0, front.width, front.height);

    const cam = opts.getCamera();
    const roofs = opts.getRoofs();
    const roofById = new Map(roofs.map((r) => [r.id, r]));
    const u = umbrellaOpen() ? umbrella : null;
    const canopy = u ? canopyCenter(u) : null;

    for (const drop of drops) {
      if (drop.kind === "fall") {
        if (isHidden(drop.x, drop.y, -50)) continue;
        // Hide streaks still behind / under the open canopy.
        if (
          canopy &&
          Math.abs(drop.x - canopy.x) < UMBRELLA_RX * 0.92 &&
          drop.y > canopy.y - UMBRELLA_RY - 4 &&
          drop.y < canopy.y + 8
        ) {
          continue;
        }
        drawFall(backCtx, drop, cam.zoom);
        continue;
      }
      const roof =
        drop.roofId === GROUND_ID
          ? groundRoof()
          : drop.roofId
            ? roofById.get(drop.roofId)
            : null;
      if (!roof) continue;
      if (isHidden(drop.x, drop.y, roof.z)) continue;
      const ctx = roof.id === GROUND_ID ? backCtx : frontCtx;
      drawBead(ctx, drop, cam.zoom);
    }

    if (u) drawUmbrella(frontCtx, u, cam.zoom);
  }

  function tick(now: number): void {
    if (!enabled) return;
    const dt = Math.min(0.05, (now - lastT) / 1000 || 0.016);
    lastT = now;
    const sm = speedMul();

    spawnAcc += dt;
    const interval = Math.max(0.012, spawnInterval());
    while (spawnAcc >= interval) {
      spawnAcc -= interval;
      spawnDrop();
      if (rainOpts.amount > 0.7) spawnDrop();
    }

    const roofLookup = new Map(allRoofs().map((r) => [r.id, r] as const));

    for (let i = drops.length - 1; i >= 0; i--) {
      const drop = drops[i]!;
      if (drop.kind === "bead") {
        const roof = drop.roofId ? roofLookup.get(drop.roofId) : null;
        if (!roof) {
          drops.splice(i, 1);
          continue;
        }
        drop.y = roof.y + drop.seatY;
        continue;
      }

      const prevY = drop.y;
      drop.x += drop.vx * dt * sm * 0.35 + drop.vy * dt * SLANT;
      drop.y += drop.vy * dt;
      drop.vy += 40 * dt * sm;

      if (
        drop.y > groundY() + 100 ||
        drop.x < opts.world.x - 100 ||
        drop.x > opts.world.x + opts.world.w + 100
      ) {
        drops.splice(i, 1);
        continue;
      }

      const u = umbrellaOpen() ? umbrella : null;
      if (u && hitUmbrella(drop, u, prevY)) {
        shedFromUmbrella(drop, u);
        continue;
      }

      if (tryLand(drop, i)) trimBeads();
    }

    paint();
    raf = requestAnimationFrame(tick);
  }

  function startLoop(): void {
    if (raf) return;
    lastT = performance.now();
    raf = requestAnimationFrame(tick);
  }

  function stopLoop(): void {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function clearAll(): void {
    drops.length = 0;
    paint();
  }

  function dump(roofId: string): void {
    for (let i = drops.length - 1; i >= 0; i--) {
      const drop = drops[i]!;
      if (drop.kind === "bead" && drop.roofId === roofId) {
        drop.kind = "fall";
        drop.roofId = null;
        drop.len = 8 + Math.random() * 12;
        drop.vx = (Math.random() - 0.5) * 60;
        drop.vy = 180 + Math.random() * 120;
      }
    }
  }

  function shake(roofId: string, impulseX: number): void {
    const push = Math.max(-140, Math.min(140, impulseX * 1.8));
    for (const drop of drops) {
      if (drop.kind !== "bead" || drop.roofId !== roofId) continue;
      if (Math.random() > 0.5) continue;
      drop.kind = "fall";
      drop.roofId = null;
      drop.len = 7 + Math.random() * 10;
      drop.vx = push + (Math.random() - 0.5) * 40;
      drop.vy = 160 + Math.random() * 100;
    }
  }

  function setEnabled(on: boolean): void {
    if (enabled === on) return;
    enabled = on;
    opts.viewport.classList.toggle("is-rain", on);
    if (on) {
      resize();
      startLoop();
    } else {
      stopLoop();
      clearAll();
      altHeld = false;
      umbrella = null;
      syncUmbrellaClass();
      if (backCtx) backCtx.clearRect(0, 0, back.width, back.height);
      if (frontCtx) frontCtx.clearRect(0, 0, front.width, front.height);
    }
  }

  const onResize = () => {
    if (!enabled) return;
    resize();
    paint();
  };

  // Blur can leave Alt stuck "down" without a matching keyup.
  function onWindowBlur(): void {
    altHeld = false;
    umbrella = null;
    syncUmbrellaClass();
  }

  opts.viewport.addEventListener("pointermove", onPointerMove);
  opts.viewport.addEventListener("pointerleave", onPointerLeave);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onWindowBlur);
  window.addEventListener("resize", onResize);

  return {
    setEnabled,
    setOptions(next) {
      if (next.amount !== undefined) rainOpts.amount = clamp01(next.amount);
      if (next.speed !== undefined) rainOpts.speed = clamp01(next.speed);
    },
    clearAll,
    isEnabled: () => enabled,
    shake,
    dump,
    destroy() {
      setEnabled(false);
      opts.viewport.removeEventListener("pointermove", onPointerMove);
      opts.viewport.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("resize", onResize);
      back.remove();
      front.remove();
    },
  };
}
