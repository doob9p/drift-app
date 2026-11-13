import { icons } from "./icons.js";
import { t } from "./i18n.js";

/** Lightweight markdown for chat bubbles — no extra dependency. */
export function renderMarkdown(src: string): string {
  const parts: string[] = [];
  const fence = /```([\w-]*)\n?([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let last = 0;
  while ((match = fence.exec(src))) {
    parts.push(renderBlocks(src.slice(last, match.index)));
    const lang = (match[1] || "").trim();
    const code = (match[2] || "").replace(/\n$/, "");
    const label = lang || "code";
    parts.push(
      `<pre class="md-code"><div class="md-code-bar"><span class="md-code-lang">${escapeHtml(label)}</span><button type="button" class="md-copy" data-copy-code data-i18n-title="chat.copyCode" title="${escapeHtml(t("chat.copyCode"))}" aria-label="${escapeHtml(t("chat.copyCode"))}">${icons.copy(12)}</button></div><code>${escapeHtml(code)}</code></pre>`
    );
    last = match.index + match[0].length;
  }
  parts.push(renderBlocks(src.slice(last)));
  return parts.join("");
}

function renderBlocks(text: string): string {
  if (!text.trim()) return "";
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1]!.length;
      out.push(
        `<h${level} class="md-h">${formatInline(heading[2]!.trim())}</h${level}>`
      );
      i += 1;
      continue;
    }

    if (/^[-*] /.test(line) || /^\d+\. /.test(line)) {
      const items: string[] = [];
      const ordered = /^\d+\. /.test(line);
      while (i < lines.length) {
        const cur = lines[i] ?? "";
        if (!cur.trim()) break;
        if (!/^[-*] /.test(cur) && !/^\d+\. /.test(cur)) break;
        items.push(
          `<li>${formatInline(cur.replace(/^[-*] /, "").replace(/^\d+\. /, ""))}</li>`
        );
        i += 1;
      }
      out.push(
        `<${ordered ? "ol" : "ul"} class="md-list">${items.join("")}</${ordered ? "ol" : "ul"}>`
      );
      continue;
    }

    const para: string[] = [line];
    i += 1;
    while (i < lines.length) {
      const cur = lines[i] ?? "";
      if (!cur.trim()) break;
      if (/^#{1,3}\s+/.test(cur)) break;
      if (/^[-*] /.test(cur) || /^\d+\. /.test(cur)) break;
      para.push(cur);
      i += 1;
    }
    out.push(
      `<p>${formatInline(para.join("\n")).replace(/\n/g, "<br>")}</p>`
    );
  }

  return out.join("");
}

function formatInline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code class="md-inline">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
      '<a href="$2" rel="noreferrer">$1</a>'
    );
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
