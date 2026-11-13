import type { ProposedAction } from "@drift/core";
import { renderMarkdown } from "./markdown.js";
import { t } from "./i18n.js";
import { icons } from "./icons.js";
import { showToast } from "./toast.js";

export type ChatSuggestion = { label: string; prompt: string };

export type ChatController = {
  clear: () => void;
  showEmpty: (suggestions?: ChatSuggestion[]) => void;
  addUser: (
    text: string,
    refs?: { name: string; kind: "file" | "dir" }[]
  ) => void;
  beginAssistant: () => void;
  appendAssistant: (chunk: string) => void;
  finishAssistant: (meta?: { tokens?: number; modelId?: string; cost?: string }) => void;
  setThinking: (on: boolean, label?: string) => void;
  setActivity: (activity: {
    title: string;
    detail?: string;
    summary?: string;
    done?: boolean;
  }) => void;
  addSystem: (text: string) => void;
  addError: (
    text: string,
    opts?: { action?: { label: string; onClick: () => void } }
  ) => void;
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
  let timeTimer: number | null = null;

  function refreshRelativeTimes(): void {
    root.querySelectorAll<HTMLElement>(".msg-time[data-ts]").forEach((el) => {
      const ts = Number(el.dataset.ts || 0);
      if (!ts) return;
      el.textContent = formatRelativeTime(ts);
      el.title = new Date(ts).toLocaleString();
    });
  }

  function ensureTimeTicker(): void {
    if (timeTimer != null) return;
    timeTimer = window.setInterval(refreshRelativeTimes, 30_000);
  }

  root.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest(
      "[data-copy-code]"
    ) as HTMLButtonElement | null;
    if (!btn || !root.contains(btn)) return;
    e.preventDefault();
    const pre = btn.closest("pre.md-code");
    const code = pre?.querySelector("code");
    const text = code?.textContent ?? "";
    if (!text) return;
    void navigator.clipboard.writeText(text).then(
      () => showToast(t("chat.copied"), "ok"),
      () => showToast(t("chat.copyFail"), "error")
    );
  });

  function ensureThread(): void {
    root.querySelector(".chat-empty")?.remove();
  }

  function scrollToBottom(): void {
    root.scrollTop = root.scrollHeight;
  }

  let lastSuggestions: ChatSuggestion[] | undefined;

  function defaultSuggestions(): ChatSuggestion[] {
    return [
      {
        label: t("chat.suggest.git"),
        prompt: t("chat.suggest.git.prompt", { path: "." }),
      },
      {
        label: t("chat.suggest.termTail"),
        prompt: t("chat.suggest.termTail.prompt"),
      },
      {
        label: t("chat.suggest.disk"),
        prompt: t("chat.suggest.disk.prompt"),
      },
    ];
  }

  function showEmpty(suggestions?: ChatSuggestion[]): void {
    const items =
      suggestions && suggestions.length > 0
        ? suggestions
        : lastSuggestions && lastSuggestions.length > 0
          ? lastSuggestions
          : defaultSuggestions();
    lastSuggestions = items;
    root.innerHTML = `
      <div class="chat-empty">
        <div class="chat-empty-title">${escapeHtml(t("chat.empty.title"))}</div>
        <div class="chat-empty-sub">${escapeHtml(t("chat.empty.sub"))}</div>
        <div class="chat-suggestions">
          ${items
            .map(
              (s) =>
                `<button type="button" data-suggest="${escapeHtml(s.prompt)}">${escapeHtml(s.label)}</button>`
            )
            .join("")}
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
    showEmpty(lastSuggestions);
  }

  function addUser(
    text: string,
    refs?: { name: string; kind: "file" | "dir" }[]
  ): void {
    ensureThread();
    removeThinking();
    const el = document.createElement("div");
    el.className = "msg msg-user";
    const chips =
      refs && refs.length
        ? `<div class="msg-refs">${refs
            .map(
              (r) =>
                `<span class="msg-ref-chip" data-kind="${r.kind}">${escapeHtml(r.name)}</span>`
            )
            .join("")}</div>`
        : "";
    const body = text.trim()
      ? `<div class="msg-bubble-text">${escapeHtml(text).replace(/\n/g, "<br>")}</div>`
      : "";
    el.innerHTML = `
      <div class="msg-bubble">${chips}${body}</div>
    `;
    root.append(el);
    scrollToBottom();
  }

  function beginAssistant(): void {
    ensureThread();
    // Keep the live activity card above the streaming reply (Cursor-like).
    assistantRaw = "";
    const el = document.createElement("div");
    el.className = "msg msg-assistant";
    el.innerHTML = `
      <div class="msg-col">
        <div class="msg-body md"></div>
        <div class="msg-footer hidden">
          <div class="msg-actions">
            <button type="button" class="msg-action" data-copy title="">${icons.copy(13)}</button>
          </div>
          <div class="msg-footer-right">
            <span class="msg-time" data-ts=""></span>
            <span class="msg-usage hidden"></span>
          </div>
        </div>
      </div>
    `;
    if (thinkingEl) thinkingEl.after(el);
    else root.append(el);
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
      const raw = assistantRaw || "_(no reply)_";
      assistantBody.innerHTML = renderMarkdown(raw);
      const col = assistantBody.parentElement;
      const footer = col?.querySelector(".msg-footer") as HTMLElement | null;
      const timeEl = col?.querySelector(".msg-time") as HTMLElement | null;
      const usageEl = col?.querySelector(".msg-usage") as HTMLElement | null;
      const copyBtn = col?.querySelector(
        "[data-copy]"
      ) as HTMLButtonElement | null;
      if (footer && timeEl && copyBtn) {
        const now = Date.now();
        timeEl.dataset.ts = String(now);
        timeEl.textContent = formatRelativeTime(now);
        timeEl.title = new Date(now).toLocaleString();
        copyBtn.title = t("chat.copy");
        copyBtn.setAttribute("aria-label", t("chat.copy"));
        copyBtn.onclick = async () => {
          try {
            await navigator.clipboard.writeText(raw);
            showToast(t("chat.copied"), "ok");
          } catch {
            showToast(t("chat.copyFail"), "error");
          }
        };
        if (usageEl) {
          const bits: string[] = [];
          if (meta?.tokens != null) {
            bits.push(`${formatTokens(meta.tokens)} tokens`);
          }
          if (meta?.cost) bits.push(meta.cost);
          if (bits.length) {
            usageEl.textContent = bits.join(" · ");
            usageEl.classList.remove("hidden");
          } else {
            usageEl.textContent = "";
            usageEl.classList.add("hidden");
          }
        }
        footer.classList.remove("hidden");
        ensureTimeTicker();
      }
    }
    assistantBody = null;
    removeThinking();
    scrollToBottom();
  }

  function ensureActivityCard(): HTMLElement {
    ensureThread();
    if (thinkingEl) return thinkingEl;
    thinkingEl = document.createElement("div");
    thinkingEl.className = "msg msg-thinking";
    thinkingEl.innerHTML = `
      <div class="activity-card" aria-live="polite">
        <div class="activity-head">
          <span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>
          <span class="activity-title thinking-label">${escapeHtml(t("thinking"))}</span>
        </div>
        <div class="activity-detail hidden"></div>
        <div class="activity-summary hidden"></div>
      </div>
    `;
    root.append(thinkingEl);
    scrollToBottom();
    return thinkingEl;
  }

  function setThinking(on: boolean, label = t("thinking")): void {
    if (!on) {
      removeThinking();
      return;
    }
    setActivity({ title: label });
  }

  function setActivity(activity: {
    title: string;
    detail?: string;
    summary?: string;
    done?: boolean;
  }): void {
    const el = ensureActivityCard();
    const card = el.querySelector(".activity-card")!;
    const titleEl = el.querySelector(".activity-title") as HTMLElement;
    const detailEl = el.querySelector(".activity-detail") as HTMLElement;
    const summaryEl = el.querySelector(".activity-summary") as HTMLElement;
    titleEl.textContent = activity.title;
    card.classList.toggle("is-done", Boolean(activity.done));
    if (activity.detail?.trim()) {
      detailEl.textContent = activity.detail.trim();
      detailEl.classList.remove("hidden");
    } else {
      detailEl.textContent = "";
      detailEl.classList.add("hidden");
    }
    if (activity.summary?.trim()) {
      summaryEl.textContent = activity.summary.trim();
      summaryEl.classList.remove("hidden");
    } else if (!summaryEl.textContent) {
      summaryEl.classList.add("hidden");
    }
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

  function addError(
    text: string,
    opts?: { action?: { label: string; onClick: () => void } }
  ): void {
    ensureThread();
    removeThinking();
    const el = document.createElement("div");
    el.className = "msg msg-error";
    const actionHtml = opts?.action
      ? `<button type="button" class="error-card-action">${escapeHtml(opts.action.label)}</button>`
      : "";
    el.innerHTML = `<div class="error-card"><div class="error-card-text">${escapeHtml(text)}</div>${actionHtml}</div>`;
    const actionBtn = el.querySelector(
      ".error-card-action"
    ) as HTMLButtonElement | null;
    if (actionBtn && opts?.action) {
      actionBtn.onclick = () => opts.action?.onClick();
    }
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
    setActivity,
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

function formatRelativeTime(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 45) return t("chat.time.justNow");
  const min = Math.floor(sec / 60);
  if (min < 60) return t("chat.time.minutes", { n: String(min) });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t("chat.time.hours", { n: String(hr) });
  const day = Math.floor(hr / 24);
  return t("chat.time.days", { n: String(day) });
}
