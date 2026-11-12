// Cross-review: an agent on a different model reviews each PR; HQ keeps its verdict next to the commit.
//
//   npx tsx scripts/cross-review-test.ts

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { roleMd } from "../server/agentFiles";
import { handleMcp } from "../server/mcp";
import { chooseReviewer, CrossReview, familyLabel, MAX_ROUNDS, modelFamily, type AgentReview } from "../server/crossReview";
import { reviewOf, toPullRequest, type GhPr } from "../server/github";
import { GitHubSync } from "../server/githubSync";
import { Planner } from "../server/planner";
import { newAgent } from "../server/store";
import type { AgentConfig, HqConfig } from "../src/data/types";

const agent = (id: string, role: string, patch: Partial<AgentConfig> = {}, lead = false): AgentConfig => ({ ...newAgent(id, id[0].toUpperCase() + id.slice(1), role, "#fff", lead), ...patch });

// ---- A model family is who made the model
assert.equal(modelFamily({ provider: "anthropic", model: "claude-opus-5-5" }), "anthropic");
assert.equal(modelFamily({ provider: "anthropic", model: "claude-sonnet-5-5" }), "anthropic", "Opus and Sonnet are the same family");
assert.equal(modelFamily({ provider: "deepseek", model: "" }), "deepseek");
assert.equal(modelFamily({ provider: "openrouter", model: "anthropic/claude-sonnet-4.5" }), "anthropic", "behind a router, the maker counts");
assert.equal(modelFamily({ provider: "openrouter", model: "" }), "openrouter");
assert.equal(modelFamily({ provider: "ollama", model: "qwen3:8b" }), "qwen3");
assert.equal(familyLabel({ provider: "openai", model: "" }), "OpenAI (GPT)");

// ---- Who reviews a PR
const michael = agent("michael", "Lead", {}, true);
const dwight = agent("dwight", "Developer", { cli: "opencode", auth: "apiKey", provider: "deepseek" });
const jim = agent("jim", "Developer"); // Claude
const pam = agent("pam", "Reviewer", { cli: "codex", provider: "openai" });
const kevin = agent("kevin", "Reviewer"); // Claude too
assert.equal(pam.reviewer, true, "a role called Reviewer makes a reviewer");
assert.equal(michael.reviewer, false);
assert.match(pam.roleMd, /reviewer.*never write app code/i);
const cand = (a: AgentConfig, available = true, open = 0) => ({ agent: a, available, open });
{
  const none = chooseReviewer([cand(michael), cand(dwight), cand(jim)], dwight);
  assert.equal(none.reviewer, null);
  assert.match(none.why ?? "", /Reviews PRs/);
  const same = chooseReviewer([cand(jim), cand(kevin)], jim);
  assert.equal(same.reviewer, null, "a reviewer of the author's own family doesn't count");
  assert.match(same.why ?? "", /same model family as Jim: Anthropic \(Claude\)\./);
  assert.equal(chooseReviewer([cand(michael), cand(jim), cand(kevin), cand(pam)], jim).reviewer?.id, "pam", "the other family");
  assert.equal(chooseReviewer([cand(kevin), cand(pam)], dwight).reviewer?.id, "kevin", "Claude reviews DeepSeek's PR (first of equals)");
  assert.equal(chooseReviewer([cand(kevin, false), cand(pam)], dwight).reviewer?.id, "pam", "one that is running first");
  assert.equal(chooseReviewer([cand(kevin, true, 3), cand(pam, true, 1)], dwight).reviewer?.id, "pam", "then the least busy");
  assert.equal(chooseReviewer([cand(kevin, true, 3), cand(pam, true, 1)], dwight, "kevin").reviewer?.id, "kevin", "the one that reviewed it before keeps it");
  assert.equal(chooseReviewer([cand(pam)], null).reviewer?.id, "pam", "an unknown author: any reviewer");
  assert.equal(chooseReviewer([cand({ ...pam, reviewer: true })], pam).reviewer, null, "never its own PR");
}

// ---- The whole flow with fakes
const dir = mkdtempSync(join(tmpdir(), "hq-cross-"));
const file = join(dir, "reviews.json");
const make = (team: AgentConfig[], f = file, opts: { now?: () => number; timeoutMs?: number } = {}) => {
  const statuses = new Map(team.map((a) => [a.id, { state: "idle", currentTaskId: null as string | null, outOfCredit: null as string | null, limitedUntil: null as string | null, session: { state: "running" } }]));
  const activity: string[] = [];
  const sent: [string, string][] = [];
  const notices: [string, string][] = [];
  const hub = {
    snap: { config: { team }, tasks: [], messages: [] as unknown[], agents: [] as unknown[] },
    cfg: (id: string) => team.find((a) => a.id === id),
    status: (id: string) => statuses.get(id),
    name: (id: string) => team.find((a) => a.id === id)?.name ?? id,
    activity: (_t: string, _id: string | null, text: string) => activity.push(text),
    emit: () => {},
    planChanged: () => {},
    setStatus: () => {},
  };
  const planner = { notify: (id: string, text: string) => sent.push([id, text]) };
  const cross = new CrossReview(hub as never, planner as never, { notice: (t, d) => notices.push([t, d]) }, f, opts);
  return { cross, hub, statuses, activity, sent, notices, team };
};
const pr = (n: number, sha: string, authorId = "dwight") => ({ number: n, title: `[T${n}] Thing`, sha, authorId });

{
  const t = make([michael, dwight, jim, kevin, pam]);
  let changes = 0;
  t.cross.onChange = () => changes++;

  // A ready PR by Dwight (DeepSeek): Pam or Kevin; Kevin is first among equals.
  let v = t.cross.sync(pr(5, "aaa"));
  assert.equal(v.state, "reviewing");
  assert.equal(t.sent.length, 1);
  const [to, text] = t.sent[0];
  assert.equal(to, "kevin");
  for (const must of ["Review PR #5", "by Dwight", "gh pr diff 5", "never use --approve or --request-changes", "submit_review", "prNumber 5"]) assert.ok(text.includes(must), `the request has "${must}"`);
  assert.ok(!/reviewed it before/.test(text));
  assert.equal(v.note, "Waiting for Kevin");

  // Asked once per commit.
  t.cross.sync(pr(5, "aaa"));
  assert.equal(t.sent.length, 1, "not asked again");

  // Only the one HQ asked may answer.
  assert.throws(() => t.cross.submit("pam", 5, "approve", "fine"), /did not ask you/);
  assert.throws(() => t.cross.submit("kevin", 99, "approve", "fine"), /did not ask you/);
  assert.throws(() => t.cross.submit("kevin", 5, "changes", "   "), /Add a summary/);

  // Changes requested: the PR shows it, and a new commit gets a new request to the same reviewer.
  assert.match(t.cross.submit("kevin", 5, "changes", "1. src/a.ts:10 divides by zero.\n2. No test for the empty list.", 2), /changes requested/);
  assert.equal(changes, 1, "GitHub is looked at again soon");
  v = t.cross.sync(pr(5, "aaa"));
  assert.equal(v.state, "changes");
  assert.equal(v.issues, 2);
  assert.equal(reviewOf(ghPr(5), "agent", v).review, "changes-requested");
  assert.equal(reviewOf(ghPr(5), "agent", v).openComments, 2);
  assert.equal(t.cross.findings(5), "1. src/a.ts:10 divides by zero. 2. No test for the empty list.", "one line for the author's terminal");
  assert.equal(t.cross.reviewerName(5), "Kevin");
  assert.equal(t.sent.length, 1);

  v = t.cross.sync(pr(5, "bbb")); // the author pushed
  assert.equal(v.state, "reviewing", "new commit: review again");
  assert.equal(t.sent.length, 2);
  assert.equal(t.sent[1][0], "kevin");
  assert.match(t.sent[1][1], /reviewed it before and it has new commits/);
  assert.equal(reviewOf(ghPr(5), "agent", v).review, "reviewing");

  // Approved: passes, and stays passed for that commit; a later commit asks again.
  t.cross.submit("kevin", 5, "approve", "Fixed both; the new test covers the empty list.");
  v = t.cross.sync(pr(5, "bbb"));
  assert.equal(v.state, "approved");
  assert.equal(reviewOf(ghPr(5), "agent", v).review, "passed");
  assert.equal(t.sent.length, 2);
  assert.equal(t.cross.sync(pr(5, "ccc")).state, "reviewing", "a commit after the approval is not covered by it");

  // Saved on disk, owner only, and back after a restart.
  assert.ok(existsSync(file));
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  const again = make([michael, dwight, jim, kevin, pam]);
  assert.equal(again.cross.sync(pr(5, "ccc")).state, "reviewing");
  assert.equal(again.sent.length, 0, "after a restart HQ does not ask a second time");
  assert.equal(again.cross.sync(pr(5, "ccc")).reviewer, "Kevin");

  // Closed PRs are forgotten.
  t.cross.prune(new Set([7]));
  assert.equal(make([michael, dwight, jim, kevin, pam]).cross.reviewerName(5), null);
}

{
  // Nobody can review: it waits, the user is told once (not once per poll).
  const t = make([michael, dwight, jim], join(dir, "none.json"));
  const v = t.cross.sync(pr(8, "aaa", "jim"));
  assert.equal(v.state, "waiting");
  assert.match(v.note ?? "", /Reviews PRs/);
  assert.equal(reviewOf(ghPr(8), "agent", v).review, "pending");
  t.cross.sync(pr(8, "aaa", "jim"));
  t.cross.sync(pr(8, "bbb", "jim"));
  assert.equal(t.notices.length, 1);
  assert.match(t.notices[0][0], /PR #8 has no reviewer/);
  assert.equal(t.sent.length, 0);
  // Only reviewers on the author's own model: also nobody.
  const same = make([michael, jim, kevin], join(dir, "same.json"));
  assert.match(same.cross.sync(pr(9, "aaa", "jim")).note ?? "", /same model family/);
  // A reviewer on another model is added: the next poll asks it.
  const grown = make([michael, jim, kevin, pam], join(dir, "same.json"));
  assert.equal(grown.cross.sync(pr(9, "aaa", "jim")).state, "reviewing");
  assert.equal(grown.sent[0][0], "pam");
}

{
  // The reviewer is gone (or switched off) before it answered: HQ asks another.
  const f = join(dir, "gone.json");
  const t = make([michael, dwight, kevin, pam], f);
  assert.equal(t.cross.sync(pr(10, "aaa")).reviewer, "Kevin");
  const left = make([michael, dwight, pam], f);
  const v = left.cross.sync(pr(10, "aaa"));
  assert.equal(v.reviewer, "Pam");
  assert.equal(left.sent[0][0], "pam");
  // One that is out of credit or at a usage limit is a worse pick than one that is running.
  const busy = make([michael, dwight, kevin, pam], join(dir, "busy.json"));
  busy.statuses.get("kevin")!.outOfCredit = "no credit";
  assert.equal(busy.cross.sync(pr(11, "aaa")).reviewer, "Pam");
  busy.statuses.get("pam")!.limitedUntil = new Date(Date.now() + 3_600_000).toISOString();
  assert.match(busy.cross.sync(pr(11, "aaa")).note ?? "", /Waiting for Pam \(at its usage limit\)/);
}

{
  // A reviewer that was asked runs out of credit (or hits a usage limit): the PR goes to another one, at once.
  const t = make([michael, dwight, kevin, pam], join(dir, "failover.json"));
  assert.equal(t.cross.sync(pr(40, "a")).reviewer, "Kevin");
  assert.equal(t.sent.length, 1);
  t.statuses.get("kevin")!.outOfCredit = "no credit";
  const v = t.cross.sync(pr(40, "a"));
  assert.equal(v.reviewer, "Pam");
  assert.equal(v.state, "reviewing");
  assert.deepEqual(t.sent.slice(1).map(([id]) => id), ["kevin", "pam"], "the old one is told to drop it, the new one is asked");
  assert.match(t.sent[1][1], /gave PR #40 to Pam/);
  assert.match(t.sent[2][1], /Review PR #40/);
  assert.ok(!/reviewed it before/.test(t.sent[2][1]), "a new reviewer has not seen it");
  assert.ok(t.activity.some((a) => /PR #40: Kevin is out of credit, so HQ asked Pam/.test(a)), t.activity.join("|"));
  // Kevin's late answer is refused; Pam's counts.
  assert.throws(() => t.cross.submit("kevin", 40, "approve", "fine"), /did not ask you/);
  // Not back and forth: with Pam down too, and Kevin back, the PR stays with Pam (Kevin was already replaced).
  t.statuses.get("kevin")!.outOfCredit = null;
  t.statuses.get("pam")!.limitedUntil = new Date(Date.now() + 3_600_000).toISOString();
  const stay = t.cross.sync(pr(40, "a"));
  assert.equal(stay.reviewer, "Pam");
  assert.equal(stay.note, "Waiting for Pam (at its usage limit)");
  assert.equal(t.sent.length, 3, "nothing more was sent");
  // After a restart it still knows who was tried.
  const again = make([michael, dwight, kevin, pam], join(dir, "failover.json"));
  again.statuses.get("pam")!.limitedUntil = new Date(Date.now() + 3_600_000).toISOString();
  assert.equal(again.cross.sync(pr(40, "a")).reviewer, "Pam");
  assert.equal(again.sent.length, 0);
  // A new commit starts over: Kevin is fine again and Pam is not.
  assert.equal(t.cross.sync(pr(40, "b")).reviewer, "Kevin");
}

{
  // A reviewer that does not answer: reminded at half the time, replaced at the full time; one that is working is left alone.
  let clock = 1_000_000;
  const MIN = 60_000;
  const t = make([michael, dwight, kevin, pam], join(dir, "slow.json"), { now: () => clock, timeoutMs: 30 * MIN });
  assert.equal(t.cross.sync(pr(41, "a")).reviewer, "Kevin");
  clock += 10 * MIN;
  t.cross.sync(pr(41, "a"));
  assert.equal(t.sent.length, 1, "too early for a reminder");
  clock += 6 * MIN; // 16 minutes
  t.cross.sync(pr(41, "a"));
  assert.equal(t.sent.length, 2);
  assert.deepEqual([t.sent[1][0], /still waiting for your review of PR #41/.test(t.sent[1][1])], ["kevin", true]);
  t.cross.sync(pr(41, "a"));
  assert.equal(t.sent.length, 2, "reminded once");
  t.statuses.get("kevin")!.state = "working"; // busy: a long review is not a late one
  clock += 20 * MIN; // 36 minutes
  assert.equal(t.cross.sync(pr(41, "a")).reviewer, "Kevin");
  assert.equal(t.sent.length, 2);
  t.statuses.get("kevin")!.state = "idle";
  const v = t.cross.sync(pr(41, "a"));
  assert.equal(v.reviewer, "Pam", "idle and silent: replaced");
  assert.deepEqual(t.sent.slice(2).map(([id]) => id), ["kevin", "pam"]);
  assert.ok(t.activity.some((a) => /Kevin has not answered in 36 minutes, so HQ asked Pam/.test(a)), t.activity.join("|"));
  clock += 31 * MIN;
  assert.equal(t.cross.sync(pr(41, "a")).reviewer, "Pam", "Kevin was already tried: nobody else");
  assert.equal(t.notices.length, 1, "the user hears that nobody else can take it");
  assert.match(t.notices[0][0], /PR #41 is waiting for Pam/);
  t.cross.sync(pr(41, "a"));
  assert.equal(t.notices.length, 1, "once");

  // One that is stopped counts as silent too, and the only reviewer left is told about to the user, not replaced by itself.
  const solo = make([michael, dwight, kevin], join(dir, "solo.json"), { now: () => clock, timeoutMs: 30 * MIN });
  solo.cross.sync(pr(42, "a"));
  solo.statuses.get("kevin")!.session.state = "stopped";
  clock += 31 * MIN;
  const late = solo.cross.sync(pr(42, "a"));
  assert.equal(late.reviewer, "Kevin");
  assert.match(late.note ?? "", /Waiting for Kevin \(not running\)/);
  assert.equal(solo.notices.length, 1);
  assert.match(solo.notices[0][1], /Start Kevin/);
  assert.equal(solo.sent.length, 1, "no second request to itself");
}

{
  // The models disagree: after MAX_ROUNDS requests for changes HQ stops asking and the user decides.
  const t = make([michael, dwight, pam], join(dir, "stuck.json"));
  for (let i = 1; i <= MAX_ROUNDS; i++) {
    assert.equal(t.cross.sync(pr(12, `sha${i}`)).state, "reviewing", `round ${i}`);
    t.cross.submit("pam", 12, "changes", `Round ${i}: still wrong.`, 1);
  }
  assert.equal(t.sent.filter(([id]) => id === "pam").length, MAX_ROUNDS, "a request per round");
  const stuck = t.cross.sync(pr(12, "sha1"));
  assert.equal(stuck.state, "stuck");
  assert.equal(reviewOf(ghPr(12), "agent", stuck).review, "changes-requested");
  assert.match(stuck.note ?? "", /3 times: it needs you/);
  assert.equal(t.sent.filter(([id]) => id === "michael").length, 1, "the lead is told once");
  assert.match(t.sent.at(-1)![1], /Do not merge it/);
  assert.equal(t.notices.length, 1, "and so is the user");
  assert.match(t.notices[0][0], /disagree/);
  assert.equal(t.cross.sync(pr(12, "sha9")).state, "stuck", "more commits don't start another round");
  assert.equal(t.sent.filter(([id]) => id === "pam").length, MAX_ROUNDS, "no fourth request");
  // A reviewer that changes its mind about the same commit does not use up a round.
  const u = make([michael, dwight, pam], join(dir, "mind.json"));
  u.cross.sync(pr(13, "a"));
  u.cross.submit("pam", 13, "changes", "x");
  u.cross.submit("pam", 13, "approve", "y");
  u.cross.submit("pam", 13, "changes", "z");
  assert.equal(u.cross.sync(pr(13, "b")).state, "reviewing");
}

// ---- How GitHub's data and the verdict make a PullRequest
function ghPr(number: number, draft = false): GhPr {
  return {
    number, title: `[T${number}] Thing`, url: "u", headRefName: `dwight/t${number}`, createdAt: "2026-11-11T00:00:00Z", mergedAt: null, state: "OPEN",
    mergeable: "MERGEABLE", isDraft: draft, reviewDecision: null, reviews: { nodes: [] }, reviewThreads: { nodes: [] }, commits: { nodes: [{ commit: { oid: "abc", statusCheckRollup: null } }] },
  };
}
{
  const approved: AgentReview = { state: "approved", reviewer: "Pam", summary: "ok", issues: 0, note: null };
  assert.equal(reviewOf(ghPr(1), "agent").review, "pending", "no verdict yet");
  assert.equal(reviewOf(ghPr(1), "agent").note, "Waiting for a reviewer");
  assert.equal(toPullRequest(ghPr(1), "agent", true, "T1", "dwight", approved).review, "passed");
  assert.equal(toPullRequest(ghPr(1, true), "agent", true, "T1", "dwight", approved).review, "pending", "a draft is never passed");
  assert.equal(toPullRequest(ghPr(1), "agent", false, "T1", "dwight").review, "passed", "review off");
}

// ---- What GitHub sync tells the author and the lead
{
  const t = make([michael, dwight, kevin, pam], join(dir, "react.json"));
  (t.hub.snap.config as unknown as { workflow: unknown }).workflow = { review: { enabled: true, tool: "agent", command: "" }, merge: { by: "human" } };
  t.cross.sync(pr(20, "a"));
  t.cross.submit("kevin", 20, "changes", "src/a.ts:10 divides by zero.\nNo test for the empty list.", 2);
  t.sent.length = 0;
  const sync = new GitHubSync(t.hub as never, { notify: (id: string, text: string) => t.sent.push([id, text]) } as never, "o/x", t.cross) as unknown as { react(old: unknown, pr: unknown): void };
  const base = { number: 20, title: "[T20] Thing", taskId: "T20", authorId: "dwight", mergeable: true, merged: false, openedAt: "", closed: false, conflict: false, draft: false };
  sync.react({ ...base, review: "reviewing", openComments: 0 }, { ...base, review: "changes-requested", openComments: 2 });
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0][0], "dwight", "the author is told");
  assert.match(t.sent[0][1], /Kevin reviewed your PR #20.*asked for changes: src\/a\.ts:10 divides by zero\. No test for the empty list\./);
  assert.match(t.sent[0][1], /HQ then asks Kevin to review the new commit/);
  assert.ok(!t.sent[0][1].includes("\n"), "one line");
  t.sent.length = 0;
  sync.react({ ...base, review: "reviewing", openComments: 0 }, { ...base, review: "passed", openComments: 0 });
  assert.equal(t.sent[0][0], "michael", "the lead hears it passed");
  assert.match(t.sent[0][1], /passed review.*Don't merge it yourself/);
  assert.ok(t.activity.includes("Kevin approved #20"), t.activity.join("|"));
}

// ---- Roles and the lead's rules
{
  const cfg = {
    project: { id: "x", name: "X", repo: "o/x", path: "/x", hqPort: 7430 },
    team: [michael, dwight, pam],
    workflow: { review: { enabled: true, tool: "agent", command: "" }, merge: { by: "human" }, budget: { dailyUsd: 0 }, deploy: { enabled: false, tool: "vercel", command: "", perAgentEnvironments: false } },
  } as unknown as HqConfig;
  const reviewer = roleMd(pam, cfg);
  for (const must of ["You review pull requests", "never use --approve or --request-changes", "submit_review", "do not approve to be agreeable", "Your tools: submit_review"]) assert.ok(reviewer.includes(must), `the reviewer's ROLE has "${must}"`);
  for (const mustNot of ["get_my_task, set_my_status", "Work only on the task you were given"]) assert.ok(!reviewer.includes(mustNot), `the reviewer's ROLE lacks "${mustNot}"`);
  assert.ok(reviewer.includes("Pam — Reviewer (reviews PRs) ← you"));
  const dev = roleMd(dwight, cfg);
  assert.ok(dev.includes("Work only on the task you were given") && !dev.includes("submit_review"));
  const lead = roleMd(michael, cfg);
  assert.match(lead, /Never assign them tasks/);
  assert.ok(!roleMd(michael, { ...cfg, workflow: { ...cfg.workflow, review: { enabled: true, tool: "human", command: "" } } } as HqConfig).includes("Never assign them tasks"));
}

// ---- Nobody hands a reviewer a task
{
  const team = [michael, dwight, pam];
  const hub = { snap: { config: { team }, tasks: [{ id: "T1", title: "x", boardId: "B", ownerId: null, status: "todo", needs: [] }], boards: [], messages: [] as unknown[], agents: [] as unknown[] }, cfg: (id: string) => team.find((a) => a.id === id), status: () => undefined, name: (id: string) => id, activity: () => {}, emit: () => {}, planChanged: () => {}, setStatus: () => {} };
  const planner = new Planner(hub as never, { push: () => {} } as never);
  assert.throws(() => planner.assign("T1", "pam", "michael"), /only reviews PRs and takes no tasks/);
  assert.throws(() => planner.assign("T1", "pam", "you"), /only reviews PRs/);
}

// ---- The Team MCP: reviewers get submit_review, nobody else does
{
  const t = make([michael, dwight, kevin, pam], join(dir, "mcp.json"));
  t.cross.sync(pr(30, "a"));
  const planner = new Planner(t.hub as never, { push: () => {} } as never);
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => void handleMcp(t.hub as never, planner, String(req.headers["x-hq-agent"]), req, res, JSON.parse(raw), t.cross));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const rpc = async (as: string, method: string, params: unknown) => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-hq-agent": as }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    return (await r.json()) as { result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean } };
  };
  const names = async (as: string) => ((await rpc(as, "tools/list", {})).result?.tools ?? []).map((x) => x.name);
  assert.ok((await names("kevin")).includes("submit_review"), "a reviewer has it");
  assert.ok(!(await names("dwight")).includes("submit_review"), "a developer does not");
  assert.ok(!(await names("michael")).includes("submit_review"), "nor the lead");
  const wrong = await rpc("pam", "tools/call", { name: "submit_review", arguments: { prNumber: 30, verdict: "approve", summary: "ok" } });
  assert.equal(wrong.result?.isError, true, "only the reviewer HQ asked");
  assert.match(wrong.result?.content?.[0].text ?? "", /did not ask you/);
  const done = await rpc("kevin", "tools/call", { name: "submit_review", arguments: { prNumber: 30, verdict: "approve", summary: "Checked the diff and ran the tests.", issues: 0 } });
  assert.ok(!done.result?.isError, JSON.stringify(done));
  assert.match(done.result?.content?.[0].text ?? "", /PR #30 approved/);
  assert.equal(t.cross.sync(pr(30, "a")).state, "approved");
  const workers = JSON.parse((await rpc("michael", "tools/call", { name: "list_workers", arguments: {} })).result?.content?.[0].text ?? "[]") as { id: string; reviewer: boolean; free: boolean }[];
  assert.deepEqual(workers.filter((w) => w.reviewer).map((w) => [w.id, w.free]), [["kevin", false], ["pam", false]], "reviewers are never free for a task");
  server.close();
}

console.log("✓ cross-review");
