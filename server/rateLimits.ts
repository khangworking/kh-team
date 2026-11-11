// Subscription usage limits. A Claude Pro/Max or ChatGPT subscription has windows (Claude: 5 hours and
// a week) and every agent signed in with it is stopped together when one is used up. HQ does not
// switch to an API key: it waits for the reset.
//
//   - Claude Code reports the windows in its status line and fires StopFailure(rate_limit) when a
//     window is used up. Claude Code also waits and continues by itself after the reset (when it
//     is allowed to), so HQ's part is to show the wait, keep HQ's own messages from interrupting it,
//     tell the lead not to assign work, and give the agent a nudge if it did not continue.
//   - Codex prints "You've hit your usage limit …" on its screen, which HQ reads.
//
// Agents that use an API key are not covered here (their errors are not a window; the daily budget covers money).

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNT_LABEL, formatReset, LIMIT_WARN_AT } from "../src/data/limits";
import type { AccountLimit, LimitAccount, LimitWindow } from "../src/data/types";
import type { Hub } from "./hub";
import { log } from "./lib/log";
import { projectHome } from "./paths";

/** When the CLI says nothing about the reset, look again after this long. */
const GUESS_MS = 30 * 60_000;
/** After a reset, Claude Code continues by itself. This long later, an agent that is still idle gets a nudge. */
const RESUME_GRACE_MS = 90_000;
/** After a reset, a limit message still on Codex's screen is old: don't read it again for this long. */
const CODEX_QUIET_MS = 10 * 60_000;

export interface RateLimitDeps {
  /** Types an HQ message into an agent's terminal (held while the agent is limited). */
  notify(agentId: string, text: string): void;
}

interface Saved {
  [account: string]: { blockedUntil: string; guessed: boolean };
}

const isAccount = (v: unknown): v is LimitAccount => v === "anthropic" || v === "openai";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export class RateLimits {
  private accounts = new Map<LimitAccount, AccountLimit>();
  private warned = new Set<string>();
  private quietUntil = new Map<string, number>();
  private seen = new Map<string, string>();
  private file: string;
  private timer: NodeJS.Timeout;

  constructor(private hub: Hub, private deps: RateLimitDeps, private graceMs = RESUME_GRACE_MS) {
    this.file = join(projectHome(hub.slug), "rate-limits.json");
    // A restart during a wait keeps the wait.
    try {
      const saved = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Saved) : {};
      for (const [account, s] of Object.entries(saved)) {
        if (isAccount(account) && Date.parse(s.blockedUntil) > Date.now()) {
          this.accounts.set(account, { account, windows: {}, blockedUntil: s.blockedUntil, guessed: !!s.guessed });
          this.applyToAgents(account, s.blockedUntil);
        }
      }
    } catch (err) {
      log.warn("rate-limits.json is unreadable; ignoring it:", err);
    }
    this.publish();
    this.timer = setInterval(() => this.tick(), 15_000);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** The subscription an agent's usage counts against, or null (API-key agents have none). */
  private accountOf(agentId: string): LimitAccount | null {
    const a = this.hub.cfg(agentId);
    return a && a.auth === "subscription" && isAccount(a.provider) ? a.provider : null;
  }

  private agentsOf(account: LimitAccount): string[] {
    return this.hub.snap.config.team.filter((a) => this.accountOf(a.id) === account).map((a) => a.id);
  }

  private get(account: LimitAccount): AccountLimit {
    let s = this.accounts.get(account);
    if (!s) this.accounts.set(account, (s = { account, windows: {}, blockedUntil: null, guessed: false }));
    return s;
  }

  /** The time an agent can work again, if its subscription is blocked now. */
  blockedUntil(agentId: string): Date | null {
    const account = this.accountOf(agentId);
    const until = account ? this.accounts.get(account)?.blockedUntil : null;
    return until && Date.parse(until) > Date.now() ? new Date(until) : null;
  }

  /** Claude Code's status line: the account's usage windows. A full window blocks the account until it resets. */
  observe(agentId: string, raw: unknown) {
    const account = this.accountOf(agentId);
    const limits = raw as { five_hour?: { used_percentage?: unknown; resets_at?: unknown }; seven_day?: { used_percentage?: unknown; resets_at?: unknown } } | undefined;
    if (!account || !limits || typeof limits !== "object") return;
    const s = this.get(account);
    const next: AccountLimit["windows"] = {};
    for (const [key, name] of [["five_hour", "fiveHour"], ["seven_day", "sevenDay"]] as const) {
      const w = limits[key];
      // resets_at is Unix seconds. A window that is gone has reset.
      if (w && num(w.used_percentage) && num(w.resets_at)) next[name] = { usedPct: w.used_percentage, resetsAt: new Date(w.resets_at * 1000).toISOString() };
    }
    s.windows = next;
    // No window at all says nothing about whether the limit is over.
    if (!Object.keys(next).length) return this.publish();

    const label = ACCOUNT_LABEL[account];
    const names = { fiveHour: "5-hour", sevenDay: "weekly" } as const;
    const full: LimitWindow[] = [];
    for (const [name, w] of Object.entries(next) as [keyof typeof names, LimitWindow][]) {
      if (w.usedPct >= 100) full.push(w);
      else if (w.usedPct >= LIMIT_WARN_AT) {
        const key = `${account}:${name}:${w.resetsAt}`;
        if (!this.warned.has(key)) {
          this.warned.add(key);
          this.hub.activity("config", null, `${label}: the ${names[name]} usage window is ${Math.round(w.usedPct)}% used. It resets ${formatReset(w.resetsAt)}.`);
        }
      }
    }
    if (full.length) this.block(account, new Date(Math.max(...full.map((w) => Date.parse(w.resetsAt)))), false);
    else if (s.blockedUntil) this.unblock(account, "usage is available again", false);
    this.publish();
  }

  /**
   * An agent could not continue because of its subscription's limit. `until` is the reset, or null when
   * the CLI didn't say: HQ then uses the known window that is used up, or looks again in 30 minutes.
   */
  hit(agentId: string, until: Date | null) {
    const account = this.accountOf(agentId);
    if (!account) return;
    const s = this.get(account);
    const open = s.blockedUntil !== null && Date.parse(s.blockedUntil) > Date.now();
    if (!until) {
      if (open) return this.applyToAgents(account, s.blockedUntil!); // already waiting
      const known = Object.values(s.windows)
        .filter((w) => Date.parse(w.resetsAt) > Date.now() && w.usedPct >= 90)
        .sort((a, b) => b.usedPct - a.usedPct)[0];
      if (known) return this.block(account, new Date(known.resetsAt), false);
      return this.block(account, new Date(Date.now() + GUESS_MS), true);
    }
    this.block(account, until, false);
  }

  /** Claude Code continued on its own, so the limit is over. */
  resumed(agentId: string) {
    const account = this.accountOf(agentId);
    if (account && this.accounts.get(account)?.blockedUntil) this.unblock(account, "Claude Code continued", false);
  }

  /**
   * Codex prints its limit on screen, and the message stays there. Each message is handled once (a relative
   * "try again in 3 hours" would otherwise slide later at every look), and one left over from before a reset is old.
   */
  codexScreen(agentId: string, screen: string) {
    if ((this.quietUntil.get(agentId) ?? 0) > Date.now()) return;
    const limit = parseCodexLimit(screen);
    if (!limit) return;
    const line = screen.split("\n").filter((l) => /usage limit|try again/i.test(l)).join("|").replace(/\s+/g, " ").trim();
    if (this.seen.get(agentId) === line) return;
    this.seen.set(agentId, line);
    this.hit(agentId, limit.until);
  }

  private applyToAgents(account: LimitAccount, until: string) {
    for (const id of this.agentsOf(account)) this.hub.setStatus(id, { state: "idle", limitedUntil: until, note: `Usage limit: back ${formatReset(until)}` });
  }

  private block(account: LimitAccount, until: Date, guessed: boolean) {
    const s = this.get(account);
    const old = s.blockedUntil && Date.parse(s.blockedUntil) > Date.now() ? Date.parse(s.blockedUntil) : null;
    const iso = until.toISOString();
    // The same wait reported again (a status line repeats itself, a screen is read every few seconds).
    if (old !== null && Math.abs(old - until.getTime()) < 90_000) return;
    s.blockedUntil = iso;
    s.guessed = guessed;
    this.applyToAgents(account, iso);
    if (old === null) {
      const ids = this.agentsOf(account);
      const names = ids.map((id) => this.hub.name(id)).join(", ");
      const when = `${formatReset(iso)}${guessed ? " (HQ will look again then)" : ""}`;
      this.hub.activity("agent.needs-input", null, `${ACCOUNT_LABEL[account]} usage limit reached. ${names} wait until ${when}.`);
      const text = `The ${ACCOUNT_LABEL[account]} usage limit is reached: ${names} can't work until ${when}. Don't assign them tasks until HQ tells you the limit has reset. Tasks they already hold continue by themselves after the reset.`;
      for (const lead of this.hub.snap.config.team.filter((a) => a.isLead && this.accountOf(a.id) !== account)) this.deps.notify(lead.id, text);
    }
    this.save();
    this.publish();
  }

  private unblock(account: LimitAccount, why: string, nudge: boolean) {
    const s = this.get(account);
    if (!s.blockedUntil) return;
    s.blockedUntil = null;
    s.guessed = false;
    const ids = this.agentsOf(account);
    for (const id of ids) {
      this.hub.setStatus(id, { limitedUntil: null, note: "Usage limit over" });
      this.quietUntil.set(id, Date.now() + CODEX_QUIET_MS);
      if (nudge) setTimeout(() => this.resume(id), this.graceMs).unref();
    }
    this.hub.activity("config", null, `${ACCOUNT_LABEL[account]} usage limit is over (${why}).`);
    for (const lead of this.hub.snap.config.team.filter((a) => a.isLead && this.accountOf(a.id) !== account))
      this.deps.notify(lead.id, `The ${ACCOUNT_LABEL[account]} usage limit has reset. ${ids.map((id) => this.hub.name(id)).join(", ")} can take work again.`);
    this.save();
    this.publish();
  }

  /** After the grace, an agent that still holds a task and is not working did not continue by itself. */
  private resume(agentId: string) {
    const st = this.hub.status(agentId);
    if (!st || st.session.state !== "running" || st.state === "working" || st.limitedUntil) return;
    const task = this.hub.snap.tasks.find((t) => t.ownerId === agentId && t.status === "in-progress");
    if (!task) return;
    this.hub.activity("agent.answered", agentId, `HQ asked ${this.hub.name(agentId)} to continue ${task.id} after the usage limit.`);
    this.deps.notify(agentId, `Your usage limit has reset. Continue ${task.id} (${task.title}) where you stopped.`);
  }

  /** Ends a wait whose time has come. */
  tick(now = Date.now()) {
    for (const s of this.accounts.values()) if (s.blockedUntil && Date.parse(s.blockedUntil) <= now) this.unblock(s.account, "it reset", true);
  }

  private save() {
    const saved: Saved = {};
    for (const s of this.accounts.values()) if (s.blockedUntil) saved[s.account] = { blockedUntil: s.blockedUntil, guessed: s.guessed };
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(saved, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      log.warn("could not save rate-limits.json:", err);
    }
  }

  private publish() {
    const list = [...this.accounts.values()].filter((s) => s.blockedUntil || Object.keys(s.windows).length).map((s) => ({ ...s, windows: { ...s.windows } }));
    if (JSON.stringify(this.hub.snap.rateLimits ?? []) === JSON.stringify(list)) return;
    this.hub.snap.rateLimits = list;
    this.hub.emit({ type: "rateLimits.updated", limits: list });
  }
}

/** What Codex prints when the ChatGPT limit is used up, and when it says it will work again (null = not said). */
export function parseCodexLimit(screen: string, now = Date.now()): { until: Date | null } | null {
  if (!/hit your usage limit|usage limit (?:reached|exceeded)|reached your usage limit/i.test(screen)) return null;
  // "try again in 2 days 3 hours 5 minutes"
  const rel = /(?:try again|available again|resets?)\s+in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,and]*)+)/i.exec(screen);
  if (rel) {
    let ms = 0;
    for (const m of rel[1].matchAll(/(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) {
      const n = Number(m[1]);
      const u = m[2].toLowerCase()[0];
      ms += n * (u === "d" ? 86_400_000 : u === "h" ? 3_600_000 : u === "m" ? 60_000 : 1000);
    }
    if (ms > 0) return { until: new Date(now + ms) };
  }
  // "try again at 3:45 PM"
  const at = /(?:try again|available again|resets?)\s+(?:at|on)\s+([^\n.]+)/i.exec(screen);
  if (at) {
    const clock = /(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(at[1]);
    if (clock) {
      let h = Number(clock[1]);
      const pm = clock[3]?.toLowerCase();
      if (pm === "pm" && h < 12) h += 12;
      if (pm === "am" && h === 12) h = 0;
      const d = new Date(now);
      d.setHours(h, Number(clock[2]), 0, 0);
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      return { until: d };
    }
    const parsed = Date.parse(at[1]);
    if (Number.isFinite(parsed) && parsed > now) return { until: new Date(parsed) };
  }
  return { until: null };
}
