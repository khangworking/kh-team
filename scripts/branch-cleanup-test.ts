// Branches deleted on GitHub go from every agent's folder (reviewers' too); nothing else does.
//
//   npx tsx scripts/branch-cleanup-test.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// HQ's folders live under the home directory: use a scratch one.
const home = mkdtempSync(join(tmpdir(), "hq-branches-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { BranchCleanup, removeGoneBranches } = await import("../server/branchCleanup");
const { ensureWorkspace } = await import("../server/workspace");
const { managedWorkspace } = await import("../server/paths");

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" }).trim();
const branches = (cwd: string) => git(cwd, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").sort();

// A "GitHub": a bare repo with main and two task branches; two agent clones of it.
const remote = join(home, "remote.git");
const seed = join(home, "seed");
mkdirSync(seed);
git(seed, "init", "-q", "-b", "main");
writeFileSync(join(seed, "a.txt"), "one\n");
git(seed, "add", ".");
git(seed, "commit", "-qm", "init");
git(home, "init", "-q", "--bare", "-b", "main", remote);
git(seed, "remote", "add", "origin", remote);
git(seed, "push", "-q", "origin", "main");
for (const b of ["t1-merged", "t2-open", "t3-closed"]) {
  git(seed, "checkout", "-q", "-b", b, "main");
  writeFileSync(join(seed, `${b}.txt`), b);
  git(seed, "add", ".");
  git(seed, "commit", "-qm", b);
  git(seed, "push", "-q", "origin", b);
}
const clone = (id: string) => {
  const dir = managedWorkspace("office", id);
  git(home, "clone", "-q", remote, dir);
  for (const b of ["t1-merged", "t2-open", "t3-closed"]) git(dir, "checkout", "-q", "-b", b, "--track", `origin/${b}`);
  git(dir, "checkout", "-q", "-b", "scratch"); // never pushed: no upstream
  writeFileSync(join(dir, "wip.txt"), "x");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "scratch work");
  git(dir, "checkout", "-q", "main");
  return dir;
};
const dwight = clone("dwight");
const jim = clone("jim"); // the reviewer
const everyone = ["main", "scratch", "t1-merged", "t2-open", "t3-closed"];
assert.deepEqual(branches(dwight), everyone);

// ---- A merged PR's branch is deleted on GitHub (and a PR closed without merging, deleted by the user)
git(seed, "push", "-q", "origin", "--delete", "t1-merged", "t3-closed");
git(jim, "checkout", "-q", "t3-closed"); // the reviewer is still on it: that one stays until it moves on

const r = await removeGoneBranches(dwight);
assert.equal(r.error, null);
assert.deepEqual(r.removed.map((b) => b.name).sort(), ["t1-merged", "t3-closed"]);
assert.ok(r.removed.every((b) => /^[0-9a-f]{7,}$/.test(b.sha)), "the tip is kept in the log");
assert.deepEqual(branches(dwight), ["main", "scratch", "t2-open"], "open and never-pushed branches stay");
assert.equal(git(dwight, "log", "-1", "--format=%s", "scratch"), "scratch work");

const again = await removeGoneBranches(dwight);
assert.deepEqual(again.removed, [], "nothing more to do");

// The branch that is checked out is never removed, and goes once the agent has moved on.
const checkedOut = await removeGoneBranches(jim);
assert.deepEqual(checkedOut.removed.map((b) => b.name), ["t1-merged"]);
assert.ok(branches(jim).includes("t3-closed"));
git(jim, "checkout", "-q", "main");
assert.deepEqual((await removeGoneBranches(jim)).removed.map((b) => b.name), ["t3-closed"]);
assert.deepEqual(branches(jim), ["main", "scratch", "t2-open"]);

// A clone that cannot reach GitHub is left alone.
git(dwight, "remote", "set-url", "origin", join(home, "nowhere.git"));
git(dwight, "branch", "--set-upstream-to=origin/t2-open", "scratch");
const offline = await removeGoneBranches(dwight);
assert.deepEqual(offline.removed, []);
assert.ok(offline.error, "reported, not thrown");
git(dwight, "remote", "set-url", "origin", remote);
git(dwight, "branch", "--unset-upstream", "scratch");
assert.deepEqual(branches(dwight), ["main", "scratch", "t2-open"]);

// ---- Every agent's folder, once, from the office
{
  git(seed, "push", "-q", "origin", "--delete", "t2-open");
  const team = ["dwight", "jim", "michael"].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), workspacePath: id === "michael" ? "/somewhere/the/user/chose" : null }));
  const lines: string[] = [];
  const hub = { slug: "office", snap: { config: { team } }, activity: (_t: string, _id: string | null, text: string) => lines.push(text) };
  const cleanup = new BranchCleanup(hub as never);
  await Promise.all([cleanup.run(), cleanup.run()]); // asked twice at once: the second waits its turn
  await new Promise((ok) => setTimeout(ok, 3600));
  assert.deepEqual(branches(dwight), ["main", "scratch"], "t2-open went");
  assert.deepEqual(branches(jim), ["main", "scratch"]);
  assert.equal(lines.length, 2, lines.join(" | "));
  assert.match(lines[0], /HQ removed 1 branch deleted on GitHub from Dwight's folder: t2-open/);
  assert.ok(lines.some((l) => l.includes("Jim's folder")), "the reviewer's folder too");
  assert.ok(!lines.some((l) => /Michael/.test(l)), "a folder the user chose is not touched");
}

// ---- A new clone prunes on its own fetches
{
  const fresh = await ensureWorkspace({ id: "kevin", name: "Kevin", workspacePath: null, mode: "sandbox" } as never, "office", { root: remote, originUrl: remote } as never);
  assert.equal(git(fresh, "config", "--get", "fetch.prune"), "true");
}

console.log("✓ branch cleanup");
