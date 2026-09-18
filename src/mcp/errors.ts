export type HostSpanErrorCode =
  | "TARGET_NOT_FOUND"
  | "TARGET_NOT_READY"
  | "SCOPE_DENIED"
  | "PATH_OUTSIDE_TARGET"
  | "SYMLINK_REJECTED"
  | "FILE_NOT_FOUND"
  | "BINARY_FILE"
  | "STALE_CONTENT"
  | "PATCH_REJECTED"
  | "VALIDATION_FAILED"
  | "IDEMPOTENCY_CONFLICT"
  | "PROCESS_NOT_FOUND"
  | "PROCESS_UNKNOWN"
  | "OUTPUT_LIMIT"
  | "DEADLINE_EXCEEDED"
  | "SEARCH_SCOPE_TOO_BROAD"
  | "SEARCH_BACKEND_UNAVAILABLE"
  | "SERVER_BUSY"
  | "POLICY_UNENFORCEABLE"
  | "NOT_A_GIT_REPOSITORY"
  | "CURSOR_EXPIRED"
  | "INTERNAL_ERROR";

export class HostSpanError extends Error {
  constructor(
    readonly code: HostSpanErrorCode,
    message: string,
    readonly retryable = false,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "HostSpanError";
  }
}

export function asHostSpanError(error: unknown): HostSpanError {
  if (error instanceof HostSpanError) return error;
  return new HostSpanError("INTERNAL_ERROR", error instanceof Error ? error.message : "Unexpected error");
}
