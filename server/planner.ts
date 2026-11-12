// Boards, tasks, assignments and messages. Used by both the Team MCP tools
// (agents) and the browser commands (you), so both follow the same rules.

import { formatReset } from "../src/data/limits";
import type { Board, Task, TaskStatus } from "../src/data/types";
import type { Hub } from "./hub";
import type { ActionItems } from "./actionItems";
import type { Inbox } from "./inbox";

export interface NewTask {
  boardId?: string;
  title: string;
  description?: string;
  files?: string[];
  doneWhen?: string;
  needs?: string[];
}

export type TaskPatch = Partial<Pick<Task, "title" | "description" | "files" | "doneWhen" | "needs" | "status" | "boardId" | "note" | "prNumber" | "ownerId" | "hold">>;

const now = () => new Date().toISOString();

export class Planner {
  private seq = 0;
  /** Set by main: the user's action items (Team MCP `ask_user`). */
  actions: ActionItems | null = null;

  constructor(private hub: Hub, private inbox: Inbox) {}

  private get snap() {
    return this.hub.snap;
  }

  task(id: string): Task | undefined {
    return this.snap.tasks.find((t) => t.id.toLowerCase() === id.trim().toLowerCase());
  }

  /** An agent by id or (case-insensitive) name; "lead" means the lead. */
  agentId(ref: string): string | null {
    const r = ref.trim().toLowerCase();
    const team = this.snap.config.team;
    if (r === "lead") return team.find((a) => a.isLead)?.id ?? null;
    return team.find((a) => a.id === r || a.name.toLowerCase() === r)?.id ?? null;
  }

  defaultBoard(): Board {
    const active = this.snap.boards.filter((b) => b.status === "active").sort((a, b) => a.order - b.order);
    if (active[0]) return active[0];
    return this.createBoard("Backlog", "active");
  }

  // ------------------------------------------------------------ boards

  createBoard(title: string, status: Board["status"] = "planned"): Board {
    const clean = title.trim().slice(0, 80) || "Board";
    const base = clean.split(/\s+/).map((w) => w[0]).join("").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3) || "B";
    let id = base;
    for (let i = 2; this.snap.boards.some((b) => b.id === id); i++) id = `${base}${i}`;
    const board: Board = { id, title: clean, status, order: this.snap.boards.length };
    this.snap.boards.push(board);
    this.hub.emit({ type: "board.updated", board: { ...board } });
    this.hub.planChanged();
    return board;
  }

  updateBoard(id: string, patch: Partial<Pick<Board, "title" | "status">>) {
    const board = this.snap.boards.find((b) => b.id === id);
    if (!board) throw new Error(`No board ${id}`);
    if (patch.title?.trim()) board.title = patch.title.trim().slice(0, 80);
    if (patch.status) board.status = patch.status;
    this.hub.emit({ type: "board.updated", board: { ...board } });
    this.hub.planChanged();
    return board;
  }

  // ------------------------------------------------------------ tasks

  createTask(input: NewTask, byId: string): Task {
    const board = input.boardId ? this.snap.boards.find((b) => b.id === input.boardId) : this.defaultBoard();
    if (!board) throw new Error(`No board ${input.boardId}. Boards: ${this.snap.boards.map((b) => b.id).join(", ")}`);
    let n = this.snap.tasks.filter((t) => t.boardId === board.id).length + 1;
    let id = `${board.id}-T${String(n).padStart(2, "0")}`;
    while (this.task(id)) id = `${board.id}-T${String(++n).padStart(2, "0")}`;
    const task: Task = {
      id, boardId: board.id, title: input.title.trim().slice(0, 120), ownerId: null, status: "todo",
      needs: input.needs ?? [], prNumber: null, description: input.description ?? "", files: input.files ?? [], doneWhen: input.doneWhen ?? "", note: null,
    };
    this.snap.tasks.push(task);
    this.hub.emit({ type: "task.updated", task: { ...task } });
    this.hub.activity("task.created", byId === "you" ? null : byId, `${this.hub.name(byId)} added ${task.id} ${task.title}`);
    this.hub.planChanged();
    return task;
  }

  updateTask(id: string, patch: TaskPatch): Task {
    const task = this.task(id);
    if (!task) throw new Error(`No task ${id}`);
    Object.assign(task, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    if (task.status === "done") {
      for (const a of this.snap.agents) if (a.currentTaskId === task.id) this.hub.setStatus(a.agentId, { currentTaskId: null });
    }
    this.hub.emit({ type: "task.updated", task: { ...task } });
    this.hub.planChanged();
    return task;
  }

  /** Gives a task to an agent and tells them to start. */
  assign(taskId: string, agentRef: string, byId: string): Task {
    const task = this.task(taskId);
    const agentId = this.agentId(agentRef);
    if (!task) throw new Error(`No task ${taskId}`);
    if (!agentId) throw new Error(`No agent "${agentRef}". Team: ${this.snap.config.team.map((a) => a.id).join(", ")}`);
    const agent = this.hub.cfg(agentId)!;
    if (agent.reviewer) throw new Error(`${agent.name} only reviews PRs and takes no tasks. Assign someone else.`);
    // A task HQ put back after its agent ran out of credit is assigned again only when the user says so.
    if (task.hold && byId !== "you") throw new Error(`${task.id} is on hold (${task.hold}). Only the user assigns it again: leave it in todo until they say so.`);
    if (this.hub.status(agentId)?.outOfCredit && byId !== "you") throw new Error(`${agent.name} is out of credit and can't work until the user adds credit and restarts it. Assign someone else.`);
    const limited = this.hub.status(agentId)?.limitedUntil;
    if (limited && Date.parse(limited) > Date.now()) throw new Error(`${agent.name} has hit its usage limit and can't work until ${formatReset(limited)}. Assign someone else, or wait.`);
    task.ownerId = agentId;
    task.hold = null; // the user decided
    if (task.status === "done") task.status = "todo";
    this.hub.emit({ type: "task.updated", task: { ...task } });
    this.hub.setStatus(agentId, { currentTaskId: task.id });
    this.hub.planChanged();
    this.hub.activity("task.assigned", byId === "you" ? null : byId, `${this.hub.name(byId)} assigned ${task.id} ${task.title} to ${agent.name}`);
    const by = byId === "you" ? "The user (your human)" : this.hub.name(byId);
    const text = `${by} assigned you ${task.id} (${task.title}). Pull main, start ${task.id}. Call the hq get_my_task tool for the details.`;
    this.record(byId, agentId, `Start ${task.id}: ${task.title}`);
    this.inbox.push(agentId, { fromId: byId, kind: "assign", text, taskId: task.id });
    return task;
  }

  setStatus(agentId: string, status: Extract<TaskStatus, "in-progress" | "blocked" | "in-review" | "done">, note?: string, prNumber?: number): Task {
    const task = this.currentTask(agentId);
    if (!task) throw new Error("You have no task. Ask the lead for one.");
    task.status = status;
    task.note = note?.slice(0, 1000) || null;
    if (prNumber) task.prNumber = prNumber;
    if (status === "done") this.hub.setStatus(agentId, { currentTaskId: null });
    else this.hub.setStatus(agentId, { currentTaskId: task.id });
    this.hub.emit({ type: "task.updated", task: { ...task } });
    this.hub.planChanged();
    const name = this.hub.name(agentId);
    const words = { "in-progress": "started", blocked: "is blocked on", "in-review": "sent for review", done: "finished" }[status];
    this.hub.activity(status === "blocked" ? "agent.needs-input" : "task.started", agentId, `${name} ${words} ${task.id}${note ? `: ${note}` : ""}`);
    // Let the lead know when work is blocked or ready for review.
    const lead = this.snap.config.team.find((a) => a.isLead);
    if (lead && lead.id !== agentId && (status === "blocked" || status === "in-review" || status === "done"))
      this.message(agentId, lead.id, `${task.id} ${words}${note ? `: ${note}` : ""}${prNumber ? ` (PR #${prNumber})` : ""}`);
    return task;
  }

  currentTask(agentId: string): Task | undefined {
    const st = this.hub.status(agentId);
    const byCurrent = st?.currentTaskId ? this.task(st.currentTaskId) : undefined;
    if (byCurrent && byCurrent.ownerId === agentId) return byCurrent;
    const mine = this.snap.tasks.filter((t) => t.ownerId === agentId && t.status !== "done");
    return mine.find((t) => t.status === "in-progress") ?? mine.find((t) => t.status === "todo") ?? mine[0];
  }

  // ------------------------------------------------------------ messages

  /** Records a message, shows it in the office, and delivers it. */
  message(fromId: string, toRef: string, text: string) {
    const toId = this.agentId(toRef);
    if (!toId) throw new Error(`No agent "${toRef}". Team: ${this.snap.config.team.map((a) => a.id).join(", ")}`);
    const clean = text.trim().slice(0, 2000);
    if (!clean) throw new Error("Empty message");
    // The lead can't hand a held task over by message either: that is the same as assigning it.
    if (this.hub.cfg(fromId)?.isLead) {
      const held = this.snap.tasks.find((t) => t.hold && new RegExp(`(^|[^A-Za-z0-9-])${t.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9-])`, "i").test(clean));
      if (held) throw new Error(`${held.id} is on hold (${held.hold}). Don't ask anyone to work on it: only the user decides when it is assigned again. Tell the user in your reply instead.`);
    }
    this.record(fromId, toId, clean);
    this.hub.activity("message", fromId === "you" ? null : fromId, `${this.hub.name(fromId)} → ${this.hub.name(toId)}: ${clean.slice(0, 80)}`);
    this.inbox.push(toId, { fromId, kind: "message", text: clean });
    return toId;
  }

  /** A notice from HQ itself (review results, merges) to one agent. */
  notify(agentId: string, text: string) {
    if (!this.hub.cfg(agentId)) return;
    this.record("hq", agentId, text);
    this.inbox.push(agentId, { fromId: "hq", kind: "notice", text });
  }

  private record(fromId: string, toId: string, text: string) {
    this.seq += 1;
    const msg = { id: `m${Date.now().toString(36)}${this.seq}`, at: now(), fromId, toId, text };
    this.snap.messages = [msg, ...this.snap.messages].slice(0, 100);
    this.hub.emit({ type: "message", message: msg });
  }
}
