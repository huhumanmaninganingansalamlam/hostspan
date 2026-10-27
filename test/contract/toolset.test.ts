import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../../src/mcp/server.js";
import {
  TOOLSET_HASH,
  TOOL_NAMES,
  registerHostSpanTools,
  type HostSpanToolHandlers,
} from "../../src/mcp/registry.js";

const handlers = Object.fromEntries(
  TOOL_NAMES.map((name) => [name, async () => ({ tool: name })]),
) as unknown as HostSpanToolHandlers;

const modernMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "hostspan-contract-test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

const HOSTSPAN_V3_5_APPROVED_TOOLSET_HASH = "sha256:29de3738393749c0bdd3b081121bf1d3adb5dde5fd9d752471503842cd0cdf7e";

async function toolsListOnce(handler: ReturnType<typeof createMcpHandler>, id: number, version = "2026-07-28"): Promise<Array<Record<string, unknown>>> {
  const modern = version === "2026-07-28";
  const response = await handler.fetch(
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-method": "tools/list",
        "mcp-protocol-version": version,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: modern ? { _meta: modernMeta } : {} }),
    }),
  );
  expect(response.status).toBe(200);
  const text = await response.text();
  const messages = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)))
    : [JSON.parse(text)];
  const listed = messages.find((message) => message.id === id) as { result?: { tools?: Array<Record<string, unknown>> } };
  const tools = listed.result?.tools;
  if (!tools) throw new Error("tools/list returned no tools");
  return tools;
}

describe("hostspan-v3.5 tool contract", () => {
  it("adds canonical auth metadata without changing SDK descriptors or dispatch in either wire era", async () => {
    const context = () => ({ toolset_hash: TOOLSET_HASH, policy_epoch: 1 });
    const baseline = createMcpHandler(() => {
      const server = new McpServer({ name: "hostspan", version: "test" });
      registerHostSpanTools(server, handlers, context);
      return server;
    });
    const adapted = createMcpHandler(() => createMcpServer(handlers, context));
    try {
      for (const version of ["2026-07-28", "2025-11-25"]) {
        const previous = await toolsListOnce(baseline, 1, version);
        const current = await toolsListOnce(adapted, 1, version);
        expect(current.map((tool) => tool.name)).toEqual(TOOL_NAMES);
        expect(current.map(({ securitySchemes, ...tool }) => {
          expect(securitySchemes).toEqual((tool._meta as { securitySchemes: unknown }).securitySchemes);
          return tool;
        })).toEqual(previous);
        for (const name of ["process_start", "process_cancel"]) {
          expect(current.find((tool) => tool.name === name)?.securitySchemes)
            .toEqual([{ type: "oauth2", scopes: ["hostspan.exec", "hostspan.terminal"] }]);
        }
      }
    } finally {
      await baseline.close();
      await adapted.close();
    }
  });

  it("keeps modern tools/list name/schema/annotation content stable across separate requests", async () => {
    expect(TOOLSET_HASH).toBe(HOSTSPAN_V3_5_APPROVED_TOOLSET_HASH);
    const handler = createMcpHandler(() => createMcpServer(handlers, () => ({ toolset_hash: TOOLSET_HASH, policy_epoch: 1 })));
    try {
      let first: string | undefined;
      for (let index = 0; index < 2; index += 1) {
        const tools = await toolsListOnce(handler, index + 1);
        expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
        const digestable = JSON.stringify(tools);
        first ??= digestable;
        expect(digestable).toBe(first);
      }
    } finally {
      await handler.close();
    }
  }, 15_000);
});
