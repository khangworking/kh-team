// The real data source: a WebSocket to the local HQ server.
// Server → browser: OfficeEvent JSON. Browser → server: { cmd, args }.

import type { OfficeDataSource, OfficeEvent } from "../source";

export function createWsSource(token: string): OfficeDataSource {
  let ws: WebSocket | null = null;
  const queue: string[] = [];

  const send = (cmd: string, ...args: unknown[]) => {
    const msg = JSON.stringify({ cmd, args });
    if (ws?.readyState === WebSocket.OPEN) ws.send(msg);
    else if (queue.length < 200) queue.push(msg);
  };

  const source: OfficeDataSource = {
    connect(onEvent, onStatus) {
      // Each connect() owns its socket and retry loop, so a stale one can't reconnect.
      let active = true;
      let retry = 0;
      let timer: number | null = null;
      let socket: WebSocket | null = null;

      const open = () => {
        if (!active) return;
        onStatus?.(retry ? "reconnecting" : "connecting");
        const proto = location.protocol === "https:" ? "wss" : "ws";
        const sock = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
        socket = sock;
        let opened = false;
        sock.onopen = () => {
          if (!active) return sock.close();
          opened = true;
          retry = 0;
          ws = sock;
          onStatus?.("open");
          while (queue.length) sock.send(queue.shift() as string);
        };
        sock.onmessage = (m) => {
          if (!active) return;
          try {
            onEvent(JSON.parse(String(m.data)) as OfficeEvent);
          } catch {
            /* ignore malformed frames */
          }
        };
        sock.onclose = () => {
          if (ws === sock) ws = null;
          if (!active) return;
          // Never opened, several times in a row: the token was rejected (HQ restarted).
          onStatus?.(!opened && retry > 2 ? "unauthorized" : "reconnecting");
          retry += 1;
          timer = window.setTimeout(open, Math.min(5000, 400 * retry));
        };
      };
      open();

      return () => {
        active = false;
        if (timer) window.clearTimeout(timer);
        // Closing mid-handshake logs a browser warning; onopen closes it instead.
        if (socket && socket.readyState !== WebSocket.CONNECTING) socket.close();
        if (ws === socket) ws = null;
      };
    },
    sendTerminalInput: (id, data) => send("sendTerminalInput", id, data),
    resizeTerminal: (id, cols, rows) => send("resizeTerminal", id, cols, rows),
    assignTask: (taskId, agentId) => send("assignTask", taskId, agentId),
    sendMessage: (toId, text) => send("sendMessage", toId, text),
    startAgent: (id) => send("startAgent", id),
    stopAgent: (id) => send("stopAgent", id),
    openWorkspace: (id) => send("openWorkspace", id),
    recreateSandbox: (id) => send("recreateSandbox", id),
    upgradeCli: (id) => send("upgradeCli", id),
    recheckSetup: () => send("recheckSetup"),
    runSetupFix: (id) => send("runSetupFix", id),
    addAgent: (input) => send("addAgent", input),
    updateAgent: (id, patch) => send("updateAgent", id, patch),
    removeAgent: (id, opts) => send("removeAgent", id, opts),
    inspectWorkspace: (id) => send("inspectWorkspace", id),
    updateSandbox: (id, patch) => send("updateSandbox", id, patch),
    setSecret: (id, name, value) => send("setSecret", id, name, value),
    openProviderKeys: () => send("openProviderKeys"),
    removeSecret: (id, name) => send("removeSecret", id, name),
    setProxy: (url) => send("setProxy", url),
    openEnvFile: (id) => send("openEnvFile", id),
    refreshSbx: () => send("refreshSbx"),
    updateWorkflow: (patch) => send("updateWorkflow", patch),
    updateProject: (patch) => send("updateProject", patch),
    createBoard: (title) => send("createBoard", title),
    updateBoard: (id, patch) => send("updateBoard", id, patch),
    completeWelcome: (input) => send("completeWelcome", input),
    openShell: (id) => send("openShell", id),
    closeShell: (id) => send("closeShell", id),
    openHostShell: (dir, fresh) => send("openHostShell", dir, fresh === true),
    closeHostShell: () => send("closeHostShell"),
    forwardPort: (agentId, port) => send("forwardPort", agentId, port),
    unforwardPort: (agentId, port) => send("unforwardPort", agentId, port),
    updateStack: (stack) => send("updateStack", stack),
    resolveActionItem: (id, decision, note) => send("resolveActionItem", id, decision, note),
    refreshMcp: () => send("refreshMcp"),
    addMcp: (input) => send("addMcp", input),
    authMcp: (name) => send("authMcp", name),
    removeMcp: (name) => send("removeMcp", name),
    setAgentMcp: (agentId, names) => send("setAgentMcp", agentId, names),
    answerApproval: (agentId, approvalId, decision) => send("answerApproval", agentId, approvalId, decision),
    resolveAccess: (requestId, decision) => send("resolveAccess", requestId, decision),
  };
  return source;
}
