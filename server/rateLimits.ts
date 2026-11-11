// Subscription usage limits. A Claude Pro/Max or ChatGPT subscription has windows (Claude and Codex: 5 hours
// and a week), and an agent whose window is used up cannot work until it resets. Each agent signs in with its
// own account, so each agent is followed on its own, from the percentages its own CLI reports (they are the
// account's, so two agents that happen to share an account agree). HQ does not switch to an API key: it waits.
//
//   - Claude Code reports the windows in its status line and fires StopFailure(rate_limit) when a window is
//     used up. It also waits and continues by itself after the reset (when it is allowed to), so HQ's part is
//     to show the wait, keep HQ's own messages from interrupting it, tell the lead not to assign work, and
//     give the agent a nudge if it did not continue.
//   - Codex writes the windows into its session file, which a Stop hook reads after each turn. It prints
//     "You've hit your usage limit …" on its screen when one is used up, which HQ reads.
//
// Before a window runs out (90% used, 10% left) HQ winds the agent down: it saves its work (commit, a draft
// pull request marked "đang làm" with the WIP label, notes on the task, a message to the lead) and then
// pauses until the reset, when it is asked to continue until the work is done.
//
// Agents that use an API key are not covered here (their errors are not a window; the daily budget covers money).

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatReset, LIMIT_WARN_AT, LIMIT_WIND_DOWN_AT } from "../src/data/limits";
import { CLI_LABEL, type AgentLimit, type AgentStatus, type LimitWindow, type Task } from "../src/data/types";
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
  [agentId: string]: { blockedUntil: string | null; windDownUntil: string | null; guessed: boolean };
}

type Phase = NonNullable<AgentStatus["limitPhase"]>;

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
export function readWindows(raw: unknown): AgentLimit["windows"] {
  const r = raw as Record<string, RawWindow | undefined>;
  const out: AgentLimit["windows"] = {};
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
export function wrapUpText(task: Task | undefined, cli: string, pct: number, until: string): string {
  const head = `Your ${cli} usage is at ${Math.round(pct)}% and resets ${formatReset(until)}. Save your work now, then stop.`;
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
  private agents = new Map<string, AgentLimit>();
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
      for (const [agentId, s] of Object.entries(saved)) {
        if (!this.eligible(agentId)) continue;
        const blockedUntil = future(s.blockedUntil) ? s.blockedUntil : null;
        const windDownUntil = future(s.windDownUntil) ? s.windDownUntil : null;
        if (!blockedUntil && !windDownUntil) continue;
        this.agents.set(agentId, { agentId, windows: {}, blockedUntil, windDownUntil, guessed: !!s.guessed });
        this.setPhase(agentId, (blockedUntil ?? windDownUntil)!, blockedUntil ? "blocked" : "paused");
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

  /** Only agents on a Claude or ChatGPT subscription have usage windows (an API key has none). */
  private eligible(agentId: string): boolean {
    const a = this.hub.cfg(agentId);
    return !!a && a.auth === "subscription" && (a.cli === "claude" || a.cli === "codex");
  }

  private get(agentId: string): AgentLimit {
    let s = this.agents.get(agentId);
    if (!s) {
      s = { agentId, windows: {}, blockedUntil: null, windDownUntil: null, guessed: false };
      this.agents.set(agentId, s);
    }
    return s;
  }

  private cli(agentId: string): string {
    const a = this.hub.cfg(agentId);
    return a ? CLI_LABEL[a.cli] : "Agent";
  }

  /** The lead(s) other than this agent: they are told so they don't assign work that can't be done. */
  private leadsExcept(agentId: string) {
    return this.hub.snap.config.team.filter((a) => a.isLead && a.id !== agentId);
  }

  private taskOf(agentId: string): Task | undefined {
    return this.hub.snap.tasks.find((t) => t.ownerId === agentId && t.status === "in-progress");
  }

  /** The time an agent can work again, if its subscription is blocked now. */
  blockedUntil(agentId: string): Date | null {
    const until = this.agents.get(agentId)?.blockedUntil;
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

  /** The agent's usage windows (from its CLI). A full window blocks it until the reset; 90% winds it down. */
  observe(agentId: string, raw: unknown) {
    if (!this.eligible(agentId) || !raw || typeof raw !== "object") return;
    const s = this.get(agentId);
    const next = readWindows(raw);
    s.windows = next;
    // No window at all says nothing about whether the limit is over.
    if (!Object.keys(next).length) return this.publish();

    const names = { fiveHour: "5-hour", sevenDay: "weekly" } as const;
    const full: LimitWindow[] = [];
    const nearly: LimitWindow[] = [];
    for (const [name, w] of Object.entries(next) as [keyof typeof names, LimitWindow][]) {
      if (w.usedPct >= 100) full.push(w);
      else if (w.usedPct >= LIMIT_WIND_DOWN_AT) nearly.push(w);
      if (w.usedPct >= LIMIT_WARN_AT && w.usedPct < 100) {
        const key = `${agentId}:${name}:${w.resetsAt}`;
        if (!this.warned.has(key)) {
          this.warned.add(key);
          this.hub.activity("config", agentId, `${this.hub.name(agentId)}: the ${names[name]} usage window is ${Math.round(w.usedPct)}% used. It resets ${formatReset(w.resetsAt)}.`);
        }
      }
    }
    const latest = (ws: LimitWindow[]) => new Date(Math.max(...ws.map((w) => Date.parse(w.resetsAt))));
    if (full.length) this.block(agentId, latest(full), false);
    else if (nearly.length) this.windDown(agentId, latest(nearly), Math.max(...nearly.map((w) => w.usedPct)));
    else if (s.blockedUntil) this.unblock(agentId, "usage is available again", false);
    else if (s.windDownUntil) this.unblock(agentId, "usage is available again", true);
    this.publish();
  }

  /**
   * The agent could not continue because of its subscription's limit. `until` is the reset, or null when
   * the CLI didn't say: HQ then uses the known window that is used up, or looks again in 30 minutes.
   */
  hit(agentId: string, until: Date | null) {
    if (!this.eligible(agentId)) return;
    const s = this.get(agentId);
    if (!until) {
      if (future(s.blockedUntil)) return this.setPhase(agentId, s.blockedUntil, "blocked"); // already waiting
      const known = Object.values(s.windows)
        .filter((w) => Date.parse(w.resetsAt) > Date.now() && w.usedPct >= LIMIT_WIND_DOWN_AT)
        .sort((a, b) => b.usedPct - a.usedPct)[0];
      if (known) return this.block(agentId, new Date(known.resetsAt), false);
      return this.block(agentId, new Date(Date.now() + GUESS_MS), true);
    }
    this.block(agentId, until, false);
  }

  /** Claude Code continued on its own, so the limit is over. */
  resumed(agentId: string) {
    if (this.agents.get(agentId)?.blockedUntil) this.unblock(agentId, "Claude Code continued", false);
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
    const s = this.agents.get(agentId);
    const until = s?.windDownUntil ?? s?.blockedUntil;
    if (!until) return;
    this.setPhase(agentId, until, "paused");
    const name = this.hub.name(agentId);
    this.hub.activity("agent.answered", agentId, `${name} saved its work and is paused until ${formatReset(until)}.`);
    for (const lead of this.leadsExcept(agentId)) this.deps.notify(lead.id, `${name} saved its work and is paused until ${formatReset(until)} because its ${this.cli(agentId)} usage is nearly used up. Don't assign ${name} anything before then.`);
  }

  /** 90% used: the agent saves its work and pauses until the window resets. */
  private windDown(agentId: string, until: Date, pct: number) {
    const s = this.get(agentId);
    if (future(s.blockedUntil)) return; // already at the limit
    const iso = until.toISOString();
    const old = s.windDownUntil ? Date.parse(s.windDownUntil) : null;
    if (old !== null && Math.abs(old - until.getTime()) < 90_000) return; // already winding down
    s.windDownUntil = iso;
    if (old !== null) {
      // The reset time moved: keep the phase, change the time.
      this.hub.setStatus(agentId, { limitedUntil: iso });
      this.save();
      return this.publish();
    }
    const st = this.hub.status(agentId);
    const task = this.taskOf(agentId);
    const saving = st?.session.state === "running" && !!(task || st.state === "working");
    const cli = this.cli(agentId);
    const name = this.hub.name(agentId);
    if (saving) {
      this.setPhase(agentId, iso, "winding-down");
      this.winding.set(agentId, Date.now());
      this.deps.notify(agentId, wrapUpText(task, cli, pct, iso));
    } else this.setPhase(agentId, iso, "paused");
    this.hub.activity("agent.needs-input", agentId, `${name}'s ${cli} usage is at ${Math.round(pct)}%. ${saving ? "It saves its work (draft PR, notes) and pauses" : "It pauses"} until ${formatReset(iso)}.`);
    const text =
      `${name}'s ${cli} usage is at ${Math.round(pct)}% and resets ${formatReset(iso)}. ${name} ${saving ? "is saving its work (commit, draft PR marked WIP, notes on the task) and will then pause" : "pauses"} until the reset. ` +
      `Don't assign ${name} tasks before then. After the reset HQ tells ${name} to continue until the work is done.`;
    for (const lead of this.leadsExcept(agentId)) this.deps.notify(lead.id, text);
    this.save();
    this.publish();
  }

  private block(agentId: string, until: Date, guessed: boolean) {
    const s = this.get(agentId);
    const old = future(s.blockedUntil) ? Date.parse(s.blockedUntil) : null;
    const iso = until.toISOString();
    // The same wait reported again (a status line repeats itself, a screen is read every few seconds).
    if (old !== null && Math.abs(old - until.getTime()) < 90_000) return;
    s.blockedUntil = iso;
    s.windDownUntil = null; // the limit itself is here: nothing is left to save with
    s.guessed = guessed;
    this.winding.delete(agentId);
    this.setPhase(agentId, iso, "blocked");
    if (old === null) {
      const name = this.hub.name(agentId);
      const when = `${formatReset(iso)}${guessed ? " (HQ will look again then)" : ""}`;
      this.hub.activity("agent.needs-input", agentId, `${name} reached its ${this.cli(agentId)} usage limit and waits until ${when}.`);
      const text = `${name} reached its ${this.cli(agentId)} usage limit and can't work until ${when}. Don't assign ${name} tasks until HQ tells you the limit has reset. The task ${name} already holds continues by itself after the reset.`;
      for (const lead of this.leadsExcept(agentId)) this.deps.notify(lead.id, text);
    }
    this.save();
    this.publish();
  }

  private unblock(agentId: string, why: string, nudge: boolean) {
    const s = this.get(agentId);
    if (!s.blockedUntil && !s.windDownUntil) return;
    s.blockedUntil = null;
    s.windDownUntil = null;
    s.guessed = false;
    this.winding.delete(agentId);
    this.hub.setStatus(agentId, { limitedUntil: null, limitPhase: null, note: "Usage limit over" });
    this.quietUntil.set(agentId, Date.now() + CODEX_QUIET_MS);
    if (nudge) setTimeout(() => this.resume(agentId), this.graceMs).unref();
    const name = this.hub.name(agentId);
    this.hub.activity("config", agentId, `${name}'s usage limit is over (${why}).`);
    for (const lead of this.leadsExcept(agentId)) this.deps.notify(lead.id, `${name}'s ${this.cli(agentId)} usage limit has reset. ${name} can take work again.`);
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
    for (const s of this.agents.values()) {
      const due = [s.blockedUntil, s.windDownUntil].some((t) => t && Date.parse(t) <= now);
      if (due) this.unblock(s.agentId, "it reset", true);
    }
    for (const [id, since] of this.winding) if (now - since > WIND_DOWN_MAX_MS) this.finishWinding(id);
  }

  private save() {
    const saved: Saved = {};
    for (const s of this.agents.values()) if (s.blockedUntil || s.windDownUntil) saved[s.agentId] = { blockedUntil: s.blockedUntil, windDownUntil: s.windDownUntil, guessed: s.guessed };
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(saved, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      log.warn("could not save rate-limits.json:", err);
    }
  }

  private publish() {
    const list = [...this.agents.values()].filter((s) => s.blockedUntil || s.windDownUntil || Object.keys(s.windows).length).map((s) => ({ ...s, windows: { ...s.windows } }));
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
