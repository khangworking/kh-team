// Claude Code / Codex hooks → agent state. Each agent's hooks POST to
// /hook/<agentId>/<Event> with the hook's JSON payload.

import type { Budget } from "./budget";
import type { Hub } from "./hub";
import type { Inbox } from "./inbox";

interface HookPayload {
  prompt?: string;
  tool_name?: string;
  message?: string;
  notification_type?: string;
  /** StopFailure: what ended the turn (a rate limit, no credit, a bad key or model). */
  error?: unknown;
  /** Cost: this step's USD. StatusLine (Claude Code): { total_cost_usd } for the whole session. */
  cost?: number | { total_cost_usd?: number };
  session_id?: string;
}

const clip = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/**
 * Whether the agent is inside a turn (prompt submitted, no Stop yet). Hooks can
 * arrive late or out of order (e.g. a PreToolUse after Stop), so only a new prompt
 * may turn an idle agent back to "working".
 */
const turnOpen = new Map<string, boolean>();

/**
 * OpenCode can't continue itself after a run ends (Claude Code's Stop reply can). A small model often
 * ends a run with a summary and no work, which leaves its task "in progress" with an idle agent.
 * So when an OpenCode agent finishes a run while it still holds an in-progress task, HQ types a short
 * reminder into its terminal. Turns that used tools count as progress; turns that didn't are limited.
 */
const NUDGE_QUIET_TURNS = 3; // consecutive runs with no tool call before HQ gives up
const NUDGE_TOTAL = 12; // reminders per task, however much progress there is
const toolsThisTurn = new Map<string, number>();
const nudges = new Map<string, { taskId: string; quiet: number; total: number }>();

export function nudgeAfterIdle(hub: Pick<Hub, "snap" | "activity" | "setStatus" | "name">, inbox: Pick<Inbox, "pending" | "push">, agentId: string): "none" | "sent" | "gave-up" {
  const task = hub.snap.tasks.find((t) => t.ownerId === agentId && t.status === "in-progress");
  if (!task) {
    nudges.delete(agentId);
    return "none";
  }
  // Queued messages start the next run on their own.
  if (inbox.pending(agentId) > 0) return "none";
  const prev = nudges.get(agentId);
  const s = prev?.taskId === task.id ? prev : { taskId: task.id, quiet: 0, total: 0 };
  s.quiet = (toolsThisTurn.get(agentId) ?? 0) > 0 ? 0 : s.quiet + 1;
  s.total++;
  nudges.set(agentId, s);
  if (s.quiet > NUDGE_QUIET_TURNS || s.total > NUDGE_TOTAL) {
    // The next run (the user's message) starts a fresh count.
    nudges.delete(agentId);
    const note = `Stopped without finishing ${task.id} — send it a message or reassign the task`;
    hub.setStatus(agentId, { state: "idle", note });
    hub.activity("agent.needs-input", agentId, `${hub.name(agentId)} keeps stopping before ${task.id} is done. HQ stopped reminding it.`);
    return "gave-up";
  }
  inbox.push(agentId, {
    fromId: "hq",
    kind: "notice",
    text:
      `Your task ${task.id} ("${task.title}") is still in progress, but your last run ended. Do not describe the work: do it with your tools (create the branch, edit the files, run the commands). ` +
      "When the PR is open, call set_my_status in-review with the PR number. If you are blocked, call set_my_status blocked with the reason.",
  });
  hub.activity("agent.answered", agentId, `HQ reminded ${hub.name(agentId)} to continue ${task.id}`);
  return "sent";
}

export interface HookResult {
  ok: boolean;
  /** JSON printed by the hook command; Claude Code acts on it (Stop: block = continue). */
  response?: Record<string, unknown>;
}

export function handleHook(hub: Hub, inbox: Inbox, agentId: string, event: string, body: HookPayload, budget?: Pick<Budget, "record" | "recordTotal">): HookResult {
  const st = hub.status(agentId);
  const name = hub.name(agentId);
  if (!st) return { ok: false };
  // Cost reports say nothing about what the agent is doing, so they don't count as activity.
  if (event === "Cost") {
    if (typeof body.cost === "number") budget?.record(agentId, body.cost);
    return { ok: true };
  }
  if (event === "StatusLine") {
    const total = typeof body.cost === "object" ? body.cost?.total_cost_usd : undefined;
    if (typeof total === "number") budget?.recordTotal(agentId, String(body.session_id ?? ""), total);
    return { ok: true };
  }
  inbox.noteHook(agentId, event);

  switch (event) {
    case "SessionStart":
      turnOpen.set(agentId, false);
      hub.setStatus(agentId, { state: "idle", note: "Ready" });
      break;
    case "UserPromptSubmit":
      turnOpen.set(agentId, true);
      toolsThisTurn.set(agentId, 0);
      hub.setStatus(agentId, { state: "working", note: body.prompt ? clip(body.prompt.replace(/\s+/g, " ")) : null });
      if (st.state !== "working") hub.activity("task.started", agentId, `${name} is working`);
      break;
    case "PreToolUse":
      // Stale: the turn already ended. (Unknown, e.g. after an HQ restart, is allowed.)
      if (turnOpen.get(agentId) === false) break;
      toolsThisTurn.set(agentId, (toolsThisTurn.get(agentId) ?? 0) + 1);
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
      nudgeAfterIdle(hub, inbox, agentId);
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
