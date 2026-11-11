// An agent that starts again continues its last conversation: the flag each CLI takes, and when HQ uses it.
//
//   npx tsx scripts/resume-test.ts

import assert from "node:assert/strict";
import { adapters, shouldResume } from "../server/adapters";
import { newAgent } from "../server/store";
import type { AgentCli, AgentConfig, HqConfig } from "../src/data/types";

const agent = (cli: AgentCli, patch: Partial<AgentConfig> = {}): AgentConfig => ({ ...newAgent("a", "A", "Dev", "#fff", false), cli, ...patch });
const cfg = { project: { hqPort: 7420 }, team: [], workflow: { merge: { by: "human" } } } as unknown as HqConfig;
const args = (a: AgentConfig, resume: boolean) => adapters[a.cli].launch(a, cfg, "/x", { resume }).args;

// New agents continue by default.
assert.equal(newAgent("a", "A", "Dev", "#fff", false).resume, true);

// Claude Code: --continue (with no earlier conversation it starts a new one).
assert.deepEqual(args(agent("claude"), true), [...args(agent("claude"), false), "--continue"]);
assert.ok(!args(agent("claude"), false).includes("--continue"));
assert.deepEqual(args(agent("claude", { model: "opus" }), true).slice(-3), ["--continue", "--model", "opus"]);

// Codex: `codex resume --last` is a subcommand, so it comes first; the model flag still follows.
assert.deepEqual(args(agent("codex"), false), []);
assert.deepEqual(args(agent("codex"), true), ["resume", "--last"]);
assert.deepEqual(args(agent("codex", { model: "gpt-x" }), true), ["resume", "--last", "-m", "gpt-x"]);
assert.deepEqual(args(agent("codex", { model: "gpt-x" }), false), ["-m", "gpt-x"]);

// OpenCode 2.x: --continue, next to --auto.
assert.deepEqual(args(agent("opencode"), false), ["--auto"]);
assert.deepEqual(args(agent("opencode"), true), ["--auto", "--continue"]);

// When HQ asks for it: only an existing sandbox made for this CLI has a conversation, and the user can turn it off.
assert.equal(shouldResume(agent("claude"), "claude"), true);
assert.equal(shouldResume(agent("claude"), null), false, "a new sandbox has none");
assert.equal(shouldResume(agent("codex"), "claude"), false, "a sandbox rebuilt for another CLI starts fresh");
assert.equal(shouldResume(agent("opencode", { resume: false }), "opencode"), false, "the user turned it off");
assert.equal(shouldResume(agent("claude", { resume: undefined }), "claude"), true, "an older config continues");
assert.equal(shouldResume(agent("claude", { mode: "local" }), "claude"), false);

console.log("✓ resume");
