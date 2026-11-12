// The models each provider offers right now, asked of the provider itself (with the office's key, on this machine),
// so a new model shows up in the suggestions without a release of HQ, and a wrong model name is caught before an
// agent starts on it instead of when it dies. Lists are cached on disk; when a provider can't be reached (no key,
// offline, an error) HQ falls back to the short built-in list and never blocks on a list it doesn't have.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { modelListed, PROVIDER_INFO, PROVIDERS, type ProviderId } from "../src/data/providers";
import type { AgentConfig } from "../src/data/types";
import type { Hub } from "./hub";
import { log } from "./lib/log";
import { projectHome } from "./paths";

export const MODELS_TTL_MS = 6 * 3_600_000;
const FETCH_TIMEOUT_MS = 8000;

interface Endpoint {
  url: string;
  headers: (key: string) => Record<string, string>;
  /** Model ids, newest first. */
  parse: (json: unknown) => string[];
}

type Obj = Record<string, unknown>;
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Obj[]) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const byNewest = (field: string) => (a: Obj, b: Obj) => (Number(b[field]) || Date.parse(str(b[field])) || 0) - (Number(a[field]) || Date.parse(str(a[field])) || 0);

/** OpenAI's list has everything the key can call; keep what an agent can chat or code with. */
const OPENAI_NOT_CHAT = /embedding|whisper|tts|dall-e|image|audio|realtime|transcribe|moderation|search|computer-use|davinci|babbage|instruct$/i;

export const ENDPOINTS: Record<ProviderId, Endpoint> = {
  anthropic: {
    url: "https://api.anthropic.com/v1/models?limit=1000",
    headers: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
    parse: (j) => arr((j as Obj)?.data).sort(byNewest("created_at")).map((m) => str(m.id)).filter(Boolean),
  },
  openai: {
    url: "https://api.openai.com/v1/models",
    headers: (key) => ({ authorization: `Bearer ${key}` }),
    parse: (j) =>
      arr((j as Obj)?.data)
        .sort(byNewest("created"))
        .map((m) => str(m.id))
        .filter((id) => /^(gpt-|o\d|codex|chatgpt)/i.test(id) && !OPENAI_NOT_CHAT.test(id)),
  },
  google: {
    url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
    headers: (key) => ({ "x-goog-api-key": key }),
    parse: (j) =>
      arr((j as Obj)?.models)
        .filter((m) => !Array.isArray(m.supportedGenerationMethods) || (m.supportedGenerationMethods as unknown[]).includes("generateContent"))
        .map((m) => str(m.name).replace(/^models\//, ""))
        .filter((id) => /^gemini/i.test(id))
        .reverse(), // the API lists oldest first
  },
  deepseek: {
    url: "https://api.deepseek.com/models",
    headers: (key) => ({ authorization: `Bearer ${key}` }),
    parse: (j) => arr((j as Obj)?.data).map((m) => str(m.id)).filter(Boolean),
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/models", // public, no key needed
    headers: () => ({}),
    parse: (j) => arr((j as Obj)?.data).sort(byNewest("created")).map((m) => str(m.id)).filter(Boolean),
  },
  ollama: {
    url: "http://localhost:11434/api/tags",
    headers: () => ({}),
    parse: (j) => arr((j as Obj)?.models).map((m) => str(m.name)).filter(Boolean),
  },
};

export type FetchFn = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

interface Cached {
  at: number;
  models: string[];
}

export class ModelCatalog {
  private cache: Partial<Record<ProviderId, Cached>> = {};
  private inflight = new Map<ProviderId, Promise<void>>();
  private fetchFn: FetchFn;
  private endpoints: Record<ProviderId, Endpoint>;
  private now: () => number;
  private ttl: number;

  /**
   * `keyFor`: the office's key for a provider (null = none). Everything else is for tests: the HTTP call, the
   * endpoints, the clock, the cache file.
   */
  constructor(
    private hub: Hub,
    private keyFor: (p: ProviderId) => string | null,
    private opts: { fetch?: FetchFn; endpoints?: Partial<Record<ProviderId, Partial<Endpoint>>>; now?: () => number; ttlMs?: number; file?: string } = {},
  ) {
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.endpoints = { ...ENDPOINTS };
    for (const p of PROVIDERS) this.endpoints[p] = { ...ENDPOINTS[p], ...opts.endpoints?.[p] };
    this.now = opts.now ?? Date.now;
    this.ttl = opts.ttlMs ?? MODELS_TTL_MS;
    this.load();
  }

  get file() {
    return this.opts.file ?? join(projectHome(this.hub.slug), "models.json");
  }

  private load() {
    try {
      if (!existsSync(this.file)) return;
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, Cached>;
      for (const p of PROVIDERS) {
        const c = raw[p];
        if (c && Array.isArray(c.models) && typeof c.at === "number") this.cache[p] = { at: c.at, models: c.models.filter((m) => typeof m === "string") };
      }
    } catch {
      this.cache = {}; // a damaged cache is just asked for again
    }
  }

  private save() {
    try {
      writeFileSync(this.file, JSON.stringify(this.cache), { mode: 0o600 });
    } catch (err) {
      log.warn(`could not save the model lists: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** The provider's live list (newest first), or null when HQ has none. */
  list(p: ProviderId): string[] | null {
    return this.cache[p]?.models.length ? this.cache[p]!.models : null;
  }

  /** What the UI suggests: the live lists HQ has (a provider without one falls back to its built-in suggestions in the UI). */
  snapshot(): Partial<Record<ProviderId, string[]>> {
    const out: Partial<Record<ProviderId, string[]>> = {};
    for (const p of PROVIDERS) {
      const l = this.list(p);
      if (l) out[p] = l;
    }
    return out;
  }

  private publish() {
    const models = this.snapshot();
    if (JSON.stringify(this.hub.snap.models ?? {}) === JSON.stringify(models)) return;
    this.hub.snap.models = models;
    this.hub.emit({ type: "models.updated", models });
  }

  /** Providers HQ can ask: those with a key in the office's keys file, plus the ones that need none (OpenRouter's list is public, Ollama is local). */
  private askable(p: ProviderId): boolean {
    const info = PROVIDER_INFO[p];
    return !info.keyVar || p === "openrouter" || !!this.keyFor(p);
  }

  private stale(p: ProviderId): boolean {
    const c = this.cache[p];
    return !c || this.now() - c.at > this.ttl;
  }

  /** Asks one provider for its list. Never throws; on failure the older list (if any) stays. */
  private ask(p: ProviderId): Promise<void> {
    const running = this.inflight.get(p);
    if (running) return running;
    const job = (async () => {
      const ep = this.endpoints[p];
      const key = this.keyFor(p) ?? "";
      if (PROVIDER_INFO[p].keyVar && p !== "openrouter" && !key) return;
      try {
        const res = await this.fetchFn(ep.url, { headers: ep.headers(key), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) {
          log.info(`model list for ${p}: HTTP ${res.status}`);
          return;
        }
        const models = [...new Set(ep.parse(await res.json()))];
        if (models.length) this.cache[p] = { at: this.now(), models };
      } catch (err) {
        log.info(`model list for ${p} unavailable: ${err instanceof Error ? err.message : err}`);
      }
    })().finally(() => this.inflight.delete(p));
    this.inflight.set(p, job);
    return job;
  }

  /** Refreshes the lists that are missing or older than the TTL (all askable ones with `force`), then publishes. */
  async refresh(force = false) {
    await Promise.all(PROVIDERS.filter((p) => this.askable(p) && (force || this.stale(p))).map((p) => this.ask(p)));
    this.save();
    this.publish();
  }

  /**
   * The reason this agent's model can't be used, or null. Only an API-key agent with a model chosen is checked, and only
   * against a list the provider itself gave (asked again when the cached one is old). No list = no objection.
   */
  async problem(agent: Pick<AgentConfig, "auth" | "provider" | "model" | "name">): Promise<string | null> {
    const model = agent.model.trim();
    if (agent.auth !== "apiKey" || !model || /^default$/i.test(model)) return null;
    if (agent.provider === "anthropic" && /^(opus|sonnet|haiku)$/i.test(model)) return null; // Claude Code and HQ turn these into current ids
    if (this.askable(agent.provider) && this.stale(agent.provider)) {
      await this.ask(agent.provider);
      this.save();
      this.publish();
    }
    const list = this.list(agent.provider);
    if (!list || modelListed(list, model)) return null;
    const near = list.filter((id) => id.toLowerCase().includes(model.toLowerCase().split(/[-:/]/)[0])).slice(0, 4);
    const hint = near.length ? ` Similar: ${near.join(", ")}.` : list.length ? ` It offers, for example: ${list.slice(0, 4).join(", ")}.` : "";
    return `${PROVIDER_INFO[agent.provider].label} doesn't offer a model called "${model}".${hint} Change it in Settings → Team, then start ${agent.name} again.`;
  }

  /**
   * The newest Anthropic id of a family ("opus", "sonnet", "haiku") that the live list has, for OpenCode, which doesn't know
   * Claude Code's short names. null when HQ has no live list or the family isn't in it.
   */
  latestClaude(family: string): string | null {
    const prefix = `claude-${family.toLowerCase()}-`;
    return this.list("anthropic")?.find((id) => id.toLowerCase().startsWith(prefix)) ?? null;
  }
}
