import { useState } from "react";
import { nextAgentName } from "../../data/names";
import { modelListed, normalizeAuth, PROVIDER_INFO, PROVIDERS, providersFor, SUBSCRIPTION_PROVIDER, type ProviderId } from "../../data/providers";
import { cliVersionState } from "../../data/cliVersions";
import { CLI_LABEL, type AgentAuth, type AgentCli, type AgentConfig, type AgentMode } from "../../data/types";
import { officeActions, useOffice } from "../../store/office";
import { agentPalette } from "../../theme/tokens";
import { Field, Portrait, SectionTitle } from "../kit";
import { CommitInput, Toggle } from "./controls";
import { RemoveAgentDialog } from "./RemoveAgentDialog";

export function CliSelect({ value, onChange }: { value: AgentCli; onChange: (v: AgentCli) => void }) {
  return (
    <select className="field" value={value} onChange={(e) => onChange(e.target.value as AgentCli)} aria-label="Coding agent">
      {(Object.keys(CLI_LABEL) as AgentCli[]).map((c) => (
        <option key={c} value={c}>
          {CLI_LABEL[c]}
        </option>
      ))}
    </select>
  );
}
const SUBSCRIPTION_LABEL: Partial<Record<AgentCli, string>> = { claude: "Claude subscription", codex: "ChatGPT subscription" };

/** How the agent pays for its model: the CLI's subscription, or an API key for one of the providers the CLI can reach. */
export function AccessSelect({ cli, auth, provider, onChange }: { cli: AgentCli; auth: AgentAuth; provider: ProviderId; onChange: (v: { auth: AgentAuth; provider: ProviderId }) => void }) {
  const value = auth === "subscription" ? "subscription" : `apiKey:${provider}`;
  return (
    <select
      className="field"
      value={value}
      aria-label="Model access"
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === "subscription" ? normalizeAuth(cli, "subscription", null) : normalizeAuth(cli, "apiKey", v.slice("apiKey:".length) as ProviderId));
      }}
    >
      {SUBSCRIPTION_PROVIDER[cli] && <option value="subscription">{SUBSCRIPTION_LABEL[cli]}</option>}
      {providersFor(cli).map((p) => (
        <option key={p} value={`apiKey:${p}`}>
          {PROVIDER_INFO[p].keyVar ? "API key · " : ""}
          {PROVIDER_INFO[p].label}
        </option>
      ))}
    </select>
  );
}

/** The office's provider keys file: HQ shows which keys are there, never their values. */
function ProviderKeysSection({ team }: { team: AgentConfig[] }) {
  const present = useOffice((s) => s.snap?.providerKeys) ?? [];
  const needed = [...new Set(team.filter((a) => a.auth === "apiKey").map((a) => a.provider))];
  return (
    <section className="border-[3px] border-ink bg-white p-3">
      <SectionTitle>Provider keys</SectionTitle>
      <p className="mb-2 text-[14px] text-muted">
        API-key agents get their key from this office's keys file when their sandbox starts, each agent only its own provider's key. Claude Code agents on an Anthropic key never hold it: sbx's proxy keeps it on this machine and adds it to their requests. The other agents (Codex, OpenCode, DeepSeek) get it as a variable inside their sandbox. HQ also asks each provider with a key for its current model list. Subscription agents sign in inside their own terminal instead.
      </p>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {PROVIDERS.filter((p) => PROVIDER_INFO[p].keyVar).map((p) => {
          const has = present.includes(p);
          const missing = !has && needed.includes(p);
          return (
            <span key={p} className={`border-2 border-ink px-1.5 py-0.5 text-[12px] ${has ? "bg-green/30" : missing ? "bg-red/20" : "bg-cream-2"}`} title={PROVIDER_INFO[p].keyVar ?? ""}>
              {PROVIDER_INFO[p].label}: {has ? "set" : missing ? "missing" : "—"}
            </span>
          );
        })}
      </div>
      <button className="btn text-[13px]" onClick={() => officeActions.openProviderKeys()}>
        Open keys file
      </button>
    </section>
  );
}

export const ROLE_SUGGESTIONS = ["Developer", "QA", "Designer", "Docs", "DevOps", "Security"];

export function TeamSettings() {
  const team = useOffice((s) => s.snap?.config.team);
  const [open, setOpen] = useState<string | null>(null);
  const [removing, setRemoving] = useState<AgentConfig | null>(null);
  if (!team) return null;
  return (
    <div className="flex flex-col gap-5">
      <ProviderKeysSection team={team} />
      <section>
        <SectionTitle>Team · {team.length} agents</SectionTitle>
        <p className="mb-3 text-[14px] text-muted">
          Changes to model, mode or folder apply the next time the agent starts. One lead plans and assigns work. Every other agent gets its own desk, sandbox and (optionally) environment. The office grows as you add agents.
        </p>
        <div className="flex flex-col gap-2">
          {team.map((a) => (
            <AgentRow key={a.id} agent={a} expanded={open === a.id} onToggle={() => setOpen(open === a.id ? null : a.id)} onRemove={() => setRemoving(a)} />
          ))}
        </div>
      </section>
      <AddAgent />
      {removing && <RemoveAgentDialog agent={removing} onClose={() => setRemoving(null)} />}
    </div>
  );
}

function AgentRow({ agent, expanded, onToggle, onRemove }: { agent: AgentConfig; expanded: boolean; onToggle: () => void; onRemove: () => void }) {
  const set = (patch: Parameters<typeof officeActions.updateAgent>[1]) => officeActions.updateAgent(agent.id, patch);
  const liveModels = useOffice((s) => s.snap?.models?.[agent.provider]);
  const cliVersion = useOffice((s) => s.snap?.cliVersions?.[agent.id]);
  const versionState = cliVersionState(cliVersion);
  const versionText =
    versionState === "behind"
      ? `⚠ ${cliVersion!.installed} → ${cliVersion!.latest} available`
      : versionState === "current"
        ? `${cliVersion!.installed} · up to date`
        : cliVersion?.installed
          ? `${cliVersion.installed} · newest not checked`
          : "version not read yet";
  const model = agent.model.trim();
  // A list the provider itself gave: a model it doesn't have would stop the agent from starting.
  const unknownModel = agent.auth === "apiKey" && !!model && !/^(default|opus|sonnet|haiku)$/i.test(model) && !!liveModels && !modelListed(liveModels, model);
  return (
    <div className="border-[3px] border-ink bg-white">
      <div className="grid grid-cols-[40px_1fr_1fr_120px_170px_100px_auto] items-end gap-2.5 p-2.5">
        <Portrait color={agent.color} lead={agent.isLead} />
        <Field label="Name">
          <CommitInput className="field" value={agent.name} onCommit={(v) => v.trim() && set({ name: v.trim() })} />
        </Field>
        <Field label="Role">
          {agent.isLead ? (
            <div className="field flex h-9 items-center bg-cream-2">Lead</div>
          ) : (
            <CommitInput className="field" value={agent.role} list="role-suggestions" onCommit={(v) => v.trim() && set({ role: v.trim() })} />
          )}
        </Field>
        <Field
          label={
            <span className="whitespace-nowrap">
              Agent
              {cliVersion?.installed && (
                <span className="ml-1 font-normal text-muted" title={versionText}>
                  ({cliVersion.installed})
                </span>
              )}
              {versionState === "behind" && (
                <span className="ml-1 text-red" role="img" aria-label="CLI update available" title={versionText}>
                  ⚠
                </span>
              )}
            </span>
          }
        >
          <CliSelect value={agent.cli} onChange={(cli) => set({ cli })} />
        </Field>
        <Field label="Model access">
          <AccessSelect cli={agent.cli} auth={agent.auth} provider={agent.provider} onChange={(v) => set(v)} />
        </Field>
        <Field label="Runs in">
          <div className="field flex h-9 items-center bg-cream-2">Sandbox</div>
        </Field>
        <div className="flex gap-1.5">
          <button className="btn px-2 text-[13px]" aria-expanded={expanded} onClick={onToggle}>
            {expanded ? "Less" : "More"}
          </button>
          {!agent.isLead && (
            <button
              className="btn px-2 text-[13px] text-red"
              onClick={onRemove}
            >
              Remove
            </button>
          )}
        </div>
      </div>
      {expanded && (
        <div className="grid grid-cols-2 gap-3 border-t-[3px] border-ink bg-cream p-3">
          <Field label="Colour">
            <div className="flex flex-wrap gap-1.5">
              {agentPalette.map((c) => (
                <button
                  key={c}
                  className="h-6 w-6 border-[3px] border-ink"
                  style={{ background: c, outline: c === agent.color ? "3px solid #241a2e" : undefined, outlineOffset: 1 }}
                  aria-label={`Colour ${c}`}
                  onClick={() => set({ color: c })}
                />
              ))}
            </div>
          </Field>
          <Field
            label={`${CLI_LABEL[agent.cli]} version`}
            hint="Read from this agent's sandbox while it runs; the newest is npm's latest release. The CLI is part of the sandbox and stays at the version it had when the sandbox was created, so HQ can't update it yet: Recreate sandbox starts a new one (it may reuse sbx's cached image, and drops what the old sandbox held, such as its last conversation)."
          >
            <div className="field flex h-9 items-center bg-cream-2">
              {versionText}
              {cliVersion?.checkedAt && versionState !== "unknown" ? <span className="ml-2 text-[12px] text-muted">· read {new Date(cliVersion.checkedAt).toLocaleString()}</span> : null}
            </div>
          </Field>
          <Field
            label="Start with model"
            hint={`Optional. Leave empty to use the CLI's default — you can always switch with /model in the terminal. Set it to keep a choice across restarts (e.g. Opus for the lead). With an API key the suggestions are the provider's own current list.${unknownModel ? ` ⚠ ${PROVIDER_INFO[agent.provider].label} doesn't offer "${model}", so this agent won't start until it is changed.` : ""}`}
          >
            <CommitInput
              className="field"
              value={agent.model}
              placeholder={
                agent.auth !== "apiKey" || (agent.cli === "claude" && agent.provider === "anthropic")
                  ? `${CLI_LABEL[agent.cli]} default`
                  : (PROVIDER_INFO[agent.provider].defaultModel ?? PROVIDER_INFO[agent.provider].models[0] ?? `${CLI_LABEL[agent.cli]} default`)
              }
              list={agent.auth === "apiKey" ? `models-${agent.provider}` : agent.cli === "codex" ? "codex-models" : "claude-models"}
              onCommit={(v) => set({ model: v.trim() })}
            />
          </Field>
          <Field
            label="Continue last conversation"
            hint="When this agent starts again (Stop then Start, or HQ restarts it), it picks up its last conversation in its sandbox, so it remembers what it was doing. Off: it starts a new one. A new or recreated sandbox has no conversation to continue."
          >
            <Toggle checked={agent.resume !== false} onChange={(v) => set({ resume: v })} label={agent.resume !== false ? "On" : "Off"} />
          </Field>
          {!agent.isLead && (
            <Field
              label="Reviews PRs"
              hint="This agent reviews the others' pull requests and takes no tasks. Used when Settings → Workflow → Review is Agent review: it must run a different model than the PR's author, so give it another provider or model."
            >
              <Toggle checked={!!agent.reviewer} onChange={(v) => set({ reviewer: v })} label={agent.reviewer ? "On" : "Off"} />
            </Field>
          )}
          <Field label="Skills" hint="Comma separated. Copied into the agent's .claude/skills.">
            <CommitInput
              className="field"
              value={agent.skills.join(", ")}
              onCommit={(v) => set({ skills: v.split(",").map((s) => s.trim()).filter(Boolean) })}
            />
          </Field>
          <div className="col-span-2">
            <Field label="Folder" hint="Leave empty and HQ keeps its own clone of the repo for this agent. Or enter an existing git folder.">
              <CommitInput
                className="field font-term text-[17px]"
                value={agent.workspacePath ?? ""}
                placeholder={`HQ-managed: ~/.jsmhq/…/${agent.id}`}
                onCommit={(v) => set({ workspacePath: v.trim() || null })}
              />
            </Field>
          </div>
          <div className="col-span-2">
            <Field label="ROLE.md" hint="Who this agent is. HQ adds the team, rules and tools, writes it to .jsmhq-role.md in the agent's folder (never committed) and loads it when the session starts. A ROLE.md the folder already has is included too, never overwritten.">
              <CommitInput multiline className="field h-[120px] resize-y font-term text-[17px] leading-tight" value={agent.roleMd} onCommit={(v) => set({ roleMd: v })} />
            </Field>
          </div>
        </div>
      )}
    </div>
  );
}

function AddAgent() {
  const [name, setName] = useState("");
  const [role, setRole] = useState("Developer");
  const [cli, setCli] = useState<AgentCli>("claude");
  const [access, setAccess] = useState(normalizeAuth("claude", "subscription", null));
  const mode: AgentMode = "sandbox";
  const team = useOffice((s) => s.snap?.config.team) ?? [];
  const live = useOffice((s) => s.snap?.models);
  const suggested = nextAgentName(team.map((a) => a.name));
  const add = () => {
    officeActions.addAgent({ name: name.trim() || suggested, role, cli, ...access, mode });
    setName("");
  };
  return (
    <section className="border-[3px] border-dashed border-ink p-3">
      <SectionTitle>Add an agent</SectionTitle>
      <form
        className="grid grid-cols-[1fr_1fr_120px_170px_100px_auto] items-end gap-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Field label="Name">
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder={suggested} />
        </Field>
        <Field label="Role">
          <input className="field" value={role} list="role-suggestions" onChange={(e) => setRole(e.target.value)} />
        </Field>
        <Field label="Agent">
          <CliSelect
            value={cli}
            onChange={(c) => {
              setCli(c);
              setAccess(normalizeAuth(c, access.auth, access.provider));
            }}
          />
        </Field>
        <Field label="Model access">
          <AccessSelect cli={cli} auth={access.auth} provider={access.provider} onChange={setAccess} />
        </Field>
        <Field label="Runs in">
          <div className="field flex h-9 items-center bg-cream-2">Sandbox</div>
        </Field>
        <button className="btn" type="submit">
          Add
        </button>
      </form>
      <p className="mt-2 text-[12px] text-muted">
        Every agent gets its own Docker Sandbox, with the lead's network rules and access to HQ at host.docker.internal.
      </p>
      <datalist id="codex-models">
        <option value="gpt-5.6-sol" />
      </datalist>
      <datalist id="claude-models">
        <option value="opus" />
        <option value="sonnet" />
        <option value="haiku" />
      </datalist>
      {PROVIDERS.map((p) => (
        <datalist key={p} id={`models-${p}`}>
          {[...(p === "anthropic" ? PROVIDER_INFO.anthropic.models : []), ...(live?.[p] ?? (p === "anthropic" ? [] : PROVIDER_INFO[p].models))].map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      ))}
      <datalist id="role-suggestions">
        {ROLE_SUGGESTIONS.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
    </section>
  );
}
