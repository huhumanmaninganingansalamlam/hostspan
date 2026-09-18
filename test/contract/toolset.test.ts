import { createMcpHandler } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../../src/mcp/server.js";
import {
  TOOLSET_HASH,
  TOOL_NAMES,
  toolsetDocument,
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

async function toolsListOnce(handler: ReturnType<typeof createMcpHandler>, id: number): Promise<Array<Record<string, unknown>>> {
  const response = await handler.fetch(
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-method": "tools/list",
        "mcp-protocol-version": "2026-07-28",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: { _meta: modernMeta } }),
    }),
  );
  expect(response.status).toBe(200);
  const listed = (await response.json()) as { result?: { tools?: Array<Record<string, unknown>> } };
  const tools = listed.result?.tools;
  if (!tools) throw new Error("tools/list returned no tools");
  return tools;
}

describe("hostspan-v2 tool contract", () => {
  it("contains exactly the fixed 11 tools with a stable digest", () => {
    const first = JSON.stringify(toolsetDocument());
    expect(toolsetDocument().tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    expect(toolsetDocument().tools).toHaveLength(11);
    expect(TOOLSET_HASH).toMatch(/^sha256:[0-9a-f]{64}$/);
    for (let index = 0; index < 100; index += 1) expect(JSON.stringify(toolsetDocument())).toBe(first);
  });

  it("keeps modern tools/list name/schema/annotation content stable across 100 per-request exchanges", async () => {
    const handler = createMcpHandler(() => createMcpServer(handlers, () => ({ toolset_hash: TOOLSET_HASH, policy_epoch: 1 })));
    try {
      let first: string | undefined;
      for (let index = 0; index < 100; index += 1) {
        const tools = await toolsListOnce(handler, index + 1);
        expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
        expect(tools).toHaveLength(11);
        const digestable = JSON.stringify(tools);
        first ??= digestable;
        expect(digestable).toBe(first);
      }
    } finally {
      await handler.close();
    }
  }, 15_000);
});
