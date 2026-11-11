// Polls GitHub, keeps the office's PRs in sync, and runs the review automations:
// comments → tell the author; passed → tell the lead; merged → task done.

import type { PullRequest } from "../src/data/types";
import { branchAgent, fetchPrs, OPEN_LIMIT, RateLimited, taskIdOf, toPullRequest } from "./github";
import type { Hub } from "./hub";
import { run } from "./lib/exec";
import { log } from "./lib/log";
import type { Planner } from "./planner";

const MERGE_CMD = (n: number | string) => `gh pr merge ${n} --squash --delete-branch`;

/** What the lead is told when a PR passes review: merge it, or leave it to the user (Settings → Workflow → Merge). */
export function passedNotice(pr: Pick<PullRequest, "number" | "title">, author: string, by: "human" | "lead"): string {
  const head = `PR #${pr.number} (${pr.title}) by ${author} passed review.`;
  return by === "lead"
    ? `${head} You merge PRs on this project: run \`${MERGE_CMD(pr.number)}\` now. If GitHub refuses (conflicts or failing checks), ask the author to fix it instead. Then assign the next task if anything is waiting.`
    : `${head} It's ready for the user to merge. Don't merge it yourself.`;
}

/** What the lead is told when the user changes who merges, with the PRs already waiting. */
export function mergeByNotice(by: "human" | "lead", waiting: number[]): string {
  if (by === "human") return "The user changed the workflow: the user merges PRs now. Don't merge PRs yourself.";
  const list = waiting.length ? ` These passed review and are waiting: ${waiting.map((n) => `#${n}`).join(", ")}. Merge each with \`${MERGE_CMD("<number>")}\`.` : "";
  return `The user changed the workflow: you now merge PRs once they pass review.${list}`;
}

const MIN_POLL_MS = 20_000; // never more often than this (nudges included)
const MAX_POLL_MS = 5 * 60_000;
const HQ_BUDGET = 1200; // GraphQL points per hour HQ may use; the rest of the 5,000 is left for the agents' gh commands
const LOW_REMAINING = 800; // below this, poll at most every 2 minutes
const label = { coderabbit: "CodeRabbit", greptile: "Greptile", copilot: "Copilot", human: "The reviewer", custom: "The review check" } as const;

export class GitHubSync {
  private prev = new Map<number, PullRequest>();
  private first = true;
  private timer: NodeJS.Timeout | null = null;
  private nudgeTimer: NodeJS.Timeout | null = null;
  private busy = false;
  private lastError: string | null = null;
  private lastFetch = 0;
  private interval = MIN_POLL_MS;
  private pausedUntil = 0;
  /** Draft PRs that already carry the WIP label (checked once per run). */
  private wip = new Set<number>();
  private wipLabelReady = false;

  constructor(private hub: Hub, private planner: Planner, private repo: string | null) {}

  start() {
    if (!this.repo) {
      log.warn("No GitHub remote: PRs and reviews are off.");
      return;
    }
    void this.tick();
    // Check sooner when an agent finishes a turn (it may have run `gh pr create`)
    // or reports a PR with set_my_status in-review.
    let reviewCfg = JSON.stringify(this.hub.snap.config.workflow.review);
    this.hub.subscribe((e) => {
      // A review-settings change re-labels existing PRs; take a fresh baseline
      // instead of treating that as new review activity.
      if (e.type === "config.updated" && JSON.stringify(e.config.workflow.review) !== reviewCfg) {
        reviewCfg = JSON.stringify(e.config.workflow.review);
        this.first = true;
        this.nudge(500);
      }
      if (e.type === "activity" && e.event.type === "agent.answered") this.nudge();
      if (e.type === "task.updated" && e.task.status === "in-review") this.nudge(1500);
    });
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
  }

  /** One poll, then schedule the next at the current interval. */
  private async tick() {
    await this.refresh();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), Math.max(this.interval, this.pausedUntil - Date.now()));
  }

  /** Refresh soon (debounced): an agent just opened a PR or finished a turn. Still respects the minimum gap and any pause. */
  nudge(delayMs = 3000) {
    if (!this.repo) return;
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    const wait = Math.max(delayMs, this.lastFetch + MIN_POLL_MS - Date.now(), this.pausedUntil - Date.now());
    this.nudgeTimer = setTimeout(() => void this.refresh(), wait);
  }

  /** Poll often enough to stay within HQ's share of the budget; slow down when it runs low. */
  private pace(rate: { cost: number; remaining: number } | null) {
    if (!rate) return;
    const forBudget = Math.ceil((Math.max(1, rate.cost) * 3_600_000) / HQ_BUDGET);
    const low = rate.remaining < LOW_REMAINING ? 120_000 : 0;
    this.interval = Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, forBudget, low));
  }

  async refresh() {
    if (!this.repo || this.busy || Date.now() < this.pausedUntil) return;
    // Never closer together than the minimum gap (a nudge can land right after a regular poll).
    if (Date.now() - this.lastFetch < MIN_POLL_MS - 1000) return;
    if (!this.hub.snap.setup.checks.find((c) => c.id === "gh" && c.status === "ok")) return;
    this.busy = true;
    this.lastFetch = Date.now();
    try {
      const { open, merged, closed, rate } = await fetchPrs(this.repo);
      if (this.lastError) log.info("GitHub reachable again");
      this.lastError = null;
      this.pace(rate);
      const wf = this.hub.snap.config.workflow;
      const team = new Set(this.hub.snap.config.team.map((a) => a.id));
      const next = [...open, ...merged].map((gh) => {
        const taskId = taskIdOf(gh);
        const task = taskId ? this.planner.task(taskId) : undefined;
        const fromBranch = branchAgent(gh.headRefName);
        const authorId = task?.ownerId ?? (fromBranch && team.has(fromBranch) ? fromBranch : "");
        return toPullRequest(gh, wf.review.tool, wf.review.enabled, task?.id ?? taskId ?? "", authorId);
      });
      // PRs we showed as open that are now neither open nor recently merged were closed. A full page of
      // open PRs may have left older ones out, so then only the recently-closed list proves it.
      const seen = new Set(next.map((p) => p.number));
      const complete = open.length < OPEN_LIMIT;
      const recentlyClosed = new Set(closed);
      for (const old of this.prev.values())
        if (!seen.has(old.number) && !old.merged && !old.closed) next.push(complete || recentlyClosed.has(old.number) ? { ...old, closed: true } : old);

      for (const pr of next) {
        const old = this.prev.get(pr.number);
        if (pr.draft && !pr.merged && !pr.closed && pr.taskId) void this.markWip(pr.number);
        if (JSON.stringify(old) !== JSON.stringify(pr)) this.hub.emit({ type: "pr.updated", pr: { ...pr } });
        if (!this.first) this.react(old, pr);
        this.syncTask(pr);
      }
      this.hub.snap.pullRequests = next;
      this.prev = new Map(next.map((p) => [p.number, p]));
      this.first = false;
    } catch (err) {
      if (err instanceof RateLimited) {
        this.pausedUntil = err.resetAt.getTime() + 5000;
        const at = err.resetAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const msg = `GitHub API rate limit reached (shared with your agents' gh commands). PR sync paused until ${at}.`;
        if (msg !== this.lastError) {
          log.warn(msg);
          this.hub.activity("config", null, msg);
        }
        this.lastError = msg;
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== this.lastError) log.warn(`GitHub: ${msg}`);
      this.lastError = msg;
    } finally {
      this.busy = false;
    }
  }

  /** Keep the task board in line with its PR. */
  private syncTask(pr: PullRequest) {
    const task = pr.taskId ? this.planner.task(pr.taskId) : undefined;
    if (!task || pr.closed) return;
    // A draft is work in progress (an agent saving its work before a usage limit): the task stays in progress.
    if (pr.draft && !pr.merged) {
      if (task.prNumber !== pr.number) this.planner.updateTask(task.id, { prNumber: pr.number });
      return;
    }
    if (pr.merged && task.status !== "done") this.planner.updateTask(task.id, { status: "done", prNumber: pr.number });
    else if (!pr.merged && (task.status === "todo" || task.status === "in-progress")) this.planner.updateTask(task.id, { status: "in-review", prNumber: pr.number });
    else if (!pr.merged && task.prNumber !== pr.number) this.planner.updateTask(task.id, { prNumber: pr.number });
  }

  /** Agents are asked to label their draft PRs WIP; this makes sure of it (the host's gh can create the label). */
  private async markWip(number: number) {
    if (!this.repo || this.wip.has(number)) return;
    this.wip.add(number);
    if (!this.wipLabelReady) {
      await run("gh", ["label", "create", "WIP", "--repo", this.repo, "--color", "FBCA04", "--description", "Work in progress", "--force"], { timeoutMs: 20_000 });
      this.wipLabelReady = true;
    }
    const r = await run("gh", ["pr", "edit", String(number), "--repo", this.repo, "--add-label", "WIP"], { timeoutMs: 20_000 });
    if (!r.ok) {
      this.wip.delete(number);
      log.warn(`could not add the WIP label to #${number}: ${r.stderr.trim().split("\n")[0]}`);
    }
  }

  private async clearWip(number: number) {
    if (!this.repo) return;
    this.wip.delete(number);
    await run("gh", ["pr", "edit", String(number), "--repo", this.repo, "--remove-label", "WIP"], { timeoutMs: 20_000 });
  }

  private react(old: PullRequest | undefined, pr: PullRequest) {
    const hub = this.hub;
    const who = pr.authorId || null;
    const tool = label[hub.snap.config.workflow.review.tool];
    const lead = hub.snap.config.team.find((a) => a.isLead);
    const ref = `#${pr.number} ${pr.title}`;

    if (!old && !pr.merged && !pr.closed) hub.activity("pr.opened", who, `${hub.name(who)} ${pr.draft ? "saved work in draft PR" : "opened PR"} ${ref}`);
    // A draft became ready for review: it is no longer work in progress.
    if (old?.draft && !pr.draft && !pr.merged && !pr.closed) void this.clearWip(pr.number);
    if (pr.closed && !old?.closed) return hub.activity("config", who, `PR #${pr.number} was closed without merging`);

    if (pr.merged && !old?.merged) {
      hub.activity("pr.merged", null, `PR ${ref} was merged`);
      if (lead) this.planner.notify(lead.id, `PR #${pr.number} (${pr.title}) was merged${pr.taskId ? `; ${pr.taskId} is done` : ""}. Assign the next task if anything is waiting.`);
      return;
    }
    if (pr.merged) return;

    if (pr.review === "reviewing" && old?.review !== "reviewing") hub.activity("review.started", null, `${tool} is reviewing #${pr.number}`);

    const newComments = pr.review === "changes-requested" && (old?.review !== "changes-requested" || pr.openComments > (old?.openComments ?? 0));
    if (newComments) {
      const n = pr.openComments;
      hub.activity("review.changes", who, `${tool} left ${n || "new"} comment${n === 1 ? "" : "s"} on #${pr.number}`);
      if (who)
        this.planner.notify(
          who,
          `${tool} reviewed your PR #${pr.number} (${pr.title}) and left ${n || "new"} open comment${n === 1 ? "" : "s"}. ` +
            `Read them with \`gh pr view ${pr.number} --comments\` (or the GitHub API), fix them on the same branch, push, and resolve each thread you fixed.`,
        );
    }

    if (pr.review === "passed" && old?.review !== "passed") {
      hub.activity("review.passed", who, `${tool} approved #${pr.number}`);
      if (lead) this.planner.notify(lead.id, passedNotice(pr, hub.name(who), hub.snap.config.workflow.merge.by));
    }

    if (pr.conflict && !old?.conflict && who)
      this.planner.notify(who, `Your PR #${pr.number} has merge conflicts with main. Pull main, rebase or merge it into your branch, fix the conflicts, and push.`);
  }
}
