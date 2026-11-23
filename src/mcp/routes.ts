import {
	bearerAuthChallengeResponse,
	OAuthError,
	verifyBearerToken,
	type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { HostSpanAuthMode } from "../config/schema.js";
import type { VerifiedPrivateToken } from "../auth/private-token.js";
import { auditInvocationIdentifiers } from "../observability/error-diagnostics.js";
import { TOOL_NAMES, type ToolCaller } from "./registry.js";
import { requestId } from "./result.js";
import { validateInboundToolCall } from "./request-validation.js";
import type { HostSpanHttpServerOptions } from "./server.js";

export function registerStatusRoutes(
	app: FastifyInstance,
	status: HostSpanHttpServerOptions["status"],
): void {
	app.get("/healthz", async () => ({ status: "ok", ...status.health() }));
	app.get("/readyz", async (_request, reply) => {
		const readiness = status.readiness();
		if (!readiness.ready) reply.code(503);
		return readiness;
	});
}
export type McpSdkDispatch = (
	request: FastifyRequest,
	reply: FastifyReply,
	invocation: ReturnType<typeof auditInvocationIdentifiers>,
) => Promise<void>;
export function registerMcpRoute(
	app: FastifyInstance,
	options: HostSpanHttpServerOptions,
	mode: HostSpanAuthMode,
	oauthVerifier: OAuthTokenVerifier | undefined,
	dispatchToSdk: McpSdkDispatch,
): void {
	app.all("/mcp", async (request, reply) => {
		const body = request.body as
			| {
					jsonrpc?: unknown;
					id?: unknown;
					method?: unknown;
					params?: { name?: unknown; arguments?: unknown };
			  }
			| undefined;
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
					transport_request_id: request.id,
					...invocation,
					request_id: id,
					stage: "authentication",
					http_status: response.status,
					error_code: error instanceof OAuthError ? error.code : "server_error",
					tool: TOOL_NAMES.find((name) => name === body?.params?.name),
				});
				reply.header("x-hostspan-request-id", id);
				return sendWebResponse(reply, response);
			}
		}
		if (mode === "private_token" && options.privateTokens) {
			let verified: VerifiedPrivateToken | undefined;
			try {
				verified = options.privateTokens.verifyAuthorizationHeader(
					request.headers.authorization,
				);
			} catch {
				// Store failures must never grant local authority or expose credential details.
				return reply
					.code(503)
					.header("cache-control", "no-store")
					.send({ error: "authentication_unavailable" });
			}
			if (!verified) {
				const id = requestId();
				options.trace?.("authorization.rejected", {
					transport_request_id: request.id,
					...invocation,
					request_id: id,
					stage: "authentication",
					http_status: 401,
					error_code: "invalid_token",
					tool: TOOL_NAMES.find((name) => name === body?.params?.name),
				});
				return reply
					.code(401)
					.header("cache-control", "no-store")
					.header("x-hostspan-request-id", id)
					.send({ error: "unauthorized" });
			}
			Object.assign(request.raw, {
				auth: {
					token: "redacted",
					clientId: `private_token:${verified.token_id}`,
					scopes: verified.scopes,
				},
			});
			caller = {
				caller_mode: "private_token",
				private_token_id: verified.token_id,
			};
		}
		const validationRejection = validateInboundToolCall(
			request,
			reply,
			caller,
			invocation,
			options,
		);
		if (validationRejection) return validationRejection;
		await dispatchToSdk(request, reply, invocation);
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
