import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { newId, type FlowDef, type FlowStep } from "@drift/core";

function normalizeStep(raw: unknown): FlowStep | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const kind = s.kind;
  if (
    kind !== "local" &&
    kind !== "ssh" &&
    kind !== "approve" &&
    kind !== "upload"
  ) {
    return null;
  }
  const id = typeof s.id === "string" && s.id ? s.id : newId();
  const label =
    typeof s.label === "string" && s.label.trim()
      ? s.label.trim()
      : kind === "approve"
        ? "Approve"
        : kind === "upload"
          ? "Upload"
          : "Command";
  const step: FlowStep = { id, kind, label };
  if (typeof s.command === "string") step.command = s.command;
  if (typeof s.cwd === "string" && s.cwd.trim()) step.cwd = s.cwd.trim();
  if (typeof s.sessionId === "string" && s.sessionId) {
    step.sessionId = s.sessionId;
  }
  if (typeof s.remoteDir === "string" && s.remoteDir.trim()) {
    step.remoteDir = s.remoteDir.trim();
  }
  if (Array.isArray(s.paths)) {
    step.paths = s.paths
      .filter((p): p is string => typeof p === "string")
      .map((p) => p.trim())
      .filter(Boolean);
  }
  if (Array.isArray(s.autoInputs)) {
    step.autoInputs = s.autoInputs
      .filter((p): p is string => typeof p === "string")
      .map((p) => p.replace(/\r$/, ""))
      .filter((p) => p.length > 0);
  } else if (typeof s.autoInputs === "string" && s.autoInputs.trim()) {
    step.autoInputs = s.autoInputs
      .split("\n")
      .map((p) => p.replace(/\r$/, ""))
      .filter((p) => p.length > 0);
  }
  if (typeof s.timeoutMs === "number" && Number.isFinite(s.timeoutMs)) {
    step.timeoutMs = Math.max(1_000, Math.min(3_600_000, s.timeoutMs));
  }
  return step;
}

function normalizeFlow(raw: unknown): FlowDef | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  const id = typeof f.id === "string" && f.id ? f.id : newId();
  const name =
    typeof f.name === "string" && f.name.trim() ? f.name.trim() : "Untitled flow";
  const stepsIn = Array.isArray(f.steps) ? f.steps : [];
  const steps = stepsIn
    .map(normalizeStep)
    .filter((s): s is FlowStep => Boolean(s));
  const now = new Date().toISOString();
  const folder =
    typeof f.folder === "string" && f.folder.trim()
      ? f.folder.trim()
      : undefined;
  return {
    id,
    name,
    steps,
    ...(folder ? { folder } : {}),
    createdAt: typeof f.createdAt === "string" ? f.createdAt : now,
    updatedAt: typeof f.updatedAt === "string" ? f.updatedAt : now,
  };
}

export function createFlowsStore(getDir: () => string) {
  const filePath = () => path.join(getDir(), "flows.json");

  async function loadAll(): Promise<FlowDef[]> {
    try {
      const raw = await readFile(filePath(), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : parsed &&
            typeof parsed === "object" &&
            Array.isArray((parsed as { flows?: unknown }).flows)
          ? (parsed as { flows: unknown[] }).flows
          : [];
      return list
        .map(normalizeFlow)
        .filter((f): f is FlowDef => Boolean(f));
    } catch {
      return [];
    }
  }

  async function saveAll(flows: FlowDef[]): Promise<void> {
    await mkdir(getDir(), { recursive: true });
    await writeFile(
      filePath(),
      JSON.stringify({ flows }, null, 2),
      "utf8"
    );
  }

  return {
    list: loadAll,
    async get(id: string): Promise<FlowDef | null> {
      const all = await loadAll();
      return all.find((f) => f.id === id) ?? null;
    },
    async upsert(input: {
      id?: string;
      name: string;
      steps: FlowStep[];
      /** Pass to set/clear; omit to keep the existing folder. */
      folder?: string | null;
    }): Promise<FlowDef> {
      const all = await loadAll();
      const now = new Date().toISOString();
      const existing = input.id
        ? all.find((f) => f.id === input.id)
        : undefined;
      let folder = existing?.folder;
      if ("folder" in input) {
        folder =
          typeof input.folder === "string" && input.folder.trim()
            ? input.folder.trim()
            : undefined;
      }
      const flow: FlowDef = {
        id: existing?.id ?? input.id ?? newId(),
        name: input.name.trim() || "Untitled flow",
        steps: input.steps
          .map(normalizeStep)
          .filter((s): s is FlowStep => Boolean(s)),
        ...(folder ? { folder } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const next = existing
        ? all.map((f) => (f.id === flow.id ? flow : f))
        : [...all, flow];
      await saveAll(next);
      return flow;
    },
    async remove(id: string): Promise<boolean> {
      const all = await loadAll();
      const next = all.filter((f) => f.id !== id);
      if (next.length === all.length) return false;
      await saveAll(next);
      return true;
    },
  };
}

export type FlowsStore = ReturnType<typeof createFlowsStore>;
