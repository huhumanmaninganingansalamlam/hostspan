import { HostSpanError } from "../errors.js";
import type { HostSpanConfig } from "../config/schema.js";
import { scanProcessSpools } from "./output-spool.js";
import type { ProcessRecord } from "./store.js";

export function assertProcessSpoolBudget(
	config: HostSpanConfig,
	requestedBytes: number,
	active: ProcessRecord[],
): void {
	const spoolUsage = scanProcessSpools(config.server.data_dir);
	let projected = spoolUsage.total;
	for (const record of active) {
		projected += Math.max(
			0,
			(record.max_output_bytes ?? 0) -
				(spoolUsage.sizes.get(record.process_id) ?? 0),
		);
	}
	const maximum = config.retention.max_total_spool_bytes;
	const remaining = maximum - projected;
	if (remaining < requestedBytes) {
		throw new HostSpanError(
			"SERVER_BUSY",
			"Process output retention budget cannot satisfy the requested output cap; retry after retained output expires.",
			true,
			{
				resource: "process_output_spool",
				reason: "capacity_saturated",
				retained_and_reserved_bytes: projected,
				requested_output_bytes: requestedBytes,
				remaining_output_bytes: Math.max(0, remaining),
				max_total_spool_bytes: maximum,
			},
		);
	}
}
