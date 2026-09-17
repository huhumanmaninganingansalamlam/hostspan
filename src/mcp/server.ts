import { createMcpFastifyApp } from "@modelcontextprotocol/fastify";
import { toNodeHandler, type NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { FastifyInstance } from "fastify";
import { isIP } from "node:net";
import { SERVER_VERSION } from "../version.js";
import { registerHostSpanTools, type HostSpanToolHandlers, type ResponseContextProvider } from "./registry.js";

export interface ServerStatusProvider {
  health(): Record<string, unknown>;
  readiness(): { ready: boolean; [key: string]: unknown };
}

export interface HostSpanHttpServerOptions {
  listen_host: string;
  listen_port: number;
  allowed_hosts?: string[];
  handlers: HostSpanToolHandlers;
  responseContext: ResponseContextProvider;
  status: ServerStatusProvider;
  trace?: (event: string, metadata: Record<string, unknown>) => void;
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

export function createMcpServer(handlers: HostSpanToolHandlers, responseContext: ResponseContextProvider): McpServer {
  const server = new McpServer(
    { name: "hostspan", version: SERVER_VERSION },
    {
      instructions:
        "HostSpan operates on explicit persistent target_id values. File paths are target-relative. Side-effect tools require idempotency keys.",
    },
  );
  registerHostSpanTools(server, handlers, responseContext);
  return server;
}

export function createHostSpanHttpServer(options: HostSpanHttpServerOptions): FastifyInstance {
  const allowedHosts = resolveAllowedHosts(options.listen_host, options.allowed_hosts);
  const app = createMcpFastifyApp({ host: options.listen_host, allowedHosts });
  const reportTransportError = (error: Error) => {
    options.trace?.("transport.error", { message: error.message });
  };
  const mcpHandler = createMcpHandler(
    () => createMcpServer(options.handlers, options.responseContext),
    {
      legacy: "stateless",
      onerror: reportTransportError,
      responseMode: "auto",
    },
  );
  const nodeHandler = toNodeHandler(mcpHandler, { onerror: reportTransportError });
  app.addHook("onRequest", async (request) => {
    options.trace?.("transport.request", {
      method: request.method,
      url: request.url,
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
  app.all("/mcp", async (request, reply) => {
    reply.hijack();
    await nodeHandler(request.raw as unknown as NodeIncomingMessageLike, reply.raw, request.body);
  });
  app.addHook("onClose", async () => {
    await mcpHandler.close();
  });
  return app;
}

export async function listenHostSpan(app: FastifyInstance, host: string, port: number): Promise<string> {
  return app.listen({ host, port });
}
