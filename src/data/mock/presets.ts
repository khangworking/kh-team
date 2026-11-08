import type { AgentConfig, Board, HqConfig, SandboxSettings, Task } from "../types";

export interface Preset {
  id: string;
  label: string;
  config: HqConfig;
  boards: Board[];
  tasks: Task[];
  /** PRs already merged before the session starts (numbered 1..n). */
  mergedPrs: number;
  /** Titles the lead uses when it tops up the active board. */
  taskPool: string[];
  questions: string[];
  leadQuestions: string[];
}

const sandbox = (extra: Partial<SandboxSettings> = {}): SandboxSettings => ({
  resources: { cpus: null, memoryGb: null },
  allow: ["registry.npmjs.org"],
  deny: [],
  ...extra,
});

function agent(
  id: string,
  name: string,
  role: string,
  color: string,
  opts: Partial<AgentConfig> = {},
): AgentConfig {
  const isLead = opts.isLead ?? false;
  return {
    id,
    name,
    role,
    isLead,
    cli: "claude",
    auth: "subscription",
    provider: "anthropic",
    model: isLead ? "Opus" : "Sonnet",
    mode: "sandbox",
    color,
    skills: isLead ? ["plan", "review", "honest"] : ["plan", "debug", "review"],
    roleMd: isLead
      ? `# ${name} — Lead\n\nYou plan and assign work. You never write app code.\nUse the HQ Team MCP: list_workers, get_status, assign_task, send_message.`
      : `# ${name} — ${role}\n\nYou build the tasks assigned to you. One task = one branch = one PR.\nOnly edit the files your task file allows.`,
    sandbox: sandbox(isLead ? {} : { allow: ["registry.npmjs.org", "console.instacloud.com"] }),
    workspacePath: null,
    ...opts,
  };
}

function doneTasks(boardId: string, titles: [string, string][], startPr: number): Task[] {
  return titles.map(([title, ownerId], i) => ({
    id: `${boardId}-T${String(i + 1).padStart(2, "0")}`,
    boardId,
    title,
    ownerId,
    status: "done",
    needs: [],
    prNumber: startPr + i,
  }));
}

// ---------------------------------------------------------------- Askwell (3 agents)

const askwell: Preset = {
  id: "askwell",
  label: "Askwell · 3 agents",
  config: {
    project: { id: "askwell", name: "Askwell", repo: "jsmastery-pro/askwell", path: "~/developer/askwell", hqPort: 7420 },
    team: [
      agent("michael", "Michael", "Lead", "#ff77a8", { isLead: true }),
      agent("dwight", "Dwight", "Developer", "#29adff"),
      agent("jim", "Jim", "Developer", "#ffd23a"),
    ],
    workflow: {
      review: { enabled: true, tool: "coderabbit", command: "" },
      merge: { by: "human" },
      deploy: { enabled: true, tool: "instacloud", command: "", perAgentEnvironments: true },
    },
  },
  boards: [
    { id: "P0", title: "Phase 0 — Setup", status: "done", order: 0 },
    { id: "P1", title: "Phase 1 — Foundation", status: "done", order: 1 },
    { id: "P2", title: "Phase 2 — Projects + widget", status: "done", order: 2 },
    { id: "P3", title: "Phase 3 — Knowledge + chat", status: "active", order: 3 },
    { id: "P4", title: "Phase 4 — Conversations + analytics", status: "planned", order: 4 },
    { id: "P5", title: "Phase 5 — Billing + customize", status: "planned", order: 5 },
    { id: "P6", title: "Phase 6 — Harden + launch", status: "planned", order: 6 },
  ],
  tasks: [
    ...doneTasks("P0", [["Repo + CI", "dwight"], ["Shared contract", "jim"]], 1),
    ...doneTasks("P1", [["Auth with Clerk", "dwight"], ["Database schema", "jim"], ["App shell", "dwight"]], 3),
    ...doneTasks("P2", [["Projects CRUD", "jim"], ["Widget script tag", "dwight"], ["Widget bubble UI", "jim"], ["Embed settings", "dwight"], ["PostHog events", "jim"]], 6),
    { id: "P3-T01", boardId: "P3", title: "Knowledge upload", ownerId: "jim", status: "todo", needs: [], prNumber: null },
    { id: "P3-T02", boardId: "P3", title: "Chat route", ownerId: "dwight", status: "todo", needs: [], prNumber: null },
    { id: "P3-T03", boardId: "P3", title: "PDF text extraction", ownerId: "jim", status: "todo", needs: [], prNumber: null },
    { id: "P3-T04", boardId: "P3", title: "Rate limit", ownerId: "dwight", status: "todo", needs: [], prNumber: null },
    { id: "P3-T05", boardId: "P3", title: "Connect panel to chat", ownerId: "dwight", status: "todo", needs: ["P3-T02"], prNumber: null },
    { id: "P4-T01", boardId: "P4", title: "Conversation list", ownerId: null, status: "todo", needs: [], prNumber: null },
    { id: "P4-T02", boardId: "P4", title: "Cost per reply chart", ownerId: null, status: "todo", needs: [], prNumber: null },
  ],
  mergedPrs: 12,
  taskPool: [
    "Answer feedback", "Retry failed embeds", "Answer caching", "Source previews", "Streaming answers",
    "Citations UI", "Multi-file upload", "Embeddings backfill", "Health checks", "Prompt templates",
  ],
  questions: [
    "Max PDF size: 10 MB or 20 MB?",
    "Use pgvector or a hosted vector DB?",
    "OK to add a dependency: pdf-parse?",
    "Stream tokens over SSE or WebSockets?",
    "Run the migration on my DB branch?",
  ],
  leadQuestions: ["Approve the Phase 4 breakdown?", "Merge #{pr} before the other open PRs?"],
};

// ---------------------------------------------------------------- Big team (7 agents)

const bigTeam: Preset = {
  id: "big-team",
  label: "Shipyard · 7 agents",
  config: {
    project: { id: "shipyard", name: "Shipyard", repo: "jsmastery-pro/shipyard", path: "~/developer/shipyard", hqPort: 7420 },
    team: [
      agent("maya", "Maya", "Lead", "#ff77a8", { isLead: true }),
      agent("dwight", "Dwight", "Developer", "#29adff"),
      agent("jim", "Jim", "Developer", "#ffd23a"),
      agent("kenji", "Kenji", "Developer", "#00e436", { cli: "codex", model: "" }),
      agent("priya", "Priya", "QA", "#a98bff", { skills: ["test", "review"] }),
      agent("leo", "Leo", "Designer", "#ff8a3d", { skills: ["frontend-design", "review"] }),
      agent("sam", "Sam", "Docs", "#3ee0d0", { model: "Haiku", skills: ["document"] }),
    ],
    workflow: {
      review: { enabled: true, tool: "greptile", command: "" },
      merge: { by: "lead" },
      deploy: { enabled: true, tool: "vercel", command: "", perAgentEnvironments: false },
    },
  },
  boards: [
    { id: "WEB", title: "Web app", status: "active", order: 0 },
    { id: "API", title: "API", status: "active", order: 1 },
    { id: "OPS", title: "Infra + release", status: "planned", order: 2 },
  ],
  tasks: [
    ...doneTasks("WEB", [["Marketing page", "leo"], ["Sign-in", "dwight"]], 1),
    { id: "WEB-T03", boardId: "WEB", title: "Fleet dashboard", ownerId: "jim", status: "todo", needs: [], prNumber: null },
    { id: "WEB-T04", boardId: "WEB", title: "Vessel detail page", ownerId: "leo", status: "todo", needs: [], prNumber: null },
    { id: "WEB-T05", boardId: "WEB", title: "E2E: booking flow", ownerId: "priya", status: "todo", needs: [], prNumber: null },
    { id: "WEB-T06", boardId: "WEB", title: "Getting started guide", ownerId: "sam", status: "todo", needs: [], prNumber: null },
    { id: "API-T01", boardId: "API", title: "Bookings endpoint", ownerId: "kenji", status: "todo", needs: [], prNumber: null },
    { id: "API-T02", boardId: "API", title: "Webhooks", ownerId: "dwight", status: "todo", needs: [], prNumber: null },
    { id: "API-T03", boardId: "API", title: "Rate limiting", ownerId: null, status: "todo", needs: [], prNumber: null },
  ],
  mergedPrs: 2,
  taskPool: [
    "Port schedule view", "Invoice export", "Crew roster", "Search filters", "Audit log", "API docs",
    "Accessibility pass", "Load test", "Error pages", "Onboarding emails",
  ],
  questions: [
    "Paginate with cursors or offsets?",
    "Is dark mode in scope for this page?",
    "Snapshot tests or visual diff?",
    "Document the beta endpoints too?",
  ],
  leadQuestions: ["Move Rate limiting to the OPS board?"],
};

// ---------------------------------------------------------------- Duo (2 agents, no deploy)

const duo: Preset = {
  id: "duo",
  label: "Notely · 2 agents",
  config: {
    project: { id: "notely", name: "Notely", repo: "you/notely", path: "~/code/notely", hqPort: 7420 },
    team: [
      agent("ada", "Ada", "Lead", "#a98bff", { isLead: true, model: "Sonnet" }),
      agent("max", "Max", "Developer", "#29adff"),
    ],
    workflow: {
      review: { enabled: true, tool: "human", command: "" },
      merge: { by: "human" },
      deploy: { enabled: false, tool: "custom", command: "", perAgentEnvironments: false },
    },
  },
  boards: [{ id: "MVP", title: "MVP", status: "active", order: 0 }],
  tasks: [
    { id: "MVP-T01", boardId: "MVP", title: "Markdown editor", ownerId: "max", status: "todo", needs: [], prNumber: null },
    { id: "MVP-T02", boardId: "MVP", title: "Local storage sync", ownerId: "max", status: "todo", needs: ["MVP-T01"], prNumber: null },
  ],
  mergedPrs: 0,
  taskPool: ["Tags", "Search", "Export to PDF", "Keyboard shortcuts", "Themes"],
  questions: ["Store notes in IndexedDB or localStorage?"],
  leadQuestions: ["Ship the MVP with search, or cut it?"],
};

export const presets: Preset[] = [askwell, bigTeam, duo];
export const defaultPresetId = askwell.id;
