// The office's provider keys: one env file (0600) in HQ's home that the user edits.
// HQ reports only which providers have a key. At launch it writes a per-agent env
// file with just that agent's key, so an agent never sees the other providers' keys.

import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROVIDER_INFO, PROVIDERS, proxyService, type ProviderId } from "../src/data/providers";
import type { AgentConfig } from "../src/data/types";
import type { Hub } from "./hub";
import { run as runCommand, type RunResult } from "./lib/exec";
import { log } from "./lib/log";
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

  /** The key for a provider, or null. For HQ's own calls on this machine (model lists, sbx's proxy); never sent to the UI. */
  keyFor(p: ProviderId): string | null {
    const v = PROVIDER_INFO[p].keyVar;
    return (v && this.read().get(v)?.trim()) || null;
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
    const before = this.hub.snap.providerKeys;
    this.hub.snap.providerKeys = providers;
    this.hub.emit({ type: "providerKeys.updated", providers });
    if (before) this.onChange(); // not the first look: a key was added or removed
  }

  /** Called when the set of providers with a key changes (main refreshes the model lists). */
  onChange: () => void = () => {};

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
    // When sbx's proxy holds the key (ProxyKeys), the sandbox gets a placeholder where the CLI insists on one, never the key.
    const viaProxy = !!proxyService(agent.cli, agent.provider);
    if (agent.cli === "claude") {
      if (info.anthropicBaseUrl) {
        // Claude Code on an Anthropic-compatible endpoint (DeepSeek, OpenRouter).
        env.ANTHROPIC_BASE_URL = info.anthropicBaseUrl;
        env.ANTHROPIC_AUTH_TOKEN = viaProxy ? "proxy-managed" : key!;
        env.ANTHROPIC_API_KEY = "";
        if (agent.model.trim()) env.ANTHROPIC_MODEL = env.ANTHROPIC_SMALL_FAST_MODEL = agent.model.trim();
      } else if (!viaProxy) env.ANTHROPIC_API_KEY = key!;
    } else if (info.keyVar && !viaProxy) env[info.keyVar] = key!;
    if (!Object.keys(env).length) return null;
    writeFileSync(file, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
    return file;
  }
}

type Runner = (cmd: string, args: string[], opts?: { timeoutMs?: number; input?: string }) => Promise<RunResult>;

/**
 * Keeps an agent's key with sbx instead of in its sandbox. `sbx secret set <service> --sandbox <name>` stores it on this
 * machine and sbx's proxy adds it to the agent's requests to that provider; inside the sandbox there is no key to read,
 * print or leak. HQ sets it every time the agent starts (so a changed key applies) and takes back what it set when the
 * agent no longer needs it (switched to a subscription, another provider, or its sandbox was removed): a stale
 * sandbox secret would keep an agent on the API key, and billing, after the user thought it was on a subscription.
 * Only secrets HQ set are ever removed (kept in proxy-keys.json); a key the user stored for a sandbox by hand stays.
 */
export class ProxyKeys {
  private owned: Record<string, string[]> = {};
  private chain: Promise<unknown> = Promise.resolve();
  private run: Runner;

  constructor(private hub: Hub, private keys: Pick<ProviderKeys, "keyFor">, private sandboxName: (agentId: string) => string, opts: { run?: Runner; file?: string } = {}) {
    this.run = opts.run ?? ((cmd, args, o) => runCommand(cmd, args, o));
    this.fileOverride = opts.file;
    try {
      if (existsSync(this.file)) this.owned = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      this.owned = {};
    }
  }

  private fileOverride?: string;
  private get file() {
    return this.fileOverride ?? join(projectHome(this.hub.slug), "proxy-keys.json");
  }

  private save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.owned), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** One at a time, in the order asked: a removal asked before a set must not land after it. */
  private queued<T>(job: () => Promise<T>): Promise<T> {
    const next = this.chain.then(job, job);
    this.chain = next.catch(() => {});
    return next;
  }

  private async remove(name: string, service: string) {
    const r = await this.run("sbx", ["secret", "rm", service, "--sandbox", name, "--force"], { timeoutMs: 20_000 });
    if (!r.ok && !/not found|no such|does not exist/i.test(r.stderr)) log.warn(`could not remove the ${service} secret of ${name}: ${r.stderr.trim().split("\n")[0]}`);
  }

  /** Before the agent's sandbox starts: gives it the key it needs, takes back what it doesn't. Throws when the key can't be stored. */
  sync(agent: AgentConfig): Promise<void> {
    return this.queued(async () => {
      const name = this.sandboxName(agent.id);
      const want = agent.auth === "apiKey" ? proxyService(agent.cli, agent.provider) : null;
      const have = this.owned[name] ?? [];
      for (const service of have.filter((s) => s !== want)) await this.remove(name, service);
      let keep = have.filter((s) => s === want);
      if (want) {
        const key = this.keys.keyFor(agent.provider);
        if (!key) throw new Error(`No ${PROVIDER_INFO[agent.provider].label} key. Add ${PROVIDER_INFO[agent.provider].keyVar} in Settings → Team → Provider keys, then start ${agent.name} again.`);
        const r = await this.run("sbx", ["secret", "set", want, "--sandbox", name, "--force"], { timeoutMs: 20_000, input: key + "\n" });
        if (!r.ok) throw new Error(`Could not store ${agent.name}'s ${PROVIDER_INFO[agent.provider].label} key in sbx: ${r.stderr.trim().split("\n")[0] || "sbx secret set failed"}`);
        keep = [want];
      }
      if (keep.length) this.owned[name] = keep;
      else delete this.owned[name];
      this.save();
    });
  }

  /** The agent's sandbox is gone: take back the keys HQ gave it. */
  release(agentId: string): Promise<void> {
    return this.queued(async () => {
      const name = this.sandboxName(agentId);
      for (const service of this.owned[name] ?? []) await this.remove(name, service);
      delete this.owned[name];
      this.save();
    });
  }
}
