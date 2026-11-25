import type {
  FlowDef,
  FlowEvent,
  FlowStep,
  SavedSession,
} from "@drift/core";
import { newId } from "@drift/core";
import {
  createLocalPty,
  type LocalPtyBackend,
} from "@drift/host-local";
import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import {
  createSshPty,
  uploadFilesViaScp,
  type SshPtyBackend,
} from "@drift/host-ssh";

type Backend = LocalPtyBackend | SshPtyBackend;

export type FlowRunnerDeps = {
  getFlow: (id: string) => Promise<FlowDef | null>;
  findBackend: (pred: (b: Backend) => boolean) => Backend | null;
  getSession: (id: string) => SavedSession | undefined;
  loadSshPassword: (sessionId: string) => Promise<string | null>;
  localPtyOpts: (size?: { cols?: number; rows?: number }) => {
    cols?: number;
    rows?: number;
    shellKind?: "powershell" | "cmd" | "gitbash";
  };
  emit: (event: FlowEvent) => void;
};

type ActiveRun = {
  runId: string;
  flowId: string;
  cardId?: string;
  abort: AbortController;
  approveWaiters: Map<
    string,
    { resolve: (ok: boolean) => void }
  >;
  /** Live stdin writer for the current local/ssh step (interactive prompts). */
  stdinWrite: ((data: string) => void) | null;
  /** True after aborted/finished was emitted — prevents duplicate terminal events. */
  terminalEmitted: boolean;
};

function parseAutoInputs(step: FlowStep): string[] {
  return (step.autoInputs || [])
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.length > 0);
}

/** Detect interactive prompts in streamed PTY/SSH output. */
function looksLikePrompt(text: string): boolean {
  const cleaned = text.replace(/\r/g, "");
  const lines = cleaned.split("\n");
  let last = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.trim()) {
      last = line;
      break;
    }
  }
  if (!last) return false;
  if (/password\s*:\s*$/i.test(last)) return true;
  if (/yes\s*\/\s*no/i.test(last)) return true;
  if (/계정명/i.test(last)) return true;
  if (
    /fingerprint/i.test(last) &&
    /continue connecting/i.test(cleaned.slice(-500))
  ) {
    return true;
  }
  // Avoid bare shell prompts and transfer progress lines.
  if (/[$#]\s*$/.test(last)) return false;
  if (/%\s*$/.test(last) || /\bETA\b/i.test(last)) return false;
  // Generic question / read prompts only (short trailing "…?" / "…:").
  if (last.length > 160) return false;
  return /[?？]\s*$/.test(last) || /[:：]\s*$/.test(last);
}

function wrapWithAutoInputs(
  run: ActiveRun,
  answers: string[],
  onChunk: ((chunk: string) => void) | undefined
): ((chunk: string) => void) | undefined {
  if (!answers.length) return onChunk;
  const queue = [...answers];
  let buf = "";
  /** Output that arrives while a reply is in flight (next prompt). */
  let afterSend = "";
  let busy = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleRetry = (ms: number) => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      trySend();
    }, ms);
  };

  const trySend = () => {
    if (!queue.length || busy) return;
    if (!looksLikePrompt(buf)) return;
    if (!run.stdinWrite) {
      scheduleRetry(120);
      return;
    }
    busy = true;
    afterSend = "";
    const next = queue.shift()!;
    const payload = next.endsWith("\n") ? next : `${next}\n`;
    setTimeout(() => {
      try {
        run.stdinWrite?.(payload);
      } finally {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          settleTimer = null;
          busy = false;
          // Drop the consumed prompt; keep only output that arrived after send.
          buf = afterSend;
          afterSend = "";
          trySend();
          if (queue.length) scheduleRetry(300);
        }, 300);
      }
    }, 60);
  };

  return (chunk: string) => {
    onChunk?.(chunk);
    if (!queue.length) return;
    if (busy) {
      afterSend = (afterSend + chunk).slice(-6_000);
      return;
    }
    buf = (buf + chunk).slice(-6_000);
    trySend();
  };
}

export function createFlowRunner(deps: FlowRunnerDeps) {
  const active = new Map<string, ActiveRun>();

  function emit(event: FlowEvent): void {
    deps.emit(event);
  }

  /** Multi-line local scripts: stop on first failure (unix). */
  function wrapLocalScript(command: string): string {
    if (process.platform === "win32") return command;
    const trimmed = command.trim();
    if (!trimmed.includes("\n")) return trimmed;
    return `set -e\n${trimmed}`;
  }

  /**
   * Keep flow logs close to a real terminal: drop Drift chrome, ANSI codes,
   * and interactive-shell noise (job control, oh-my-zsh, …).
   */
  function sanitizeFlowChunk(chunk: string): string {
    let s = chunk
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
      .replace(/\u001b[()][0-9A-Za-z]/g, "")
      .replace(/\u001b./g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
    const noise =
      /cannot set terminal process group|no job control|Inappropriate ioctl|^\s*\[oh-my-zsh\]|^\s*Using Node|^\s*npm warn Unknown env config|^\$ cd /i;
    return s
      .split("\n")
      .filter((line) => {
        if (noise.test(line)) return false;
        // Drop leftover Drift prompt echoes like "$ ll" when they are the
        // only token after $ (real shell output rarely looks like this alone).
        if (/^\$\s+\S+$/.test(line.trim())) return false;
        return true;
      })
      .join("\n");
  }

  function makeChunkEmitter(base: {
    runId: string;
    flowId: string;
    cardId?: string;
    stepId: string;
  }): {
    onChunk: (chunk: string) => void;
    flush: () => void;
  } {
    let pending = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!pending) return;
      const chunk = sanitizeFlowChunk(pending);
      pending = "";
      if (!chunk) return;
      emit({ type: "output", ...base, chunk });
    };
    const onChunk = (chunk: string) => {
      if (!chunk) return;
      pending += chunk;
      if (pending.length > 4_000) {
        flush();
        return;
      }
      if (!timer) {
        timer = setTimeout(flush, 40);
      }
    };
    return { onChunk, flush };
  }

  async function execLocal(
    run: ActiveRun,
    command: string,
    timeoutMs: number,
    cwd: string | undefined,
    onChunk: ((chunk: string) => void) | undefined,
    abortSignal: AbortSignal
  ): Promise<{ exitCode: number | null; output: string }> {
    const script = wrapLocalScript(command);
    const execOpts = {
      timeoutMs,
      cwd: cwd || undefined,
      onChunk,
      abortSignal,
      onStdin: (write: (data: string) => void) => {
        run.stdinWrite = write;
      },
    };
    const existing = deps.findBackend((b) => b.target.kind === "local");
    try {
      if (existing) {
        const result = await existing.exec(script, execOpts);
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
        return { exitCode: result.exitCode, output };
      }
      const backend = createLocalPty(deps.localPtyOpts({ cols: 80, rows: 24 }));
      try {
        const result = await backend.exec(script, execOpts);
        const output = [result.stdout, result.stderr]
          .filter(Boolean)
          .join("\n");
        return { exitCode: result.exitCode, output };
      } finally {
        await backend.dispose();
      }
    } finally {
      run.stdinWrite = null;
    }
  }

  async function execSsh(
    run: ActiveRun,
    sessionId: string,
    command: string,
    timeoutMs: number,
    cwd: string | undefined,
    onChunk: ((chunk: string) => void) | undefined,
    abortSignal: AbortSignal
  ): Promise<{ exitCode: number | null; output: string }> {
    const execOpts = {
      timeoutMs,
      cwd: cwd || undefined,
      onChunk,
      abortSignal,
      onStdin: (write: (data: string) => void) => {
        run.stdinWrite = write;
      },
    };
    const existing = deps.findBackend(
      (b) => b.target.kind === "ssh" && b.target.sessionId === sessionId
    );
    try {
      if (existing) {
        const result = await existing.exec(command, execOpts);
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
        return { exitCode: result.exitCode, output };
      }
      const session = deps.getSession(sessionId);
      if (!session) {
        throw new Error(`SSH session not found: ${sessionId}`);
      }
      const password = await deps.loadSshPassword(session.id);
      const backend = createSshPty(session, {
        cols: 80,
        rows: 24,
        password: password || undefined,
      });
      try {
        const result = await backend.exec(command, execOpts);
        const output = [result.stdout, result.stderr]
          .filter(Boolean)
          .join("\n");
        return { exitCode: result.exitCode, output };
      } finally {
        await backend.dispose();
      }
    } finally {
      run.stdinWrite = null;
    }
  }

  async function runStep(
    run: ActiveRun,
    step: FlowStep
  ): Promise<"ok" | "fail" | "aborted"> {
    if (run.abort.signal.aborted) return "aborted";

    const base = {
      runId: run.runId,
      flowId: run.flowId,
      cardId: run.cardId,
      stepId: step.id,
    };

    if (step.kind === "approve") {
      emit({
        type: "step",
        ...base,
        status: "waiting",
      });
      emit({
        type: "waiting",
        ...base,
        label: step.label,
      });
      const ok = await new Promise<boolean>((resolve) => {
        run.approveWaiters.set(step.id, { resolve });
        run.abort.signal.addEventListener(
          "abort",
          () => {
            run.approveWaiters.delete(step.id);
            resolve(false);
          },
          { once: true }
        );
      });
      if (!ok || run.abort.signal.aborted) {
        emit({ type: "step", ...base, status: "fail", error: "Cancelled" });
        return "aborted";
      }
      emit({ type: "step", ...base, status: "ok" });
      return "ok";
    }

    if (step.kind === "upload") {
      const sessionId = (step.sessionId || "").trim();
      if (!sessionId) {
        emit({
          type: "step",
          ...base,
          status: "fail",
          error: "SSH session not selected",
        });
        return "fail";
      }
      const session = deps.getSession(sessionId);
      if (!session) {
        emit({
          type: "step",
          ...base,
          status: "fail",
          error: `SSH session not found: ${sessionId}`,
        });
        return "fail";
      }
      const paths = (step.paths || []).map((p) => p.trim()).filter(Boolean);
      if (!paths.length) {
        emit({
          type: "step",
          ...base,
          status: "fail",
          error: "No files to upload",
        });
        return "fail";
      }
      emit({ type: "step", ...base, status: "running" });
      const timeoutMs = step.timeoutMs ?? 600_000;
      const baseDir = step.cwd?.trim() || os.homedir();
      const remoteDir = step.remoteDir?.trim() || "~";
      const localPaths = paths.map((p) =>
        path.isAbsolute(p) ? p : path.resolve(baseDir, p)
      );
      const missing = localPaths.filter((p) => !existsSync(p));
      if (missing.length) {
        const msg = `Local file not found:\n${missing.map((p) => `  ${p}`).join("\n")}`;
        emit({ type: "output", ...base, chunk: `${msg}\n` });
        emit({ type: "step", ...base, status: "fail", error: "Local file not found" });
        return "fail";
      }
      try {
        const password = await deps.loadSshPassword(session.id);
        if (!password?.trim() && !session.identityFile?.trim()) {
          const msg =
            "No SSH password or key for this session. Save the password on the SSH host (or set an identity file), then retry.";
          emit({ type: "step", ...base, status: "fail", error: msg });
          return "fail";
        }
        const result = await uploadFilesViaScp(
          session,
          localPaths,
          remoteDir,
          {
            timeoutMs,
            password: password || undefined,
            abortSignal: run.abort.signal,
          }
        );
        if (
          run.abort.signal.aborted ||
          ("error" in result && result.error === "Aborted")
        ) {
          emit({ type: "step", ...base, status: "fail", error: "Stopped" });
          return "aborted";
        }
        if ("error" in result) {
          emit({
            type: "output",
            ...base,
            chunk: `${sanitizeFlowChunk(result.error)}\n`,
          });
          emit({
            type: "step",
            ...base,
            status: "fail",
            error: result.error,
          });
          return "fail";
        }
        emit({
          type: "step",
          ...base,
          status: "ok",
        });
        return "ok";
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit({ type: "output", ...base, chunk: `${message}\n` });
        emit({ type: "step", ...base, status: "fail", error: message });
        return "fail";
      }
    }

    const command = (step.command || "").trim();
    if (!command) {
      emit({
        type: "step",
        ...base,
        status: "fail",
        error: "Empty command",
      });
      return "fail";
    }

    if (step.kind === "ssh" && !(step.sessionId || "").trim()) {
      emit({
        type: "step",
        ...base,
        status: "fail",
        error: "SSH session not selected",
      });
      return "fail";
    }

    emit({ type: "step", ...base, status: "running" });
    const cwd = step.cwd?.trim() || undefined;
    const stream = makeChunkEmitter(base);
    const onChunk = wrapWithAutoInputs(
      run,
      parseAutoInputs(step),
      stream.onChunk
    );
    const timeoutMs = step.timeoutMs ?? 600_000;
    try {
      const result =
        step.kind === "local"
          ? await execLocal(
              run,
              command,
              timeoutMs,
              cwd,
              onChunk,
              run.abort.signal
            )
          : await execSsh(
              run,
              step.sessionId!,
              command,
              timeoutMs,
              cwd,
              onChunk,
              run.abort.signal
            );
      stream.flush();
      if (run.abort.signal.aborted) {
        emit({ type: "step", ...base, status: "fail", error: "Stopped" });
        return "aborted";
      }
      const code = result.exitCode ?? 1;
      const ok = code === 0;
      // Keep streamed log in the UI; only update status / exit.
      emit({
        type: "step",
        ...base,
        status: ok ? "ok" : "fail",
        exitCode: result.exitCode,
        error: ok ? undefined : `Exit ${code}`,
      });
      return ok ? "ok" : "fail";
    } catch (err) {
      stream.flush();
      if (run.abort.signal.aborted) {
        emit({ type: "step", ...base, status: "fail", error: "Stopped" });
        return "aborted";
      }
      const message = err instanceof Error ? err.message : String(err);
      emit({
        type: "output",
        ...base,
        chunk: `${message}\n`,
      });
      emit({
        type: "step",
        ...base,
        status: "fail",
        error: message,
      });
      return "fail";
    }
  }

  return {
    async start(input: {
      flowId: string;
      cardId?: string;
    }): Promise<{ runId: string } | { error: string }> {
      const flow = await deps.getFlow(input.flowId);
      if (!flow) return { error: "Flow not found" };
      if (flow.steps.length === 0) return { error: "Flow has no steps" };

      const runId = newId();
      const run: ActiveRun = {
        runId,
        flowId: flow.id,
        cardId: input.cardId,
        abort: new AbortController(),
        approveWaiters: new Map(),
        stdinWrite: null,
        terminalEmitted: false,
      };
      active.set(runId, run);

      emit({
        type: "started",
        runId,
        flowId: flow.id,
        cardId: input.cardId,
      });

      void (async () => {
        let failed = false;
        let aborted = false;
        try {
          for (const step of flow.steps) {
            if (run.abort.signal.aborted) {
              aborted = true;
              break;
            }
            if (failed) {
              emit({
                type: "step",
                runId,
                flowId: flow.id,
                cardId: input.cardId,
                stepId: step.id,
                status: "skipped",
              });
              continue;
            }
            const result = await runStep(run, step);
            if (result === "aborted") {
              aborted = true;
              break;
            }
            if (result === "fail") failed = true;
          }
        } finally {
          active.delete(runId);
          run.stdinWrite = null;
          if (run.terminalEmitted) return;
          run.terminalEmitted = true;
          if (aborted || run.abort.signal.aborted) {
            emit({
              type: "aborted",
              runId,
              flowId: flow.id,
              cardId: input.cardId,
            });
            return;
          }
          emit({
            type: "finished",
            runId,
            flowId: flow.id,
            cardId: input.cardId,
            status: failed ? "error" : "done",
            error: failed ? "A step failed" : undefined,
          });
        }
      })();

      return { runId };
    },

    approve(runId: string, stepId: string): { ok: true } | { error: string } {
      const run = active.get(runId);
      if (!run) return { error: "Run not found" };
      if (run.terminalEmitted || run.abort.signal.aborted) {
        return { error: "Run is stopping" };
      }
      const waiter = run.approveWaiters.get(stepId);
      if (!waiter) return { error: "Step is not waiting" };
      run.approveWaiters.delete(stepId);
      waiter.resolve(true);
      return { ok: true };
    },

    writeStdin(
      runId: string,
      data: string
    ): { ok: true } | { error: string } {
      const run = active.get(runId);
      if (!run) return { error: "Run not found" };
      if (run.terminalEmitted || run.abort.signal.aborted) {
        return { error: "Run is stopping" };
      }
      if (!run.stdinWrite) return { error: "Step is not accepting input" };
      const text = data.endsWith("\n") ? data : `${data}\n`;
      try {
        run.stdinWrite(text);
        return { ok: true };
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    abort(runId?: string): { stopped: string[] } {
      const stopped: string[] = [];
      for (const [id, run] of [...active.entries()]) {
        if (runId && id !== runId) continue;
        for (const [, w] of run.approveWaiters) w.resolve(false);
        run.approveWaiters.clear();
        run.stdinWrite = null;
        run.abort.abort();
        // Keep the run in `active` until the async loop finishes so it can
        // observe the abort and emit a single terminal event.
        if (!run.terminalEmitted) {
          run.terminalEmitted = true;
          stopped.push(id);
          emit({
            type: "aborted",
            runId: id,
            flowId: run.flowId,
            cardId: run.cardId,
          });
        }
      }
      return { stopped };
    },
  };
}

export type FlowRunner = ReturnType<typeof createFlowRunner>;
