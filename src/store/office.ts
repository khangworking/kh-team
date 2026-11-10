// The office store: the only place that talks to the data source.
// Components and the PixiJS scene read from here.

import { create } from "zustand";
import { createMockSource } from "../data/mock/mockSource";
import type { ConnectionStatus, DataPreset, OfficeDataSource, OfficeEvent, SimSpeed } from "../data/source";
import { createWsSource } from "../data/ws/wsSource";
import type { StackConfig } from "../data/stack";
import type { AccessDecision, NewMcpServer, AgentConfig, AgentStatus, OfficeSnapshot, RemoveAgentOptions, SetupCheckId, WelcomeInput, WorkspaceInfo } from "../data/types";
import { appendTerminal, clearTerminals } from "./terminal";

export interface LoggedEvent {
  n: number;
  at: number;
  event: OfficeEvent;
}

interface OfficeState {
  snap: OfficeSnapshot | null;
  epoch: number; // bumps on every full snapshot (e.g. a preset reload)
  events: LoggedEvent[]; // last 20, terminal output excluded
  terminalChunks: number;
  speed: SimSpeed;
  presets: DataPreset[] | null;
  live: boolean; // connected to a real HQ server (vs. the demo mock)
  workspaceInfo: Record<string, WorkspaceInfo>; // answers to inspectWorkspace
  connection: ConnectionStatus;
  source: OfficeDataSource;
}

/**
 * HQ opens the UI with `?token=…`. With a token we talk to the real server;
 * without one (plain `pnpm dev`) the UI runs on the mock.
 */
function hqToken(): string | null {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    try {
      sessionStorage.setItem("hq-token", fromUrl);
    } catch {
      /* private mode */
    }
    url.searchParams.delete("token");
    history.replaceState(null, "", url.toString()); // keep the token out of history and screenshots
    return fromUrl;
  }
  try {
    return sessionStorage.getItem("hq-token");
  } catch {
    return null;
  }
}

const token = hqToken();
const source: OfficeDataSource = token ? createWsSource(token) : createMockSource();

export const useOffice = create<OfficeState>(() => ({
  snap: null,
  epoch: 0,
  events: [],
  terminalChunks: 0,
  speed: 1,
  presets: source.dev?.presets ?? null,
  live: token !== null,
  workspaceInfo: {},
  connection: "connecting",
  source,
}));

let eventN = 0;

function upsert<T>(list: T[], item: T, same: (a: T) => boolean): T[] {
  const i = list.findIndex(same);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

function reduce(snap: OfficeSnapshot, e: OfficeEvent): OfficeSnapshot {
  switch (e.type) {
    case "snapshot":
      return e.snapshot;
    case "workspace.info":
      return snap;
    case "sbx.updated":
      return { ...snap, sbx: e.sbx };
    case "providerKeys.updated":
      return { ...snap, providerKeys: e.providers };
    case "setup.updated":
      return { ...snap, setup: e.setup };
    case "config.updated":
      return { ...snap, config: e.config };
    case "agent.updated":
      return { ...snap, agents: upsert(snap.agents, e.agent, (a) => a.agentId === e.agent.agentId) };
    case "agent.removed":
      return { ...snap, agents: snap.agents.filter((a) => a.agentId !== e.agentId) };
    case "board.updated":
      return { ...snap, boards: upsert(snap.boards, e.board, (b) => b.id === e.board.id) };
    case "task.updated":
      return { ...snap, tasks: upsert(snap.tasks, e.task, (t) => t.id === e.task.id) };
    case "task.removed":
      return { ...snap, tasks: snap.tasks.filter((t) => t.id !== e.taskId) };
    case "pr.updated":
      return { ...snap, pullRequests: upsert(snap.pullRequests, e.pr, (p) => p.number === e.pr.number) };
    case "env.updated":
      return { ...snap, environments: upsert(snap.environments, e.env, (x) => x.name === e.env.name) };
    case "env.removed":
      return { ...snap, environments: snap.environments.filter((x) => x.name !== e.name) };
    case "message":
      return { ...snap, messages: [e.message, ...snap.messages].slice(0, 100) };
    case "activity":
      return { ...snap, activity: [e.event, ...snap.activity].slice(0, 50) };
    case "terminal.output":
      return snap;
    case "action.updated":
      return { ...snap, actionItems: upsert(snap.actionItems ?? [], e.item, (i) => i.id === e.item.id) };
    case "mcp.updated":
      return { ...snap, mcp: e.mcp };
    case "access.updated":
      return { ...snap, accessRequests: upsert(snap.accessRequests ?? [], e.request, (r) => r.id === e.request.id) };
  }
}

function handle(e: OfficeEvent) {
  if (e.type === "terminal.output") {
    appendTerminal(e.agentId, e.data);
    useOffice.setState((s) => ({ terminalChunks: s.terminalChunks + 1 }));
    return;
  }
  if (e.type === "workspace.info") {
    useOffice.setState((s) => ({ workspaceInfo: { ...s.workspaceInfo, [e.info.agentId]: e.info } }));
    return;
  }
  if (e.type === "snapshot") clearTerminals();
  useOffice.setState((s) => {
    const base = s.snap ?? (e.type === "snapshot" ? e.snapshot : null);
    if (!base) return {};
    eventN += 1;
    return {
      snap: reduce(base, e),
      epoch: e.type === "snapshot" ? s.epoch + 1 : s.epoch,
      events: [{ n: eventN, at: Date.now(), event: e }, ...s.events].slice(0, 20),
    };
  });
}

let disconnect: (() => void) | null = null;

export function connectOffice() {
  if (disconnect) return disconnect;
  disconnect = source.connect(handle, (connection) => useOffice.setState({ connection }));
  return () => {
    disconnect?.();
    disconnect = null;
  };
}

// ---------------------------------------------------------------- actions

export const officeActions = {
  sendTerminalInput: (agentId: string, data: string) => source.sendTerminalInput(agentId, data),
  resizeTerminal: (agentId: string, cols: number, rows: number) => source.resizeTerminal(agentId, cols, rows),
  startAgent: (id: string) => source.startAgent(id),
  stopAgent: (id: string) => source.stopAgent(id),
  openWorkspace: (id: string) => source.openWorkspace(id),
  recreateSandbox: (id: string) => source.recreateSandbox(id),
  openShell: (id: string) => source.openShell(id),
  closeShell: (id: string) => source.closeShell(id),
  openHostShell: (dir: string, fresh?: boolean) => source.openHostShell(dir, fresh),
  closeHostShell: () => source.closeHostShell(),
  forwardPort: (agentId: string, port: number) => source.forwardPort(agentId, port),
  unforwardPort: (agentId: string, port: number) => source.unforwardPort(agentId, port),
  recheckSetup: () => source.recheckSetup(),
  runSetupFix: (id: SetupCheckId) => source.runSetupFix(id),
  assignTask: (taskId: string, agentId: string) => source.assignTask(taskId, agentId),
  sendMessage: (toId: string, text: string) => source.sendMessage(toId, text),
  addAgent: source.addAgent.bind(source),
  updateAgent: source.updateAgent.bind(source),
  removeAgent: (id: string, opts?: RemoveAgentOptions) => source.removeAgent(id, opts),
  inspectWorkspace: (id: string) => source.inspectWorkspace(id),
  updateSandbox: source.updateSandbox.bind(source),
  setSecret: (agentId: string | null, service: string, value: string) => source.setSecret(agentId, service, value),
  removeSecret: (agentId: string | null, service: string) => source.removeSecret(agentId, service),
  setProxy: (url: string | null) => source.setProxy(url),
  openEnvFile: (id: string) => source.openEnvFile(id),
  openProviderKeys: () => source.openProviderKeys(),
  refreshSbx: () => source.refreshSbx(),
  answerApproval: (agentId: string, approvalId: string, decision: "allow" | "dismiss") => source.answerApproval(agentId, approvalId, decision),
  updateWorkflow: source.updateWorkflow.bind(source),
  updateProject: source.updateProject.bind(source),
  createBoard: source.createBoard.bind(source),
  updateBoard: source.updateBoard.bind(source),
  completeWelcome: (input: WelcomeInput) => source.completeWelcome(input),
  updateStack: (stack: StackConfig | null) => source.updateStack(stack),
  resolveActionItem: (id: string, decision: "done" | "dismissed", note?: string) => source.resolveActionItem(id, decision, note),
  refreshMcp: () => source.refreshMcp(),
  addMcp: (input: NewMcpServer) => source.addMcp(input),
  authMcp: (name: string) => source.authMcp(name),
  removeMcp: (name: string) => source.removeMcp(name),
  setAgentMcp: (agentId: string, names: string[]) => source.setAgentMcp(agentId, names),
  resolveAccess: (requestId: string, decision: AccessDecision) => source.resolveAccess(requestId, decision),
  simulateAccessRequest: () => source.dev?.simulateAccessRequest(),
  setSpeed(speed: SimSpeed) {
    source.dev?.setSpeed(speed);
    useOffice.setState({ speed });
  },
  loadPreset(id: string) {
    source.dev?.loadPreset(id);
  },
};

// ---------------------------------------------------------------- selectors

export interface AgentView {
  config: AgentConfig;
  status: AgentStatus;
}

/** Team in config order, joined with live status. */
export function selectTeam(snap: OfficeSnapshot | null): AgentView[] {
  if (!snap) return [];
  return snap.config.team.flatMap((config) => {
    const status = snap.agents.find((a) => a.agentId === config.id);
    return status ? [{ config, status }] : [];
  });
}

export const reviewToolLabel = {
  coderabbit: "CodeRabbit",
  greptile: "Greptile",
  copilot: "Copilot",
  human: "Human review",
  custom: "Custom check",
} as const;

export const deployToolLabel = { instacloud: "InstaCloud", vercel: "Vercel", custom: "Custom deploy" } as const;

/** Everything waiting on the user: open action items, agents asking in the terminal, access requests, blocked requests, PRs ready to merge. */
export function selectAttention(snap: OfficeSnapshot | null) {
  if (!snap) return { items: [], asking: [], access: [], blocked: [], readyPrs: [], total: 0 };
  const items = (snap.actionItems ?? []).filter((i) => i.status === "open");
  const access = (snap.accessRequests ?? []).filter((r) => r.status === "pending");
  const asking = snap.agents.filter((a) => a.state === "needs-input" && !access.some((r) => r.agentId === a.agentId));
  const blocked = snap.config.team.map((a) => ({ agentId: a.id, count: snap.sbx.agents[a.id]?.approvals?.length ?? 0 })).filter((b) => b.count > 0);
  const readyPrs = snap.pullRequests.filter((p) => p.review === "passed" && p.mergeable && !p.merged && !p.closed);
  return { items, asking, access, blocked, readyPrs, total: items.length + asking.length + access.length + blocked.length + readyPrs.length };
}
