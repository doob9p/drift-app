import type { DesktopApi } from "../../electron/preload";
import { t } from "./i18n.js";
import { showToast } from "./toast.js";

/** Cursor dashboard page for minting a User API Key. */
export const CURSOR_API_KEYS_URL = "https://cursor.com/dashboard/api";

export function isApiKeyError(message: string): boolean {
  if (message === "no_api_key") return true;
  if (/api key is not set/i.test(message)) return true;
  return /api key/i.test(message) && /not set|settings|필요|없/i.test(message);
}

/** Toast + optional settings jump when the Cursor API key is missing. */
export function showNeedApiKeyToast(
  api: DesktopApi,
  opts?: { openSettings?: () => void }
): void {
  showToast(t("settings.needKeyToast"), "error", {
    ms: 9000,
    action: {
      label: t("settings.openKeyPage"),
      onClick: () => {
        void api.openExternal(CURSOR_API_KEYS_URL);
      },
    },
  });
  opts?.openSettings?.();
}

export function openCursorApiKeysPage(api: DesktopApi): void {
  void api.openExternal(CURSOR_API_KEYS_URL);
}
