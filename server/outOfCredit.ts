// An agent that uses an API key can run out of credit in the middle of a task (the provider answers
// "Insufficient Balance", "credit balance is too low", a billing error …). It cannot continue, and it cannot
// summarize what it did. So HQ does it from what is on disk:
//
//   - the task gets a note with what the agent did (its branch, commits not on main, uncommitted files,
//     where the work is), goes back to todo with no owner, and is put ON HOLD: the lead may not assign it
//     again. Only the user assigns it, when they say so; then the new owner reads the note.
//   - the agent is marked out of credit (the lead's list_workers says so and assign_task refuses it) until
//     it is restarted, and the user gets an action item.
//   - the lead is told.
//
// Subscription agents are not covered (their limits are usage windows: rateLimits.ts).

import { existsSync } from "node:fs";
import { PROVIDER_INFO } from "../src/data/providers";
import type { Task } from "../src/data/types";
import type { Hub } from "./hub";
import { run } from "./lib/exec";
import type { Planner } from "./planner";

/** What providers and CLIs say when an account has no credit left. */
export const CREDIT_ERROR = /quota ?exceeded|insufficient[\s_-]*(?:balance|credits?|funds|quota)|credit balance|out of credits?|no credits? (?:left|remaining)|payment required|exceeded your current quota|billing_error/i;

export const isOutOfCredit = (text: string) => CREDIT_ERROR.test(text);

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const git = async (dir: string, args: string[]) => {
  const r = await run("git", args, { cwd: dir, timeoutMs: 15_000 });
  return r.ok ? r.stdout.trim() : "";
};

/** What the agent's folder shows about its work on a task: facts, not a guess. */
export async function gitFacts(dir: string): Promise<string> {
  if (!existsSync(dir)) return "its folder is gone";
  const branch = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  // The branch the work started from: origin's default branch, else main or master.
  let base = "";
  for (const ref of [await git(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]), "origin/main", "origin/master", "main", "master"]) {
    if (ref && (await git(dir, ["rev-parse", "--verify", "--quiet", ref]))) {
      base = ref;
      break;
    }
  }
  const subjects = base ? (await git(dir, ["log", "--format=%s", "-n", "5", `${base}..HEAD`])).split("\n").filter(Boolean) : [];
  const ahead = base ? Number(await git(dir, ["rev-list", "--count", `${base}..HEAD`])) || subjects.length : 0;
  const changed = (await git(dir, ["status", "--porcelain"])).split("\n").filter(Boolean).map((l) => l.slice(3).trim());
  const unpushed = (await git(dir, ["log", "--oneline", "--branches", "--not", "--remotes"])).split("\n").filter(Boolean).length;
  const parts = [
    `branch ${branch || "(unknown)"}`,
    ahead ? `${ahead} commit${ahead === 1 ? "" : "s"} not on ${base.replace(/^origin\//, "")}: ${subjects.map((s) => `"${clip(s, 50)}"`).join("; ")}${ahead > subjects.length ? "; …" : ""}` : "no commits of its own yet",
    changed.length ? `${changed.length} uncommitted file${changed.length === 1 ? "" : "s"} (${changed.slice(0, 6).join(", ")}${changed.length > 6 ? ", …" : ""})` : "nothing uncommitted",
    unpushed ? "NOT pushed to GitHub" : "pushed",
  ];
  return parts.join("; ");
}

export interface CreditDeps {
  /** The agent's folder on this machine. */
  dirOf(agentId: string): string | null;
  /** Puts an item on the user's action list. */
  notice(title: string, details: string): void;
}

export class OutOfCredit {
  private handled = new Map<string, number>();

  constructor(private hub: Hub, private planner: Planner, private deps: CreditDeps) {}

  /** The agent was restarted (a new session), presumably with credit: it may work again. */
  clear(agentId: string) {
    if (this.hub.status(agentId)?.outOfCredit) this.hub.setStatus(agentId, { outOfCredit: null });
  }

  /** The provider said the account has no credit left. `text` is the provider's error. */
  async handle(agentId: string, text: string) {
    const agent = this.hub.cfg(agentId);
    if (!agent || agent.auth !== "apiKey") return;
    if (Date.now() - (this.handled.get(agentId) ?? 0) < 60_000) return; // one failure is reported more than once
    this.handled.set(agentId, Date.now());
    const hub = this.hub;
    const name = agent.name;
    const provider = PROVIDER_INFO[agent.provider].label;
    const reason = clip(text.replace(/\s+/g, " ").replace(/\(request_id:[^)]*\)/i, "").trim(), 100);
    // Read before HQ adds its own lines to the feed.
    const recent = hub.snap.activity.filter((a) => a.agentId === agentId).slice(0, 3).map((a) => clip(a.text, 70)).reverse();
    hub.setStatus(agentId, { state: "needs-input", outOfCredit: reason, note: `Out of credit (${provider}). Add credit or change the key, then restart ${name}.` });
    hub.activity("agent.needs-input", agentId, `${name} is out of credit (${provider}: ${reason}).`);

    const task: Task | undefined = hub.snap.tasks.find((t) => t.ownerId === agentId && t.status === "in-progress");
    let taskLine = `${name} held no task in progress.`;
    if (task) {
      const dir = this.deps.dirOf(agentId);
      const facts = dir ? await gitFacts(dir) : "its folder is unknown";
      const when = new Date().toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      const note = clip(
        `[HQ ${when}] ${name} ran out of credit (${provider}: ${reason}) while working on this. What it did: ${facts}. ${dir ? `The work is in ${name}'s folder ${dir}.` : ""}${recent.length ? ` Its last steps: ${recent.join(" / ")}.` : ""} ` +
          `Back in todo and on hold: HQ assigns it again only when the user says so.`,
        1000,
      );
      this.planner.updateTask(task.id, { status: "todo", ownerId: null, note, hold: `${name} ran out of credit` });
      hub.setStatus(agentId, { currentTaskId: null });
      hub.activity("config", agentId, `${task.id} went back to todo with a summary of ${name}'s work. It is on hold until you assign it.`);
      taskLine = `${task.id} (${task.title}) went back to todo with a summary of what ${name} did in its note, and is ON HOLD.`;
    }

    const lead = hub.snap.config.team.find((a) => a.isLead && a.id !== agentId);
    if (lead)
      this.planner.notify(
        lead.id,
        `${name} ran out of credit (${provider}) and can't work. ${taskLine}${task ? ` Do not assign ${task.id} again, to anyone: only the user does, when they say so. The summary is in the task's note.` : ""} Don't assign ${name} anything until it is restarted.`,
      );
    this.deps.notice(
      `${name} is out of credit (${provider})`,
      `${name}'s provider says: ${reason}. ${task ? `${task.id} went back to todo with a summary of the work so far (see the task's note) and is on hold: it stays unassigned until you assign it. ` : ""}` +
        `To continue: add credit to the ${provider} account (or change ${name}'s provider or key in Settings → Team), then restart ${name}.`,
    );
  }
}
