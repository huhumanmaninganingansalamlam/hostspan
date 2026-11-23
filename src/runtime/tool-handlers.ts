import {
	desktopBackend,
	supportedDesktopSession,
	type PortalDesktop,
} from "../computer/portal.js";
import { HostSpanError } from "../errors.js";
import { hostname } from "node:os";
import type { OAuthService } from "../auth/oauth-service.js";
import type { HostSpanConfig } from "../config/schema.js";
import { fileList } from "../files/list.js";
import { fileRead } from "../files/read.js";
import { fileSearch } from "../files/search.js";
import type { FilePatchService } from "../files/patch.js";
import { resolveTargetPath } from "../targets/path.js";
import {
	TOOL_NAMES,
	type HostSpanToolAuthorization,
	type HostSpanToolHandlers,
	type ToolCaller,
} from "../mcp/registry.js";
import type {
	FileListToolInput,
	FilePatchToolInput,
	FileReadToolInput,
	FileSearchToolInput,
	ProcessCancelToolInput,
	ProcessPollToolInput,
	ProcessListToolInput,
	ProcessStartToolInput,
	ProcessWriteToolInput,
	SystemStatusInput,
	TargetListInput,
} from "../tools/schemas.js";
import {
	auditErrorDiagnostics,
	auditRequestDiagnostics,
} from "../observability/error-diagnostics.js";
import { isQualifiedCorePlatform } from "../platform.js";
import type { PolicyEvaluator } from "../policy/evaluator.js";
import type { ProcessSupervisor } from "../processes/supervisor.js";
import type { AuditRepo } from "../state/audit-repo.js";
import {
	databaseResponsive,
	type HostSpanDatabase,
} from "../state/database.js";
import type { ProcessesRepo } from "../state/processes-repo.js";
import type { TargetRegistry } from "../targets/registry.js";
import {
	BUILD_IDENTITY,
	PROTOCOL_VERSION,
	SERVER_VERSION,
	TOOLSET_VERSION,
} from "../version.js";
import type { BoundedConcurrencyLimiter } from "./concurrency-limiter.js";
import type { createTracedToolRunner } from "./tool-tracing.js";

export interface RuntimeToolHandlerDependencies {
	config: HostSpanConfig;
	computer: PortalDesktop | undefined;
	traced: ReturnType<typeof createTracedToolRunner>;
	db: HostSpanDatabase;
	processes: ProcessesRepo;
	oauth: OAuthService | undefined;
	targets: TargetRegistry;
	policy: PolicyEvaluator;
	patchService: FilePatchService;
	supervisor: ProcessSupervisor;
	searchLimiter: BoundedConcurrencyLimiter;
	searchBackendReady(): boolean;
	terminalBackendReady(): boolean;
	audit: AuditRepo;
}

export function createRuntimeToolHandlers({
	config,
	computer,
	traced,
	db,
	processes,
	oauth,
	targets,
	policy,
	patchService,
	supervisor,
	searchLimiter,
	searchBackendReady,
	terminalBackendReady,
	audit,
}: RuntimeToolHandlerDependencies) {
	let computerSession:
		| {
				session_id: string;
				initiated_at: string;
				initiated_request_id: string;
				initiated_by: ToolCaller;
				last_request_id: string;
				last_request_at: string;
				last_action: string;
		  }
		| undefined;

	// Desktop tray status travels through the authenticated local daemon-control
	// socket. It is not a caller's MCP tool invocation and must not create
	// audit rows, append logs, or re-probe expensive backend readiness.
	const computerBackendStatus = (): Record<string, unknown> => {
		const current = computer?.status();
		return {
			name: config.computer?.backend ?? desktopBackend(),
			configured: Boolean(computer),
			...(computerSession?.session_id === current?.session_id
				? { session_activity: computerSession }
				: {}),
			project_attribution: "unavailable",
			supported_session: supportedDesktopSession(),
			scope: "daemon_desktop",
			display_selection:
				config.computer?.backend === "native"
					? "primary_display"
					: "OS_consent",
			remote_ssh_desktop: false,
			display_enumeration: false,
			...(current ?? {
				state: "disabled",
				message:
					"Desktop control is off. Use hostspan computer enable to configure it.",
			}),
		};
	};

	const desktopComputerStatus = () => ({
		backends: { computer: computerBackendStatus() },
	});

	const handlers: HostSpanToolHandlers = {
		computer: (input, requestId, caller = { caller_mode: "local" }) =>
			traced(
				"computer",
				input,
				requestId,
				async () => {
					if (!computer)
						throw new HostSpanError(
							"SCOPE_DENIED",
							"Desktop control is off. Run hostspan computer enable with the intended --config, then explicitly restart that daemon to apply it.",
						);
					const result = await computer.run(input);
					const sessionId = computer.status().session_id;
					if (typeof sessionId === "string") {
						const now = new Date().toISOString();
						if (computerSession?.session_id !== sessionId)
							computerSession = {
								session_id: sessionId,
								initiated_at: now,
								initiated_request_id: requestId,
								initiated_by: { ...caller },
								last_request_id: requestId,
								last_request_at: now,
								last_action: input.action,
							};
						else
							Object.assign(computerSession, {
								last_request_id: requestId,
								last_request_at: now,
								last_action: input.action,
							});
					} else computerSession = undefined;
					return result;
				},
				caller,
			),
		system_status: (_input: SystemStatusInput, requestId: string) =>
			traced("system_status", {}, requestId, () => {
				const searchReady = searchBackendReady();
				const terminalReady = config.terminal ? terminalBackendReady() : true;
				const processReady = isQualifiedCorePlatform();
				return {
					server_version: SERVER_VERSION,
					build: BUILD_IDENTITY,
					host: {
						hostname: hostname(),
						platform: process.platform,
						arch: process.arch,
					},
					protocol_version: PROTOCOL_VERSION,
					toolset_version: TOOLSET_VERSION,
					advertised_tools: [...TOOL_NAMES],
					backends: {
						search: { name: "ripgrep", ready: searchReady },
						database: { name: "sqlite", ready: databaseResponsive(db) },
						process: {
							name:
								process.platform === "win32"
									? "windows_process_tree"
									: "posix_process_group",
							ready: processReady,
						},
						terminal: {
							name: "hostspan_pty",
							ready: terminalReady,
							configured: Boolean(config.terminal),
						},
						computer: computerBackendStatus(),
						search_concurrency: searchLimiter.snapshot(),
					},
					active_process_count: processes.activeCount(),
					degraded: !searchReady || !terminalReady,
					oauth: oauth
						? {
								enabled: true,
								issuer: oauth.issuer,
								resource: oauth.publicMcpUrl,
							}
						: { enabled: false },
					native_execution: true,
					sandboxed: false,
				};
			}),
		target_list: (_input: TargetListInput, requestId: string) =>
			traced("target_list", {}, requestId, () => ({
				targets: targets.list().map((target) => ({
					target_id: target.target_id,
					label: target.label,
					provider: target.provider,
					capabilities: target.capabilities,
					exec_mode: target.exec_profile ? "native" : null,
					ready: target.ready,
				})),
			})),
		file_list: (input: FileListToolInput, requestId: string) =>
			traced("file_list", input, requestId, () => {
				const target = targets.get(input.target_id, "read");
				return fileList(target, input, policy);
			}),
		file_read: (input: FileReadToolInput, requestId: string) =>
			traced("file_read", input, requestId, () => {
				const target = targets.get(input.target_id, "read");
				const guarded = resolveTargetPath(target, input.path);
				policy.assertFileAllowed(
					target,
					guarded.relative,
					guarded.absolute,
					false,
				);
				return fileRead(target, input);
			}),
		file_search: (input: FileSearchToolInput, requestId: string) =>
			traced("file_search", input, requestId, () =>
				searchLimiter.run(async () => {
					const target = targets.get(input.target_id, "read");
					for (const path of input.paths.length ? input.paths : ["."]) {
						const guarded = resolveTargetPath(target, path);
						policy.assertFileAllowed(
							target,
							guarded.relative,
							guarded.absolute,
							false,
						);
					}
					return fileSearch(target, input);
				}),
			),
		file_patch: (input: FilePatchToolInput, requestId: string) =>
			traced("file_patch", input, requestId, () =>
				patchService.apply(targets.get(input.target_id, "write"), input),
			),
		process_start: (input: ProcessStartToolInput, requestId: string) =>
			traced("process_start", input, requestId, () =>
				supervisor.start(input, requestId),
			),
		process_poll: (input: ProcessPollToolInput, requestId: string) =>
			traced("process_poll", input, requestId, () => supervisor.poll(input)),
		process_list: (input: ProcessListToolInput, requestId: string) =>
			traced("process_list", input, requestId, () => {
				const target = targets.get(input.target_id, "read");
				const path = resolveTargetPath(target, input.cwd);
				policy.assertFileAllowed(target, path.relative, path.absolute, false);
				return processes.list({ ...input, cwd: path.relative });
			}),
		process_write: (input: ProcessWriteToolInput, requestId: string) =>
			traced("process_write", input, requestId, () => supervisor.write(input)),
		process_cancel: (input: ProcessCancelToolInput, requestId: string) =>
			traced("process_cancel", input, requestId, () =>
				supervisor.cancel(input),
			),
	};

	const authorization: HostSpanToolAuthorization = {
		rejected: (tool, input, requestId, error, stage, caller) => {
			audit.append({
				request_id: requestId,
				event_type: "request.aborted",
				metadata: {
					...caller,
					tool,
					stage,
					...auditErrorDiagnostics(error),
					...auditRequestDiagnostics(input),
				},
			});
		},
		processBackend: (processId) => {
			const backend = processes.get(processId)?.backend;
			return backend === "native" || backend === "pty" ? backend : undefined;
		},
	};

	return { handlers, authorization, desktopComputerStatus };
}
