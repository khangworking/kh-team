import { create } from "zustand";

export type DrawerState =
  | { kind: "agent"; id: string; tab?: AgentTab }
  | { kind: "boards"; boardId?: string }
  | { kind: "prs" }
  | { kind: "env"; name: string }
  | { kind: "actions" }
  | { kind: "terminal" }
  | null;

export type AgentTab = "terminal" | "shell" | "task" | "sandbox" | "messages";
export type SettingsTab = "team" | "workflow" | "stack" | "mcp" | "sandbox" | "boards" | "project";

/** Something in the office the camera can fly to. */
export type FocusTarget =
  | { kind: "agent"; id: string }
  | { kind: "plan" }
  | { kind: "prs" }
  | { kind: "env"; name: string }
  | { kind: "home" };

export interface HoverInfo {
  title: string;
  sub?: string;
  x: number;
  y: number;
}

interface UiState {
  drawer: DrawerState;
  settings: { tab: SettingsTab; agentId?: string } | null;
  hover: HoverInfo | null;
  focus: { target: FocusTarget; nonce: number } | null;
  zoomRequest: { delta: number; nonce: number } | null;
  planBoardId: string | null; // board shown on the plan wall; null = first active
  debugOpen: boolean;
  setupOpen: boolean;
  /** Side drawer width in px, remembered per browser; `maximized` fills the screen. */
  drawerWidth: number;
  drawerMaximized: boolean;
}

const WIDTH_KEY = "kh-team.drawerWidth";
const LEGACY_WIDTH_KEY = "jsmhq.drawerWidth"; // before the rename
export const DRAWER_MIN = 420;
export const DRAWER_DEFAULT = 520;

/** Room left for the office and team panel when the drawer is as wide as it gets. */
export function drawerMax() {
  return Math.max(DRAWER_MIN, window.innerWidth - 32);
}

function savedWidth(): number {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY) ?? localStorage.getItem(LEGACY_WIDTH_KEY));
    return Number.isFinite(v) && v >= DRAWER_MIN ? v : DRAWER_DEFAULT;
  } catch {
    return DRAWER_DEFAULT;
  }
}

export const useUi = create<UiState>(() => ({
  drawer: null,
  settings: null,
  hover: null,
  focus: null,
  zoomRequest: null,
  planBoardId: null,
  debugOpen: false,
  setupOpen: false,
  drawerWidth: savedWidth(),
  drawerMaximized: false,
}));

let nonce = 0;

export const ui = {
  focus(target: FocusTarget) {
    nonce += 1;
    useUi.setState({ focus: { target, nonce } });
  },
  openAgent(id: string, tab?: AgentTab) {
    useUi.setState({ drawer: { kind: "agent", id, tab } });
    ui.focus({ kind: "agent", id });
  },
  openBoards(boardId?: string) {
    useUi.setState({ drawer: { kind: "boards", boardId } });
    ui.focus({ kind: "plan" });
  },
  openTerminal() {
    useUi.setState({ drawer: { kind: "terminal" } });
  },
  openActions() {
    useUi.setState({ drawer: { kind: "actions" } });
  },
  openPrs() {
    useUi.setState({ drawer: { kind: "prs" } });
    ui.focus({ kind: "prs" });
  },
  openEnv(name: string) {
    useUi.setState({ drawer: { kind: "env", name } });
    ui.focus({ kind: "env", name });
  },
  closeDrawer() {
    useUi.setState({ drawer: null });
    ui.focus({ kind: "home" });
  },
  openSettings(tab: SettingsTab = "team", agentId?: string) {
    useUi.setState({ settings: { tab, agentId } });
  },
  closeSettings() {
    useUi.setState({ settings: null });
  },
  setHover(hover: HoverInfo | null) {
    useUi.setState({ hover });
  },
  zoom(delta: number) {
    nonce += 1;
    useUi.setState({ zoomRequest: { delta, nonce } });
  },
  showBoardOnWall(boardId: string | null) {
    useUi.setState({ planBoardId: boardId });
  },
  openSetup() {
    useUi.setState({ setupOpen: true });
  },
  closeSetup() {
    useUi.setState({ setupOpen: false });
  },
  setDrawerWidth(px: number) {
    const w = Math.round(Math.min(drawerMax(), Math.max(DRAWER_MIN, px)));
    useUi.setState({ drawerWidth: w, drawerMaximized: false });
    try {
      localStorage.setItem(WIDTH_KEY, String(w));
    } catch {
      /* private window: applies until reload */
    }
  },
  toggleDrawerMaximized() {
    useUi.setState((s) => ({ drawerMaximized: !s.drawerMaximized }));
  },
  toggleDebug() {
    useUi.setState((s) => ({ debugOpen: !s.debugOpen }));
  },
};
