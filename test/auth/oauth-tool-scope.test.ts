import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import type { OAuthTokenResponse } from "../../src/auth/oauth-service.js";
import { HostSpanError } from "../../src/errors.js";
import { errorResult } from "../../src/mcp/result.js";
import { TOOL_NAMES, TOOLSET_HASH } from "../../src/mcp/registry.js";
import {
	OAuthScopeTestContext,
	OAUTH_RESOURCE,
	OAUTH_REDIRECT,
	issueOAuthToken,
	refreshOAuthToken,
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

describe("OAuth tool scope boundaries", () => {
	it("defaults new grants to read and only allows refresh to preserve or narrow authority", async () => {
		const { runtime, approvalSecret } = oauthTests.createOAuthScopeRuntime();
		const oauth = runtime.oauth;
		if (!oauth) throw new Error("OAuth runtime was not initialized.");
		try {
			expect(oauth.authorizationServerMetadata()).toMatchObject({
				scopes_supported: [
					"hostspan.computer",
					"hostspan.read",
					"hostspan.write",
					"hostspan.exec",
					"hostspan.terminal",
				],
			});
			expect(oauth.protectedResourceMetadata()).toMatchObject({
				scopes_supported: [
					"hostspan.computer",
					"hostspan.read",
					"hostspan.write",
					"hostspan.exec",
					"hostspan.terminal",
				],
			});

			const defaultGrant = issueOAuthToken(oauth, approvalSecret);
			expect(defaultGrant.token.scope).toBe("hostspan.read");
			expect(() =>
				refreshOAuthToken(
					oauth,
					defaultGrant.clientId,
					defaultGrant.token.refresh_token,
					"hostspan.read hostspan.exec",
				),
			).toThrowError(expect.objectContaining({ code: "invalid_scope" }));

			const combined = issueOAuthToken(
				oauth,
				approvalSecret,
				"hostspan.read hostspan.write",
			);
			const narrowed = refreshOAuthToken(
				oauth,
				combined.clientId,
				combined.token.refresh_token,
				"hostspan.read",
			);
			expect(narrowed.scope).toBe("hostspan.read");

			expect(() =>
				issueOAuthToken(oauth, approvalSecret, "hostspan"),
			).toThrowError(
				expect.objectContaining({
					redirect: expect.stringContaining("error=invalid_scope"),
				}),
			);

			const granular = issueOAuthToken(oauth, approvalSecret, "hostspan.read");
			expect(() =>
				refreshOAuthToken(
					oauth,
					granular.clientId,
					granular.token.refresh_token,
					"hostspan",
				),
			).toThrowError(expect.objectContaining({ code: "invalid_scope" }));

			const oldRefresh = "hs_refresh_legacy_scope";
			const now = Math.floor(Date.now() / 1000);
			runtime.oauthRepo.saveRefreshToken({
				token_hash: createHash("sha256").update(oldRefresh).digest("hex"),
				client_id: granular.clientId,
				scope: "hostspan",
				resource: OAUTH_RESOURCE,
				expires_at: now + 3600,
				revoked_at: null,
			});
			expect(() =>
				refreshOAuthToken(oauth, granular.clientId, oldRefresh),
			).toThrowError(expect.objectContaining({ code: "invalid_scope" }));

			const oldCode = "hs_code_legacy_scope";
			const verifier = "legacy-code-verifier";
			runtime.oauthRepo.saveAuthorizationCode({
				code_hash: createHash("sha256").update(oldCode).digest("hex"),
				client_id: granular.clientId,
				redirect_uri: OAUTH_REDIRECT,
				scope: "hostspan",
				code_challenge: createHash("sha256")
					.update(verifier)
					.digest("base64url"),
				resource: OAUTH_RESOURCE,
				expires_at: now + 300,
				used_at: null,
			});
			expect(() =>
				oauth.exchangeToken(
					new URLSearchParams({
						grant_type: "authorization_code",
						code: oldCode,
						client_id: granular.clientId,
						redirect_uri: OAUTH_REDIRECT,
						code_verifier: verifier,
						resource: OAUTH_RESOURCE,
					}),
				),
			).toThrowError(expect.objectContaining({ code: "invalid_scope" }));
		} finally {
			await oauthTests.closeRuntime(runtime);
		}
	});

	it("keeps the fixed tool list while separating read and write authority", async () => {
		const { runtime, approvalSecret } = oauthTests.createOAuthScopeRuntime();
		const oauth = runtime.oauth;
		if (!oauth) throw new Error("OAuth runtime was not initialized.");
		const calls: string[] = [];
		const app = oauthTests.createOAuthTestApp(runtime, calls);
		try {
			const readGrant = issueOAuthToken(oauth, approvalSecret, "hostspan.read");
			const read = readGrant.token;
			const write = issueOAuthToken(
				oauth,
				approvalSecret,
				"hostspan.write",
			).token;

			const listed = await app.inject({
				method: "POST",
				url: "/mcp",
				headers: {
					host: "mcp.example.com",
					authorization: `Bearer ${read.access_token}`,
					accept: "application/json, text/event-stream",
					"content-type": "application/json",
					"mcp-method": "tools/list",
					"mcp-protocol-version": "2026-07-28",
				},
				payload: {
					jsonrpc: "2.0",
					id: "list",
					method: "tools/list",
					params: { _meta: modernOAuthMeta() },
				},
			});
			const listedBody = listed.json() as {
				result?: {
					tools?: Array<{
						name: string;
						_meta?: { securitySchemes?: unknown };
					}>;
				};
			};
			expect(listedBody.result?.tools?.map((tool) => tool.name)).toEqual(
				TOOL_NAMES,
			);
			expect(
				listedBody.result?.tools?.find((tool) => tool.name === "computer")
					?._meta?.securitySchemes,
			).toEqual([{ type: "oauth2", scopes: ["hostspan.computer"] }]);

			expectOAuthToolAllowed(
				await callOAuthMcpTool(app, read.access_token, "system_status", {}),
				"system_status",
			);
			expectOAuthToolAllowed(
				await callOAuthMcpTool(app, read.access_token, "process_list", {
					target_id: "test",
				}),
				"process_list",
			);
			expectOAuthScopeDenied(
				await callOAuthMcpTool(
					app,
					read.access_token,
					"file_patch",
					oauthPatchArgs(),
				),
				"hostspan.write",
			);
			expect(calls).not.toContain("file_patch");
			expect(runtime.audit.recent()).toContainEqual(
				expect.objectContaining({
					process_id: null,
					metadata: expect.objectContaining({
						tool: "file_patch",
						stage: "authorization",
						error_reason: "oauth_scope",
						error_required_scopes: ["hostspan.write"],
						error_granted_scopes: ["hostspan.read"],
					}),
				}),
			);
			const deniedDesktop = await callOAuthMcpTool(
				app,
				read.access_token,
				"computer",
				{ action: "open" },
			);
			expectOAuthScopeDenied(deniedDesktop, "hostspan.computer");
			const challenges = deniedDesktop.result?._meta?.["mcp/www_authenticate"];
			expect(challenges).toHaveLength(1);
			expect(challenges?.[0]).toContain('error="insufficient_scope"');
			expect(challenges?.[0]).toContain(
				'error_description="Additional HostSpan authorization is required."',
			);
			expect(challenges?.[0]).toContain(
				'scope="hostspan.read hostspan.computer"',
			);
			expect(challenges?.[0]).toContain(
				'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
			);
			expect(calls).not.toContain("computer");
			const policyDenied = errorResult(
				{ toolset_hash: TOOLSET_HASH, policy_epoch: 5 },
				new HostSpanError("SCOPE_DENIED", "Desktop control is off."),
			);
			expect(policyDenied.isError).toBe(true);
			expect(policyDenied._meta).toBeUndefined();
			const desktop = issueOAuthToken(
				oauth,
				approvalSecret,
				"hostspan.read hostspan.computer",
				readGrant.clientId,
			).token;
			expect(oauth.verifyAccessToken(read.access_token)?.scopes).toEqual([
				"hostspan.read",
			]);
			expect(oauth.verifyAccessToken(desktop.access_token)?.scopes).toEqual([
				"hostspan.read",
				"hostspan.computer",
			]);
			expectOAuthToolAllowed(
				await callOAuthMcpTool(app, desktop.access_token, "computer", {
					action: "open",
				}),
				"computer",
			);

			// Reauthorization must preserve execution scopes, including through normal refresh.
			const previous = issueOAuthToken(
				oauth,
				approvalSecret,
				"hostspan.read hostspan.write hostspan.exec hostspan.terminal",
				readGrant.clientId,
			).token;
			const needsComputer = await callOAuthMcpTool(
				app,
				previous.access_token,
				"computer",
				{ action: "open" },
			);
			const requestedScope = /scope="([^"]+)"/.exec(
				needsComputer.result?._meta?.["mcp/www_authenticate"]?.[0] ?? "",
			)?.[1];
			expect(requestedScope?.split(" ")).toEqual([
				"hostspan.read",
				"hostspan.write",
				"hostspan.exec",
				"hostspan.terminal",
				"hostspan.computer",
			]);
			const consented = issueOAuthToken(
				oauth,
				approvalSecret,
				requestedScope,
				readGrant.clientId,
			).token;
			const refreshed = await app.inject({
				method: "POST",
				url: "/token",
				headers: {
					host: "mcp.example.com",
					"content-type": "application/x-www-form-urlencoded",
				},
				payload: new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: consented.refresh_token,
					client_id: readGrant.clientId,
				}).toString(),
			});
			expect(refreshed.statusCode).toBe(200);
			const renewed = refreshed.json() as OAuthTokenResponse;
			expect(renewed.scope).toBe(requestedScope);
			for (const token of [consented, renewed]) {
				expectOAuthToolAllowed(
					await callOAuthMcpTool(app, token.access_token, "computer", {
						action: "open",
					}),
					"computer",
				);
				expectOAuthToolAllowed(
					await callOAuthMcpTool(
						app,
						token.access_token,
						"process_start",
						oauthProcessStartArgs(false),
					),
					"process_start",
				);
			}

			expectOAuthToolAllowed(
				await callOAuthMcpTool(
					app,
					write.access_token,
					"file_patch",
					oauthPatchArgs(),
				),
				"file_patch",
			);
			expectOAuthScopeDenied(
				await callOAuthMcpTool(app, write.access_token, "file_read", {
					target_id: "test",
					path: "x.txt",
				}),
				"hostspan.read",
			);

			const oldAccess = "hs_access_legacy_scope";
			runtime.oauthRepo.saveAccessToken({
				token_hash: createHash("sha256").update(oldAccess).digest("hex"),
				client_id: readGrant.clientId,
				scope: "hostspan",
				resource: OAUTH_RESOURCE,
				expires_at: Math.floor(Date.now() / 1000) + 300,
				revoked_at: null,
			});
			expectOAuthScopeDenied(
				await callOAuthMcpTool(app, oldAccess, "system_status", {}),
				"hostspan.read",
			);
			expectOAuthScopeDenied(
				await callOAuthMcpTool(app, oldAccess, "file_patch", oauthPatchArgs()),
				"hostspan.write",
			);
		} finally {
			await oauthTests.closeApp(app);
			await oauthTests.closeRuntime(runtime);
		}
	});

	it("separates exec and terminal process authority including cancellation", async () => {
		const { runtime, approvalSecret } = oauthTests.createOAuthScopeRuntime();
		const oauth = runtime.oauth;
		if (!oauth) throw new Error("OAuth runtime was not initialized.");
		const calls: string[] = [];
		const app = oauthTests.createOAuthTestApp(runtime, calls);
		try {
			const exec = issueOAuthToken(
				oauth,
				approvalSecret,
				"hostspan.exec",
			).token;
			const terminal = issueOAuthToken(
				oauth,
				approvalSecret,
				"hostspan.terminal",
			).token;

			expectOAuthToolAllowed(
				await callOAuthMcpTool(
					app,
					exec.access_token,
					"process_start",
					oauthProcessStartArgs(false),
				),
				"process_start",
			);
			expectOAuthScopeDenied(
				await callOAuthMcpTool(
					app,
					exec.access_token,
					"process_start",
					oauthProcessStartArgs(true),
				),
				"hostspan.terminal",
			);
			expectOAuthToolAllowed(
				await callOAuthMcpTool(app, exec.access_token, "process_cancel", {
					idempotency_key: uuidv7(),
					process_id: "native-proc",
					grace_ms: 0,
				}),
				"process_cancel",
			);
			expectOAuthScopeDenied(
				await callOAuthMcpTool(app, exec.access_token, "process_cancel", {
					idempotency_key: uuidv7(),
					process_id: "pty-proc",
					grace_ms: 0,
				}),
				"hostspan.terminal",
			);

			expectOAuthToolAllowed(
				await callOAuthMcpTool(
					app,
					terminal.access_token,
					"process_start",
					oauthProcessStartArgs(true),
				),
				"process_start",
			);
			expectOAuthScopeDenied(
				await callOAuthMcpTool(
					app,
					terminal.access_token,
					"process_start",
					oauthProcessStartArgs(false),
				),
				"hostspan.exec",
			);
			expectOAuthToolAllowed(
				await callOAuthMcpTool(app, terminal.access_token, "process_write", {
					idempotency_key: uuidv7(),
					process_id: "pty-proc",
					chars: "x",
					control_keys: [],
				}),
				"process_write",
			);
			expectOAuthToolAllowed(
				await callOAuthMcpTool(app, terminal.access_token, "process_cancel", {
					idempotency_key: uuidv7(),
					process_id: "pty-proc",
					grace_ms: 0,
				}),
				"process_cancel",
			);
			expectOAuthScopeDenied(
				await callOAuthMcpTool(app, terminal.access_token, "process_cancel", {
					idempotency_key: uuidv7(),
					process_id: "native-proc",
					grace_ms: 0,
				}),
				"hostspan.exec",
			);
		} finally {
			await oauthTests.closeApp(app);
			await oauthTests.closeRuntime(runtime);
		}
	});
});
