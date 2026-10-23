import { createHash } from "node:crypto";
import { canonicalJson } from "../canonical-json.js";
import type { McpServer, ServerContext, ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  HOSTSPAN_OAUTH_SCOPE_COMPUTER,
  HOSTSPAN_OAUTH_SCOPE_EXEC,
  HOSTSPAN_OAUTH_SCOPE_READ,
  HOSTSPAN_OAUTH_SCOPE_TERMINAL,
  HOSTSPAN_OAUTH_SCOPE_WRITE,
  oauthScopesGrant,
  type HostSpanOAuthScope,
} from "../auth/oauth-scopes.js";
import { ComputerInputSchema, type ComputerInput } from "../computer/portal.js";
import { TOOLSET_VERSION } from "../version.js";
import { asHostSpanError, HostSpanError } from "../errors.js";
import { errorResult, requestId, successResult, type ResponseContext } from "./result.js";
import {
  FileListInputSchema,
  FilePatchInputSchema,
  FileReadInputSchema,
  FileSearchInputSchema,
  ProcessCancelInputSchema,
  ProcessPollInputSchema,
  ProcessListInputSchema,
  ProcessStartInputSchema,
  ProcessWriteInputSchema,
  SystemStatusInputSchema,
  TargetListInputSchema,
  type FileListToolInput,
  type FilePatchToolInput,
  type FileReadToolInput,
  type FileSearchToolInput,
  type ProcessCancelToolInput,
  type ProcessPollToolInput,
  type ProcessListToolInput,
  type ProcessStartToolInput,
  type ProcessWriteToolInput,
  type SystemStatusInput,
  type TargetListInput,
} from "../tools/schemas.js";

const readOnlyAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const mutationAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

const processAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

export const TOOL_DEFINITIONS = [
  {
    name: "system_status" as const,
    description: "Return HostSpan server, immutable toolset, policy, backend, and active process status.",
    inputSchema: SystemStatusInputSchema,
    annotations: readOnlyAnnotations,
  },
  {
    name: "target_list" as const,
    description: "List configured persistent target aliases and the capabilities currently available for each target.",
    inputSchema: TargetListInputSchema,
    annotations: readOnlyAnnotations,
  },
  {
    name: "file_list" as const,
    description: "List a bounded directory tree under one target using target-relative paths.",
    inputSchema: FileListInputSchema,
    annotations: readOnlyAnnotations,
  },
  {
    name: "file_read" as const,
    description: "Read one target-relative file. Use start_byte=0 for lossless byte pages, then returned next_byte and expected_sha256 to continue without gaps or changed content. Line ranges remain available.",
    inputSchema: FileReadInputSchema,
    annotations: readOnlyAnnotations,
  },
  {
    name: "file_search" as const,
    description: "Search bounded target-relative paths with ripgrep and return matching lines with nearby context.",
    inputSchema: FileSearchInputSchema,
    annotations: readOnlyAnnotations,
  },
  {
    name: "file_patch" as const,
    description: "Dry-run or apply an idempotent hash-guarded multi-file unified diff and verify postconditions.",
    inputSchema: FilePatchInputSchema,
    annotations: mutationAnnotations,
  },
  {
    name: "process_start" as const,
    description:
      "Start one durable process with no implicit deadline; wait_ms and max_bytes bound the response, max_output_bytes bounds rolling output retention without stopping execution. Set deadline_ms for an explicit lifetime or tty=true for an interactive terminal on targets with terminal capability.",
    inputSchema: ProcessStartInputSchema,
    annotations: processAnnotations,
  },
  {
    name: "process_poll" as const,
    description: "Read output and state for a returned process_id, using its cursors. If the ID was lost, use process_list; never invent an ID or restart a running command. exit_code belongs to the spawned command, not nested tests.",
    inputSchema: ProcessPollInputSchema,
    annotations: readOnlyAnnotations,
  },
  {
    name: "process_write" as const,
    description: "Idempotently deliver characters, control keys, or resize updates to an interactive process, then observe incremental output; observation failure does not resend delivered input.",
    inputSchema: ProcessWriteInputSchema,
    annotations: processAnnotations,
  },
  {
    name: "process_cancel" as const,
    description:
      "Idempotently stop a supervised process: terminate the native process group or close the durable interactive session as appropriate.",
    inputSchema: ProcessCancelInputSchema,
    annotations: processAnnotations,
  },
  {
    name: "computer" as const,
    description: "Observe and control the consented desktop. Open returns a session_id while the user selects a screen; observe returns an image and observation_id. Input uses that observation and a unique idempotency_key, then returns a fresh image. Dispatched input is not verified application success; compare the new image. Close releases the session. Coordinates use coordinate_width/height, not resized image pixels. Desktop input is not confined by file target roots.",
    inputSchema: ComputerInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "process_list" as const,
    description: "Recover HostSpan process IDs and state for one target/cwd without running a command. Defaults to active processes; active_only=false includes completed work. Continue with the returned cursor and use process_poll to recover output. Does not list unrelated OS processes.",
    inputSchema: ProcessListInputSchema,
    annotations: readOnlyAnnotations,
  },
] as const;

export const TOOL_NAMES = TOOL_DEFINITIONS.map((tool) => tool.name);

export type ToolName = (typeof TOOL_DEFINITIONS)[number]["name"];

export function toolsetDocument() {
  return {
    toolset_version: TOOLSET_VERSION,
    tools: TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: z.toJSONSchema(tool.inputSchema),
      annotations: tool.annotations,
    })),
  };
}

export const TOOLSET_HASH = `sha256:${createHash("sha256").update(canonicalJson(toolsetDocument())).digest("hex")}`;

export interface HostSpanToolHandlers {
  computer(input: ComputerInput, requestId: string): Promise<Record<string, unknown>> | Record<string, unknown>;
  system_status(input: SystemStatusInput, requestId: string): Promise<Record<string, unknown>> | Record<string, unknown>;
  target_list(input: TargetListInput, requestId: string): Promise<Record<string, unknown>> | Record<string, unknown>;
  file_list(input: FileListToolInput, requestId: string): Promise<Record<string, unknown>> | Record<string, unknown>;
  file_read(input: FileReadToolInput, requestId: string): Promise<Record<string, unknown>> | Record<string, unknown>;
  file_search(input: FileSearchToolInput, requestId: string): Promise<Record<string, unknown>> | Record<string, unknown>;
  file_patch(input: FilePatchToolInput, requestId: string): Promise<Record<string, unknown>> | Record<string, unknown>;
  process_start(input: ProcessStartToolInput, requestId: string): Promise<Record<string, unknown>> | Record<string, unknown>;
  process_list(input: ProcessListToolInput, requestId: string): Promise<Record<string, unknown>> | Record<string, unknown>;
  process_poll(input: ProcessPollToolInput, requestId: string): Promise<Record<string, unknown>> | Record<string, unknown>;
  process_write(input: ProcessWriteToolInput, requestId: string): Promise<Record<string, unknown>> | Record<string, unknown>;
  process_cancel(input: ProcessCancelToolInput, requestId: string): Promise<Record<string, unknown>> | Record<string, unknown>;
}

export interface HostSpanToolAuthorization {
  rejected?(tool: ToolName, input: Record<string, unknown>, requestId: string, error: HostSpanError, stage: "authorization" | "validation"): void;
  processBackend(processId: string): "native" | "pty" | undefined;
}

export type ResponseContextProvider = () => ResponseContext;

function requestOAuthScopes(context: ServerContext): readonly string[] | undefined {
  return context.http?.authInfo?.scopes;
}

function requireOAuthScope(context: ServerContext, requiredScope: HostSpanOAuthScope): void {
  const grantedScopes = requestOAuthScopes(context);
  if (!grantedScopes || oauthScopesGrant(grantedScopes, requiredScope)) return;
  throw new HostSpanError("SCOPE_DENIED", `OAuth scope ${requiredScope} is required for this tool.`, false, {
    reason: "oauth_scope",
    required_scope: requiredScope,
    granted_scopes: [...grantedScopes],
  });
}

function requireAnyOAuthScope(context: ServerContext, requiredScopes: readonly HostSpanOAuthScope[]): void {
  const grantedScopes = requestOAuthScopes(context);
  if (!grantedScopes || requiredScopes.some((scope) => oauthScopesGrant(grantedScopes, scope))) return;
  throw new HostSpanError("SCOPE_DENIED", "A process mutation OAuth scope is required for this tool.", false, {
    reason: "oauth_scope",
    required_scopes: [...requiredScopes],
    granted_scopes: [...grantedScopes],
  });
}

function authorizeProcessCancel(
  context: ServerContext,
  input: ProcessCancelToolInput,
  authorization: HostSpanToolAuthorization | undefined,
): void {
  if (!requestOAuthScopes(context)) return;
  if (!authorization) {
    throw new HostSpanError("POLICY_UNENFORCEABLE", "OAuth process cancellation scope cannot be resolved.", false, {
      reason: "oauth_scope_resolver_unavailable",
    });
  }
  const backend = authorization.processBackend(input.process_id);
  if (backend === "pty") {
    requireOAuthScope(context, HOSTSPAN_OAUTH_SCOPE_TERMINAL);
    return;
  }
  if (backend === "native") {
    requireOAuthScope(context, HOSTSPAN_OAUTH_SCOPE_EXEC);
    return;
  }
  requireAnyOAuthScope(context, [HOSTSPAN_OAUTH_SCOPE_EXEC, HOSTSPAN_OAUTH_SCOPE_TERMINAL]);
}

async function invoke<T>(
  input: T,
  handler: (input: T, requestId: string) => Promise<Record<string, unknown>> | Record<string, unknown>,
  context: ResponseContextProvider,
  authorize?: (input: T, requestId: string) => void,
  includeImage = false,
) {
  const id = requestId();
  try {
    authorize?.(input, id);
    return successResult(context(), await handler(input, id), id, includeImage);
  } catch (error) {
    return errorResult(context(), error, id, includeImage);
  }
}

export function registerHostSpanTools(
  server: McpServer,
  handlers: HostSpanToolHandlers,
  context: ResponseContextProvider,
  authorization?: HostSpanToolAuthorization,
): void {
  function checked<T>(tool: ToolName, check: (input: T) => void) {
    return (input: T, id: string) => {
      try { check(input); }
      catch (error) {
        authorization?.rejected?.(tool, input as Record<string, unknown>, id, asHostSpanError(error), "authorization");
        throw error;
      }
    };
  }
  server.registerTool(TOOL_DEFINITIONS[0].name, TOOL_DEFINITIONS[0], (input, requestContext) =>
    invoke(input, async (parsed, id) => ({ ...await handlers.system_status(parsed, id), authorization: { mode: requestOAuthScopes(requestContext) ? "oauth" : "local", granted_scopes: requestOAuthScopes(requestContext), client_tool_visibility: "not_observable" } }), context, checked("system_status", () => requireOAuthScope(requestContext, HOSTSPAN_OAUTH_SCOPE_READ))),
  );
  server.registerTool(TOOL_DEFINITIONS[1].name, TOOL_DEFINITIONS[1], (input, requestContext) =>
    invoke(input, handlers.target_list.bind(handlers), context, checked("target_list", () => requireOAuthScope(requestContext, HOSTSPAN_OAUTH_SCOPE_READ))),
  );
  server.registerTool(TOOL_DEFINITIONS[2].name, TOOL_DEFINITIONS[2], (input, requestContext) =>
    invoke(input, handlers.file_list.bind(handlers), context, checked("file_list", () => requireOAuthScope(requestContext, HOSTSPAN_OAUTH_SCOPE_READ))),
  );
  server.registerTool(TOOL_DEFINITIONS[3].name, TOOL_DEFINITIONS[3], (input, requestContext) =>
    invoke(input, handlers.file_read.bind(handlers), context, checked("file_read", () => requireOAuthScope(requestContext, HOSTSPAN_OAUTH_SCOPE_READ))),
  );
  server.registerTool(TOOL_DEFINITIONS[4].name, TOOL_DEFINITIONS[4], (input, requestContext) =>
    invoke(input, handlers.file_search.bind(handlers), context, checked("file_search", () => requireOAuthScope(requestContext, HOSTSPAN_OAUTH_SCOPE_READ))),
  );
  server.registerTool(TOOL_DEFINITIONS[5].name, TOOL_DEFINITIONS[5], (input, requestContext) =>
    invoke(input, handlers.file_patch.bind(handlers), context, checked("file_patch", () => requireOAuthScope(requestContext, HOSTSPAN_OAUTH_SCOPE_WRITE))),
  );
  server.registerTool(TOOL_DEFINITIONS[6].name, TOOL_DEFINITIONS[6], (input, requestContext) =>
    invoke(input, handlers.process_start.bind(handlers), context, checked("process_start", (parsed: ProcessStartToolInput) => requireOAuthScope(requestContext, parsed.tty ? HOSTSPAN_OAUTH_SCOPE_TERMINAL : HOSTSPAN_OAUTH_SCOPE_EXEC))),
  );
  server.registerTool(TOOL_DEFINITIONS[7].name, TOOL_DEFINITIONS[7], (input, requestContext) =>
    invoke(input, handlers.process_poll.bind(handlers), context, checked("process_poll", () => requireOAuthScope(requestContext, HOSTSPAN_OAUTH_SCOPE_READ))),
  );
  server.registerTool(TOOL_DEFINITIONS[8].name, TOOL_DEFINITIONS[8], (input, requestContext) =>
    invoke(input, handlers.process_write.bind(handlers), context, checked("process_write", () => requireOAuthScope(requestContext, HOSTSPAN_OAUTH_SCOPE_TERMINAL))),
  );
  server.registerTool(TOOL_DEFINITIONS[9].name, TOOL_DEFINITIONS[9], (input, requestContext) =>
    invoke(input, handlers.process_cancel.bind(handlers), context, checked("process_cancel", (parsed: ProcessCancelToolInput) => authorizeProcessCancel(requestContext, parsed, authorization))),
  );
  server.registerTool(TOOL_DEFINITIONS[10].name, TOOL_DEFINITIONS[10], (input, requestContext) =>
    invoke(input, handlers.computer.bind(handlers), context, checked("computer", () => requireOAuthScope(requestContext, HOSTSPAN_OAUTH_SCOPE_COMPUTER)), true),
  );
  server.registerTool(TOOL_DEFINITIONS[11].name, TOOL_DEFINITIONS[11], (input, requestContext) =>
    invoke(input, handlers.process_list.bind(handlers), context, checked("process_list", () => requireOAuthScope(requestContext, HOSTSPAN_OAUTH_SCOPE_READ))),
  );
}
