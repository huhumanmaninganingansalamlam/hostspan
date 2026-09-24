import { createMcpFastifyApp } from "@modelcontextprotocol/fastify";
import { toNodeHandler, type NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import {
  bearerAuthChallengeResponse,
  createMcpHandler,
  McpServer,
  OAuthError,
  OAuthErrorCode,
  verifyBearerToken,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import type { FastifyInstance, FastifyReply } from "fastify";
import { isIP } from "node:net";
import {
  OAuthAuthorizationRedirectError,
  OAuthHttpError,
  type OAuthService,
} from "../auth/oauth-service.js";
import { SERVER_VERSION } from "../version.js";
import { registerHostSpanTools, type HostSpanToolAuthorization, type HostSpanToolHandlers, type ResponseContextProvider } from "./registry.js";

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
      instructions:
        "HostSpan operates on explicit persistent target_id values. File paths are target-relative. Side-effect tools require idempotency keys.",
    },
  );
  registerHostSpanTools(server, handlers, responseContext, authorization);
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
  const mcpHandler = createMcpHandler(
    () => createMcpServer(options.handlers, options.responseContext, options.authorization),
    {
      onerror: reportTransportError,
      responseMode: "auto",
    },
  );
  const nodeHandler = toNodeHandler(mcpHandler, { onerror: reportTransportError });
  const maxInflightMcpRequests = options.max_inflight_mcp_requests ?? 128;
  let inflightMcpRequests = 0;
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?", 1)[0];
    if (path !== "/mcp") return;
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
  app.addHook("onRequest", async (request) => {
    const oauthPath = ["/authorize", "/token", "/register", "/revoke"].some((path) => request.url.startsWith(path));
    const traceUrl = oauthPath || request.url.startsWith("/.well-known/") ? request.url.split("?", 1)[0] : request.url;
    options.trace?.("transport.request", {
      method: request.method,
      url: traceUrl,
      rpc_method:
        request.body && typeof request.body === "object" && "method" in request.body
          ? String((request.body as Record<string, unknown>).method)
          : undefined,
    });
  });
  app.get("/healthz", async () => ({ status: "ok", ...options.status.health() }));
  app.get("/readyz", async (_request, reply) => {
    const readiness = options.status.readiness();
    if (!readiness.ready) reply.code(503);
    return readiness;
  });
  if (options.oauth) registerOAuthRoutes(app, options.oauth);
  app.all("/mcp", async (request, reply) => {
    if (options.oauth && oauthVerifier) {
      try {
        const auth = await verifyBearerToken(request.headers.authorization, {
          verifier: oauthVerifier,
          resourceMetadataUrl: options.oauth.resourceMetadataUrl,
        });
        Object.assign(request.raw, { auth });
      } catch (error) {
        return sendWebResponse(
          reply,
          bearerAuthChallengeResponse(error, {
            resourceMetadataUrl: options.oauth.resourceMetadataUrl,
          }),
        );
      }
    }
    reply.hijack();
    await nodeHandler(request.raw as unknown as NodeIncomingMessageLike, reply.raw, request.body);
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

function registerOAuthRoutes(app: FastifyInstance, oauth: OAuthService): void {
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
    try {
      return cors(reply)
        .header("cache-control", "no-store")
        .header("pragma", "no-cache")
        .send(oauth.exchangeToken(requestForm(request.body)));
    } catch (error) {
      const result = oauthErrorPayload(error);
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
