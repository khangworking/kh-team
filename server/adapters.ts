// Per-CLI differences: which files HQ writes into the agent's folder and how
// the agent is launched. Everything else (hooks → state, Team MCP, delivery)
// is shared — Codex and Claude Code send the same hook payloads, and OpenCode's
// plugin (opencodePlugin.ts) posts the same events.

import { join } from "node:path";
import { agentWrite } from "./lib/agentFs";
import { PROVIDER_INFO } from "../src/data/providers";
import type { AgentCli, AgentConfig, HqConfig } from "../src/data/types";
import { adoptRoleFile, excludeFromGit, HOOK_SCRIPT, type RoleExtras, hookCommand, hookScriptFor, hqUrl, MCP_CONFIG, ROLE_FILE, roleMd, writeClaudeFiles, writeHookScript } from "./agentFiles";
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
  launch(agent: AgentConfig, cfg: HqConfig, dir: string): Launch;
  /** False when the CLI can't run in Docker Sandboxes (yet). */
  sandbox: boolean;
}

// ---------------------------------------------------------------- Claude Code

const claude: CliAdapter = {
  sandbox: true,
  async writeFiles(dir, agent, cfg, token, extras = {}) {
    const ownRole = await adoptRoleFile(dir);
    writeClaudeFiles(dir, agent, cfg, token, { ...extras, ownRole });
  },
  launch(agent) {
    // "Opus" / "Sonnet" / "Haiku" → Claude Code's aliases; anything else is passed as a full model id.
    const m = agent.model.trim();
    // On DeepSeek/OpenRouter the model comes from ANTHROPIC_MODEL (providerKeys.ts).
    const model = !m || /^default$/i.test(m) || PROVIDER_INFO[agent.provider].anthropicBaseUrl ? null : /^(opus|sonnet|haiku)$/i.test(m) ? m.toLowerCase() : m;
    // Relative to the agent's folder, where it starts. An absolute path would be the host's, and on
    // Windows the folder has a different path inside the sandbox (C:\x on the host, /c/x in the sandbox).
    return {
      sbxAgent: "claude",
      args: ["--mcp-config", MCP_CONFIG, ...(model ? ["--model", model] : [])],
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

export function codexConfig(agent: AgentConfig, cfg: HqConfig, token: string, dir: string, extras: RoleExtras = {}): string {
  const url = hqUrl(agent, cfg.project.hqPort);
  const script = hookScriptFor(agent, dir);
  const lines = [
    "# Written by JSM HQ for this agent (git-excluded). Codex loads it once you trust this folder.",
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
  for (const event of CODEX_EVENTS)
    lines.push("", `[[hooks.${event}]]`, `[[hooks.${event}.hooks]]`, 'type = "command"', `command = ${t(hookCommand(url, token, agent.id, event, script))}`);
  return lines.join("\n") + "\n";
}

const codex: CliAdapter = {
  sandbox: true,
  async writeFiles(dir, agent, cfg, token, extras = {}) {
    // A repo that commits its own Codex config can't take HQ's without changing a tracked file.
    const tracked = await run("git", ["ls-files", "--error-unmatch", CODEX_CONFIG], { cwd: dir });
    if (tracked.ok) throw new Error(`This repo commits ${CODEX_CONFIG}, so HQ can't add its Codex settings without changing a tracked file. Use Claude Code for this agent, or remove that file from the repo.`);
    // The role goes in the config (developer_instructions); the folder's own ROLE.md is included, never overwritten.
    const ownRole = await adoptRoleFile(dir);
    agentWrite(dir, CODEX_CONFIG, codexConfig(agent, cfg, token, dir, { ...extras, ownRole }), { mode: 0o600 });
    if (hookScriptFor(agent, dir)) writeHookScript(dir);
    excludeFromGit(dir, [CODEX_CONFIG, HOOK_SCRIPT]);
  },
  launch(agent) {
    const model = agent.model.trim() && !/^default$/i.test(agent.model.trim()) ? agent.model.trim() : null;
    return { sbxAgent: "codex", args: model ? ["-m", model] : [] };
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

export function opencodeConfig(agent: AgentConfig, cfg: HqConfig, token: string, dir: string): Record<string, unknown> {
  const model = agent.model.trim() || PROVIDER_INFO[agent.provider].models[0] || "";
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
    const ownRole = await adoptRoleFile(dir);
    agentWrite(dir, ROLE_FILE, roleMd(agent, cfg, { ...extras, ownRole }));
    agentWrite(dir, OPENCODE_CONFIG, JSON.stringify(opencodeConfig(agent, cfg, token, dir), null, 2) + "\n", { mode: 0o600 });
    agentWrite(dir, `${OPENCODE_PLUGIN}/index.ts`, opencodePluginSource({ hqUrl: hqUrl(agent, cfg.project.hqPort), token, agentId: agent.id }), { mode: 0o600 });
    excludeFromGit(dir, [ROLE_FILE, OPENCODE_CONFIG, `${OPENCODE_PLUGIN}/`]);
  },
  launch() {
    // The sandbox is the boundary, so OpenCode approves its own tool calls.
    return { sbxAgent: "opencode", args: ["--auto"] };
  },
};

export const adapters: Record<AgentCli, CliAdapter> = { claude, codex, opencode };

/** The command a Local-mode agent runs on the host. */
export const localBinary: Record<AgentCli, string> = { claude: "claude", codex: "codex", opencode: "opencode" };
