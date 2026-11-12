// Cross-review: a model other than the author's reviews each pull request.
//
// With the review tool set to "agent", HQ asks an agent marked as a reviewer to review every PR that is ready
// (not a draft). The reviewer must use a different model family than the PR's author, because a model that
// reviews its own kind of work shares its blind spots. HQ never falls back to a same-model reviewer: with none
// to pick, the PR waits and the user is told.
//
// Every agent acts through the same GitHub account, and GitHub does not let an account approve or request
// changes on its own PR. So the reviewer posts its findings as a plain review comment and gives its verdict to
// HQ with the `submit_review` tool. HQ keeps the verdict (reviews.json) next to the commit it was asked about:
//   - approve  → the PR passes review (the lead is told, the user merges as usual);
//   - changes  → the author is sent the findings; when it pushes, HQ asks for a new review of the new commit;
//   - after MAX_ROUNDS "changes" the loop stops and the user decides (the two models disagree).

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "../src/data/types";
import { PROVIDER_INFO } from "../src/data/providers";
import type { Hub } from "./hub";
import { log } from "./lib/log";
import { projectHome } from "./paths";
import type { Planner } from "./planner";

/** Requests for changes before HQ stops asking and leaves it to the user. */
export const MAX_ROUNDS = 3;

export type Verdict = "approve" | "changes";

/** What the review looks like for one PR at its current commit. */
export interface AgentReview {
  state: "waiting" | "reviewing" | "approved" | "changes" | "stuck";
  reviewer: string | null;
  /** The reviewer's findings (approved or changes). */
  summary: string;
  issues: number;
  note: string | null;
}

interface Entry {
  /** The reviewer asked; null while there is none to ask. */
  reviewerId: string | null;
  /** The PR commit the review was asked for. A new commit means a new request. */
  sha: string;
  verdict: Verdict | null;
  summary: string;
  issues: number;
  /** "changes" verdicts so far, over all commits of this PR. */
  rounds: number;
  /** The user was told there is nobody to review it / the loop stopped. */
  told: boolean;
  title: string;
  authorId: string;
}

/** The family a model belongs to, for "a different model": the provider, or whoever made it behind a router. */
export function modelFamily(a: Pick<AgentConfig, "provider" | "model">): string {
  const provider = String(a.provider);
  // OpenRouter and Ollama host other people's models; their name says whose ("anthropic/claude-…", "qwen3:8b").
  if (provider !== "openrouter" && provider !== "ollama") return provider;
  const model = a.model.trim().toLowerCase();
  return model.split(/[/:]/)[0] || provider;
}

export const familyLabel = (a: Pick<AgentConfig, "provider" | "model">): string => {
  const f = modelFamily(a);
  return (PROVIDER_INFO as Record<string, { label: string } | undefined>)[f]?.label ?? f;
};

export interface Candidate {
  agent: AgentConfig;
  /** Running, with credit and under its usage limit. */
  available: boolean;
  /** Reviews it has been asked for and not yet answered. */
  open: number;
}

/** Who reviews a PR by `author`: a reviewer of another model family; the one that reviewed it before, then the least busy. */
export function chooseReviewer(
  candidates: Candidate[],
  author: Pick<AgentConfig, "id" | "name" | "provider" | "model"> | null,
  previous: string | null = null,
): { reviewer: AgentConfig | null; why: string | null } {
  const reviewers = candidates.filter((c) => c.agent.reviewer && !c.agent.isLead && c.agent.id !== author?.id);
  if (!reviewers.length) return { reviewer: null, why: "No agent is set to review PRs. Turn on “Reviews PRs” for an agent in Settings → Team (or add one with the role Reviewer)." };
  const other = author ? reviewers.filter((c) => modelFamily(c.agent) !== modelFamily(author)) : reviewers;
  if (!other.length)
    return { reviewer: null, why: `Every reviewer uses the same model family as ${author?.name}: ${author ? familyLabel(author) : ""}. Add a reviewer on a different model, or review it yourself.` };
  const rank = (c: Candidate) => [c.available ? 0 : 1, c.agent.id === previous ? 0 : 1, c.open];
  const sorted = [...other].sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return 0;
  });
  return { reviewer: sorted[0].agent, why: null };
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export interface CrossReviewDeps {
  /** Something only the user can resolve (nobody can review; the models disagree). */
  notice(title: string, details: string): void;
}

export class CrossReview {
  private entries = new Map<number, Entry>();
  /** Set by main: look at GitHub again soon (a verdict just arrived). */
  onChange: () => void = () => {};

  constructor(private hub: Hub, private planner: Pick<Planner, "notify">, private deps: CrossReviewDeps, private file = join(projectHome(hub.slug), "reviews.json")) {
    try {
      const saved = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, Entry>) : {};
      for (const [n, e] of Object.entries(saved)) if (Number.isInteger(Number(n)) && e && typeof e.sha === "string") this.entries.set(Number(n), { ...e, summary: e.summary ?? "", issues: e.issues ?? 0, rounds: e.rounds ?? 0, told: !!e.told, title: e.title ?? "", authorId: e.authorId ?? "" });
    } catch (err) {
      log.warn("reviews.json is unreadable; ignoring it:", err);
    }
  }

  private save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.entries), null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      log.warn("could not save reviews.json:", err);
    }
  }

  private available(id: string): boolean {
    const st = this.hub.status(id);
    return st?.session.state === "running" && !st.outOfCredit && !(st.limitedUntil && Date.parse(st.limitedUntil) > Date.now());
  }

  private candidates(): Candidate[] {
    const open = (id: string) => [...this.entries.values()].filter((e) => e.reviewerId === id && !e.verdict).length;
    return this.hub.snap.config.team.map((agent) => ({ agent, available: this.available(agent.id), open: open(agent.id) }));
  }

  /** The agent is still one that may review this PR. */
  private stillFits(reviewerId: string, authorId: string): boolean {
    const r = this.hub.cfg(reviewerId);
    const author = this.hub.cfg(authorId);
    return !!r?.reviewer && !r.isLead && r.id !== authorId && (!author || modelFamily(r) !== modelFamily(author));
  }

  private view(e: Entry, note: string | null = null): AgentReview {
    const reviewer = e.reviewerId ? this.hub.name(e.reviewerId) : null;
    const base = { reviewer, summary: e.summary, issues: e.issues };
    if (e.verdict === "approve") return { ...base, state: "approved", note: null };
    if (e.verdict === "changes" && e.rounds >= MAX_ROUNDS) return { ...base, state: "stuck", note: `Changes were requested ${MAX_ROUNDS} times: it needs you` };
    if (e.verdict === "changes") return { ...base, state: "changes", note };
    const away = e.reviewerId && !this.available(e.reviewerId) ? " (not available right now)" : "";
    return { ...base, state: reviewer ? "reviewing" : "waiting", note: note ?? (reviewer ? `Waiting for ${reviewer}${away}` : "Waiting for a reviewer") };
  }

  /** Called for each open, non-draft PR on every poll: asks for a review when one is needed and says how it stands. */
  sync(pr: { number: number; title: string; sha: string; authorId: string }): AgentReview {
    const e = this.entries.get(pr.number);
    // Already asked for this commit (or answered).
    if (e && e.sha === pr.sha && e.reviewerId && (e.verdict || this.stillFits(e.reviewerId, pr.authorId))) return this.view(e);
    // The models disagreed MAX_ROUNDS times: stop asking; it is the user's call.
    if (e && e.verdict === "changes" && e.rounds >= MAX_ROUNDS) return this.view(e);

    const author = this.hub.cfg(pr.authorId) ?? null;
    const { reviewer, why } = chooseReviewer(this.candidates(), author, e?.reviewerId ?? null);
    if (!reviewer) {
      const next: Entry = { reviewerId: null, sha: pr.sha, verdict: null, summary: "", issues: 0, rounds: e?.rounds ?? 0, told: e?.told ?? false, title: pr.title, authorId: pr.authorId };
      if (!next.told) {
        next.told = true;
        this.hub.activity("config", null, `PR #${pr.number} has no reviewer: ${why}`);
        this.deps.notice(`PR #${pr.number} has no reviewer`, `${why}\nUntil then it stays "waiting for a reviewer".`);
      }
      this.entries.set(pr.number, next);
      this.save();
      return this.view(next, why);
    }

    const again = !!e?.rounds;
    const next: Entry = { reviewerId: reviewer.id, sha: pr.sha, verdict: null, summary: "", issues: 0, rounds: e?.rounds ?? 0, told: false, title: pr.title, authorId: pr.authorId };
    this.entries.set(pr.number, next);
    this.save();
    this.planner.notify(reviewer.id, this.request(pr, again));
    return this.view(next);
  }

  private request(pr: { number: number; title: string; authorId: string }, again: boolean): string {
    const n = pr.number;
    const author = pr.authorId ? this.hub.name(pr.authorId) : "someone";
    return (
      `Review PR #${n} (${pr.title}) by ${author}. ` +
      (again ? "You reviewed it before and it has new commits: check that your earlier points were fixed and look at what changed. " : "") +
      `Read it with \`gh pr view ${n}\` and \`gh pr diff ${n}\`, run the project's tests on it if it has any (\`gh pr checkout ${n}\`), and compare it with its task (list_tasks: the files it may edit and its done-when). ` +
      `Post your findings with \`gh pr review ${n} --comment --body "…"\`. This GitHub account cannot approve or request changes on its own PRs, so never use --approve or --request-changes. ` +
      `Then call submit_review with prNumber ${n}, verdict "approve" or "changes", and a summary of what you found.`
    );
  }

  /** The loop ends: the lead and the user are told once. */
  private stop(n: number, e: Entry) {
    e.told = true;
    const lead = this.hub.snap.config.team.find((a) => a.isLead);
    const who = e.reviewerId ? this.hub.name(e.reviewerId) : "The reviewer";
    const text = `${who} has asked for changes on PR #${n} ${MAX_ROUNDS} times. HQ will not ask for another review: the user decides.`;
    this.hub.activity("agent.needs-input", null, text);
    if (lead) this.planner.notify(lead.id, `${text} Do not merge it; tell the user in your reply.`);
    this.deps.notice(`PR #${n}: the reviewer and the author disagree`, `${text}\nRead the review comments on the PR, then decide: ask the author for another change, or merge it yourself.`);
  }

  /** The reviewer's answer (Team MCP `submit_review`). */
  submit(reviewerId: string, prNumber: number, verdict: Verdict, summary: string, issues = 0): string {
    const e = this.entries.get(prNumber);
    if (!e || e.reviewerId !== reviewerId) throw new Error(`HQ did not ask you to review PR #${prNumber}. Only answer a review HQ asked for.`);
    const clean = summary.trim();
    if (!clean) throw new Error("Add a summary of what you found, so the author knows what to do.");
    // A reviewer that changes its mind about the same commit does not count twice.
    e.rounds += (verdict === "changes" ? 1 : 0) - (e.verdict === "changes" ? 1 : 0);
    e.verdict = verdict;
    e.summary = clip(clean, 3000);
    e.issues = Math.max(0, Math.floor(issues));
    e.told = false;
    if (verdict === "changes" && e.rounds >= MAX_ROUNDS) this.stop(prNumber, e);
    this.save();
    this.onChange();
    return verdict === "approve"
      ? `Recorded: PR #${prNumber} approved. HQ tells the lead. Stop now.`
      : `Recorded: changes requested on PR #${prNumber}. HQ sends your findings to the author and asks you again when they push. Stop now.`;
  }

  reviewerName(prNumber: number): string | null {
    const id = this.entries.get(prNumber)?.reviewerId;
    return id ? this.hub.name(id) : null;
  }

  /** The reviewer's findings as one line, for the message to the author. */
  findings(prNumber: number): string {
    return clip(oneLine(this.entries.get(prNumber)?.summary ?? ""), 1200);
  }

  /** Forget PRs that are no longer open. */
  prune(open: Set<number>) {
    let changed = false;
    for (const n of this.entries.keys())
      if (!open.has(n)) {
        this.entries.delete(n);
        changed = true;
      }
    if (changed) this.save();
  }
}
