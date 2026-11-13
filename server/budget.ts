// The office's daily budget. Agents that use an API key report what each model call cost (the
// OpenCode plugin per step, Claude Code's status line as a running total per session). HQ adds it
// up per local day in ~/.kh-team/<project>/spend.json. Subscription agents have no USD cost and
// Ollama is free, so only API-key agents count. Codex reports no cost yet, so its API-key
// agents are not counted.
//
// At 80% of the limit HQ warns. At 100% it stops the API-key agents and refuses to start them until
// the next day or until the limit is raised. A limit of 0 means no limit (spend is still tracked).

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUDGET_WARN_AT, budgetLevel, formatUsd } from "../src/data/budget";
import type { BudgetState } from "../src/data/types";
import type { Hub } from "./hub";
import { log } from "./lib/log";
import { projectHome } from "./paths";

interface SpendFile {
  /** local date → agent id → USD */
  days: Record<string, Record<string, number>>;
  /** Claude Code reports a running total per session: the last total seen, so a total is never counted twice. */
  sessions: Record<string, { id: string; total: number }>;
  /** What HQ already did today, so a restart doesn't repeat it. */
  flags: { day: string; warned: boolean; stopped: boolean };
}

export interface BudgetActions {
  /** Stops these agents' sessions. */
  stop(agentIds: string[]): void;
  /** Puts an item on the user's action list. */
  notice(title: string, details: string): void;
}

const KEEP_DAYS = 31;
const SAVE_DELAY_MS = 1000;
const round = (n: number) => Math.round(n * 1e6) / 1e6;
/** The local calendar day, YYYY-MM-DD. */
export const localDay = (d = new Date()) => d.toLocaleDateString("sv");

export class Budget {
  private file: string;
  private data: SpendFile;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private hub: Hub, private actions: BudgetActions) {
    this.file = join(projectHome(hub.slug), "spend.json");
    this.data = this.load();
  }

  private load(): SpendFile {
    const empty: SpendFile = { days: {}, sessions: {}, flags: { day: localDay(), warned: false, stopped: false } };
    try {
      if (!existsSync(this.file)) return empty;
      const saved = JSON.parse(readFileSync(this.file, "utf8")) as Partial<SpendFile>;
      return { days: saved.days ?? {}, sessions: saved.sessions ?? {}, flags: saved.flags ?? empty.flags };
    } catch (err) {
      log.warn("spend.json is unreadable; starting the spend count again:", err);
      return empty;
    }
  }

  private save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    this.saveTimer.unref();
  }

  /** Writes now (HQ is stopping, or the delay is up). */
  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const keep = Object.keys(this.data.days).sort().slice(-KEEP_DAYS);
    this.data.days = Object.fromEntries(keep.map((d) => [d, this.data.days[d]]));
    // A temp file renamed over the old one, so a crash can't leave half a file.
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      log.warn("could not save spend.json:", err);
    }
  }

  /** Only agents that use an API key count. */
  private counts(agentId: string): boolean {
    return this.hub.cfg(agentId)?.auth === "apiKey";
  }

  /** One more call's cost (OpenCode reports it per step). */
  record(agentId: string, usd: number) {
    if (!this.counts(agentId) || !Number.isFinite(usd) || usd <= 0) return;
    const row = (this.data.days[localDay()] ??= {});
    row[agentId] = round((row[agentId] ?? 0) + usd);
    this.save();
    this.refresh();
  }

  /** A session's running total (Claude Code's status line): only the part not seen before is added. */
  recordTotal(agentId: string, sessionId: string, total: number) {
    if (!this.counts(agentId) || !Number.isFinite(total) || total < 0) return;
    const prev = this.data.sessions[agentId];
    const delta = prev && prev.id === sessionId && total >= prev.total ? total - prev.total : total;
    this.data.sessions[agentId] = { id: sessionId, total };
    if (delta > 0) this.record(agentId, delta);
    else if (!prev || prev.id !== sessionId) this.save();
  }

  state(): BudgetState {
    const day = localDay();
    const perAgent = { ...(this.data.days[day] ?? {}) };
    const spentUsd = round(Object.values(perAgent).reduce((a, b) => a + b, 0));
    const dailyUsd = this.hub.snap.config.workflow.budget?.dailyUsd ?? 0;
    return { dailyUsd, spentUsd, perAgent, day, exceeded: budgetLevel(spentUsd, dailyUsd) === "over" };
  }

  /** True when this agent may not start: the limit is reached and it uses an API key. */
  blocks(agentId: string): boolean {
    return this.counts(agentId) && this.state().exceeded;
  }

  /** Recomputes today's state, warns or stops when a threshold is crossed, and tells the browsers. */
  refresh() {
    const day = localDay();
    const flags = this.data.flags;
    if (flags.day !== day) Object.assign(flags, { day, warned: false, stopped: false });
    const b = this.state();
    const level = budgetLevel(b.spentUsd, b.dailyUsd);
    const spent = `${formatUsd(b.spentUsd)} of ${formatUsd(b.dailyUsd)}`;

    if (level === "warn" && !flags.warned) {
      flags.warned = true;
      this.hub.activity("config", null, `Budget: ${spent} used today (${Math.round(BUDGET_WARN_AT * 100)}% of the limit).`);
      this.save();
    }
    if (level === "over" && !flags.stopped) {
      flags.warned = true;
      flags.stopped = true;
      const ids = this.hub.snap.config.team.filter((a) => a.auth === "apiKey" && ["running", "starting"].includes(this.hub.status(a.id)?.session.state ?? "")).map((a) => a.id);
      this.hub.activity("config", null, `Budget reached: ${spent} today. Stopping agents that use an API key.`);
      this.actions.notice(
        `Daily budget reached (${spent})`,
        "HQ stopped the agents that use an API key and won't start them again today. To continue now, raise the daily budget in Settings → Workflow, then press Start. The count starts again at midnight.",
      );
      if (ids.length) this.actions.stop(ids);
      this.save();
    }
    // The limit was raised above today's spend: agents may start again, and the limit can trigger again.
    if (level !== "over" && flags.stopped) {
      flags.stopped = false;
      this.save();
    }

    if (JSON.stringify(this.hub.snap.budget) !== JSON.stringify(b)) {
      this.hub.snap.budget = b;
      this.hub.emit({ type: "budget.updated", budget: b });
    }
  }
}
