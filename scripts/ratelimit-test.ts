// Subscription usage limits, one agent = one account: reading Claude Code's windows and Codex's windows and
// screen, the 90% wind-down (save work, draft PR, pause), blocking at the limit, telling the lead, holding work,
// and nudging agents that did not continue after the reset.
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

// Every agent is on its own subscription, apart from `key`, which uses an API key and has no usage windows.
type Agent = { id: string; isLead: boolean; cli: "claude" | "codex"; auth: "subscription" | "apiKey" };
const team: Agent[] = [
  { id: "lead", isLead: true, cli: "codex", auth: "subscription" },
  { id: "a", isLead: false, cli: "claude", auth: "subscription" },
  { id: "a2", isLead: false, cli: "claude", auth: "subscription" },
  { id: "a3", isLead: false, cli: "claude", auth: "subscription" }, // no task
  { id: "x", isLead: false, cli: "codex", auth: "subscription" },
  { id: "key", isLead: false, cli: "claude", auth: "apiKey" },
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
const claudeWin = (pct: number, resets = inOneHour) => ({ five_hour: { used_percentage: pct, resets_at: resets } });
const codexWin = (pct: number) => ({ primary: { used_percent: pct, window_minutes: 300, resets_at: inOneHour }, secondary: { used_percent: 20, window_minutes: 10080, resets_at: inOneHour + 604800 } });
const toLead = (t: ReturnType<typeof make>) => t.sent.filter((s) => s[0] === "lead").map((s) => s[1]);

// ---- A window at 85% warns once; it blocks nobody.
{
  const t = make("warn");
  t.limits.observe("a", claudeWin(85));
  t.limits.observe("a", claudeWin(85));
  assert.equal(t.activity.filter((a) => /85%/.test(a)).length, 1);
  assert.equal(t.limits.blockedUntil("a"), null);
  t.limits.observe("key", claudeWin(85)); // an API-key agent has no subscription
  assert.equal(t.activity.length, 1);
  t.limits.stop();
}

// ---- Each agent is its own account: a full window blocks only the agent that reports it.
{
  const t = make("block");
  t.limits.observe("a", { ...claudeWin(100), seven_day: { used_percentage: 40, resets_at: inOneHour + 86400 } });
  assert.equal(t.statuses.get("a")!.limitPhase, "blocked");
  assert.equal(Date.parse(t.statuses.get("a")!.limitedUntil!) / 1000, inOneHour);
  for (const id of ["a2", "a3", "x", "key", "lead"]) assert.ok(!t.statuses.get(id)!.limitedUntil, `${id} has its own account`);
  assert.equal(toLead(t).length, 1);
  assert.match(toLead(t)[0], /a reached its Claude Code usage limit/);
  t.limits.observe("a", claudeWin(100)); // repeated: no second notice
  t.limits.hit("a", null); // StopFailure for a limit already known
  assert.equal(toLead(t).length, 1);
  // a2 reports plenty left: it keeps working.
  t.limits.observe("a2", claudeWin(30, inOneHour + 7200));
  assert.ok(!t.statuses.get("a2")!.limitedUntil);
  t.limits.stop();
}

// ---- StopFailure(rate_limit): that agent waits; an API-key agent has an error to fix.
{
  const t = make("stopfailure");
  const inbox = { noteHook: () => {} };
  handleHook(t.hub as never, inbox as never, "a", "StopFailure", { error: "rate_limit" }, undefined, t.limits);
  assert.equal(t.statuses.get("a")!.state, "idle");
  assert.equal(t.statuses.get("a")!.limitPhase, "blocked", "blocked, with a guessed time to look again");
  assert.ok(!t.statuses.get("a2")!.limitedUntil, "another agent's account is not affected");
  handleHook(t.hub as never, inbox as never, "key", "StopFailure", { error: "rate_limit" }, undefined, t.limits);
  assert.equal(t.statuses.get("key")!.state, "needs-input");
  // Claude Code's own wait notices are not "needs you".
  handleHook(t.hub as never, inbox as never, "a2", "Notification", { notification_type: "quota_auto_resume_disabled", message: "stopped" }, undefined, t.limits);
  assert.equal(t.statuses.get("a2")!.state, "idle");
  t.limits.stop();
}

// ---- 90% used: the agent saves its work (commit, draft PR "Đang làm", WIP label, notes, lead told) and pauses until the reset.
{
  const t = make("winddown");
  t.statuses.get("a2")!.state = "working"; // mid-turn, with its own account at 40%
  t.limits.observe("a2", claudeWin(40));
  t.limits.observe("a", claudeWin(92));
  assert.equal(t.statuses.get("a")!.limitPhase, "winding-down", "a is saving its work");
  assert.ok(!t.statuses.get("a2")!.limitedUntil, "a2 has its own account and keeps working");
  const toA = t.sent.filter((s) => s[0] === "a").map((s) => s[1]);
  assert.equal(toA.length, 1);
  for (const must of ["92%", "[T1] WIP", "git push", "DRAFT", "Đang làm (WIP)", "--label WIP", "gh label create WIP", "set_my_status", "send_message", "in-review"]) assert.ok(toA[0].includes(must), `the wrap-up message has "${must}"`);
  assert.equal(toLead(t).length, 1, "the lead is told once");
  assert.match(toLead(t)[0], /a's Claude Code usage is at 92%.*saving its work/);
  t.limits.observe("a", claudeWin(93)); // repeated: nothing new
  assert.equal(t.sent.filter((s) => s[0] === "a").length, 1);
  assert.equal(toLead(t).length, 1);

  // An agent with no task has nothing to save: it pauses at once, with no wrap-up message.
  t.limits.observe("a3", claudeWin(91));
  assert.equal(t.statuses.get("a3")!.limitPhase, "paused");
  assert.equal(t.sent.filter((s) => s[0] === "a3").length, 0);

  // The wrap-up is done when the agent's turn ends with nothing queued (a queued message continues the turn).
  const inbox = { noteHook: () => {}, takeForStop: () => null, pending: () => 0 };
  t.limits.turnEnded("a", 1);
  assert.equal(t.statuses.get("a")!.limitPhase, "winding-down");
  handleHook(t.hub as never, inbox as never, "a", "Stop", {}, undefined, t.limits);
  assert.equal(t.statuses.get("a")!.limitPhase, "paused");
  assert.match(t.statuses.get("a")!.note!, /Work saved/);
  assert.ok(toLead(t).some((s) => /a saved its work and is paused/.test(s)));

  // After the reset the agent is released, and an idle agent with a task is told to continue with its notes and draft PR.
  t.tasks[0].prNumber = 12;
  t.tasks[0].note = "Done: schema. Next: routes.";
  t.sent.length = 0;
  t.limits.tick(Date.now() + 3601 * 1000);
  for (const id of ["a", "a3"]) assert.ok(!t.statuses.get(id)!.limitedUntil && !t.statuses.get(id)!.limitPhase, `${id} is released`);
  await sleep(120);
  const resume = t.sent.find((s) => s[0] === "a" && /Continue T1/.test(s[1]))?.[1] ?? "";
  for (const must of ["Done: schema. Next: routes.", "draft PR is #12", "gh pr ready 12", "--remove-label WIP", "in-review"]) assert.ok(resume.includes(must), `the resume message has "${must}"`);
  assert.equal(t.sent.filter((s) => s[0] === "a3").length, 0, "a3 had no task");
  assert.equal(t.sent.filter((s) => s[0] === "a2").length, 0, "a2 was never paused");
  assert.ok(toLead(t).some((s) => /a's Claude Code usage limit has reset/.test(s)));
  t.limits.stop();
}

// ---- Two agents that happen to share an account report the same numbers, and each winds down on its own.
{
  const t = make("shared");
  t.limits.observe("a", claudeWin(95));
  t.limits.observe("a2", claudeWin(95));
  assert.equal(t.statuses.get("a")!.limitPhase, "winding-down");
  assert.equal(t.statuses.get("a2")!.limitPhase, "winding-down");
  t.limits.stop();
}

// ---- Usage drops below 90% before the reset (credits added): released early. The limit arriving ends the winding down.
{
  const t = make("early");
  t.limits.observe("a", claudeWin(91));
  assert.equal(t.statuses.get("a")!.limitPhase, "winding-down");
  t.limits.observe("a", claudeWin(30));
  assert.ok(!t.statuses.get("a")!.limitedUntil);
  t.limits.observe("a", claudeWin(95));
  assert.equal(t.statuses.get("a")!.limitPhase, "winding-down");
  t.limits.observe("a", claudeWin(100));
  assert.equal(t.statuses.get("a")!.limitPhase, "blocked", "the limit is here: nothing left to save with");
  t.limits.stop();
}

// ---- Codex agents wind down the same way, from the windows Codex's session file reports (posted by a Stop hook).
{
  const t = make("codexdown");
  t.limits.observe("x", codexWin(88));
  assert.ok(!t.statuses.get("x")!.limitedUntil, "88% is a warning only");
  t.limits.observe("x", codexWin(92));
  assert.equal(t.statuses.get("x")!.limitPhase, "paused", "x holds no task here, so it pauses at once");
  assert.ok(!t.statuses.get("lead")!.limitedUntil, "the Codex lead has its own account");
  assert.ok(!t.statuses.get("a")!.limitedUntil, "so does the Claude agent");
  t.limits.observe("x", codexWin(100));
  assert.equal(t.statuses.get("x")!.limitPhase, "blocked");
  t.limits.stop();
  // The hook route: a usage report is not agent activity.
  const t2 = make("codexhook");
  const noActivity = { noteHook: () => assert.fail("a usage report is not agent activity") };
  assert.deepEqual(handleHook(t2.hub as never, noActivity as never, "x", "Usage", { rate_limits: codexWin(93) }, undefined, t2.limits), { ok: true });
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

// ---- Codex's screen: handled once per agent, not slid later at every look.
{
  const t = make("codex");
  const screen = "■ You've hit your usage limit. Try again in 3 hours.";
  t.limits.codexScreen("x", screen);
  const first = t.statuses.get("x")!.limitedUntil;
  assert.ok(first);
  await sleep(20);
  t.limits.codexScreen("x", screen);
  assert.equal(t.statuses.get("x")!.limitedUntil, first);
  assert.equal(toLead(t).length, 1, "the lead is told once");
  assert.ok(!t.statuses.get("lead")!.limitedUntil, "another Codex agent is another account");
  t.limits.stop();
}

// ---- A restart during a wait keeps the wait (and an agent that was saving its work comes back paused).
{
  const first = make("restart");
  first.limits.observe("a", claudeWin(100));
  first.limits.observe("a2", claudeWin(93));
  first.limits.stop();
  const second = make("restart");
  assert.ok(second.limits.blockedUntil("a"));
  assert.equal(second.statuses.get("a")!.limitPhase, "blocked");
  assert.equal(second.statuses.get("a2")!.limitPhase, "paused");
  assert.ok(!second.statuses.get("a3")!.limitedUntil);
  second.limits.stop();
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
