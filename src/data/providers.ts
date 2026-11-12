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
  /** Suggested model ids (as the CLI expects them). The fallback when the provider's own list can't be fetched. */
  models: string[];
  /** What an agent starts with when no model is chosen and the CLI has no default of its own (OpenCode). Defaults to models[0]. */
  defaultModel?: string;
}

export const PROVIDER_INFO: Record<ProviderId, ProviderInfo> = {
  // Sonnet, not Opus, when OpenCode has no model chosen: a forgotten setting shouldn't be the most expensive one.
  anthropic: { label: "Anthropic (Claude)", keyVar: "ANTHROPIC_API_KEY", clis: ["claude", "opencode"], models: ["opus", "sonnet", "haiku"], defaultModel: "sonnet" },
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

/**
 * Whether `model` is one of `list` (the provider's own model ids). Providers list dated ids ("claude-haiku-4-5-20251001",
 * "gpt-5-2025-08-07") but accept the short alias too, and Ollama lists "qwen3:8b" and accepts "qwen3": those count.
 */
export function modelListed(list: readonly string[], model: string): boolean {
  const m = model.trim().toLowerCase();
  return list.some((id) => {
    const l = id.toLowerCase();
    return l === m || l.startsWith(`${m}-`) || l === `${m}:latest` || l.startsWith(`${m}:`) || l === `models/${m}`;
  });
}

/** The provider's key can be kept by sbx's proxy instead of entering the agent's sandbox: sbx service name, by CLI and provider. */
const PROXY_SERVICE: Partial<Record<AgentCli, Partial<Record<ProviderId, string>>>> = {
  // Verified: a Claude Code sandbox with only an `anthropic` secret (no key variable) answers; on OpenRouter's Anthropic-compatible
  // endpoint with a placeholder token it answers with the stored key, and a wrong stored key makes it fail.
  claude: { anthropic: "anthropic", openrouter: "openrouter" },
  // Not turned on: OpenCode, which sbx treats as a third-party kit that needs an approved binding in
  // ~/.config/sbx/credentials.yaml before the proxy injects anything; and Codex + OpenAI, whose sbx sandbox is set up for the
  // ChatGPT sign-in (requests go to chatgpt.com, which refuses API keys), so Codex keeps the key as a variable.
};

/** The sbx secret service that carries this CLI's key for this provider, or null when the key goes in as a variable. */
export const proxyService = (cli: AgentCli, provider: ProviderId): string | null => PROXY_SERVICE[cli]?.[provider] ?? null;
