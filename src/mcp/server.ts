import { createMcpFastifyApp } from "@modelcontextprotocol/fastify";
import { toNodeHandler, type NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { FastifyInstance } from "fastify";
import { SERVER_VERSION } from "../version.js";
import { registerHostSpanTools, type HostSpanToolHandlers, type ResponseContextProvider } from "./registry.js";

export interface ServerStatusProvider {
  health(): Record<string, unknown>;
  readiness(): { ready: boolean; [key: string]: unknown };
}

export interface HostSpanHttpServerOptions {
  listen_host: "127.0.0.1";
  listen_port: number;
  mcp_path?: string;
  diagnostic_routes?: boolean;
  handlers: HostSpanToolHandlers;
  responseContext: ResponseContextProvider;
  status: ServerStatusProvider;
  trace?: (event: string, metadata: Record<string, unknown>) => void;
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
  const app = createMcpFastifyApp({ host: options.listen_host });
  const mcpPath = options.mcp_path ?? "/mcp";
  const diagnosticRoutes = options.diagnostic_routes ?? true;
  if (!mcpPath.startsWith("/") || mcpPath.includes("?") || mcpPath.includes("#")) {
    throw new Error("mcp_path must be an absolute URL path without query or fragment components");
  }
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
  app.addHook("onRequest", async (request, reply) => {
    const traceUrl = request.url.split("?", 1)[0] === mcpPath ? "/mcp" : request.url;
    const hostHeader = request.headers.host ?? "";
    const hostname = hostHeader.startsWith("[") ? hostHeader.slice(1, hostHeader.indexOf("]")) : hostHeader.split(":")[0];
    if (hostname && !["127.0.0.1", "localhost", "::1"].includes(hostname.toLowerCase())) {
      options.trace?.("transport.host_rejected", {
        method: request.method,
        url: traceUrl,
        host: hostname,
      });
      return reply.code(421).send({ error: "Host header is not allowed; HostSpan Alpha is loopback-only." });
    }
    options.trace?.("transport.request", {
      method: request.method,
      url: traceUrl,
      rpc_method:
        request.body && typeof request.body === "object" && "method" in request.body
          ? String((request.body as Record<string, unknown>).method)
          : undefined,
    });
  });
  if (diagnosticRoutes) {
    app.get("/healthz", async () => ({ status: "ok", ...options.status.health() }));
    app.get("/readyz", async (_request, reply) => {
      const readiness = options.status.readiness();
      if (!readiness.ready) reply.code(503);
      return readiness;
    });
  }
  app.all(mcpPath, async (request, reply) => {
    reply.hijack();
    await nodeHandler(request.raw as unknown as NodeIncomingMessageLike, reply.raw, request.body);
  });
  app.addHook("onClose", async () => {
    await mcpHandler.close();
  });
  return app;
}

export async function listenHostSpan(app: FastifyInstance, host: "127.0.0.1", port: number): Promise<string> {
  return app.listen({ host, port });
}
