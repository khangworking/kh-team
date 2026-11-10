// Action items: things an agent needs the user to do outside its sandbox
// (create a database, put a key in an env file, change a dashboard setting).
// Agents add them with the Team MCP tool `ask_user`; the user closes them in HQ,
// and HQ tells the agent so it can continue. Kept on this Mac, never committed.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionItem } from "../src/data/types";
import type { Hub } from "./hub";
import { parseCliJson } from "./lib/json";
import { projectHome } from "./paths";
import type { Planner } from "./planner";

const KEEP_CLOSED = 100;

export class ActionItems {
  private file: string;
  private seq = 0;

  constructor(private hub: Hub, private planner: Planner) {
    this.file = join(projectHome(hub.slug), "action-items.json");
    const saved = existsSync(this.file) ? parseCliJson<ActionItem[]>(readFileSync(this.file, "utf8")) : null;
    hub.snap.actionItems = Array.isArray(saved) ? saved : [];
  }

  private get items(): ActionItem[] {
    return (this.hub.snap.actionItems ??= []);
  }

  private save() {
    const open = this.items.filter((i) => i.status === "open");
    const closed = this.items.filter((i) => i.status !== "open").slice(0, KEEP_CLOSED);
    this.hub.snap.actionItems = [...open, ...closed].sort((a, b) => b.at.localeCompare(a.at));
    // Write a temp file and rename it over, so a crash mid-save can't leave a half-written list.
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.hub.snap.actionItems, null, 2));
    renameSync(tmp, this.file);
  }

  add(fromId: string, title: string, details: string, waiting: boolean): ActionItem {
    const clean = title.trim().replace(/\s+/g, " ").slice(0, 160);
    if (!clean) throw new Error("Give the action item a short title.");
    const item: ActionItem = {
      id: `ai${Date.now().toString(36)}${++this.seq}`,
      fromId,
      taskId: fromId === "hq" ? null : (this.planner.currentTask(fromId)?.id ?? null),
      title: clean,
      details: details.trim().slice(0, 4000),
      waiting,
      status: "open",
      note: null,
      at: new Date().toISOString(),
      closedAt: null,
    };
    this.items.unshift(item);
    this.save();
    this.hub.emit({ type: "action.updated", item: { ...item } });
    this.hub.activity("agent.needs-input", fromId, `${this.hub.name(fromId)} added an action item${waiting ? " (waiting)" : ""}: ${clean}`);
    return item;
  }

  resolve(id: string, decision: "done" | "dismissed", note?: string) {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.status !== "open") return;
    item.status = decision;
    item.note = note?.trim().slice(0, 1000) || null;
    item.closedAt = new Date().toISOString();
    this.save();
    this.hub.emit({ type: "action.updated", item: { ...item } });
    const n = item.note ? ` Note from the user: ${item.note}` : "";
    if (decision === "done") this.planner.notify(item.fromId, `The user did your action item "${item.title}".${n} Continue with it.`);
    else this.planner.notify(item.fromId, `The user dismissed your action item "${item.title}".${n} Continue without it, or find another way.`);
  }
}
