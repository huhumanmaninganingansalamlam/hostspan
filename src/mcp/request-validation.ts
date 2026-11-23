import { classifyInboundRequest } from "@modelcontextprotocol/server";
import type { FastifyRequest, FastifyReply } from "fastify";
import { HostSpanError } from "../errors.js";
import type { auditInvocationIdentifiers } from "../observability/error-diagnostics.js";
import { errorResult, requestId } from "./result.js";
import { TOOL_DEFINITIONS, type ToolCaller } from "./registry.js";
import type { HostSpanHttpServerOptions } from "./server.js";

// GHSA-46jr-4wx8-v453: bound schema-validation allocations, including our pre-handler diagnostics.
export const MAX_TOOL_INPUT_ELEMENTS = 10_000;
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

export function validateInboundToolCall(
	request: FastifyRequest,
	reply: FastifyReply,
	caller: ToolCaller,
	invocation: ReturnType<typeof auditInvocationIdentifiers>,
	options: HostSpanHttpServerOptions,
): FastifyReply | undefined {
	const body = request.body as
		| {
				jsonrpc?: unknown;
				id?: unknown;
				method?: unknown;
				params?: { name?: unknown; arguments?: unknown };
		  }
		| undefined;
	if (
		request.method === "POST" &&
		body?.jsonrpc === "2.0" &&
		(typeof body.id === "string" || typeof body.id === "number") &&
		body.method === "tools/call"
	) {
		const tool = TOOL_DEFINITIONS.find(
			(entry) => entry.name === body.params?.name,
		);
		const route = classifyInboundRequest({
			httpMethod: request.method,
			...(request.headers["mcp-protocol-version"] !== undefined
				? {
						protocolVersionHeader:
							request.headers["mcp-protocol-version"].toString(),
					}
				: {}),
			...(request.headers["mcp-method"] !== undefined
				? { mcpMethodHeader: request.headers["mcp-method"].toString() }
				: {}),
			...(request.headers["mcp-name"] !== undefined
				? { mcpNameHeader: request.headers["mcp-name"].toString() }
				: {}),
			body,
		});
		if (tool && route.kind !== "reject") {
			// SDK schema failures bypass tool handlers. Preserve their detail and correlate them in our audit.
			// Valid calls still pass through the SDK's protocol and schema checks.
			const args = body.params?.arguments ?? {};
			const parsed = withinInputBudget(args)
				? tool.inputSchema.safeParse(args)
				: undefined;
			if (!parsed?.success) {
				const id = requestId();
				const issues = parsed
					? parsed.error.issues.map(
							(issue) =>
								`${issue.path.join(".") || "arguments"}: ${issue.message}`,
						)
					: [
							`arguments exceed the ${MAX_TOOL_INPUT_ELEMENTS} element validation budget`,
						];
				const error = new HostSpanError(
					"VALIDATION_FAILED",
					`Invalid ${tool.name} arguments: ${issues.join("; ")}`,
					false,
					{ reason: "invalid_tool_arguments" },
				);
				options.authorization?.rejected?.(
					tool.name,
					invocation,
					id,
					error,
					"validation",
					tool.name === "computer" ? caller : undefined,
				);
				// Schema-owned top-level names only: nested record keys and issue messages can contain caller data.
				const fields = new Set(
					"shape" in tool.inputSchema
						? Object.keys(tool.inputSchema.shape)
						: tool.inputSchema.options.flatMap((option) =>
								Object.keys(option.shape),
							),
				);
				const validationIssues = parsed
					? parsed.error.issues.slice(0, 16).map(({ path, code }) => ({
							field:
								typeof path[0] === "string" && fields.has(path[0])
									? path[0]
									: "arguments",
							code,
						}))
					: [{ field: "arguments", code: "input_budget_exceeded" }];
				options.trace?.("validation.rejected", {
					transport_request_id: request.id,
					...invocation,
					request_id: id,
					tool: tool.name,
					stage: "validation",
					error_code: error.code,
					reason: "invalid_tool_arguments",
					validation_issues: validationIssues,
					validation_issue_count: parsed ? parsed.error.issues.length : 1,
				});
				reply.header("x-hostspan-request-id", id);
				// This direct reply bypasses the SDK's modern wire-result stamp.
				return reply.send({
					jsonrpc: "2.0",
					id: body.id ?? null,
					result: {
						...errorResult(options.responseContext(), error, id),
						...(route.kind === "modern" ? { resultType: "complete" } : {}),
					},
				});
			}
		}
	}
	return undefined;
}
