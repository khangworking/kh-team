// How an agent's process is run and reached. macOS and Linux use tmux, so
// agents outlive HQ; Windows has no tmux, so HQ runs them itself (see plan 008).

/** What to run, as a program and its arguments (no shell quoting). */
export interface LaunchSpec {
  file: string;
  args: string[];
  /** Local mode only: env files whose variables the agent gets, in order (app variables, then the provider key). */
  envFiles: string[];
}

export interface TermSize {
  cols: number;
  rows: number;
}

/** A live view of an agent's terminal. Closing it never stops the agent. */
export interface TermHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface ExitInfo {
  dead: boolean;
  exitStatus: number | null;
}

export interface SessionBackend {
  readonly kind: "tmux" | "pty";
  /** True when agents keep running after HQ stops. */
  readonly persistent: boolean;
  exists(name: string): Promise<boolean>;
  create(name: string, cwd: string, spec: LaunchSpec, size: TermSize): Promise<void>;
  kill(name: string): Promise<void>;
  /** Streams the agent's terminal output; `onEnd` runs when the view goes away. */
  attach(name: string, size: TermSize, onData: (data: string) => void, onEnd: () => void): TermHandle;
  /** Types text literally (no Enter). */
  type(name: string, text: string): Promise<boolean>;
  enter(name: string): Promise<boolean>;
  /** Whether the agent's process has exited (the session is kept so HQ can say why). */
  exitInfo(name: string): Promise<ExitInfo | null>;
  /** Last non-empty lines of the screen, plain text. */
  screenText(name: string, lines: number): Promise<string>;
  /** HQ is stopping. */
  shutdown(): void;
}
