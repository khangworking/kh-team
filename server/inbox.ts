// Delivery to agents. If the agent is idle at its prompt, HQ types the message
// into its terminal. If it's busy, the message waits and is handed over by the
// agent's Stop hook when its turn ends (Claude Code then continues with it).

import type { Hub } from "./hub";
import { log } from "./lib/log";

export interface InboxItem {
  fromId: string; // agent id or "you"
  text: string;
  kind: "message" | "assign" | "notice"; // notice = from HQ itself (e.g. review results)
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
  private timer: NodeJS.Timeout;

  constructor(private hub: Hub, private keys: Keyboard) {
    // Safety net: retry anything queued for agents that have gone idle.
    this.timer = setInterval(() => {
      for (const id of this.queues.keys()) void this.tryType(id);
    }, 2000);
  }

  stop() {
    clearInterval(this.timer);
  }

  push(agentId: string, item: InboxItem) {
    const q = this.queues.get(agentId) ?? [];
    q.push(item);
    this.queues.set(agentId, q);
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
    if (event === "UserPromptSubmit") this.lastSubmit.set(agentId, Date.now());
    if (event === "Stop" || event === "Idle" || event === "SessionStart" || event === "Notification") setTimeout(() => void this.tryType(agentId), QUIET_MS + 100);
  }

  /** An already-running session was reattached: its prompt exists even though HQ missed SessionStart. */
  sessionReattached(agentId: string) {
    this.sessionUp.add(agentId);
  }

  /** The session stopped or restarted: Claude Code's prompt is gone until the next SessionStart. */
  sessionDown(agentId: string) {
    this.sessionUp.delete(agentId);
  }

  forget(agentId: string) {
    this.queues.delete(agentId);
    this.sessionUp.delete(agentId);
  }

  /** Called from the Stop hook: everything queued, as the reason Claude continues with. */
  takeForStop(agentId: string): string | null {
    const q = this.queues.get(agentId);
    if (!q?.length) return null;
    this.queues.set(agentId, []);
    return this.format(q);
  }

  private canType(agentId: string): boolean {
    const st = this.hub.status(agentId);
    return (
      !!st &&
      this.sessionUp.has(agentId) &&
      st.session.state === "running" &&
      st.state === "idle" &&
      !(st.limitedUntil && Date.parse(st.limitedUntil) > Date.now()) && // a usage limit wait: typing would cut Claude Code's wait short
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
    const items = q.splice(0);
    this.typing.add(agentId);
    const typedAt = Date.now();
    try {
      if (!(await this.keys.type(agentId, this.format(items)))) {
        log.warn(`could not type into ${agentId}; keeping ${items.length} message(s) queued`);
        this.queues.set(agentId, [...items, ...(this.queues.get(agentId) ?? [])]);
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
