## Implementation plan: P0 — Multi-provider agents, one sandbox each

### What we're building
Each agent picks how it reaches a model: a CLI's own subscription (Claude Code, Codex) or an API key for a provider (Anthropic, OpenAI, Gemini, DeepSeek, OpenRouter, Ollama on this machine). OpenCode is the third CLI and covers every API-key provider. **Every agent runs in its own Docker Sandbox**; there is no Local mode.

History: OpenCode 1.x on the host came first, then Pi, then OpenCode again because Docker Sandboxes ships OpenCode (not Pi) as a built-in agent. Old configs with `cli: "pi"` load as OpenCode, and every agent loads with `mode: "sandbox"`.

### Verified live (sbx 0.51.0, OpenCode 2.0.29 inside the sandbox, 2026-11-08)
- `sbx run opencode <dir>` runs **OpenCode 2.x** (the host has 1.19, a different config format). 2.x has a background service per sandbox and a TUI that connects to it; no `--port`.
- OpenCode 2.x loads the project config `.opencode/opencode.json` from the agent's folder (`OPENCODE_CONFIG` is not read). Keys used: `model`, `instructions`, `plugins` (a directory path), `providers.<id>.settings.{apiKey, baseURL}`, `mcp.servers.<name>.{type, url, headers, oauth, codemode}`.
- A plugin (`import { Plugin } from "@opencode/plugin"`, `Plugin.define({ id, setup(ctx) })`) loads from `plugins` and reads `ctx.event.subscribe()`. Events used: `session.execution.started` / `succeeded` / `failed`, `session.tool.input.started` (`data.name`), `session.tool.success` / `failed`, `session.step.ended` (`cost`, `tokens`).
- The plugin's `fetch` reaches HQ at `host.docker.internal:<port>` (HQ already adds that policy rule).
- MCP tools default to Code Mode (`tools.hq.list_workers(...)` inside an `execute` script); a small model got that wrong every time. `codemode: false` on the `hq` server declares `hq_list_workers` etc. directly, and the same model then called it and answered.
- With Ollama (`gemma4:e2b`) in the agent's sandbox: SessionStart → "Ready", a message → working → idle, the Team MCP call, a second message sent while busy delivered after the first run, and a bad model → "needs you · Provider error".
- Ollama on the host is reached as `http://host.docker.internal:11434/v1`; sbx checks it as `localhost:11434`, so the sandbox needs that rule. OpenCode needs a dummy `apiKey` for it.
- The balanced policy allows `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`; it blocks `openrouter.ai` and `api.deepseek.com`.
- Codex 0.167 has `forced_login_method`; `preferred_auth_method` is gone.
- DeepSeek on the host (before sandboxes were required): Claude Code on `https://api.deepseek.com/anthropic` and OpenCode both worked. Claude Code's own cost figure uses Claude prices, not DeepSeek's.

### Decisions
- `AgentConfig.auth: "subscription" | "apiKey"` and `provider: ProviderId`; `normalizeAuth()` keeps them valid for the CLI.
- Catalog in `src/data/providers.ts`: key variable, CLIs per provider, Anthropic-compatible base URL, hosts the sandbox needs (`sandboxHosts`), suggested models.
- Keys: one file per office, `~/.jsmhq/<project>/providers.env` (0600), edited by the user. HQ publishes only which keys are present. At start, HQ writes `<agent>.provider.env` with just that agent's key and passes it to `sbx run --env-file`: **the key is a variable inside that agent's VM**. The sandbox (not the key) is the boundary for now.
- HQ adds the provider's `sandboxHosts` to the agent's allowed sites before its sandbox starts (rules for that sandbox only).
- OpenCode runs with `--auto` (approves its own tool calls) because the sandbox is the boundary.
- OpenCode can't continue a finished run from a plugin, so the plugin posts `Idle` (Stop without taking the queue) and the inbox types queued messages. `StopFailure` (OpenCode, and later Claude Code's hook) marks "needs you" with the error.
- HQ doesn't read OpenCode's screen (`reconcileFromScreen` is for Claude Code and Codex).
- HQ starts Claude agents with `CLAUDECODE` unset (an HQ started from a Claude Code terminal passes it on, and Claude Code then refuses to start).

### Not verified yet
- Cloud providers inside a sandbox (no valid key: the DeepSeek key was revoked). The sandbox sets placeholder `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` for sbx's proxy; whether a real key from `--env-file` wins over them needs a test with a real key.
- Claude Code and Codex with API keys inside a sandbox.

### Not done yet
- Keys through sbx's proxy (`sbx secret set <service> --sandbox <name>`) for Anthropic, OpenAI, Gemini, OpenRouter, so those keys never enter the VM. sbx 0.51 also wants a credential binding (`~/.config/sbx/credentials.yaml`) before it injects a key.
- Cost tracking and the 10 USD/office/day budget (P1): OpenCode's `session.step.ended` carries `cost`.
- Rate limits for subscriptions, "wait for reset" (P1).
