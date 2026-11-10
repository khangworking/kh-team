// HQ reminds an OpenCode agent that ends a run while it still holds an in-progress task, and gives
// up when the agent keeps stopping without using any tool.
//
//   npx tsx scripts/nudge-test.ts

import assert from "node:assert/strict";
import { handleHook } from "../server/hooks";

type Task = { id: string; title: string; ownerId: string | null; status: string };
const tasks: Task[] = [{ id: "T1", title: "Scaffold app", ownerId: "dwight", status: "in-progress" }];
const status = { state: "idle", note: "" as string | null };
const activity: string[] = [];
const hub = {
  snap: { tasks },
  status: () => ({ ...status, session: { state: "running" } }),
  name: (id: string) => id,
  setStatus: (_id: string, p: Partial<typeof status>) => Object.assign(status, p),
  activity: (_t: string, _id: string | null, text: string) => activity.push(text),
};
const pushed: string[] = [];
let queued = 0;
const inbox = {
  noteHook: () => {},
  pending: () => queued,
  push: (_id: string, item: { text: string }) => pushed.push(item.text),
  takeForStop: () => null,
};
const run = (event: string, body = {}) => handleHook(hub as never, inbox as never, "dwight", event, body);

// A run that ends with no tool call: reminded, three times, then HQ gives up.
for (let i = 1; i <= 3; i++) {
  run("UserPromptSubmit", { prompt: "go" });
  run("Idle");
  assert.equal(pushed.length, i, `reminder ${i}`);
}
assert.match(pushed[0], /T1/);
run("UserPromptSubmit", { prompt: "go" });
run("Idle");
assert.equal(pushed.length, 3, "no fourth reminder");
assert.match(status.note ?? "", /Stopped without finishing T1/);
assert.ok(activity.some((a) => /stopped reminding/.test(a)));

// A run that used tools is progress: the quiet count starts over.
run("UserPromptSubmit", { prompt: "go" });
run("PreToolUse", { tool_name: "bash" });
run("Idle");
assert.equal(pushed.length, 4, "reminded after a run with tools");

// Messages already queued start the next run themselves.
queued = 1;
run("UserPromptSubmit", { prompt: "go" });
run("Idle");
assert.equal(pushed.length, 4, "no reminder while messages are queued");
queued = 0;

// No in-progress task (the agent opened its PR): nothing to remind about.
tasks[0].status = "in-review";
run("UserPromptSubmit", { prompt: "go" });
run("Idle");
assert.equal(pushed.length, 4, "no reminder once the task is in review");

console.log("✓ nudge");
