// The office's daily budget for agents that use an API key. Subscription agents have no USD cost
// and Ollama is free, so only API-key spend counts. Shared by the server (enforcement) and the UI.

export const DEFAULT_DAILY_BUDGET_USD = 10;
/** Share of the limit at which HQ warns. */
export const BUDGET_WARN_AT = 0.8;
export const MAX_DAILY_BUDGET_USD = 100_000;

export type BudgetLevel = "ok" | "warn" | "over";

/** limit 0 = no limit. */
export function budgetLevel(spentUsd: number, dailyUsd: number): BudgetLevel {
  if (!(dailyUsd > 0)) return "ok";
  if (spentUsd >= dailyUsd) return "over";
  return spentUsd >= dailyUsd * BUDGET_WARN_AT ? "warn" : "ok";
}

export const formatUsd = (usd: number) => `$${usd < 100 ? usd.toFixed(2) : Math.round(usd)}`;
