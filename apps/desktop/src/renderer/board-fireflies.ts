/**
 * Firefly board overlay — soft drifting points of light that gather toward
 * the cursor and scatter when it moves quickly.
 */

export type FireflyRoof = {
  id: string;
  y: number;
  x: number;
  w: number;
  h: number;
  z: number;
};

export type FireflyCamera = {
  x: number;
  y: number;
  zoom: number;
};

export type BoardFirefliesWorld = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type BoardFirefliesOptions = {
  amount: number;
  speed: number;
};

export type BoardFireflies = {
  setEnabled: (on: boolean) => void;
  setOptions: (next: Partial<BoardFirefliesOptions>) => void;
  clearAll: () => void;
  isEnabled: () => boolean;
  shake: (roofId: string, impulseX: number) => void;
  dump: (roofId: string) => void;
  destroy: () => void;
};

const GROUND_Y_PAD = 18;
const MAX_FLIES = 120;
const ATTRACT_R = 140;

type Fly = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  phase: number;
  blink: number;
  size: number;
  hue: number;
  roofId: string | null;
};

export function createBoardFireflies(opts: {
  viewport: HTMLElement;
  world: BoardFirefliesWorld;
  getCamera: () => FireflyCamera;
  getRoofs: () => FireflyRoof[];
}): BoardFireflies {
  const back = document.createElement("canvas");
  back.className = "board-fireflies-canvas board-fireflies-back";
  back.setAttribute("aria-hidden", "true");
  const front = document.createElement("canvas");
  front.className = "board-fireflies-canvas board-fireflies-front";
  front.setAttribute("aria-hidden", "true");
  opts.viewport.appendChild(back);
  opts.viewport.appendChild(front);
  const backCtx = back.getContext("2d");
  const frontCtx = front.getContext("2d");

  let enabled = false;
  let raf = 0;
  let lastT = 0;
  let spawnAcc = 0;
  const flies: Fly[] = [];
  let dpr = 1;
  let mouse: { x: number; y: number } | null = null;
  let lastMouse: { x: number; y: number } | null = null;
  let flyOpts: BoardFirefliesOptions = { amount: 0.55, speed: 0.5 };

  function clamp01(n: number): number {
    return Math.min(1, Math.max(0, n));
  }

  function maxCap(): number {
    return Math.max(24, Math.floor(MAX_FLIES * (0.3 + flyOpts.amount * 0.95)));
  }

  function spawnInterval(): number {
    return 0.35 - flyOpts.amount * 0.26;
  }

  function speedMul(): number {
    return 0.45 + flyOpts.speed * 1.1;
  }

  function groundY(): number {
    return opts.world.y + opts.world.h - GROUND_Y_PAD;
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

  function spawnFly(): void {
    if (flies.length >= maxCap()) return;
    flies.push({
      x: opts.world.x + Math.random() * opts.world.w,
      y: opts.world.y + opts.world.h * (0.12 + Math.random() * 0.72),
      vx: (Math.random() - 0.5) * 24,
      vy: (Math.random() - 0.5) * 18,
      phase: Math.random() * Math.PI * 2,
      blink: Math.random() * Math.PI * 2,
      size: 1.4 + Math.random() * 2.2,
      hue: 48 + Math.random() * 36,
      roofId: null,
    });
  }

  function onPointerMove(e: PointerEvent): void {
    if (!enabled) return;
    const w = clientToWorld(e.clientX, e.clientY);
    if (lastMouse) {
      const dx = w.x - lastMouse.x;
      const dy = w.y - lastMouse.y;
      const speed = Math.hypot(dx, dy);
      if (speed > 18) {
        // Quick sweep scatters nearby fireflies.
        for (const f of flies) {
          const d = Math.hypot(f.x - w.x, f.y - w.y);
          if (d > 70) continue;
          const push = (1 - d / 70) * speed * 2.2;
          f.vx += (dx / speed) * push;
          f.vy += (dy / speed) * push * 0.7;
        }
      }
    }
    lastMouse = w;
    mouse = w;
  }

  function onPointerLeave(): void {
    mouse = null;
    lastMouse = null;
  }

  function worldToScreen(wx: number, wy: number): { x: number; y: number } {
    const cam = opts.getCamera();
    return {
      x: (wx * cam.zoom + cam.x) * dpr,
      y: (wy * cam.zoom + cam.y) * dpr,
    };
  }

  function isOverFrontRoof(wx: number, wy: number): boolean {
    for (const roof of opts.getRoofs()) {
      if (
        wx >= roof.x &&
        wx <= roof.x + roof.w &&
        wy >= roof.y &&
        wy <= roof.y + Math.min(36, roof.h * 0.2)
      ) {
        return true;
      }
    }
    return false;
  }

  function drawFly(
    ctx: CanvasRenderingContext2D,
    f: Fly,
    camZoom: number
  ): void {
    const glow = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(f.blink));
    if (glow < 0.12) return;
    const scr = worldToScreen(f.x, f.y);
    const r = f.size * camZoom * dpr;
    const g = ctx.createRadialGradient(scr.x, scr.y, 0, scr.x, scr.y, r * 4.5);
    g.addColorStop(0, `hsla(${f.hue}, 95%, 72%, ${glow})`);
    g.addColorStop(0.25, `hsla(${f.hue}, 90%, 58%, ${glow * 0.45})`);
    g.addColorStop(1, `hsla(${f.hue}, 80%, 45%, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(scr.x, scr.y, r * 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `hsla(${f.hue}, 100%, 88%, ${Math.min(1, glow + 0.15)})`;
    ctx.beginPath();
    ctx.arc(scr.x, scr.y, Math.max(0.6, r * 0.55), 0, Math.PI * 2);
    ctx.fill();
  }

  function paint(): void {
    if (!backCtx || !frontCtx) return;
    backCtx.setTransform(1, 0, 0, 1, 0, 0);
    frontCtx.setTransform(1, 0, 0, 1, 0, 0);
    backCtx.clearRect(0, 0, back.width, back.height);
    frontCtx.clearRect(0, 0, front.width, front.height);

    const cam = opts.getCamera();
    for (const f of flies) {
      const ctx = isOverFrontRoof(f.x, f.y) ? frontCtx : backCtx;
      drawFly(ctx, f, cam.zoom);
    }
  }

  function tick(now: number): void {
    if (!enabled) return;
    const dt = Math.min(0.05, (now - lastT) / 1000 || 0.016);
    lastT = now;
    const sm = speedMul();

    spawnAcc += dt;
    const interval = Math.max(0.08, spawnInterval());
    while (spawnAcc >= interval) {
      spawnAcc -= interval;
      spawnFly();
    }

    const gy = groundY();
    for (let i = flies.length - 1; i >= 0; i--) {
      const f = flies[i]!;
      f.phase += dt * (0.8 + flyOpts.speed);
      f.blink += dt * (2.2 + Math.random() * 0.4);

      // Soft wander.
      f.vx += Math.sin(f.phase * 1.3) * 14 * dt * sm;
      f.vy += Math.cos(f.phase * 0.9) * 10 * dt * sm;

      // Gentle pull toward cursor.
      if (mouse) {
        const dx = mouse.x - f.x;
        const dy = mouse.y - f.y;
        const d = Math.hypot(dx, dy);
        if (d < ATTRACT_R && d > 8) {
          const pull = (1 - d / ATTRACT_R) * 55 * dt * sm;
          f.vx += (dx / d) * pull;
          f.vy += (dy / d) * pull;
        }
      }

      f.vx *= 1 - 0.55 * dt;
      f.vy *= 1 - 0.55 * dt;
      f.x += f.vx * dt * sm;
      f.y += f.vy * dt * sm;

      // Soft world bounds — wrap horizontally, bounce vertically.
      if (f.x < opts.world.x - 20) f.x = opts.world.x + opts.world.w + 10;
      if (f.x > opts.world.x + opts.world.w + 20) f.x = opts.world.x - 10;
      if (f.y < opts.world.y + 20) {
        f.y = opts.world.y + 20;
        f.vy = Math.abs(f.vy) * 0.4;
      }
      if (f.y > gy - 8) {
        f.y = gy - 8;
        f.vy = -Math.abs(f.vy) * 0.5;
      }
    }

    while (flies.length > maxCap()) flies.shift();

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
    flies.length = 0;
    paint();
  }

  function dump(roofId: string): void {
    const roof = opts.getRoofs().find((r) => r.id === roofId);
    if (!roof) return;
    const cx = roof.x + roof.w * 0.5;
    const cy = roof.y + 10;
    for (const f of flies) {
      if (
        f.x < roof.x - 20 ||
        f.x > roof.x + roof.w + 20 ||
        f.y < roof.y - 40 ||
        f.y > roof.y + 50
      ) {
        continue;
      }
      f.vx += (f.x - cx) * 0.08 + (Math.random() - 0.5) * 40;
      f.vy -= 30 + Math.random() * 50;
    }
  }

  function shake(roofId: string, impulseX: number): void {
    const roof = opts.getRoofs().find((r) => r.id === roofId);
    if (!roof) return;
    const push = Math.max(-120, Math.min(120, impulseX * 1.6));
    for (const f of flies) {
      if (
        f.x < roof.x - 20 ||
        f.x > roof.x + roof.w + 20 ||
        f.y < roof.y - 40 ||
        f.y > roof.y + 40
      ) {
        continue;
      }
      f.vx += push * (0.5 + Math.random() * 0.6);
      f.vy -= 10 + Math.random() * 20;
    }
  }

  function setEnabled(on: boolean): void {
    if (enabled === on) return;
    enabled = on;
    opts.viewport.classList.toggle("is-fireflies", on);
    if (on) {
      resize();
      const n = Math.floor(18 + flyOpts.amount * 28);
      for (let i = 0; i < n; i++) spawnFly();
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
      if (next.amount !== undefined) flyOpts.amount = clamp01(next.amount);
      if (next.speed !== undefined) flyOpts.speed = clamp01(next.speed);
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
