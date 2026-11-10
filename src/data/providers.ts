// Model providers an agent can use, and which coding CLIs can reach each one.
// Subscription = the CLI's own sign-in (Claude Pro/Max, ChatGPT). API key = a key
// the user puts in the office's provider keys file; HQ hands only the agent's own
// key to its session.

import type { AgentAuth, AgentCli } from "./types";

export const PROVIDERS = ["anthropic", "openai", "google", "deepseek", "openrouter", "ollama"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export interface ProviderInfo {
  label: string;
  /** Env var the key goes in (the provider keys file). null = no key (a local server). */
  keyVar: string | null;
  /** CLIs that can use this provider with an API key. */
  clis: AgentCli[];
  /** Hosts the agent's sandbox must reach that the "balanced" policy blocks. HQ allows them for that sandbox. */
  sandboxHosts?: string[];
  /** Anthropic-compatible endpoint, so Claude Code can run on it. */
  anthropicBaseUrl?: string;
  /** Suggested model ids (as the CLI expects them). */
  models: string[];
}

export const PROVIDER_INFO: Record<ProviderId, ProviderInfo> = {
  anthropic: { label: "Anthropic (Claude)", keyVar: "ANTHROPIC_API_KEY", clis: ["claude", "opencode"], models: ["opus", "sonnet", "haiku"] },
  openai: { label: "OpenAI (GPT)", keyVar: "OPENAI_API_KEY", clis: ["codex", "opencode"], models: [] },
  google: { label: "Google (Gemini)", keyVar: "GEMINI_API_KEY", clis: ["opencode"], models: ["gemini-2.5-pro", "gemini-2.5-flash"] },
  deepseek: {
    label: "DeepSeek",
    keyVar: "DEEPSEEK_API_KEY",
    clis: ["claude", "opencode"],
    anthropicBaseUrl: "https://api.deepseek.com/anthropic",
    sandboxHosts: ["api.deepseek.com"],
    models: ["deepseek-v4-pro", "deepseek-flash"],
  },
  openrouter: { label: "OpenRouter", keyVar: "OPENROUTER_API_KEY", clis: ["claude", "opencode"], anthropicBaseUrl: "https://openrouter.ai/api", sandboxHosts: ["openrouter.ai"], models: [] },
  // Ollama on this machine, reached from the sandbox through host.docker.internal (sbx checks it as localhost).
  ollama: { label: "Ollama (this machine)", keyVar: null, clis: ["opencode"], sandboxHosts: ["localhost:11434", "host.docker.internal:11434"], models: ["qwen3:8b"] },
};

/** The CLIs that sign in with a subscription, and the provider that subscription is for. */
export const SUBSCRIPTION_PROVIDER: Partial<Record<AgentCli, ProviderId>> = { claude: "anthropic", codex: "openai" };

export const providersFor = (cli: AgentCli): ProviderId[] => PROVIDERS.filter((p) => PROVIDER_INFO[p].clis.includes(cli));

/** A valid auth + provider for this CLI, keeping the current ones when they still fit. */
export function normalizeAuth(cli: AgentCli, auth: AgentAuth | undefined, provider: ProviderId | null | undefined): { auth: AgentAuth; provider: ProviderId } {
  const sub = SUBSCRIPTION_PROVIDER[cli];
  if (sub && auth !== "apiKey") return { auth: "subscription", provider: sub };
  const options = providersFor(cli);
  return { auth: "apiKey", provider: provider && options.includes(provider) ? provider : options[0] };
}

export const isProvider = (v: unknown): v is ProviderId => typeof v === "string" && (PROVIDERS as readonly string[]).includes(v);
