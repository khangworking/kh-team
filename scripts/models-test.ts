// Model lists from the providers, the check before an agent starts, OpenCode's model ids, and keys kept by sbx's proxy.
//
//   npx tsx scripts/models-test.ts

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Files go in a scratch home, not the real ~/.jsmhq.
const home = mkdtempSync(join(tmpdir(), "hq-models-"));
Object.assign(process.env, { HOME: home, USERPROFILE: home });

const { ENDPOINTS, ModelCatalog } = await import("../server/modelCatalog");
const { ProviderKeys, ProxyKeys } = await import("../server/providerKeys");
const { opencodeModel, opencodeConfig } = await import("../server/adapters");
const { modelListed, proxyService, PROVIDER_INFO } = await import("../src/data/providers");

type Agent = { id: string; name: string; cli: "claude" | "codex" | "opencode"; auth: "subscription" | "apiKey"; provider: "anthropic" | "openai" | "google" | "deepseek" | "openrouter" | "ollama"; model: string };
const agent = (o: Partial<Agent> = {}): Agent => ({ id: "kevin", name: "Kevin", cli: "claude", auth: "apiKey", provider: "anthropic", model: "", ...o });

// ---------------------------------------------------------------- what each provider's answer is turned into
{
  const anthropic = { data: [{ id: "claude-old-1", created_at: "2025-01-01T00:00:00Z" }, { id: "claude-opus-5-5", created_at: "2026-10-01T00:00:00Z" }, { id: "claude-haiku-4-5-20251001", created_at: "2025-10-01T00:00:00Z" }] };
  assert.deepEqual(ENDPOINTS.anthropic.parse(anthropic), ["claude-opus-5-5", "claude-haiku-4-5-20251001", "claude-old-1"], "newest first");
  assert.deepEqual(ENDPOINTS.anthropic.headers("k"), { "x-api-key": "k", "anthropic-version": "2023-06-01" });

  const openai = { data: [{ id: "text-embedding-3-small", created: 5 }, { id: "gpt-5.6-sol", created: 30 }, { id: "whisper-1", created: 1 }, { id: "o4-mini", created: 20 }, { id: "gpt-image-1", created: 9 }, { id: "gpt-5", created: 10 }] };
  assert.deepEqual(ENDPOINTS.openai.parse(openai), ["gpt-5.6-sol", "o4-mini", "gpt-5"], "chat models only, newest first");

  const google = { models: [{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }, { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] }, { name: "models/gemini-3-pro", supportedGenerationMethods: ["generateContent"] }] };
  assert.deepEqual(ENDPOINTS.google.parse(google), ["gemini-3-pro", "gemini-2.5-flash"], "the prefix is dropped, newest (listed last) first");

  assert.deepEqual(ENDPOINTS.deepseek.parse({ data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-flash" }] }), ["deepseek-v4-pro", "deepseek-flash"]);
  assert.deepEqual(ENDPOINTS.openrouter.parse({ data: [{ id: "a/old", created: 1 }, { id: "b/new", created: 2 }] }), ["b/new", "a/old"]);
  assert.deepEqual(ENDPOINTS.ollama.parse({ models: [{ name: "qwen3:8b" }, { name: "llama3.2:latest" }] }), ["qwen3:8b", "llama3.2:latest"]);
  for (const p of Object.keys(ENDPOINTS) as (keyof typeof ENDPOINTS)[]) assert.deepEqual(ENDPOINTS[p].parse(null), [], `${p}: a strange answer gives nothing`);
}

// ---------------------------------------------------------------- matching a model against a list
{
  const list = ["claude-opus-5-5", "claude-haiku-4-5-20251001", "qwen3:8b", "gpt-5-2025-08-07"];
  assert.ok(modelListed(list, "claude-opus-5-5"));
  assert.ok(modelListed(list, "claude-haiku-4-5"), "the short name of a dated id");
  assert.ok(modelListed(list, "CLAUDE-OPUS-5-5"), "case does not matter");
  assert.ok(modelListed(list, "qwen3"), "Ollama accepts the name without its tag");
  assert.ok(modelListed(list, "gpt-5"));
  assert.ok(!modelListed(list, "claude-opus-9"));
  assert.ok(!modelListed(list, "opus"), "a Claude Code alias is not an id (it is handled before this check)");
  assert.ok(!modelListed(list, "laude-haiku-4-5"), "a prefix only counts at a dash: no half words");
  assert.ok(!modelListed(list, "claude-opus-5-55"), "a different version is a different model");
}

// ---------------------------------------------------------------- the catalog
const keysPresent: Record<string, string | null> = { anthropic: "sk-ant-test", openai: null, google: null, deepseek: null };
const keyFor = (p: string) => keysPresent[p] ?? null;
const hubOf = (slug: string) => {
  const events: { type: string }[] = [];
  return { events, hub: { slug, snap: {} as { models?: unknown }, emit: (e: { type: string }) => events.push(e) } };
};
const answers: Record<string, unknown> = {
  "https://api.anthropic.com/v1/models?limit=1000": { data: [{ id: "claude-sonnet-5-5", created_at: "2026-09-01T00:00:00Z" }, { id: "claude-opus-5-5", created_at: "2026-10-01T00:00:00Z" }, { id: "claude-haiku-4-5-20251001", created_at: "2025-10-01T00:00:00Z" }] },
  "https://openrouter.ai/api/v1/models": { data: [{ id: "x-ai/grok-9", created: 3 }, { id: "anthropic/claude-opus-5-5", created: 2 }] },
  "http://localhost:11434/api/tags": { models: [{ name: "qwen3:8b" }] },
};
const calls: { url: string; headers: Record<string, string> }[] = [];
let down = false;
const fakeFetch = async (url: string, init: { headers: Record<string, string> }) => {
  calls.push({ url, headers: init.headers });
  if (down) throw new Error("offline");
  const a = answers[url];
  return { ok: !!a, status: a ? 200 : 404, json: async () => a };
};
let clock = 1_000_000;
const cacheFile = join(home, "models.json");
const make = (slug: string, file = cacheFile) => {
  const h = hubOf(slug);
  const catalog = new ModelCatalog(h.hub as never, keyFor as never, { fetch: fakeFetch as never, now: () => clock, ttlMs: 1000, file });
  return { ...h, catalog };
};

{
  const { catalog, hub, events } = make("m1");
  await catalog.refresh();
  assert.deepEqual(catalog.list("anthropic"), ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001"]);
  assert.equal(calls.find((c) => c.url.includes("anthropic"))?.headers["x-api-key"], "sk-ant-test", "asked with the office's key");
  assert.ok(!calls.some((c) => c.url.includes("openai") || c.url.includes("googleapis") || c.url.includes("deepseek")), "providers without a key are not asked");
  assert.ok(calls.some((c) => c.url.includes("openrouter")), "OpenRouter's list is public");
  assert.deepEqual(catalog.list("openrouter"), ["x-ai/grok-9", "anthropic/claude-opus-5-5"]);
  assert.equal(catalog.list("openai"), null, "no key, no list");
  assert.deepEqual(Object.keys((hub.snap.models ?? {}) as object).sort(), ["anthropic", "ollama", "openrouter"]);
  assert.equal(events.filter((e) => e.type === "models.updated").length, 1);
  assert.ok(existsSync(cacheFile), "saved");

  // Nothing changed: not asked again within the TTL, nothing announced.
  const n = calls.length;
  await catalog.refresh();
  assert.equal(calls.length, n);
  assert.equal(events.filter((e) => e.type === "models.updated").length, 1);

  // After the TTL it is asked again; a provider that fails keeps its older list.
  clock += 5000;
  down = true;
  await catalog.refresh();
  assert.ok(calls.length > n, "asked again");
  assert.deepEqual(catalog.list("anthropic"), ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001"], "offline: the old list stays");
  down = false;

  // A restart reads the lists from disk without asking.
  const before = calls.length;
  const again = make("m1b");
  assert.deepEqual(again.catalog.list("anthropic"), catalog.list("anthropic"));
  assert.equal(calls.length, before);

  // The newest id of a Claude family.
  assert.equal(catalog.latestClaude("opus"), "claude-opus-5-5");
  assert.equal(catalog.latestClaude("haiku"), "claude-haiku-4-5-20251001");
  assert.equal(catalog.latestClaude("mythos"), null);
}

// A damaged cache file is just asked for again.
{
  const bad = join(home, "bad-models.json");
  writeFileSync(bad, "{not json");
  const { catalog } = make("m2", bad);
  assert.equal(catalog.list("anthropic"), null);
  await catalog.refresh();
  assert.ok(catalog.list("anthropic"));
}

// A forced refresh (a key was added) asks even a fresh list again.
{
  const { catalog } = make("m3", join(home, "m3.json"));
  await catalog.refresh();
  const n = calls.length;
  await catalog.refresh(true);
  assert.ok(calls.length > n);
}

// ---------------------------------------------------------------- the check before an agent starts
{
  const { catalog } = make("m4", join(home, "m4.json"));
  await catalog.refresh();
  const problem = (a: Agent) => catalog.problem(a as never);
  assert.equal(await problem(agent({ model: "claude-opus-5-5" })), null, "an id the provider lists");
  assert.equal(await problem(agent({ model: "claude-haiku-4-5" })), null, "its short name");
  assert.equal(await problem(agent({ model: "" })), null, "no model chosen");
  assert.equal(await problem(agent({ model: "default" })), null);
  assert.equal(await problem(agent({ model: "Opus" })), null, "Claude Code's own names");
  assert.equal(await problem(agent({ model: "claude-opus-9" })) !== null, true, "an id the provider doesn't have");
  const msg = (await problem(agent({ name: "Kevin", model: "claude-opus-9" })))!;
  assert.match(msg, /Anthropic \(Claude\) doesn't offer a model called "claude-opus-9"/);
  assert.match(msg, /claude-opus-5-5/, "names models it does offer");
  assert.match(msg, /start Kevin again/);
  assert.equal(await problem(agent({ auth: "subscription", model: "whatever-5" })), null, "a subscription has no list to check against");
  assert.equal(await problem(agent({ provider: "openai", cli: "codex", model: "gpt-nothing" })), null, "no list for a provider without a key");
  assert.equal(await problem(agent({ provider: "ollama", cli: "opencode", model: "qwen3" })), null, "Ollama's tag is optional");
  assert.notEqual(await problem(agent({ provider: "ollama", cli: "opencode", model: "nope:1b" })), null);
  assert.equal(await problem(agent({ provider: "openrouter", cli: "claude", model: "anthropic/claude-opus-5-5" })), null);

  // Offline with nothing cached: no objection (HQ never blocks on a list it doesn't have).
  down = true;
  clock += 10_000;
  const empty = make("m5", join(home, "m5.json"));
  assert.equal(await empty.catalog.problem(agent({ model: "claude-opus-9" }) as never), null);
  down = false;
}

// ---------------------------------------------------------------- OpenCode's model ids
{
  const latest = (f: string) => (f === "opus" ? "claude-opus-6" : null);
  assert.equal(opencodeModel({ provider: "anthropic", model: "opus" }, latest), "claude-opus-6", "the newest the provider lists");
  assert.equal(opencodeModel({ provider: "anthropic", model: "opus" }), "claude-opus-5-5", "no list: the built-in id");
  assert.equal(opencodeModel({ provider: "anthropic", model: "haiku" }, latest), "claude-haiku-5-5", "family not in the list: the built-in id");
  assert.equal(opencodeModel({ provider: "anthropic", model: "claude-opus-4-1" }, latest), "claude-opus-4-1", "a full id is kept");
  assert.equal(opencodeModel({ provider: "anthropic", model: "" }), "claude-sonnet-5-5", "no model chosen: Sonnet, not the dearest");
  assert.equal(PROVIDER_INFO.anthropic.defaultModel, "sonnet");
  assert.equal(opencodeModel({ provider: "deepseek", model: "" }), "deepseek-v4-pro");
  assert.equal(opencodeModel({ provider: "openai", model: "" }), "");
  const cfg = opencodeConfig({ ...agent({ cli: "opencode", model: "opus" }), sandbox: {} } as never, { project: { hqPort: 7420 } } as never, "t", "/x", latest);
  assert.equal(cfg.model, "anthropic/claude-opus-6");
}

// ---------------------------------------------------------------- keys kept by sbx's proxy
{
  assert.equal(proxyService("claude", "anthropic"), "anthropic");
  assert.equal(proxyService("claude", "deepseek"), null, "DeepSeek has no sbx service: its key stays a variable");
  assert.equal(proxyService("opencode", "anthropic"), null, "OpenCode needs an approved binding in sbx first");
  assert.equal(proxyService("codex", "openai"), null);

  const hub = { slug: "proxy", snap: {}, emit() {}, cfg: () => undefined } as never;
  const keyFile = join(home, ".jsmhq", "proxy", "providers.env");
  const keys = new ProviderKeys(hub);
  keys.ensureFile();
  writeFileSync(keyFile, "ANTHROPIC_API_KEY=sk-ant-live\nDEEPSEEK_API_KEY=sk-ds-live\nOPENAI_API_KEY=\n");
  assert.equal(keys.keyFor("anthropic"), "sk-ant-live");
  assert.equal(keys.keyFor("openai"), null);
  assert.equal(keys.keyFor("ollama"), null);

  // The key of an agent whose key sbx holds is not written for its sandbox; other agents still get theirs.
  assert.equal(keys.launchEnv(agent() as never), null, "Claude + Anthropic key: nothing enters the sandbox");
  const dsEnv = keys.launchEnv(agent({ id: "ds", provider: "deepseek", model: "deepseek-v4-pro" }) as never)!;
  assert.match(readFileSync(dsEnv, "utf8"), /ANTHROPIC_AUTH_TOKEN=sk-ds-live/);
  const ocEnv = keys.launchEnv(agent({ id: "oc", cli: "opencode" }) as never)!;
  assert.match(readFileSync(ocEnv, "utf8"), /ANTHROPIC_API_KEY=sk-ant-live/);
  assert.throws(() => keys.launchEnv(agent({ id: "x", provider: "openai", cli: "codex" }) as never), /No OpenAI/);

  const ran: { args: string[]; input?: string }[] = [];
  let fail = false;
  let pause: Promise<void> | null = null;
  const fakeRun = async (_cmd: string, args: string[], o?: { input?: string }) => {
    if (pause) await pause;
    ran.push({ args, input: o?.input });
    return fail ? { ok: false, code: 1, stdout: "", stderr: "boom\nmore" } : { ok: true, code: 0, stdout: "", stderr: "" };
  };
  const stateFile = join(home, "proxy-keys.json");
  const proxy = new ProxyKeys(hub, keys, (id) => `hq-proxy-${id}`, { run: fakeRun, file: stateFile });

  await proxy.sync(agent() as never);
  assert.deepEqual(ran[0].args, ["secret", "set", "anthropic", "--sandbox", "hq-proxy-kevin", "--force"]);
  assert.equal(ran[0].input, "sk-ant-live\n", "the key goes in on stdin, not on the command line");
  assert.ok(!ran[0].args.join(" ").includes("sk-ant"));
  assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), { "hq-proxy-kevin": ["anthropic"] });
  if (process.platform !== "win32") assert.equal(statSync(stateFile).mode & 0o077, 0, "the state file is private");

  // Every start sets it again (a changed key applies).
  ran.length = 0;
  await proxy.sync(agent() as never);
  assert.equal(ran.length, 1);

  // An agent that doesn't use the proxy: nothing is set, and nothing HQ did not set is removed.
  ran.length = 0;
  await proxy.sync(agent({ id: "ds", provider: "deepseek" }) as never);
  await proxy.sync(agent({ id: "sub", auth: "subscription" }) as never);
  assert.equal(ran.length, 0);

  // Back to a subscription: the key HQ gave is taken back, or the agent would stay on (and bill) the API key.
  await proxy.sync(agent({ auth: "subscription" }) as never);
  assert.deepEqual(ran.map((r) => r.args), [["secret", "rm", "anthropic", "--sandbox", "hq-proxy-kevin", "--force"]]);
  assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), {});

  // The sandbox goes: its key goes.
  await proxy.sync(agent() as never);
  ran.length = 0;
  await proxy.release("kevin");
  assert.deepEqual(ran.map((r) => r.args[1]), ["rm"]);
  ran.length = 0;
  await proxy.release("kevin");
  assert.equal(ran.length, 0, "nothing left to take back");

  // A restart remembers what HQ set.
  await proxy.sync(agent() as never);
  const reborn = new ProxyKeys(hub, keys, (id) => `hq-proxy-${id}`, { run: fakeRun, file: stateFile });
  ran.length = 0;
  await reborn.sync(agent({ auth: "subscription" }) as never);
  assert.equal(ran.length, 1);

  // Failures: sbx refuses → the start fails with sbx's first line; no key → the same advice as for any provider.
  fail = true;
  await assert.rejects(proxy.sync(agent() as never), /Could not store Kevin's Anthropic \(Claude\) key in sbx: boom$/);
  fail = false;
  writeFileSync(keyFile, "ANTHROPIC_API_KEY=\n");
  await assert.rejects(proxy.sync(agent() as never), /No Anthropic \(Claude\) key/);
  writeFileSync(keyFile, "ANTHROPIC_API_KEY=sk-ant-live\n");

  // Order: a removal asked first never lands after a later set (a replaced sandbox is removed, then started again).
  await proxy.sync(agent() as never);
  ran.length = 0;
  let open!: () => void;
  pause = new Promise((r) => (open = r));
  const first = proxy.release("kevin");
  const second = proxy.sync(agent() as never);
  open();
  pause = null;
  await Promise.all([first, second]);
  assert.deepEqual(ran.map((r) => r.args[1]), ["rm", "set"]);
}

console.log("models: ok");
