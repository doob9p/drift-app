/**
 * Rain board overlay — slanted streaks, roof beads, cursor sweep.
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
  let rainOpts: BoardRainOptions = { amount: 0.55, speed: 0.5 };

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

  function onPointerMove(e: PointerEvent): void {
    if (!enabled) return;
    const w = clientToWorld(e.clientX, e.clientY);
    if (lastMouse) {
      sweepAt(w.x, w.y, w.x - lastMouse.x, w.y - lastMouse.y);
    }
    lastMouse = w;
  }

  function onPointerLeave(): void {
    lastMouse = null;
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

  function paint(): void {
    if (!backCtx || !frontCtx) return;
    backCtx.setTransform(1, 0, 0, 1, 0, 0);
    frontCtx.setTransform(1, 0, 0, 1, 0, 0);
    backCtx.clearRect(0, 0, back.width, back.height);
    frontCtx.clearRect(0, 0, front.width, front.height);

    const cam = opts.getCamera();
    const roofs = opts.getRoofs();
    const roofById = new Map(roofs.map((r) => [r.id, r]));

    for (const drop of drops) {
      if (drop.kind === "fall") {
        if (isHidden(drop.x, drop.y, -50)) continue;
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
      if (backCtx) backCtx.clearRect(0, 0, back.width, back.height);
      if (frontCtx) frontCtx.clearRect(0, 0, front.width, front.height);
    }
  }

  const onResize = () => {
    if (!enabled) return;
    resize();
    paint();
  };

  opts.viewport.addEventListener("pointermove", onPointerMove);
  opts.viewport.addEventListener("pointerleave", onPointerLeave);
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
      window.removeEventListener("resize", onResize);
      back.remove();
      front.remove();
    },
  };
}
