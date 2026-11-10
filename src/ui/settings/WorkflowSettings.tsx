import { budgetLevel, formatUsd } from "../../data/budget";
import type { DeployTool, ReviewTool } from "../../data/types";
import { deployToolLabel, officeActions, reviewToolLabel, useOffice } from "../../store/office";
import { Field, SectionTitle } from "../kit";
import { CommitInput, Toggle } from "./controls";

const REVIEW_HINT: Record<ReviewTool, string> = {
  coderabbit: "Reads CodeRabbit's check and comments on each PR.",
  greptile: "Reads Greptile's review status and comments.",
  copilot: "Reads GitHub Copilot code review results.",
  human: "A person reviews. HQ waits for an approving GitHub review.",
  custom: "Runs your command; exit code 0 = passed, anything else = changes.",
};

export function WorkflowSettings() {
  const wf = useOffice((s) => s.snap?.config.workflow);
  const budget = useOffice((s) => s.snap?.budget);
  const team = useOffice((s) => s.snap?.config.team);
  // Deploy isn't built in real HQ yet (only the demo shows environments), so it's shown as coming soon.
  const live = useOffice((s) => s.live);
  if (!wf) return null;
  const stage = (name: string, on: boolean, detail: string) => (
    <span className={`border-[3px] border-ink px-2 py-0.5 ${on ? "bg-white" : "bg-cream-2 text-muted line-through"}`}>
      <b>{name}</b> <span className="text-[12px]">{detail}</span>
    </span>
  );

  return (
    <div className="flex flex-col gap-6">
      <section>
        <SectionTitle>Pipeline</SectionTitle>
        <div className="flex flex-wrap items-center gap-2 text-[14px]">
          {stage("Build", true, "agent in its sandbox")}
          <span>→</span>
          {stage("Review", wf.review.enabled, reviewToolLabel[wf.review.tool])}
          <span>→</span>
          {stage("Merge", true, wf.merge.by === "lead" ? "by the lead" : "by you")}
          <span>→</span>
          {live ? (
            <span className="border-[3px] border-dashed border-ink bg-cream-2 px-2 py-0.5 text-muted">
              <b>Deploy</b> <span className="text-[12px]">coming soon</span>
            </span>
          ) : (
            stage("Deploy", wf.deploy.enabled, deployToolLabel[wf.deploy.tool])
          )}
        </div>
        <p className="mt-2 text-[13px] text-muted">One task = one branch = one PR. HQ only reads results from these tools; it never merges or deploys itself.</p>
      </section>

      <section className="border-[3px] border-ink bg-white p-3">
        <div className="mb-3 flex items-center justify-between">
          <SectionTitle>Review</SectionTitle>
          <Toggle checked={wf.review.enabled} onChange={(v) => officeActions.updateWorkflow({ review: { enabled: v } })} label={wf.review.enabled ? "On" : "Off"} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Tool" hint={REVIEW_HINT[wf.review.tool]}>
            <select
              className="field"
              disabled={!wf.review.enabled}
              value={wf.review.tool}
              onChange={(e) => officeActions.updateWorkflow({ review: { tool: e.target.value as ReviewTool } })}
            >
              {(Object.keys(reviewToolLabel) as ReviewTool[]).map((t) => (
                <option key={t} value={t}>
                  {reviewToolLabel[t]}
                </option>
              ))}
            </select>
          </Field>
          {wf.review.tool === "custom" && (
            <Field label="Command" hint="Runs on the host against the PR branch.">
              <CommitInput className="field font-term text-[17px]" value={wf.review.command} placeholder="pnpm lint && pnpm test" onCommit={(v) => officeActions.updateWorkflow({ review: { command: v } })} />
            </Field>
          )}
        </div>
        <p className="mt-2 text-[12px] text-muted">When a review finishes with comments, HQ tells the PR's author to fix them.</p>
      </section>

      <section className="border-[3px] border-ink bg-white p-3">
        <SectionTitle>Merge</SectionTitle>
        <div className="flex gap-2" role="radiogroup" aria-label="Who merges">
          {(["human", "lead"] as const).map((by) => (
            <button key={by} className="btn text-[14px]" role="radio" aria-checked={wf.merge.by === by} aria-pressed={wf.merge.by === by} onClick={() => officeActions.updateWorkflow({ merge: { by } })}>
              {by === "human" ? "You merge" : "The lead merges"}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[12px] text-muted">The lead always sets the merge order and handles conflicts between PRs.</p>
      </section>

      <section className="border-[3px] border-ink bg-white p-3">
        <SectionTitle>Daily budget</SectionTitle>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Limit per day (USD)" hint="For the whole office, agents that use an API key only. 0 = no limit. The count starts again at midnight.">
            <CommitInput
              className="field"
              value={String(wf.budget?.dailyUsd ?? 0)}
              onCommit={(v) => {
                const n = Number(v.replace(",", "."));
                if (Number.isFinite(n) && n >= 0) officeActions.updateWorkflow({ budget: { dailyUsd: n } });
              }}
            />
          </Field>
          <Field label="Spent today">
            <div className={`text-[20px] ${budget && budgetLevel(budget.spentUsd, budget.dailyUsd) === "over" ? "text-red" : ""}`}>
              {formatUsd(budget?.spentUsd ?? 0)}
              {wf.budget?.dailyUsd ? <span className="text-[13px] text-muted"> of {formatUsd(wf.budget.dailyUsd)}</span> : null}
            </div>
          </Field>
        </div>
        {budget && Object.keys(budget.perAgent).length > 0 && (
          <ul className="m-0 mt-2 list-none p-0 text-[13px]">
            {Object.entries(budget.perAgent).map(([id, usd]) => (
              <li key={id}>
                {team?.find((a) => a.id === id)?.name ?? id}: {formatUsd(usd)}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[12px] text-muted">
          At 80% HQ warns you. At 100% it stops the agents that use an API key and won't start them until midnight or until you raise the limit. Subscription agents
          and Ollama cost nothing here. Claude Code on DeepSeek or OpenRouter is priced as if it were Claude, so the figure is an estimate. Codex agents with an API key are
          not counted yet.
        </p>
      </section>

      {live ? (
        <section className="border-[3px] border-dashed border-ink bg-cream-2 p-3">
          <div className="mb-1 flex items-center justify-between">
            <SectionTitle>Deploy</SectionTitle>
            <span className="chip text-[12px]">Coming soon</span>
          </div>
          <p className="m-0 text-[13px] text-muted">
            Preview deployments per PR (Vercel, InstaCloud) and one environment per agent, shown in the office's server room. Not available yet; agents can
            still deploy with their own tools.
          </p>
        </section>
      ) : (
      <section className="border-[3px] border-ink bg-white p-3">
        <div className="mb-3 flex items-center justify-between">
          <SectionTitle>Deploy</SectionTitle>
          <Toggle checked={wf.deploy.enabled} onChange={(v) => officeActions.updateWorkflow({ deploy: { enabled: v } })} label={wf.deploy.enabled ? "On" : "Off"} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Tool">
            <select
              className="field"
              disabled={!wf.deploy.enabled}
              value={wf.deploy.tool}
              onChange={(e) => officeActions.updateWorkflow({ deploy: { tool: e.target.value as DeployTool } })}
            >
              {(Object.keys(deployToolLabel) as DeployTool[]).map((t) => (
                <option key={t} value={t}>
                  {deployToolLabel[t]}
                </option>
              ))}
            </select>
          </Field>
          {wf.deploy.tool === "custom" && (
            <Field label="Command">
              <CommitInput className="field font-term text-[17px]" value={wf.deploy.command} placeholder="./scripts/deploy.sh" onCommit={(v) => officeActions.updateWorkflow({ deploy: { command: v } })} />
            </Field>
          )}
          <div className="col-span-2">
            <Toggle
              checked={wf.deploy.perAgentEnvironments}
              onChange={(v) => officeActions.updateWorkflow({ deploy: { perAgentEnvironments: v } })}
              label="One environment per agent (own app + database copy)"
            />
          </div>
        </div>
        <p className="mt-2 text-[12px] text-muted">The server room shows one rack per environment. Turn deploy off to hide it.</p>
      </section>
      )}
    </div>
  );
}
