/** Lightweight markdown for chat bubbles — no extra dependency. */
export function renderMarkdown(src: string): string {
  const escaped = escapeHtml(src);
  const parts: string[] = [];
  let i = 0;
  const fence = /```([\w-]*)\n?([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let last = 0;
  while ((match = fence.exec(escaped))) {
    parts.push(inlineMarkdown(escaped.slice(last, match.index)));
    const lang = match[1] || "";
    const code = match[2].replace(/\n$/, "");
    parts.push(
      `<pre class="md-code"><div class="md-code-bar"><span>${lang || "code"}</span></div><code>${code}</code></pre>`
    );
    last = match.index + match[0].length;
    i++;
  }
  parts.push(inlineMarkdown(escaped.slice(last)));
  void i;
  return parts.join("");
}

function inlineMarkdown(text: string): string {
  const blocks = text.split(/\n{2,}/);
  return blocks
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return "";
      if (/^[-*] /.test(trimmed) || /^\d+\. /.test(trimmed)) {
        const items = trimmed
          .split(/\n/)
          .map((line) => line.replace(/^[-*] /, "").replace(/^\d+\. /, ""))
          .map((line) => `<li>${formatInline(line)}</li>`)
          .join("");
        return `<ul class="md-list">${items}</ul>`;
      }
      return `<p>${formatInline(trimmed).replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
}

function formatInline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, "<code class=\"md-inline\">$1</code>")
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
