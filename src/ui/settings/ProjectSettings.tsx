import { useState } from "react";
import { DEFAULT_OFFICE_NAME, OFFICE_NAME_MAX } from "../../data/names";
import { FONT_STYLES, savedFont, setFont, type FontStyle } from "../../theme/fonts";
import { officeActions, useOffice } from "../../store/office";
import { Field, SectionTitle } from "../kit";
import { CommitInput, Toggle } from "./controls";

function FontPicker() {
  const [font, setCurrent] = useState(savedFont);
  return (
    <section className="border-[3px] border-ink bg-white p-3">
      <SectionTitle>Font</SectionTitle>
      <Field label="Font style" hint="For panels, drawers, settings and agent terminals. The office stays pixel. Saved in this browser only.">
        <select
          className="field w-[320px]"
          value={font}
          onChange={(e) => {
            const f = e.target.value as FontStyle;
            setFont(f);
            setCurrent(f);
          }}
        >
          {FONT_STYLES.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label} · {f.hint}
            </option>
          ))}
        </select>
      </Field>
    </section>
  );
}

export function ProjectSettings() {
  const project = useOffice((s) => s.snap?.config.project);
  if (!project) return null;
  return (
    <div className="flex flex-col gap-5">
      <FontPicker />
      <section className="grid grid-cols-2 gap-3 border-[3px] border-ink bg-white p-3">
        <div className="col-span-2">
          <SectionTitle>Project</SectionTitle>
        </div>
        <Field label="Name">
          <CommitInput className="field" value={project.name} onCommit={(v) => v.trim() && officeActions.updateProject({ name: v.trim() })} />
        </Field>
        <Field label="Office name" hint={`The sign on the office wall. Up to ${OFFICE_NAME_MAX} characters; letters and numbers read best.`}>
          <CommitInput
            className="field"
            maxLength={OFFICE_NAME_MAX}
            value={project.officeName ?? ""}
            placeholder={DEFAULT_OFFICE_NAME}
            onCommit={(v) => officeActions.updateProject({ officeName: v.trim() })}
          />
        </Field>
        <Field label="GitHub repo" hint="owner/name. HQ only reads PRs, checks and comments.">
          <CommitInput className="field font-term text-[17px]" value={project.repo} onCommit={(v) => v.trim() && officeActions.updateProject({ repo: v.trim() })} />
        </Field>
        <Field label="Local path">
          <CommitInput className="field font-term text-[17px]" value={project.path} onCommit={(v) => v.trim() && officeActions.updateProject({ path: v.trim() })} />
        </Field>
        <Field label="HQ port" hint="Sandboxes reach HQ at host.docker.internal on this port.">
          <CommitInput
            className="field font-term text-[17px]"
            value={String(project.hqPort)}
            onCommit={(v) => {
              const n = Number(v);
              if (Number.isInteger(n) && n > 1023 && n < 65536) officeActions.updateProject({ hqPort: n });
            }}
          />
        </Field>
      </section>
      <section>
        <SectionTitle>Plan</SectionTitle>
        <Toggle checked={!!project.exportPlan} onChange={(v) => officeActions.updateProject({ exportPlan: v })} label="Export plan to docs/plan.md" />
        <p className="mt-1 text-[13px] text-muted">
          HQ keeps the plan in the plan.json next to config.json (.kh-team/ in your repo). With this on, it also writes a readable copy to docs/plan.md every time the plan changes, so you can commit it or read it on GitHub. Edits to that file are overwritten.
        </p>
      </section>
      <section className="text-[13px] text-muted">
        <SectionTitle>Security</SectionTitle>
        <ul className="list-disc pl-5">
          <li>HQ binds 127.0.0.1 only.</li>
          <li>A random token is created on every start. The browser, hooks and the Team MCP must send it.</li>
          <li>HQ never reads .env files. Sandboxes get keys from Docker's secret store.</li>
        </ul>
      </section>
    </div>
  );
}
