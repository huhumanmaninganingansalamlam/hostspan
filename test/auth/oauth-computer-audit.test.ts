import { afterEach, describe, expect, it, vi } from "vitest";
import { v7 as uuidv7 } from "uuid";
import {
	ComputerInputSchema,
	PortalDesktop,
} from "../../src/computer/portal.js";
import { HostSpanError } from "../../src/errors.js";
import { TOOLSET_HASH } from "../../src/mcp/registry.js";
import { createHostSpanHttpServer } from "../../src/mcp/server.js";
import {
	OAuthScopeTestContext,
	issueOAuthToken,
	callOAuthMcpTool,
} from "../helpers/oauth-scope-fixture.js";

const oauthTests = new OAuthScopeTestContext();

afterEach(async () => {
	await oauthTests.dispose();
});

describe("OAuth computer audit attribution", () => {
	it("correlates verified GUI callers, screen and coordinates in existing audit across delivery, replay and rejection", async () => {
		const { runtime, approvalSecret } = oauthTests.createOAuthScopeRuntime({
			computer: true,
		});
		const oauth = runtime.oauth;
		if (!oauth) throw new Error("OAuth runtime was not initialized.");
		const app = createHostSpanHttpServer({
			listen_host: "127.0.0.1",
			listen_port: 0,
			allowed_hosts: ["127.0.0.1", "mcp.example.com"],
			oauth: oauth,
			handlers: runtime.handlers,
			authorization: runtime.authorization,
			responseContext: () => ({ toolset_hash: TOOLSET_HASH, policy_epoch: 5 }),
			status: { health: () => ({}), readiness: () => ({ ready: true }) },
		});
		const session_id = uuidv7();
		const observation_id = uuidv7();
		const secret = "HOSTSPAN_SECRET_CANARY_GUI";
		const desktop = vi
			.spyOn(PortalDesktop.prototype, "run")
			.mockImplementation(async (raw) => {
				const input = ComputerInputSchema.parse(raw);
				if (input.action === "observe")
					throw new HostSpanError("SCOPE_DENIED", "Sharing ended");
				return {
					state: "completed",
					session_id,
					observation_id: uuidv7(),
					desktop_backend: "wayland-portal",
					desktop_scope: "monitor",
					pipewire_node_id: 73,
					window_attribution: "unavailable",
					coordinate_width: 1680,
					coordinate_height: 1050,
					dispatched: true,
					outcome_verified: false,
					...(input.action === "text" ? { replayed: true } : {}),
					image: Buffer.from(secret).toString("base64"),
					mime_type: "image/png",
					window_title: secret,
				};
			});
		try {
			const first = issueOAuthToken(oauth, approvalSecret, "hostspan.computer");
			const second = issueOAuthToken(
				oauth,
				approvalSecret,
				"hostspan.computer",
			);
			const read = issueOAuthToken(oauth, approvalSecret, "hostspan.read");
			const click = {
				action: "click",
				session_id,
				observation_id,
				x: 512,
				y: 310,
				idempotency_key: uuidv7(),
			};
			const delivered = await callOAuthMcpTool(
				app,
				first.token.access_token,
				"computer",
				click,
			);
			expect(delivered).toMatchObject({
				result: { structuredContent: { dispatched: true } },
			});
			const replay = await callOAuthMcpTool(
				app,
				second.token.access_token,
				"computer",
				{
					action: "text",
					session_id,
					observation_id,
					text: secret,
					idempotency_key: uuidv7(),
				},
			);
			const failed = await callOAuthMcpTool(
				app,
				first.token.access_token,
				"computer",
				{ action: "observe", session_id },
			);
			const denied = await callOAuthMcpTool(
				app,
				read.token.access_token,
				"computer",
				click,
			);
			const invalid = await callOAuthMcpTool(
				app,
				first.token.access_token,
				"computer",
				{ ...click, x: -1 },
			);
			const events = runtime.audit.recent();
			const event = (response: typeof delivered, type: string) =>
				events.find(
					(row) =>
						row.request_id === response.result?.structuredContent?.request_id &&
						row.event_type === type,
				);
			expect(event(delivered, "request.accepted")).toMatchObject({
				metadata: {
					caller_mode: "oauth",
					oauth_client_id: first.clientId,
					action: "click",
					session_id,
					observation_id,
					x: 512,
					y: 310,
					button: "left",
				},
			});
			expect(event(delivered, "response.returned")).toMatchObject({
				metadata: {
					caller_mode: "oauth",
					oauth_client_id: first.clientId,
					session_id,
					pipewire_node_id: 73,
					desktop_scope: "monitor",
					window_attribution: "unavailable",
					dispatched: true,
					outcome_verified: false,
				},
			});
			expect(event(replay, "response.returned")).toMatchObject({
				metadata: {
					oauth_client_id: second.clientId,
					session_id,
					replayed: true,
					outcome_verified: false,
				},
			});
			expect(event(replay, "request.accepted")).toMatchObject({
				metadata: { text_bytes: Buffer.byteLength(secret) },
			});
			expect(event(failed, "request.aborted")).toMatchObject({
				metadata: {
					oauth_client_id: first.clientId,
					session_id,
					stage: "handler",
					error_code: "SCOPE_DENIED",
				},
			});
			expect(event(denied, "request.aborted")).toMatchObject({
				metadata: {
					oauth_client_id: read.clientId,
					stage: "authorization",
					error_reason: "oauth_scope",
				},
			});
			expect(event(invalid, "request.aborted")).toMatchObject({
				metadata: {
					oauth_client_id: first.clientId,
					stage: "validation",
					error_code: "VALIDATION_FAILED",
				},
			});
			expect(desktop).toHaveBeenCalledTimes(3);
			const serialized = JSON.stringify(events);
			for (const value of [
				secret,
				Buffer.from(secret).toString("base64"),
				first.token.access_token,
				second.token.access_token,
				first.token.refresh_token,
				approvalSecret,
			]) {
				expect(serialized).not.toContain(value);
			}
			await runtime.handlers.computer({ action: "open" }, "local-gui-call");
			expect(
				runtime.audit
					.recent()
					.find((row) => row.request_id === "local-gui-call"),
			).toMatchObject({ metadata: { caller_mode: "local" } });
		} finally {
			desktop.mockRestore();
			await oauthTests.closeApp(app);
			await oauthTests.closeRuntime(runtime);
		}
	});
});
