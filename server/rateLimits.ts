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
// Before a window runs out (90% used, 10% left) HQ winds down: each agent saves its work (commit, a draft
// pull request marked "đang làm" with the WIP label, notes on the task, a message to the lead) and then
// pauses until the reset, when it is asked to continue until the work is done. Claude Code reports the
// percentages in its status line; Codex writes them to its session file, which a hook reads after each turn.
//
// Agents that use an API key are not covered here (their errors are not a window; the daily budget covers money).

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNT_LABEL, formatReset, LIMIT_WARN_AT, LIMIT_WIND_DOWN_AT } from "../src/data/limits";
import type { AccountLimit, AgentStatus, LimitAccount, LimitWindow, Task } from "../src/data/types";
import type { Hub } from "./hub";
import { log } from "./lib/log";
import { projectHome } from "./paths";

/** When the CLI says nothing about the reset, look again after this long. */
const GUESS_MS = 30 * 60_000;
/** After a reset, Claude Code continues by itself. This long later, an agent that is still idle gets a nudge. */
const RESUME_GRACE_MS = 90_000;
/** After a reset, a limit message still on Codex's screen is old: don't read it again for this long. */
const CODEX_QUIET_MS = 10 * 60_000;
/** An agent that has not finished saving its work this long after being asked is paused anyway. */
const WIND_DOWN_MAX_MS = 20 * 60_000;

export interface RateLimitDeps {
  /** Types an HQ message into an agent's terminal (held while the agent is paused or limited). */
  notify(agentId: string, text: string): void;
}

interface Saved {
  [account: string]: { blockedUntil: string | null; windDownUntil: string | null; guessed: boolean };
}

type Phase = NonNullable<AgentStatus["limitPhase"]>;

const isAccount = (v: unknown): v is LimitAccount => v === "anthropic" || v === "openai";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const future = (iso: string | null | undefined): iso is string => !!iso && Date.parse(iso) > Date.now();

interface RawWindow {
  used_percentage?: unknown; // Claude Code
  used_percent?: unknown; // Codex
  resets_at?: unknown; // Unix seconds
  window_minutes?: unknown; // Codex
}

/**
 * The usage windows from what a CLI reports. Claude Code: five_hour / seven_day. Codex: primary / secondary, each with
 * its length in minutes (300 = the 5-hour window, 10080 = the week). A window that is gone has reset.
 */
export function readWindows(raw: unknown): AccountLimit["windows"] {
  const r = raw as Record<string, RawWindow | undefined>;
  const out: AccountLimit["windows"] = {};
  const put = (name: "fiveHour" | "sevenDay", w: RawWindow | undefined) => {
    const pct = w?.used_percentage ?? w?.used_percent;
    if (w && num(pct) && num(w.resets_at)) out[name] = { usedPct: pct, resetsAt: new Date(w.resets_at * 1000).toISOString() };
  };
  put("fiveHour", r.five_hour);
  put("sevenDay", r.seven_day);
  for (const w of [r.primary, r.secondary]) if (w) put(num(w.window_minutes) && w.window_minutes > 1440 ? "sevenDay" : "fiveHour", w);
  return out;
}

/** What an agent is told when its usage is nearly used up: save the work in the way the team can pick it up later. */
export function wrapUpText(task: Task | undefined, label: string, pct: number, until: string): string {
  const head = `Your ${label} usage is at ${Math.round(pct)}% and resets ${formatReset(until)}. Save your work now, then stop.`;
  if (!task) return `${head} You hold no task, so just finish what you are doing in a minute or two and stop. HQ pauses you until the reset and then tells you to continue.`;
  const id = task.id;
  return (
    `${head} In this order: ` +
    `1) Commit everything on your task branch, even if unfinished, and push it: git add -A && git commit -m "[${id}] WIP: <what is done>" && git push -u origin HEAD. ` +
    `2) Open a DRAFT pull request titled "[${id}] ${task.title}" (if one already exists for this branch, update it instead). The first line of its body must be "Đang làm (WIP)", followed by what is done, what is left, and your plan for the next steps. ` +
    `Give it the WIP label: first create the label if it is missing (gh label create WIP --color FBCA04 --description "Work in progress" 2>/dev/null), then gh pr create --draft --label WIP --title "[${id}] ${task.title}" --body "<the body>" (for an existing PR: gh pr edit <number> --add-label WIP). ` +
    `3) Call set_my_status with in-progress and a note with a short summary and your next steps, so they stay on the task. ` +
    `4) Tell the lead with send_message in one or two lines, with the draft PR link. ` +
    `5) Stop. Do not start anything new and do not set the task to in-review. HQ pauses you until the usage resets and then tells you to continue.`
  );
}

/** What an agent is told after the reset, when it holds a task. */
export function resumeText(task: Task): string {
  const done = task.prNumber
    ? `Your draft PR is #${task.prNumber}. When the work is done, mark it ready (gh pr ready ${task.prNumber}), remove the WIP label (gh pr edit ${task.prNumber} --remove-label WIP), replace "Đang làm (WIP)" in its body with a normal description, and call set_my_status with in-review and the PR number.`
    : "When the work is done, open the PR and call set_my_status with in-review and the PR number.";
  return `Your usage has reset. Continue ${task.id} (${task.title}) where you stopped.${task.note ? ` Your saved notes: ${task.note}` : ""} ${done}`;
}

export class RateLimits {
  private accounts = new Map<LimitAccount, AccountLimit>();
  private warned = new Set<string>();
  private quietUntil = new Map<string, number>();
  private seen = new Map<string, string>();
  /** Agents asked to save their work, and when. */
  private winding = new Map<string, number>();
  private file: string;
  private timer: NodeJS.Timeout;

  constructor(private hub: Hub, private deps: RateLimitDeps, private graceMs = RESUME_GRACE_MS) {
    this.file = join(projectHome(hub.slug), "rate-limits.json");
    // A restart during a wait keeps the wait (an agent that was saving its work counts as paused).
    try {
      const saved = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Saved) : {};
      for (const [account, s] of Object.entries(saved)) {
        if (!isAccount(account)) continue;
        const blockedUntil = future(s.blockedUntil) ? s.blockedUntil : null;
        const windDownUntil = future(s.windDownUntil) ? s.windDownUntil : null;
        if (!blockedUntil && !windDownUntil) continue;
        this.accounts.set(account, { account, windows: {}, blockedUntil, windDownUntil, guessed: !!s.guessed });
        for (const id of this.agentsOf(account)) this.setPhase(id, (blockedUntil ?? windDownUntil)!, blockedUntil ? "blocked" : "paused");
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
    if (!s) {
      s = { account, windows: {}, blockedUntil: null, windDownUntil: null, guessed: false };
      this.accounts.set(account, s);
    }
    return s;
  }

  private leadsOutside(account: LimitAccount) {
    return this.hub.snap.config.team.filter((a) => a.isLead && this.accountOf(a.id) !== account);
  }

  private taskOf(agentId: string): Task | undefined {
    return this.hub.snap.tasks.find((t) => t.ownerId === agentId && t.status === "in-progress");
  }

  /** The time an agent can work again, if its subscription is blocked now. */
  blockedUntil(agentId: string): Date | null {
    const account = this.accountOf(agentId);
    const until = account ? this.accounts.get(account)?.blockedUntil : null;
    return future(until) ? new Date(until) : null;
  }

  private setPhase(agentId: string, until: string, phase: Phase) {
    const note =
      phase === "winding-down"
        ? "Usage nearly used up: saving work"
        : phase === "paused"
          ? `Work saved. Paused until ${formatReset(until)}`
          : `Usage limit: back ${formatReset(until)}`;
    this.hub.setStatus(agentId, { ...(phase === "blocked" ? { state: "idle" as const } : {}), limitedUntil: until, limitPhase: phase, note });
  }

  /** Claude Code's status line: the account's usage windows. A full window blocks the account until it resets; 90% winds it down. */
  observe(agentId: string, raw: unknown) {
    const account = this.accountOf(agentId);
    if (!account || !raw || typeof raw !== "object") return;
    const s = this.get(account);
    const next = readWindows(raw);
    s.windows = next;
    // No window at all says nothing about whether the limit is over.
    if (!Object.keys(next).length) return this.publish();

    const label = ACCOUNT_LABEL[account];
    const names = { fiveHour: "5-hour", sevenDay: "weekly" } as const;
    const full: LimitWindow[] = [];
    const nearly: LimitWindow[] = [];
    for (const [name, w] of Object.entries(next) as [keyof typeof names, LimitWindow][]) {
      if (w.usedPct >= 100) full.push(w);
      else if (w.usedPct >= LIMIT_WIND_DOWN_AT) nearly.push(w);
      if (w.usedPct >= LIMIT_WARN_AT && w.usedPct < 100) {
        const key = `${account}:${name}:${w.resetsAt}`;
        if (!this.warned.has(key)) {
          this.warned.add(key);
          this.hub.activity("config", null, `${label}: the ${names[name]} usage window is ${Math.round(w.usedPct)}% used. It resets ${formatReset(w.resetsAt)}.`);
        }
      }
    }
    const latest = (ws: LimitWindow[]) => new Date(Math.max(...ws.map((w) => Date.parse(w.resetsAt))));
    if (full.length) this.block(account, latest(full), false);
    else if (nearly.length) this.windDown(account, latest(nearly), Math.max(...nearly.map((w) => w.usedPct)));
    else if (s.blockedUntil) this.unblock(account, "usage is available again", false);
    else if (s.windDownUntil) this.unblock(account, "usage is available again", true);
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
    const open = future(s.blockedUntil);
    if (!until) {
      if (open) return this.applyToAgents(account, s.blockedUntil!, "blocked"); // already waiting
      const known = Object.values(s.windows)
        .filter((w) => Date.parse(w.resetsAt) > Date.now() && w.usedPct >= LIMIT_WIND_DOWN_AT)
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

  /** An agent's turn ended (Stop). One that was saving its work and has nothing queued is done: it pauses until the reset. */
  turnEnded(agentId: string, queued: number) {
    if (!this.winding.has(agentId) || queued > 0) return;
    this.finishWinding(agentId);
  }

  private finishWinding(agentId: string) {
    this.winding.delete(agentId);
    const account = this.accountOf(agentId);
    const s = account ? this.accounts.get(account) : undefined;
    const until = s?.windDownUntil ?? s?.blockedUntil;
    if (!account || !until) return;
    this.setPhase(agentId, until, "paused");
    const name = this.hub.name(agentId);
    this.hub.activity("agent.answered", agentId, `${name} saved its work and is paused until ${formatReset(until)}.`);
    for (const lead of this.leadsOutside(account))
      this.deps.notify(lead.id, `${name} saved its work and is paused until ${formatReset(until)} because ${ACCOUNT_LABEL[account]} usage is nearly used up. Don't assign ${name} anything before then.`);
  }

  private applyToAgents(account: LimitAccount, until: string, phase: Phase) {
    for (const id of this.agentsOf(account)) this.setPhase(id, until, phase);
  }

  /** 90% used: agents save their work and pause until the window resets. */
  private windDown(account: LimitAccount, until: Date, pct: number) {
    const s = this.get(account);
    if (future(s.blockedUntil)) return; // already at the limit
    const iso = until.toISOString();
    const old = s.windDownUntil ? Date.parse(s.windDownUntil) : null;
    if (old !== null && Math.abs(old - until.getTime()) < 90_000) return; // already winding down
    s.windDownUntil = iso;
    const label = ACCOUNT_LABEL[account];
    if (old !== null) {
      // The reset time moved: keep each agent's phase, change the time.
      for (const id of this.agentsOf(account)) this.hub.setStatus(id, { limitedUntil: iso });
      this.save();
      return this.publish();
    }
    const asked: string[] = [];
    for (const id of this.agentsOf(account)) {
      const st = this.hub.status(id);
      const task = this.taskOf(id);
      if (st?.session.state === "running" && (task || st.state === "working")) {
        this.setPhase(id, iso, "winding-down");
        this.winding.set(id, Date.now());
        this.deps.notify(id, wrapUpText(task, label, pct, iso));
        asked.push(this.hub.name(id));
      } else this.setPhase(id, iso, "paused");
    }
    const names = this.agentsOf(account).map((id) => this.hub.name(id)).join(", ");
    this.hub.activity("agent.needs-input", null, `${label} usage is at ${Math.round(pct)}%. ${asked.length ? `${asked.join(", ")} save their work (draft PR, notes)` : "Agents pause"} until ${formatReset(iso)}.`);
    const text =
      `${label} usage is at ${Math.round(pct)}% and resets ${formatReset(iso)}. ${names} ${asked.length ? "are saving their work (commit, draft PR marked WIP, notes on the task) and will then pause" : "pause"} until the reset. ` +
      `Don't assign them tasks before then. After the reset HQ tells them to continue until the work is done.`;
    for (const lead of this.leadsOutside(account)) this.deps.notify(lead.id, text);
    this.save();
    this.publish();
  }

  private block(account: LimitAccount, until: Date, guessed: boolean) {
    const s = this.get(account);
    const old = future(s.blockedUntil) ? Date.parse(s.blockedUntil) : null;
    const iso = until.toISOString();
    // The same wait reported again (a status line repeats itself, a screen is read every few seconds).
    if (old !== null && Math.abs(old - until.getTime()) < 90_000) return;
    s.blockedUntil = iso;
    s.windDownUntil = null; // the limit itself is here: nothing is left to save with
    s.guessed = guessed;
    for (const id of this.agentsOf(account)) this.winding.delete(id);
    this.applyToAgents(account, iso, "blocked");
    if (old === null) {
      const names = this.agentsOf(account).map((id) => this.hub.name(id)).join(", ");
      const when = `${formatReset(iso)}${guessed ? " (HQ will look again then)" : ""}`;
      this.hub.activity("agent.needs-input", null, `${ACCOUNT_LABEL[account]} usage limit reached. ${names} wait until ${when}.`);
      const text = `The ${ACCOUNT_LABEL[account]} usage limit is reached: ${names} can't work until ${when}. Don't assign them tasks until HQ tells you the limit has reset. Tasks they already hold continue by themselves after the reset.`;
      for (const lead of this.leadsOutside(account)) this.deps.notify(lead.id, text);
    }
    this.save();
    this.publish();
  }

  private unblock(account: LimitAccount, why: string, nudge: boolean) {
    const s = this.get(account);
    if (!s.blockedUntil && !s.windDownUntil) return;
    s.blockedUntil = null;
    s.windDownUntil = null;
    s.guessed = false;
    const ids = this.agentsOf(account);
    for (const id of ids) {
      this.winding.delete(id);
      this.hub.setStatus(id, { limitedUntil: null, limitPhase: null, note: "Usage limit over" });
      this.quietUntil.set(id, Date.now() + CODEX_QUIET_MS);
      if (nudge) setTimeout(() => this.resume(id), this.graceMs).unref();
    }
    this.hub.activity("config", null, `${ACCOUNT_LABEL[account]} usage limit is over (${why}).`);
    for (const lead of this.leadsOutside(account))
      this.deps.notify(lead.id, `The ${ACCOUNT_LABEL[account]} usage limit has reset. ${ids.map((id) => this.hub.name(id)).join(", ")} can take work again.`);
    this.save();
    this.publish();
  }

  /** After the grace, an agent that still holds a task and is not working did not continue by itself. */
  private resume(agentId: string) {
    const st = this.hub.status(agentId);
    if (!st || st.session.state !== "running" || st.state === "working" || st.limitedUntil) return;
    const task = this.taskOf(agentId);
    if (!task) return;
    this.hub.activity("agent.answered", agentId, `HQ asked ${this.hub.name(agentId)} to continue ${task.id} after the usage reset.`);
    this.deps.notify(agentId, resumeText(task));
  }

  /** Ends a wait whose time has come, and pauses an agent that is taking too long to save its work. */
  tick(now = Date.now()) {
    for (const s of this.accounts.values()) {
      const due = [s.blockedUntil, s.windDownUntil].some((t) => t && Date.parse(t) <= now);
      if (due) this.unblock(s.account, "it reset", true);
    }
    for (const [id, since] of this.winding) if (now - since > WIND_DOWN_MAX_MS) this.finishWinding(id);
  }

  private save() {
    const saved: Saved = {};
    for (const s of this.accounts.values()) if (s.blockedUntil || s.windDownUntil) saved[s.account] = { blockedUntil: s.blockedUntil, windDownUntil: s.windDownUntil, guessed: s.guessed };
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(saved, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      log.warn("could not save rate-limits.json:", err);
    }
  }

  private publish() {
    const list = [...this.accounts.values()].filter((s) => s.blockedUntil || s.windDownUntil || Object.keys(s.windows).length).map((s) => ({ ...s, windows: { ...s.windows } }));
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
