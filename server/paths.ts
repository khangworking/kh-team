import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "project";

/** HQ's home folder under the user's home, and where it was before the rename (the project was called JSM HQ then). */
export const HOME_DIR = ".kh-team";
export const LEGACY_HOME_DIR = ".jsmhq";

/**
 * ~/.kh-team/<project>/ — HQ's per-project home (agent folders, tokens).
 * An office that already lives in ~/.jsmhq/<project>/ stays there: its agent folders are mounted into
 * Docker Sandboxes by path (and recorded in their configs), so moving them would break the sandboxes. New offices use ~/.kh-team.
 */
export function projectHome(projectSlug: string): string {
  const fresh = join(homedir(), HOME_DIR, projectSlug);
  const legacy = join(homedir(), LEGACY_HOME_DIR, projectSlug);
  const dir = !existsSync(fresh) && existsSync(legacy) ? legacy : fresh;
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function managedWorkspace(projectSlug: string, agentId: string): string {
  return join(projectHome(projectSlug), agentId);
}

/** Session names used for tmux and for the sandbox. */
export const sessionName = (projectSlug: string, agentId: string) => `hq-${projectSlug}-${agentId}`;

/**
 * Agent token: what hooks and the Team MCP send. Stable per project so agent
 * sessions that outlive an HQ restart keep working. Stored 0600 in HQ's home.
 */
export function agentToken(projectSlug: string): string {
  const file = join(projectHome(projectSlug), "agent-token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const tok = randomBytes(24).toString("hex");
  writeFileSync(file, tok, { mode: 0o600 });
  return tok;
}

/**
 * Browser token, required by the UI's WebSocket. New on every start — except in
 * dev, where it survives server reloads so the open tab keeps working.
 */
export function browserToken(projectSlug: string, dev: boolean): string {
  if (!dev) return randomBytes(24).toString("hex");
  const file = join(projectHome(projectSlug), "dev-browser-token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const tok = randomBytes(24).toString("hex");
  writeFileSync(file, tok, { mode: 0o600 });
  return tok;
}
