import type { ProposedAction } from "@drift/core";
import { renderMarkdown } from "./markdown.js";
import { t } from "./i18n.js";
import { icons } from "./icons.js";

export type ChatController = {
  clear: () => void;
  showEmpty: () => void;
  addUser: (text: string) => void;
  beginAssistant: () => void;
  appendAssistant: (chunk: string) => void;
  finishAssistant: (meta?: { tokens?: number; modelId?: string; cost?: string }) => void;
  setThinking: (on: boolean, label?: string) => void;
  addSystem: (text: string) => void;
  addError: (text: string) => void;
  addPlan: (steps: string[]) => void;
  addApproval: (
    payload: { runId: string; action: ProposedAction },
    onDecision: (d: "allow-once" | "allow-session" | "deny") => void
  ) => void;
  resolveApprovalCard: (decision: "allow-once" | "allow-session" | "deny") => void;
  scrollToBottom: () => void;
};

export function createChatController(root: HTMLElement): ChatController {
  let assistantBody: HTMLElement | null = null;
  let assistantRaw = "";
  let thinkingEl: HTMLElement | null = null;
  let approvalEl: HTMLElement | null = null;
  let renderTimer: number | null = null;

  function ensureThread(): void {
    root.querySelector(".chat-empty")?.remove();
  }

  function scrollToBottom(): void {
    root.scrollTop = root.scrollHeight;
  }

  function showEmpty(): void {
    root.innerHTML = `
      <div class="chat-empty">
        <div class="chat-empty-title">${escapeHtml(t("chat.empty.title"))}</div>
        <div class="chat-empty-sub">${escapeHtml(t("chat.empty.sub"))}</div>
        <div class="chat-suggestions">
          <button type="button" data-suggest="${escapeHtml(t("chat.suggest.port.prompt"))}">${escapeHtml(t("chat.suggest.port"))}</button>
          <button type="button" data-suggest="${escapeHtml(t("chat.suggest.git.prompt"))}">${escapeHtml(t("chat.suggest.git"))}</button>
          <button type="button" data-suggest="${escapeHtml(t("chat.suggest.disk.prompt"))}">${escapeHtml(t("chat.suggest.disk"))}</button>
        </div>
      </div>
    `;
  }

  function clear(): void {
    root.innerHTML = "";
    assistantBody = null;
    assistantRaw = "";
    thinkingEl = null;
    approvalEl = null;
    showEmpty();
  }

  function addUser(text: string): void {
    ensureThread();
    removeThinking();
    const el = document.createElement("div");
    el.className = "msg msg-user";
    el.innerHTML = `
      <div class="msg-bubble">${escapeHtml(text).replace(/\n/g, "<br>")}</div>
    `;
    root.append(el);
    scrollToBottom();
  }

  function beginAssistant(): void {
    ensureThread();
    removeThinking();
    assistantRaw = "";
    const el = document.createElement("div");
    el.className = "msg msg-assistant";
    el.innerHTML = `
      <div class="msg-avatar" aria-hidden="true">${icons.sparkles(12)}</div>
      <div class="msg-col">
        <div class="msg-role">Agent</div>
        <div class="msg-body md"></div>
        <div class="msg-meta hidden"></div>
      </div>
    `;
    root.append(el);
    assistantBody = el.querySelector(".msg-body");
    scrollToBottom();
  }

  function scheduleRender(): void {
    if (renderTimer != null) return;
    renderTimer = window.setTimeout(() => {
      renderTimer = null;
      if (assistantBody) {
        assistantBody.innerHTML = renderMarkdown(assistantRaw);
        scrollToBottom();
      }
    }, 40);
  }

  function appendAssistant(chunk: string): void {
    if (!assistantBody) beginAssistant();
    assistantRaw += chunk;
    scheduleRender();
  }

  function finishAssistant(meta?: {
    tokens?: number;
    modelId?: string;
    cost?: string;
  }): void {
    if (renderTimer != null) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    if (assistantBody) {
      assistantBody.innerHTML = renderMarkdown(assistantRaw || "_(no reply)_");
      const metaEl = assistantBody.parentElement?.querySelector(".msg-meta");
      if (metaEl && (meta?.tokens || meta?.modelId || meta?.cost)) {
        metaEl.classList.remove("hidden");
        const bits: string[] = [];
        if (meta.modelId) bits.push(meta.modelId);
        if (meta.tokens != null) bits.push(`${formatTokens(meta.tokens)} tokens`);
        if (meta.cost) bits.push(meta.cost);
        metaEl.textContent = bits.join(" · ");
      }
    }
    assistantBody = null;
    removeThinking();
    scrollToBottom();
  }

  function setThinking(on: boolean, label = t("thinking")): void {
    if (!on) {
      removeThinking();
      return;
    }
    ensureThread();
    if (thinkingEl) {
      thinkingEl.querySelector(".thinking-label")!.textContent = label;
      return;
    }
    thinkingEl = document.createElement("div");
    thinkingEl.className = "msg msg-thinking";
    thinkingEl.innerHTML = `
      <div class="msg-avatar" aria-hidden="true">${icons.sparkles(12)}</div>
      <div class="thinking-pill">
        <span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="thinking-label">${escapeHtml(label)}</span>
      </div>
    `;
    root.append(thinkingEl);
    scrollToBottom();
  }

  function removeThinking(): void {
    thinkingEl?.remove();
    thinkingEl = null;
  }

  function addSystem(text: string): void {
    ensureThread();
    const el = document.createElement("div");
    el.className = "msg msg-system";
    el.innerHTML = `<div class="system-chip">${escapeHtml(text)}</div>`;
    root.append(el);
    scrollToBottom();
  }

  function addError(text: string): void {
    ensureThread();
    removeThinking();
    const el = document.createElement("div");
    el.className = "msg msg-error";
    el.innerHTML = `<div class="error-card">${escapeHtml(text)}</div>`;
    root.append(el);
    scrollToBottom();
  }

  function addPlan(steps: string[]): void {
    ensureThread();
    const el = document.createElement("div");
    el.className = "msg msg-tool";
    el.innerHTML = `
      <div class="tool-card">
        <div class="tool-card-head">${escapeHtml(t("mode.plan"))}</div>
        <ol>${steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol>
      </div>
    `;
    root.append(el);
    scrollToBottom();
  }

  function addApproval(
    payload: { runId: string; action: ProposedAction },
    onDecision: (d: "allow-once" | "allow-session" | "deny") => void
  ): void {
    ensureThread();
    removeThinking();
    approvalEl?.remove();
    const targetRef = payload.action.target;
    const targetLabel =
      targetRef.kind === "ssh"
        ? `SSH · ${targetRef.hostLabel} · ${targetRef.cwd}`
        : `Local · ${targetRef.cwd}`;
    const el = document.createElement("div");
    el.className = "msg msg-approval";
    el.innerHTML = `
      <div class="approval-card" data-run="${escapeHtml(payload.runId)}">
        <div class="approval-card-head">
          <span class="approval-badge">${escapeHtml(payload.action.effect)}</span>
          <span>${escapeHtml(t("approval.wait"))}</span>
        </div>
        <div class="approval-card-summary">${escapeHtml(payload.action.summary)}</div>
        <div class="approval-card-target">${escapeHtml(targetLabel)}</div>
        <pre class="approval-card-cmd">${escapeHtml(payload.action.command || "(no command)")}</pre>
        <div class="approval-card-actions">
          <button type="button" class="danger" data-d="deny">${escapeHtml(t("approval.deny"))}</button>
          <button type="button" data-d="allow-session">${escapeHtml(t("approval.session"))}</button>
          <button type="button" class="primary" data-d="allow-once">${escapeHtml(t("approval.once"))}</button>
        </div>
      </div>
    `;
    el.querySelectorAll("button[data-d]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const d = (btn as HTMLElement).dataset.d as
          | "allow-once"
          | "allow-session"
          | "deny";
        onDecision(d);
      });
    });
    root.append(el);
    approvalEl = el;
    scrollToBottom();
  }

  function resolveApprovalCard(
    decision: "allow-once" | "allow-session" | "deny"
  ): void {
    if (!approvalEl) return;
    const card = approvalEl.querySelector(".approval-card");
    if (!card) return;
    const label =
      decision === "deny"
        ? t("approval.denied")
        : decision === "allow-session"
          ? t("approval.allowedSession")
          : t("approval.allowedOnce");
    card.classList.add("resolved");
    card.classList.toggle("denied", decision === "deny");
    const actions = card.querySelector(".approval-card-actions");
    if (actions) {
      actions.innerHTML = `<span class="approval-resolved">${label}</span>`;
    }
    approvalEl = null;
  }

  return {
    clear,
    showEmpty,
    addUser,
    beginAssistant,
    appendAssistant,
    finishAssistant,
    setThinking,
    addSystem,
    addError,
    addPlan,
    addApproval,
    resolveApprovalCard,
    scrollToBottom,
  };
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
