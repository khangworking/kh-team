// Delivery to agents. If the agent is idle at its prompt, HQ types the message
// into its terminal. If it's busy, the message waits and is handed over by the
// agent's Stop hook when its turn ends (Claude Code then continues with it).
//
// The queue is kept on disk (~/.kh-team/<project>/inbox.json), so a message waiting for a busy agent survives
// HQ stopping or crashing. A message leaves the file once the agent has taken it: handed over by the Stop hook,
// or typed and then answered by the agent's UserPromptSubmit. Typed but not yet answered messages are kept apart
// ("inflight") and go back in the queue if the session ends first. After a restart a message that no longer
// makes sense is dropped: too old, or a task assignment for a task that has moved on.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hub } from "./hub";
import { log } from "./lib/log";
import { projectHome } from "./paths";

export interface InboxItem {
  fromId: string; // agent id or "you"
  text: string;
  kind: "message" | "assign" | "notice"; // notice = from HQ itself (e.g. review results)
  /** An assignment: the task, so it is dropped if the task has moved on. */
  taskId?: string;
  /** When it was queued (ISO). */
  at?: string;
}

/** A message older than this is no longer worth delivering. */
export const MAX_AGE_MS = 3 * 24 * 3600_000;
/** At most this many wait for one agent; the oldest go first. */
export const MAX_QUEUE = 50;
const SAVE_DELAY_MS = 500;

interface Stored {
  queues: Record<string, InboxItem[]>;
  inflight: Record<string, InboxItem[]>;
}

export interface Keyboard {
  type(agentId: string, text: string): Promise<boolean>;
  enter(agentId: string): Promise<boolean>;
}

const QUIET_MS = 1000; // no hooks for this long = the prompt has settled
const SUBMIT_CHECK_MS = 3000; // typed text should produce UserPromptSubmit by then

export class Inbox {
  private queues = new Map<string, InboxItem[]>();
  private sessionUp = new Set<string>(); // SessionStart seen: Claude Code's prompt exists
  private lastHook = new Map<string, number>();
  private lastSubmit = new Map<string, number>();
  private typing = new Set<string>();
  /** Typed into the terminal, not yet answered by the agent's UserPromptSubmit. */
  private inflight = new Map<string, InboxItem[]>();
  private timer: NodeJS.Timeout;
  private file: string;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private hub: Hub, private keys: Keyboard) {
    this.file = join(projectHome(hub.slug), "inbox.json");
    this.load();
    // Safety net: retry anything queued for agents that have gone idle.
    this.timer = setInterval(() => {
      for (const id of this.queues.keys()) void this.tryType(id);
    }, 2000);
  }

  stop() {
    clearInterval(this.timer);
    this.flush();
  }

  // ------------------------------------------------------------ the file

  /** Reads the saved queue. What was typed but never answered goes back to the front of the queue. */
  private load() {
    let saved: Partial<Stored> = {};
    try {
      if (existsSync(this.file)) saved = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Stored>;
    } catch (err) {
      log.warn("inbox.json is unreadable; starting with an empty inbox:", err);
    }
    let restored = 0;
    for (const id of new Set([...Object.keys(saved.inflight ?? {}), ...Object.keys(saved.queues ?? {})])) {
      if (!this.hub.cfg(id)) continue; // the agent was removed
      const items = [...(saved.inflight?.[id] ?? []), ...(saved.queues?.[id] ?? [])].filter((i) => this.fresh(id, i));
      if (!items.length) continue;
      this.queues.set(id, items.slice(-MAX_QUEUE));
      restored += items.length;
    }
    if (restored) {
      this.hub.activity("config", null, `HQ restored ${restored} waiting message${restored === 1 ? "" : "s"} for ${[...this.queues.keys()].map((id) => this.hub.name(id)).join(", ")}.`);
      this.save();
    }
  }

  /** Still worth delivering: not too old, and an assignment only while the task is still that agent's. */
  private fresh(agentId: string, item: InboxItem): boolean {
    if (item.at && Date.now() - Date.parse(item.at) > MAX_AGE_MS) return false;
    if (item.kind === "assign" && item.taskId) {
      const task = this.hub.snap.tasks.find((t) => t.id === item.taskId);
      if (!task || task.ownerId !== agentId || task.status === "done") return false;
    }
    return true;
  }

  private save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    this.saveTimer.unref();
  }

  /** Writes now (HQ is stopping, or the delay is up). */
  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const stored: Stored = { queues: {}, inflight: {} };
    for (const [id, q] of this.queues) if (q.length) stored.queues[id] = q;
    for (const [id, q] of this.inflight) if (q.length) stored.inflight[id] = q;
    // A temp file renamed over the old one, so a crash can't leave half a file. Messages can hold work details: owner only.
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(stored, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      log.warn("could not save inbox.json:", err);
    }
  }

  push(agentId: string, item: InboxItem) {
    const q = this.queues.get(agentId) ?? [];
    q.push({ ...item, at: item.at ?? new Date().toISOString() });
    if (q.length > MAX_QUEUE) q.splice(0, q.length - MAX_QUEUE);
    this.queues.set(agentId, q);
    this.save();
    void this.tryType(agentId);
  }

  /** When the agent's last hook arrived (0 if never). */
  lastHookAt(agentId: string): number {
    return this.lastHook.get(agentId) ?? 0;
  }

  pending(agentId: string) {
    return this.queues.get(agentId)?.length ?? 0;
  }

  /** Every hook event goes through here (before the state change it causes). */
  noteHook(agentId: string, event: string) {
    this.lastHook.set(agentId, Date.now());
    if (event === "SessionStart") this.sessionUp.add(agentId);
    if (event === "SessionEnd") this.sessionUp.delete(agentId);
    if (event === "UserPromptSubmit") {
      this.lastSubmit.set(agentId, Date.now());
      // The agent answered what was typed: it has it.
      if (this.inflight.delete(agentId)) this.save();
    }
    if (event === "Stop" || event === "Idle" || event === "SessionStart" || event === "Notification") setTimeout(() => void this.tryType(agentId), QUIET_MS + 100);
  }

  /** An already-running session was reattached: its prompt exists even though HQ missed SessionStart. */
  sessionReattached(agentId: string) {
    this.sessionUp.add(agentId);
  }

  /** The session stopped or restarted: Claude Code's prompt is gone until the next SessionStart. */
  sessionDown(agentId: string) {
    this.sessionUp.delete(agentId);
    // What was typed into a session that ended before answering was probably lost with it: back in the queue.
    const lost = this.inflight.get(agentId);
    if (lost?.length) {
      this.inflight.delete(agentId);
      this.queues.set(agentId, [...lost, ...(this.queues.get(agentId) ?? [])].slice(-MAX_QUEUE));
      this.save();
    }
  }

  forget(agentId: string) {
    this.queues.delete(agentId);
    this.inflight.delete(agentId);
    this.sessionUp.delete(agentId);
    this.save();
  }

  /** Called from the Stop hook: everything queued, as the reason Claude continues with. */
  takeForStop(agentId: string): string | null {
    const q = (this.queues.get(agentId) ?? []).filter((i) => this.fresh(agentId, i));
    this.queues.set(agentId, []);
    this.save();
    return q.length ? this.format(q) : null;
  }

  private canType(agentId: string): boolean {
    const st = this.hub.status(agentId);
    return (
      !!st &&
      this.sessionUp.has(agentId) &&
      st.session.state === "running" &&
      st.state === "idle" &&
      // A usage limit wait: typing would cut Claude Code's wait short. An agent saving its work before the limit still gets messages.
      !(st.limitedUntil && Date.parse(st.limitedUntil) > Date.now() && st.limitPhase !== "winding-down") &&
      !this.typing.has(agentId) &&
      Date.now() - (this.lastHook.get(agentId) ?? 0) >= QUIET_MS
    );
  }

  private whyNot(agentId: string): string {
    const st = this.hub.status(agentId);
    return JSON.stringify({ up: this.sessionUp.has(agentId), session: st?.session.state, state: st?.state, note: st?.note, typing: this.typing.has(agentId), quietMs: Date.now() - (this.lastHook.get(agentId) ?? 0) });
  }

  /** Types queued items into an idle agent. Safe to call any time. */
  async tryType(agentId: string) {
    const q = this.queues.get(agentId);
    if (!q?.length) return;
    if (!this.canType(agentId)) {
      if (process.env.HQ_DEBUG) log.info(`inbox ${agentId}: holding ${q.length} — ${this.whyNot(agentId)}`);
      return;
    }
    const items = q.splice(0).filter((i) => this.fresh(agentId, i));
    if (!items.length) return this.save();
    this.typing.add(agentId);
    const typedAt = Date.now();
    // Kept on disk as "typed" until the agent's UserPromptSubmit says it has them (set before typing: the hook can come back first).
    this.inflight.set(agentId, [...(this.inflight.get(agentId) ?? []), ...items]);
    this.save();
    try {
      if (!(await this.keys.type(agentId, this.format(items)))) {
        log.warn(`could not type into ${agentId}; keeping ${items.length} message(s) queued`);
        this.inflight.set(agentId, (this.inflight.get(agentId) ?? []).filter((i) => !items.includes(i)));
        this.queues.set(agentId, [...items, ...(this.queues.get(agentId) ?? [])]);
        this.save();
        return;
      }
      // If the prompt didn't submit (Enter swallowed), press it once more.
      await new Promise((r) => setTimeout(r, SUBMIT_CHECK_MS));
      if ((this.lastSubmit.get(agentId) ?? 0) < typedAt && this.hub.status(agentId)?.state === "idle") {
        log.warn(`${agentId}: no prompt submit after typing; pressing Enter again`);
        await this.keys.enter(agentId);
      }
    } finally {
      this.typing.delete(agentId);
    }
  }

  private format(items: InboxItem[]): string {
    const lines = items.map((i) =>
      i.kind === "message" ? `[HQ] Message from ${this.hub.name(i.fromId)}: ${i.text}` : `[HQ] ${i.text}`,
    );
    const fromAgent = items.some((i) => i.kind === "message" && i.fromId !== "you");
    // Claude Code submits on newline, so everything goes on one line.
    return (lines.join("  ·  ") + (fromAgent ? "  (Reply with the hq send_message tool only if a reply is needed.)" : "")).replace(/\s*\n\s*/g, " ");
  }
}
