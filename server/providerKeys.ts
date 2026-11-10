// The office's provider keys: one env file (0600) in HQ's home that the user edits.
// HQ reports only which providers have a key. At launch it writes a per-agent env
// file with just that agent's key, so an agent never sees the other providers' keys.

import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROVIDER_INFO, PROVIDERS, type ProviderId } from "../src/data/providers";
import type { AgentConfig } from "../src/data/types";
import type { Hub } from "./hub";
import { projectHome } from "./paths";

const TEMPLATE = [
  "# Provider API keys for this office (kept on this machine, never committed).",
  "# Fill in the ones your API-key agents use. Each agent only gets its own provider's key.",
  ...PROVIDERS.flatMap((p) => (PROVIDER_INFO[p].keyVar ? [`${PROVIDER_INFO[p].keyVar}=`] : [])),
  "",
].join("\n");

/** KEY=value lines, like the loader in backends/tmux.ts: no expansion, comments skipped. */
function parse(text: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const eq = line.indexOf("=");
    if (line.startsWith("#") || eq < 1) continue;
    vars.set(line.slice(0, eq).trim(), line.slice(eq + 1));
  }
  return vars;
}

export class ProviderKeys {
  constructor(private hub: Hub) {}

  get file() {
    return join(projectHome(this.hub.slug), "providers.env");
  }

  private launchFile(agentId: string) {
    return join(projectHome(this.hub.slug), `${agentId}.provider.env`);
  }

  ensureFile(): string {
    if (!existsSync(this.file)) writeFileSync(this.file, TEMPLATE, { mode: 0o600 });
    chmodSync(this.file, 0o600);
    return this.file;
  }

  private read(): Map<string, string> {
    return existsSync(this.file) ? parse(readFileSync(this.file, "utf8")) : new Map();
  }

  /** Providers that have a non-empty key (Ollama needs none). */
  present(): ProviderId[] {
    const vars = this.read();
    return PROVIDERS.filter((p) => {
      const v = PROVIDER_INFO[p].keyVar;
      return !v || !!vars.get(v)?.trim();
    });
  }

  /** Sends the list when it changed (the user edits the file in their own editor, so HQ checks it now and then). */
  publish() {
    const providers = this.present();
    if (this.hub.snap.providerKeys?.join() === providers.join()) return;
    this.hub.snap.providerKeys = providers;
    this.hub.emit({ type: "providerKeys.updated", providers });
  }

  /**
   * The env file an API-key agent starts with: its provider's key, plus what its CLI needs to reach
   * that provider. null for subscription agents (they use the CLI's own sign-in). Throws when the key is missing.
   */
  launchEnv(agent: AgentConfig): string | null {
    const file = this.launchFile(agent.id);
    rmSync(file, { force: true });
    if (agent.auth !== "apiKey") return null;
    const info = PROVIDER_INFO[agent.provider];
    const key = info.keyVar ? this.read().get(info.keyVar)?.trim() : "";
    if (info.keyVar && !key) throw new Error(`No ${info.label} key. Add ${info.keyVar} in Settings → Team → Provider keys, then start ${agent.name} again.`);
    const env: Record<string, string> = {};
    if (agent.cli === "claude") {
      if (info.anthropicBaseUrl) {
        // Claude Code on an Anthropic-compatible endpoint (DeepSeek, OpenRouter).
        env.ANTHROPIC_BASE_URL = info.anthropicBaseUrl;
        env.ANTHROPIC_AUTH_TOKEN = key!;
        env.ANTHROPIC_API_KEY = "";
        if (agent.model.trim()) env.ANTHROPIC_MODEL = env.ANTHROPIC_SMALL_FAST_MODEL = agent.model.trim();
      } else env.ANTHROPIC_API_KEY = key!;
    } else if (info.keyVar) env[info.keyVar] = key!;
    writeFileSync(file, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
    return file;
  }
}
