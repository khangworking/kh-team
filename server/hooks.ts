// Claude Code / Codex hooks → agent state. Each agent's hooks POST to
// /hook/<agentId>/<Event> with the hook's JSON payload.

import type { Hub } from "./hub";
import type { Inbox } from "./inbox";

interface HookPayload {
  prompt?: string;
  tool_name?: string;
  message?: string;
  notification_type?: string;
  /** StopFailure: what ended the turn (a rate limit, no credit, a bad key or model). */
  error?: unknown;
}

const clip = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/**
 * Whether the agent is inside a turn (prompt submitted, no Stop yet). Hooks can
 * arrive late or out of order (e.g. a PreToolUse after Stop), so only a new prompt
 * may turn an idle agent back to "working".
 */
const turnOpen = new Map<string, boolean>();

export interface HookResult {
  ok: boolean;
  /** JSON printed by the hook command; Claude Code acts on it (Stop: block = continue). */
  response?: Record<string, unknown>;
}

export function handleHook(hub: Hub, inbox: Inbox, agentId: string, event: string, body: HookPayload): HookResult {
  const st = hub.status(agentId);
  const name = hub.name(agentId);
  if (!st) return { ok: false };
  inbox.noteHook(agentId, event);

  switch (event) {
    case "SessionStart":
      turnOpen.set(agentId, false);
      hub.setStatus(agentId, { state: "idle", note: "Ready" });
      break;
    case "UserPromptSubmit":
      turnOpen.set(agentId, true);
      hub.setStatus(agentId, { state: "working", note: body.prompt ? clip(body.prompt.replace(/\s+/g, " ")) : null });
      if (st.state !== "working") hub.activity("task.started", agentId, `${name} is working`);
      break;
    case "PreToolUse":
      // Stale: the turn already ended. (Unknown, e.g. after an HQ restart, is allowed.)
      if (turnOpen.get(agentId) === false) break;
      // Also clears "needs input" once a permission prompt is answered.
      if (st.state !== "working" || st.note?.startsWith("Asking")) hub.setStatus(agentId, { state: "working", note: body.tool_name ? `Using ${body.tool_name}` : null });
      break;
    case "PostToolUse":
      // A tool finished: if it was waiting on the user (a question or a permission), they answered.
      if (turnOpen.get(agentId) === false) break;
      if (st.state === "needs-input") hub.setStatus(agentId, { state: "working", note: "Continuing after your answer" });
      break;
    case "PermissionRequest": {
      // Codex: an approval prompt is waiting in the terminal.
      const what = body.tool_name ? `Approve ${body.tool_name}?` : "Approval needed in the terminal";
      hub.setStatus(agentId, { state: "needs-input", note: `Asking: ${what}` });
      hub.activity("agent.needs-input", agentId, `${name} needs you: ${what}`);
      break;
    }
    case "Notification": {
      const msg = body.message ?? "Needs your attention";
      // "Waiting for your input" fires after a finished turn sits idle — not urgent.
      if (/waiting for your input/i.test(msg) || body.notification_type === "idle_prompt") {
        hub.setStatus(agentId, { state: "idle", note: "Waiting for you" });
        break;
      }
      hub.setStatus(agentId, { state: "needs-input", note: `Asking: ${clip(msg)}` });
      hub.activity("agent.needs-input", agentId, `${name} needs you: ${clip(msg, 60)}`);
      break;
    }
    case "Stop": {
      // Messages that arrived while the agent was busy: hand them over now,
      // and Claude Code continues with them instead of stopping.
      const queued = inbox.takeForStop(agentId);
      if (queued) {
        turnOpen.set(agentId, true); // Claude continues: same turn
        hub.setStatus(agentId, { state: "working", note: "Reading new messages" });
        return { ok: true, response: { decision: "block", reason: queued } };
      }
      turnOpen.set(agentId, false);
      hub.setStatus(agentId, { state: "idle", note: "Finished — ready for the next instruction" });
      hub.activity("agent.answered", agentId, `${name} finished a turn`);
      break;
    }
    case "Idle":
      // A finished run from a CLI that can't continue on a Stop reply (OpenCode): queued messages stay
      // in the inbox, which types them now that the agent is idle.
      turnOpen.set(agentId, false);
      hub.setStatus(agentId, { state: "idle", note: "Finished — ready for the next instruction" });
      hub.activity("agent.answered", agentId, `${name} finished a turn`);
      break;
    case "StopFailure": {
      // The turn ended on an API error. Not "finished": say why, and keep queued messages for later.
      turnOpen.set(agentId, false);
      const why = typeof body.error === "string" ? body.error : body.error ? JSON.stringify(body.error) : "API error";
      hub.setStatus(agentId, { state: "needs-input", note: `Provider error: ${clip(why, 100)}` });
      hub.activity("agent.needs-input", agentId, `${name} stopped on a provider error: ${clip(why, 60)}`);
      break;
    }
    case "SessionEnd":
      turnOpen.set(agentId, false);
      hub.setStatus(agentId, { state: "idle", note: "Session ended" });
      break;
    default:
      return { ok: false };
  }
  return { ok: true };
}
