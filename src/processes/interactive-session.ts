export interface InteractiveSessionSnapshot {
  exists: boolean;
  dead: boolean;
  exit_code: number | null;
  signal: string | null;
  reason: string | null;
  pid: number | null;
  columns: number | null;
  rows: number | null;
}

export interface StartInteractiveSessionInput {
  processId: string;
  cwd: string;
  argv: string[];
  env: Record<string, string>;
  columns: number;
  rows: number;
  deadlineAt: string | null;
  maxOutputBytes: number;
}

export interface InteractiveOutputDrainResult {
  drained: boolean;
  bytes: number;
}

export interface InteractiveSessionManager {
  readonly backend: "pty";
  sessionName(processId: string): string;
  humanAttachCommand(session: string, readOnly?: boolean): string;
  available(): Promise<boolean>;
  start(input: StartInteractiveSessionInput): Promise<{ session: string; pid: number | null }>;
  inspect(session: string): Promise<InteractiveSessionSnapshot>;
  inspectSync(session: string): InteractiveSessionSnapshot;
  write(
    session: string,
    input: { chars: string; control_keys: string[]; columns?: number; rows?: number },
  ): Promise<void>;
  close(session: string, graceMs?: number): Promise<void>;
  closeSync(session: string): void;
  outputBytes(processId: string): number;
  outputDrained(processId: string): boolean;
  waitForOutputDrain(processId: string, waitMs?: number): Promise<InteractiveOutputDrainResult>;
  waitForExitStatus(session: string, waitMs?: number): Promise<InteractiveSessionSnapshot>;
  waitForActivity(
    session: string,
    processId: string,
    previousBytes: number,
    waitMs: number,
  ): Promise<InteractiveSessionSnapshot>;
  attach(session: string, readOnly?: boolean): Promise<void>;
}
