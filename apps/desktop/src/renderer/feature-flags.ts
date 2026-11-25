/**
 * Feature flags for gradual product pivots.
 * Cursor API / prompt-card agent UI is hidden while Claude Code cards land.
 * Backend + IPC stay intact so we can re-enable without a rewrite.
 */
export const CURSOR_API_UI_ENABLED = false;
