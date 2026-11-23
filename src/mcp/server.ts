import { mcpOAuthTokenVerifier, validateHttpAuthenticationConfiguration } from "./authentication.js";
export { resolveAllowedHosts } from "./authentication.js";
import { registerMcpRoute, registerStatusRoutes } from "./routes.js";
import { createTransportObservationState, registerTransportObservationHooks, observedMediaType } from "./transport-observation.js";
import { MAX_TOOL_INPUT_ELEMENTS, } from "./request-validation.js";
import type { HostSpanAuthMode } from "../config/schema.js";
import type { PrivateTokenStore, } from "../auth/private-token.js";
import { requestId } from "./result.js";
import { createMcpFastifyApp } from "@modelcontextprotocol/fastify";
import { toNodeHandler, type NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  McpServer,
} from "@modelcontextprotocol/server";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  OAuthAuthorizationRedirectError,
  OAuthHttpError,
  type OAuthService,
} from "../auth/oauth-service.js";
import { splitOAuthScopes } from "../auth/oauth-scopes.js";
import { auditInvocationIdentifiers } from "../observability/error-diagnostics.js";
import { SERVER_VERSION } from "../version.js";
import { listedTools, registerHostSpanTools, type HostSpanToolAuthorization, type HostSpanToolHandlers, type ResponseContextProvider, } from "./registry.js";

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
  authenticationMode?: HostSpanAuthMode;
  privateTokens?: PrivateTokenStore;
  protected_transport?: "encrypted_private_network";
  authorization?: HostSpanToolAuthorization;
  handlers: HostSpanToolHandlers;
  responseContext: ResponseContextProvider;
  status: ServerStatusProvider;
  trace?: (event: string, metadata: Record<string, unknown>) => void;
}

export function createMcpServer(
  handlers: HostSpanToolHandlers,
  responseContext: ResponseContextProvider,
  authorization?: HostSpanToolAuthorization,
  mode: HostSpanAuthMode = "none",
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
  registerHostSpanTools(server, handlers, responseContext, authorization, mode);
  // SDK 2's high-level registration omits canonical securitySchemes. Keep discovery
  // on its public handler API; tool invocation still uses the original SDK handlers.
  server.server.setRequestHandler("tools/list", () => ({ tools: listedTools(mode) }));
  return server;
}

export function createHostSpanHttpServer(options: HostSpanHttpServerOptions): FastifyInstance {
  const { mode, allowedHosts } = validateHttpAuthenticationConfiguration(options);
  const app = createMcpFastifyApp({ host: options.listen_host, allowedHosts, allowedOrigins: allowedHosts });
  const oauthVerifier = options.oauth ? mcpOAuthTokenVerifier(options.oauth) : undefined;
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });
  const reportTransportError = (error: Error) => {
    options.trace?.("transport.error", { message: error.message });
  };
  const { observations, servingRequest } = createTransportObservationState();
  const mcpHandler = createMcpHandler(
    (context) => {
      const invocation = servingRequest.getStore();
      if (invocation) options.trace?.("transport.sdk_selected", {
        transport_request_id: invocation.transport_request_id, ...auditInvocationIdentifiers(invocation), sdk_era: context.era,
      });
      return createMcpServer(options.handlers, options.responseContext, options.authorization, mode);
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
  registerTransportObservationHooks(app, options, { observations, servingRequest });
  registerStatusRoutes(app, options.status);
  if (options.oauth) registerOAuthRoutes(app, options.oauth, options.trace);
  registerMcpRoute(app, options, mode, oauthVerifier, async (request, reply, invocation) => {
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
