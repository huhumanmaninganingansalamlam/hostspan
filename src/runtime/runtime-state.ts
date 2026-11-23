import { join, resolve } from "node:path";
import { PortalDesktop } from "../computer/portal.js";
import { PrivateTokenStore } from "../auth/private-token.js";
import {
	TerminalConfigSchema,
	resolveAuthenticationMode,
	type HostSpanConfig,
	type HostSpanAuthMode,
} from "../config/schema.js";
import { loadConfig } from "../config/loader.js";
import { oauthApprovalSecretPath } from "../config/paths.js";
import { PolicyEvaluator } from "../policy/evaluator.js";
import { HostSpanLogger } from "../observability/logger.js";
import {
	protectWindowsFile,
	protectWindowsTree,
} from "../security/windows-acl.js";
import { PtySessionManager } from "../processes/pty-session.js";
import { AuditRepo } from "../state/audit-repo.js";
import { openDatabase, type HostSpanDatabase } from "../state/database.js";
import { OperationsRepo } from "../state/operations-repo.js";
import { OAuthRepo } from "../state/oauth-repo.js";
import { ProcessesRepo } from "../state/processes-repo.js";
import { TransactionsRepo } from "../state/transactions-repo.js";
import { TargetRegistry } from "../targets/registry.js";

export interface RuntimeState {
	resolvedConfigPath: string;
	config: HostSpanConfig;
	authenticationMode: HostSpanAuthMode;
	targets: TargetRegistry;
	db: HostSpanDatabase;
	privateTokens: PrivateTokenStore | undefined;
	operations: OperationsRepo;
	processes: ProcessesRepo;
	computer: PortalDesktop | undefined;
	transactions: TransactionsRepo;
	audit: AuditRepo;
	oauthRepo: OAuthRepo;
	logger: HostSpanLogger;
	policy: PolicyEvaluator;
	terminal: PtySessionManager | undefined;
	native: PtySessionManager;
}

export function openRuntimeState(configPath: string): RuntimeState {
	const resolvedConfigPath = resolve(configPath);
	const config = loadConfig(resolvedConfigPath);
	const authenticationMode = resolveAuthenticationMode(config);
	protectWindowsFile(resolvedConfigPath);
	protectWindowsFile(`${resolvedConfigPath}.bak`);
	protectWindowsFile(oauthApprovalSecretPath(resolvedConfigPath));
	protectWindowsTree(config.server.data_dir);
	const targets = new TargetRegistry(config);
	const db = openDatabase(join(config.server.data_dir, "state.db"));
	let privateTokens: PrivateTokenStore | undefined;
	try {
		if (authenticationMode === "private_token")
			privateTokens = new PrivateTokenStore(config.server.data_dir);
	} catch (error) {
		db.close();
		throw error;
	}
	const operations = new OperationsRepo(db);
	const processes = new ProcessesRepo(db);
	const computer = config.computer
		? new PortalDesktop(operations, config.computer.backend)
		: undefined;
	const transactions = new TransactionsRepo(db);
	const audit = new AuditRepo(db, {
		maxAgeDays: config.retention.audit_days,
		maxEvents: config.retention.max_audit_events ?? 1_000,
	});
	const oauthRepo = new OAuthRepo(db);
	const logger = new HostSpanLogger(config.server.data_dir);
	const policy = new PolicyEvaluator(config, [
		resolvedConfigPath,
		`${resolvedConfigPath}.bak`,
		oauthApprovalSecretPath(resolvedConfigPath),
		join(config.server.data_dir, "private-access.db"),
	]);
	const terminal = config.terminal
		? new PtySessionManager(config.server.data_dir, config.terminal, {
				requireOwnership: true,
				configPath: resolvedConfigPath,
			})
		: undefined;
	const native = new PtySessionManager(
		config.server.data_dir,
		TerminalConfigSchema.parse({}),
		{ requireOwnership: true, backend: "native" },
	);
	return {
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
	};
}
