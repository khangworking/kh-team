// Subscription usage limits: reading Claude Code's windows and Codex's screen, blocking the whole account,
// telling the lead, holding work, and nudging agents that did not continue after the reset.
//
//   npx tsx scripts/ratelimit-test.ts

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The state file goes in a scratch home, not the real ~/.jsmhq.
const home = mkdtempSync(join(tmpdir(), "hq-limits-"));
Object.assign(process.env, { HOME: home, USERPROFILE: home });

const { RateLimits, parseCodexLimit, readWindows } = await import("../server/rateLimits");
const { handleHook } = await import("../server/hooks");

// ---- The windows, in the shape each CLI reports them
{
  const claude = readWindows({ five_hour: { used_percentage: 23.5, resets_at: 1738425600 }, seven_day: { used_percentage: 41.2, resets_at: 1738857600 } });
  assert.equal(claude.fiveHour?.usedPct, 23.5);
  assert.equal(claude.sevenDay?.resetsAt, new Date(1738857600 * 1000).toISOString());
  // Codex's session file: primary is the 5-hour window (300 minutes), secondary the week (10080).
  const codex = readWindows({ primary: { used_percent: 91.5, window_minutes: 300, resets_at: 1794241692 }, secondary: { used_percent: 60, window_minutes: 10080, resets_at: 1794382923 } });
  assert.equal(codex.fiveHour?.usedPct, 91.5);
  assert.equal(codex.sevenDay?.usedPct, 60);
  // A plan with only a weekly window reports it as primary.
  assert.deepEqual(Object.keys(readWindows({ primary: { used_percent: 10, window_minutes: 10080, resets_at: 1794382923 } })), ["sevenDay"]);
  assert.deepEqual(readWindows({ primary: { used_percent: "x" } }), {});
}

// ---- Codex's message
{
  const now = Date.parse("2026-11-10T10:00:00");
  const rel = parseCodexLimit("■ You've hit your usage limit. Upgrade to Pro, or try again in 2 days 3 hours 5 minutes.", now);
  assert.equal(rel?.until?.getTime(), now + (2 * 86400 + 3 * 3600 + 5 * 60) * 1000);
  const hours = parseCodexLimit("You've hit your usage limit. Try again in 4 hours.", now);
  assert.equal(hours?.until?.getTime(), now + 4 * 3600_000);
  const later = parseCodexLimit("You've hit your usage limit. Try again at 3:45 PM.", now);
  assert.equal(later?.until?.getHours(), 15);
  assert.equal(later?.until?.getMinutes(), 45);
  const tomorrow = parseCodexLimit("You've hit your usage limit. Try again at 9:15 AM.", now);
  assert.ok(tomorrow!.until!.getTime() > now && tomorrow!.until!.getTime() - now > 20 * 3600_000, "a clock time already past means tomorrow");
  assert.equal(parseCodexLimit("You've hit your usage limit.", now)?.until, null);
  assert.equal(parseCodexLimit("Ask Codex to do anything", now), null);
}

type Agent = { id: string; isLead: boolean; auth: "subscription" | "apiKey"; provider: string };
const team: Agent[] = [
  { id: "lead", isLead: true, auth: "subscription", provider: "openai" }, // Codex lead
  { id: "a", isLead: false, auth: "subscription", provider: "anthropic" },
  { id: "a2", isLead: false, auth: "subscription", provider: "anthropic" },
  { id: "a3", isLead: false, auth: "subscription", provider: "anthropic" }, // no task
  { id: "x", isLead: false, auth: "subscription", provider: "openai" },
  { id: "key", isLead: false, auth: "apiKey", provider: "anthropic" },
];
type Status = { state: string; note: string | null; limitedUntil?: string | null; limitPhase?: string | null; session: { state: string } };
const make = (slug: string) => {
  const statuses = new Map<string, Status>(team.map((t) => [t.id, { state: "idle", note: null, session: { state: "running" } }]));
  const tasks = [
    { id: "T1", title: "Do it", ownerId: "a", status: "in-progress", prNumber: undefined as number | undefined, note: null as string | null },
    { id: "T2", title: "Other", ownerId: "a2", status: "in-progress", prNumber: undefined as number | undefined, note: null as string | null },
  ];
  const activity: string[] = [];
  const sent: [string, string][] = [];
  const hub = {
    slug,
    snap: { config: { team }, tasks, rateLimits: undefined as unknown },
    cfg: (id: string) => team.find((t) => t.id === id),
    status: (id: string) => statuses.get(id),
    setStatus: (id: string, p: Partial<Status>) => Object.assign(statuses.get(id)!, p),
    name: (id: string) => id,
    activity: (_t: string, _id: string | null, text: string) => activity.push(text),
    emit: () => {},
  };
  const limits = new RateLimits(hub as never, { notify: (id, text) => sent.push([id, text]) }, 50);
  return { hub, limits, statuses, activity, sent, tasks };
};
const inOneHour = Math.floor(Date.now() / 1000) + 3600;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- A window at 85% warns once; it blocks nobody.
{
  const t = make("warn");
  const w = { five_hour: { used_percentage: 85, resets_at: inOneHour } };
  t.limits.observe("a", w);
  t.limits.observe("a", w);
  assert.equal(t.activity.filter((a) => /85%/.test(a)).length, 1);
  assert.equal(t.limits.blockedUntil("a"), null);
  t.limits.observe("key", w); // an API-key agent has no subscription
  assert.equal(t.activity.length, 1);
  t.limits.stop();
}

// ---- A full window blocks the whole account (not the other one), and the lead is told.
{
  const t = make("block");
  t.limits.observe("a", { five_hour: { used_percentage: 100, resets_at: inOneHour }, seven_day: { used_percentage: 40, resets_at: inOneHour + 86400 } });
  for (const id of ["a", "a2"]) {
    assert.ok(t.statuses.get(id)!.limitedUntil, `${id} is limited`);
    assert.equal(Date.parse(t.statuses.get(id)!.limitedUntil!) / 1000, inOneHour);
  }
  assert.ok(!t.statuses.get("x")!.limitedUntil, "the Codex subscription is another account");
  assert.ok(!t.statuses.get("key")!.limitedUntil, "an API-key agent is not covered");
  assert.ok(!t.statuses.get("lead")!.limitedUntil);
  assert.deepEqual(t.sent.map((s) => s[0]), ["lead"]);
  assert.match(t.sent[0][1], /a, a2, a3 can't work until/);
  t.limits.observe("a2", { five_hour: { used_percentage: 100, resets_at: inOneHour } }); // repeated: no second notice
  t.limits.hit("a", null); // StopFailure for a limit already known
  assert.equal(t.sent.length, 1);
  assert.ok(t.limits.blockedUntil("a2"));
  t.limits.stop();
}

// ---- 90% used: agents save their work (commit, draft PR "Đang làm", WIP label, notes, lead told) and pause until the reset.
{
  const t = make("winddown");
  t.statuses.get("a2")!.state = "working"; // mid-turn
  const w = (pct: number) => ({ five_hour: { used_percentage: pct, resets_at: inOneHour } });
  t.limits.observe("a", w(92));
  // a and a2 hold tasks: asked to save, still able to receive messages. a3 has nothing to save: paused at once.
  for (const id of ["a", "a2"]) assert.equal(t.statuses.get(id)!.limitPhase, "winding-down", `${id} is saving its work`);
  assert.equal(t.statuses.get("a3")!.limitPhase, "paused");
  assert.ok(!t.statuses.get("x")!.limitedUntil, "the other subscription is not affected");
  const toA = t.sent.filter((s) => s[0] === "a").map((s) => s[1]);
  assert.equal(toA.length, 1);
  for (const must of ["92%", "[T1] WIP", "git push", "DRAFT", "Đang làm (WIP)", "--label WIP", "gh label create WIP", "set_my_status", "send_message", "in-review"]) assert.ok(toA[0].includes(must), `the wrap-up message has "${must}"`);
  assert.equal(t.sent.filter((s) => s[0] === "a3").length, 0, "no wrap-up for an agent without a task");
  assert.equal(t.sent.filter((s) => s[0] === "lead").length, 1, "the lead is told once");
  assert.match(t.sent.find((s) => s[0] === "lead")![1], /saving their work/);
  t.limits.observe("a2", w(93)); // repeated: nothing new
  assert.equal(t.sent.filter((s) => s[0] === "a").length, 1);
  assert.equal(t.sent.filter((s) => s[0] === "lead").length, 1);

  // The wrap-up is done when the agent's turn ends with nothing queued (a queued message continues the turn).
  const inbox = { noteHook: () => {}, takeForStop: () => null, pending: () => 0 };
  t.limits.turnEnded("a", 1);
  assert.equal(t.statuses.get("a")!.limitPhase, "winding-down");
  handleHook(t.hub as never, inbox as never, "a", "Stop", {}, undefined, t.limits);
  assert.equal(t.statuses.get("a")!.limitPhase, "paused");
  assert.match(t.statuses.get("a")!.note!, /Work saved/);
  assert.ok(t.sent.some((s) => s[0] === "lead" && /saved its work and is paused/.test(s[1])));
  assert.equal(t.statuses.get("a2")!.limitPhase, "winding-down", "a2 is still saving");

  // After the reset: everyone is released, and an idle agent with a task is told to continue with its notes and draft PR.
  t.tasks[0].prNumber = 12;
  t.tasks[0].note = "Done: schema. Next: routes.";
  t.statuses.get("a2")!.state = "idle";
  t.sent.length = 0;
  t.limits.tick(Date.now() + 3601 * 1000);
  for (const id of ["a", "a2", "a3"]) assert.ok(!t.statuses.get(id)!.limitedUntil && !t.statuses.get(id)!.limitPhase, `${id} is released`);
  await sleep(120);
  const resume = t.sent.find((s) => s[0] === "a" && /Continue T1/.test(s[1]))?.[1] ?? "";
  for (const must of ["Done: schema. Next: routes.", "draft PR is #12", "gh pr ready 12", "--remove-label WIP", "in-review"]) assert.ok(resume.includes(must), `the resume message has "${must}"`);
  assert.ok(t.sent.some((s) => s[0] === "a2" && /Continue T2/.test(s[1])));
  assert.equal(t.sent.filter((s) => s[0] === "a3").length, 0, "a3 had no task");
  t.limits.stop();
}

// ---- Codex agents wind down the same way, from the windows Codex's session file reports (posted by a Stop hook).
{
  const t = make("codexdown");
  const w = (pct: number) => ({ primary: { used_percent: pct, window_minutes: 300, resets_at: inOneHour }, secondary: { used_percent: 20, window_minutes: 10080, resets_at: inOneHour + 604800 } });
  t.limits.observe("x", w(88));
  assert.ok(!t.statuses.get("x")!.limitedUntil, "88% is a warning only");
  t.limits.observe("x", w(92));
  assert.equal(t.statuses.get("x")!.limitPhase, "paused", "x holds no task here, so it pauses at once");
  assert.ok(!t.statuses.get("a")!.limitedUntil, "the Claude subscription is another account");
  t.limits.observe("x", w(100));
  assert.equal(t.statuses.get("x")!.limitPhase, "blocked");
  t.limits.stop();
  // The hook route: a usage report is not agent activity.
  const t2 = make("codexhook");
  const noActivity = { noteHook: () => assert.fail("a usage report is not agent activity") };
  assert.deepEqual(handleHook(t2.hub as never, noActivity as never, "x", "Usage", { rate_limits: w(93) }, undefined, t2.limits), { ok: true });
  assert.equal(t2.statuses.get("x")!.limitPhase, "paused");
  t2.limits.stop();
}

// ---- Codex's config has the usage hook for a subscription agent, and not for an API-key agent.
{
  const { codexConfig, codexUsageCommand } = await import("../server/adapters");
  const { newAgent } = await import("../server/store");
  const agent = newAgent("dai", "Dai", "Dev", "#fff", false);
  Object.assign(agent, { cli: "codex", auth: "subscription", provider: "openai", mode: "sandbox" });
  const cfg = { project: { hqPort: 7420 }, team: [agent], workflow: { merge: { by: "human" }, review: { enabled: true, tool: "human", command: "" }, deploy: { enabled: false } } };
  const sub = codexConfig(agent, cfg as never, "tok", "/x");
  assert.ok(sub.includes("/hook/dai/Usage") && sub.includes("rate_limits"));
  assert.equal(sub.match(/\[\[hooks\.Stop\.hooks\]\]/g)?.length, 2, "HQ's Stop hook and the usage hook");
  const key = codexConfig({ ...agent, auth: "apiKey", provider: "openai" }, cfg as never, "tok", "/x");
  assert.ok(!key.includes("/Usage"));
  assert.match(codexUsageCommand("http://h:1", "tok", "dai"), /transcript_path/);
}

// ---- Usage drops below 90% before the reset (credits added): released early. The limit itself arriving ends the winding down.
{
  const t = make("early");
  const w = (pct: number) => ({ five_hour: { used_percentage: pct, resets_at: inOneHour } });
  t.limits.observe("a", w(91));
  assert.equal(t.statuses.get("a")!.limitPhase, "winding-down");
  t.limits.observe("a", w(30));
  assert.ok(!t.statuses.get("a")!.limitedUntil);
  t.limits.observe("a", w(95));
  assert.equal(t.statuses.get("a")!.limitPhase, "winding-down");
  t.limits.observe("a", w(100));
  assert.equal(t.statuses.get("a")!.limitPhase, "blocked", "the limit is here: nothing left to save with");
  t.limits.stop();
}

// ---- StopFailure(rate_limit): a subscription agent waits; an API-key agent has an error to fix.
{
  const t = make("stopfailure");
  const inbox = { noteHook: () => {} };
  handleHook(t.hub as never, inbox as never, "a", "StopFailure", { error: "rate_limit" }, undefined, t.limits);
  assert.equal(t.statuses.get("a")!.state, "idle");
  assert.ok(t.statuses.get("a")!.limitedUntil, "blocked, with a guessed time to look again");
  assert.ok(t.statuses.get("a2")!.limitedUntil, "the whole account");
  handleHook(t.hub as never, inbox as never, "key", "StopFailure", { error: "rate_limit" }, undefined, t.limits);
  assert.equal(t.statuses.get("key")!.state, "needs-input");
  // Claude Code's own wait notices are not "needs you".
  handleHook(t.hub as never, inbox as never, "a2", "Notification", { notification_type: "quota_auto_resume_disabled", message: "stopped" }, undefined, t.limits);
  assert.equal(t.statuses.get("a2")!.state, "idle");
  t.limits.stop();
}

// ---- The reset: the wait ends, the lead is told, and only an idle agent with a task is nudged.
{
  const t = make("reset");
  t.limits.observe("a", { five_hour: { used_percentage: 100, resets_at: inOneHour } });
  t.sent.length = 0;
  t.limits.tick(Date.now() + 1000); // not yet
  assert.ok(t.limits.blockedUntil("a"));
  t.statuses.get("a2")!.state = "working"; // a2 continued by itself
  t.limits.tick(Date.now() + 3601 * 1000);
  assert.equal(t.limits.blockedUntil("a"), null);
  assert.ok(!t.statuses.get("a")!.limitedUntil);
  assert.match(t.sent.find((s) => s[0] === "lead")![1], /has reset/);
  await sleep(120);
  const nudged = t.sent.filter((s) => /Continue/.test(s[1])).map((s) => s[0]);
  assert.deepEqual(nudged, ["a"], "a is idle with a task; a2 is already working");
  t.limits.stop();
}

// ---- Codex's screen: handled once, not slid later at every look.
{
  const t = make("codex");
  const screen = "■ You've hit your usage limit. Try again in 3 hours.";
  t.limits.codexScreen("x", screen);
  const first = t.statuses.get("x")!.limitedUntil;
  assert.ok(first);
  await sleep(20);
  t.limits.codexScreen("x", screen);
  assert.equal(t.statuses.get("x")!.limitedUntil, first);
  assert.deepEqual(t.sent.map((s) => s[0]), [], "the lead is Codex too, on the same account");
  t.limits.stop();
}

// ---- A restart during a wait keeps the wait.
{
  const first = make("restart");
  first.limits.observe("a", { five_hour: { used_percentage: 100, resets_at: inOneHour } });
  first.limits.stop();
  const second = make("restart");
  assert.ok(second.limits.blockedUntil("a"));
  assert.ok(second.statuses.get("a2")!.limitedUntil);
  second.limits.stop();
  // ...also one that was winding down: the agents come back paused.
  const wd = make("restart-winddown");
  wd.limits.observe("a", { five_hour: { used_percentage: 93, resets_at: inOneHour } });
  wd.limits.stop();
  const wd2 = make("restart-winddown");
  assert.equal(wd2.statuses.get("a")!.limitPhase, "paused");
  wd2.limits.stop();
}

// ---- A draft PR is work in progress: not reviewed, and its task stays in progress.
{
  const { toPullRequest } = await import("../server/github");
  const { GitHubSync } = await import("../server/githubSync");
  const gh = {
    number: 12, title: "[PFD-T01] Scaffold", url: "u", headRefName: "dwight/PFD-T01", createdAt: "2026-11-11T00:00:00Z", mergedAt: null, state: "OPEN" as const,
    mergeable: "MERGEABLE" as const, isDraft: true, reviewDecision: null, reviews: { nodes: [] }, reviewThreads: { nodes: [] }, commits: { nodes: [] },
  };
  const draft = toPullRequest(gh as never, "coderabbit", true, "PFD-T01", "a");
  assert.equal(draft.draft, true);
  assert.equal(draft.review, "pending", "a draft is never reviewed or passed");
  assert.match(draft.reviewNote ?? "", /work in progress/i);
  assert.equal(toPullRequest({ ...gh, isDraft: false } as never, "human", false, "PFD-T01", "a").draft, false);

  const task = { id: "PFD-T01", status: "in-progress", prNumber: undefined as number | undefined };
  const updates: unknown[] = [];
  const planner = { task: () => task, updateTask: (_id: string, p: unknown) => updates.push(p) };
  const sync = new GitHubSync({} as never, planner as never, "o/r");
  (sync as unknown as { syncTask(pr: unknown): void }).syncTask(draft);
  assert.deepEqual(updates, [{ prNumber: 12 }], "only the PR number is recorded: the task stays in progress");
  (sync as unknown as { syncTask(pr: unknown): void }).syncTask({ ...draft, draft: false });
  assert.deepEqual(updates[1], { status: "in-review", prNumber: 12 }, "once it is ready for review the task moves on");
}

console.log("✓ rate limits");
process.exit(0);
