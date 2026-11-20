/** Attachments staged in a prompt composer (Cursor-like). */

export type PromptAttachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: "image" | "text" | "binary";
  /** Raw base64 (no data: prefix) for SDK image send. */
  data?: string;
  /** Inline text for non-image files. */
  text?: string;
  /** Local preview URL for images (object URL or data URL). */
  previewUrl?: string;
};

export const MAX_PROMPT_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENT_TEXT_BYTES = 400_000;

const IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

const TEXT_EXT = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "jsonc",
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "css",
  "scss",
  "less",
  "html",
  "htm",
  "xml",
  "yml",
  "yaml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "php",
  "sql",
  "graphql",
  "vue",
  "svelte",
  "csv",
  "tsv",
  "log",
  "dockerfile",
  "makefile",
  "gitignore",
  "editorconfig",
]);

function newId(): string {
  return `att_${Math.random().toString(36).slice(2, 10)}`;
}

function extOf(name: string): string {
  const base = name.split(/[/\\]/).pop() || name;
  const i = base.lastIndexOf(".");
  return i >= 0 ? base.slice(i + 1).toLowerCase() : base.toLowerCase();
}

export function isImageMime(mime: string, name = ""): boolean {
  const m = mime.toLowerCase();
  if (IMAGE_MIME.has(m)) return true;
  if (m === "image/jpg") return true;
  const ext = extOf(name);
  return ["png", "jpg", "jpeg", "gif", "webp"].includes(ext);
}

function looksLikeText(mime: string, name: string): boolean {
  const m = mime.toLowerCase();
  if (m.startsWith("text/")) return true;
  if (
    m.includes("json") ||
    m.includes("xml") ||
    m.includes("javascript") ||
    m.includes("typescript") ||
    m.includes("yaml") ||
    m.includes("csv") ||
    m === "application/x-sh" ||
    m === "application/sql"
  ) {
    return true;
  }
  return TEXT_EXT.has(extOf(name));
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("read_failed"));
    reader.readAsDataURL(file);
  });
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("read_failed"));
    reader.readAsText(file);
  });
}

export type AttachmentReadError =
  | "too_many"
  | "too_large"
  | "unsupported"
  | "read_failed";

export type AttachmentReadResult =
  | { ok: true; attachment: PromptAttachment }
  | { ok: false; reason: AttachmentReadError; name: string };

export async function fileToPromptAttachment(
  file: File,
  currentCount: number
): Promise<AttachmentReadResult> {
  const name = file.name || "attachment";
  if (currentCount >= MAX_PROMPT_ATTACHMENTS) {
    return { ok: false, reason: "too_many", name };
  }
  const mime = file.type || "application/octet-stream";

  if (isImageMime(mime, name)) {
    if (file.size > MAX_ATTACHMENT_IMAGE_BYTES) {
      return { ok: false, reason: "too_large", name };
    }
    try {
      const dataUrl = await readAsDataUrl(file);
      const comma = dataUrl.indexOf(",");
      const data = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
      const resolvedMime =
        mime === "image/jpg" || !file.type
          ? dataUrl.match(/^data:([^;]+)/)?.[1] || "image/png"
          : mime;
      return {
        ok: true,
        attachment: {
          id: newId(),
          name,
          mime: resolvedMime,
          size: file.size,
          kind: "image",
          data,
          previewUrl: dataUrl,
        },
      };
    } catch {
      return { ok: false, reason: "read_failed", name };
    }
  }

  if (looksLikeText(mime, name)) {
    if (file.size > MAX_ATTACHMENT_TEXT_BYTES) {
      return { ok: false, reason: "too_large", name };
    }
    try {
      const text = await readAsText(file);
      return {
        ok: true,
        attachment: {
          id: newId(),
          name,
          mime: mime.startsWith("text/") ? mime : "text/plain",
          size: file.size,
          kind: "text",
          text,
        },
      };
    } catch {
      return { ok: false, reason: "read_failed", name };
    }
  }

  // Binary non-images: keep metadata only so the model knows it was attached.
  if (file.size > MAX_ATTACHMENT_IMAGE_BYTES) {
    return { ok: false, reason: "too_large", name };
  }
  return {
    ok: true,
    attachment: {
      id: newId(),
      name,
      mime,
      size: file.size,
      kind: "binary",
    },
  };
}

export function filesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  if (dt.files?.length) return [...dt.files];
  const out: File[] = [];
  for (const item of dt.items || []) {
    if (item.kind === "file") {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function buildAttachmentPromptSuffix(
  attachments: PromptAttachment[]
): string {
  const parts: string[] = [];
  for (const att of attachments) {
    if (att.kind === "text" && att.text != null) {
      parts.push(
        `[Attached file: ${att.name}]\n\`\`\`\n${att.text}\n\`\`\``
      );
    } else if (att.kind === "binary") {
      parts.push(
        `[Attached binary file: ${att.name} (${formatAttachmentSize(att.size)}, ${att.mime}) — contents not inlined]`
      );
    } else if (att.kind === "image") {
      parts.push(`[Attached image: ${att.name}]`);
    }
  }
  return parts.join("\n\n");
}

export function attachmentsToSdkImages(
  attachments: PromptAttachment[]
): Array<{ data: string; mimeType: string }> {
  return attachments
    .filter((a) => a.kind === "image" && a.data)
    .map((a) => ({ data: a.data!, mimeType: a.mime || "image/png" }));
}
