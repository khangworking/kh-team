// The CLI version of each agent's sandbox against the newest published.
//
//   npx tsx scripts/cli-versions-test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "hq-cliver-"));
Object.assign(process.env, { HOME: home, USERPROFILE: home });

const { cliLine, compareVersions, cliVersionState, parseVersion, NPM_PACKAGE } = await import("../src/data/cliVersions");
const { CliVersions, upgradeCommand, CODEX_INSTALL } = await import("../server/cliVersions");

// ---------------------------------------------------------------- reading and comparing
assert.equal(parseVersion("2.1.322 (Claude Code)"), "2.1.322");
assert.equal(parseVersion("codex-cli 0.167.0\n"), "0.167.0");
assert.equal(parseVersion("1.19.0"), "1.19.0");
assert.equal(parseVersion("command not found"), null);
assert.equal(parseVersion(""), null);

assert.ok(compareVersions("0.167.0", "0.167.2") < 0);
assert.ok(compareVersions("0.167.10", "0.167.2") > 0, "numbers, not text");
assert.ok(compareVersions("2.0.0", "1.19.5") > 0);
assert.equal(compareVersions("1.2.3", "1.2.3"), 0);

assert.equal(cliVersionState(undefined), "unknown");
assert.equal(cliVersionState({ installed: null, latest: "1.0.0" }), "unknown");
assert.equal(cliVersionState({ installed: "1.0.0", latest: null }), "unknown");
assert.equal(cliVersionState({ installed: "0.167.0", latest: "0.167.2" }), "behind");
assert.equal(cliVersionState({ installed: "0.167.2", latest: "0.167.2" }), "current");
assert.equal(cliVersionState({ installed: "2.0.29", latest: "1.19.5" }), "current", "newer than the stable tag (a beta channel) is not behind");

assert.deepEqual(Object.keys(NPM_PACKAGE).sort(), ["claude", "codex", "opencode"]);

// ---------------------------------------------------------------- the server side
type A = { id: string; name: string; cli: "claude" | "codex" | "opencode" };
const team: A[] = [
  { id: "jim", name: "Jim", cli: "claude" },
  { id: "dwight", name: "Dwight", cli: "codex" },
  { id: "pam", name: "Pam", cli: "opencode" },
];
const hubOf = (slug: string) => {
  const events: { type: string }[] = [];
  const activity: string[] = [];
  return { events, activity, hub: { slug, snap: { config: { team } } as { config: { team: A[] }; cliVersions?: unknown }, emit: (e: { type: string }) => events.push(e), activity: (_k: string, _id: string, text: string) => activity.push(text) } };
};

const calls: string[][] = [];
let status: Record<string, string> = { "hq-v-jim": "running", "hq-v-dwight": "running", "hq-v-pam": "exited" };
const outputs: Record<string, string> = { "hq-v-jim claude": "2.1.322 (Claude Code)\n", "hq-v-dwight codex": "codex-cli 0.167.0\n" };
let lsFails = false;
const fakeRun = async (_cmd: string, args: string[]) => {
  calls.push(args);
  if (args[0] === "ls") {
    if (lsFails) return { ok: false, code: 1, stdout: "", stderr: "daemon down" };
    return { ok: true, code: 0, stdout: JSON.stringify(Object.entries(status).map(([name, st]) => ({ name, status: st }))), stderr: "" };
  }
  const out = outputs[`${args[1]} ${args[2]}`];
  return out === undefined ? { ok: false, code: 1, stdout: "", stderr: "not found" } : { ok: true, code: 0, stdout: out, stderr: "" };
};
const npm: Record<string, string> = { "@anthropic-ai/claude-code": "2.1.322", "@openai/codex": "0.167.2", "opencode-ai": "1.19.5", "opencode2": "2.2.7" };
const urls: string[] = [];
let npmDown = false;
const fakeFetch = async (url: string) => {
  urls.push(url);
  if (npmDown) throw new Error("offline");
  const pkg = url.includes("opencode.ai/update") ? "opencode2" : url.replace("https://registry.npmjs.org/", "").replace("/latest", "");
  return { ok: pkg in npm, json: async () => ({ version: npm[pkg] }) };
};
let clock = 1_000_000;
const stateFile = join(home, "cli-versions.json");
const make = (slug = "v") => {
  const h = hubOf(slug);
  return { ...h, cv: new CliVersions(h.hub as never, { run: fakeRun as never, fetch: fakeFetch as never, now: () => clock, file: stateFile }) };
};

{
  const { cv, hub, events } = make();
  assert.deepEqual(Object.values(cv.info()).map((i) => i.installed), [null, null, null], "nothing known yet");
  await cv.check();

  const info = hub.snap.cliVersions as ReturnType<typeof cv.info>;
  assert.equal(info.jim.installed, "2.1.322");
  assert.equal(info.jim.latest, "2.1.322");
  assert.equal(info.dwight.installed, "0.167.0");
  assert.equal(info.dwight.latest, "0.167.2");
  assert.equal(cliVersionState(info.dwight), "behind");
  assert.equal(cliVersionState(info.jim), "current");
  assert.equal(info.pam.installed, null, "a stopped sandbox is not asked (exec would start it)");
  assert.equal(info.pam.latest, "1.19.5", "but the newest is known");
  assert.ok(!calls.some((c) => c[0] === "exec" && c[1] === "hq-v-pam"));
  assert.deepEqual(calls.find((c) => c[0] === "exec" && c[1] === "hq-v-dwight"), ["exec", "hq-v-dwight", "codex", "--version"]);
  assert.equal(events.filter((e) => e.type === "cliVersions.updated").length, 1);
  assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")).dwight.version, "0.167.0", "saved");

  // npm is asked again only after its TTL; nothing new → nothing announced.
  const n = urls.length;
  await cv.check();
  assert.equal(urls.length, n, "fresh answer reused");
  assert.equal(events.filter((e) => e.type === "cliVersions.updated").length, 1);
  clock += 7 * 3_600_000;
  await cv.check();
  assert.equal(urls.length, n + 4, "after the TTL: claude, codex, and both OpenCode lines");

  // npm unreachable: the older answer stays.
  clock += 7 * 3_600_000;
  npmDown = true;
  await cv.check();
  assert.equal(((hub.snap.cliVersions as ReturnType<typeof cv.info>).dwight).latest, "0.167.2");
  npmDown = false;

  // Only some agents: the others' sandboxes are not asked.
  calls.length = 0;
  await cv.check({ only: ["jim"] });
  assert.deepEqual(calls.filter((c) => c[0] === "exec").map((c) => c[1]), ["hq-v-jim"]);

  // A newer sandbox version shows after the next look.
  outputs["hq-v-dwight codex"] = "codex-cli 0.167.2\n";
  await cv.check();
  assert.equal(cliVersionState((hub.snap.cliVersions as ReturnType<typeof cv.info>).dwight), "current");
}

// A restart: a stopped agent still shows what its sandbox had when last read.
{
  status = { "hq-v-jim": "exited", "hq-v-dwight": "exited", "hq-v-pam": "exited" };
  const { cv } = make();
  const info = cv.info();
  assert.equal(info.dwight.installed, "0.167.2");
  assert.ok(info.dwight.checkedAt, "with when it was read");
  assert.equal(info.dwight.latest, null, "the newest is asked again");
}

// The agent's CLI changed: the old sandbox's version means nothing for the new CLI.
{
  const { cv, hub } = make();
  (hub.snap.config.team.find((a) => a.id === "dwight") as A).cli = "claude";
  assert.equal(cv.info().dwight.installed, null);
  (hub.snap.config.team.find((a) => a.id === "dwight") as A).cli = "codex";
}

// sbx can't be listed: nothing is guessed. A CLI that doesn't answer keeps the earlier version. A bad file is ignored.
{
  status = { "hq-v-jim": "running", "hq-v-dwight": "running", "hq-v-pam": "exited" };
  const { cv } = make();
  lsFails = true;
  await cv.check();
  assert.equal(cv.info().dwight.installed, "0.167.2", "kept");
  lsFails = false;
  delete outputs["hq-v-dwight codex"];
  await cv.check();
  assert.equal(cv.info().dwight.installed, "0.167.2", "an unreadable answer doesn't erase it");

  writeFileSync(stateFile, "{broken");
  assert.equal(make().cv.info().jim.installed, null);
}

// Asked while busy: nothing is lost, nothing runs twice at once.
{
  status = { "hq-v-jim": "running", "hq-v-dwight": "running", "hq-v-pam": "exited" };
  outputs["hq-v-dwight codex"] = "codex-cli 0.167.2\n";
  const { cv } = make();
  calls.length = 0;
  const first = cv.check({ only: ["jim"] });
  const second = cv.check({ only: ["dwight"] });
  await first;
  await second;
  await new Promise((r) => setTimeout(r, 50)); // the queued look
  assert.deepEqual(calls.filter((c) => c[0] === "exec").map((c) => c[1]).sort(), ["hq-v-dwight", "hq-v-jim"]);
}

// ---------------------------------------------------------------- OpenCode 2 is compared with OpenCode 2
assert.equal(cliLine("opencode", "2.0.29"), "opencode2");
assert.equal(cliLine("opencode", "1.19.0"), "opencode");
assert.equal(cliLine("opencode", null), "opencode");
assert.equal(cliLine("claude", "2.1.322"), "claude");
{
  status = { "hq-v-jim": "running", "hq-v-dwight": "running", "hq-v-pam": "running" };
  outputs["hq-v-pam opencode"] = "opencode v2.0.29\n";
  outputs["hq-v-dwight codex"] = "codex-cli 0.167.2\n";
  const { cv } = make();
  await cv.check({ force: true });
  assert.equal(cv.info().pam.installed, "2.0.29");
  assert.equal(cv.info().pam.latest, "2.2.7", "not npm's 1.19.5");
  assert.equal(cliVersionState(cv.info().pam), "behind");
  outputs["hq-v-pam opencode"] = "opencode v1.19.0\n";
  await cv.check({ force: true });
  assert.equal(cv.info().pam.latest, "1.19.5", "a sandbox still on OpenCode 1");
}

// ---------------------------------------------------------------- upgrading
{
  assert.deepEqual(upgradeCommand("claude", "2.1.322"), ["claude", "update"]);
  assert.deepEqual(upgradeCommand("opencode", "2.2.7"), ["opencode", "upgrade", "--method", "curl"]);
  assert.deepEqual(upgradeCommand("codex", "0.167.2"), ["sh", "-c", CODEX_INSTALL, "sh", "0.167.2"]);
  assert.match(CODEX_INSTALL, /rust-v\$v\/codex-package-\$t\.tar\.gz/, "the whole package, not the lone binary");
  assert.match(CODEX_INSTALL, /\.local\/share\/codex/, "the agent user's own directory, no root needed");
  assert.match(CODEX_INSTALL, /mv -Tf .*codex\.new.* .*\/codex"/, "the symlink is replaced in one step");
  assert.match(CODEX_INSTALL, /prev=\$\(readlink/, "the version in use is kept");
}

{
  // What a real sandbox does: the upgrade command changes what --version says.
  status = { "hq-v-jim": "running", "hq-v-dwight": "running", "hq-v-pam": "exited" };
  outputs["hq-v-jim claude"] = "2.1.311 (Claude Code)\n";
  outputs["hq-v-dwight codex"] = "codex-cli 0.167.0\n";
  let behave: "ok" | "fail" | "nochange" = "ok";
  const seenUpgrading: boolean[] = [];
  let cvRef: { info: () => Record<string, { upgrading?: boolean }> } | null = null;
  const upgradeRun = async (cmd: string, args: string[]) => {
    if (args[0] === "exec" && (args[2] === "claude" && args[3] === "update" || args[2] === "sh")) {
      calls.push(args);
      seenUpgrading.push(!!cvRef?.info()[args[1].replace("hq-v-", "")].upgrading);
      if (behave === "fail") return { ok: false, code: 1, stdout: "", stderr: "curl: (22) The requested URL returned error: 404\n" };
      if (behave === "ok") outputs[`${args[1]} ${args[1].endsWith("jim") ? "claude" : "codex"}`] = args[1].endsWith("jim") ? "2.1.322 (Claude Code)\n" : "codex-cli 0.167.2\n";
      return { ok: true, code: 0, stdout: "done\n", stderr: "" };
    }
    return fakeRun(cmd, args);
  };
  const h = hubOf("v");
  const cv = new CliVersions(h.hub as never, { run: upgradeRun as never, fetch: fakeFetch as never, now: () => clock, file: join(home, "up-state.json") });
  cvRef = cv;
  await cv.check({ force: true });
  const info = () => h.hub.snap.cliVersions as ReturnType<typeof cv.info>;
  assert.equal(cliVersionState(info().jim), "behind");
  assert.equal(cliVersionState(info().dwight), "behind");

  // Not behind / not running: refused, with the reason.
  const refused = await cv.upgrade("nobody");
  assert.equal(refused.ok, false);
  status["hq-v-dwight"] = "exited";
  const stopped = await cv.upgrade("dwight");
  assert.equal(stopped.ok, false);
  assert.match(stopped.message, /Start Dwight first/);
  assert.match(info().dwight.error ?? "", /Start Dwight first/, "kept for the UI");
  assert.ok(!calls.some((c) => c[0] === "exec" && c[1] === "hq-v-dwight" && c[2] === "sh"), "nothing was run in a stopped sandbox");
  status["hq-v-dwight"] = "running";

  // Claude: success.
  calls.length = 0;
  seenUpgrading.length = 0;
  h.events.length = 0;
  const done = cv.upgrade("jim");
  assert.equal((await cv.upgrade("jim")).ok, false, "not twice at once");
  const res = await done;
  assert.equal(res.ok, true);
  assert.match(res.message, /upgraded from 2\.1\.311 to 2\.1\.322/);
  assert.match(res.message, /next time Jim starts/);
  assert.deepEqual(seenUpgrading, [true]);
  assert.equal(info().jim.installed, "2.1.322");
  assert.equal(info().jim.upgrading, undefined);
  assert.equal(info().jim.error, undefined);
  assert.deepEqual(calls.find((c) => c[0] === "exec" && c[2] === "claude" && c[3] === "update"), ["exec", "hq-v-jim", "claude", "update"]);
  assert.ok(h.activity.some((t) => /upgraded from 2\.1\.311/.test(t)));
  assert.equal((await cv.upgrade("jim")).ok, false, "up to date now: nothing to do");

  // Codex: the install script runs with the newest version as its argument.
  calls.length = 0;
  assert.equal((await cv.upgrade("dwight")).ok, true);
  assert.deepEqual(calls.find((c) => c[2] === "sh")?.slice(-2), ["sh", "0.167.2"]);
  assert.equal(info().dwight.installed, "0.167.2");

  // A failing command: the last line of what it said is the reason; the version is unchanged.
  outputs["hq-v-jim claude"] = "2.1.311 (Claude Code)\n";
  await cv.check({ force: true });
  behave = "fail";
  const bad = await cv.upgrade("jim");
  assert.equal(bad.ok, false);
  assert.match(bad.message, /upgrading claude failed: curl: \(22\) The requested URL returned error: 404/);
  assert.equal(info().jim.installed, "2.1.311");
  assert.match(info().jim.error ?? "", /404/);

  // A command that says "ok" but changes nothing is not success.
  behave = "nochange";
  const same = await cv.upgrade("jim");
  assert.equal(same.ok, false);
  assert.match(same.message, /still 2\.1\.311/);
  assert.equal(info().jim.error?.includes("still 2.1.311"), true);

  // The next try clears the old error.
  behave = "ok";
  assert.equal((await cv.upgrade("jim")).ok, true);
  assert.equal(info().jim.error, undefined);
}

console.log("cli-versions: ok");
