import { HostSpanError } from "../errors.js";
import { errorResult, requestId } from "./result.js";
import { createMcpFastifyApp } from "@modelcontextprotocol/fastify";
import { toNodeHandler, type NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import {
  bearerAuthChallengeResponse,
  classifyInboundRequest,
  createMcpHandler,
  McpServer,
  OAuthError,
  OAuthErrorCode,
  SUPPORTED_PROTOCOL_VERSIONS,
  verifyBearerToken,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import type { FastifyInstance, FastifyReply } from "fastify";
import { isIP } from "node:net";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  OAuthAuthorizationRedirectError,
  OAuthHttpError,
  type OAuthService,
} from "../auth/oauth-service.js";
import { splitOAuthScopes } from "../auth/oauth-scopes.js";
import { auditInvocationIdentifiers } from "../observability/error-diagnostics.js";
import { PROTOCOL_VERSION, SERVER_VERSION } from "../version.js";
import { TOOL_DEFINITIONS, TOOL_NAMES, listedTools, registerHostSpanTools, type HostSpanToolAuthorization, type HostSpanToolHandlers, type ResponseContextProvider, type ToolCaller } from "./registry.js";

// GHSA-46jr-4wx8-v453: bound schema-validation allocations, including our pre-handler diagnostics.
const MAX_TOOL_INPUT_ELEMENTS = 10_000;
function withinInputBudget(input: unknown): boolean {
  const stack = [input];
  let count = 0;
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    for (const value of Object.values(node)) {
      if (++count > MAX_TOOL_INPUT_ELEMENTS) return false;
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return true;
}

export interface ServerStatusProvider {
  health(): Record<string, unknown>;
  readiness(): { ready: boolean; [key: string]: unknown };
}

export interface HostSpanHttpServerOptions {
  listen_host: string;
  listen_port: number;
  allowed_hosts?: string[];
  max_inflight_mcp_requests?: number;
  oauth?: OAuthService;
  authorization?: HostSpanToolAuthorization;
  handlers: HostSpanToolHandlers;
  responseContext: ResponseContextProvider;
  status: ServerStatusProvider;
  trace?: (event: string, metadata: Record<string, unknown>) => void;
}

function mcpOAuthTokenVerifier(oauth: OAuthService): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token) {
      const verified = oauth.verifyAccessToken(token);
      if (!verified) throw new OAuthError(OAuthErrorCode.InvalidToken, "Access token is invalid, expired, or revoked.");
      return { ...verified, resource: new URL(verified.resource) };
    },
  };
}

function normalizeAllowedHost(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed.toLowerCase();
  return isIP(trimmed) === 6 ? `[${trimmed.toLowerCase()}]` : trimmed.toLowerCase();
}

function requestedProtocol(value: unknown): string | null {
  if (value === undefined) return null;
  return typeof value === "string" && (value === PROTOCOL_VERSION || SUPPORTED_PROTOCOL_VERSIONS.includes(value))
    ? value : "unrecognized";
}

function observedMediaType(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const media = typeof value === "string" ? value.split(";", 1)[0]?.trim().toLowerCase() : undefined;
  return media === "application/json" || media === "text/event-stream" ? media : "other";
}

export function resolveAllowedHosts(listenHost: string, configured: string[] = []): string[] {
  if (configured.length) return [...new Set(configured.map(normalizeAllowedHost))];
  if (["0.0.0.0", "::"].includes(listenHost)) {
    throw new Error("wildcard listen_host requires explicit allowed_hosts");
  }
  if (["127.0.0.1", "localhost", "::1"].includes(listenHost.toLowerCase())) {
    return ["127.0.0.1", "localhost", "[::1]"];
  }
  return [normalizeAllowedHost(listenHost)];
}

export function createMcpServer(
  handlers: HostSpanToolHandlers,
  responseContext: ResponseContextProvider,
  authorization?: HostSpanToolAuthorization,
): McpServer {
  const server = new McpServer(
    { name: "hostspan", version: SERVER_VERSION },
    {
      maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
      instructions:
        "HostSpan file/process tools use persistent target_id values and target-relative file paths. The computer tool uses its own consented desktop session_id, outside file-root boundaries. " +
        "Generate a fresh random UUIDv7 idempotency key for each new side-effect operation. Keys are shared across all targets and sessions and remain reserved after completion. " +
        "Reuse a key only to retry the identical operation with identical arguments; never reuse example keys or restart a counter in another session. " +
        "Recover a lost process_id with process_list, not a guessed identifier or a duplicate start. exit_code describes the spawned command; nested test receipts and result files must be checked separately. " +
        "For process_poll/process_write, copy next_stdout_cursor and next_stderr_cursor from that same process's previous response; cursors are independent byte offsets, not character counts. " +
        "file_search.query is a ripgrep regular expression, not a shell command or glob. Escape regex metacharacters when searching literal code. " +
        "process_start.wait_ms controls response waiting only; max_bytes bounds each response. " +
        "There is no implicit process deadline. Set deadline_ms only when the task must be stopped after that duration, or use process_cancel. " +
        "max_output_bytes caps retained output, not execution: older output is evicted while recent output continues to be captured. " +
        "A cursor behind retention resumes at the earliest retained output with explicit loss metadata. Poll for completion; human PTY attachments receive recent history and live output.",
    },
  );
  registerHostSpanTools(server, handlers, responseContext, authorization);
  // SDK 2's high-level registration omits canonical securitySchemes. Keep discovery
  // on its public handler API; tool invocation still uses the original SDK handlers.
  server.server.setRequestHandler("tools/list", () => ({ tools: listedTools() }));
  return server;
}

export function createHostSpanHttpServer(options: HostSpanHttpServerOptions): FastifyInstance {
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(options.listen_host.toLowerCase());
  if (!loopback && !options.oauth) {
    throw new Error("Non-loopback HostSpan HTTP serving requires OAuth.");
  }
  const allowedHosts = resolveAllowedHosts(options.listen_host, options.allowed_hosts);
  const app = createMcpFastifyApp({ host: options.listen_host, allowedHosts, allowedOrigins: allowedHosts });
  const oauthVerifier = options.oauth ? mcpOAuthTokenVerifier(options.oauth) : undefined;
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });
  const reportTransportError = (error: Error) => {
    options.trace?.("transport.error", { message: error.message });
  };
  type Observation = { transport_request_id: string; idempotency_key?: string; request_id?: string; response_source?: "sdk" | "fastify"; response_status?: number; response_media?: string | null; response_auth_challenge?: boolean };
  const observations = new WeakMap<object, Observation>();
  const servingRequest = new AsyncLocalStorage<Observation>();
  const mcpHandler = createMcpHandler(
    (context) => {
      const invocation = servingRequest.getStore();
      if (invocation) options.trace?.("transport.sdk_selected", {
        transport_request_id: invocation.transport_request_id, ...auditInvocationIdentifiers(invocation), sdk_era: context.era,
      });
      return createMcpServer(options.handlers, options.responseContext, options.authorization);
    },
    {
      onerror: reportTransportError,
      responseMode: "auto",
    },
  );
  const nodeHandler = toNodeHandler({ fetch: async (request, context) => {
    const response = await mcpHandler.fetch(request, context);
    const observation = servingRequest.getStore();
    if (observation) {
      // Supported fetch Response headers; leave its body/stream and all headers unchanged.
      observation.response_source = "sdk";
      observation.response_status = response.status;
      observation.response_media = observedMediaType(response.headers.get("content-type"));
      observation.response_auth_challenge = response.headers.has("www-authenticate");
    }
    return response;
  } }, { onerror: reportTransportError });
  const maxInflightMcpRequests = options.max_inflight_mcp_requests ?? 128;
  let inflightMcpRequests = 0;
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?", 1)[0];
    if (path !== "/mcp") return;
    const observation: Observation = { transport_request_id: request.id };
    observations.set(request, observation);
    let observed = false;
    const observeResponse = (outcome: "finished" | "closed_before_finish") => {
      if (observed) return;
      observed = true;
      const body = request.body as { params?: { arguments?: unknown; _meta?: Record<string, unknown> } } | undefined;
      const id = reply.raw.getHeader("x-hostspan-request-id") ?? observation.request_id;
      const type = reply.raw.getHeader("content-type");
      const media = type !== undefined ? observedMediaType(type) : "unobserved";
      options.trace?.("transport.response", {
        transport_request_id: request.id, ...auditInvocationIdentifiers(body?.params?.arguments),
        ...(typeof id === "string" && /^req_[0-9a-f]{32}$/i.test(id) ? { request_id: id } : {}),
        requested_protocol_header: requestedProtocol(request.headers["mcp-protocol-version"]),
        requested_protocol_envelope: requestedProtocol(body?.params?._meta?.["io.modelcontextprotocol/protocolVersion"]),
        selected_protocol_version: "unobserved", response_envelope_validity: "unobserved",
        outcome, headers_sent: reply.raw.headersSent, writable_finished: reply.raw.writableFinished,
        http_status: reply.raw.headersSent ? reply.raw.statusCode : null,
        content_type: reply.raw.headersSent ? media : null,
        http_auth_challenge_present: reply.raw.headersSent ? (reply.raw.hasHeader("www-authenticate") ? true : "unobserved") : null,
        prepared_response_source: observation.response_source ?? "unobserved",
        prepared_response_status: observation.response_status ?? "unobserved",
        prepared_response_content_type: observation.response_media === undefined ? "unobserved" : observation.response_media,
        prepared_response_http_auth_challenge_present: observation.response_auth_challenge ?? "unobserved",
        mcp_auth_challenge_present: "unobserved",
      });
    };
    reply.raw.once("finish", () => observeResponse("finished"));
    reply.raw.once("close", () => observeResponse("closed_before_finish"));
    if (inflightMcpRequests >= maxInflightMcpRequests) {
      return reply
        .code(503)
        .header("retry-after", "1")
        .send({
          jsonrpc: "2.0",
          error: { code: -32000, message: "HostSpan is busy; retry shortly." },
          id: null,
        });
    }
    inflightMcpRequests += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inflightMcpRequests = Math.max(0, inflightMcpRequests - 1);
    };
    reply.raw.once("finish", release);
    reply.raw.once("close", release);
  });
  app.addHook("onSend", async (request, reply, payload) => {
    const observation = observations.get(request);
    if (observation) {
      observation.response_source = "fastify";
      observation.response_status = reply.statusCode;
      observation.response_media = observedMediaType(reply.getHeader("content-type"));
      observation.response_auth_challenge = reply.hasHeader("www-authenticate");
      const id = reply.getHeader("x-hostspan-request-id");
      if (typeof id === "string" && /^req_[0-9a-f]{32}$/i.test(id)) observation.request_id = id;
    }
    return payload;
  });
  app.addHook("preHandler", async (request) => {
    const traceUrl = request.url.split("?", 1)[0];
    const body = request.body as { method?: unknown; params?: { name?: unknown; arguments?: unknown } } | undefined;
    options.trace?.("transport.request", {
      transport_request_id: request.id,
      ...auditInvocationIdentifiers(body?.params?.arguments),
      method: request.method,
      url: traceUrl,
      rpc_method: typeof body?.method === "string" && ["initialize", "tools/list", "tools/call", "server/discover"].includes(body.method) ? body.method : undefined,
      tool: TOOL_NAMES.find((name) => name === body?.params?.name),
    });
  });
  app.get("/healthz", async () => ({ status: "ok", ...options.status.health() }));
  app.get("/readyz", async (_request, reply) => {
    const readiness = options.status.readiness();
    if (!readiness.ready) reply.code(503);
    return readiness;
  });
  if (options.oauth) registerOAuthRoutes(app, options.oauth, options.trace);
  app.all("/mcp", async (request, reply) => {
    const body = request.body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: { name?: unknown; arguments?: unknown } } | undefined;
    const invocation = auditInvocationIdentifiers(body?.params?.arguments);
    let caller: ToolCaller = { caller_mode: "local" };
    if (options.oauth && oauthVerifier) {
      try {
        const auth = await verifyBearerToken(request.headers.authorization, {
          verifier: oauthVerifier,
          resourceMetadataUrl: options.oauth.resourceMetadataUrl,
          expectedResource: new URL(options.oauth.publicMcpUrl),
        });
        Object.assign(request.raw, { auth });
        caller = { caller_mode: "oauth", oauth_client_id: auth.clientId };
      } catch (error) {
        const id = requestId();
        const response = bearerAuthChallengeResponse(error, {
          resourceMetadataUrl: options.oauth.resourceMetadataUrl,
        });
        options.trace?.("authorization.rejected", {
          transport_request_id: request.id, ...invocation,
          request_id: id, stage: "authentication", http_status: response.status,
          error_code: error instanceof OAuthError ? error.code : "server_error",
          tool: TOOL_NAMES.find((name) => name === body?.params?.name),
        });
        reply.header("x-hostspan-request-id", id);
        return sendWebResponse(
          reply,
          response,
        );
      }
    }
    if (request.method === "POST" && body?.jsonrpc === "2.0" && (typeof body.id === "string" || typeof body.id === "number") && body.method === "tools/call") {
      const tool = TOOL_DEFINITIONS.find((entry) => entry.name === body.params?.name);
      const route = classifyInboundRequest({
        httpMethod: request.method,
        ...(request.headers["mcp-protocol-version"] !== undefined ? { protocolVersionHeader: request.headers["mcp-protocol-version"].toString() } : {}),
        ...(request.headers["mcp-method"] !== undefined ? { mcpMethodHeader: request.headers["mcp-method"].toString() } : {}),
        ...(request.headers["mcp-name"] !== undefined ? { mcpNameHeader: request.headers["mcp-name"].toString() } : {}),
        body,
      });
      if (tool && route.kind !== "reject") {
        // SDK schema failures bypass tool handlers. Preserve their detail and correlate them in our audit.
        // Valid calls still pass through the SDK's protocol and schema checks.
        const args = body.params?.arguments ?? {};
        const parsed = withinInputBudget(args) ? tool.inputSchema.safeParse(args) : undefined;
        if (!parsed?.success) {
          const id = requestId();
          const issues = parsed ? parsed.error.issues.map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`)
            : [`arguments exceed the ${MAX_TOOL_INPUT_ELEMENTS} element validation budget`];
          const error = new HostSpanError("VALIDATION_FAILED", `Invalid ${tool.name} arguments: ${issues.join("; ")}`, false, { reason: "invalid_tool_arguments" });
          options.authorization?.rejected?.(tool.name, invocation, id, error, "validation", tool.name === "computer" ? caller : undefined);
          options.trace?.("validation.rejected", { transport_request_id: request.id, ...invocation,
            request_id: id, tool: tool.name, stage: "validation", error_code: error.code, reason: "invalid_tool_arguments" });
          reply.header("x-hostspan-request-id", id);
          // This direct reply bypasses the SDK's modern wire-result stamp.
          return reply.send({ jsonrpc: "2.0", id: body.id ?? null, result: {
            ...errorResult(options.responseContext(), error, id),
            ...(route.kind === "modern" ? { resultType: "complete" } : {}),
          } });
        }
      }
    }
    reply.hijack();
    const observation = observations.get(request) ?? { transport_request_id: request.id };
    Object.assign(observation, invocation);
    await servingRequest.run(observation, () =>
      nodeHandler(request.raw as unknown as NodeIncomingMessageLike, reply.raw, request.body));
  });
  app.addHook("onClose", async () => {
    await mcpHandler.close();
  });
  return app;
}

function requestForm(body: unknown): URLSearchParams {
  if (typeof body !== "string") throw new OAuthHttpError(400, "invalid_request", "Expected form-encoded request body.");
  return new URLSearchParams(body);
}

function queryParams(query: unknown): URLSearchParams {
  const params = new URLSearchParams();
  if (!query || typeof query !== "object" || Array.isArray(query)) return params;
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (typeof value === "string") params.set(key, value);
  }
  return params;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function authorizationPage(prompt: ReturnType<OAuthService["beginAuthorization"]>): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">',
    "<title>Authorize HostSpan</title></head><body>",
    '<main style="font-family:system-ui;max-width:720px;margin:48px auto;padding:0 20px">',
    "<h1>Authorize HostSpan</h1>",
    `<p><strong>Client:</strong> ${escapeHtml(prompt.client_name)}</p>`,
    `<p><strong>Scopes:</strong> ${escapeHtml(prompt.scope)}</p>`,
    `<p><strong>Resource:</strong> ${escapeHtml(prompt.resource)}</p>`,
    "<p>OAuth scopes and HostSpan target policy are both enforced. Approval never grants authority beyond either boundary.</p>",
    '<form method="post">',
    `<input type="hidden" name="request_id" value="${escapeHtml(prompt.request_id)}">`,
    '<label>HostSpan approval secret<br><input style="width:100%;max-width:560px" type="password" name="approval_secret" autocomplete="off" required></label>',
    '<p><button type="submit">Approve</button></p></form></main></body></html>',
  ].join("");
}

function oauthErrorPayload(error: unknown): { status: number; payload: Record<string, unknown> } {
  if (error instanceof OAuthHttpError) {
    return { status: error.status, payload: { error: error.code, error_description: error.message } };
  }
  return { status: 500, payload: { error: "server_error", error_description: "OAuth request failed." } };
}

function registerOAuthRoutes(app: FastifyInstance, oauth: OAuthService, trace?: HostSpanHttpServerOptions["trace"]): void {
  const cors = (reply: FastifyReply) =>
    reply
      .header("access-control-allow-origin", "*")
      .header("access-control-allow-methods", "GET,POST,OPTIONS")
      .header("access-control-allow-headers", "content-type,authorization");
  const metadata = async (_request: unknown, reply: FastifyReply) =>
    cors(reply).header("cache-control", "no-store").send(oauth.authorizationServerMetadata());
  app.get("/.well-known/oauth-authorization-server", metadata);
  app.get("/.well-known/oauth-protected-resource", async (_request, reply) =>
    cors(reply).header("cache-control", "no-store").send(oauth.protectedResourceMetadata()),
  );
  app.get("/.well-known/oauth-protected-resource/mcp", async (_request, reply) =>
    cors(reply).header("cache-control", "no-store").send(oauth.protectedResourceMetadata()),
  );
  app.options("/.well-known/oauth-authorization-server", async (_request, reply) => cors(reply).code(204).send());
  app.options("/.well-known/oauth-protected-resource", async (_request, reply) => cors(reply).code(204).send());
  app.options("/.well-known/oauth-protected-resource/mcp", async (_request, reply) => cors(reply).code(204).send());
  app.options("/register", async (_request, reply) => cors(reply).code(204).send());
  app.options("/token", async (_request, reply) => cors(reply).code(204).send());
  app.post("/register", async (request, reply) => {
    try {
      return cors(reply)
        .code(201)
        .header("cache-control", "no-store")
        .header("pragma", "no-cache")
        .send(oauth.registerClient(request.body));
    } catch (error) {
      const result = oauthErrorPayload(error);
      return reply.code(result.status).send(result.payload);
    }
  });
  app.get("/authorize", async (request, reply) => {
    try {
      const prompt = oauth.beginAuthorization(queryParams(request.query));
      return reply
        .type("text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .send(authorizationPage(prompt));
    } catch (error) {
      if (error instanceof OAuthAuthorizationRedirectError) {
        return reply.header("cache-control", "no-store").redirect(error.redirect, 302);
      }
      const result = oauthErrorPayload(error);
      return reply.code(result.status).send(result.payload);
    }
  });
  app.post("/authorize", async (request, reply) => {
    try {
      const form = requestForm(request.body);
      const redirect = oauth.approveAuthorization(form.get("request_id") ?? "", form.get("approval_secret") ?? "");
      return reply.header("cache-control", "no-store").redirect(redirect, 302);
    } catch (error) {
      if (error instanceof OAuthAuthorizationRedirectError) {
        return reply.header("cache-control", "no-store").redirect(error.redirect, 302);
      }
      const result = oauthErrorPayload(error);
      return reply.code(result.status).send(result.payload);
    }
  });
  app.post("/token", async (request, reply) => {
    const id = requestId();
    reply.header("x-hostspan-request-id", id);
    let grantType = "unsupported";
    try {
      const form = requestForm(request.body);
      const requestedGrant = form.get("grant_type");
      if (requestedGrant === "authorization_code" || requestedGrant === "refresh_token") grantType = requestedGrant;
      const token = oauth.exchangeToken(form);
      trace?.("oauth.token", {
        request_id: id, grant_type: grantType, outcome: "issued", granted_scopes: splitOAuthScopes(token.scope),
      });
      return cors(reply)
        .header("cache-control", "no-store")
        .header("pragma", "no-cache")
        .send(token);
    } catch (error) {
      const result = oauthErrorPayload(error);
      trace?.("oauth.token", {
        request_id: id, grant_type: grantType, outcome: "rejected", error_code: result.payload.error,
      });
      return cors(reply)
        .code(result.status)
        .header("cache-control", "no-store")
        .header("pragma", "no-cache")
        .send(result.payload);
    }
  });
  app.post("/revoke", async (request, reply) => {
    try {
      const token = requestForm(request.body).get("token");
      if (token) oauth.revoke(token);
      return reply.code(200).send();
    } catch (error) {
      const result = oauthErrorPayload(error);
      return reply.code(result.status).send(result.payload);
    }
  });
}

async function sendWebResponse(reply: FastifyReply, response: Response) {
  reply.code(response.status);
  for (const [name, value] of response.headers) reply.header(name, value);
  const textBody = await response.text();
  if (!textBody) return reply.send();
  if (response.headers.get("content-type")?.includes("application/json")) {
    try {
      return reply.send(JSON.parse(textBody));
    } catch {
      return reply.send(textBody);
    }
  }
  return reply.send(textBody);
}
