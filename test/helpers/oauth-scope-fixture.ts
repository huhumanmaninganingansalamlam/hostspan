import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { v7 as uuidv7 } from "uuid";
import { expect } from "vitest";
import {
	createOAuthSetup,
	type OAuthService,
	type OAuthTokenResponse,
} from "../../src/auth/oauth-service.js";
import type { HostSpanConfig } from "../../src/config/schema.js";
import { writeConfigAtomic } from "../../src/config/writer.js";
import {
	TOOLSET_HASH,
	type HostSpanToolHandlers,
} from "../../src/mcp/registry.js";
import { createHostSpanHttpServer } from "../../src/mcp/server.js";
import {
	createRuntime,
	type HostSpanRuntime,
} from "../../src/runtime/create-runtime.js";

export const OAUTH_RESOURCE = "https://mcp.example.com/mcp";
export const OAUTH_REDIRECT = "http://127.0.0.1:44123/callback";

export interface OAuthScopeRuntimeOptions {
	computer?: boolean;
}

export interface OAuthScopeRuntimeFixture {
	runtime: HostSpanRuntime;
	approvalSecret: string;
}

export type OAuthToolCallBody = {
	result?: {
		resultType?: string;
		isError?: boolean;
		_meta?: { "mcp/www_authenticate"?: string[] };
		structuredContent?: Record<string, unknown>;
		content?: Array<{ type?: string; text?: string }>;
	};
};

function recordingOAuthHandlers(calls: string[]): HostSpanToolHandlers {
	const recordToolCall = (tool: string) => {
		calls.push(tool);
		return { tool };
	};
	return {
		computer: () => recordToolCall("computer"),
		system_status: () => recordToolCall("system_status"),
		target_list: () => recordToolCall("target_list"),
		file_list: () => recordToolCall("file_list"),
		file_read: () => recordToolCall("file_read"),
		file_search: () => recordToolCall("file_search"),
		file_patch: () => recordToolCall("file_patch"),
		process_start: () => recordToolCall("process_start"),
		process_poll: () => recordToolCall("process_poll"),
		process_list: () => recordToolCall("process_list"),
		process_write: () => recordToolCall("process_write"),
		process_cancel: () => recordToolCall("process_cancel"),
	};
}

/** Owns OAuth test runtimes, Fastify apps, and temporary profile roots for one test file. */
export class OAuthScopeTestContext {
	readonly #roots: string[] = [];
	readonly #runtimes = new Set<HostSpanRuntime>();
	readonly #apps = new Set<FastifyInstance>();

	createOAuthScopeRuntime(
		options: OAuthScopeRuntimeOptions = {},
	): OAuthScopeRuntimeFixture {
		const root = mkdtempSync(join(tmpdir(), "hostspan-oauth-scopes-"));
		this.#roots.push(root);
		const targetRoot = join(root, "repo");
		mkdirSync(targetRoot, { recursive: true });
		const oauthSetup = createOAuthSetup(OAUTH_RESOURCE);
		const configPath = join(root, "config.yaml");
		const config: HostSpanConfig = {
			schema_version: 1,
			policy_epoch: 5,
			server: {
				listen_host: "127.0.0.1",
				listen_port: 39393,
				allowed_hosts: ["127.0.0.1", "mcp.example.com"],
				data_dir: join(root, "state"),
			},
			retention: {
				completed_process_output_ttl_minutes: 60,
				operation_result_days: 14,
				audit_days: 30,
				max_total_spool_bytes: 16 * 1024 * 1024,
			},
			oauth: oauthSetup.config,
			targets: {
				test: {
					label: "OAuth scope test",
					provider: "local",
					root: targetRoot,
					capabilities: ["read"],
					deny_globs: [],
					ignore_globs: [],
				},
			},
			exec_profiles: {},
			...(options.computer
				? { computer: { backend: "wayland-portal" as const } }
				: {}),
		};
		writeConfigAtomic(configPath, config);
		const runtime = createRuntime(configPath);
		this.#runtimes.add(runtime);
		if (!runtime.oauth) throw new Error("OAuth runtime was not initialized.");
		return { runtime, approvalSecret: oauthSetup.approval_secret };
	}

	createOAuthTestApp(
		runtime: HostSpanRuntime,
		calls: string[],
		traces?: Array<Record<string, unknown>>,
		overrides: Partial<HostSpanToolHandlers> = {},
	): FastifyInstance {
		const oauth = runtime.oauth;
		if (!oauth) throw new Error("OAuth runtime was not initialized.");
		const backends = new Map<string, "native" | "pty">([
			["native-proc", "native"],
			["pty-proc", "pty"],
		]);
		const app = createHostSpanHttpServer({
			listen_host: "127.0.0.1",
			listen_port: 0,
			allowed_hosts: ["127.0.0.1", "mcp.example.com"],
			oauth,
			authorization: {
				...runtime.authorization,
				processBackend: (processId) => backends.get(processId),
			},
			handlers: { ...recordingOAuthHandlers(calls), ...overrides },
			responseContext: () => ({
				toolset_hash: TOOLSET_HASH,
				policy_epoch: runtime.config.policy_epoch,
			}),
			status: {
				health: () => ({ server_version: "test" }),
				readiness: () => ({ ready: true }),
			},
			...(traces
				? {
						trace: (event: string, metadata: Record<string, unknown>) =>
							traces.push({ event, ...metadata }),
					}
				: {}),
		});
		this.#apps.add(app);
		return app;
	}

	async closeApp(app: FastifyInstance): Promise<void> {
		if (!this.#apps.delete(app)) return;
		await app.close();
	}

	async closeRuntime(runtime: HostSpanRuntime): Promise<void> {
		if (!this.#runtimes.delete(runtime)) return;
		await runtime.close();
	}

	async dispose(): Promise<void> {
		let cleanupError: unknown;
		for (const app of [...this.#apps].reverse()) {
			try {
				await this.closeApp(app);
			} catch (error) {
				cleanupError ??= error;
			}
		}
		for (const runtime of [...this.#runtimes].reverse()) {
			try {
				await this.closeRuntime(runtime);
			} catch (error) {
				cleanupError ??= error;
			}
		}
		for (const root of this.#roots.splice(0)) {
			try {
				rmSync(root, { recursive: true, force: true });
			} catch (error) {
				cleanupError ??= error;
			}
		}
		if (cleanupError) throw cleanupError;
	}
}

export function issueOAuthToken(
	oauth: OAuthService,
	approvalSecret: string,
	scope?: string,
	existingClientId?: string,
): { clientId: string; token: OAuthTokenResponse } {
	const client = existingClientId
		? { client_id: existingClientId }
		: oauth.registerClient({
				client_name: "scope-test",
				application_type: "native",
				redirect_uris: [OAUTH_REDIRECT],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
			});
	const verifier = `scope-test-verifier-${"x".repeat(48)}`;
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const params = new URLSearchParams({
		response_type: "code",
		client_id: client.client_id,
		redirect_uri: OAUTH_REDIRECT,
		code_challenge: challenge,
		code_challenge_method: "S256",
		resource: OAUTH_RESOURCE,
	});
	if (scope !== undefined) params.set("scope", scope);
	const prompt = oauth.beginAuthorization(params);
	const redirect = new URL(
		oauth.approveAuthorization(prompt.request_id, approvalSecret),
	);
	const code = redirect.searchParams.get("code");
	if (!code) throw new Error("OAuth authorization did not return a code.");
	const token = oauth.exchangeToken(
		new URLSearchParams({
			grant_type: "authorization_code",
			code,
			client_id: client.client_id,
			redirect_uri: OAUTH_REDIRECT,
			code_verifier: verifier,
			resource: OAUTH_RESOURCE,
		}),
	);
	return { clientId: client.client_id, token };
}

export function refreshOAuthToken(
	oauth: OAuthService,
	clientId: string,
	refreshTokenValue: string,
	scope?: string,
): OAuthTokenResponse {
	const form = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: refreshTokenValue,
		client_id: clientId,
		resource: OAUTH_RESOURCE,
	});
	if (scope !== undefined) form.set("scope", scope);
	return oauth.exchangeToken(form);
}

export function modernOAuthMeta() {
	return {
		"io.modelcontextprotocol/protocolVersion": "2026-07-28",
		"io.modelcontextprotocol/clientInfo": {
			name: "oauth-scope-test",
			version: "1.0.0",
		},
		"io.modelcontextprotocol/clientCapabilities": {},
	};
}

export async function callOAuthMcpTool(
	app: FastifyInstance,
	token: string,
	name: string,
	args: Record<string, unknown>,
	protocolVersion = "2026-07-28",
): Promise<OAuthToolCallBody> {
	const response = await app.inject({
		method: "POST",
		url: "/mcp",
		headers: {
			host: "mcp.example.com",
			authorization: `Bearer ${token}`,
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
			"mcp-method": "tools/call",
			"mcp-name": name,
			"mcp-protocol-version": protocolVersion,
		},
		payload: {
			jsonrpc: "2.0",
			id: `call-${name}-${uuidv7()}`,
			method: "tools/call",
			params: {
				name,
				arguments: args,
				...(protocolVersion === "2026-07-28"
					? { _meta: modernOAuthMeta() }
					: {}),
			},
		},
	});
	expect(response.statusCode, response.body).toBe(200);
	expect(response.headers["www-authenticate"]).toBeUndefined();
	return response.json() as OAuthToolCallBody;
}

export function expectOAuthToolAllowed(
	body: OAuthToolCallBody,
	tool: string,
): void {
	expect(body.result?.isError).not.toBe(true);
	expect(body.result?.structuredContent).toMatchObject({ tool });
}

export function expectOAuthScopeDenied(
	body: OAuthToolCallBody,
	requiredScope?: string,
): void {
	expect(body.result?.isError).toBe(true);
	const text = body.result?.content?.[0]?.text;
	if (!text)
		throw new Error("scope denial did not include HostSpan error content");
	const payload = (body.result?.structuredContent ?? JSON.parse(text)) as {
		error?: { code?: string; details?: Record<string, unknown> };
	};
	expect(payload.error?.code).toBe("SCOPE_DENIED");
	expect(payload.error?.details).toMatchObject({ reason: "oauth_scope" });
	if (requiredScope)
		expect(payload.error?.details?.required_scope).toBe(requiredScope);
}

export const oauthPatchArgs = () => ({
	idempotency_key: uuidv7(),
	target_id: "test",
	files: [
		{
			path: "x.txt",
			expected_sha256: "0".repeat(64),
			unified_diff: "--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-a\n+b\n",
		},
	],
});

export const oauthProcessStartArgs = (tty: boolean) => ({
	idempotency_key: uuidv7(),
	target_id: "test",
	argv: ["node", "-e", "process.exit(0)"],
	cwd: ".",
	env: {},
	wait_ms: 0,
	deadline_ms: 1_000,
	max_output_bytes: 1_024,
	tty,
});
