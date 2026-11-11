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

const { RateLimits, parseCodexLimit } = await import("../server/rateLimits");
const { handleHook } = await import("../server/hooks");

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
  { id: "x", isLead: false, auth: "subscription", provider: "openai" },
  { id: "key", isLead: false, auth: "apiKey", provider: "anthropic" },
];
type Status = { state: string; note: string | null; limitedUntil?: string | null; session: { state: string } };
const make = (slug: string) => {
  const statuses = new Map<string, Status>(team.map((t) => [t.id, { state: "idle", note: null, session: { state: "running" } }]));
  const tasks = [{ id: "T1", title: "Do it", ownerId: "a", status: "in-progress" }, { id: "T2", title: "Other", ownerId: "a2", status: "in-progress" }];
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
  assert.match(t.sent[0][1], /a, a2 can't work until/);
  t.limits.observe("a2", { five_hour: { used_percentage: 100, resets_at: inOneHour } }); // repeated: no second notice
  t.limits.hit("a", null); // StopFailure for a limit already known
  assert.equal(t.sent.length, 1);
  assert.ok(t.limits.blockedUntil("a2"));
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
}

console.log("✓ rate limits");
process.exit(0);
