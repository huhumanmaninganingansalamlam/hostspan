import { afterEach, describe, expect, it, vi } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { toolsetDocument } from "../../src/mcp/registry.js";
import {
	OAuthScopeTestContext,
	issueOAuthToken,
	modernOAuthMeta,
	callOAuthMcpTool,
	expectOAuthToolAllowed,
	expectOAuthScopeDenied,
	oauthPatchArgs,
	oauthProcessStartArgs,
} from "../helpers/oauth-scope-fixture.js";

const oauthTests = new OAuthScopeTestContext();

afterEach(async () => {
	await oauthTests.dispose();
});

describe("OAuth transport and response scope enforcement", () => {
	it("keeps invalid response waits distinct from insufficient scope without dispatch", async () => {
		const { runtime, approvalSecret } = oauthTests.createOAuthScopeRuntime();
		const oauth = runtime.oauth;
		if (!oauth) throw new Error("OAuth runtime was not initialized.");
		const calls: string[] = [];
		const app = oauthTests.createOAuthTestApp(runtime, calls);
		try {
			expect(
				toolsetDocument().tools.find((tool) => tool.name === "process_start")
					?.input_schema,
			).toMatchObject({
				properties: {
					wait_ms: {
						type: "integer",
						minimum: 0,
						maximum: 1_500,
						default: 1_200,
					},
				},
			});
			const exec = issueOAuthToken(
				oauth,
				approvalSecret,
				"hostspan.read hostspan.exec",
			);
			const terminal = issueOAuthToken(
				oauth,
				approvalSecret,
				"hostspan.read hostspan.terminal",
				exec.clientId,
			);
			for (const grant of [exec, terminal]) {
				const body = await callOAuthMcpTool(
					app,
					grant.token.access_token,
					"process_start",
					{ ...oauthProcessStartArgs(false), wait_ms: 10_000 },
				);
				expect(body.result).toMatchObject({
					resultType: "complete",
					isError: true,
					structuredContent: {
						error: {
							code: "VALIDATION_FAILED",
							message: expect.stringMatching(/wait_ms.*1500/),
							details: { reason: "invalid_tool_arguments" },
						},
					},
				});
				expect(body.result?._meta?.["mcp/www_authenticate"]).toBeUndefined();
			}
			const legacy = await callOAuthMcpTool(
				app,
				exec.token.access_token,
				"process_start",
				{ ...oauthProcessStartArgs(false), wait_ms: 10_000 },
				"2025-11-25",
			);
			expect(legacy.result).toMatchObject({
				isError: true,
				structuredContent: { error: { code: "VALIDATION_FAILED" } },
			});
			expect(legacy.result?.resultType).toBeUndefined();
			expect(legacy.result?._meta?.["mcp/www_authenticate"]).toBeUndefined();
			const denied = await callOAuthMcpTool(
				app,
				terminal.token.access_token,
				"process_start",
				{ ...oauthProcessStartArgs(false), wait_ms: 1_000 },
			);
			expect(denied.result?.resultType).toBe("complete");
			expectOAuthScopeDenied(denied, "hostspan.exec");
			const challenge = denied.result?._meta?.["mcp/www_authenticate"];
			expect(challenge).toHaveLength(1);
			for (const value of [
				'error="insufficient_scope"',
				"hostspan.read",
				"hostspan.terminal",
				"hostspan.exec",
			]) {
				expect(challenge?.[0]).toContain(value);
			}
			expect(calls).toEqual([]);
			const allowed = await callOAuthMcpTool(
				app,
				exec.token.access_token,
				"system_status",
				{},
			);
			expectOAuthToolAllowed(allowed, "system_status");
			expect(allowed.result?.resultType).toBe("complete");
			expect(calls).toEqual(["system_status"]);
		} finally {
			await oauthTests.closeApp(app);
			await oauthTests.closeRuntime(runtime);
		}
	});

	it("records bounded HTTP completion and close-before-finish over real local sockets", async () => {
		const http = await import("node:http");
		const { runtime, approvalSecret } = oauthTests.createOAuthScopeRuntime();
		const oauth = runtime.oauth;
		if (!oauth) throw new Error("OAuth runtime was not initialized.");
		const traces: Array<Record<string, unknown>> = [];
		const calls: string[] = [];
		let hold = false;
		let entered!: () => void;
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const app = oauthTests.createOAuthTestApp(runtime, calls, traces, {
			file_patch: async () => {
				calls.push("fixture-file_patch");
				if (hold) {
					entered();
					await held;
				}
				return { tool: "file_patch" };
			},
		});
		const grant = issueOAuthToken(oauth, approvalSecret, "hostspan.write");
		const secret = "PRIVATE_HTTP_CANARY";
		try {
			const address = await app.listen({ host: "127.0.0.1", port: 0 });
			const headers = (version: string, authenticated = true) => ({
				host: "mcp.example.com",
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
				"mcp-method": "tools/call",
				"mcp-name": "file_patch",
				"mcp-protocol-version": version,
				...(authenticated
					? { authorization: `Bearer ${grant.token.access_token}` }
					: {}),
			});
			const payload = (version: string, key: string) => ({
				jsonrpc: "2.0",
				id: secret,
				method: "tools/call",
				params: {
					name: "file_patch",
					arguments: {
						...oauthPatchArgs(),
						idempotency_key: key,
						dry_run: true,
					},
					...(version === "2026-07-28" ? { _meta: modernOAuthMeta() } : {}),
				},
			});
			for (const [version, media, era] of [
				["2026-07-28", "application/json", "modern"],
				["2025-11-25", "text/event-stream", "legacy"],
			] as const) {
				const key = uuidv7();
				const response = await fetch(`${address}/mcp`, {
					method: "POST",
					headers: headers(version),
					body: JSON.stringify(payload(version, key)),
					signal: AbortSignal.timeout(5_000),
				});
				await response.text();
				expect(response.status).toBe(200);
				await vi.waitFor(() =>
					expect(
						traces.some(
							(row) =>
								row.event === "transport.response" &&
								row.idempotency_key === key,
						),
					).toBe(true),
				);
				const terminal = traces.filter(
					(row) =>
						row.event === "transport.response" && row.idempotency_key === key,
				);
				expect(terminal).toHaveLength(1);
				expect(terminal[0]).toMatchObject({
					outcome: "finished",
					headers_sent: true,
					writable_finished: true,
					http_status: 200,
					content_type: "unobserved",
					http_auth_challenge_present: "unobserved",
					prepared_response_source: "sdk",
					prepared_response_status: 200,
					prepared_response_content_type: media,
					prepared_response_http_auth_challenge_present: false,
					requested_protocol_header: version,
					selected_protocol_version: "unobserved",
					response_envelope_validity: "unobserved",
				});
				expect(traces).toContainEqual(
					expect.objectContaining({
						event: "transport.sdk_selected",
						idempotency_key: key,
						transport_request_id: terminal[0]?.transport_request_id,
						sdk_era: era,
					}),
				);
			}
			const unauthKey = uuidv7();
			const unauth = await fetch(`${address}/mcp`, {
				method: "POST",
				headers: headers("2026-07-28", false),
				body: JSON.stringify(payload("2026-07-28", unauthKey)),
				signal: AbortSignal.timeout(5_000),
			});
			await unauth.text();
			expect(unauth.status).toBe(401);
			await vi.waitFor(() =>
				expect(
					traces.some(
						(row) =>
							row.event === "transport.response" &&
							row.idempotency_key === unauthKey,
					),
				).toBe(true),
			);
			expect(traces).toContainEqual(
				expect.objectContaining({
					event: "transport.response",
					idempotency_key: unauthKey,
					http_status: 401,
					prepared_response_source: "fastify",
					prepared_response_http_auth_challenge_present: true,
					request_id: unauth.headers.get("x-hostspan-request-id"),
				}),
			);

			hold = true;
			const abortedKey = uuidv7();
			const client = http.request(`${address}/mcp`, {
				method: "POST",
				headers: headers("2026-07-28"),
			});
			client.on("error", () => undefined);
			client.end(JSON.stringify(payload("2026-07-28", abortedKey)));
			await pending;
			// A legacy response completes while the modern request is still in its handler.
			hold = false;
			const concurrentKey = uuidv7();
			const concurrent = await fetch(`${address}/mcp`, {
				method: "POST",
				headers: headers("2025-11-25"),
				body: JSON.stringify(payload("2025-11-25", concurrentKey)),
				signal: AbortSignal.timeout(5_000),
			});
			await concurrent.text();
			expect(concurrent.status).toBe(200);
			expect(traces).toContainEqual(
				expect.objectContaining({
					event: "transport.sdk_selected",
					idempotency_key: concurrentKey,
					sdk_era: "legacy",
				}),
			);
			expect(traces).toContainEqual(
				expect.objectContaining({
					event: "transport.sdk_selected",
					idempotency_key: abortedKey,
					sdk_era: "modern",
				}),
			);
			const closed = new Promise<void>((resolve) =>
				client.once("close", resolve),
			);
			client.destroy();
			await closed;
			await vi.waitFor(() =>
				expect(
					traces.some(
						(row) =>
							row.event === "transport.response" &&
							row.idempotency_key === abortedKey,
					),
				).toBe(true),
			);
			const aborted = traces.filter(
				(row) =>
					row.event === "transport.response" &&
					row.idempotency_key === abortedKey,
			);
			expect(aborted).toHaveLength(1);
			expect(aborted[0]).toMatchObject({
				outcome: "closed_before_finish",
				headers_sent: false,
				writable_finished: false,
				http_status: null,
				content_type: null,
				http_auth_challenge_present: null,
			});
			expect(traces).toContainEqual(
				expect.objectContaining({
					event: "transport.response",
					idempotency_key: concurrentKey,
					outcome: "finished",
					prepared_response_content_type: "text/event-stream",
					http_status: 200,
				}),
			);
			const terminal = JSON.stringify(
				traces.filter(
					(row) =>
						row.event === "transport.response" ||
						row.event === "transport.sdk_selected",
				),
			);
			expect(terminal).not.toContain(secret);
			expect(terminal).not.toContain(grant.token.access_token);
		} finally {
			release();
			await oauthTests.closeApp(app);
			await oauthTests.closeRuntime(runtime);
		}
	}, 15_000);
});
