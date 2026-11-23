import { cleanupTerminalPatchJournals } from "../files/patch.js";
import { cleanupExpiredProcessSpools } from "../processes/output-spool.js";
import type { HostSpanConfig } from "../config/schema.js";
import type { OperationsRepo } from "../state/operations-repo.js";
import type { ProcessesRepo } from "../state/processes-repo.js";
import type { TransactionsRepo } from "../state/transactions-repo.js";
import type { OAuthRepo } from "../state/oauth-repo.js";
import type { AuditRepo } from "../state/audit-repo.js";
import type { HostSpanLogger } from "../observability/logger.js";

export function createRetentionMaintenance({
	config,
	transactions,
	processes,
	operations,
	oauthRepo,
	audit,
	logger,
}: {
	config: HostSpanConfig;
	transactions: TransactionsRepo;
	processes: ProcessesRepo;
	operations: OperationsRepo;
	oauthRepo: OAuthRepo;
	audit: AuditRepo;
	logger: HostSpanLogger;
}): () => void {
	const runRetentionMaintenance = () => {
		const now = new Date().toISOString();
		const removedPatchJournals = cleanupTerminalPatchJournals(transactions);
		const cleanup = cleanupExpiredProcessSpools(
			config.server.data_dir,
			processes.expiredOutput(now).map((record) => record.process_id),
			config.retention.max_total_spool_bytes,
			processes.outputRetentionCandidates().map((record) => record.process_id),
		);
		for (const processId of cleanup.evicted)
			processes.expireOutput(processId, now);
		const compactedOperationResults = operations.compactResultsOlderThan(
			config.retention.operation_result_days,
		);
		const prunedProcessRows = processes.pruneTerminalMetadataOlderThan(
			config.retention.operation_result_days,
		);
		const prunedPatchTransactions = transactions.pruneTerminalOlderThan(
			config.retention.operation_result_days,
		);
		oauthRepo.pruneExpired(Math.floor(Date.now() / 1_000));
		const auditMaintenance = audit.maintain();
		if (cleanup.over_quota) logger.info("spool.quota_exceeded", cleanup);
		if (
			removedPatchJournals.length ||
			cleanup.removed.length ||
			cleanup.evicted.length ||
			compactedOperationResults > 0 ||
			prunedProcessRows > 0 ||
			prunedPatchTransactions > 0 ||
			auditMaintenance.deleted_by_age ||
			auditMaintenance.deleted_by_cap
		) {
			logger.info("retention.maintained", {
				patch_journals_removed: removedPatchJournals.length,
				spool_removed: cleanup.removed.length,
				spool_evicted: cleanup.evicted.length,
				spool_total_bytes: cleanup.total_bytes,
				operation_results_compacted: compactedOperationResults,
				process_rows_pruned: prunedProcessRows,
				patch_transactions_pruned: prunedPatchTransactions,
				audit_deleted_by_age: auditMaintenance.deleted_by_age,
				audit_deleted_by_cap: auditMaintenance.deleted_by_cap,
			});
		}
	};
	return runRetentionMaintenance;
}
