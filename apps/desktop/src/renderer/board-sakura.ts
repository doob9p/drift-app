/**
 * Sakura board petals — soft pink blossoms that drift, land on roofs & desk,
 * and scatter when the cursor sweeps past.
 */

export type SakuraRoof = {
  id: string;
  y: number;
  x: number;
  w: number;
  h: number;
  /** Higher = in front (matches board card z). */
  z: number;
};

export type SakuraCamera = {
  x: number;
  y: number;
  zoom: number;
};

export type BoardSakuraWorld = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type BoardSakuraOptions = {
  /** 0–1 petal fall density. */
  amount: number;
  /** 0–1 fall / flutter speed. */
  speed: number;
};

export type BoardSakura = {
  setEnabled: (on: boolean) => void;
  setOptions: (next: Partial<BoardSakuraOptions>) => void;
  clearAll: () => void;
  isEnabled: () => boolean;
  shake: (roofId: string, impulseX: number) => void;
  dump: (roofId: string) => void;
  destroy: () => void;
};

const GROUND_Y_PAD = 18;
const GROUND_ID = "__board_ground__";
const MAX_FALL = 150;
const MAX_LANDED = 380;
const SWEEP_R = 30;
const LAND_JITTER = 3;
const SPRITE_DRAW = 16;

const PETAL_SRCS = [
  "/sakura/petal-pink.png",
  "/sakura/petal-blush.png",
  "/sakura/petal-soft.png",
  "/sakura/petal-deep.png",
] as const;

type Petal = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  spin: number;
  scale: number;
  sprite: number;
  phase: number;
  kind: "fall" | "landed";
  roofId: string | null;
  seatY: number;
};

function loadImage(src: string): HTMLImageElement {
  const img = new Image();
  img.decoding = "async";
  img.src = src;
  return img;
}

export function createBoardSakura(opts: {
  viewport: HTMLElement;
  world: BoardSakuraWorld;
  getCamera: () => SakuraCamera;
  getRoofs: () => SakuraRoof[];
}): BoardSakura {
  const back = document.createElement("canvas");
  back.className = "board-sakura-canvas board-sakura-back";
  back.setAttribute("aria-hidden", "true");
  const front = document.createElement("canvas");
  front.className = "board-sakura-canvas board-sakura-front";
  front.setAttribute("aria-hidden", "true");
  opts.viewport.appendChild(back);
  opts.viewport.appendChild(front);
  const backCtx = back.getContext("2d");
  const frontCtx = front.getContext("2d");

  const sprites = PETAL_SRCS.map(loadImage);

  let enabled = false;
  let raf = 0;
  let lastT = 0;
  let spawnAcc = 0;
  const petals: Petal[] = [];
  let dpr = 1;
  let lastMouse: { x: number; y: number } | null = null;
  let sakuraOpts: BoardSakuraOptions = {
    amount: 0.55,
    speed: 0.5,
  };

  function clamp01(n: number): number {
    return Math.min(1, Math.max(0, n));
  }

  function spawnInterval(): number {
    return 0.3 - sakuraOpts.amount * 0.22;
  }

  function speedMul(): number {
    return 0.4 + sakuraOpts.speed * 1.05;
  }

  function maxFallCap(): number {
    return Math.max(32, Math.floor(MAX_FALL * (0.35 + sakuraOpts.amount * 0.9)));
  }

  function maxLandedCap(): number {
    return Math.max(
      70,
      Math.floor(MAX_LANDED * (0.4 + sakuraOpts.amount * 0.85))
    );
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

  function groundRoof(): SakuraRoof {
    return {
      id: GROUND_ID,
      x: opts.world.x,
      y: groundY(),
      w: opts.world.w,
      h: 64,
      z: -100,
    };
  }

  function allRoofs(): SakuraRoof[] {
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

  function spawnPetal(): void {
    const fallCount = petals.filter((p) => p.kind === "fall").length;
    if (fallCount >= maxFallCap()) return;
    const w = opts.world.w;
    petals.push({
      x: opts.world.x + Math.random() * w,
      y: opts.world.y - 12 - Math.random() * 48,
      vx: 12 + Math.random() * 28,
      vy: 12 + Math.random() * 22,
      rot: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 2.8,
      scale: 0.7 + Math.random() * 0.55,
      sprite: Math.floor(Math.random() * sprites.length),
      phase: Math.random() * Math.PI * 2,
      kind: "fall",
      roofId: null,
      seatY: 0,
    });
  }

  function trimLanded(): void {
    const cap = maxLandedCap();
    let landed = 0;
    for (const p of petals) if (p.kind === "landed") landed += 1;
    if (landed <= cap) return;
    let remove = landed - cap;
    for (let i = 0; i < petals.length && remove > 0; i++) {
      if (petals[i]!.kind === "landed") {
        petals.splice(i, 1);
        i -= 1;
        remove -= 1;
      }
    }
  }

  function tryLand(petal: Petal): boolean {
    const roofs = allRoofs().slice().sort((a, b) => a.z - b.z);
    for (const roof of roofs) {
      if (petal.x < roof.x - 2 || petal.x > roof.x + roof.w + 2) continue;
      const top = roof.y + (roof.id === GROUND_ID ? 0 : 2);
      if (petal.y < top - 2 || petal.y > top + 16) continue;
      if (isHidden(petal.x, top + 2, roof.z)) continue;
      petal.kind = "landed";
      petal.roofId = roof.id;
      petal.y = top + (Math.random() - 0.5) * LAND_JITTER;
      petal.seatY = petal.y - roof.y;
      petal.vx = 0;
      petal.vy = 0;
      petal.spin *= 0.12;
      return true;
    }
    return false;
  }

  function sweepAt(wx: number, wy: number, dx: number, dy: number): void {
    const speed = Math.hypot(dx, dy);
    if (speed < 0.4) return;
    const push = Math.min(380, 80 + speed * 7);
    const nx = dx / speed;
    const ny = dy / speed;
    for (const petal of petals) {
      if (petal.kind !== "landed") continue;
      const d = Math.hypot(petal.x - wx, petal.y - wy);
      if (d > SWEEP_R) continue;
      const roof =
        petal.roofId === GROUND_ID
          ? groundRoof()
          : opts.getRoofs().find((r) => r.id === petal.roofId);
      if (roof && isHidden(petal.x, petal.y, roof.z)) continue;
      petal.kind = "fall";
      petal.roofId = null;
      petal.vx = nx * push * (0.5 + Math.random() * 0.6) + 20;
      petal.vy = ny * push * 0.3 - (50 + Math.random() * 70);
      petal.spin = (Math.random() - 0.5) * 6;
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

  function drawPetal(
    ctx: CanvasRenderingContext2D,
    petal: Petal,
    camZoom: number
  ): void {
    const img = sprites[petal.sprite];
    if (!img || !img.complete || img.naturalWidth === 0) return;
    const scr = worldToScreen(petal.x, petal.y);
    const size = SPRITE_DRAW * petal.scale * camZoom * dpr;
    ctx.save();
    ctx.translate(scr.x, scr.y);
    ctx.rotate(petal.rot);
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 0.92;
    ctx.drawImage(img, -size / 2, -size / 2, size, size);
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

    for (const petal of petals) {
      if (petal.kind === "fall") {
        if (isHidden(petal.x, petal.y, -50)) continue;
        drawPetal(backCtx, petal, cam.zoom);
        continue;
      }
      const roof =
        petal.roofId === GROUND_ID
          ? groundRoof()
          : petal.roofId
            ? roofById.get(petal.roofId)
            : null;
      if (!roof) continue;
      if (isHidden(petal.x, petal.y, roof.z)) continue;
      const ctx = roof.id === GROUND_ID ? backCtx : frontCtx;
      drawPetal(ctx, petal, cam.zoom);
    }
  }

  function tick(now: number): void {
    if (!enabled) return;
    const dt = Math.min(0.05, (now - lastT) / 1000 || 0.016);
    lastT = now;
    const sm = speedMul();

    spawnAcc += dt;
    const interval = spawnInterval();
    while (spawnAcc >= interval) {
      spawnAcc -= interval;
      spawnPetal();
    }

    const roofLookup = new Map(allRoofs().map((r) => [r.id, r] as const));

    for (let i = petals.length - 1; i >= 0; i--) {
      const petal = petals[i]!;
      if (petal.kind === "landed") {
        const roof = petal.roofId ? roofLookup.get(petal.roofId) : null;
        if (!roof) {
          petal.kind = "fall";
          petal.roofId = null;
          continue;
        }
        petal.y = roof.y + petal.seatY;
        petal.rot += petal.spin * dt * 0.15;
        continue;
      }

      // Soft flutter + gentle side breeze (sakura drift).
      petal.phase += dt * (1.1 + sakuraOpts.speed * 0.8);
      petal.vx += Math.sin(petal.phase * 1.7) * 22 * dt * sm;
      petal.vx += 6 * dt;
      petal.vy += 28 * dt * sm;
      petal.vx *= 1 - 0.22 * dt;
      petal.x += petal.vx * dt * sm;
      petal.y += petal.vy * dt * sm;
      petal.rot += petal.spin * dt * sm;

      if (
        petal.y > groundY() + 80 ||
        petal.x < opts.world.x - 80 ||
        petal.x > opts.world.x + opts.world.w + 80
      ) {
        petals.splice(i, 1);
        continue;
      }

      if (tryLand(petal)) trimLanded();
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
    petals.length = 0;
    paint();
  }

  function dump(roofId: string): void {
    for (let i = petals.length - 1; i >= 0; i--) {
      const petal = petals[i]!;
      if (petal.kind === "landed" && petal.roofId === roofId) {
        petal.kind = "fall";
        petal.roofId = null;
        petal.vy = 20 + Math.random() * 40;
        petal.vx = 20 + (Math.random() - 0.5) * 70;
        petal.spin = (Math.random() - 0.5) * 4;
      }
    }
  }

  function shake(roofId: string, impulseX: number): void {
    const push = Math.max(-160, Math.min(160, impulseX * 2));
    for (const petal of petals) {
      if (petal.kind !== "landed" || petal.roofId !== roofId) continue;
      if (Math.random() > 0.6) continue;
      petal.kind = "fall";
      petal.roofId = null;
      petal.vx = push + (Math.random() - 0.5) * 36;
      petal.vy = -40 - Math.random() * 45;
      petal.spin = (Math.random() - 0.5) * 5;
    }
  }

  function setEnabled(on: boolean): void {
    if (enabled === on) return;
    enabled = on;
    opts.viewport.classList.toggle("is-sakura", on);
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
      if (next.amount !== undefined) sakuraOpts.amount = clamp01(next.amount);
      if (next.speed !== undefined) sakuraOpts.speed = clamp01(next.speed);
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
