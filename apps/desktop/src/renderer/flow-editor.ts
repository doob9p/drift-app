import type { FlowDef, FlowStep, FlowStepKind, SavedSession } from "@drift/core";
import { t } from "./i18n.js";
import { icons } from "./icons.js";

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function kindIcon(kind: FlowStepKind, size = 12): string {
  switch (kind) {
    case "local":
      return icons.terminal(size);
    case "ssh":
      return icons.server(size);
    case "upload":
      return icons.upload(size);
    case "approve":
      return icons.checkCircle(size);
  }
}

export type FlowEditorHandlers = {
  listFlows: () => Promise<FlowDef[]>;
  upsertFlow: (input: {
    id?: string;
    name: string;
    steps: FlowStep[];
    folder?: string | null;
  }) => Promise<FlowDef>;
  deleteFlow: (id: string) => Promise<{ ok: boolean }>;
  listSessions: () => Promise<SavedSession[]>;
  /** Optional folder picker for local cwd. */
  pickDirectory?: () => Promise<string | null>;
};

/**
 * Modal UI to create/edit a single deploy flow.
 * Mount once; call open() to show.
 */
export function createFlowEditor(
  host: HTMLElement,
  handlers: FlowEditorHandlers
): {
  open: (opts?: { flowId?: string; onSaved?: (flow: FlowDef) => void }) => void;
  close: () => void;
} {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop hidden";
  backdrop.id = "modal-flow";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.innerHTML = `
    <div class="modal modal-flow">
      <header class="flow-editor-head">
        <div class="flow-editor-head-copy">
          <h2 data-i18n="flow.editorTitle">${t("flow.editorTitle")}</h2>
          <p class="flow-editor-lead">${t("flow.editorLead")}</p>
        </div>
        <button type="button" class="ghost icon" data-flow-close title="${t("settings.close")}" aria-label="${t("settings.close")}">${icons.close(14)}</button>
      </header>
      <div class="flow-editor-scroll">
        <label class="flow-editor-name">
          <span>${t("flow.name")}</span>
          <input type="text" data-flow-name maxlength="80" />
        </label>
        <div class="flow-editor-steps-block">
          <div class="flow-editor-steps-head">
            <div class="flow-editor-steps-title">
              <span>${t("flow.steps")}</span>
              <span class="flow-editor-steps-count" data-flow-step-count></span>
            </div>
            <div class="flow-editor-add-kinds" role="group" aria-label="${t("flow.addStep")}">
              <button type="button" class="flow-add-kind" data-add-kind="local" data-kind="local">${kindIcon("local", 12)}<span>${t("flow.kind.local")}</span></button>
              <button type="button" class="flow-add-kind" data-add-kind="ssh" data-kind="ssh">${kindIcon("ssh", 12)}<span>${t("flow.kind.ssh")}</span></button>
              <button type="button" class="flow-add-kind" data-add-kind="upload" data-kind="upload">${kindIcon("upload", 12)}<span>${t("flow.kind.upload")}</span></button>
              <button type="button" class="flow-add-kind" data-add-kind="approve" data-kind="approve">${kindIcon("approve", 12)}<span>${t("flow.kind.approve")}</span></button>
            </div>
          </div>
          <div class="flow-editor-steps" data-flow-steps></div>
        </div>
      </div>
      <footer class="flow-editor-foot">
        <button type="button" class="ghost danger" data-flow-delete>${t("flow.delete")}</button>
        <div class="flow-editor-foot-right">
          <button type="button" class="ghost" data-flow-close>${t("flow.cancel")}</button>
          <button type="button" class="primary" data-flow-save>${t("flow.save")}</button>
        </div>
      </footer>
    </div>
  `;
  host.append(backdrop);

  let flows: FlowDef[] = [];
  let sessions: SavedSession[] = [];
  let editingId: string | null = null;
  let draftSteps: FlowStep[] = [];
  let onSaved: ((flow: FlowDef) => void) | undefined;

  const nameInput = backdrop.querySelector(
    "[data-flow-name]"
  ) as HTMLInputElement;
  const stepsEl = backdrop.querySelector(
    "[data-flow-steps]"
  ) as HTMLElement;
  const stepCountEl = backdrop.querySelector(
    "[data-flow-step-count]"
  ) as HTMLElement;
  const deleteBtn = backdrop.querySelector(
    "[data-flow-delete]"
  ) as HTMLButtonElement;

  function close(): void {
    backdrop.classList.add("hidden");
    onSaved = undefined;
  }

  function syncDeleteVisibility(): void {
    deleteBtn.classList.toggle("hidden", !editingId);
  }

  function syncStepCount(): void {
    const n = draftSteps.length;
    stepCountEl.textContent = n ? String(n) : "";
    stepCountEl.classList.toggle("is-empty", n === 0);
  }

  function readStepsFromDom(): FlowStep[] {
    const rows = [
      ...stepsEl.querySelectorAll<HTMLElement>("[data-step-row]"),
    ];
    return rows.map((row) => {
      const id = row.dataset.stepId || uid("step");
      const kind = (row.dataset.kind || "local") as FlowStepKind;
      const label =
        (
          row.querySelector("[data-step-label]") as HTMLInputElement
        )?.value.trim() || t(`flow.kind.${kind}`);
      const command =
        (row.querySelector("[data-step-command]") as HTMLTextAreaElement)
          ?.value ?? "";
      const cwd =
        (row.querySelector("[data-step-cwd]") as HTMLInputElement)?.value.trim() ||
        undefined;
      const sessionId =
        (row.querySelector("[data-step-session]") as HTMLSelectElement)
          ?.value || undefined;
      const remoteDir =
        (row.querySelector("[data-step-remote]") as HTMLInputElement)
          ?.value.trim() || undefined;
      const pathsRaw =
        (row.querySelector("[data-step-paths]") as HTMLTextAreaElement)
          ?.value ?? "";
      const autoInputsRaw =
        (row.querySelector("[data-step-auto-inputs]") as HTMLTextAreaElement)
          ?.value ?? "";
      const step: FlowStep = { id, kind, label };
      if (kind === "upload") {
        if (cwd) step.cwd = cwd;
        if (sessionId) step.sessionId = sessionId;
        if (remoteDir) step.remoteDir = remoteDir;
        step.paths = pathsRaw
          .split("\n")
          .map((p) => p.trim())
          .filter(Boolean);
      } else if (kind !== "approve") {
        step.command = command;
        if (cwd) step.cwd = cwd;
        if (kind === "ssh" && sessionId) step.sessionId = sessionId;
        const autoInputs = autoInputsRaw
          .split("\n")
          .map((p) => p.replace(/\r$/, ""))
          .filter((p) => p.length > 0);
        if (autoInputs.length) step.autoInputs = autoInputs;
      }
      return step;
    });
  }

  function renderStepBody(step: FlowStep, sessionOptions: string): string {
    if (step.kind === "approve") {
      return `<p class="flow-step-hint">${t("flow.approveHint")}</p>`;
    }
    if (step.kind === "upload") {
      return `
        <div class="flow-step-fields">
          <label class="flow-step-field">
            <span>${t("flow.sshSession")}</span>
            <select data-step-session>${sessionOptions || `<option value="">${t("flow.noSessions")}</option>`}</select>
          </label>
          <label class="flow-step-field">
            <span>${t("flow.cwd")}</span>
            <div class="flow-step-cwd-row">
              <input type="text" data-step-cwd placeholder="${t("flow.cwdPlaceholder")}" spellcheck="false" />
              <button type="button" class="ghost" data-step-pick-cwd>${t("flow.cwdBrowse")}</button>
            </div>
          </label>
          <label class="flow-step-field">
            <span>${t("flow.uploadPaths")}</span>
            <textarea data-step-paths rows="3" spellcheck="false"></textarea>
          </label>
          <label class="flow-step-field">
            <span>${t("flow.remoteDir")}</span>
            <input type="text" data-step-remote placeholder="~" spellcheck="false" />
          </label>
        </div>
        <p class="flow-step-hint">${t("flow.uploadHint")}</p>`;
    }
    const hasAuto = (step.autoInputs || []).length > 0;
    return `
      <div class="flow-step-fields">
        ${
          step.kind === "ssh"
            ? `<label class="flow-step-field">
                <span>${t("flow.sshSession")}</span>
                <select data-step-session>${sessionOptions || `<option value="">${t("flow.noSessions")}</option>`}</select>
              </label>`
            : ""
        }
        <label class="flow-step-field">
          <span>${t("flow.cwd")}</span>
          <div class="flow-step-cwd-row">
            <input type="text" data-step-cwd placeholder="${t("flow.cwdPlaceholder")}" spellcheck="false" />
            ${
              step.kind === "local"
                ? `<button type="button" class="ghost" data-step-pick-cwd>${t("flow.cwdBrowse")}</button>`
                : ""
            }
          </div>
        </label>
        <label class="flow-step-field flow-step-field-command">
          <span>${t("flow.command")}</span>
          <textarea data-step-command rows="3" spellcheck="false"></textarea>
        </label>
      </div>
      <details class="flow-step-advanced"${hasAuto ? " open" : ""}>
        <summary>${t("flow.advanced")}</summary>
        <label class="flow-step-field">
          <span>${t("flow.autoInputs")}</span>
          <textarea data-step-auto-inputs rows="3" spellcheck="false"></textarea>
          <p class="flow-step-hint">${t("flow.autoInputsHint")}</p>
        </label>
      </details>`;
  }

  function renderSteps(): void {
    syncStepCount();
    if (draftSteps.length === 0) {
      stepsEl.innerHTML = `<div class="flow-steps-empty">${t("flow.stepsEmpty")}</div>`;
      return;
    }

    stepsEl.innerHTML = draftSteps
      .map((step, index) => {
        const sessionOptions = sessions
          .map(
            (s) =>
              `<option value="${s.id}"${s.id === step.sessionId ? " selected" : ""}></option>`
          )
          .join("");
        return `
        <div class="flow-step-rail">
          <div class="flow-step-rail-mark" aria-hidden="true">
            <span class="flow-step-rail-dot">${index + 1}</span>
            ${index < draftSteps.length - 1 ? `<span class="flow-step-rail-line"></span>` : ""}
          </div>
          <div class="flow-step-row" data-step-row data-step-id="${step.id}" data-kind="${step.kind}">
            <div class="flow-step-row-top">
              <div class="flow-step-identity">
                <span class="flow-step-kind-tag" data-kind="${step.kind}">${kindIcon(step.kind, 11)}<span>${t(`flow.kind.${step.kind}`)}</span></span>
                <input type="text" class="flow-step-label" data-step-label value="" placeholder="${t(`flow.kind.${step.kind}`)}" />
              </div>
              <div class="flow-step-actions">
                <button type="button" class="icon ghost" data-step-up title="${t("flow.moveUp")}" aria-label="${t("flow.moveUp")}">${icons.chevronUp(12)}</button>
                <button type="button" class="icon ghost" data-step-down title="${t("flow.moveDown")}" aria-label="${t("flow.moveDown")}">${icons.chevronDown(12)}</button>
                <button type="button" class="icon ghost" data-step-remove title="${t("flow.removeStep")}" aria-label="${t("flow.removeStep")}">${icons.trash(13)}</button>
              </div>
            </div>
            ${renderStepBody(step, sessionOptions)}
          </div>
        </div>`;
      })
      .join("");

    for (const step of draftSteps) {
      const row = stepsEl.querySelector(
        `[data-step-id="${step.id}"]`
      ) as HTMLElement | null;
      if (!row) continue;
      const labelInput = row.querySelector(
        "[data-step-label]"
      ) as HTMLInputElement;
      labelInput.value = step.label;
      const cmd = row.querySelector(
        "[data-step-command]"
      ) as HTMLTextAreaElement | null;
      if (cmd) cmd.value = step.command || "";
      const autoEl = row.querySelector(
        "[data-step-auto-inputs]"
      ) as HTMLTextAreaElement | null;
      if (autoEl) autoEl.value = (step.autoInputs || []).join("\n");
      const pathsEl = row.querySelector(
        "[data-step-paths]"
      ) as HTMLTextAreaElement | null;
      if (pathsEl) pathsEl.value = (step.paths || []).join("\n");
      const remoteEl = row.querySelector(
        "[data-step-remote]"
      ) as HTMLInputElement | null;
      if (remoteEl) remoteEl.value = step.remoteDir || "";
      const cwdInput = row.querySelector(
        "[data-step-cwd]"
      ) as HTMLInputElement | null;
      if (cwdInput) cwdInput.value = step.cwd || "";
      const sel = row.querySelector(
        "[data-step-session]"
      ) as HTMLSelectElement | null;
      if (sel) {
        for (const opt of sel.options) {
          const s = sessions.find((x) => x.id === opt.value);
          if (s) opt.textContent = s.name || `${s.user}@${s.host}`;
        }
      }
      row
        .querySelector("[data-step-pick-cwd]")
        ?.addEventListener("click", () => {
          void (async () => {
            if (!handlers.pickDirectory || !cwdInput) return;
            const picked = await handlers.pickDirectory();
            if (picked) cwdInput.value = picked;
          })();
        });
      row.querySelector("[data-step-up]")?.addEventListener("click", () => {
        draftSteps = readStepsFromDom();
        const i = draftSteps.findIndex((s) => s.id === step.id);
        if (i > 0) {
          const tmp = draftSteps[i - 1]!;
          draftSteps[i - 1] = draftSteps[i]!;
          draftSteps[i] = tmp;
          renderSteps();
        }
      });
      row.querySelector("[data-step-down]")?.addEventListener("click", () => {
        draftSteps = readStepsFromDom();
        const i = draftSteps.findIndex((s) => s.id === step.id);
        if (i >= 0 && i < draftSteps.length - 1) {
          const tmp = draftSteps[i + 1]!;
          draftSteps[i + 1] = draftSteps[i]!;
          draftSteps[i] = tmp;
          renderSteps();
        }
      });
      row.querySelector("[data-step-remove]")?.addEventListener("click", () => {
        draftSteps = readStepsFromDom().filter((s) => s.id !== step.id);
        renderSteps();
      });
    }
  }

  function startBlank(): void {
    editingId = null;
    nameInput.value = t("flow.untitled");
    draftSteps = [
      {
        id: uid("step"),
        kind: "local",
        label: t("flow.kind.local"),
        command: "echo hello",
      },
    ];
    syncDeleteVisibility();
    renderSteps();
  }

  async function loadFlow(id: string): Promise<void> {
    const flow = flows.find((f) => f.id === id);
    if (!flow) return;
    editingId = flow.id;
    nameInput.value = flow.name;
    draftSteps = flow.steps.map((s) => ({ ...s }));
    syncDeleteVisibility();
    renderSteps();
  }

  async function refresh(): Promise<void> {
    flows = await handlers.listFlows();
    sessions = await handlers.listSessions();
  }

  backdrop.querySelectorAll("[data-flow-close]").forEach((btn) => {
    btn.addEventListener("click", () => close());
  });
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelectorAll<HTMLButtonElement>("[data-add-kind]").forEach(
    (btn) => {
      btn.addEventListener("click", () => {
        draftSteps = readStepsFromDom();
        const kind = btn.dataset.addKind as FlowStepKind;
        const step: FlowStep = {
          id: uid("step"),
          kind,
          label: t(`flow.kind.${kind}`),
        };
        if (kind === "local" || kind === "ssh") step.command = "";
        if (kind === "ssh" || kind === "upload") {
          step.sessionId = sessions[0]?.id;
        }
        if (kind === "upload") {
          step.paths = [];
          step.remoteDir = "~";
        }
        draftSteps.push(step);
        renderSteps();
        const last = stepsEl.querySelector(
          `[data-step-id="${step.id}"] [data-step-label]`
        ) as HTMLInputElement | null;
        last?.focus();
        last?.select();
      });
    }
  );
  backdrop.querySelector("[data-flow-save]")!.addEventListener("click", () => {
    void (async () => {
      draftSteps = readStepsFromDom();
      const existing = editingId
        ? flows.find((f) => f.id === editingId)
        : undefined;
      const saved = await handlers.upsertFlow({
        id: editingId || undefined,
        name: nameInput.value.trim() || t("flow.untitled"),
        steps: draftSteps,
        // Keep sidebar folder assignment across edits.
        ...(editingId ? { folder: existing?.folder ?? null } : {}),
      });
      editingId = saved.id;
      onSaved?.(saved);
      close();
    })();
  });
  deleteBtn.addEventListener("click", () => {
    void (async () => {
      if (!editingId) {
        close();
        return;
      }
      if (!window.confirm(t("sidebar.flowDeleteConfirm"))) return;
      await handlers.deleteFlow(editingId);
      close();
    })();
  });

  return {
    async open(opts) {
      onSaved = opts?.onSaved;
      await refresh();
      if (opts?.flowId && flows.some((f) => f.id === opts.flowId)) {
        await loadFlow(opts.flowId);
      } else {
        startBlank();
      }
      backdrop.classList.remove("hidden");
      nameInput.focus();
      nameInput.select();
    },
    close,
  };
}
