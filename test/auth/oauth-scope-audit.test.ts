import { afterEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import {
	OAuthScopeTestContext,
	issueOAuthToken,
	refreshOAuthToken,
	modernOAuthMeta,
	callOAuthMcpTool,
	expectOAuthToolAllowed,
	expectOAuthScopeDenied,
	oauthProcessStartArgs,
} from "../helpers/oauth-scope-fixture.js";

const oauthTests = new OAuthScopeTestContext();

afterEach(async () => {
	await oauthTests.dispose();
});

describe("OAuth validation and scope audit hygiene", () => {
	it("preserves advertised granular grants and enforces exec separately from terminal", async () => {
		const { runtime, approvalSecret } = oauthTests.createOAuthScopeRuntime();
		const oauth = runtime.oauth;
		if (!oauth) throw new Error("OAuth runtime was not initialized.");
		const calls: string[] = [];
		const app = oauthTests.createOAuthTestApp(runtime, calls);
		try {
			for (const path of [
				"/.well-known/oauth-authorization-server",
				"/.well-known/oauth-protected-resource",
			]) {
				const metadata = await app.inject({
					method: "GET",
					url: path,
					headers: { host: "mcp.example.com" },
				});
				expect(metadata.statusCode).toBe(200);
				expect(metadata.json().scopes_supported).toEqual([
					"hostspan.computer",
					"hostspan.read",
					"hostspan.write",
					"hostspan.exec",
					"hostspan.terminal",
				]);
			}
			// Static discovery requests both possible scopes; each call still enforces only its branch.
			const allScopes = [
				"hostspan.computer",
				"hostspan.read",
				"hostspan.write",
				"hostspan.exec",
				"hostspan.terminal",
			];
			const full = issueOAuthToken(oauth, approvalSecret, allScopes.join(" "));
			expect(oauth.verifyAccessToken(full.token.access_token)?.scopes).toEqual(
				allScopes,
			);
			const refreshed = refreshOAuthToken(
				oauth,
				full.clientId,
				full.token.refresh_token,
			);
			expect(oauth.verifyAccessToken(refreshed.access_token)?.scopes).toEqual(
				allScopes,
			);
			const listed = await app.inject({
				method: "POST",
				url: "/mcp",
				headers: {
					host: "mcp.example.com",
					accept: "application/json, text/event-stream",
					"content-type": "application/json",
					"mcp-method": "tools/list",
					"mcp-protocol-version": "2026-07-28",
					authorization: `Bearer ${refreshed.access_token}`,
				},
				payload: {
					jsonrpc: "2.0",
					id: 1,
					method: "tools/list",
					params: { _meta: modernOAuthMeta() },
				},
			});
			expect(listed.statusCode).toBe(200);
			const tools = listed.json().result.tools as Array<{
				name: string;
				securitySchemes?: unknown;
				_meta?: { securitySchemes?: unknown };
			}>;
			for (const name of ["process_start", "process_cancel"]) {
				expect(
					tools.find((tool) => tool.name === name)?.securitySchemes,
				).toEqual([
					{ type: "oauth2", scopes: ["hostspan.exec", "hostspan.terminal"] },
				]);
				expect(
					tools.find((tool) => tool.name === name)?._meta?.securitySchemes,
				).toEqual([
					{ type: "oauth2", scopes: ["hostspan.exec", "hostspan.terminal"] },
				]);
			}
			const scopes = [
				"hostspan.computer",
				"hostspan.read",
				"hostspan.write",
				"hostspan.terminal",
			];
			const grant = issueOAuthToken(oauth, approvalSecret, scopes.join(" "));
			expect(oauth.verifyAccessToken(grant.token.access_token)?.scopes).toEqual(
				scopes,
			);
			const status = await callOAuthMcpTool(
				app,
				grant.token.access_token,
				"system_status",
				{},
			);
			expect(status.result?.structuredContent?.authorization).toMatchObject({
				mode: "oauth",
				granted_scopes: scopes,
			});
			const denied = await callOAuthMcpTool(
				app,
				grant.token.access_token,
				"process_start",
				{ ...oauthProcessStartArgs(false), wait_ms: 1_000 },
			);
			expectOAuthScopeDenied(denied, "hostspan.exec");
			expect(denied.result?._meta?.["mcp/www_authenticate"]?.[0]).toContain(
				'error="insufficient_scope"',
			);
			expect(calls).toEqual(["system_status"]);
			expectOAuthToolAllowed(
				await callOAuthMcpTool(
					app,
					grant.token.access_token,
					"process_start",
					oauthProcessStartArgs(true),
				),
				"process_start",
			);
			expect(calls).toEqual(["system_status", "process_start"]);
		} finally {
			await oauthTests.closeApp(app);
			await oauthTests.closeRuntime(runtime);
		}
	});

	it("correlates early authentication, validation and scope rejects without retaining payloads", async () => {
		const { runtime, approvalSecret } = oauthTests.createOAuthScopeRuntime();
		const oauth = runtime.oauth;
		if (!oauth) throw new Error("OAuth runtime was not initialized.");
		const calls: string[] = [];
		const traces: Array<Record<string, unknown>> = [];
		const app = oauthTests.createOAuthTestApp(runtime, calls, traces);
		const secret = "HOSTSPAN_SECRET_CANARY_EARLY_REJECT";
		const grant = issueOAuthToken(oauth, approvalSecret, "hostspan.read");
		const inject = (
			idempotency_key: string,
			wait_ms: number,
			authenticated = true,
		) =>
			app.inject({
				method: "POST",
				url: "/mcp",
				headers: {
					host: "mcp.example.com",
					accept: "application/json, text/event-stream",
					"content-type": "application/json",
					"mcp-method": "tools/call",
					"mcp-name": "process_start",
					"mcp-protocol-version": "2026-07-28",
					...(authenticated
						? { authorization: `Bearer ${grant.token.access_token}` }
						: {}),
				},
				payload: {
					jsonrpc: "2.0",
					id: secret,
					method: "tools/call",
					params: {
						name: "process_start",
						arguments: {
							...oauthProcessStartArgs(false),
							idempotency_key,
							wait_ms,
							argv: [secret],
							env: { SECRET: secret },
						},
						_meta: modernOAuthMeta(),
					},
				},
			});
		try {
			const unauthKey = uuidv7();
			const unauth = await inject(unauthKey, 10_000, false);
			expect(unauth.statusCode).toBe(401);
			expect(unauth.headers["www-authenticate"]).toContain("Bearer");
			const ingress = traces.find(
				(row) =>
					row.event === "transport.request" &&
					row.idempotency_key === unauthKey,
			);
			expect(ingress).toMatchObject({
				transport_request_id: expect.any(String),
				tool: "process_start",
			});
			expect(traces).toContainEqual(
				expect.objectContaining({
					event: "authorization.rejected",
					idempotency_key: unauthKey,
					transport_request_id: ingress?.transport_request_id,
					request_id: unauth.headers["x-hostspan-request-id"],
					stage: "authentication",
					http_status: 401,
				}),
			);

			for (const wait_ms of [10_000, 1_000]) {
				const key = uuidv7();
				const response = await inject(key, wait_ms);
				expect(response.statusCode).toBe(200);
				expect(response.headers["www-authenticate"]).toBeUndefined();
				const result = response.json().result;
				const validation = wait_ms > 1_500;
				expect(result).toMatchObject({
					resultType: "complete",
					isError: true,
					structuredContent: {
						error: {
							code: validation ? "VALIDATION_FAILED" : "SCOPE_DENIED",
						},
					},
				});
				expect(Boolean(result._meta?.["mcp/www_authenticate"])).toBe(
					!validation,
				);
				expect(runtime.audit.recent()).toContainEqual(
					expect.objectContaining({
						request_id: result.structuredContent.request_id,
						metadata: expect.objectContaining({
							idempotency_key: key,
							tool: "process_start",
							stage: validation ? "validation" : "authorization",
						}),
					}),
				);
				if (validation) {
					expect(response.headers["x-hostspan-request-id"]).toBe(
						result.structuredContent.request_id,
					);
					expect(traces).toContainEqual(
						expect.objectContaining({
							event: "validation.rejected",
							idempotency_key: key,
							request_id: result.structuredContent.request_id,
							transport_request_id: expect.any(String),
						}),
					);
				}
			}
			await inject(secret, 10_000);
			expect(
				JSON.stringify({ traces, audit: runtime.audit.recent() }),
			).not.toContain(secret);
			expect(calls).toEqual([]);
		} finally {
			await oauthTests.closeApp(app);
			await oauthTests.closeRuntime(runtime);
		}
	});

	it("retains bounded schema field and issue codes without validation payloads", async () => {
		const { runtime, approvalSecret } = oauthTests.createOAuthScopeRuntime();
		if (!runtime.oauth) throw new Error("OAuth runtime was not initialized.");
		const calls: string[] = [];
		const traces: Array<Record<string, unknown>> = [];
		const app = oauthTests.createOAuthTestApp(runtime, calls, traces);
		const grant = issueOAuthToken(
			runtime.oauth,
			approvalSecret,
			"hostspan.read hostspan.exec",
		);
		const secret = "private-validation-value-DO-NOT-RETAIN";
		try {
			for (const protocol of ["2026-07-28", "2025-11-25"]) {
				const body = await callOAuthMcpTool(
					app,
					grant.token.access_token,
					"process_start",
					{
						...oauthProcessStartArgs(false),
						idempotency_key: secret,
						wait_ms: 10_000,
						argv: [secret],
						env: { [secret]: { value: secret } },
						[secret]: secret,
					},
					protocol,
				);
				expect(body.result).toMatchObject({
					isError: true,
					structuredContent: { error: { code: "VALIDATION_FAILED" } },
				});
				expect(body.result?._meta?.["mcp/www_authenticate"]).toBeUndefined();
				const rejected = traces.find(
					(row) =>
						row.event === "validation.rejected" &&
						row.request_id === body.result?.structuredContent?.request_id,
				);
				expect(rejected).toMatchObject({
					validation_issue_count: 4,
					validation_issues: [
						{ field: "idempotency_key", code: "invalid_format" },
						{ field: "env", code: "invalid_type" },
						{ field: "wait_ms", code: "too_big" },
						{ field: "arguments", code: "unrecognized_keys" },
					],
				});
			}
			const many = await callOAuthMcpTool(
				app,
				grant.token.access_token,
				"process_start",
				{
					...oauthProcessStartArgs(false),
					env: Object.fromEntries(
						Array.from({ length: 40 }, (_, i) => [`${secret}-${i}`, null]),
					),
				},
			);
			const bounded = traces.find(
				(row) =>
					row.event === "validation.rejected" &&
					row.request_id === many.result?.structuredContent?.request_id,
			);
			expect(bounded).toMatchObject({ validation_issue_count: 40 });
			expect(bounded?.validation_issues).toHaveLength(16);
			expect(bounded?.validation_issues).toEqual(
				Array.from({ length: 16 }, () => ({
					field: "env",
					code: "invalid_type",
				})),
			);

			const union = await callOAuthMcpTool(
				app,
				grant.token.access_token,
				"computer",
				{ action: secret },
			);
			expect(traces).toContainEqual(
				expect.objectContaining({
					request_id: union.result?.structuredContent?.request_id,
					validation_issues: [{ field: "action", code: "invalid_union" }],
				}),
			);
			const budget = await callOAuthMcpTool(
				app,
				grant.token.access_token,
				"process_start",
				{
					...oauthProcessStartArgs(false),
					env: Object.fromEntries(
						Array.from({ length: 10_001 }, (_, i) => [
							`${secret}-${i}`,
							secret,
						]),
					),
				},
			);
			expect(traces).toContainEqual(
				expect.objectContaining({
					request_id: budget.result?.structuredContent?.request_id,
					validation_issue_count: 1,
					validation_issues: [
						{ field: "arguments", code: "input_budget_exceeded" },
					],
				}),
			);
			expect(
				JSON.stringify({ traces, audit: runtime.audit.recent() }),
			).not.toContain(secret);
			expect(calls).toEqual([]);
			expect(runtime.processes.active()).toEqual([]);
		} finally {
			await oauthTests.closeApp(app);
			await oauthTests.closeRuntime(runtime);
		}
	});
});
