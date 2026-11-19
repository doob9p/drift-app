/**
 * Autumn board leaves — falling maple/oak sprites that land on roofs & desk,
 * tumble in the air, and scatter when the cursor sweeps past.
 */

export type LeafRoof = {
  id: string;
  y: number;
  x: number;
  w: number;
  h: number;
  /** Higher = in front (matches board card z). */
  z: number;
};

export type LeafCamera = {
  x: number;
  y: number;
  zoom: number;
};

export type BoardLeavesWorld = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type BoardLeavesOptions = {
  /** 0–1 leaf fall density. */
  amount: number;
  /** 0–1 fall / tumble speed. */
  speed: number;
};

export type BoardLeaves = {
  setEnabled: (on: boolean) => void;
  setOptions: (next: Partial<BoardLeavesOptions>) => void;
  clearAll: () => void;
  isEnabled: () => boolean;
  shake: (roofId: string, impulseX: number) => void;
  dump: (roofId: string) => void;
  destroy: () => void;
};

const GROUND_Y_PAD = 18;
const GROUND_ID = "__board_ground__";
const MAX_FALL = 160;
const MAX_LANDED = 420;
const SWEEP_R = 28;
const LAND_JITTER = 4;
const SPRITE_DRAW = 18;

const LEAF_SRCS = [
  "/autumn/leaf-maple-red.png",
  "/autumn/leaf-maple-orange.png",
  "/autumn/leaf-maple-yellow.png",
  "/autumn/leaf-oak-brown.png",
] as const;

type Leaf = {
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
  /** Offset from roof top when landed (keeps pile look under shake). */
  seatY: number;
};

function loadImage(src: string): HTMLImageElement {
  const img = new Image();
  img.decoding = "async";
  img.src = src;
  return img;
}

export function createBoardLeaves(opts: {
  viewport: HTMLElement;
  world: BoardLeavesWorld;
  getCamera: () => LeafCamera;
  getRoofs: () => LeafRoof[];
}): BoardLeaves {
  const back = document.createElement("canvas");
  back.className = "board-leaves-canvas board-leaves-back";
  back.setAttribute("aria-hidden", "true");
  const front = document.createElement("canvas");
  front.className = "board-leaves-canvas board-leaves-front";
  front.setAttribute("aria-hidden", "true");
  opts.viewport.appendChild(back);
  opts.viewport.appendChild(front);
  const backCtx = back.getContext("2d");
  const frontCtx = front.getContext("2d");

  const sprites = LEAF_SRCS.map(loadImage);

  let enabled = false;
  let raf = 0;
  let lastT = 0;
  let spawnAcc = 0;
  const leaves: Leaf[] = [];
  let dpr = 1;
  let lastMouse: { x: number; y: number } | null = null;
  let leafOpts: BoardLeavesOptions = {
    amount: 0.55,
    speed: 0.5,
  };

  function clamp01(n: number): number {
    return Math.min(1, Math.max(0, n));
  }

  function spawnInterval(): number {
    return 0.28 - leafOpts.amount * 0.22;
  }

  function speedMul(): number {
    return 0.5 + leafOpts.speed * 1.2;
  }

  function maxFallCap(): number {
    return Math.max(36, Math.floor(MAX_FALL * (0.35 + leafOpts.amount * 0.9)));
  }

  function maxLandedCap(): number {
    return Math.max(80, Math.floor(MAX_LANDED * (0.4 + leafOpts.amount * 0.85)));
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

  function groundRoof(): LeafRoof {
    return {
      id: GROUND_ID,
      x: opts.world.x,
      y: groundY(),
      w: opts.world.w,
      h: 64,
      z: -100,
    };
  }

  function allRoofs(): LeafRoof[] {
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

  function spawnLeaf(): void {
    const fallCount = leaves.filter((l) => l.kind === "fall").length;
    if (fallCount >= maxFallCap()) return;
    const w = opts.world.w;
    leaves.push({
      x: opts.world.x + Math.random() * w,
      y: opts.world.y - 12 - Math.random() * 40,
      vx: (Math.random() - 0.5) * 28,
      vy: 28 + Math.random() * 36,
      rot: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 4.5,
      scale: 0.75 + Math.random() * 0.55,
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
    for (const l of leaves) if (l.kind === "landed") landed += 1;
    if (landed <= cap) return;
    let remove = landed - cap;
    for (let i = 0; i < leaves.length && remove > 0; i++) {
      if (leaves[i]!.kind === "landed") {
        leaves.splice(i, 1);
        i -= 1;
        remove -= 1;
      }
    }
  }

  function tryLand(leaf: Leaf): boolean {
    const roofs = allRoofs().slice().sort((a, b) => a.z - b.z);
    for (const roof of roofs) {
      if (leaf.x < roof.x - 2 || leaf.x > roof.x + roof.w + 2) continue;
      const top = roof.y + (roof.id === GROUND_ID ? 0 : 2);
      if (leaf.y < top - 2 || leaf.y > top + 18) continue;
      if (isHidden(leaf.x, top + 2, roof.z)) continue;
      leaf.kind = "landed";
      leaf.roofId = roof.id;
      leaf.y = top + (Math.random() - 0.5) * LAND_JITTER;
      leaf.seatY = leaf.y - roof.y;
      leaf.vx = 0;
      leaf.vy = 0;
      leaf.spin *= 0.15;
      return true;
    }
    return false;
  }

  function sweepAt(wx: number, wy: number, dx: number, dy: number): void {
    const speed = Math.hypot(dx, dy);
    if (speed < 0.4) return;
    const push = Math.min(420, 90 + speed * 8);
    const nx = dx / speed;
    const ny = dy / speed;
    for (const leaf of leaves) {
      if (leaf.kind !== "landed") continue;
      const d = Math.hypot(leaf.x - wx, leaf.y - wy);
      if (d > SWEEP_R) continue;
      const roof =
        leaf.roofId === GROUND_ID
          ? groundRoof()
          : opts.getRoofs().find((r) => r.id === leaf.roofId);
      if (roof && isHidden(leaf.x, leaf.y, roof.z)) continue;
      leaf.kind = "fall";
      leaf.roofId = null;
      leaf.vx = nx * push * (0.55 + Math.random() * 0.55);
      leaf.vy = ny * push * 0.35 - (40 + Math.random() * 80);
      leaf.spin = (Math.random() - 0.5) * 8;
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

  function drawLeaf(
    ctx: CanvasRenderingContext2D,
    leaf: Leaf,
    camZoom: number
  ): void {
    const img = sprites[leaf.sprite];
    if (!img || !img.complete || img.naturalWidth === 0) return;
    const scr = worldToScreen(leaf.x, leaf.y);
    const size = SPRITE_DRAW * leaf.scale * camZoom * dpr;
    ctx.save();
    ctx.translate(scr.x, scr.y);
    ctx.rotate(leaf.rot);
    ctx.imageSmoothingEnabled = false;
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

    for (const leaf of leaves) {
      if (leaf.kind === "fall") {
        if (isHidden(leaf.x, leaf.y, -50)) continue;
        drawLeaf(backCtx, leaf, cam.zoom);
        continue;
      }
      const roof =
        leaf.roofId === GROUND_ID
          ? groundRoof()
          : leaf.roofId
            ? roofById.get(leaf.roofId)
            : null;
      if (!roof) continue;
      if (isHidden(leaf.x, leaf.y, roof.z)) continue;
      const ctx = roof.id === GROUND_ID ? backCtx : frontCtx;
      drawLeaf(ctx, leaf, cam.zoom);
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
      spawnLeaf();
    }

    const roofLookup = new Map(
      allRoofs().map((r) => [r.id, r] as const)
    );

    for (let i = leaves.length - 1; i >= 0; i--) {
      const leaf = leaves[i]!;
      if (leaf.kind === "landed") {
        const roof = leaf.roofId ? roofLookup.get(leaf.roofId) : null;
        if (!roof) {
          leaf.kind = "fall";
          leaf.roofId = null;
          continue;
        }
        leaf.y = roof.y + leaf.seatY;
        leaf.rot += leaf.spin * dt * 0.2;
        continue;
      }

      leaf.phase += dt * (1.4 + leafOpts.speed);
      leaf.vx += Math.sin(leaf.phase * 2.1) * 18 * dt * sm;
      leaf.vy += 55 * dt * sm;
      leaf.vx *= 1 - 0.35 * dt;
      leaf.x += leaf.vx * dt * sm;
      leaf.y += leaf.vy * dt * sm;
      leaf.rot += leaf.spin * dt * sm;

      if (leaf.y > groundY() + 80 || leaf.x < opts.world.x - 80 || leaf.x > opts.world.x + opts.world.w + 80) {
        leaves.splice(i, 1);
        continue;
      }

      if (tryLand(leaf)) trimLanded();
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
    leaves.length = 0;
    paint();
  }

  function dump(roofId: string): void {
    for (let i = leaves.length - 1; i >= 0; i--) {
      const leaf = leaves[i]!;
      if (leaf.kind === "landed" && leaf.roofId === roofId) {
        leaf.kind = "fall";
        leaf.roofId = null;
        leaf.vy = 40 + Math.random() * 60;
        leaf.vx = (Math.random() - 0.5) * 80;
        leaf.spin = (Math.random() - 0.5) * 6;
      }
    }
  }

  function shake(roofId: string, impulseX: number): void {
    const push = Math.max(-180, Math.min(180, impulseX * 2.2));
    for (const leaf of leaves) {
      if (leaf.kind !== "landed" || leaf.roofId !== roofId) continue;
      if (Math.random() > 0.55) continue;
      leaf.kind = "fall";
      leaf.roofId = null;
      leaf.vx = push + (Math.random() - 0.5) * 40;
      leaf.vy = -30 - Math.random() * 50;
      leaf.spin = (Math.random() - 0.5) * 7;
    }
  }

  function setEnabled(on: boolean): void {
    if (enabled === on) return;
    enabled = on;
    opts.viewport.classList.toggle("is-autumn", on);
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
      if (next.amount !== undefined) leafOpts.amount = clamp01(next.amount);
      if (next.speed !== undefined) leafOpts.speed = clamp01(next.speed);
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
