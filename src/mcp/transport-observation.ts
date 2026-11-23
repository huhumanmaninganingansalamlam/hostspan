import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyInstance } from "fastify";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server";
import { auditInvocationIdentifiers } from "../observability/error-diagnostics.js";
import { PROTOCOL_VERSION } from "../version.js";
import { TOOL_NAMES } from "./registry.js";
import type { HostSpanHttpServerOptions } from "./server.js";

function requestedProtocol(value: unknown): string | null {
	if (value === undefined) return null;
	return typeof value === "string" &&
		(value === PROTOCOL_VERSION || SUPPORTED_PROTOCOL_VERSIONS.includes(value))
		? value
		: "unrecognized";
}

export function observedMediaType(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	const media =
		typeof value === "string"
			? value.split(";", 1)[0]?.trim().toLowerCase()
			: undefined;
	return media === "application/json" || media === "text/event-stream"
		? media
		: "other";
}

export interface McpTransportObservation {
	transport_request_id: string;
	idempotency_key?: string;
	request_id?: string;
	response_source?: "sdk" | "fastify";
	response_status?: number;
	response_media?: string | null;
	response_auth_challenge?: boolean;
}

export function createTransportObservationState() {
	const observations = new WeakMap<object, McpTransportObservation>();
	const servingRequest = new AsyncLocalStorage<McpTransportObservation>();
	return { observations, servingRequest };
}

export function registerTransportObservationHooks(
	app: FastifyInstance,
	options: Pick<
		HostSpanHttpServerOptions,
		"trace" | "max_inflight_mcp_requests"
	>,
	{ observations }: ReturnType<typeof createTransportObservationState>,
): void {
	const maxInflightMcpRequests = options.max_inflight_mcp_requests ?? 128;
	let inflightMcpRequests = 0;
	app.addHook("onRequest", async (request, reply) => {
		const path = request.url.split("?", 1)[0];
		if (path !== "/mcp") return;
		const observation: McpTransportObservation = {
			transport_request_id: request.id,
		};
		observations.set(request, observation);
		let observed = false;
		const observeResponse = (outcome: "finished" | "closed_before_finish") => {
			if (observed) return;
			observed = true;
			const body = request.body as
				| { params?: { arguments?: unknown; _meta?: Record<string, unknown> } }
				| undefined;
			const id =
				reply.raw.getHeader("x-hostspan-request-id") ?? observation.request_id;
			const type = reply.raw.getHeader("content-type");
			const media = type !== undefined ? observedMediaType(type) : "unobserved";
			options.trace?.("transport.response", {
				transport_request_id: request.id,
				...auditInvocationIdentifiers(body?.params?.arguments),
				...(typeof id === "string" && /^req_[0-9a-f]{32}$/i.test(id)
					? { request_id: id }
					: {}),
				requested_protocol_header: requestedProtocol(
					request.headers["mcp-protocol-version"],
				),
				requested_protocol_envelope: requestedProtocol(
					body?.params?._meta?.["io.modelcontextprotocol/protocolVersion"],
				),
				selected_protocol_version: "unobserved",
				response_envelope_validity: "unobserved",
				outcome,
				headers_sent: reply.raw.headersSent,
				writable_finished: reply.raw.writableFinished,
				http_status: reply.raw.headersSent ? reply.raw.statusCode : null,
				content_type: reply.raw.headersSent ? media : null,
				http_auth_challenge_present: reply.raw.headersSent
					? reply.raw.hasHeader("www-authenticate")
						? true
						: "unobserved"
					: null,
				prepared_response_source: observation.response_source ?? "unobserved",
				prepared_response_status: observation.response_status ?? "unobserved",
				prepared_response_content_type:
					observation.response_media === undefined
						? "unobserved"
						: observation.response_media,
				prepared_response_http_auth_challenge_present:
					observation.response_auth_challenge ?? "unobserved",
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
			observation.response_media = observedMediaType(
				reply.getHeader("content-type"),
			);
			observation.response_auth_challenge = reply.hasHeader("www-authenticate");
			const id = reply.getHeader("x-hostspan-request-id");
			if (typeof id === "string" && /^req_[0-9a-f]{32}$/i.test(id))
				observation.request_id = id;
		}
		return payload;
	});
	app.addHook("preHandler", async (request) => {
		const traceUrl = request.url.split("?", 1)[0];
		const body = request.body as
			| { method?: unknown; params?: { name?: unknown; arguments?: unknown } }
			| undefined;
		options.trace?.("transport.request", {
			transport_request_id: request.id,
			...auditInvocationIdentifiers(body?.params?.arguments),
			method: request.method,
			url: traceUrl,
			rpc_method:
				typeof body?.method === "string" &&
				["initialize", "tools/list", "tools/call", "server/discover"].includes(
					body.method,
				)
					? body.method
					: undefined,
			tool: TOOL_NAMES.find((name) => name === body?.params?.name),
		});
	});
}
