import {
	daemonStatus,
	removeDaemonPid,
	startDaemonControlServer,
	writeDaemonPid,
} from "../../daemon/control.js";
import { createHostSpanHttpServer } from "../../mcp/server.js";
import { errorResult, requestId, successResult } from "../../mcp/result.js";
import { toolsetHash } from "../../mcp/registry.js";
import {
	createRuntime,
	runtimeReadiness,
} from "../../runtime/create-runtime.js";
import { BUILD_IDENTITY, SERVER_VERSION } from "../../version.js";
import {
	cliValidationError,
	type CliCommandContext,
	writeJsonResult,
} from "../context.js";

function isLoopbackHost(host: string): boolean {
	return ["127.0.0.1", "localhost", "::1"].includes(host.toLowerCase());
}

export async function runServeCommand(
	commandContext: CliCommandContext,
): Promise<number> {
	const { configPath } = commandContext;
	const existingDaemon = daemonStatus(configPath);
	if (existingDaemon.running && existingDaemon.pid !== process.pid) {
		throw cliValidationError(
			`HostSpan is already running with pid ${existingDaemon.pid}.`,
		);
	}

	const runtime = createRuntime(configPath, { deferActivation: true });
	if (
		!isLoopbackHost(runtime.config.server.listen_host) &&
		runtime.authenticationMode === "none"
	) {
		await runtime.close();
		throw cliValidationError(
			"Non-loopback listen_host requires OAuth or an explicitly configured private_token mode.",
		);
	}

	const app = createHostSpanHttpServer({
		listen_host: runtime.config.server.listen_host,
		listen_port: runtime.config.server.listen_port,
		...(runtime.config.server.allowed_hosts
			? { allowed_hosts: runtime.config.server.allowed_hosts }
			: {}),
		max_inflight_mcp_requests:
			runtime.config.server.max_inflight_mcp_requests ?? 128,
		authenticationMode: runtime.authenticationMode,
		...(runtime.config.authentication?.protected_transport
			? {
					protected_transport:
						runtime.config.authentication.protected_transport,
				}
			: {}),
		...(runtime.privateTokens ? { privateTokens: runtime.privateTokens } : {}),
		...(runtime.oauth ? { oauth: runtime.oauth } : {}),
		authorization: runtime.authorization,
		handlers: runtime.handlers,
		responseContext: () => ({
			toolset_hash: toolsetHash(runtime.authenticationMode),
			policy_epoch: runtime.config.policy_epoch,
		}),
		status: {
			// This unauthenticated endpoint exposes an opaque correlation ID, not Git internals.
			health: () => ({
				server_version: SERVER_VERSION,
				build_id: BUILD_IDENTITY.build_id,
			}),
			readiness: () => runtimeReadiness(runtime),
		},
		trace: (event, metadata) => runtime.logger.info(event, metadata),
	});

	let address: string;
	try {
		address = await app.listen({
			host: runtime.config.server.listen_host,
			port: runtime.config.server.listen_port,
		});
	} catch (error) {
		await app.close().catch(() => undefined);
		await runtime.close();
		throw error;
	}

	let requestShutdown!: () => void;
	const shutdownRequested = new Promise<void>((resolveShutdown) => {
		requestShutdown = resolveShutdown;
	});
	const control = await (async () => {
		let started:
			| Awaited<ReturnType<typeof startDaemonControlServer>>
			| undefined;
		try {
			started = await startDaemonControlServer(
				configPath,
				requestShutdown,
				async (input) => {
					const id = requestId();
					const responseContext = {
						toolset_hash: toolsetHash(runtime.authenticationMode),
						policy_epoch: runtime.config.policy_epoch,
					};
					try {
						const result =
							input.action === "status"
								? runtime.desktopComputerStatus()
								: await runtime.handlers.computer(input, id, {
										caller_mode: "local",
									});
						return successResult(responseContext, result, id, true);
					} catch (error) {
						return errorResult(responseContext, error, id, true);
					}
				},
				async (input) => {
					const id = requestId();
					return {
						request_id: id,
						...(await runtime.handlers.process_poll(input, id)),
					};
				},
				async (input) => {
					const id = requestId();
					return {
						request_id: id,
						...(await runtime.handlers.process_list(input, id)),
					};
				},
			);
			runtime.activate();
			return started;
		} catch (error) {
			await started?.close();
			await app.close().catch(() => undefined);
			await runtime.close();
			throw error;
		}
	})();

	const shutdown = async () => {
		try {
			await runtime.supervisor.shutdown();
			await app.close();
			await runtime.close();
		} finally {
			await control.close();
			removeDaemonPid(configPath);
		}
	};

	writeDaemonPid(configPath);
	writeJsonResult(commandContext.stdout, {
		ok: true,
		address,
		mcp: `${address}/mcp`,
		listen_host: runtime.config.server.listen_host,
		allowed_hosts: runtime.config.server.allowed_hosts ?? [],
		authentication_mode: runtime.authenticationMode,
		oauth: runtime.oauth
			? {
					enabled: true,
					public_mcp_url: runtime.oauth.publicMcpUrl,
					issuer: runtime.oauth.issuer,
				}
			: { enabled: false },
		native_execution: true,
		sandboxed: false,
	});

	const onSignal = () => requestShutdown();
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	await shutdownRequested;
	process.off("SIGINT", onSignal);
	process.off("SIGTERM", onSignal);
	await shutdown();
	return 0;
}
