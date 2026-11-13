# KH Team — Build Context (UI MVP, pixel office)

Context for an AI coding agent. Build the **complete KH Team interface with mock data and no real backend.** Every piece of data comes from one mock data source that follows the same interface the real local HQ server will use later.

Plan: `context/plans/001-jsm-hq-ui.md`.

---

## 1. Product

KH Team is a local web app: a 2D pixel-art office where a person runs a team of AI coding agents. It is a **general tool**: any repo, any team size, any review/deploy tools.

| Concept          | Meaning                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| Team             | 1 lead + any number of agents. Each agent: name, role name, model, skills, `ROLE.md`, sandbox settings |
| Lead             | The one special role. Plans and assigns work through the Team MCP. Writes no code                    |
| Agent role       | Free text ("Developer", "QA", "Designer"…). Every non-lead agent builds tasks and opens PRs          |
| Desk             | An agent's spot in the office. Represents its isolated Docker Sandbox                                |
| Board            | A kanban board. One project has many boards (per phase or per area). Each task is on exactly one board |
| Task             | One unit of work. One owner, one branch, one PR                                                      |
| Workflow         | Fixed stages Build → Review → Merge → Deploy. Each stage can be off and has a tool                   |
| Review gate      | The Review stage in the office. Tool is configurable (CodeRabbit, Greptile, Copilot, Human, custom)  |
| Environment      | A deployed copy of the project: `main` plus optionally one per agent                                 |
| Sandbox settings | Per agent: policy level, allowed/blocked domains, proxy, secret names                                |
| Team MCP         | The MCP server HQ hosts. Agent ↔ agent messages and lead commands all pass through HQ                |

**Confirmed backend fact:** a sandbox can reach HQ on the host via `host.docker.internal:<port>` once `sbx policy allow network` allows it. HQ will add that rule itself when it creates a sandbox, and every HQ endpoint requires a per-start token.

**Mock data:** two presets. **Askwell** (AI support chat widget): Michael (lead), Dwight and Jim (developers). **Big team**: 7 agents with mixed roles, used to test the layout.

---

## 2. Scope

| In scope                                                | Out of scope                                          |
| ------------------------------------------------------- | ----------------------------------------------------- |
| Pixel office that builds itself from config             | Real terminals, `node-pty`, Docker, GitHub, deploys   |
| HUD, drawers, settings screens                          | Any server, API route, or network call                |
| Mock data source + simulation that scales with the team | Auth, persistence, database                           |
| Terminal view (xterm.js) fed by fake output             | Running real commands, storing secret values          |
| Click, pan, zoom, keyboard                              | Mobile layout (desktop only, min width 1280px)        |

---

## 3. Stack

| Layer           | Choice                                                                 |
| --------------- | ---------------------------------------------------------------------- |
| Build           | Vite + React 18 + TypeScript (`strict`)                                |
| Office renderer | PixiJS v8, driven imperatively (no `@pixi/react`)                      |
| Sprites         | Drawn in code: character grids + pixel helpers → canvas → Pixi texture |
| State           | `zustand`                                                              |
| UI              | Tailwind CSS v4                                                        |
| Terminal        | `@xterm/xterm` + `@xterm/addon-fit`                                    |
| HUD animation   | `framer-motion`                                                        |
| Fonts           | `@fontsource` packages (bundled, no network): Pixelify Sans, VT323     |
| Package manager | pnpm                                                                   |

**No external assets.** Every sprite is drawn in code.

---

## 4. Folder structure

```
src/
  main.tsx, App.tsx, index.css
  data/
    types.ts                 # all domain types (section 5)
    source.ts                # OfficeDataSource interface (section 6)
    mock/
      presets.ts             # team + boards + tasks per preset
      simulation.ts          # per-agent state machines (section 7)
      terminalScripts.ts     # fake Claude Code output
      mockSource.ts          # implements OfficeDataSource
  store/
    office.ts                # zustand store, fed only by the data source
    ui.ts                    # selection, drawer, settings, hover, focus requests
  office/                    # PixiJS — never imported by data/
    OfficeCanvas.tsx         # React mount point
    OfficeScene.ts           # owns the Pixi app, syncs with the store
    engine/                  # palette, pen (pixel drawing), font, textures, camera, path
    layout/                  # generateLayout(config) → OfficeLayout
    draw/                    # static layer, furniture, robots, live layer
    actors/                  # bots (movement/behaviour), parcels, effects
  ui/
    hud/                     # TopBar, TeamPanel, ActivityFeed, Tooltip
    drawers/                 # Drawer, AgentDrawer, TerminalView, BoardsDrawer, PrDrawer, EnvironmentDrawer
    settings/                # SettingsModal + Team / Workflow / Sandbox / Boards / Project tabs
    DebugPanel.tsx
    kit.tsx                  # Panel, Button, Chip, Field…
  theme/tokens.ts
```

---

## 5. Domain types

`src/data/types.ts` is the source of truth. Summary:

```ts
// ---- Config (what the user sets) ----
type PolicyLevel = "open" | "balanced" | "locked";
interface SandboxSettings { policy: PolicyLevel; allow: string[]; deny: string[]; proxy: string | null; secrets: string[] } // secret NAMES only

interface AgentConfig {
  id: string; name: string; role: string; isLead: boolean;
  model: string; mode: "sandbox" | "local"; color: string;
  skills: string[]; roleMd: string; sandbox: SandboxSettings;
}

type ReviewTool = "coderabbit" | "greptile" | "copilot" | "human" | "custom";
type DeployTool = "instacloud" | "vercel" | "custom";
interface WorkflowConfig {
  review: { enabled: boolean; tool: ReviewTool; command: string };
  merge:  { by: "human" | "lead" };
  deploy: { enabled: boolean; tool: DeployTool; command: string; perAgentEnvironments: boolean };
}

interface ProjectConfig { name: string; repo: string; path: string; hqPort: number }
interface HqConfig { project: ProjectConfig; team: AgentConfig[]; workflow: WorkflowConfig }

// ---- Live state ----
type AgentState = "idle" | "working" | "needs-input" | "in-review" | "review-passed";
interface AgentStatus { agentId; state; currentTaskId; stateSince; note }

interface Board { id; title; status: "active" | "planned" | "done"; order }
type TaskStatus = "todo" | "in-progress" | "in-review" | "done" | "blocked";
interface Task { id; boardId; title; ownerId: string | null; status; needs: string[]; prNumber }

type ReviewState = "pending" | "reviewing" | "changes-requested" | "passed";
interface PullRequest { number; title; taskId; authorId; review; openComments; mergeable; merged; openedAt }
interface Environment { name; agentId: string | null; url; status: "live" | "deploying" | "sleeping"; lastDeployAt }
interface AgentMessage { id; at; fromId; toId; text }           // Team MCP traffic
interface ActivityEvent { id; at; type: ActivityType; agentId; text }

interface OfficeSnapshot {
  config: HqConfig; agents: AgentStatus[]; boards: Board[]; tasks: Task[];
  pullRequests: PullRequest[]; environments: Environment[];
  messages: AgentMessage[];   // newest first, last 100
  activity: ActivityEvent[];  // newest first, last 50
}
```

---

## 6. Data source interface

The UI never imports mock code. It talks only to `OfficeDataSource` through the store. A real WebSocket source replaces the mock later without UI changes.

```ts
interface OfficeDataSource {
  connect(onEvent: (e: OfficeEvent) => void): () => void;
  // agents + work
  sendTerminalInput(agentId: string, data: string): void;
  assignTask(taskId: string, agentId: string): void;
  // config
  addAgent(input: NewAgentInput): void;
  updateAgent(id: string, patch: AgentPatch): void;
  removeAgent(id: string): void;            // the lead cannot be removed
  updateSandbox(agentId: string, patch: Partial<SandboxSettings>): void;
  setSecret(agentId: string, name: string, value: string): void; // value goes to Docker's store, never kept by HQ
  removeSecret(agentId: string, name: string): void;
  updateWorkflow(patch: WorkflowPatch): void;
  updateProject(patch: Partial<ProjectConfig>): void;
  createBoard(title: string): void;
  updateBoard(id: string, patch: Partial<Pick<Board, "title" | "status">>): void;
  dev?: DevControls;                        // mock only: speed, presets
}
```

Events: `snapshot`, `config.updated`, `agent.updated`, `agent.removed`, `board.updated`, `task.updated`, `task.removed`, `pr.updated`, `env.updated`, `env.removed`, `message`, `activity`, `terminal.output`.

---

## 7. Mock simulation

Runs on a sim clock (1x / 2x / 4x). No fixed script: every non-lead agent runs the same loop, offset in time, so it scales with the team.

| Step            | What happens                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| Get work        | Agent needs a task → lead assigns one from the active board (`task.assigned` + Team MCP message lead → agent)   |
| Build           | `working` 10–18s. ~35% chance of `needs-input` mid-way (note = question), auto-answered after ~7s or by typing |
| Talk            | Sometimes an agent messages another agent through the Team MCP ("Changed the chat contract, pull main")       |
| Open PR         | Task `in-review`, PR opened, agent `in-review`. Agent environment redeploys                                    |
| Review          | If Review is on: `reviewing` → ~40% `changes-requested` (1–3 comments, agent fixes) → `passed`. If off: passes |
| Merge           | Agent `review-passed`, then merged by human or lead (per workflow). Task `done`                                |
| Deploy          | If Deploy is on: `main` deploying → live, `deploy` activity                                                    |
| Rest            | Agent `idle` a few seconds (coffee run), then gets work again                                                   |
| Lead            | Plans: tops up the active board with new tasks when it runs low; asks you to approve a plan now and then       |

Fake terminal output per agent follows these steps (Claude Code-like tool calls, ANSI colors, typed reasoning lines).

---

## 8. The office

Tile size 16px, integer zoom (2–5), drag to pan, scroll to zoom. Top-down ¾ view, PICO-8-flavoured palette.

### Layout (generated from config)

| Module      | Placement                                                                                    | Shown when            |
| ----------- | -------------------------------------------------------------------------------------------- | --------------------- |
| Lead corner | Top-left: plan wall on the back wall (active board), stand-up beanbags, lead desk          | always                |
| Lounge      | Top band, right of the lead corner: coffee machine, fridge, couch                           | always                |
| Desks       | Grid of cubicles below (7×7 tiles, 1-tile corridors). Columns: n ≤ 4 → n, else ⌈n/2⌉ (max 5) | one per non-lead      |
| PR belt     | Conveyor along the bottom, ending at `main`                                                 | always                |
| Review gate | On the belt, with tool label and the rabbit; PR board on an easel next to it                | `review.enabled`      |
| Server room | Right side behind glass: one rack per environment; cables from each desk to its rack        | `deploy.enabled`      |

### State → visual

| Agent state     | Desk strip / antenna | Emote          |
| --------------- | -------------------- | -------------- |
| `idle`          | lavender, dim        | Zz / wanders   |
| `working`       | blue, running light  | typing dots    |
| `needs-input`   | red, blinking        | red `!` bubble |
| `in-review`     | orange               | hourglass      |
| `review-passed` | green                | check          |

PR parcels ride the belt: desk → gate (scan) → back to the desk on changes, on through on pass → `main` on merge (rack pulses). Team MCP messages fly as envelopes between desks with a speech bubble.

---

## 9. Interaction

| Action                             | Result                                                     |
| ---------------------------------- | ---------------------------------------------------------- |
| Hover agent, desk, board, gate, rack | Selection brackets; tooltip with name + state            |
| Click agent or desk                | Camera flies to it; Agent drawer opens                     |
| Click plan wall                    | Boards drawer opens (on the active board)                 |
| Click PR board or gate             | PR drawer opens                                            |
| Click rack                         | Environment drawer opens                                   |
| Esc / close                        | Drawer or settings closes                                  |
| 1–9                                | Jump to agent N                                            |
| `D`                                | Toggle the debug panel                                     |

---

## 10. HUD

```
┌──────────────────────────────── TopBar ─────────────────────────────────┐
│ TeamPanel (left, 280px, scrolls)       office              Drawer        │
│                                                       (right, 520px)     │
│ ActivityFeed (bottom-left, 280px)                                        │
└──────────────────────────────────────────────────────────────────────────┘
```

| Component         | Content                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| TopBar            | Wordmark · project + repo · "Sandbox · N running" · active board picker · speed 1x/2x/4x · zoom · settings · debug |
| TeamPanel         | Card per agent: portrait, name, role, model, state chip, task, time in state. `needs-input` blinks + shows note  |
| ActivityFeed      | Newest first, icon per type, relative time                                                                      |
| AgentDrawer       | Header + tabs: **Terminal** (xterm, accepts typing) · **Task** · **Sandbox** · **Messages** (Team MCP)          |
| BoardsDrawer      | Board tabs; kanban of the selected board; assign a task to an agent                                             |
| PrDrawer          | Open PRs then merged: number, title, author, review chip, comments, mergeable. "Open on GitHub" disabled        |
| EnvironmentDrawer | Name, URL, status, last deploy, agent                                                                           |
| Settings          | Tabs: **Team** (add/remove/edit agents) · **Workflow** · **Sandbox** (per agent) · **Boards** · **Project**     |
| DebugPanel        | Raw snapshot as collapsible JSON, last 20 events, preset switcher                                               |

### Terminal input (mock)

Typing echoes. Enter → canned reply after 1s. An agent in `needs-input` returns to `working` on Enter.

---

## 11. Design tokens

PICO-8-flavoured "cozy management game" palette (`src/theme/tokens.ts`). Panels: cream with a 3px ink border, inset bevel and hard drop shadow (no blur). Terminal: navy.

| Token    | Hex       | Use                  |
| -------- | --------- | -------------------- |
| ink      | `#241a2e` | outlines, text       |
| cream    | `#fff6e9` | panels               |
| navy     | `#1d2b53` | dark panels, terminal |
| working  | `#29adff` | state                |
| input    | `#ff004d` | state                |
| review   | `#ffa300` | state                |
| passed   | `#00e436` | state                |
| idle     | `#83769c` | state                |

Same state colors in the office and the HUD. Agent colors come from config.

---

## 12. Code rules

| Rule           | Detail                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------- |
| Data access    | Components and the office read only from the zustand store. Only the store talks to the data source |
| Mock isolation | Everything fake lives in `src/data/mock/`                                                           |
| Config-driven  | Team size, roles, colors, gate, server room and labels all come from config                         |
| Files          | One concern per file, ~250 lines max                                                                |
| Types          | No `any`. Import domain types from `src/data/types.ts`                                              |
| Performance    | 60fps. Static layer drawn once per layout; live layer redrawn per frame; screens ≤ 4×/s             |
| Secrets        | Never store or display secret values                                                                |

---

## 13. Done when

- [ ] The office builds itself from config; 2, 3 and 7 agents each get a sensible layout; adding an agent adds a desk at once
- [ ] The simulation loops: states change, cards move, parcels go through the gate to deploy, the rabbit hops on pass
- [ ] Turning off Review or Deploy hides the gate or server room; tool names come from the workflow config
- [ ] Every object opens the right drawer, with a camera move
- [ ] The terminal streams fake output and accepts typing
- [ ] Team MCP messages show as envelopes/bubbles, in the Messages tab and in the activity feed
- [ ] Every settings screen edits the mock and the change shows up live
- [ ] 60fps, no console errors, no network requests
