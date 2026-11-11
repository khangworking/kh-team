import { budgetLevel, formatUsd } from "../../data/budget";
import { ACCOUNT_LABEL, formatReset, LIMIT_WARN_AT } from "../../data/limits";
import { PROVIDER_INFO } from "../../data/providers";
import type { SimSpeed } from "../../data/source";
import { officeActions, selectAttention, useOffice } from "../../store/office";
import { ui, useUi } from "../../store/ui";

const SPEEDS: SimSpeed[] = [1, 2, 4];

function Logo() {
  return (
    <svg className="h-[30px] w-[30px] shrink-0" viewBox="0 0 10 10" shapeRendering="crispEdges" aria-hidden>
      <rect x="1" y="1" width="8" height="8" fill="#241a2e" />
      <rect x="2" y="2" width="6" height="6" fill="#29adff" />
      <rect x="3" y="3" width="1" height="2" fill="#fff6e9" />
      <rect x="6" y="3" width="1" height="2" fill="#fff6e9" />
      <rect x="3" y="6" width="4" height="1" fill="#1d2b53" />
      <rect x="4" y="0" width="2" height="1" fill="#ffec27" />
    </svg>
  );
}

export function TopBar() {
  const snap = useOffice((s) => s.snap);
  const speed = useOffice((s) => s.speed);
  const hasDev = useOffice((s) => s.presets !== null);
  const planBoardId = useUi((s) => s.planBoardId);
  const attention = selectAttention(snap).total;
  const debugOpen = useUi((s) => s.debugOpen);
  const live = useOffice((s) => s.live);
  if (!snap) return null;
  const setupIssues = snap.setup.checks.filter((c) => c.status !== "ok").length;
  const stopped = snap.agents.filter((a) => a.session.state === "stopped" || a.session.state === "failed");

  // Live: count real running sessions. Mock: every agent counts as running.
  const runningIds = new Set(snap.agents.filter((a) => a.session.state === "running").map((a) => a.agentId));
  const sandboxes = snap.config.team.filter((a) => a.mode === "sandbox" && runningIds.has(a.id)).length;
  const local = snap.config.team.filter((a) => a.mode === "local" && runningIds.has(a.id)).length;
  const boards = [...snap.boards].sort((a, b) => a.order - b.order);
  const active = boards.filter((b) => b.status === "active");
  const openPrs = snap.pullRequests.filter((p) => !p.merged && !p.closed).length;
  // Spend only matters once an agent pays per call: an API key for a hosted provider (Ollama is free).
  const budget = snap.budget;
  const paid = snap.config.team.some((a) => a.auth === "apiKey" && PROVIDER_INFO[a.provider].keyVar);
  const level = budget ? budgetLevel(budget.spentUsd, budget.dailyUsd) : "ok";

  return (
    <header className="panel fixed left-4 right-4 top-[10px] z-10 flex h-[50px] items-center gap-4 px-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <Logo />
        <b className="whitespace-nowrap text-[22px] font-bold tracking-[0.02em]">JSM HQ</b>
        {!live && (
          <span className="chip shrink-0 text-[12px]" style={{ ["--c" as string]: "#ffec27" }} title="Running on mock data. Start the real HQ with `pnpm dev:hq`.">
            Demo data
          </span>
        )}
        <span className="truncate text-[16px] text-muted">
          — <em className="font-semibold not-italic text-ink">{snap.config.project.name}</em>{" "}
          <span className="font-term text-[17px]">{snap.config.project.repo}</span>
        </span>
      </div>
      <div className="flex-1" />

      <label className="flex items-center gap-2 text-[14px]">
        <span className="text-muted">Plan wall</span>
        <select
          className="field w-[190px] py-0 text-[14px]"
          value={planBoardId ?? ""}
          onChange={(e) => ui.showBoardOnWall(e.target.value || null)}
          aria-label="Board shown on the plan wall"
        >
          <option value="">First active ({active[0]?.title ?? "none"})</option>
          {boards.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title} · {b.status}
            </option>
          ))}
        </select>
      </label>

      {hasDev && (
        <div className="flex items-center gap-1.5" role="group" aria-label="Simulation speed">
          {SPEEDS.map((s) => (
            <button key={s} className="btn px-2 text-[14px]" aria-pressed={speed === s} onClick={() => officeActions.setSpeed(s)}>
              {s}x
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-1.5">
        <button className="btn w-8 px-0 text-[18px] leading-none" aria-label="Zoom out" onClick={() => ui.zoom(-1)}>
          −
        </button>
        <button className="btn w-8 px-0 text-[18px] leading-none" aria-label="Zoom in" onClick={() => ui.zoom(1)}>
          +
        </button>
      </div>

      {live &&
        (snap.rateLimits ?? []).map((l) => {
          const blocked = l.blockedUntil && Date.parse(l.blockedUntil) > Date.now();
          const top = Object.entries(l.windows).sort((a, b) => b[1].usedPct - a[1].usedPct)[0];
          if (!blocked && !(top && top[1].usedPct >= LIMIT_WARN_AT)) return null;
          const name = top?.[0] === "sevenDay" ? "weekly" : "5h";
          return (
            <span
              key={l.account}
              className={`chip whitespace-nowrap text-[13px] ${blocked ? "bg-red text-white" : "bg-yellow"}`}
              title={
                blocked
                  ? `${ACCOUNT_LABEL[l.account]} usage limit reached. HQ waits for the reset${l.guessed ? " (the time is a guess; HQ looks again then)" : ""}, holds messages for these agents and tells the lead not to assign them work.`
                  : `${ACCOUNT_LABEL[l.account]}: the ${name} usage window is ${Math.round(top![1].usedPct)}% used. It resets ${formatReset(top![1].resetsAt)}.`
              }
            >
              {ACCOUNT_LABEL[l.account]} · {blocked ? `limit, back ${formatReset(l.blockedUntil!)}` : `${name} ${Math.round(top![1].usedPct)}%`}
            </span>
          );
        })}

      {live && budget && (paid || budget.spentUsd > 0) && (
        <button
          className={`btn whitespace-nowrap text-[14px] ${level === "over" ? "bg-red text-white" : level === "warn" ? "bg-yellow" : ""}`}
          onClick={() => ui.openSettings("workflow")}
          title={`Spent today by agents that use an API key${budget.dailyUsd > 0 ? `, of a ${formatUsd(budget.dailyUsd)} daily budget` : " (no daily limit)"}. Click to change the budget.`}
        >
          Today · <b>{formatUsd(budget.spentUsd)}</b>
          {budget.dailyUsd > 0 ? ` / ${formatUsd(budget.dailyUsd)}` : ""}
        </button>
      )}

      <div
        className="flex items-center gap-2 whitespace-nowrap border-[3px] border-ink bg-navy px-2.5 py-0.5 text-[15px] text-cream"
        title="Each agent runs in its own isolated Docker Sandbox (microVM)"
      >
        <span>
          Sandbox · <b>{sandboxes}</b> running{local ? ` · ${local} local` : ""}
        </span>
        <i className="led" style={runningIds.size ? undefined : { background: "#83769c", animation: "none" }} />
      </div>

      {live && stopped.length > 0 && (
        <button className="btn text-[14px]" onClick={() => stopped.forEach((a) => officeActions.startAgent(a.agentId))}>
          Start {stopped.length === snap.agents.length ? "team" : `${stopped.length} stopped`}
        </button>
      )}
      {live && (
        <button className="btn text-[14px]" onClick={() => ui.openSetup()} title="Setup checklist">
          Setup{setupIssues ? ` · ${setupIssues}` : " ✓"}
        </button>
      )}
      <div className="flex gap-1.5">
        <button
          className="btn text-[14px]"
          style={attention ? { background: "#ffec27" } : undefined}
          onClick={() => ui.openActions()}
          title="Everything waiting on you"
        >
          Action items{attention ? ` · ${attention}` : ""}
        </button>
        <button className="btn text-[14px]" onClick={() => ui.openBoards(planBoardId ?? undefined)}>
          Boards
        </button>
        <button className="btn text-[14px]" onClick={() => ui.openPrs()}>
          PRs{openPrs ? ` · ${openPrs}` : ""}
        </button>
        <button className="btn text-[14px]" onClick={() => ui.openTerminal()} title="Your own shell on this machine: the repo, an agent's folder or any folder">
          Terminal
        </button>
      </div>
      <button className="btn text-[14px]" onClick={() => ui.openSettings("team")}>
        Settings
      </button>
      <button className="btn text-[14px]" aria-pressed={debugOpen} onClick={() => ui.toggleDebug()} title="Debug panel (D)">
        Debug
      </button>
    </header>
  );
}
