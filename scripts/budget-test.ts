// The daily budget: what counts, how Claude Code's running totals are turned into amounts, the
// 80% warning, the 100% stop, and what a restart or a new day does.
//
//   npx tsx scripts/budget-test.ts

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The spend file goes in a scratch home, not the real ~/.jsmhq.
const home = mkdtempSync(join(tmpdir(), "hq-budget-"));
Object.assign(process.env, { HOME: home, USERPROFILE: home });

const { Budget, localDay } = await import("../server/budget");
const { handleHook } = await import("../server/hooks");

type Agent = { id: string; auth: "subscription" | "apiKey" };
const team: Agent[] = [
  { id: "paid", auth: "apiKey" },
  { id: "sub", auth: "subscription" },
];
const make = (slug: string, dailyUsd: number) => {
  const activity: string[] = [];
  const events: { type: string }[] = [];
  const config = { team, workflow: { budget: { dailyUsd } } };
  const hub = {
    slug,
    snap: { config, budget: undefined as unknown },
    cfg: (id: string) => team.find((a) => a.id === id),
    status: () => ({ session: { state: "running" } }),
    name: (id: string) => id,
    activity: (_t: string, _id: string | null, text: string) => activity.push(text),
    emit: (e: { type: string }) => events.push(e),
  };
  const stopped: string[][] = [];
  const notices: string[] = [];
  const budget = new Budget(hub as never, { stop: (ids) => stopped.push(ids), notice: (t) => notices.push(t) });
  return { hub, config, budget, activity, events, stopped, notices };
};
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

// What counts: an API-key agent. A subscription agent's cost is ignored.
{
  const t = make("count", 10);
  t.budget.record("paid", 1.25);
  t.budget.record("sub", 5);
  t.budget.record("paid", -3);
  t.budget.record("paid", Number.NaN);
  near(t.budget.state().spentUsd, 1.25);
  assert.deepEqual(Object.keys(t.budget.state().perAgent), ["paid"]);
}

// Claude Code's running total per session: only the new part is added.
{
  const t = make("totals", 10);
  t.budget.recordTotal("paid", "s1", 1);
  t.budget.recordTotal("paid", "s1", 1); // the status line repeats itself
  t.budget.recordTotal("paid", "s1", 1.5);
  near(t.budget.state().spentUsd, 1.5);
  t.budget.recordTotal("paid", "s2", 0.25); // a new session starts from zero
  near(t.budget.state().spentUsd, 1.75);
}

// Cost reports arrive through the hook route and don't move the agent's state.
{
  const t = make("hook", 10);
  const inbox = { noteHook: () => assert.fail("a cost report is not agent activity") };
  assert.deepEqual(handleHook(t.hub as never, inbox as never, "paid", "Cost", { cost: 0.5 }, t.budget), { ok: true });
  handleHook(t.hub as never, inbox as never, "paid", "StatusLine", { session_id: "x", cost: { total_cost_usd: 0.75 } }, t.budget);
  near(t.budget.state().spentUsd, 1.25);
}

// 80% warns once; 100% stops the API-key agents once and blocks their start; raising the limit unblocks.
{
  const t = make("limit", 10);
  t.budget.record("paid", 7.9);
  assert.equal(t.activity.length, 0);
  t.budget.record("paid", 0.2); // 8.10
  assert.equal(t.activity.length, 1);
  assert.match(t.activity[0], /Budget/);
  t.budget.record("paid", 0.1);
  assert.equal(t.activity.length, 1, "warns once");
  assert.equal(t.stopped.length, 0);
  assert.equal(t.budget.blocks("paid"), false);

  t.budget.record("paid", 2); // 10.20
  assert.deepEqual(t.stopped, [["paid"]]);
  assert.equal(t.notices.length, 1);
  assert.equal(t.budget.blocks("paid"), true);
  assert.equal(t.budget.blocks("sub"), false, "a subscription agent still starts");
  assert.equal(t.budget.state().exceeded, true);
  t.budget.record("paid", 1);
  assert.equal(t.stopped.length, 1, "stops once");

  t.config.workflow.budget.dailyUsd = 50;
  t.budget.refresh();
  assert.equal(t.budget.blocks("paid"), false, "a higher limit lets it start again");
  t.config.workflow.budget.dailyUsd = 5;
  t.budget.refresh();
  assert.equal(t.stopped.length, 2, "and the limit can trigger again");
  t.budget.flush();
}

// No limit: spend is tracked and nothing is stopped.
{
  const t = make("nolimit", 0);
  t.budget.record("paid", 500);
  near(t.budget.state().spentUsd, 500);
  assert.equal(t.budget.blocks("paid"), false);
  assert.equal(t.stopped.length, 0);
}

// A restart keeps today's spend and doesn't repeat the stop; a new day starts from zero.
{
  const first = make("restart", 10);
  first.budget.record("paid", 11);
  assert.equal(first.stopped.length, 1);
  first.budget.flush();
  const second = make("restart", 10);
  second.budget.refresh();
  near(second.budget.state().spentUsd, 11);
  assert.equal(second.stopped.length, 0, "already stopped before the restart");
  assert.equal(second.budget.blocks("paid"), true);

  const dir = join(home, ".jsmhq", "newday");
  mkdirSync(dir, { recursive: true });
  const yesterday = localDay(new Date(Date.now() - 36 * 3600 * 1000));
  writeFileSync(join(dir, "spend.json"), JSON.stringify({ days: { [yesterday]: { paid: 99 } }, sessions: {}, flags: { day: yesterday, warned: true, stopped: true } }));
  const day = make("newday", 10);
  day.budget.refresh();
  near(day.budget.state().spentUsd, 0);
  assert.equal(day.budget.blocks("paid"), false, "yesterday's stop does not carry over");
}

console.log("✓ budget");
process.exit(0);
