// An agent with an API key runs out of credit mid-task: HQ writes what it did into the task from the agent's
// git folder, puts the task back in todo with no owner and ON HOLD (only the user assigns it again), marks the
// agent out of credit, tells the lead and the user.
//
//   npx tsx scripts/credit-test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitFacts, isOutOfCredit, OutOfCredit } from "../server/outOfCredit";
import { handleHook } from "../server/hooks";
import { Planner } from "../server/planner";

// ---- What counts as "no credit"
for (const yes of [
  "AI.Error.QuotaExceeded: Insufficient Balance (request_id: 5c8db5dc)",
  "Your credit balance is too low to access the Anthropic API.",
  "billing_error",
  "You exceeded your current quota, please check your plan and billing details",
  "402 Payment Required",
  "Insufficient credits",
]) assert.ok(isOutOfCredit(yes), yes);
for (const no of ["rate_limit", "model_not_found", "API Error: Rate limit reached", "overloaded", "invalid_request", ""]) assert.ok(!isOutOfCredit(no), no);

// ---- What HQ can read about the work from the agent's folder
const tmp = mkdtempSync(join(tmpdir(), "hq-credit-"));
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
const source = join(tmp, "source");
mkdirSync(source);
writeFileSync(join(source, "a.txt"), "one\n");
sh(source, "init", "-q", "-b", "main");
sh(source, "add", ".");
sh(source, "commit", "-qm", "init");
const clone = join(tmp, "dwight");
sh(tmp, "clone", "-q", source, clone);
sh(clone, "checkout", "-q", "-b", "p1f-t07-theme");
writeFileSync(join(clone, "theme.ts"), "x\n");
sh(clone, "add", ".");
sh(clone, "commit", "-qm", "Add the theme hook");
writeFileSync(join(clone, "theme.ts"), "xy\n");
sh(clone, "commit", "-qam", "Persist the theme choice");
writeFileSync(join(clone, "App.tsx"), "draft\n");
const facts = await gitFacts(clone);
for (const must of ["branch p1f-t07-theme", "2 commits not on main", '"Persist the theme choice"', '"Add the theme hook"', "1 uncommitted file (App.tsx)", "NOT pushed"]) assert.ok(facts.includes(must), `facts has "${must}": ${facts}`);
assert.match(await gitFacts(join(tmp, "missing")), /folder is gone/);

// ---- The whole flow, with fakes for the hub
type Agent = { id: string; name: string; isLead: boolean; auth: "subscription" | "apiKey"; provider: string };
const team: Agent[] = [
  { id: "michael", name: "Michael", isLead: true, auth: "subscription", provider: "anthropic" },
  { id: "dwight", name: "Dwight", isLead: false, auth: "apiKey", provider: "deepseek" },
  { id: "jim", name: "Jim", isLead: false, auth: "subscription", provider: "anthropic" },
];
const make = () => {
  const statuses = new Map(team.map((t) => [t.id, { state: "idle", note: null as string | null, currentTaskId: null as string | null, outOfCredit: null as string | null, session: { state: "running", workspace: t.id === "dwight" ? clone : null } }]));
  const tasks = [
    { id: "T1", title: "Light/dark mode", boardId: "B1", ownerId: "dwight" as string | null, status: "in-progress", needs: [], prNumber: null, note: null as string | null, hold: null as string | null },
    { id: "T2", title: "Other", boardId: "B1", ownerId: null as string | null, status: "todo", needs: [], prNumber: null, note: null as string | null, hold: null as string | null },
  ];
  statuses.get("dwight")!.currentTaskId = "T1";
  const activity: { agentId: string | null; text: string }[] = [{ agentId: "dwight", text: "Dwight started T1" }, { agentId: "dwight", text: "Dwight is working" }];
  const pushed: [string, string][] = [];
  const notices: [string, string][] = [];
  const hub = {
    snap: { config: { team }, tasks, activity, messages: [] as unknown[], agents: [] as unknown[] },
    cfg: (id: string) => team.find((t) => t.id === id),
    status: (id: string) => statuses.get(id),
    setStatus: (id: string, p: object) => Object.assign(statuses.get(id)!, p),
    name: (id: string) => team.find((t) => t.id === id)?.name ?? id,
    activity: (_t: string, id: string | null, text: string) => activity.unshift({ agentId: id, text }),
    emit: () => {},
    planChanged: () => {},
  };
  const inbox = { push: (id: string, item: { text: string }) => pushed.push([id, item.text]) };
  const planner = new Planner(hub as never, inbox as never);
  const credit = new OutOfCredit(hub as never, planner, { dirOf: (id) => statuses.get(id)?.session.workspace ?? null, notice: (t, d) => notices.push([t, d]) });
  return { hub, planner, credit, statuses, tasks, pushed, notices, activity };
};

{
  const t = make();
  await t.credit.handle("dwight", "AI.Error.QuotaExceeded: Insufficient Balance (request_id: 5c8db5dc)");
  const dwight = t.statuses.get("dwight")!;
  assert.equal(dwight.state, "needs-input");
  assert.match(dwight.outOfCredit ?? "", /Insufficient Balance/);
  assert.ok(!(dwight.outOfCredit ?? "").includes("request_id"), "the request id is noise");
  assert.equal(dwight.currentTaskId, null);

  const task = t.tasks[0];
  assert.equal(task.status, "todo", "back in todo");
  assert.equal(task.ownerId, null, "with no owner");
  assert.match(task.hold ?? "", /Dwight ran out of credit/);
  for (const must of ["ran out of credit (DeepSeek", "branch p1f-t07-theme", "2 commits not on main", "1 uncommitted file (App.tsx)", "NOT pushed", clone, "Dwight started T1", "on hold"]) assert.ok(task.note!.includes(must), `the note has "${must}"`);
  assert.ok(task.note!.length <= 1000);
  if (process.env.SHOW) console.log(task.note, "\n---\n", t.pushed[0][1], "\n---\n", t.notices[0][1]);

  assert.equal(t.pushed.filter((p) => p[0] === "michael").length, 1, "the lead is told");
  assert.match(t.pushed[0][1], /Do not assign T1 again.*only the user/);
  assert.equal(t.notices.length, 1, "the user gets an action item");
  assert.match(t.notices[0][1], /add credit.*restart Dwight/i);

  await t.credit.handle("dwight", "Insufficient Balance"); // reported again at once: nothing new
  assert.equal(t.pushed.length, 1);
  assert.equal(t.notices.length, 1);

  // The lead may not assign the held task, nor anything to the agent that is out of credit. The user may.
  assert.throws(() => t.planner.assign("T1", "jim", "michael"), /on hold.*Only the user/);
  assert.throws(() => t.planner.assign("T2", "dwight", "michael"), /out of credit/);
  t.planner.assign("T1", "jim", "you");
  assert.equal(task.ownerId, "jim");
  assert.equal(task.hold, null, "assigned by the user: no longer on hold");
  assert.match(t.pushed[t.pushed.length - 1][1], /assigned you T1/);
  assert.ok(task.note!.includes("branch p1f-t07-theme"), "the new owner reads the summary in the task");

  // A new session of the agent (the user added credit and restarted it) clears the flag.
  t.credit.clear("dwight");
  assert.equal(t.statuses.get("dwight")!.outOfCredit, null);
  t.planner.assign("T2", "dwight", "michael");
}

// No task in progress: the agent is marked and the user told, and no task is touched.
{
  const t = make();
  t.tasks[0].status = "todo";
  t.tasks[0].ownerId = null;
  await t.credit.handle("dwight", "Insufficient Balance");
  assert.ok(t.statuses.get("dwight")!.outOfCredit);
  assert.equal(t.tasks[0].hold, null);
  assert.equal(t.notices.length, 1);
}

// A subscription agent is not covered here (its limits are usage windows).
{
  const t = make();
  await t.credit.handle("jim", "Insufficient Balance");
  assert.equal(t.statuses.get("jim")!.outOfCredit, null);
  assert.equal(t.notices.length, 0);
}

// ---- The hook route: StopFailure with a credit error goes to HQ's handler; other errors stay "provider error".
{
  const t = make();
  const seen: string[] = [];
  const credit = { handle: async (id: string, text: string) => void seen.push(`${id}:${text}`), clear: (id: string) => void seen.push(`clear:${id}`) };
  const inbox = { noteHook: () => {} };
  const hook = (id: string, event: string, body: object) => handleHook(t.hub as never, inbox as never, id, event, body, undefined, undefined, credit);
  hook("dwight", "StopFailure", { error: "AI.Error.QuotaExceeded: Insufficient Balance" });
  hook("dwight", "StopFailure", { error: "billing_error", error_details: "Your credit balance is too low" });
  assert.deepEqual(seen, ["dwight:AI.Error.QuotaExceeded: Insufficient Balance", "dwight:Your credit balance is too low"]);
  hook("dwight", "StopFailure", { error: "model_not_found" });
  assert.equal(t.statuses.get("dwight")!.state, "needs-input");
  assert.match(t.statuses.get("dwight")!.note ?? "", /Provider error/);
  assert.equal(seen.length, 2);
  hook("jim", "StopFailure", { error: "billing_error" }); // a subscription agent
  assert.equal(seen.length, 2);
  hook("dwight", "SessionStart", {});
  assert.equal(seen[2], "clear:dwight");
}

console.log("✓ out of credit");
process.exit(0);
