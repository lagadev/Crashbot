import type { Env } from "../env";

export function isAdmin(env: Env, userId: number): boolean {
  const ids = (env.ADMIN_TELEGRAM_IDS || "").split(",").map((s) => s.trim());
  return ids.includes(String(userId));
}

/**
 * Builds the persistent keyboard:
 *   Row 1: Play Crash            (web_app - opens the crash-only Mini App)
 *   Row 2: Profile | Refer       (plain text buttons)
 *   Row 3: Withdraw              (plain text button)
 *   Row 4: Admin Panel           (web_app - admins only)
 */
export function buildMainKeyboard(env: Env, userId: number, host: string) {
  const base = `https://${host}`;
  const rows: any[] = [
    [{ text: "\ud83c\udfae Play Crash", web_app: { url: `${base}/?view=crash` } }],
    [{ text: "\ud83d\udc64 Profile" }, { text: "\ud83e\udd1d Refer" }],
    [{ text: "\ud83d\udcb0 Withdraw" }],
  ];
  if (isAdmin(env, userId)) {
    rows.push([{ text: "\ud83d\udee0 Admin Panel", web_app: { url: `${base}/admin/` } }]);
  }
  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
}
