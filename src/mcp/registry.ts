import { createHash } from "node:crypto";
import type { McpServer, ServerContext, ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  HOSTSPAN_OAUTH_SCOPE_EXEC,
  HOSTSPAN_OAUTH_SCOPE_READ,
  HOSTSPAN_OAUTH_SCOPE_TERMINAL,
  HOSTSPAN_OAUTH_SCOPE_WRITE,
  oauthScopesGrant,
  type HostSpanOAuthScope,
} from "../auth/oauth-scopes.js";
import { TOOLSET_VERSION } from "../version.js";
import { HostSpanError } from "./errors.js";
import { errorResult, requestId, successResult, type ResponseContext } from "./result.js";
import {
  FileListInputSchema,
  FilePatchInputSchema,
  FileReadInputSchema,
  FileSearchInputSchema,
  GitChangesInputSchema,
  ProcessCancelInputSchema,
  ProcessPollInputSchema,
  ProcessStartInputSchema,
  ProcessWriteInputSchema,
  SystemStatusInputSchema,
  TargetListInputSchema,
  type FileListToolInput,
  type FilePatchToolInput,
  type FileReadToolInput,
  type FileSearchToolInput,
  type GitChangesToolInput,
  type ProcessCancelToolInput,
  type ProcessPollToolInput,
  type ProcessStartToolInput,
  type ProcessWriteToolInput,
  type SystemStatusInput,
  type TargetListInput,
} from "./schemas.js";

export const TOOL_NAMES = [
  "system_status",
  "target_list",
  "file_list",
  "file_read",
  "file_search",
  "file_patch",
  "git_changes",
  "process_start",
  "process_poll",
  "process_write",
  "process_cancel",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

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
    description: "Read a bounded text range or binary metadata from one target-relative file, optionally with SHA-256.",
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
    name: "git_changes" as const,
    description: "Return deterministic bounded Git status, diff, and untracked summaries for one target.",
    inputSchema: GitChangesInputSchema,
    annotations: readOnlyAnnotations,
  },
  {
    name: "process_start" as const,
    description:
      "Start one durable process through HostSpan and optionally wait briefly; set tty=true for a durable interactive terminal on targets with terminal capability.",
    inputSchema: ProcessStartInputSchema,
    annotations: processAnnotations,
  },
  {
    name: "process_poll" as const,
    description: "Read incremental stdout/stderr bytes and durable terminal state for a previously started process.",
    inputSchema: ProcessPollInputSchema,
    annotations: readOnlyAnnotations,
  },
  {
    name: "process_write" as const,
    description: "Write characters, control keys, or terminal resize updates to a durable interactive process and return incremental output.",
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
] as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

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

export const TOOLSET_HASH = `sha256:${createHash("sha256").update(canonical(toolsetDocument())).digest("hex")}`;

export interface HostSpanToolHandlers {
  system_status(input: SystemStatusInput, requestId: string): Promise<Record<string, unknown>> | Record<string, unknown>;
  target_list(input: TargetListInput, requestId: string): Promise<Record<string, unknown>> | Record<string, unknown>;
  file_list(input: FileListToolInput, requestId: string): Promise<Record<string, unknown>> | Record<string, unknown>;
  file_read(input: FileReadToolInput, requestId: string): Promise<Record<string, unknown>> | Record<string, unknown>;
  file_search(input: FileSearchToolInput, requestId: string): Promise<Record<string, unknown>> | Record<string, unknown>;
  file_patch(input: FilePatchToolInput, requestId: string): Promise<Record<string, unknown>> | Record<string, unknown>;
  git_changes(input: GitChangesToolInput, requestId: string): Promise<Record<string, unknown>> | Record<string, unknown>;
  process_start(input: ProcessStartToolInput, requestId: string): Promise<Record<string, unknown>> | Record<string, unknown>;
  process_poll(input: ProcessPollToolInput, requestId: string): Promise<Record<string, unknown>> | Record<string, unknown>;
  process_write(input: ProcessWriteToolInput, requestId: string): Promise<Record<string, unknown>> | Record<string, unknown>;
  process_cancel(input: ProcessCancelToolInput, requestId: string): Promise<Record<string, unknown>> | Record<string, unknown>;
}

export interface HostSpanToolAuthorization {
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
  authorize?: (input: T) => void,
) {
  const id = requestId();
  try {
    authorize?.(input);
    return successResult(context(), await handler(input, id), id);
  } catch (error) {
    return errorResult(context(), error, id);
  }
}

export function registerHostSpanTools(
  server: McpServer,
  handlers: HostSpanToolHandlers,
  context: ResponseContextProvider,
  authorization?: HostSpanToolAuthorization,
): void {
  server.registerTool(
    "system_status",
    { description: TOOL_DEFINITIONS[0].description, inputSchema: SystemStatusInputSchema, annotations: TOOL_DEFINITIONS[0].annotations },
    (input, requestContext) =>
      invoke(input, handlers.system_status.bind(handlers), context, () => requireOAuthScope(requestContext, HOSTSPAN_OAUTH_SCOPE_READ)),
  );
  server.registerTool(
    "target_list",
    { description: TOOL_DEFINITIONS[1].description, inputSchema: TargetListInputSchema, annotations: TOOL_DEFINITIONS[1].annotations },
    (input, requestContext) =>
      invoke(input, handlers.target_list.bind(handlers), context, () => requireOAuthScope(requestContext, HOSTSPAN_OAUTH_SCOPE_READ)),
  );
  server.registerTool(
    "file_list",
    { description: TOOL_DEFINITIONS[2].description, inputSchema: FileListInputSchema, annotations: TOOL_DEFINITIONS[2].annotations },
    (input, requestContext) =>
      invoke(input, handlers.file_list.bind(handlers), context, () => requireOAuthScope(requestContext, HOSTSPAN_OAUTH_SCOPE_READ)),
  );
  server.registerTool(
    "file_read",
    { description: TOOL_DEFINITIONS[3].description, inputSchema: FileReadInputSchema, annotations: TOOL_DEFINITIONS[3].annotations },
    (input, requestContext) =>
      invoke(input, handlers.file_read.bind(handlers), context, () => requireOAuthScope(requestContext, HOSTSPAN_OAUTH_SCOPE_READ)),
  );
  server.registerTool(
    "file_search",
    { description: TOOL_DEFINITIONS[4].description, inputSchema: FileSearchInputSchema, annotations: TOOL_DEFINITIONS[4].annotations },
    (input, requestContext) =>
      invoke(input, handlers.file_search.bind(handlers), context, () => requireOAuthScope(requestContext, HOSTSPAN_OAUTH_SCOPE_READ)),
  );
  server.registerTool(
    "file_patch",
    { description: TOOL_DEFINITIONS[5].description, inputSchema: FilePatchInputSchema, annotations: TOOL_DEFINITIONS[5].annotations },
    (input, requestContext) =>
      invoke(input, handlers.file_patch.bind(handlers), context, () => requireOAuthScope(requestContext, HOSTSPAN_OAUTH_SCOPE_WRITE)),
  );
  server.registerTool(
    "git_changes",
    { description: TOOL_DEFINITIONS[6].description, inputSchema: GitChangesInputSchema, annotations: TOOL_DEFINITIONS[6].annotations },
    (input, requestContext) =>
      invoke(input, handlers.git_changes.bind(handlers), context, () => requireOAuthScope(requestContext, HOSTSPAN_OAUTH_SCOPE_READ)),
  );
  server.registerTool(
    "process_start",
    { description: TOOL_DEFINITIONS[7].description, inputSchema: ProcessStartInputSchema, annotations: TOOL_DEFINITIONS[7].annotations },
    (input, requestContext) =>
      invoke(input, handlers.process_start.bind(handlers), context, (parsed) =>
        requireOAuthScope(requestContext, parsed.tty ? HOSTSPAN_OAUTH_SCOPE_TERMINAL : HOSTSPAN_OAUTH_SCOPE_EXEC),
      ),
  );
  server.registerTool(
    "process_poll",
    { description: TOOL_DEFINITIONS[8].description, inputSchema: ProcessPollInputSchema, annotations: TOOL_DEFINITIONS[8].annotations },
    (input, requestContext) =>
      invoke(input, handlers.process_poll.bind(handlers), context, () => requireOAuthScope(requestContext, HOSTSPAN_OAUTH_SCOPE_READ)),
  );
  server.registerTool(
    "process_write",
    { description: TOOL_DEFINITIONS[9].description, inputSchema: ProcessWriteInputSchema, annotations: TOOL_DEFINITIONS[9].annotations },
    (input, requestContext) =>
      invoke(input, handlers.process_write.bind(handlers), context, () => requireOAuthScope(requestContext, HOSTSPAN_OAUTH_SCOPE_TERMINAL)),
  );
  server.registerTool(
    "process_cancel",
    { description: TOOL_DEFINITIONS[10].description, inputSchema: ProcessCancelInputSchema, annotations: TOOL_DEFINITIONS[10].annotations },
    (input, requestContext) =>
      invoke(input, handlers.process_cancel.bind(handlers), context, (parsed) => authorizeProcessCancel(requestContext, parsed, authorization)),
  );
}
