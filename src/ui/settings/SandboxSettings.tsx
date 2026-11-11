import { useState } from "react";
import { SERVICE_KEYS, type BasePolicy, type SbxRule } from "../../data/types";
import { officeActions, useOffice } from "../../store/office";
import { Dot, Field, SectionTitle } from "../kit";
import { ChipList, CommitInput, isDomain } from "./controls";
import { ResourcesSection } from "./ResourcesSection";

const BASE: Record<BasePolicy, string> = {
  "allow-all": "Allow all — every outbound connection is allowed",
  balanced: "Balanced — blocked by default; AI services, package registries and common dev sites allowed",
  "deny-all": "Deny all — everything blocked unless a rule allows it",
  unknown: "Unknown — sbx didn't say",
};

const SOURCE: Record<SbxRule["source"], string> = { hq: "HQ", kit: "agent kit", org: "your org", cli: "sbx CLI" };

/** Add / remove service keys for one scope (an agent's sandbox, or every sandbox). */
function KeyEditor({ keys, onSet, onRemove, disabled }: { keys: string[]; onSet: (service: string, value: string) => void; onRemove: (s: string) => void; disabled?: string }) {
  const [service, setService] = useState<string>(SERVICE_KEYS[0]);
  const [value, setValue] = useState("");
  return (
    <div>
      <ul className="mb-2 flex flex-wrap gap-1.5">
        {keys.length === 0 && <li className="text-[13px] text-muted">None</li>}
        {keys.map((k) => (
          <li key={k} className="chip font-term text-[15px]">
            {k} <span className="text-muted">••••</span>
            <button className="ml-1 text-[12px]" aria-label={`Remove ${k} key`} onClick={() => window.confirm(`Remove the ${k} key from sbx?`) && onRemove(k)}>
              ✕
            </button>
          </li>
        ))}
      </ul>
      {disabled ? (
        <p className="text-[12px] text-muted">{disabled}</p>
      ) : (
        <form
          className="grid grid-cols-[150px_1fr_auto] items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!value) return;
            onSet(service, value);
            setValue("");
          }}
        >
          <Field label="Service">
            <select className="field" value={service} onChange={(e) => setService(e.target.value)}>
              {SERVICE_KEYS.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label="Key / token">
            <input className="field" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
          <button className="btn" type="submit" disabled={!value}>
            Store
          </button>
        </form>
      )}
    </div>
  );
}

export function SandboxSettingsTab({ initialAgentId }: { initialAgentId?: string }) {
  const snap = useOffice((s) => s.snap);
  const live = useOffice((s) => s.live);
  const [agentId, setAgentId] = useState(initialAgentId ?? snap?.config.team[0]?.id ?? "");
  if (!snap) return null;
  const agent = snap.config.team.find((a) => a.id === agentId) ?? snap.config.team[0];
  if (!agent) return null;
  const sb = agent.sandbox;
  const sbx = snap.sbx;
  const state = sbx.agents[agent.id];
  const status = snap.agents.find((a) => a.agentId === agent.id);
  const sandboxExists = !!status?.session.sandbox || !!state?.rules.length;
  const update = (patch: Parameters<typeof officeActions.updateSandbox>[1]) => officeActions.updateSandbox(agent.id, patch);
  const port = snap.config.project.hqPort;

  const copyToAll = () => {
    for (const a of snap.config.team) if (a.id !== agent.id) officeActions.updateSandbox(a.id, { allow: [...sb.allow], deny: [...sb.deny] });
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        {snap.config.team.map((a) => (
          <button key={a.id} className="btn flex items-center gap-1.5 text-[14px]" aria-pressed={a.id === agent.id} onClick={() => setAgentId(a.id)}>
            <Dot color={a.color} size={8} /> {a.name}
          </button>
        ))}
        <button className="btn ml-auto text-[13px]" onClick={() => officeActions.refreshSbx()} title="Read rules, keys and proxy from sbx again">
          Refresh from sbx
        </button>
      </div>

      {agent.mode === "local" && (
        <p className="border-[3px] border-orange bg-[#fff1d6] px-3 py-2 text-[14px]">
          {agent.name} runs in Local mode, so sandbox settings don't apply until it's switched back to Sandbox. The env file still applies.
        </p>
      )}

      <h3 className="-mb-2 text-[18px] font-bold">This agent</h3>

      <ResourcesSection agent={agent} status={status} team={snap.config.team} machine={snap.setup.machine} />

      <section className="border-[3px] border-ink bg-white p-3">
        <SectionTitle>Sandbox</SectionTitle>
        <div className="flex items-center gap-3">
          <p className="m-0 flex-1 text-[13px] text-muted">
            Removes {agent.name}'s sandbox and starts a fresh one. Use it when a change doesn't take effect in the running sandbox (a new key or credential, an installed tool gone wrong, a
            new CLI). {agent.name}'s folder and code are kept; anything installed inside the VM and the CLI's conversation are lost, and {agent.name} restarts.
          </p>
          <button
            className="btn shrink-0 text-[13px]"
            disabled={!live || !sandboxExists || status?.session.state === "starting"}
            title={!sandboxExists ? `${agent.name} has no sandbox yet. It is created on first Start.` : undefined}
            onClick={() =>
              window.confirm(`Recreate ${agent.name}'s sandbox?\n\nThe agent's folder and code are kept. Anything installed inside the VM and the CLI's conversation are lost, and ${agent.name} restarts.`) &&
              officeActions.recreateSandbox(agent.id)
            }
          >
            Recreate sandbox
          </button>
        </div>
      </section>

      <section className="border-[3px] border-ink bg-white p-3">
        <div className="flex items-center justify-between">
          <SectionTitle>Network for {agent.name}'s sandbox</SectionTitle>
          <button className="btn mb-2 px-2 text-[12px]" onClick={copyToAll} title="Copy these allowed and blocked domains to every agent">
            Copy to all agents
          </button>
        </div>
        <p className="mb-3 text-[13px] text-muted">
          On top of the machine's base policy ({sbx.basePolicy}). Blocked wins over allowed. Applied with{" "}
          <code className="font-term text-[15px]">sbx policy allow/deny network --sandbox</code>.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Allowed domains">
            <ChipList items={sb.allow} onChange={(allow) => update({ allow })} placeholder="registry.npmjs.org" validate={isDomain} />
          </Field>
          <Field label="Blocked domains">
            <ChipList items={sb.deny} onChange={(deny) => update({ deny })} placeholder="*.googleapis.com" validate={isDomain} />
          </Field>
        </div>
        {state?.syncError && <p className="mt-2 border-2 border-red bg-[#ffe1ea] px-2 py-1 text-[13px] text-red">sbx: {state.syncError}</p>}
        <div className="mt-3">
          <div className="mb-1 text-[13px] font-semibold">Rules in effect {live ? "(read from sbx)" : "(demo)"}</div>
          {!sandboxExists ? (
            <p className="text-[12px] text-muted">{agent.name}'s sandbox doesn't exist yet. The rules above are applied when it's created on first Start.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {state?.rules.length === 0 && <li className="text-[12px] text-muted">No sandbox-specific rules.</li>}
              {state?.rules.map((r) =>
                r.resources.map((res) => (
                  <li key={`${r.id}-${res}`} className="chip font-term text-[14px]" style={{ ["--c" as string]: r.decision === "allow" ? "#c8f5d2" : "#ffd0dc" }} title={`${r.decision} · added by ${SOURCE[r.source]}`}>
                    {r.decision === "allow" ? "✓" : "✗"} {res} <span className="text-[11px] text-muted">{SOURCE[r.source]}</span>
                  </li>
                )),
              )}
            </ul>
          )}
        </div>
      </section>

      <section className="border-[3px] border-ink bg-white p-3">
        <SectionTitle>Service keys for {agent.name} only</SectionTitle>
        <p className="mb-2 text-[13px] text-muted">
          The host proxy adds these to {agent.name}'s requests, so the key never enters the VM. HQ passes the value straight to{" "}
          <code className="font-term text-[15px]">sbx secret set</code> and never stores it.
        </p>
        <KeyEditor
          keys={state?.keys ?? []}
          disabled={sandboxExists ? undefined : `Start ${agent.name} once to add keys only for this sandbox. Keys for every sandbox are under This machine.`}
          onSet={(service, value) => officeActions.setSecret(agent.id, service, value)}
          onRemove={(service) => officeActions.removeSecret(agent.id, service)}
        />
      </section>

      <section className="border-[3px] border-ink bg-white p-3">
        <SectionTitle>App variables (env file)</SectionTitle>
        <p className="mb-2 text-[13px] text-muted">
          For values your app needs to run and test (DATABASE_URL, STRIPE_KEY…). One <code className="font-term text-[15px]">KEY=value</code> per line. HQ never reads or commits this file. When the agent starts, the values become
          environment variables in its session and in its Shell tab — not a .env file in the project. Restart the agent after editing.
        </p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate border-2 border-ink bg-cream px-2 py-0.5 font-term text-[16px]" title={state?.envFile.path}>
            {state?.envFile.path ?? "—"}
          </code>
          <button className="btn text-[13px]" onClick={() => officeActions.openEnvFile(agent.id)}>
            {state?.envFile.exists ? "Open" : "Create & open"}
          </button>
        </div>
        <p className="mt-2 text-[12px] font-semibold text-[#a35d00]">⚠ Unlike service keys, these values do enter the VM. Use test or development credentials. Restart the agent after editing.</p>
      </section>

      <h3 className="-mb-2 mt-2 text-[18px] font-bold">This machine — all sandboxes</h3>
      <p className="-mt-3 text-[13px] text-muted">These are sbx's machine-wide settings. They affect every sandbox on this machine, including ones HQ didn't create.</p>

      <section className="border-[3px] border-ink bg-white p-3">
        <SectionTitle>Base network policy</SectionTitle>
        <p className="text-[15px]">{BASE[sbx.basePolicy]}</p>
        <p className="mt-1 text-[12px] text-muted">
          Set once with <code className="font-term text-[14px]">sbx policy init</code>. Changing it means <code className="font-term text-[14px]">sbx policy reset</code>, which deletes every rule on this
          machine, so HQ doesn't do it. HQ always allows <code className="font-term text-[14px]">localhost:{port}</code> and{" "}
          <code className="font-term text-[14px]">host.docker.internal:{port}</code> so agents can reach it.{" "}
          <a className="underline" href="https://docs.docker.com/ai/sandboxes/security/" target="_blank" rel="noreferrer">
            Docs ↗
          </a>
        </p>
      </section>

      <section className="border-[3px] border-ink bg-white p-3">
        <SectionTitle>Upstream proxy</SectionTitle>
        <Field label="Proxy URL" hint="Optional. All sandbox traffic goes through this proxy. Leave empty for none.">
          <CommitInput className="field font-term text-[17px]" value={sbx.proxy ?? ""} placeholder="http://proxy.internal:3128" onCommit={(v) => officeActions.setProxy(v.trim() || null)} />
        </Field>
      </section>

      <section className="border-[3px] border-ink bg-white p-3">
        <SectionTitle>Service keys for every sandbox</SectionTitle>
        <KeyEditor keys={sbx.globalKeys} onSet={(service, value) => officeActions.setSecret(null, service, value)} onRemove={(service) => officeActions.removeSecret(null, service)} />
      </section>
    </div>
  );
}
