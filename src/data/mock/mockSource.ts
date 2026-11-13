import { normalizeAuth } from "../providers";
import { agentPalette } from "../../theme/tokens";
import type { OfficeDataSource, OfficeEvent, SimSpeed } from "../source";
import { stackDomains } from "../stack";
import { HOST_TERMINAL, type AccessRequest, AgentConfig, AgentPatch, Board, NewAgentInput, ProjectConfig, SandboxSettings, WorkflowPatch } from "../types";
import { defaultPresetId, presets, type Preset } from "./presets";
import { Simulation } from "./simulation";
import * as T from "./terminalScripts";
import { mockSbx, mockSession, mockSetup, World } from "./world";

const TICK_MS = 50;
const TERM_MS = 30;


export function createMockSource(): OfficeDataSource {
  let presetId = defaultPresetId;
  let world = new World(findPreset(presetId));
  let sim = new Simulation(world);
  let listener: ((e: OfficeEvent) => void) | null = null;
  let timers: number[] = [];
  let last = 0;
  let inputBuf = new Map<string, string>();

  function findPreset(id: string): Preset {
    return presets.find((p) => p.id === id) ?? presets[0];
  }

  /** Fresh world for the current preset (keeps the speed). */
  function reset() {
    const speed = world.speed;
    world.clearTimers();
    world.setEmitter(null);
    world = new World(findPreset(presetId));
    world.speed = speed;
    sim = new Simulation(world);
    inputBuf = new Map();
    openShells.clear();
  }

  function boot() {
    world.setEmitter((e) => listener?.(e));
    listener?.({ type: "snapshot", snapshot: structuredClone(world.snap) });
    sim.start();
  }

  function loop() {
    const t = performance.now();
    const dt = Math.min(0.25, (t - last) / 1000) * world.speed;
    last = t;
    world.advance(dt);
    sim.tick(dt);
  }

  /** Rebuilds the mock "sbx" state from config, keeping any keys set in the UI. */
  function syncSbx() {
    const old = world.snap.sbx;
    const next = mockSbx(world.snap.config.team, world.snap.config.project.name);
    next.globalKeys = old.globalKeys;
    next.proxy = old.proxy;
    for (const id of Object.keys(next.agents)) if (old.agents[id]) (next.agents[id].keys = old.agents[id].keys), (next.agents[id].approvals = old.agents[id].approvals);
    world.snap.sbx = next;
    world.emit({ type: "sbx.updated", sbx: structuredClone(next) });
  }

  function hostCmd(agentId: string, text: string) {
    world.write(agentId, [{ text: `\x1b[38;2;102;114;159mhq ▸ ${text}\x1b[0m` }]);
  }

  /** Demo "Shell" tab: a pretend shell inside the agent's sandbox. */
  const shellPrompt = (id: string) =>
    id === HOST_TERMINAL
      ? `\x1b[38;2;108;240;138myou@mac\x1b[0m:\x1b[38;2;41;173;255m${hostDir}\x1b[0m$ `
      : `\x1b[38;2;108;240;138m${id.slice(6)}@sandbox\x1b[0m:\x1b[38;2;41;173;255m~/workspace\x1b[0m$ `;
  let hostDir = "~/askwell";
  const shellOut = (id: string, data: string) => listener?.({ type: "terminal.output", agentId: id, data });
  const DEMO_SHELL: Record<string, string> = {
    ls: "README.md  app  components  lib  package.json  pnpm-lock.yaml",
    pwd: "/Users/you/.kh-team/askwell/workspace",
    "git status": "On branch p3-t02-chat-route\r\nChanges not staged for commit:\r\n  modified:   app/api/chat/route.ts",
    "node -v": "v22.11.0",
    whoami: "agent",
    "npm run dev": "\x1b[1m  ▲ Next.js 15.1\x1b[0m\r\n  - Local:   http://localhost:3000\r\n\r\n ✓ Ready in 1.2s",
  };
  function demoShell(id: string, data: string) {
    let buf = inputBuf.get(id) ?? "";
    for (const ch of data) {
      if (ch === "\r") {
        const cmd = buf.trim();
        buf = "";
        shellOut(id, "\r\n");
        if (cmd) shellOut(id, `${DEMO_SHELL[cmd] ?? `(demo shell) ${cmd}: try ls, pwd, git status, node -v, npm run dev`}\r\n`);
        shellOut(id, shellPrompt(id));
      } else if (ch === "\x7f") {
        if (buf.length) (buf = buf.slice(0, -1)), shellOut(id, "\b \b");
      } else if (ch >= " ") {
        buf += ch;
        shellOut(id, ch);
      }
    }
    inputBuf.set(id, buf);
  }
  const openShells = new Set<string>();

  const source: OfficeDataSource = {
    connect(onEvent, onStatus) {
      listener = onEvent;
      onStatus?.("open");
      last = performance.now();
      reset();
      boot();
      timers = [
        window.setInterval(loop, TICK_MS),
        window.setInterval(() => world.flushTerminals(Math.max(1, Math.round(world.speed * 1.3))), TERM_MS),
      ];
      return () => {
        timers.forEach((id) => window.clearInterval(id));
        timers = [];
        world.clearTimers();
        world.setEmitter(null);
        listener = null;
      };
    },

    sendTerminalInput(agentId, data) {
      if (agentId.startsWith("shell:")) return openShells.has(agentId) ? demoShell(agentId, data) : undefined;
      // Echo printable input; act on Enter.
      let buf = inputBuf.get(agentId) ?? "";
      for (const ch of data) {
        if (ch === "\r") {
          const text = buf.trim();
          buf = "";
          listener?.({ type: "terminal.output", agentId, data: "\r\n" });
          if (!text) continue;
          const st = world.status(agentId);
          if (st?.state === "needs-input") {
            world.after(0.6, () => sim.answer(agentId, "you"));
          } else {
            world.after(1, () => world.write(agentId, T.cannedReply(!!world.cfg(agentId)?.isLead, text.length)));
          }
        } else if (ch === "\x7f") {
          if (buf.length) {
            buf = buf.slice(0, -1);
            listener?.({ type: "terminal.output", agentId, data: "\b \b" });
          }
        } else if (ch >= " ") {
          buf += ch;
          listener?.({ type: "terminal.output", agentId, data: ch });
        }
      }
      inputBuf.set(agentId, buf);
    },

    sendMessage(toId, text) {
      if (!world.cfg(toId) || !text.trim()) return;
      world.message("you", toId, text.trim());
      world.after(1.2, () => world.write(toId, T.cannedReply(!!world.cfg(toId)?.isLead, text.length)));
    },

    resizeTerminal() {
      // The mock streams plain lines, so size doesn't matter.
    },

    startAgent(id) {
      const st = world.status(id);
      if (!st || st.session.state === "running") return;
      world.setStatus(id, { session: { ...st.session, state: "running", detail: null } });
      world.activity("session", id, `${world.name(id)}'s session started`);
      if (!world.cfg(id)?.isLead) sim.startWorker(id, 1.5);
    },

    stopAgent(id) {
      const st = world.status(id);
      if (!st) return;
      if (openShells.has(`shell:${id}`)) source.closeShell(id);
      sim.stopAgent(id);
      world.setStatus(id, { state: "idle", currentTaskId: null, note: "Stopped", session: { ...st.session, state: "stopped", detail: null } });
      world.activity("session", id, `${world.name(id)}'s session stopped`);
    },

    recreateSandbox(id) {
      const st = world.status(id);
      const r = world.cfg(id)?.sandbox.resources;
      if (!st || !r) return;
      world.setStatus(id, { session: { ...st.session, sandbox: { cpus: r.cpus ?? 8, memoryGb: r.memoryGb ?? 8 } } });
      hostCmd(id, `sbx rm hq-…-${id} && sbx run --cpus ${r.cpus ?? "auto"} --memory ${r.memoryGb ?? "auto"}g … (mock)`);
      world.activity("session", id, `Recreated ${world.name(id)}'s sandbox`);
    },

    upgradeCli(id) {
      const info = world.snap.cliVersions?.[id];
      const target = info?.pinned || info?.latest;
      if (!info || !target || !world.snap.cliVersions) return;
      world.snap.cliVersions[id] = { ...info, upgrading: true };
      world.emit({ type: "cliVersions.updated", cliVersions: structuredClone(world.snap.cliVersions) });
      setTimeout(() => {
        if (!world.snap.cliVersions) return;
        world.snap.cliVersions[id] = { ...info, installed: target, checkedAt: new Date().toISOString() };
        world.activity("session", id, `${world.name(id)}: ${info.cli} ${info.installed} → ${target} (mock). It takes effect the next time ${world.name(id)} starts.`);
        world.emit({ type: "cliVersions.updated", cliVersions: structuredClone(world.snap.cliVersions) });
      }, 2500);
    },

    openWorkspace(id) {
      hostCmd(id, `open ${world.status(id)?.session.workspace ?? "?"} (mock: nothing opens)`);
    },

    recheckSetup() {
      world.snap.setup = mockSetup();
      world.emit({ type: "setup.updated", setup: world.snap.setup });
    },

    runSetupFix() {
      // Everything is installed in the mock.
    },

    assignTask(taskId, agentId) {
      const task = world.task(taskId);
      const agent = world.cfg(agentId);
      if (!task || !agent || agent.isLead || task.status !== "todo") return;
      world.patchTask(taskId, { ownerId: agentId });
      world.activity("task.assigned", null, `You assigned ${taskId} ${task.title} to ${agent.name}`);
      if (!sim.hasJob(agentId) && world.status(agentId)?.state === "idle") {
        world.message(world.lead().id, agentId, `Pull main, start ${taskId}.`);
        world.after(1, () => sim.begin(agentId, taskId), agentId);
      }
    },

    addAgent(input: NewAgentInput) {
      const team = world.snap.config.team;
      const base = T.slug(input.name) || "agent";
      let id = base;
      for (let i = 2; team.some((a) => a.id === id); i++) id = `${base}-${i}`;
      const used = new Set(team.map((a) => a.color));
      const color = agentPalette.find((c) => !used.has(c)) ?? agentPalette[team.length % agentPalette.length];
      const lead = world.lead();
      const agent: AgentConfig = {
        id, name: input.name.trim() || "Agent", role: input.role.trim() || "Developer", isLead: false, cli: input.cli ?? "claude",
        ...normalizeAuth(input.cli ?? "claude", input.auth, input.provider),
        model: input.model ?? "", mode: input.mode, color, skills: ["plan", "review"],
        roleMd: `# ${input.name} — ${input.role}\n\nYou build the tasks assigned to you.`,
        sandbox: structuredClone(lead.sandbox),
        workspacePath: null,
      };
      team.push(agent);
      world.snap.agents.push({
        agentId: id, state: "idle", currentTaskId: null, stateSince: new Date().toISOString(), note: null,
        session: mockSession(world.snap.config.project.name, id),
      });
      world.configChanged();
      world.emit({ type: "agent.updated", agent: { ...world.snap.agents[world.snap.agents.length - 1] } });
      world.syncEnvironments();
      world.activity("config", null, `Added ${agent.name} (${agent.role}) — new sandbox starting`);
      world.write(id, T.banner(agent.name, agent.role, world.snap.config.project.repo, agent.mode));
      hostCmd(id, `sbx run claude · allow host.docker.internal:${world.snap.config.project.hqPort}`);
      syncSbx();
      sim.startWorker(id, 2);
    },

    updateAgent(id, patch: AgentPatch) {
      const agent = world.cfg(id);
      if (!agent) return;
      Object.assign(agent, patch);
      if (patch.cliVersion !== undefined && world.snap.cliVersions?.[id]) {
        world.snap.cliVersions[id] = { ...world.snap.cliVersions[id], pinned: patch.cliVersion || null };
        world.emit({ type: "cliVersions.updated", cliVersions: structuredClone(world.snap.cliVersions) });
      }
      world.configChanged();
    },

    inspectWorkspace(id) {
      const st = world.status(id);
      if (!st) return;
      listener?.({
        type: "workspace.info",
        info: { agentId: id, path: st.session.workspace ?? "", managed: true, exists: true, changedFiles: 1, unpushedCommits: 2, sandboxName: `hq-mock-${id}`, sandboxExists: true },
      });
    },

    removeAgent(id) {
      const agent = world.cfg(id);
      if (!agent || agent.isLead) return;
      if (openShells.has(`shell:${id}`)) source.closeShell(id);
      sim.stopAgent(id);
      world.snap.config.team = world.snap.config.team.filter((a) => a.id !== id);
      world.snap.agents = world.snap.agents.filter((a) => a.agentId !== id);
      for (const t of world.snap.tasks)
        if (t.ownerId === id && t.status !== "done") world.patchTask(t.id, { ownerId: null, status: t.status === "in-progress" ? "todo" : t.status });
      world.emit({ type: "agent.removed", agentId: id });
      world.configChanged();
      world.syncEnvironments();
      world.activity("config", null, `Removed ${agent.name} — sandbox stopped`);
    },

    updateSandbox(agentId, patch: Partial<SandboxSettings>) {
      const agent = world.cfg(agentId);
      if (!agent) return;
      Object.assign(agent.sandbox, structuredClone(patch));
      world.configChanged();
      if (patch.allow || patch.deny) {
        hostCmd(agentId, `sbx policy allow/deny network --sandbox hq-mock-${agentId} … (mock)`);
        syncSbx();
      }
      world.activity("config", agentId, `Updated ${agent.name}'s sandbox settings`);
    },

    setSecret(agentId, service, value) {
      void value; // A real source pipes this to `sbx secret set`; HQ never keeps it.
      const sbx = world.snap.sbx;
      if (agentId === null) sbx.globalKeys = [...new Set([...sbx.globalKeys, service])];
      else if (sbx.agents[agentId]) sbx.agents[agentId].keys = [...new Set([...sbx.agents[agentId].keys, service])];
      world.emit({ type: "sbx.updated", sbx: structuredClone(sbx) });
      world.activity("config", agentId, `Stored the ${service} key ${agentId ? `for ${world.name(agentId)}` : "for every sandbox"} (mock)`);
    },

    removeSecret(agentId, service) {
      const sbx = world.snap.sbx;
      if (agentId === null) sbx.globalKeys = sbx.globalKeys.filter((k) => k !== service);
      else if (sbx.agents[agentId]) sbx.agents[agentId].keys = sbx.agents[agentId].keys.filter((k) => k !== service);
      world.emit({ type: "sbx.updated", sbx: structuredClone(sbx) });
    },

    setProxy(url) {
      world.snap.sbx.proxy = url;
      world.emit({ type: "sbx.updated", sbx: structuredClone(world.snap.sbx) });
    },

    openEnvFile(agentId) {
      hostCmd(agentId, `open ${world.snap.sbx.agents[agentId]?.envFile.path ?? "?"} (mock: nothing opens)`);
    },

    openProviderKeys() {
      world.snap.providerKeys = ["anthropic", "deepseek"];
      world.emit({ type: "providerKeys.updated", providers: [...world.snap.providerKeys] });
    },

    refreshSbx() {
      syncSbx();
    },

    resolveActionItem(id, decision, note) {
      const item = world.snap.actionItems?.find((i) => i.id === id);
      if (!item || item.status !== "open") return;
      item.status = decision;
      item.note = note?.trim() || null;
      item.closedAt = new Date().toISOString();
      world.emit({ type: "action.updated", item: { ...item } });
      world.message("you", item.fromId, decision === "done" ? `Done: ${item.title}${item.note ? ` (${item.note})` : ""}` : `Dismissed: ${item.title}${item.note ? ` (${item.note})` : ""}`);
    },

    refreshMcp() {
      if (world.snap.mcp) world.emit({ type: "mcp.updated", mcp: structuredClone(world.snap.mcp) });
    },

    addMcp(input) {
      const m = world.snap.mcp;
      const name = input.name.trim().toLowerCase();
      if (!m || !name || m.servers.some((s) => s.name === name)) return;
      m.servers.push({ name, transport: input.command ? "local stdio" : "remote http", status: input.apiKey || input.command ? "ready" : "needs-auth", nextStep: null });
      world.activity("config", null, `Added MCP server ${name}`);
      world.emit({ type: "mcp.updated", mcp: structuredClone(m) });
    },

    authMcp(name) {
      const m = world.snap.mcp;
      const s = m?.servers.find((x) => x.name === name);
      if (!m || !s) return;
      listener?.({ type: "terminal.output", agentId: `setup:mcp-auth-${name}`, data: `\x1b[2m$ sbx mcp auth ${name}\x1b[0m\r\nOpening your browser to sign in… (demo)\r\n\x1b[32m✓ Done\x1b[0m\r\n` });
      s.status = "ready";
      s.nextStep = null;
      world.emit({ type: "mcp.updated", mcp: structuredClone(m) });
    },

    removeMcp(name) {
      const m = world.snap.mcp;
      if (!m) return;
      m.servers = m.servers.filter((s) => s.name !== name);
      for (const a of world.snap.config.team) if (a.mcp?.includes(name)) a.mcp = a.mcp.filter((n) => n !== name);
      for (const id of Object.keys(m.attached)) m.attached[id] = m.attached[id].filter((n) => n !== name);
      world.configChanged();
      world.emit({ type: "mcp.updated", mcp: structuredClone(m) });
    },

    setAgentMcp(agentId, names) {
      const agent = world.cfg(agentId);
      const m = world.snap.mcp;
      if (!agent || !m) return;
      const added = names.filter((n) => !(agent.mcp ?? []).includes(n));
      agent.mcp = [...names];
      // Demo: running agents get new servers right away; unticked ones stay until the sandbox is recreated.
      if (world.status(agentId)?.session.state === "running") {
        m.attached[agentId] = [...new Set([...(m.attached[agentId] ?? []), ...added])];
        for (const n of added) hostCmd(agentId, `sbx mcp load ${n} --sandbox hq-mock-${agentId} (mock)`);
      }
      world.configChanged();
      world.emit({ type: "mcp.updated", mcp: structuredClone(m) });
    },

    answerApproval(agentId, approvalId, decision) {
      const st = world.snap.sbx.agents[agentId];
      const target = st?.approvals.find((a) => a.id === approvalId);
      if (!st || (approvalId !== "all" && !target)) return;
      if (decision === "allow") {
        const agent = world.cfg(agentId);
        const hosts = [...new Set((target ? [target] : st.approvals).map((a) => a.host))];
        for (const host of hosts) {
          if (agent && !agent.sandbox.allow.includes(host)) agent.sandbox.allow = [...agent.sandbox.allow, host];
          hostCmd(agentId, `sbx policy allow network --sandbox hq-mock-${agentId} ${host} (mock)`);
        }
        world.configChanged();
        world.activity("config", agentId, `You allowed ${target ? target.host : `${hosts.length} sites`} for ${world.name(agentId)}'s sandbox`);
      }
      st.approvals = approvalId === "all" ? [] : st.approvals.filter((a) => (decision === "allow" ? a.host !== target?.host : a.id !== approvalId));
      syncSbx();
    },

    updateWorkflow(patch: WorkflowPatch) {
      const wf = world.snap.config.workflow;
      Object.assign(wf.review, patch.review);
      Object.assign(wf.merge, patch.merge);
      Object.assign(wf.deploy, patch.deploy);
      if (typeof patch.budget?.dailyUsd === "number") wf.budget = { dailyUsd: Math.max(0, patch.budget.dailyUsd) };
      world.configChanged();
      world.syncEnvironments();
      sim.workflowChanged();
      world.activity("config", null, "Workflow updated");
    },

    updateProject(patch: Partial<ProjectConfig>) {
      Object.assign(world.snap.config.project, patch);
      world.configChanged();
      world.syncEnvironments();
    },

    createBoard(title) {
      const clean = title.trim();
      if (!clean) return;
      const base = clean.split(/\s+/).map((w) => w[0]).join("").toUpperCase().slice(0, 3) || "B";
      let id = base;
      for (let i = 2; world.snap.boards.some((b) => b.id === id); i++) id = `${base}${i}`;
      const board: Board = { id, title: clean, status: "planned", order: world.snap.boards.length };
      world.snap.boards.push(board);
      world.emit({ type: "board.updated", board: { ...board } });
      world.activity("config", null, `Created board ${clean}`);
    },

    updateBoard(id, patch) {
      const board = world.snap.boards.find((b) => b.id === id);
      if (!board) return;
      Object.assign(board, patch);
      world.emit({ type: "board.updated", board: { ...board } });
    },

    openShell(id) {
      const tid = `shell:${id}`;
      if (openShells.has(tid)) return;
      openShells.add(tid);
      inputBuf.delete(tid);
      shellOut(tid, `\x1b[2m$ sbx exec -it hq-mock-${id} bash   (demo)\x1b[0m\r\n${shellPrompt(tid)}`);
    },

    openHostShell(dir, fresh) {
      const want = dir.trim() || "~/askwell";
      if (openShells.has(HOST_TERMINAL) && !fresh && want === hostDir) return;
      if (openShells.has(HOST_TERMINAL)) shellOut(HOST_TERMINAL, "\x1bc");
      hostDir = want;
      openShells.add(HOST_TERMINAL);
      inputBuf.delete(HOST_TERMINAL);
      shellOut(HOST_TERMINAL, `\x1b[2m$ zsh in ${hostDir}   (demo)\x1b[0m\r\n${shellPrompt(HOST_TERMINAL)}`);
    },

    closeHostShell() {
      openShells.delete(HOST_TERMINAL);
    },

    forwardPort(agentId, port) {
      const st = world.snap.sbx.agents[agentId];
      if (!st || st.ports?.some((p) => p.sandbox === port)) return;
      st.ports = [...(st.ports ?? []), { sandbox: port, host: port }].sort((a, b) => a.sandbox - b.sandbox);
      world.emit({ type: "sbx.updated", sbx: structuredClone(world.snap.sbx) });
      world.activity("config", agentId, `Forwarded port ${port} from ${world.name(agentId)}'s sandbox to localhost:${port} on this machine. (demo)`);
    },

    unforwardPort(agentId, port) {
      const st = world.snap.sbx.agents[agentId];
      if (!st) return;
      st.ports = (st.ports ?? []).filter((p) => p.sandbox !== port);
      world.emit({ type: "sbx.updated", sbx: structuredClone(world.snap.sbx) });
    },

    closeShell(id) {
      openShells.delete(`shell:${id}`);
      inputBuf.delete(`shell:${id}`);
      shellOut(`shell:${id}`, "\r\n\x1b[2m[shell closed]\x1b[0m\r\n");
    },

    completeWelcome() {
      // The demo never shows the welcome screen.
    },

    updateStack(stack) {
      if (stack) world.snap.config.stack = structuredClone(stack);
      else delete world.snap.config.stack;
      world.configChanged();
    },

    resolveAccess(requestId, decision) {
      const req = world.snap.accessRequests?.find((r) => r.id === requestId);
      if (!req || req.status !== "pending") return;
      req.status = decision === "deny" ? "denied" : "allowed";
      world.emit({ type: "access.updated", request: { ...req } });
      const who = world.name(req.agentId);
      if (decision === "deny") {
        world.activity("config", req.agentId, `You denied ${who} access to ${req.domain}`);
        world.write(req.agentId, [{ text: `\x1b[38;2;255;0;77mhq ▸ access to ${req.domain} denied — continuing without it\x1b[0m` }]);
      } else {
        const ids = decision === "everyone" ? world.snap.config.team.filter((a) => a.mode === "sandbox").map((a) => a.id) : [req.agentId];
        for (const id of ids) {
          const a = world.cfg(id);
          if (a && !a.sandbox.allow.includes(req.domain)) a.sandbox.allow = [...a.sandbox.allow, req.domain];
          hostCmd(id, `sbx policy allow network --sandbox hq-mock-${id} ${req.domain} (mock)`);
        }
        world.configChanged();
        syncSbx();
        world.activity("config", req.agentId, `You allowed ${req.domain} for ${decision === "everyone" ? "every agent" : who}`);
      }
      if (world.status(req.agentId)?.state === "needs-input") world.setStatus(req.agentId, { state: "working", note: decision === "deny" ? "Continuing without it" : `Reading ${req.domain}` });
    },

    dev: {
      presets: presets.map((p) => ({ id: p.id, label: p.label })),
      loadPreset(id) {
        presetId = id;
        reset();
        boot();
      },
      setSpeed(multiplier: SimSpeed) {
        world.speed = multiplier;
      },
      simulateAccessRequest() {
        const busy = world.snap.agents.filter((s) => s.session.state === "running" && s.state !== "needs-input" && !world.cfg(s.agentId)?.isLead);
        const st = busy[Math.floor(Math.random() * busy.length)];
        if (!st) return;
        // A domain this agent can't reach yet: from the stack if any, else a common docs site.
        const allowed = new Set(world.cfg(st.agentId)?.sandbox.allow ?? []);
        const open = (list: string[]) => list.filter((d) => !d.startsWith("*.") && !allowed.has(d));
        const fromStack = open(stackDomains(world.snap.config.stack).map((d) => d.domain));
        const pool = fromStack.length ? fromStack : open(["posthog.com", "docs.stripe.com", "hono.dev", "docs.arcjet.com"]);
        const domain = pool[Math.floor(Math.random() * pool.length)] ?? "example.com";
        const req: AccessRequest = { id: world.id("ar"), agentId: st.agentId, domain, reason: `Read the ${domain} docs before integrating it`, at: new Date().toISOString(), status: "pending" };
        world.snap.accessRequests = [req, ...(world.snap.accessRequests ?? [])].slice(0, 30);
        world.emit({ type: "access.updated", request: { ...req } });
        world.setStatus(st.agentId, { state: "needs-input", note: `Asking: access to ${domain}` });
        world.activity("agent.needs-input", st.agentId, `${world.name(st.agentId)} needs you: access to ${domain}`);
        world.write(st.agentId, [{ text: `\x1b[38;2;255;163;0mhq ▸ request_access ${domain} — "${req.reason}" (waiting for you)\x1b[0m` }]);
      },
    },
  };

  return source;
}
