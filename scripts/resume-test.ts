// An agent that starts again continues its last conversation: the flag each CLI takes, and when HQ uses it.
//
//   npx tsx scripts/resume-test.ts

import assert from "node:assert/strict";
import { adapters, opencodeConfig, opencodeModel, shouldResume } from "../server/adapters";
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

// OpenCode does not know Claude Code's model names: "anthropic/opus" is "Model unavailable". Full ids pass through.
const oc = (patch: Partial<AgentConfig>) => agent("opencode", { auth: "apiKey", ...patch });
assert.equal(opencodeModel(oc({ provider: "anthropic", model: "" })), "claude-sonnet-5-5", "the default for Anthropic is Sonnet, as an id and not the bare alias");
assert.equal(opencodeModel(oc({ provider: "anthropic", model: "sonnet" })), "claude-sonnet-5-5");
assert.equal(opencodeModel(oc({ provider: "anthropic", model: "Haiku" })), "claude-haiku-5-5");
assert.equal(opencodeModel(oc({ provider: "anthropic", model: "claude-haiku-4-5" })), "claude-haiku-4-5", "a full id is left alone");
assert.equal(opencodeModel(oc({ provider: "deepseek", model: "" })), "deepseek-v4-pro");
assert.equal(opencodeModel(oc({ provider: "deepseek", model: "opus" })), "opus", "only Anthropic's aliases are translated");
assert.equal(opencodeModel(oc({ provider: "openai", model: "" })), "", "no model: OpenCode picks");
const written = opencodeConfig(oc({ provider: "anthropic", model: "opus" }), cfg, "tok", "/x") as { model?: string };
assert.equal(written.model, "anthropic/claude-opus-5-5");
assert.equal(adapters.claude.launch(agent("claude", { provider: "anthropic", model: "opus" }), cfg, "/x").args.slice(-2).join(" "), "--model opus", "Claude Code keeps its alias");

console.log("✓ resume");
