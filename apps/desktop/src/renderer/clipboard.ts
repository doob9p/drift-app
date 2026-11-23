/** Copy text via Electron IPC (reliable) with DOM clipboard as fallback. */
export async function copyText(text: string): Promise<boolean> {
  const value = text ?? "";
  if (!value) return false;

  const api = (
    window as unknown as {
      cursorTerm?: {
        writeClipboardText?: (t: string) => Promise<{ ok: boolean }>;
      };
    }
  ).cursorTerm;

  if (api?.writeClipboardText) {
    try {
      const result = await api.writeClipboardText(value);
      if (result?.ok) return true;
    } catch {
      /* fall through */
    }
  }

  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    /* fall through */
  }

  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
