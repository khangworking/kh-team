// The project used to be called JSM HQ. What it left on disk (an office in ~/.jsmhq, a repo's .jsmhq/ folder, hook
// entries and files in agent folders) must keep working under the new name, and never be doubled or lost.
//
//   npx tsx scripts/rename-test.ts

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const home = mkdtempSync(join(tmpdir(), "hq-rename-"));
Object.assign(process.env, { HOME: home, USERPROFILE: home });

const { projectHome, HOME_DIR, LEGACY_HOME_DIR } = await import("../server/paths");
const { loadConfig, saveConfig, loadPlan, savePlan } = await import("../server/store");
const { writeSettings, dropLegacyFiles, excludeFromGit, adoptRoleFile, ROLE_FILE, HOOK_SCRIPT, LEGACY_FILES, MARK } = await import("../server/agentFiles");

assert.equal(homedir(), home, "the test runs against a scratch home");
assert.equal(HOME_DIR, ".kh-team");
assert.equal(LEGACY_HOME_DIR, ".jsmhq");
assert.equal(ROLE_FILE, ".kh-team-role.md");
assert.equal(HOOK_SCRIPT, ".kh-team-hook.mjs");
assert.equal(MARK, "# kh-team-hook");

// ---------------------------------------------------------------- ~/.kh-team, or the office that already lives in ~/.jsmhq
{
  const fresh = projectHome("brand-new");
  assert.equal(fresh, join(home, ".kh-team", "brand-new"), "a new office lives in ~/.kh-team");
  assert.ok(existsSync(fresh));
  assert.ok(!existsSync(join(home, ".jsmhq", "brand-new")));

  // An office from before the rename: its agent folders are mounted into sandboxes by path, so it stays where it is.
  mkdirSync(join(home, ".jsmhq", "todoapp", "dwight"), { recursive: true });
  writeFileSync(join(home, ".jsmhq", "todoapp", "agent-token"), "tok");
  assert.equal(projectHome("todoapp"), join(home, ".jsmhq", "todoapp"));
  assert.ok(!existsSync(join(home, ".kh-team", "todoapp")), "nothing is created beside it");
  assert.equal(projectHome("todoapp"), join(home, ".jsmhq", "todoapp"), "and it stays that way");

  // Both exist (someone moved it by hand): the new one wins.
  mkdirSync(join(home, ".jsmhq", "both"), { recursive: true });
  mkdirSync(join(home, ".kh-team", "both"), { recursive: true });
  assert.equal(projectHome("both"), join(home, ".kh-team", "both"));
}

// ---------------------------------------------------------------- the repo's config folder
const repoInfo = (root: string) => ({ root, name: "demo", originUrl: null, github: null, hasCodeRabbit: false, hasInsta: false });
{
  // A repo with neither: .kh-team/
  const fresh = mkdtempSync(join(tmpdir(), "hq-repo-new-"));
  const { config, isNew } = loadConfig(repoInfo(fresh) as never, 7420);
  assert.equal(isNew, true);
  saveConfig(fresh, config);
  savePlan(fresh, loadPlan(fresh));
  assert.ok(existsSync(join(fresh, ".kh-team", "config.json")));
  assert.ok(existsSync(join(fresh, ".kh-team", "plan.json")));
  assert.ok(!existsSync(join(fresh, ".jsmhq")));
  assert.equal(loadConfig(repoInfo(fresh) as never, 7420).isNew, false, "found again");

  // A repo that has .jsmhq/ (committed config): read and kept there, no second folder appears.
  const old = mkdtempSync(join(tmpdir(), "hq-repo-old-"));
  const seed = loadConfig(repoInfo(old) as never, 7420).config;
  mkdirSync(join(old, ".jsmhq"));
  writeFileSync(join(old, ".jsmhq", "config.json"), JSON.stringify({ ...seed, project: { ...seed.project, name: "From the old folder" } }));
  const found = loadConfig(repoInfo(old) as never, 7420);
  assert.equal(found.isNew, false);
  assert.equal(found.config.project.name, "From the old folder");
  found.config.project.name = "Changed";
  saveConfig(old, found.config);
  assert.equal(JSON.parse(readFileSync(join(old, ".jsmhq", "config.json"), "utf8")).project.name, "Changed", "written where it was read");
  assert.ok(!existsSync(join(old, ".kh-team")), "HQ doesn't create a second folder in the user's repo");
  const plan = loadPlan(old);
  savePlan(old, plan);
  assert.ok(existsSync(join(old, ".jsmhq", "plan.json")));
}

// ---------------------------------------------------------------- hooks and files an HQ from before the rename wrote into an agent's folder
{
  const dir = mkdtempSync(join(tmpdir(), "hq-agent-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  mkdirSync(join(dir, ".claude"));
  const legacyCmd = (event: string) => `curl -sf -m 4 -X POST 'http://host.docker.internal:7420/hook/kevin/${event}' || true # jsmhq-hook`;
  const legacySettings = {
    statusLine: { type: "command", command: `${legacyCmd("StatusLine")}` },
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: 'cat "$CLAUDE_PROJECT_DIR/.jsmhq-role.md" 2>/dev/null || true # jsmhq-hook' }, { type: "command", command: legacyCmd("SessionStart") }] }],
      Stop: [{ hooks: [{ type: "command", command: legacyCmd("Stop") }] }, { hooks: [{ type: "command", command: "echo the user's own hook" }] }],
    },
    permissions: { allow: ["Bash(ls)"] },
  };
  writeFileSync(join(dir, ".claude", "settings.local.json"), JSON.stringify(legacySettings));
  for (const f of LEGACY_FILES) writeFileSync(join(dir, f), "old");
  writeFileSync(join(dir, ".git", "info", "exclude"), "# my own line\n# JSM HQ\n.jsmhq-role.md\n.jsmhq-hook.mjs\n.mcp.json\n");

  dropLegacyFiles(dir);
  for (const f of LEGACY_FILES) assert.ok(!existsSync(join(dir, f)), `${f} removed`);
  const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8");
  assert.ok(exclude.includes("# my own line") && exclude.includes(".mcp.json"), "the user's own lines stay");
  assert.ok(!exclude.includes("jsmhq") && !exclude.includes("JSM HQ"), "the old lines go");
  excludeFromGit(dir, [ROLE_FILE]);
  assert.match(readFileSync(join(dir, ".git", "info", "exclude"), "utf8"), /# KH Team\n\.kh-team-role\.md/);

  const agent = { id: "kevin", mode: "sandbox", name: "Kevin" };
  writeSettings(dir, agent as never, 7420, "tok");
  const out = JSON.parse(readFileSync(join(dir, ".claude", "settings.local.json"), "utf8"));
  const all = JSON.stringify(out);
  assert.ok(!all.includes("jsmhq"), "no old marker or file name is left in the hooks");
  assert.equal((all.match(/\/hook\/kevin\/Stop(?!\w)/g) ?? []).length, 1, "the Stop hook is there once, not twice");
  assert.equal((all.match(/\/hook\/kevin\/SessionStart(?!\w)/g) ?? []).length, 1);
  assert.ok(all.includes("# kh-team-hook"), "the new marker");
  assert.ok(all.includes("the user's own hook"), "a hook the user added is kept");
  assert.ok(all.includes("Bash(ls)"), "their permissions too");
  assert.ok(out.statusLine.command.includes("/hook/kevin/StatusLine") && !out.statusLine.command.includes("jsmhq"), "the old status line is replaced");

  // A second write changes nothing (no growth).
  writeSettings(dir, agent as never, 7420, "tok");
  assert.equal(readFileSync(join(dir, ".claude", "settings.local.json"), "utf8"), JSON.stringify(out, null, 2) + "\n");

  // A role file an HQ ≤ 0.3 generated as ROLE.md is still recognised, from either name.
  const roleDir = mkdtempSync(join(tmpdir(), "hq-role-"));
  execFileSync("git", ["init", "-q"], { cwd: roleDir });
  writeFileSync(join(roleDir, "ROLE.md"), "## Team MCP (server `hq`)\nYou are managed by JSM HQ.\n");
  assert.equal(await adoptRoleFile(roleDir), null);
  assert.ok(!existsSync(join(roleDir, "ROLE.md")), "removed, not adopted as the project's own");
  writeFileSync(join(roleDir, "ROLE.md"), "## Team MCP (server `hq`)\nYou are managed by KH Team.\n");
  assert.equal(await adoptRoleFile(roleDir), null);
  writeFileSync(join(roleDir, "ROLE.md"), "My own role.\n");
  assert.equal(await adoptRoleFile(roleDir), "My own role.\n", "a role the project wrote is theirs");
}

console.log("rename: ok");
