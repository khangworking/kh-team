// Drives each available session backend with a fake agent (a Node REPL-like
// loop): create, attach, type + Enter, read the screen, exit code, kill.
// Runs on every CI OS, so the Windows backend is exercised on real Windows.
//
//   npx tsx scripts/session-backend-test.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../server/lib/exec";
import { ptyBackend } from "../server/backends/pty";
import { tmuxBackend } from "../server/backends/tmux";
import type { SessionBackend } from "../server/backends/types";

const FAKE_AGENT = [
  "process.stdin.setEncoding('utf8');",
  "console.log('agent-ready');",
  "let buf = '';",
  "process.stdin.on('data', (d) => {",
  "  buf += d;",
  "  let i;",
  "  while ((i = buf.search(/[\\r\\n]/)) >= 0) {",
  "    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);",
  "    if (!line) continue;",
  "    if (line === 'quit') process.exit(3);",
  "    console.log('got:' + line);",
  "  }",
  "});",
].join("\n");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(label: string, fn: () => Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(200);
  }
  throw new Error(`timed out: ${label}`);
}

async function test(backend: SessionBackend) {
  const name = `hq-backend-test-${process.pid}`;
  const cwd = mkdtempSync(join(tmpdir(), "hq-backend-"));
  let streamed = "";
  let ended = false;
  try {
    await backend.create(name, cwd, { file: process.execPath, args: ["-e", FAKE_AGENT], envFiles: [] }, { cols: 100, rows: 30 });
    if (!(await backend.exists(name))) throw new Error("session missing after create");
    const view = backend.attach(name, { cols: 90, rows: 25 }, (d) => (streamed += d), () => (ended = true));
    await until("agent-ready on screen", async () => (await backend.screenText(name, 10)).includes("agent-ready"));

    if (!(await backend.type(name, "hello world"))) throw new Error("type failed");
    await sleep(200);
    if (!(await backend.enter(name))) throw new Error("enter failed");
    await until("reply on screen", async () => (await backend.screenText(name, 10)).includes("got:hello world"));
    // tmux's attach client redraws on its own schedule; the pty backend streams everything.
    if (backend.kind === "pty" && !streamed.includes("got:hello world")) throw new Error("reply not streamed to the view");
    view.resize(80, 20);

    if ((await backend.exitInfo(name))?.dead) throw new Error("reported dead while running");
    await backend.type(name, "quit");
    await backend.enter(name);
    await until("exit noticed", async () => (await backend.exitInfo(name))?.dead === true);
    const exit = await backend.exitInfo(name);
    // Some tmux versions (e.g. Ubuntu's) report a dead pane without its exit code; HQ only shows it in a message.
    if (exit?.exitStatus !== 3 && !(backend.kind === "tmux" && exit?.exitStatus === null)) throw new Error(`exit status ${exit?.exitStatus}, expected 3`);

    await backend.kill(name);
    if (await backend.exists(name)) throw new Error("session still exists after kill");
    await until("view ended", async () => ended, 5000);
    console.log(`✓ ${backend.kind} backend`);
  } finally {
    await backend.kill(name).catch(() => {});
    backend.shutdown();
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      /* Windows may still hold the folder */
    }
  }
}

const backends: SessionBackend[] = [ptyBackend];
if (process.platform !== "win32" && (await run("tmux", ["-V"])).ok) backends.push(tmuxBackend);
else console.log("- tmux backend skipped (tmux not installed)");

let failed = false;
for (const b of backends) {
  try {
    await test(b);
  } catch (e) {
    failed = true;
    console.error(`✗ ${b.kind} backend: ${e instanceof Error ? e.message : e}`);
  }
}
process.exit(failed ? 1 : 0);
