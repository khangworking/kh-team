// Small shared HUD pieces.

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentState, ReviewState } from "../data/types";
import { robotCanvases } from "../office/draw/robots";
import { reviewStyle, stateStyle } from "../theme/tokens";

export function StateChip({ state, blink = true }: { state: AgentState; blink?: boolean }) {
  const st = stateStyle[state];
  return (
    <span className={`chip chip-dot ${blink && state === "needs-input" ? "blink" : ""}`} style={{ ["--c" as string]: st.color }}>
      {st.label}
    </span>
  );
}

export function ReviewChip({ review, merged }: { review: ReviewState; merged?: boolean }) {
  const st = merged ? { label: "Merged", color: "#00873a" } : reviewStyle[review];
  return (
    <span className="chip chip-dot" style={{ ["--c" as string]: st.color, color: merged ? "#fff" : undefined }}>
      {st.label}
    </span>
  );
}

/** Pixel robot portrait drawn from the same sprite as the office. */
export function Portrait({ color, lead, size = 40 }: { color: string; lead: boolean; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const g = c?.getContext("2d");
    if (!c || !g) return;
    const src = robotCanvases(color, lead).front;
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, 16, 16);
    g.drawImage(src, 2, 1);
  }, [color, lead]);
  return (
    <canvas
      ref={ref}
      width={16}
      height={16}
      className="shrink-0 border-[3px] border-ink bg-navy"
      style={{ width: size, height: size, imageRendering: "pixelated" }}
      aria-hidden
    />
  );
}

export function Dot({ color, size = 10 }: { color: string; size?: number }) {
  return <i className="inline-block shrink-0 border-2 border-ink" style={{ width: size, height: size, background: color }} />;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.12em] text-muted">{children}</h3>;
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[14px] font-semibold">{label}</span>
      {children}
      {hint && <span className="text-[12px] text-muted">{hint}</span>}
    </label>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (id: T) => void }) {
  return (
    <div role="tablist" className="flex flex-wrap gap-2">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} aria-pressed={value === t.id} className="btn text-[14px]" onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Re-renders every `ms` so relative times stay fresh. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
