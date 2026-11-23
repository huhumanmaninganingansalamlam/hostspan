import {
	cleanupTerminalPatchJournals,
	recoverPatchTransactions,
} from "../files/patch.js";
import { recoverProcesses } from "../processes/recovery.js";
import {
	claimRuntimeGeneration,
	syncTargetSnapshots,
	type HostSpanDatabase,
} from "../state/database.js";
import {
	targetConfigDigest,
	type TargetRegistry,
} from "../targets/registry.js";
import type { PtySessionManager } from "../processes/pty-session.js";
import type { HostSpanConfig } from "../config/schema.js";
import type { OperationsRepo } from "../state/operations-repo.js";
import type { ProcessesRepo } from "../state/processes-repo.js";
import type { TransactionsRepo } from "../state/transactions-repo.js";
import type { HostSpanLogger } from "../observability/logger.js";

export function createRuntimeActivation({
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
}: {
	config: HostSpanConfig;
	db: HostSpanDatabase;
	native: PtySessionManager;
	terminal: PtySessionManager | undefined;
	targets: TargetRegistry;
	transactions: TransactionsRepo;
	operations: OperationsRepo;
	processes: ProcessesRepo;
	logger: HostSpanLogger;
	runRetentionMaintenance(): void;
}) {
	let runtimeActive = false;
	const maintainRetentionSafely = () => {
		if (!runtimeActive) return;
		try {
			runRetentionMaintenance();
		} catch (error) {
			logger.info("retention.maintenance_failed", {
				message: error instanceof Error ? error.message : String(error),
			});
		}
	};
	const activate = (): void => {
		if (runtimeActive) return;
		const generation = claimRuntimeGeneration(db);
		native.activateOwnership(generation);
		terminal?.activateOwnership(generation);
		recoverPatchTransactions(targets, transactions);
		const removedPatchJournals = cleanupTerminalPatchJournals(transactions);
		if (removedPatchJournals.length)
			logger.info("patch.journals_cleaned", {
				count: removedPatchJournals.length,
			});
		syncTargetSnapshots(
			db,
			targets.list().map((target) => ({
				target_id: target.target_id,
				config_digest: targetConfigDigest(config.targets[target.target_id]),
				policy_epoch: config.policy_epoch,
				provider: target.provider,
				root_fingerprint: targets.fingerprint(target),
				ready: target.ready,
			})),
		);

		const recoveredProcesses = recoverProcesses(
			processes,
			operations,
			terminal,
			config.retention.completed_process_output_ttl_minutes,
			native,
		);
		for (const recovered of recoveredProcesses)
			logger.info("process.recovered", recovered);
		runtimeActive = true;
		maintainRetentionSafely();
	};

	return { activate, isActive: () => runtimeActive, maintainRetentionSafely };
}
