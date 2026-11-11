import { useState } from "react";
import type { BoardStatus, Task, TaskStatus } from "../../data/types";
import { officeActions, useOffice } from "../../store/office";
import { ui, useUi } from "../../store/ui";
import { Dot } from "../kit";
import { DrawerHeader } from "./Drawer";

const COLUMNS: { id: TaskStatus; label: string; color: string }[] = [
  { id: "todo", label: "To do", color: "#83769c" },
  { id: "in-progress", label: "Doing", color: "#29adff" },
  { id: "in-review", label: "Review", color: "#ffa300" },
  { id: "done", label: "Done", color: "#00e436" },
  { id: "blocked", label: "Blocked", color: "#ff004d" },
];

const STATUS_LABEL: Record<BoardStatus, string> = { active: "Active", planned: "Planned", done: "Done" };

export function BoardsDrawer({ initialBoardId }: { initialBoardId?: string }) {
  const snap = useOffice((s) => s.snap);
  const planBoardId = useUi((s) => s.planBoardId);
  const boards = [...(snap?.boards ?? [])].sort((a, b) => a.order - b.order);
  const [boardId, setBoardId] = useState(initialBoardId ?? boards.find((b) => b.status === "active")?.id ?? boards[0]?.id);
  if (!snap) return null;
  const board = boards.find((b) => b.id === boardId);
  const tasks = snap.tasks.filter((t) => t.boardId === boardId);
  const cols = COLUMNS.filter((c) => c.id !== "blocked" || tasks.some((t) => t.status === "blocked"));
  const shownOnWall = (planBoardId ?? boards.find((b) => b.status === "active")?.id) === boardId;

  return (
    <>
      <DrawerHeader>
        <b className="text-[18px]">Boards</b>
        <span className="text-[14px] text-muted">{boards.length} in {snap.config.project.name}</span>
      </DrawerHeader>
      <div className="flex flex-wrap gap-1.5 border-b-[3px] border-ink px-3 py-2">
        {boards.map((b) => (
          <button key={b.id} className="btn px-2 text-[13px]" aria-pressed={b.id === boardId} onClick={() => setBoardId(b.id)}>
            {b.status === "active" && <span className="mr-1 text-blue">●</span>}
            {b.title}
          </button>
        ))}
      </div>
      {board && (
        <div className="flex items-center gap-2 border-b-[3px] border-ink bg-cream-2 px-3 py-1.5 text-[14px]">
          <span className="text-muted">Status</span>
          <select
            className="field w-[120px] py-0 text-[14px]"
            value={board.status}
            onChange={(e) => officeActions.updateBoard(board.id, { status: e.target.value as BoardStatus })}
          >
            {(Object.keys(STATUS_LABEL) as BoardStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <span className="text-[12px] text-muted">Agents only pick tasks from active boards.</span>
          <button className="btn ml-auto px-2 text-[13px]" disabled={shownOnWall} onClick={() => ui.showBoardOnWall(board.id)}>
            {shownOnWall ? "On the wall" : "Show on wall"}
          </button>
        </div>
      )}
      <div className="scroll-thin grid min-h-0 flex-1 auto-cols-[minmax(200px,1fr)] grid-flow-col gap-2 overflow-auto bg-[#f7f3ea] p-3">
        {cols.map((c) => {
          const list = tasks.filter((t) => t.status === c.id);
          if (c.id === "done") list.reverse();
          return (
            <div key={c.id} className="min-w-0">
              <h4 className="mb-2 flex justify-between border-b-[3px] pb-0.5 text-[14px] font-semibold" style={{ borderColor: c.color }}>
                {c.label} <span className="font-term text-[17px] text-muted">{list.length}</span>
              </h4>
              <div className="flex flex-col gap-2">
                {list.map((t) => (
                  <TaskCard key={t.id} task={t} />
                ))}
              </div>
            </div>
          );
        })}
        {tasks.length === 0 && <p className="col-span-full p-6 text-center text-muted">No tasks on this board yet. The lead adds tasks when a board is active.</p>}
      </div>
    </>
  );
}

function TaskCard({ task }: { task: Task }) {
  const snap = useOffice((s) => s.snap);
  const owner = snap?.config.team.find((a) => a.id === task.ownerId);
  const workers = snap?.config.team.filter((a) => !a.isLead) ?? [];
  const blockedBy = task.needs.filter((n) => snap?.tasks.find((t) => t.id === n)?.status !== "done");
  return (
    <div className={`border-2 border-ink px-2 py-1.5 shadow-[0_3px_0_rgba(36,26,46,0.35)] ${task.status === "done" ? "bg-[#e8e1d2] text-muted" : "bg-white"}`}>
      <div className="font-term text-[16px] leading-none text-muted">
        {task.id}
        {task.prNumber && <span className="ml-1.5">#{task.prNumber}</span>}
      </div>
      <div
        className={`text-[14px] font-semibold leading-tight ${task.status === "done" ? "line-through" : ""}`}
        title={[task.description, task.files?.length ? `Files: ${task.files.join(", ")}` : "", task.doneWhen ? `Done when: ${task.doneWhen}` : ""].filter(Boolean).join("\n\n") || undefined}
      >
        {task.title}
      </div>
      {task.status === "blocked" && task.note && <div className="text-[12px] text-red">{task.note}</div>}
      {task.hold && (
        <div className="mt-1 border-2 border-red bg-[#ffe1ea] px-1.5 py-0.5 text-[12px] text-red" title={task.note ?? undefined}>
          On hold: {task.hold}. It stays unassigned until you assign it. Hover for the summary of the work so far.
        </div>
      )}
      <div className="mt-1 flex items-center gap-1.5 text-[12px]">
        {owner ? (
          <>
            <Dot color={owner.color} size={8} /> {owner.name}
          </>
        ) : (
          <span className="text-muted">Unassigned</span>
        )}
      </div>
      {blockedBy.length > 0 && task.status === "todo" && <div className="text-[12px] text-red">Waits on {blockedBy.join(", ")}</div>}
      {task.status === "todo" && (
        <select
          className="field mt-1 py-0 text-[12px]"
          value=""
          onChange={(e) => e.target.value && officeActions.assignTask(task.id, e.target.value)}
          aria-label={`Assign ${task.id}`}
        >
          <option value="">Assign to…</option>
          {workers.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.role})
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
