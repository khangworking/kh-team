// Per-CLI differences: which files HQ writes into the agent's folder and how
// the agent is launched. Everything else (hooks → state, Team MCP, delivery)
// is shared — Codex and Claude Code send the same hook payloads, and OpenCode's
// plugin (opencodePlugin.ts) posts the same events.

import { join } from "node:path";
import { agentWrite } from "./lib/agentFs";
import { PROVIDER_INFO } from "../src/data/providers";
import type { AgentCli, AgentConfig, HqConfig } from "../src/data/types";
import { adoptRoleFile, dropLegacyFiles, excludeFromGit, HOOK_SCRIPT, type RoleExtras, hookCommand, hookScriptFor, hqUrl, MCP_CONFIG, ROLE_FILE, roleMd, writeClaudeFiles, writeHookScript } from "./agentFiles";
import { run } from "./lib/exec";
import { opencodePluginSource } from "./opencodePlugin";

export interface Launch {
  sbxAgent: string; // agent name for `sbx run`
  args: string[]; // the CLI's own arguments (not shell-quoted)
  /** Local mode: run through `env` with these variables (not secrets: those come from env files). */
  env?: Record<string, string>;
  /** Local mode: variables to drop from the agent's environment. */
  unset?: string[];
}

export interface CliAdapter {
  /** Writes HQ's files into the agent's folder (all git-excluded). */
  writeFiles(dir: string, agent: AgentConfig, cfg: HqConfig, token: string, extras?: RoleExtras): Promise<void>;
  /** `resume`: the agent has an earlier conversation in its sandbox and should continue it. */
  launch(agent: AgentConfig, cfg: HqConfig, dir: string, opts?: { resume?: boolean }): Launch;
  /** False when the CLI can't run in Docker Sandboxes (yet). */
  sandbox: boolean;
}

/**
 * Whether an agent that starts continues its last conversation. The conversation lives in the agent's sandbox, so
 * only an existing sandbox made for this CLI has one: a new sandbox, or one rebuilt for another CLI, starts fresh.
 */
export function shouldResume(agent: Pick<AgentConfig, "mode" | "resume" | "cli">, sandboxAgent: string | null): boolean {
  return agent.mode === "sandbox" && agent.resume !== false && sandboxAgent === agent.cli;
}

// ---------------------------------------------------------------- Claude Code

const claude: CliAdapter = {
  sandbox: true,
  async writeFiles(dir, agent, cfg, token, extras = {}) {
    const ownRole = await adoptRoleFile(dir);
    writeClaudeFiles(dir, agent, cfg, token, { ...extras, ownRole });
  },
  launch(agent, _cfg, _dir, opts) {
    // "Opus" / "Sonnet" / "Haiku" → Claude Code's aliases; anything else is passed as a full model id.
    const m = agent.model.trim();
    // On DeepSeek/OpenRouter the model comes from ANTHROPIC_MODEL (providerKeys.ts).
    const model = !m || /^default$/i.test(m) || PROVIDER_INFO[agent.provider].anthropicBaseUrl ? null : /^(opus|sonnet|haiku)$/i.test(m) ? m.toLowerCase() : m;
    // Relative to the agent's folder, where it starts. An absolute path would be the host's, and on
    // Windows the folder has a different path inside the sandbox (C:\x on the host, /c/x in the sandbox).
    return {
      sbxAgent: "claude",
      args: ["--mcp-config", MCP_CONFIG, ...(opts?.resume ? ["--continue"] : []), ...(model ? ["--model", model] : [])],
      // HQ started from a Claude Code terminal passes this on, and Claude Code then refuses to start ("nested session").
      unset: ["CLAUDECODE"],
    };
  },
};

// ---------------------------------------------------------------- Codex

export const CODEX_CONFIG = ".codex/config.toml";
const CODEX_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "Stop", "SessionEnd"];

/** TOML basic string (JSON's escaping is valid TOML for these characters). */
const t = (s: string) => JSON.stringify(s);

/**
 * Codex writes its usage windows (5-hour and weekly, as percentages) into its session file, which every hook
 * is told the path of. After each turn this reads the latest ones and posts them to HQ (the usage-limit wind-down).
 * Runs in the agent's sandbox, which has sh, jq and curl.
 */
export function codexUsageCommand(url: string, token: string, agentId: string): string {
  const post = `curl -sf -m 4 -X POST -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' --data "{\\"rate_limits\\":$rl}" '${url}/hook/${agentId}/Usage'`;
  return (
    `f=$(jq -r '.transcript_path // empty' 2>/dev/null); ` +
    `if [ -n "$f" ] && [ -f "$f" ]; then rl=$(grep '"rate_limits":{' "$f" | tail -1 | jq -c '(.payload.rate_limits // .rate_limits) // empty' 2>/dev/null); ` +
    `[ -n "$rl" ] && ${post} >/dev/null 2>&1; fi; true`
  );
}

export function codexConfig(agent: AgentConfig, cfg: HqConfig, token: string, dir: string, extras: RoleExtras = {}): string {
  const url = hqUrl(agent, cfg.project.hqPort);
  const script = hookScriptFor(agent, dir);
  const lines = [
    "# Written by KH Team for this agent (git-excluded). Codex loads it once you trust this folder.",
    `developer_instructions = ${t(roleMd(agent, cfg, extras))}`,
    // API-key agents use OPENAI_API_KEY from their provider env file instead of a ChatGPT sign-in.
    ...(agent.auth === "apiKey" ? ['forced_login_method = "api"'] : []),
    "",
    "[features]",
    "hooks = true",
    "",
    "[mcp_servers.hq]",
    `url = ${t(`${url}/mcp`)}`,
    `http_headers = { Authorization = ${t(`Bearer ${token}`)}, "X-HQ-Agent" = ${t(agent.id)} }`,
  ];
  for (const event of CODEX_EVENTS) {
    lines.push("", `[[hooks.${event}]]`, `[[hooks.${event}.hooks]]`, 'type = "command"', `command = ${t(hookCommand(url, token, agent.id, event, script))}`);
    // A ChatGPT subscription has usage windows; an API key has none. (A Local-mode Windows agent has no sh, jq or curl.)
    if (event === "Stop" && agent.auth === "subscription" && !script) lines.push(`[[hooks.${event}.hooks]]`, 'type = "command"', `command = ${t(codexUsageCommand(url, token, agent.id))}`);
  }
  return lines.join("\n") + "\n";
}

const codex: CliAdapter = {
  sandbox: true,
  async writeFiles(dir, agent, cfg, token, extras = {}) {
    // A repo that commits its own Codex config can't take HQ's without changing a tracked file.
    const tracked = await run("git", ["ls-files", "--error-unmatch", CODEX_CONFIG], { cwd: dir });
    if (tracked.ok) throw new Error(`This repo commits ${CODEX_CONFIG}, so HQ can't add its Codex settings without changing a tracked file. Use Claude Code for this agent, or remove that file from the repo.`);
    // The role goes in the config (developer_instructions); the folder's own ROLE.md is included, never overwritten.
    dropLegacyFiles(dir);
    const ownRole = await adoptRoleFile(dir);
    agentWrite(dir, CODEX_CONFIG, codexConfig(agent, cfg, token, dir, { ...extras, ownRole }), { mode: 0o600 });
    if (hookScriptFor(agent, dir)) writeHookScript(dir);
    excludeFromGit(dir, [CODEX_CONFIG, HOOK_SCRIPT]);
  },
  launch(agent, _cfg, _dir, opts) {
    const model = agent.model.trim() && !/^default$/i.test(agent.model.trim()) ? agent.model.trim() : null;
    // `codex resume --last` continues the latest session of this folder; with none it starts a new one.
    return { sbxAgent: "codex", args: [...(opts?.resume ? ["resume", "--last"] : []), ...(model ? ["-m", model] : [])] };
  },
};

// ---------------------------------------------------------------- OpenCode

/** Project config OpenCode 2.x loads from the agent's folder; HQ's plugin sits beside it. */
export const OPENCODE_CONFIG = ".opencode/opencode.json";
const OPENCODE_PLUGIN = ".opencode/kh-hq";

/** OpenCode's provider settings for the agent: keys come from the env file HQ passes to the sandbox. */
function opencodeProviders(agent: AgentConfig): Record<string, unknown> {
  const info = PROVIDER_INFO[agent.provider];
  if (agent.provider === "ollama") return { ollama: { settings: { baseURL: "http://host.docker.internal:11434/v1", apiKey: "ollama" } } };
  return info.keyVar ? { [agent.provider]: { settings: { apiKey: `{env:${info.keyVar}}` } } } : {};
}

/**
 * Claude Code takes "opus", "sonnet" and "haiku" as model names; OpenCode only knows full ids ("Model unavailable:
 * anthropic/opus"). Those three, and nothing else, are turned into an id: the newest of that family the provider
 * lists now (`latest`), or, when HQ has no list, these, which are only as new as this release.
 */
const OPENCODE_ANTHROPIC_FALLBACK: Record<string, string> = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" };

/** The model OpenCode starts with for this agent ("" = OpenCode's own choice). */
export function opencodeModel(agent: Pick<AgentConfig, "provider" | "model">, latest?: (family: string) => string | null): string {
  const info = PROVIDER_INFO[agent.provider];
  const chosen = agent.model.trim() || info.defaultModel || info.models[0] || "";
  if (agent.provider !== "anthropic") return chosen;
  const family = chosen.toLowerCase();
  return OPENCODE_ANTHROPIC_FALLBACK[family] ? (latest?.(family) ?? OPENCODE_ANTHROPIC_FALLBACK[family]) : chosen;
}

export function opencodeConfig(agent: AgentConfig, cfg: HqConfig, token: string, dir: string, latest?: (family: string) => string | null): Record<string, unknown> {
  const model = opencodeModel(agent, latest);
  return {
    $schema: "https://opencode.ai/config.json",
    ...(model ? { model: `${agent.provider}/${model}` } : {}),
    // The sandbox mounts the agent's folder at the same path as on the host.
    instructions: [join(dir, ROLE_FILE)],
    plugins: [join(dir, OPENCODE_PLUGIN)],
    providers: opencodeProviders(agent),
    // codemode: false declares HQ's tools to the model directly, instead of only inside Code Mode scripts.
    mcp: { servers: { hq: { type: "remote", url: `${hqUrl(agent, cfg.project.hqPort)}/mcp`, oauth: false, codemode: false, headers: { Authorization: `Bearer ${token}`, "X-HQ-Agent": agent.id } } } },
  };
}

const opencode: CliAdapter = {
  sandbox: true,
  async writeFiles(dir, agent, cfg, token, extras = {}) {
    // A repo that commits its own OpenCode config can't take HQ's without changing a tracked file.
    const tracked = await run("git", ["ls-files", "--error-unmatch", OPENCODE_CONFIG], { cwd: dir });
    if (tracked.ok) throw new Error(`This repo commits ${OPENCODE_CONFIG}, so HQ can't add its OpenCode settings without changing a tracked file. Use Claude Code or Codex for this agent, or remove that file from the repo.`);
    dropLegacyFiles(dir);
    const ownRole = await adoptRoleFile(dir);
    agentWrite(dir, ROLE_FILE, roleMd(agent, cfg, { ...extras, ownRole }));
    agentWrite(dir, OPENCODE_CONFIG, JSON.stringify(opencodeConfig(agent, cfg, token, dir, extras.claudeLatest), null, 2) + "\n", { mode: 0o600 });
    agentWrite(dir, `${OPENCODE_PLUGIN}/index.ts`, opencodePluginSource({ hqUrl: hqUrl(agent, cfg.project.hqPort), token, agentId: agent.id }), { mode: 0o600 });
    excludeFromGit(dir, [ROLE_FILE, OPENCODE_CONFIG, `${OPENCODE_PLUGIN}/`]);
  },
  launch(_agent, _cfg, _dir, opts) {
    // The sandbox is the boundary, so OpenCode approves its own tool calls.
    return { sbxAgent: "opencode", args: ["--auto", ...(opts?.resume ? ["--continue"] : [])] };
  },
};

export const adapters: Record<AgentCli, CliAdapter> = { claude, codex, opencode };

/** The command a Local-mode agent runs on the host. */
export const localBinary: Record<AgentCli, string> = { claude: "claude", codex: "codex", opencode: "opencode" };
