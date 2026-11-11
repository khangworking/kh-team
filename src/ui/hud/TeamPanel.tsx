import { formatReset, LIMIT_WARN_AT } from "../../data/limits";
import { PROVIDER_INFO } from "../../data/providers";
import { CLI_LABEL } from "../../data/types";
import { selectTeam, useOffice, type AgentView } from "../../store/office";
import { ui, useUi } from "../../store/ui";
import { stateStyle } from "../../theme/tokens";
import { ago, Portrait, StateChip, useNow } from "../kit";

function AgentCard({ a, focused, n, now }: { a: AgentView; focused: boolean; n: number; now: number }) {
  const snap = useOffice((s) => s.snap);
  const task = a.status.currentTaskId ? snap?.tasks.find((t) => t.id === a.status.currentTaskId) : null;
  const st = stateStyle[a.status.state];
  const usageTop = Object.entries(snap?.rateLimits?.find((l) => l.agentId === a.config.id)?.windows ?? {}).sort((x, y) => y[1].usedPct - x[1].usedPct)[0];
  const needs = a.status.state === "needs-input";
  const blocked = useOffice((s) => s.snap?.sbx.agents[a.config.id]?.approvals?.length ?? 0);
  const items = useOffice((s) => (s.snap?.actionItems ?? []).filter((i) => i.status === "open" && i.fromId === a.config.id).length);
  return (
    <button
      className={`panel relative grid w-full cursor-pointer grid-cols-[40px_1fr] gap-x-2.5 gap-y-1 px-2.5 pb-2.5 pt-2 text-left transition-transform hover:-translate-x-px hover:-translate-y-px ${needs ? "outline-[3px] outline-red" : ""}`}
      style={needs ? { outlineStyle: "solid" } : undefined}
      onClick={() => ui.openAgent(a.config.id)}
      aria-label={`${a.config.name}, ${a.config.role}, ${st.label}`}
    >
      {focused && <span className="absolute -left-4 top-4 text-[14px]">▶</span>}
      <div className="row-span-2">
        <Portrait color={a.config.color} lead={a.config.isLead} />
      </div>
      <div className="flex min-w-0 items-baseline gap-1.5">
        <b className="text-[17px]">{a.config.name}</b>
        <span className="truncate text-[13px] text-muted">
          {a.config.role} · {CLI_LABEL[a.config.cli]}
          {a.config.auth === "apiKey" ? ` · ${PROVIDER_INFO[a.config.provider].label}` : ""}
          {a.config.model ? ` · ${a.config.model}` : ""}
        </span>
        <span className="kbd ml-auto px-1 text-[13px] leading-none">{n}</span>
      </div>
      <div className="flex items-center gap-2">
        <StateChip state={a.status.state} />
        <span className="font-term text-[16px] text-muted">{ago(a.status.stateSince, now)}</span>
        {a.config.mode === "local" && <span className="chip text-[11px]">local</span>}
        {a.status.outOfCredit && (
          <span className="chip text-[11px]" style={{ background: "#ffd0dc" }} title={`${a.status.outOfCredit}. Add credit (or change the key), then restart ${a.config.name}.`}>
            no credit
          </span>
        )}
        {!(a.status.limitedUntil && Date.parse(a.status.limitedUntil) > now) && usageTop && usageTop[1].usedPct >= LIMIT_WARN_AT && (
          <span className="chip text-[11px]" style={{ background: "#fff1d6" }} title={`${usageTop[0] === "sevenDay" ? "Weekly" : "5-hour"} usage window. It resets ${formatReset(usageTop[1].resetsAt, now)}.`}>
            {usageTop[0] === "sevenDay" ? "week" : "5h"} {Math.round(usageTop[1].usedPct)}%
          </span>
        )}
        {a.status.limitedUntil && Date.parse(a.status.limitedUntil) > now && (
          <span
            className="chip text-[11px]"
            style={{ background: a.status.limitPhase === "blocked" ? "#ffd0dc" : "#ffec27" }}
            title={
              a.status.limitPhase === "winding-down"
                ? "Usage is nearly used up. This agent is saving its work (commit, draft PR, notes) before it pauses."
                : a.status.limitPhase === "paused"
                  ? "Usage is nearly used up and the work is saved. HQ holds this agent until the reset, then asks it to continue."
                  : "This subscription hit its usage limit. HQ holds messages and waits for the reset."
            }
          >
            {a.status.limitPhase === "winding-down" ? "saving work" : a.status.limitPhase === "paused" ? "paused" : "limit"} · back {formatReset(a.status.limitedUntil, now)}
          </span>
        )}
        {items > 0 && (
          <span className="chip text-[11px]" style={{ background: "#ffec27" }} title="Action items from this agent. Open Action items in the top bar.">
            {items} for you
          </span>
        )}
        {blocked > 0 && (
          <span className="chip text-[11px]" style={{ background: "#fff1d6" }} title="Requests the sandbox blocked. Open the agent to allow or dismiss them.">
            {blocked} blocked
          </span>
        )}
      </div>
      <div className={`col-span-2 mt-1 truncate text-[13px] ${task || needs ? "" : "text-muted"}`}>
        {needs ? (
          <span className="text-red">{a.status.note}</span>
        ) : task ? (
          <>
            <span className="mr-1 font-term text-[16px] text-muted">{task.id}</span>
            {task.title}
          </>
        ) : (
          a.status.note ?? "No task"
        )}
      </div>
    </button>
  );
}

export function TeamPanel() {
  const snap = useOffice((s) => s.snap);
  const drawer = useUi((s) => s.drawer);
  const now = useNow(1000);
  const team = selectTeam(snap);
  const needs = team.filter((a) => a.status.state === "needs-input").length;

  return (
    <section aria-label="Team" className="fixed bottom-[250px] left-4 top-[74px] z-10 flex w-[280px] flex-col gap-2">
      <div className="flex items-center justify-between px-1 text-[13px] font-semibold uppercase tracking-[0.12em] text-cream [text-shadow:0_2px_0_#241a2e]">
        <span>
          Team · {team.length}
          {needs > 0 && <span className="ml-2 text-yellow">{needs} need you</span>}
        </span>
        <button className="btn px-2 text-[12px] normal-case tracking-normal text-ink [text-shadow:none]" onClick={() => ui.openSettings("team")}>
          + Agent
        </button>
      </div>
      <div className="scroll-thin flex min-h-0 flex-col gap-2.5 overflow-y-auto pb-2 pl-4 -ml-4 pr-1">
        {team.map((a, i) => (
          <AgentCard key={a.config.id} a={a} n={i + 1} now={now} focused={drawer?.kind === "agent" && drawer.id === a.config.id} />
        ))}
      </div>
    </section>
  );
}
