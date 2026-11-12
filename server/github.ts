// Read-only GitHub: one GraphQL query (via the user's `gh` login) and pure
// functions that turn the response into PullRequests with a review state.

import type { PullRequest, ReviewState, ReviewTool } from "../src/data/types";
import type { AgentReview } from "./crossReview";
import { run } from "./lib/exec";

// ---------------------------------------------------------------- query

// GitHub charges GraphQL by how many nested items a query *could* return, from a
// 5,000-point hourly budget shared with the agents' own `gh` commands. Keep the
// nested lists small, and fetch only the basics for merged PRs.
const BASE_FIELDS = "number title url headRefName createdAt mergedAt state mergeable isDraft reviewDecision";
const REVIEW_FIELDS = `
  reviews(last: 10) { nodes { author { login } state submittedAt } }
  reviewThreads(first: 30) { nodes { isResolved isOutdated comments(first: 1) { nodes { author { login } } } } }
  commits(last: 1) { nodes { commit { oid statusCheckRollup { contexts(first: 25) { nodes {
    __typename
    ... on CheckRun { name status conclusion }
    ... on StatusContext { context state description }
  } } } } } }`;

/** Open PRs fetched per poll. A full page may not be the whole list. */
export const OPEN_LIMIT = 20;

const QUERY = `query($owner: String!, $name: String!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    open: pullRequests(states: OPEN, first: ${OPEN_LIMIT}, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${BASE_FIELDS} ${REVIEW_FIELDS} } }
    merged: pullRequests(states: MERGED, first: 10, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${BASE_FIELDS} } }
    closed: pullRequests(states: CLOSED, first: 10, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number } }
  }
}`;

export interface RateLimit {
  cost: number;
  remaining: number;
  resetAt: string;
}

/** Thrown when GitHub's API budget is used up; `resetAt` is when it refills. */
export class RateLimited extends Error {
  constructor(readonly resetAt: Date) {
    super("GitHub API rate limit reached");
  }
}

/** When the GraphQL budget refills (falls back to 15 minutes from now). */
async function graphqlResetAt(): Promise<Date> {
  const r = await run("gh", ["api", "rate_limit"], { timeoutMs: 15_000 });
  try {
    const reset = (JSON.parse(r.stdout) as { resources?: { graphql?: { reset?: number } } }).resources?.graphql?.reset;
    if (reset) return new Date(reset * 1000);
  } catch {
    /* fall through */
  }
  return new Date(Date.now() + 15 * 60_000);
}

export interface GhPr {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  createdAt: string;
  mergedAt: string | null;
  state: "OPEN" | "MERGED" | "CLOSED";
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  isDraft: boolean;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  reviews: { nodes: { author: { login: string } | null; state: string; submittedAt: string }[] };
  reviewThreads: { nodes: { isResolved: boolean; isOutdated: boolean; comments: { nodes: { author: { login: string } | null }[] } }[] };
  commits: { nodes: { commit: { oid?: string; statusCheckRollup: { contexts: { nodes: Ctx[] } } | null } }[] };
}

type Ctx =
  | { __typename: "CheckRun"; name: string; status: string; conclusion: string | null }
  | { __typename: "StatusContext"; context: string; state: string; description: string | null };

/** GitHub's short "secondary" limits clear within minutes; the hourly budget resets at its own time. */
async function rateLimited(message: string): Promise<RateLimited> {
  if (/secondary rate limit/i.test(message)) return new RateLimited(new Date(Date.now() + 2 * 60_000));
  return new RateLimited(await graphqlResetAt());
}

const EMPTY_REVIEW = { reviews: { nodes: [] }, reviewThreads: { nodes: [] }, commits: { nodes: [] } };

export async function fetchPrs(repo: string): Promise<{ open: GhPr[]; merged: GhPr[]; closed: number[]; rate: RateLimit | null }> {
  const [owner, name] = repo.split("/");
  const r = await run("gh", ["api", "graphql", "-f", `query=${QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`], { timeoutMs: 30_000 });
  if (!r.ok) {
    const msg = r.stderr.trim().split("\n")[0] || "gh api failed";
    if (/rate limit/i.test(r.stderr + r.stdout)) throw await rateLimited(r.stderr + r.stdout);
    throw new Error(msg);
  }
  const data = JSON.parse(r.stdout) as {
    data?: { rateLimit?: RateLimit; repository?: { open: { nodes: GhPr[] }; merged: { nodes: Omit<GhPr, keyof typeof EMPTY_REVIEW>[] }; closed?: { nodes: { number: number }[] } } };
    errors?: { message: string; type?: string }[];
  };
  const limited = data.errors?.find((e) => e.type === "RATE_LIMITED" || /rate limit/i.test(e.message));
  if (limited) throw await rateLimited(limited.message);
  if (!data.data?.repository) throw new Error(data.errors?.[0]?.message ?? "Repository not found");
  return {
    open: data.data.repository.open.nodes,
    merged: data.data.repository.merged.nodes.map((pr) => ({ ...pr, ...EMPTY_REVIEW })),
    closed: (data.data.repository.closed?.nodes ?? []).map((n) => n.number),
    rate: data.data.rateLimit ?? null,
  };
}

// ---------------------------------------------------------------- review state

/** Each review tool's bot logins and status/check name. */
const BOTS: Record<Exclude<ReviewTool, "human" | "custom" | "agent">, { logins: string[]; check: RegExp; label: string }> = {
  coderabbit: { logins: ["coderabbitai", "coderabbitai[bot]"], check: /coderabbit/i, label: "CodeRabbit" },
  greptile: { logins: ["greptile-apps", "greptile-apps[bot]"], check: /greptile/i, label: "Greptile" },
  copilot: { logins: ["copilot-pull-request-reviewer", "copilot-pull-request-reviewer[bot]", "Copilot"], check: /copilot/i, label: "Copilot" },
};

export interface ReviewResult {
  review: ReviewState;
  openComments: number;
  note: string | null;
}

const contexts = (pr: GhPr): Ctx[] => pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
const openThreads = (pr: GhPr, logins?: string[]) =>
  pr.reviewThreads.nodes.filter((t) => !t.isResolved && !t.isOutdated && (!logins || logins.includes(t.comments.nodes[0]?.author?.login ?? ""))).length;

export function reviewOf(pr: GhPr, tool: ReviewTool, agent?: AgentReview): ReviewResult {
  if (tool === "agent") {
    // A reviewing agent of another model (crossReview.ts): its verdict lives in HQ, not on GitHub.
    if (!agent) return { review: "pending", openComments: 0, note: "Waiting for a reviewer" };
    if (agent.state === "approved") return { review: "passed", openComments: 0, note: null };
    if (agent.state === "changes" || agent.state === "stuck") return { review: "changes-requested", openComments: agent.issues, note: agent.note };
    return { review: agent.state === "reviewing" ? "reviewing" : "pending", openComments: 0, note: agent.note };
  }
  if (tool === "custom") return { review: "pending", openComments: openThreads(pr), note: "Custom review checks aren't run by HQ yet" };

  if (tool === "human") {
    const decided =
      pr.reviewDecision ??
      [...pr.reviews.nodes].reverse().find((r) => r.state === "APPROVED" || r.state === "CHANGES_REQUESTED")?.state ??
      null;
    const open = openThreads(pr);
    if (decided === "APPROVED") return { review: "passed", openComments: open, note: null };
    if (decided === "CHANGES_REQUESTED") return { review: "changes-requested", openComments: open, note: null };
    return { review: "pending", openComments: open, note: "Waiting for a reviewer" };
  }

  const bot = BOTS[tool];
  const open = openThreads(pr, bot.logins);
  const ctx = contexts(pr).find((c) => bot.check.test(c.__typename === "CheckRun" ? c.name : c.context));
  const pending = ctx && (ctx.__typename === "CheckRun" ? ctx.status !== "COMPLETED" : ctx.state === "PENDING" || ctx.state === "EXPECTED");
  if (pending) return { review: "reviewing", openComments: open, note: null };
  if (open > 0) return { review: "changes-requested", openComments: open, note: null };

  const desc = ctx?.__typename === "StatusContext" ? (ctx.description ?? "") : "";
  if (/rate.?limit|skip|paused|disabled/i.test(desc)) return { review: "pending", openComments: 0, note: `${bot.label}: ${desc.toLowerCase()}` };
  const ok = ctx && (ctx.__typename === "CheckRun" ? ctx.conclusion === "SUCCESS" || ctx.conclusion === "NEUTRAL" : ctx.state === "SUCCESS");
  if (ok) return { review: "passed", openComments: 0, note: null };
  if (ctx) return { review: "changes-requested", openComments: 0, note: `${bot.label} check failed` };
  // No status yet: passed if the bot has already reviewed with nothing open, else still waiting.
  const botReviewed = pr.reviews.nodes.some((r) => bot.logins.includes(r.author?.login ?? ""));
  return botReviewed ? { review: "passed", openComments: 0, note: null } : { review: "pending", openComments: 0, note: `Waiting for ${bot.label}` };
}

// ---------------------------------------------------------------- matching

const TASK_ID = /([A-Z][A-Z0-9]*-T\d+)/i;

/** `[P3-T02] Chat route` → P3-T02; otherwise a task id inside the branch name. */
export function taskIdOf(pr: Pick<GhPr, "title" | "headRefName">): string | null {
  const inTitle = pr.title.match(/\[([A-Z][A-Z0-9]*-T\d+)\]/i);
  if (inTitle) return inTitle[1].toUpperCase();
  const inBranch = pr.headRefName.match(TASK_ID);
  return inBranch ? inBranch[1].toUpperCase() : null;
}

/** `alice/UI-T11-redesign` → alice */
export function branchAgent(branch: string): string | null {
  const m = branch.match(/^([a-z0-9][a-z0-9-]*)\//i);
  return m ? m[1].toLowerCase() : null;
}

export function toPullRequest(pr: GhPr, tool: ReviewTool, reviewEnabled: boolean, taskId: string, authorId: string, agent?: AgentReview): PullRequest {
  const merged = pr.state === "MERGED";
  // A draft is work in progress (an agent saving its work before a usage limit): not reviewed, never "passed".
  const r = pr.isDraft ? { review: "pending" as ReviewState, openComments: 0, note: "Draft: work in progress" } : reviewEnabled ? reviewOf(pr, tool, agent) : { review: "passed" as ReviewState, openComments: 0, note: null };
  return {
    number: pr.number,
    title: pr.title,
    taskId,
    authorId,
    review: merged && r.review !== "changes-requested" ? "passed" : r.review,
    openComments: r.openComments,
    mergeable: pr.mergeable === "MERGEABLE",
    merged,
    openedAt: pr.createdAt,
    url: pr.url,
    branch: pr.headRefName,
    closed: pr.state === "CLOSED",
    conflict: pr.mergeable === "CONFLICTING",
    reviewNote: r.note,
    draft: pr.isDraft,
  };
}
