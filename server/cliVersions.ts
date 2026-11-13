// Which version of its coding CLI each agent's sandbox runs, and the newest one published, so the user can see
// which agents are behind. The CLI lives in the sandbox image and stays at the version it had when the sandbox was
// created, so this only reads: it asks `sbx exec <sandbox> <cli> --version` of the sandboxes that are running
// (never starts one) and asks npm for each CLI's newest release. What it found last time is kept on disk, so an
// agent that is stopped still shows what its sandbox has. `upgrade` installs the newest release into one agent's
// running sandbox (below, per CLI).

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliLine, cliNeedsInstall, cliTarget, cliVersionState, NPM_PACKAGE, parseVersion, type CliLine, type CliVersionInfo } from "../src/data/cliVersions";
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

/** Where the newest release of each line is published. OpenCode 2 has its own feed: npm's "latest" for it is still 1.x. */
const LATEST_URL: Record<CliLine, string> = {
  claude: `https://registry.npmjs.org/${NPM_PACKAGE.claude}/latest`,
  codex: `https://registry.npmjs.org/${NPM_PACKAGE.codex}/latest`,
  opencode: `https://registry.npmjs.org/${NPM_PACKAGE.opencode}/latest`,
  opencode2: "https://opencode.ai/update/api/latest/cli/npm",
};

/**
 * Installs the release of Codex `$1` for this machine's architecture into the agent user's home. It has to be the whole
 * "package" (the binary, its exec server and code-mode host, bwrap, ripgrep, voice): a lone binary answers `--version` and
 * runs `codex exec`, but the interactive start fails with "no complete local package". The package goes in
 * ~/.local/share/codex/<version>/ and ~/.local/bin/codex (which comes before /usr/local/bin in the sandbox's PATH) is pointed
 * at it in one step, so a running Codex isn't disturbed. `codex update` can't tell how the sandbox's Codex was installed, and
 * /opt/codex belongs to root. Versions older than the one being replaced are removed; the one in use is kept.
 */
export const CODEX_INSTALL = `set -e
v="$1"
case "$(uname -m)" in aarch64|arm64) t=aarch64-unknown-linux-musl;; x86_64|amd64) t=x86_64-unknown-linux-musl;; *) echo "unsupported architecture $(uname -m)" >&2; exit 1;; esac
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT
curl -fsSL --max-time 600 -o "$d/codex.tgz" "https://github.com/openai/codex/releases/download/rust-v$v/codex-package-$t.tar.gz"
root="$HOME/.local/share/codex"
prev=$(readlink "$HOME/.local/bin/codex" 2>/dev/null || true)
rm -rf "$root/$v.new"; mkdir -p "$root/$v.new"
tar xzf "$d/codex.tgz" -C "$root/$v.new"
test -x "$root/$v.new/bin/codex"
rm -rf "$root/$v"; mv "$root/$v.new" "$root/$v"
mkdir -p "$HOME/.local/bin"
ln -sfn "$root/$v/bin/codex" "$HOME/.local/bin/codex.new"
mv -Tf "$HOME/.local/bin/codex.new" "$HOME/.local/bin/codex"
for o in "$root"/*; do
  case "$o" in "$root/$v") continue;; esac
  case "$prev" in "$o"/*) continue;; esac
  rm -rf "$o"
done`;

/**
 * Installs OpenCode `$1`. `opencode upgrade` puts it in ~/.opencode/bin, which is not on the sandbox's PATH; the image's own
 * OpenCode (/opt/opencode, linked from /usr/local/bin, owned by root) is, so it would keep winning. ~/.local/bin comes first
 * in PATH, so the installed one is linked there in one step.
 */
export const OPENCODE_INSTALL = `set -e
opencode upgrade --method curl "$1"
test -x "$HOME/.opencode/bin/opencode"
mkdir -p "$HOME/.local/bin"
ln -sfn "$HOME/.opencode/bin/opencode" "$HOME/.local/bin/opencode.new"
mv -Tf "$HOME/.local/bin/opencode.new" "$HOME/.local/bin/opencode"`;

/**
 * The sbx exec arguments (after the sandbox name) that install exactly `version` of a CLI, newer or older than what the sandbox has
 * (so the same command serves an upgrade and a pin).
 */
export function upgradeCommand(cli: AgentCli, version: string): string[] {
  if (cli === "claude") return ["claude", "install", version];
  if (cli === "opencode") return ["sh", "-c", OPENCODE_INSTALL, "sh", version];
  return ["sh", "-c", CODEX_INSTALL, "sh", version];
}

/** The last meaningful line of what a command said (colours and spinner control codes removed), for an error message. */
function lastLine(r: RunResult): string | undefined {
  return `${r.stderr}\n${r.stdout}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n").map((l) => l.trim()).filter(Boolean).pop()?.slice(0, 200);
}

interface Seen {
  cli: AgentCli;
  version: string;
  at: string;
}

export class CliVersions {
  private seen: Record<string, Seen> = {}; // agent id → what its sandbox had when last read
  private latest: Partial<Record<CliLine, { version: string; at: number }>> = {};
  private upgrading = new Set<string>();
  private errors: Record<string, string> = {};
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
      const installed = same ? s.version : null;
      out[a.id] = {
        cli: a.cli,
        installed,
        latest: this.latest[cliLine(a.cli, installed)]?.version ?? null,
        checkedAt: same ? s.at : null,
        pinned: a.cliVersion || null,
        ...(this.upgrading.has(a.id) ? { upgrading: true } : {}),
        ...(this.errors[a.id] ? { error: this.errors[a.id] } : {}),
      };
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
    const lines = new Set<CliLine>();
    for (const a of this.hub.snap.config.team) {
      lines.add(a.cli);
      if (a.cli === "opencode") lines.add("opencode2"); // which one depends on what the sandbox has
    }
    await Promise.all(
      [...lines].map(async (cli) => {
        const have = this.latest[cli];
        if (!force && have && this.now() - have.at < LATEST_TTL_MS) return;
        try {
          const res = await this.fetchFn(LATEST_URL[cli], { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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
  /** Whether the agent's sandbox is running (an exec into a stopped one would start it). */
  private async running(agentId: string): Promise<boolean> {
    const ls = await this.run("sbx", ["ls", "--json"], { timeoutMs: 10_000 });
    const boxes = ls.ok ? sandboxList<{ name: string; status?: string }>(ls.stdout) : null;
    const name = sessionName(this.hub.slug, agentId);
    return !!boxes?.some((b) => b.name === name && b.status === "running");
  }

  /** Runs the install of `version` in the sandbox `name` (an exec into a stopped sandbox starts it). Resolves with an error text, or null. */
  private async install(cli: AgentCli, name: string, version: string): Promise<string | null> {
    const r = await this.run("sbx", ["exec", name, ...upgradeCommand(cli, version)], { timeoutMs: 330_000 });
    return r.ok ? null : (lastLine(r) ?? "the install command failed");
  }

  /**
   * Installs the version the agent should have (its pin, else the newest) in its sandbox. The agent's running session keeps the old
   * program until it starts again, so this is safe while it works; Recreate sandbox goes back to the image's version (a pinned agent is
   * put back on its pin when it starts). Resolves with a line for the user; failures are also kept in the agent's info (`error`) and
   * the activity feed.
   */
  async upgrade(agentId: string): Promise<{ ok: boolean; message: string }> {
    const agent = this.hub.snap.config.team.find((a) => a.id === agentId);
    if (!agent) return { ok: false, message: "No such agent." };
    const fail = (message: string) => {
      this.errors[agentId] = message;
      this.hub.activity("session", agentId, `${agent.name}: ${message}`);
      this.publish();
      return { ok: false, message };
    };
    if (this.upgrading.has(agentId)) return { ok: false, message: "Already upgrading." };
    const before = this.info()[agentId];
    const target = cliTarget(before);
    if (!cliNeedsInstall(cliVersionState(before)) || !target) return fail(`${agent.name}'s ${agent.cli} is not known to differ from the version it should have, so there is nothing to install.`);
    this.upgrading.add(agentId); // before the first await: a second click right behind the first is refused
    try {
      if (!(await this.running(agentId))) return fail(`Start ${agent.name} first: its sandbox isn't running, and the install is done inside it.`);
      delete this.errors[agentId];
      this.publish();
      const error = await this.install(agent.cli, sessionName(this.hub.slug, agentId), target);
      await this.readInstalled([agentId]);
      const after = this.info()[agentId];
      const done = cliVersionState(after) === "current";
      if (error && !done) return fail(`installing ${agent.cli} ${target} failed: ${error}.`);
      if (!done) return fail(`${agent.cli} is still ${after.installed ?? "of unknown version"} after the install (it should be ${target}).`);
      const message = `${agent.cli} ${before.installed} → ${after.installed} in ${agent.name}'s sandbox${before.pinned ? " (pinned)" : ""}. It takes effect the next time ${agent.name} starts.`;
      this.hub.activity("session", agentId, `${agent.name}: ${message}`);
      return { ok: true, message };
    } finally {
      this.upgrading.delete(agentId);
      this.publish();
    }
  }

  /**
   * Before a pinned agent starts: makes the CLI in its sandbox (which must exist) exactly the pinned version, installing it if
   * needed, so a new or recreated sandbox, whose image has some other version, never runs an unpinned one. Does nothing for an agent
   * without a pin. Throws, with something the user can act on, when it can't: an agent on the wrong version must not start quietly.
   */
  async enforcePin(agentId: string): Promise<void> {
    const agent = this.hub.snap.config.team.find((a) => a.id === agentId);
    const pin = agent?.cliVersion;
    if (!agent || !pin) return;
    const name = sessionName(this.hub.slug, agentId);
    const read = async () => {
      const r = await this.run("sbx", ["exec", name, agent.cli, "--version"], { timeoutMs: 60_000 });
      return r.ok ? parseVersion(r.stdout) : null;
    };
    let installed = await read();
    if (installed !== pin) {
      const error = await this.install(agent.cli, name, pin);
      installed = await read();
      if (installed !== pin)
        throw new Error(`Could not install ${agent.cli} ${pin}, the version ${agent.name} is pinned to${error ? `: ${error}` : ` (the sandbox has ${installed ?? "an unreadable version"})`}. Fix it, or change or clear the pin in Settings → Team.`);
      this.hub.activity("session", agentId, `${agent.name}: installed ${agent.cli} ${pin}, the version it is pinned to.`);
    }
    this.seen[agentId] = { cli: agent.cli, version: pin, at: new Date(this.now()).toISOString() };
    this.save();
    this.publish();
  }
}
