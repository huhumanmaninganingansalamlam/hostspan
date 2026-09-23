# HostSpan MCP v4 contract design

Status: design target for the next breaking MCP contract. This document does not change the active `hostspan-v3` contract.

## Goals

The v4 contract should make tool selection and result handling easier for models without expanding HostSpan's authority surface. It should add explicit output schemas, clearer titles and selection-oriented descriptions, a stable error vocabulary, and names that match the behavior they describe.

The active v3 contract remains immutable while v4 is implemented behind a new toolset version. Existing v3 names, input schemas, annotations, and toolset hash must not be edited in place.

## Contract versioning and hash

The implementation should introduce `TOOLSET_VERSION = "hostspan-v4"` only when the full v4 surface is ready to ship as a breaking contract. A v4 toolset hash must cover, in canonical order, every public tool's:

- name
- title
- description
- input schema
- output schema
- annotations

Changing any of those fields changes the v4 toolset hash. Runtime policy state, backend readiness, OAuth grants, and target configuration are not part of the hash.

Every successful structured result continues to include `request_id`, `toolset_hash`, and `policy_epoch`. They are response context, not tool-specific payload.

## Public tool surface

v4 should retain the current 11 public tool names. The breaking change is the richer contract, not gratuitous renaming.

| Tool | Title | OAuth scope | Selection rule |
| --- | --- | --- | --- |
| `system_status` | Inspect HostSpan status | `hostspan.read` | Use for server/toolset/backend readiness and active-process summary; do not use as a prerequisite for ordinary file or process calls. |
| `target_list` | List HostSpan targets | `hostspan.read` | Use when the target id or its capabilities are unknown. Do not call repeatedly after the required target is known. |
| `file_list` | List files | `hostspan.read` | Use to discover names and bounded tree structure. Prefer `file_search` when looking for content. |
| `file_read` | Read file content | `hostspan.read` | Use when the file path is known. Request the smallest useful line range; do not search by repeatedly reading whole files. |
| `file_search` | Search file content | `hostspan.read` | Use for unknown locations or cross-file content lookup. Narrow paths/globs instead of issuing broad repeated searches. |
| `file_patch` | Apply guarded file patch | `hostspan.write` | Use only for requested file mutations. Reuse the same idempotency key only for the same logical mutation. |
| `git_changes` | Inspect Git changes | `hostspan.read` | Use for bounded status/diff review without command execution. Do not start a shell process just to run status/diff. |
| `process_start` | Start process | `hostspan.exec` or `hostspan.terminal` | Use for an actual command. Set `tty=true` only when interactive terminal semantics are required. |
| `process_poll` | Read process output | `hostspan.read` | Use only for a process id already returned by HostSpan. Continue from returned cursors instead of rereading from zero. |
| `process_write` | Write to terminal | `hostspan.terminal` | Use only for a live interactive process. Do not use it for non-TTY stdin or as a polling substitute. |
| `process_cancel` | Stop process | `hostspan.exec` or `hostspan.terminal` | Use only when the caller intends to stop a process. Required scope follows the durable process backend. |

### Why `git_changes` stays separate

Keep the dedicated Git read surface in v4. It provides deterministic, bounded, policy-filtered status and diff data without granting arbitrary process execution. Folding it into `process_start` would force a read-only review workflow to request `hostspan.exec`, widen target capability requirements, and make output bounds and secret filtering command-dependent.

Do not add general `git_*` mutation tools in v4. Git mutation remains available only through explicitly authorized process execution when the target grants that capability. The public count therefore stays at 11.

## Tool descriptions

Descriptions should be short selection instructions rather than implementation summaries. Each description should state the job, the strongest reason to choose the tool over its nearest neighbor, and any authority-sensitive branch.

Recommended descriptions:

| Tool | Description |
| --- | --- |
| `system_status` | Inspect HostSpan server, toolset, backend readiness, and active-process summary. Use for diagnostics, not as a required preflight for other tools. |
| `target_list` | List configured target ids and capabilities. Use when a target or its allowed operations are not already known. |
| `file_list` | List a bounded target-relative directory tree. Use for names and structure; use file_search for content lookup. |
| `file_read` | Read a bounded range from one known target-relative file with metadata and optional SHA-256. |
| `file_search` | Search content across bounded target-relative paths. Use this instead of repeatedly reading files when the match location is unknown. |
| `file_patch` | Dry-run or apply an idempotent SHA-256-guarded multi-file unified diff, then run requested validators. |
| `git_changes` | Inspect bounded, policy-filtered Git status and diff without granting command execution. |
| `process_start` | Start one durable command. Use tty=true only for interactive terminal semantics; non-TTY and TTY starts require different OAuth authority. |
| `process_poll` | Read new output and state for a HostSpan process from supplied cursors. Reuse returned cursors for incremental reads. |
| `process_write` | Send characters, control keys, or resize updates to a live interactive HostSpan process and return new output. |
| `process_cancel` | Idempotently stop a HostSpan process. Authorization follows the process's durable native or PTY backend. |

## Output schemas

Every tool must register an MCP `outputSchema` with an object root. Handler return types should be inferred from those schemas instead of `Record<string, unknown>`. The SDK then validates non-error `structuredContent` before sending it.

All success schemas extend this required response context:

```text
request_id: string
toolset_hash: "sha256:" + 64 hex characters
policy_epoch: non-negative integer
```

Unknown properties should be rejected in the schema unless a field is intentionally an extensibility map.

### `system_status`

Required:

```text
server_version: string
protocol_version: string
toolset_version: "hostspan-v4"
advertised_tools: array of the 11 exact tool names
backends:
  search: { name: string, ready: boolean }
  database: { name: string, ready: boolean }
  process: { name: string, ready: boolean }
  terminal: { name: string, ready: boolean, configured: boolean }
active_processes: non-negative integer
execution_isolation: "host"
```

Replace the v3 `native_execution` / `sandboxed` pair with `execution_isolation: "host"`. In v3, `native_execution=true` also appears on PTY-backed processes, so the name can be misread as the process backend even though `backend` is separately `native|pty`.

### `target_list`

```text
targets: array of {
  target_id: string
  label: string
  provider: string
  capabilities: unique array of "read" | "write" | "exec" | "git" | "terminal"
  exec_mode: "native" | null
  git_repository: boolean
  ready: boolean
}
```

No filesystem root path is exposed.

### `file_list`

```text
path: string
entries: array of {
  path: string
  type: "file" | "directory" | "symlink" | "other"
  size_bytes: non-negative integer
  mtime: RFC3339 timestamp
}
truncated: boolean
cursor?: string
```

Require `cursor` exactly when `truncated=true` because another page is available.

### `file_read`

Use a discriminating `content_kind` instead of returning a successful result containing `error_code: "BINARY_FILE"`.

Common fields:

```text
path: string
content_kind: "text" | "binary"
encoding: "utf-8" | "utf-16le" | "utf-16be" | "binary"
bom: boolean
size_bytes: non-negative integer
mtime: RFC3339 timestamp
sha256?: 64 hex characters
truncated_before: boolean
truncated_after: boolean
```

For `content_kind="text"`:

```text
text: string
returned_range: { start_line: positive integer, end_line: positive integer }
returned_bytes: non-negative integer
```

For `content_kind="binary"`, omit `text` and expose `returned_bytes: 0`. Binary content is not a tool error; the schema should make that state explicit.

### `file_search`

```text
matches: array of {
  type: "match" | "context"
  path: string
  line_number: positive integer
  text: string
  mtime: RFC3339 timestamp
}
match_count: non-negative integer
returned_bytes: non-negative integer
truncated: boolean
truncation_reason?: "max_bytes" | "max_matches" | "backend_output"
```

Rename v3 `returned_record_bytes` to `returned_bytes`. Drop `backend: "ripgrep"`, `binary: "ignored"`, and `hidden: false` from the public result; they describe current implementation choices rather than result semantics. Backend readiness remains available through `system_status`.

### `file_patch`

```text
dry_run: boolean
transaction_id: string
files: array of {
  path: string
  before_sha256: 64 hex characters
  after_sha256: 64 hex characters
  changed: boolean
}
validators: array of {
  name: "git_diff_check" | "syntax_check"
  status: "passed" | "failed"
}
applied: boolean
```

A validator failure is an error result, not a successful response with an ambiguous status.

### `git_changes`

```text
repository: { root_relative: string }
status: array of {
  path: string
  index_status: string
  worktree_status: string
  old_path?: string
}
diff: string
diff_truncated: boolean
untracked: array of { path: string, size_bytes: non-negative integer }
```

Keep the diff byte-bounded and UTF-8 safe. Status/untracked collections remain independently bounded and fail closed if their internal safety bounds are exceeded.

### Process result family

`process_start`, `process_poll`, and `process_write` should share one `ProcessSnapshotOutputSchema`. `process_cancel` should return the same state core after cancellation so callers do not need a second poll just to learn the resulting durable state.

Required state core:

```text
state: "launching" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "unknown"
process_id: string
backend: "native" | "pty"
interactive: boolean
execution_isolation: "host"
stdout: string
stderr: string
next_stdout_cursor: non-negative integer
next_stderr_cursor: non-negative integer
exit_code: integer | null
signal: string | null
reason: string | null
deadline_at: RFC3339 timestamp | null
output_expires_at: RFC3339 timestamp | null
```

Optional fields:

```text
output_budget?: {
  process_limit_bytes: non-negative integer
  retained_bytes: non-negative integer
  remaining_bytes: non-negative integer
}
terminal_session?: string
human_attach_command?: string
human_attach_read_only_command?: string
```

The attach fields are present only for a live PTY session. Remove v3 `native_execution` and `sandboxed` in favor of `execution_isolation`.

`process_write` must not invent a second output vocabulary; it returns the same snapshot after applying input. `process_cancel` must be idempotent and return the settled/current snapshot even when cancellation was already requested.

## Error contract

All HostSpan tool-execution errors should return `isError=true`, a machine-readable `structuredContent`, and a text content item containing the same JSON payload for clients that only inspect text.

Error `structuredContent`:

```text
request_id: string
toolset_hash: string
policy_epoch: non-negative integer
error: {
  code: stable HostSpan error code
  message: safe human-readable message
  retryable: boolean
  request_id: string
  reason?: stable safe reason token
  resource?: safe public resource token
  limit?: {
    kind: stable token
    value: non-negative integer
    unit: "bytes" | "milliseconds" | "count"
  }
}
```

Do not expose arbitrary exception objects or a free-form public `details` map in v4. Map only reviewed, non-secret diagnostics into `reason`, `resource`, and `limit`; keep backend stderr, absolute paths, secrets, and implementation diagnostics in redacted server logs.

Rules:

- `code` describes the stable error class.
- `reason` describes the safe machine-actionable cause inside that class.
- `retryable=true` means retrying later without necessarily changing arguments may succeed.
- Validation, policy, capability, OAuth-scope, and idempotency-conflict errors are not retryable unless the server explicitly documents a transient cause.
- Deadline, bounded queue saturation, and temporarily unavailable backend errors may be retryable.
- A result-state `reason` on a successful process snapshot is not an error code; it explains why the durable state ended or became unknown.

Maintain one test table that asserts the expected `code`, `retryable`, and safe `reason` for every public error path.

## Annotations and authority

Keep read-only annotations on `system_status`, `target_list`, `file_list`, `file_read`, `file_search`, `git_changes`, and `process_poll`.

Keep mutation annotations on `file_patch`. Keep process mutation annotations on `process_start`, `process_write`, and `process_cancel`.

Annotations are hints, not authorization. OAuth scope checks and target capability/policy checks remain independent runtime gates. Tool discovery must not hide tools based on the current token because doing so would make the toolset/hash authority-dependent.

## Model-facing regression suite

The v4 implementation is not complete until deterministic model-facing scenarios cover tool choice as well as schema validation. Tests should exercise at least these cases:

| Scenario | Expected behavior |
| --- | --- |
| Known file path, asked to inspect content | Call `file_read` directly; no `target_list`, `system_status`, or `file_search` preflight. |
| Unknown source location, asked to find symbol | Call `file_search` before targeted reads; do not walk/read the whole tree. |
| Asked for directory structure | Use `file_list`, not `file_search` or a shell `find`. |
| Asked what changed in Git | Use `git_changes`, not `process_start ["git", ...]`. |
| Start a non-interactive test command | Use `process_start tty=false`; do not request terminal authority. |
| Start an interactive REPL | Use `process_start tty=true`, then `process_write`; do not start duplicate sessions. |
| Continue reading a running process | Use `process_poll` with the returned cursors; do not restart the command or poll from zero. |
| Mutation response is delayed/lost | Retry with the same idempotency key; never create a fresh key for the same side effect. |
| Read-only OAuth token asked to patch | Receive `SCOPE_DENIED`; do not try process execution as an authority bypass. |
| Exec-only token asked to mutate a file | Receive `SCOPE_DENIED`; do not shell out to bypass `file_patch` authority. |
| Terminal-only token cancels a native process | Receive `SCOPE_DENIED`; required cancellation authority follows durable backend. |
| Output is truncated | Continue using cursor/range information or narrow scope; do not blindly repeat the identical call. |

The regression harness should assert call sequence, call count, arguments, and idempotency-key reuse. It should fail on unnecessary discovery calls, duplicate side effects, authority-escalation substitutions, and schema-invalid results.

## Implementation plan

A future v4 implementation should be one deliberate breaking-contract change:

1. Add typed output schemas and infer handler result types from them.
2. Add titles and selection-oriented descriptions.
3. Introduce the v4 metadata renames and common error serialization.
4. Keep the 11-tool surface and dedicated bounded `git_changes`.
5. Add contract tests that pin names, titles, descriptions, input/output schemas, annotations, and the new toolset hash.
6. Add model-facing tool-selection regression fixtures.
7. Run the complete existing safety/recovery/idempotency suite plus the new v4 contract suite before switching any default client guidance.

Do not silently migrate an existing `hostspan-v3` endpoint to these schemas. A release that serves v4 must identify the new contract explicitly and document the compatibility boundary.

## Acceptance criteria

The design is implemented only when all of the following are true:

- Every advertised v4 tool has an object-root output schema validated by the MCP SDK on successful calls.
- No public handler returns `Record<string, unknown>` as its contract type.
- Toolset hashing includes titles and output schemas.
- Process results no longer expose the ambiguous `native_execution` / `sandboxed` pair.
- Successful binary `file_read` results no longer masquerade as errors through `error_code`.
- Errors have stable code/retryability/safe-reason semantics with no unreviewed detail leakage.
- The public tool count remains 11 and `git_changes` remains bounded/read-only.
- Model-facing regressions catch unnecessary calls, duplicate side effects, and authority-escalation attempts.
- The active v3 contract and hash remain unchanged until a separately reviewed v4 implementation is intentionally selected.
