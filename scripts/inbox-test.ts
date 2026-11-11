// The inbox is kept on disk: a message waiting for a busy agent survives HQ stopping, one typed but never
// answered goes back in the queue, and a message that no longer makes sense is dropped after a restart.
//
//   npx tsx scripts/inbox-test.ts

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The file goes in a scratch home, not the real ~/.jsmhq.
const home = mkdtempSync(join(tmpdir(), "hq-inbox-"));
Object.assign(process.env, { HOME: home, USERPROFILE: home });

const { Inbox, MAX_AGE_MS, MAX_QUEUE } = await import("../server/inbox");

const team = ["dwight", "jim"];
const make = (slug: string, tasks: { id: string; ownerId: string | null; status: string }[] = []) => {
  const state = new Map(team.map((id) => [id, { state: "working", session: { state: "running" } }]));
  const activity: string[] = [];
  const typed: [string, string][] = [];
  const hub = {
    slug,
    snap: { tasks },
    cfg: (id: string) => (team.includes(id) ? { id } : undefined),
    status: (id: string) => state.get(id),
    name: (id: string) => id,
    activity: (_t: string, _id: string | null, text: string) => activity.push(text),
  };
  const keys = { type: async (id: string, text: string) => (typed.push([id, text]), true), enter: async () => true };
  const inbox = new Inbox(hub as never, keys);
  const file = join(home, ".jsmhq", slug, "inbox.json");
  const saved = () => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { queues: Record<string, { text: string }[]>; inflight: Record<string, { text: string }[]> }) : { queues: {}, inflight: {} });
  return { hub, inbox, state, typed, activity, file, saved };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- A message for a busy agent is on disk, and comes back after a restart.
{
  const a = make("restart");
  a.inbox.push("dwight", { fromId: "you", kind: "message", text: "Please add tests." });
  a.inbox.flush();
  assert.equal(a.saved().queues.dwight.length, 1);
  assert.equal(statSync(a.file).mode & 0o777, 0o600, "owner only");
  assert.equal(a.typed.length, 0, "the agent is busy");
  a.inbox.stop();

  const b = make("restart"); // HQ started again
  assert.equal(b.inbox.pending("dwight"), 1);
  assert.match(b.activity[0], /restored 1 waiting message for dwight/);
  b.inbox.sessionReattached("dwight");
  b.state.get("dwight")!.state = "idle";
  await b.inbox.tryType("dwight");
  assert.match(b.typed[0][1], /Please add tests\./, "delivered once the agent is idle");
  b.inbox.stop();
}

// ---- Typed is not delivered until the agent answers.
{
  const a = make("inflight");
  a.state.get("dwight")!.state = "idle";
  a.inbox.sessionReattached("dwight");
  a.inbox.push("dwight", { fromId: "you", kind: "message", text: "Review the PR." });
  await sleep(50);
  a.inbox.flush();
  assert.equal(a.typed.length, 1);
  assert.equal(a.saved().queues.dwight?.length ?? 0, 0, "no longer waiting");
  assert.equal(a.saved().inflight.dwight.length, 1, "but kept until the agent answers");
  a.inbox.noteHook("dwight", "UserPromptSubmit");
  a.inbox.flush();
  assert.equal(a.saved().inflight.dwight?.length ?? 0, 0, "answered: gone");
  a.inbox.stop();

  // HQ stopped before the answer: the message comes back at the front of the queue.
  const b = make("inflight2");
  b.state.get("dwight")!.state = "idle";
  b.inbox.sessionReattached("dwight");
  b.inbox.push("dwight", { fromId: "you", kind: "message", text: "First." });
  await sleep(50);
  b.state.get("dwight")!.state = "working";
  b.inbox.push("dwight", { fromId: "you", kind: "message", text: "Second." });
  b.inbox.flush();
  b.inbox.stop();
  const c = make("inflight2");
  assert.equal(c.inbox.pending("dwight"), 2);
  c.inbox.flush();
  assert.deepEqual(c.saved().queues.dwight.map((i) => i.text), ["First.", "Second."], "in the original order");
  c.inbox.stop();

  // The session ended before the answer: back in the queue (without a restart).
  const d = make("inflight3");
  d.state.get("dwight")!.state = "idle";
  d.inbox.sessionReattached("dwight");
  d.inbox.push("dwight", { fromId: "you", kind: "message", text: "Lost with the session." });
  await sleep(50);
  assert.equal(d.inbox.pending("dwight"), 0);
  d.inbox.sessionDown("dwight");
  assert.equal(d.inbox.pending("dwight"), 1);
  d.inbox.stop();
}

// ---- A message that no longer makes sense is dropped after a restart.
{
  const tasks = [
    { id: "T1", ownerId: "dwight", status: "in-progress" },
    { id: "T2", ownerId: "dwight", status: "in-progress" },
    { id: "T3", ownerId: "dwight", status: "in-progress" },
  ];
  const a = make("stale", tasks);
  a.inbox.push("dwight", { fromId: "you", kind: "assign", text: "assigned T1", taskId: "T1" });
  a.inbox.push("dwight", { fromId: "you", kind: "assign", text: "assigned T2", taskId: "T2" });
  a.inbox.push("dwight", { fromId: "you", kind: "assign", text: "assigned T3", taskId: "T3" });
  a.inbox.push("dwight", { fromId: "hq", kind: "notice", text: "an old notice", at: new Date(Date.now() - MAX_AGE_MS - 1000).toISOString() });
  a.inbox.push("dwight", { fromId: "hq", kind: "notice", text: "a recent notice" });
  a.inbox.push("ghost", { fromId: "you", kind: "message", text: "for an agent that was removed" });
  a.inbox.flush();
  a.inbox.stop();
  tasks[1].ownerId = "jim"; // T2 moved on to someone else
  tasks[2].status = "done"; // T3 is finished
  const b = make("stale", tasks);
  b.inbox.flush();
  assert.deepEqual(b.saved().queues.dwight.map((i) => i.text), ["assigned T1", "a recent notice"]);
  assert.equal(b.inbox.pending("ghost"), 0);
  // The same check runs when the queue is handed over at the end of a turn.
  tasks[0].ownerId = "jim";
  assert.match(b.inbox.takeForStop("dwight") ?? "", /a recent notice/);
  b.inbox.flush();
  assert.equal(b.saved().queues.dwight?.length ?? 0, 0, "handed over: gone from the file");
  b.inbox.stop();
}

// ---- Limits and removal.
{
  const a = make("limits");
  for (let i = 0; i < MAX_QUEUE + 5; i++) a.inbox.push("dwight", { fromId: "you", kind: "message", text: `m${i}` });
  assert.equal(a.inbox.pending("dwight"), MAX_QUEUE, "the oldest go first");
  a.inbox.flush();
  assert.equal(a.saved().queues.dwight[0].text, "m5");
  a.inbox.forget("dwight");
  a.inbox.flush();
  assert.equal(a.saved().queues.dwight?.length ?? 0, 0, "a removed agent's queue is gone");
  a.inbox.stop();
}

// ---- A broken file is not fatal.
{
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(join(home, ".jsmhq", "broken"), { recursive: true });
  writeFileSync(join(home, ".jsmhq", "broken", "inbox.json"), "{ not json");
  const a = make("broken");
  assert.equal(a.inbox.pending("dwight"), 0);
  a.inbox.stop();
}

console.log("✓ inbox");
process.exit(0);
