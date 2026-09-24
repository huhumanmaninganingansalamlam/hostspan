import { HostSpanError } from "../errors.js";

export function serializeOperationError(error: unknown): unknown {
  if (error instanceof HostSpanError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    };
  }
  if (error instanceof Error) {
    return { code: "INTERNAL_ERROR", message: error.message, retryable: false, details: {} };
  }
  return error;
}

export type OperationResolution =
  | { kind: "new" }
  | { kind: "replay"; state: string; result: unknown; error?: HostSpanError }
  | { kind: "join"; state: string; result: unknown }
  | { kind: "unknown"; state: string; result: unknown };

export interface OperationsStore {
  resolve(idempotencyKey: string, toolName: string, args: unknown, targetId?: string): OperationResolution;
  setState(idempotencyKey: string, state: string, result?: unknown, error?: unknown): void;
  getState(idempotencyKey: string): string | undefined;
}
