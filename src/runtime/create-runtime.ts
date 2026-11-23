import type { DesktopComputerBackendStatus } from "./tool-handlers.js";
import { OAuthService } from "../auth/oauth-service.js";
import type { PrivateTokenStore } from "../auth/private-token.js";
import type { HostSpanAuthMode, HostSpanConfig } from "../config/schema.js";
import { defaultConfigPath } from "../config/paths.js";
import { FilePatchService } from "../files/patch.js";
import { ripgrepExecutable } from "../files/ripgrep.js";
import type {
	HostSpanToolAuthorization,
	HostSpanToolHandlers,
} from "../mcp/registry.js";
import type { HostSpanLogger } from "../observability/logger.js";
import type { PolicyEvaluator } from "../policy/evaluator.js";
import type { InteractiveSessionManager } from "../processes/interactive-session.js";
import { ProcessSupervisor } from "../processes/supervisor.js";
import type { AuditRepo } from "../state/audit-repo.js";
import type { HostSpanDatabase } from "../state/database.js";
import type { OperationsRepo } from "../state/operations-repo.js";
import type { OAuthRepo } from "../state/oauth-repo.js";
import type { ProcessesRepo } from "../state/processes-repo.js";
import type { TransactionsRepo } from "../state/transactions-repo.js";
import type { TargetRegistry } from "../targets/registry.js";
import { BoundedConcurrencyLimiter } from "./concurrency-limiter.js";
import { openRuntimeState } from "./runtime-state.js";
import { createRuntimeActivation } from "./activation.js";
import { createRuntimeToolHandlers } from "./tool-handlers.js";
import {
	cachedExecutableProbe,
	cachedNodeModuleProbe,
} from "./backend-probes.js";
import { createRetentionMaintenance } from "./retention-maintenance.js";
import { createTracedToolRunner } from "./tool-tracing.js";
export { runtimeReadiness } from "./readiness.js";

export interface HostSpanRuntime {
	config: HostSpanConfig;
	authenticationMode: HostSpanAuthMode;
	privateTokens?: PrivateTokenStore;
	configPath: string;
	db: HostSpanDatabase;
	targets: TargetRegistry;
	policy: PolicyEvaluator;
	operations: OperationsRepo;
	processes: ProcessesRepo;
	transactions: TransactionsRepo;
	audit: AuditRepo;
	logger: HostSpanLogger;
	supervisor: ProcessSupervisor;
	terminal?: InteractiveSessionManager;
	searchLimiter: BoundedConcurrencyLimiter;
	searchBackendReady(): boolean;
	terminalBackendReady(): boolean;
	/** Local daemon-control status: never an externally exposed MCP tool or audit event. */
	desktopComputerStatus(): {
		backends: { computer: DesktopComputerBackendStatus };
	};
	oauthRepo: OAuthRepo;
	oauth?: OAuthService;
	handlers: HostSpanToolHandlers;
	authorization: HostSpanToolAuthorization;
	activate(): void;
	close(): Promise<void>;
}

export function createRuntime(
	configPath = defaultConfigPath(),
	options: { deferActivation?: boolean } = {},
): HostSpanRuntime {
	const {
		resolvedConfigPath,
		config,
		authenticationMode,
		targets,
		db,
		privateTokens,
		operations,
		processes,
		computer,
		transactions,
		audit,
		oauthRepo,
		logger,
		policy,
		terminal,
		native,
	} = openRuntimeState(configPath);
	const runRetentionMaintenance = createRetentionMaintenance({
		config,
		transactions,
		processes,
		operations,
		oauthRepo,
		audit,
		logger,
	});
	const { activate, isActive, maintainRetentionSafely } =
		createRuntimeActivation({
			config,
			db,
			native,
			terminal,
			targets,
			transactions,
			operations,
			processes,
			logger,
			runRetentionMaintenance,
		});
	if (!options.deferActivation) activate();

	const patchService = new FilePatchService({
		data_dir: config.server.data_dir,
		operations,
		transactions,
		policy,
	});
	const supervisor = new ProcessSupervisor({
		config,
		targets,
		policy,
		operations,
		processes,
		native,
		...(terminal ? { terminal } : {}),
		logger,
	});
	let closing = false;
	let processMaintenanceInflight: Promise<void> | undefined;
	let closeRuntimePromise: Promise<void> | undefined;
	const processMaintenanceTimer = setInterval(() => {
		if (closing || !isActive() || processMaintenanceInflight) return;
		processMaintenanceInflight = supervisor
			.reconcileInteractiveProcesses()
			.catch((error) => {
				logger.info("process.reconcile_failed", {
					message: error instanceof Error ? error.message : String(error),
				});
			})
			.finally(() => {
				processMaintenanceInflight = undefined;
			});
	}, 500);
	processMaintenanceTimer.unref();
	const retentionMaintenanceTimer = setInterval(
		maintainRetentionSafely,
		60_000,
	);
	retentionMaintenanceTimer.unref();
	const searchLimiter = new BoundedConcurrencyLimiter({
		maxConcurrent: config.server.max_concurrent_searches ?? 8,
		maxQueued: config.server.max_queued_searches ?? 16,
		queueTimeoutMs: config.server.search_queue_timeout_ms ?? 1_000,
		resource: "file_search",
		label: "Search",
	});
	const searchBackendReady = cachedExecutableProbe(ripgrepExecutable());
	const terminalBackendReady = cachedNodeModuleProbe("node-pty");
	const oauth = config.oauth
		? new OAuthService(config.oauth, oauthRepo)
		: undefined;

	const traced = createTracedToolRunner({ audit, logger });

	const { handlers, authorization, desktopComputerStatus } =
		createRuntimeToolHandlers({
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
		});

	return {
		config,
		authenticationMode,
		...(privateTokens ? { privateTokens } : {}),
		configPath: resolvedConfigPath,
		db,
		targets,
		policy,
		operations,
		processes,
		transactions,
		audit,
		logger,
		supervisor,
		...(terminal ? { terminal } : {}),
		searchLimiter,
		searchBackendReady,
		terminalBackendReady,
		desktopComputerStatus,
		oauthRepo,
		...(oauth ? { oauth } : {}),
		handlers,
		authorization,
		activate,
		close: () => {
			if (closeRuntimePromise) return closeRuntimePromise;
			closing = true;
			computer?.dispose();
			clearInterval(processMaintenanceTimer);
			clearInterval(retentionMaintenanceTimer);
			closeRuntimePromise = (async () => {
				await processMaintenanceInflight;
				await supervisor.settleForRuntimeClose();
				if (db.open) db.close();
				privateTokens?.close();
			})();
			return closeRuntimePromise;
		},
	};
}
