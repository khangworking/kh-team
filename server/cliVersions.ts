// Which version of its coding CLI each agent's sandbox runs, and the newest one published, so the user can see
// which agents are behind. The CLI lives in the sandbox image and stays at the version it had when the sandbox was
// created, so this only reads: it asks `sbx exec <sandbox> <cli> --version` of the sandboxes that are running
// (never starts one) and asks npm for each CLI's newest release. What it found last time is kept on disk, so an
// agent that is stopped still shows what its sandbox has.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NPM_PACKAGE, parseVersion, type CliVersionInfo } from "../src/data/cliVersions";
import type { AgentCli } from "../src/data/types";
import type { Hub } from "./hub";
import { run as runCommand, type RunResult } from "./lib/exec";
import { sandboxList } from "./lib/json";
import { log } from "./lib/log";
import { projectHome, sessionName } from "./paths";

export const LATEST_TTL_MS = 6 * 3_600_000;
const FETCH_TIMEOUT_MS = 8000;

type Runner = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<RunResult>;
export type VersionFetch = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

interface Seen {
  cli: AgentCli;
  version: string;
  at: string;
}

export class CliVersions {
  private seen: Record<string, Seen> = {}; // agent id → what its sandbox had when last read
  private latest: Partial<Record<AgentCli, { version: string; at: number }>> = {};
  private run: Runner;
  private fetchFn: VersionFetch;
  private now: () => number;
  private busy = false;
  private again: { only?: string[]; force?: boolean } | null = null; // asked while busy

  /** Everything after `hub` is for tests: the command runner, the HTTP call, the clock, the state file. */
  constructor(private hub: Hub, private opts: { run?: Runner; fetch?: VersionFetch; now?: () => number; file?: string } = {}) {
    this.run = opts.run ?? ((cmd, args, o) => runCommand(cmd, args, o));
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? Date.now;
    try {
      if (existsSync(this.file)) this.seen = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      this.seen = {};
    }
  }

  get file() {
    return this.opts.file ?? join(projectHome(this.hub.slug), "cli-versions.json");
  }

  private save() {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.seen), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      log.warn(`could not save the CLI versions: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** What the UI shows, one entry per agent in the team. */
  info(): Record<string, CliVersionInfo> {
    const out: Record<string, CliVersionInfo> = {};
    for (const a of this.hub.snap.config.team) {
      const s = this.seen[a.id];
      const same = s && s.cli === a.cli; // after the agent's CLI changed, its old sandbox's version means nothing
      out[a.id] = { cli: a.cli, installed: same ? s.version : null, latest: this.latest[a.cli]?.version ?? null, checkedAt: same ? s.at : null };
    }
    return out;
  }

  private publish() {
    const cliVersions = this.info();
    if (JSON.stringify(this.hub.snap.cliVersions ?? {}) === JSON.stringify(cliVersions)) return;
    this.hub.snap.cliVersions = cliVersions;
    this.hub.emit({ type: "cliVersions.updated", cliVersions });
  }

  /** Asks npm for the newest release of each CLI an agent uses (once per TTL). Never throws. */
  private async askLatest(force: boolean) {
    const clis = [...new Set(this.hub.snap.config.team.map((a) => a.cli))];
    await Promise.all(
      clis.map(async (cli) => {
        const have = this.latest[cli];
        if (!force && have && this.now() - have.at < LATEST_TTL_MS) return;
        try {
          const res = await this.fetchFn(`https://registry.npmjs.org/${NPM_PACKAGE[cli]}/latest`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
          if (!res.ok) return;
          const v = parseVersion(String(((await res.json()) as { version?: unknown })?.version ?? ""));
          if (v) this.latest[cli] = { version: v, at: this.now() };
        } catch (err) {
          log.info(`latest ${cli} version unavailable: ${err instanceof Error ? err.message : err}`);
        }
      }),
    );
  }

  /** Reads the version in the sandboxes of `only` (default: every agent) that are running now. */
  private async readInstalled(only?: string[]) {
    const ls = await this.run("sbx", ["ls", "--json"], { timeoutMs: 10_000 });
    const boxes = ls.ok ? sandboxList<{ name: string; status?: string }>(ls.stdout) : null;
    if (!boxes) return;
    const running = new Set(boxes.filter((b) => b.status === "running").map((b) => b.name));
    for (const a of this.hub.snap.config.team) {
      if (only && !only.includes(a.id)) continue;
      const name = sessionName(this.hub.slug, a.id);
      if (!running.has(name)) continue;
      const r = await this.run("sbx", ["exec", name, a.cli, "--version"], { timeoutMs: 20_000 });
      const version = r.ok ? parseVersion(r.stdout) : null;
      if (version) this.seen[a.id] = { cli: a.cli, version, at: new Date(this.now()).toISOString() };
    }
    this.save();
  }

  /** Looks again. `only`: agent ids whose sandbox just started. `force`: ask npm even if its answer is fresh. One at a time. */
  async check(opts: { only?: string[]; force?: boolean } = {}) {
    if (this.busy) {
      // Remember what was asked: everything (no `only`) wins over a few agents, and the lists add up.
      const was = this.again;
      const all = !opts.only || (!!was && !was.only);
      this.again = { force: !!(was?.force || opts.force), only: all ? undefined : [...(was?.only ?? []), ...opts.only!] };
      return;
    }
    this.busy = true;
    try {
      await Promise.all([this.askLatest(!!opts.force), this.readInstalled(opts.only)]);
    } finally {
      this.busy = false;
      this.publish();
      const next = this.again;
      this.again = null;
      if (next) await this.check(next);
    }
  }
}
