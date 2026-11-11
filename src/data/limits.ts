// Subscription usage limits (Claude's 5-hour and weekly windows, ChatGPT's limit for Codex).
// Shared by the server and the UI.

import type { LimitAccount } from "./types";

export const ACCOUNT_LABEL: Record<LimitAccount, string> = { anthropic: "Claude", openai: "Codex (ChatGPT)" };

/** Share of a window at which HQ warns, in percent. */
export const LIMIT_WARN_AT = 80;
/** Share of a window at which agents save their work (commit, draft PR) and pause until the reset: 10% is left. */
export const LIMIT_WIND_DOWN_AT = 90;

/** "3:45 PM" for today, "Fri 3:45 PM" for another day, in the machine's locale. */
export function formatReset(when: string | Date, now = Date.now()): string {
  const d = new Date(when);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date(now).toDateString() ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}
