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

function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.includes("|", 1);
}

function isTableSeparator(line: string): boolean {
  const t = line.trim();
  if (!t.includes("|")) return false;
  // | --- | :---: | ---: |
  return /^\|?[\s:|-]+\|[\s:|-]*\|?$/.test(t) && /:-+:?|:?-+:?/.test(t);
}

function splitTableCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

function parseAlign(cell: string): "left" | "center" | "right" | null {
  const t = cell.trim();
  if (/^:?-+:$/.test(t)) return "center";
  if (/^-+:$/.test(t)) return "right";
  if (/^:?-+$/.test(t)) return "left";
  return null;
}

function renderTable(header: string, separator: string, rows: string[]): string {
  const heads = splitTableCells(header);
  const aligns = splitTableCells(separator).map(parseAlign);
  const ths = heads
    .map((cell, idx) => {
      const align = aligns[idx];
      const style = align ? ` style="text-align:${align}"` : "";
      return `<th${style}>${formatInline(cell)}</th>`;
    })
    .join("");
  const body = rows
    .map((row) => {
      const cells = splitTableCells(row);
      const tds = heads
        .map((_, idx) => {
          const align = aligns[idx];
          const style = align ? ` style="text-align:${align}"` : "";
          return `<td${style}>${formatInline(cells[idx] ?? "")}</td>`;
        })
        .join("");
      return `<tr>${tds}</tr>`;
    })
    .join("");
  return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${ths}</tr></thead><tbody>${body}</tbody></table></div>`;
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

    // GFM table: header + separator + rows
    if (
      isTableRow(line) &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1] ?? "")
    ) {
      const header = line;
      const separator = lines[i + 1] ?? "";
      i += 2;
      const rows: string[] = [];
      while (i < lines.length) {
        const cur = lines[i] ?? "";
        if (!cur.trim()) break;
        if (!isTableRow(cur) || isTableSeparator(cur)) break;
        rows.push(cur);
        i += 1;
      }
      out.push(renderTable(header, separator, rows));
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
      if (
        isTableRow(cur) &&
        i + 1 < lines.length &&
        isTableSeparator(lines[i + 1] ?? "")
      ) {
        break;
      }
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
