// macOS and Linux: each agent runs in a tmux session, so it keeps running when
// HQ or the browser closes. HQ attaches a pty to show its terminal.

import { spawn as spawnPty } from "@lydell/node-pty";
import { run, shq } from "../lib/exec";
import * as tmux from "./tmuxCli";
import type { LaunchSpec, SessionBackend } from "./types";

const TERM_ENV = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>;

/** Quotes for a POSIX shell only when needed, so simple commands stay readable. */
const q = (s: string) => (/^[A-Za-z0-9_\-.,:/=@%+]+$/.test(s) ? s : shq(s));

/**
 * Shell code that exports each KEY=value line of an env file literally, like `sbx --env-file`
 * (no $-expansion, spaces kept; comments and blank lines skipped). HQ itself never reads the file.
 */
export const loadEnvFile = (quotedPath: string) =>
  // CRLF files: drop the \r. Lines whose key isn't a valid name are skipped (export would stop the shell).
  // Scratch names are unlikely to clash with app variables and are unset afterwards; the CR is
  // computed per line, so nothing in the file can change it.
  `while IFS= read -r __khteam_l || [ -n "$__khteam_l" ]; do __khteam_l=\${__khteam_l%"$(printf '\\r')"}; __khteam_k=\${__khteam_l%%=*}; ` +
  `case "$__khteam_l" in *=*) case "$__khteam_k" in ""|[!A-Za-z_]*|*[!A-Za-z0-9_]*) ;; *) export "$__khteam_l";; esac;; esac; done < ${quotedPath}; ` +
  `unset __khteam_l __khteam_k`;

/** The shell line tmux runs. Local mode loads the env file into that shell. */
export function shellCommand(spec: LaunchSpec): string {
  const load = spec.envFiles.map((f) => `${loadEnvFile(shq(f))} && `).join("");
  return load + [spec.file, ...spec.args].map(q).join(" ");
}

export const tmuxBackend: SessionBackend = {
  kind: "tmux",
  persistent: true,

  exists: (name) => tmux.hasSession(name),

  async create(name, cwd, spec) {
    await tmux.newSession(name, cwd, shellCommand(spec));
  },

  kill: (name) => tmux.killSession(name),

  attach(name, size, onData, onEnd) {
    const pty = spawnPty("tmux", ["attach-session", "-t", `=${name}`], { name: "xterm-256color", cols: size.cols, rows: size.rows, env: TERM_ENV });
    pty.onData(onData);
    pty.onExit(onEnd);
    return { write: (d) => pty.write(d), resize: (c, r) => pty.resize(c, r), close: () => pty.kill() };
  },

  async type(name, text) {
    if (!(await tmux.hasSession(name))) return false;
    return (await run("tmux", ["send-keys", "-t", `=${name}:`, "-l", text], { timeoutMs: 5000 })).ok;
  },

  async enter(name) {
    return (await run("tmux", ["send-keys", "-t", `=${name}:`, "Enter"], { timeoutMs: 5000 })).ok;
  },

  exitInfo: (name) => tmux.paneInfo(name),

  screenText: (name, lines) => tmux.tailText(name, lines),

  shutdown() {
    // Nothing to do: tmux keeps the agents running.
  },
};
