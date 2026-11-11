// Owns the Pixi app. Reads the stores, never writes data — only UI state
// (hover, selection) through the ui actions.

import { Application, Container, Graphics, Sprite, TextureStyle, type Texture } from "pixi.js";
import type { AgentState, HqConfig, PullRequest, ReviewState } from "../data/types";
import { mulberry32 } from "../lib/random";
import { selectTeam, useOffice } from "../store/office";
import { useUi, type FocusTarget } from "../store/ui";
import { think, type Bot } from "./actors/bots";
import { Effects } from "./actors/effects";
import { BeltPath, parcelPos, updateParcels, type Parcel } from "./actors/parcels";
import { PlanNotes } from "./actors/planNotes";
import * as live from "./draw/live";
import { drawEmote, drawFace, drawNameTag, drawSelection, drawShadow } from "./draw/overlay";
import { buildStatic } from "./draw/static";
import { Camera } from "./engine/camera";
import { C } from "./engine/palette";
import { GfxPen } from "./engine/pen";
import { canvasTexture } from "./engine/textures";
import type { OfficeLayout, PxRect } from "./layout/layout";
import { attachInput } from "./sceneInput";
import { syncScene } from "./sceneSync";

TextureStyle.defaultOptions.scaleMode = "nearest";

export class OfficeScene {
  app = new Application();
  world = new Container();
  actors = new Container({ sortableChildren: true });
  private staticSprite: Sprite | null = null;
  private staticTex: Texture | null = null;
  private gSlow = new Graphics();
  private gFast = new Graphics();
  private gShadow = new Graphics();
  private gOver = new Graphics();
  camera!: Camera;

  layout: OfficeLayout | null = null;
  belt!: BeltPath;
  bots = new Map<string, Bot>();
  parcels: Parcel[] = [];
  prs = new Map<number, PullRequest>();
  prevReview = new Map<number, ReviewState>();
  seenActivity = new Set<string>();
  seenMessages = new Set<string>();
  notes = new PlanNotes();
  effects = new Effects();
  gateMode: { mode: live.GateMode; at: number } = { mode: "idle", at: 0 };
  pulses = new Map<string, number>();
  hover: { rect: PxRect; agentId: string | null } | null = null;
  epoch = -1;
  t = 0;
  private dt = 0;
  reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  private slowAcc = 1;
  private rand = mulberry32(3);
  private cleanups: (() => void)[] = [];
  private destroyed = false;

  async init(host: HTMLElement) {
    await this.app.init({ resizeTo: host, background: C.grass, antialias: false, autoDensity: true, resolution: window.devicePixelRatio || 1, roundPixels: true });
    if (this.destroyed) return void this.app.destroy(true);
    host.appendChild(this.app.canvas);
    this.app.canvas.style.imageRendering = "pixelated";
    this.world.addChild(this.gSlow, this.gFast, this.gShadow, this.actors, this.gOver);
    this.app.stage.addChild(this.world);
    this.camera = new Camera(
      this.world,
      () => ({ w: this.app.screen.width, h: this.app.screen.height }),
      () => ({ left: 312, top: 74, bottom: 16, right: useUi.getState().drawer ? 552 : 16 }),
      () => this.reducedMotion,
    );

    const sync = () => {
      const { snap, epoch } = useOffice.getState();
      if (snap) syncScene(this, snap, epoch);
    };
    sync();
    this.cleanups.push(useOffice.subscribe((s, prev) => (s.snap !== prev.snap || s.epoch !== prev.epoch) && sync()));
    this.cleanups.push(
      useUi.subscribe((s, prev) => {
        if (s.focus && s.focus !== prev.focus) this.focusOn(s.focus.target);
        if (s.zoomRequest && s.zoomRequest !== prev.zoomRequest) this.camera.zoomBy(s.zoomRequest.delta);
      }),
    );
    this.cleanups.push(attachInput(this));
    this.app.renderer.on("resize", () => this.camera.apply());
    this.app.ticker.add((tk) => this.frame(Math.min(0.1, tk.deltaMS / 1000)));
    // Dev-only handles for debugging from the console.
    if (import.meta.env.DEV) Object.assign(window, { __hqScene: this, __hqStore: useOffice });
  }

  destroy() {
    this.destroyed = true;
    this.cleanups.forEach((fn) => fn());
    if (this.app.renderer) this.app.destroy(true, { children: true });
  }

  setStatic(l: OfficeLayout, config: HqConfig) {
    const tex = canvasTexture(buildStatic(l, config));
    if (this.staticSprite) this.staticSprite.texture = tex;
    else {
      this.staticSprite = new Sprite(tex);
      this.world.addChildAt(this.staticSprite, 0);
    }
    this.staticTex?.destroy(true);
    this.staticTex = tex;
    this.camera.setWorldSize(l.worldW, l.worldH);
    this.slowAcc = 1;
  }

  // ------------------------------------------------------------ queries

  stateOf(agentId: string | null): AgentState | null {
    if (!agentId) return null;
    return useOffice.getState().snap?.agents.find((a) => a.agentId === agentId)?.state ?? null;
  }

  colorOf(agentId: string | null): string {
    return useOffice.getState().snap?.config.team.find((a) => a.id === agentId)?.color ?? C.white;
  }

  dropS(agentId: string): number {
    const l = this.layout;
    const d = l?.desks.find((x) => x.agentId === agentId);
    return d && l ? this.belt.sAtX(l.ox + d.drop[0] * 16 + 8) : 0;
  }

  botRect(b: Bot): PxRect {
    return { x: Math.round(b.x) - 7, y: b.headY - 1, w: 14, h: Math.round(b.y) - b.headY + 3 };
  }

  focusOn(target: FocusTarget) {
    const l = this.layout;
    if (!l) return;
    const near = Math.max(this.camera.zoom, Math.min(4, this.camera.fitZoom() + 1));
    if (target.kind === "home") return this.camera.home();
    if (target.kind === "agent") {
      const b = this.bots.get(target.id);
      if (b) this.camera.flyTo(b.x, b.y - 10, near);
    } else if (target.kind === "plan") {
      const r = l.plan.board;
      this.camera.flyTo(r.x + r.w / 2, r.y + 40, near);
    } else if (target.kind === "prs") {
      const r = l.prBoard ?? l.gate ?? l.mailbox;
      if (r) this.camera.flyTo(r.x + r.w / 2, r.y + r.h, near);
    } else {
      const r = l.racks.find((x) => x.name === target.name);
      if (r) this.camera.flyTo(r.x + r.w / 2, r.y + r.h / 2, near);
    }
  }

  // ------------------------------------------------------------ frame

  private frame(dt: number) {
    const l = this.layout;
    const snap = useOffice.getState().snap;
    if (!l || !snap) return;
    this.t += dt;
    this.dt = dt;
    const t = this.t;
    this.camera.update(dt);

    const team = selectTeam(snap);
    const stateMap = new Map(team.map((a) => [a.config.id, a.status.state]));

    // bots
    for (const bot of this.bots.values()) {
      const state = stateMap.get(bot.config.id) ?? "idle";
      bot.pause = Math.max(0, bot.pause - dt);
      if (bot.errand?.kind === "drop" && t > bot.errand.deadline) {
        const e = bot.errand;
        bot.errand = null;
        e.onArrive();
      }
      if (state !== "idle" && bot.errand && (bot.errand.kind === "coffee" || bot.errand.kind === "wander")) {
        bot.errand = null;
        bot.path = [];
        bot.pause = 0;
      }
      think(bot, l, state, t, this.rand);
      bot.move(dt, l);
      bot.render(t, state);
    }

    // parcels, effects, pulses
    // The belt runs at sim speed (1x/2x/4x) so parcels keep up with PR state.
    updateParcels(this.parcels, this.prs, this.belt, dt * useOffice.getState().speed, {
      deskPos: (id) => {
        const b = this.bots.get(id);
        return b ? { x: b.x, y: b.y - 14 } : null;
      },
      dropS: (id) => this.dropS(id),
      onMerged: (p) => {
        this.pulses.set("main", 1);
        const pos = this.belt.pos(this.belt.len);
        this.effects.text(`#${p.num} MERGED`, pos.x, pos.y - 26, C.green);
      },
    });
    this.effects.update(dt);
    for (const [k, v] of this.pulses) this.pulses.set(k, Math.max(0, v - dt * 0.6));
    if (this.gateMode.mode !== "idle" && this.gateMode.mode !== "reviewing" && t - this.gateMode.at > 1.6) this.gateMode = { mode: "idle", at: t };
    const scanning = this.parcels.some((p) => p.mode === "scan" && this.prs.get(p.num)?.review === "reviewing");
    if (this.gateMode.mode === "idle" && scanning) this.gateMode = { mode: "reviewing", at: t };
    if (this.gateMode.mode === "reviewing" && !scanning) this.gateMode = { mode: "idle", at: t };

    // slow layer (~8 fps)
    this.slowAcc += dt;
    if (this.slowAcc >= 0.125) {
      this.slowAcc = 0;
      this.drawSlow(snap.environments, stateMap, t);
    }
    this.drawFast(snap, stateMap, t);
  }

  private drawSlow(envs: import("../data/types").Environment[], states: Map<string, AgentState>, t: number) {
    const l = this.layout as OfficeLayout;
    const g = this.gSlow;
    g.clear();
    const p = new GfxPen(g);
    live.drawWindowAndClock(p, l, t);
    for (const d of l.desks) live.drawScreen(p, l.ox + (d.x0 + 2) * 16 + 15, l.oy + d.y0 * 16 + 12, states.get(d.agentId) ?? "idle", this.colorOf(d.agentId), t, d.index);
    if (l.lead.agentId) {
      const st = states.get(l.lead.agentId) ?? "idle";
      live.drawScreen(p, l.ox + 224, l.oy + 72, st, this.colorOf(l.lead.agentId), t, 0);
      live.drawScreen(p, l.ox + 250, l.oy + 72, st, this.colorOf(l.lead.agentId), t, 1);
    }
    if (l.prBoard) live.drawPrBoard(p, l.prBoard, [...this.prs.values()].sort((a, b) => a.number - b.number), (id) => this.colorOf(id));
    live.drawRacks(p, l.racks, envs, (id) => (id ? states.get(id) ?? null : null), (n) => this.pulses.get(n) ?? 0, t);
  }

  private drawFast(snap: import("../data/types").OfficeSnapshot, states: Map<string, AgentState>, t: number) {
    const l = this.layout as OfficeLayout;
    const g = this.gFast;
    g.clear();
    const p = new GfxPen(g);

    // plan wall
    const planId = useUi.getState().planBoardId ?? snap.boards.filter((b) => b.status === "active").sort((a, b) => a.order - b.order)[0]?.id ?? null;
    const board = snap.boards.find((b) => b.id === planId);
    if (board) live.drawPlanTitle(p, l, board.title);
    this.notes.update(snap.tasks, planId, l.plan.board, this.dt, t);
    this.notes.draw(p, snap.tasks, (id) => (id ? this.colorOf(id) : "#ffe9a8"), t); // unassigned = plain yellow sticky

    if (!this.reducedMotion) live.drawCables(p, l, (id) => states.get(id) ?? null, (id) => this.colorOf(id), t);
    for (const d of l.desks) live.drawDeskStrip(p, d, l.ox, l.oy, states.get(d.agentId) ?? "idle", this.reducedMotion ? 0 : t);
    if (l.lead.agentId) live.drawLeadLamp(p, l.ox, l.oy, states.get(l.lead.agentId) ?? "idle", t);
    live.drawBelt(p, l, this.reducedMotion ? 0 : t);
    for (const parcel of this.parcels) {
      const pos = parcelPos(parcel, this.belt);
      const pr = this.prs.get(parcel.num);
      if (!pos || !pr) continue;
      const inGate = l.gate && parcel.mode === "scan";
      if (!inGate) live.drawParcel(p, pos.x, pos.y - pos.lift, parcel.num, this.colorOf(pr.authorId), true);
    }
    if (l.gate) {
      const tool = snap.config.workflow.review.tool;
      const label = { coderabbit: "CodeRabbit", greptile: "Greptile", copilot: "Copilot", agent: "Agent review", human: "Human review", custom: "Review check" }[tool];
      live.drawGate(p, l.gate, this.gateMode.mode, t - this.gateMode.at, t, label, tool === "coderabbit");
    }

    // bots: shadows below, faces/emotes/tags above
    const sh = this.gShadow;
    sh.clear();
    const ps = new GfxPen(sh);
    const o = this.gOver;
    o.clear();
    const po = new GfxPen(o);
    for (const bot of this.bots.values()) {
      const state = states.get(bot.config.id) ?? "idle";
      drawShadow(ps, bot);
      drawFace(po, bot, state, t);
      if (bot.carry !== null) {
        const pr = this.prs.get(bot.carry);
        if (pr) live.drawParcel(po, bot.x, bot.headY - 2, pr.number, this.colorOf(pr.authorId), false);
      }
    }
    for (const bot of this.bots.values()) {
      const state = states.get(bot.config.id) ?? "idle";
      drawEmote(po, bot, state, t, t);
      if (bot.path.length || this.hover?.agentId === bot.config.id) drawNameTag(po, bot);
    }
    this.effects.draw(po, (id) => {
      const b = this.bots.get(id);
      return b ? { x: b.x, y: b.headY + 10 } : null;
    });
    if (this.hover) drawSelection(po, this.hover.rect, t);
  }
}
