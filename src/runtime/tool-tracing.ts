import { asHostSpanError } from "../errors.js";
import { argumentHash } from "../state/operations-repo.js";
import {
	auditErrorDiagnostics,
	auditRequestDiagnostics,
	auditResponseDiagnostics,
} from "../observability/error-diagnostics.js";
import type { AuditRepo } from "../state/audit-repo.js";
import type { HostSpanLogger } from "../observability/logger.js";
import type { ToolCaller } from "../mcp/registry.js";

export function createTracedToolRunner({
	audit,
	logger,
}: {
	audit: AuditRepo;
	logger: HostSpanLogger;
}) {
	const traced = async <T extends Record<string, unknown>>(
		tool: string,
		input: unknown,
		requestId: string,
		run: () => Promise<T> | T,
		caller?: ToolCaller,
	): Promise<T> => {
		const started = Date.now();
		const inputRecord =
			input && typeof input === "object"
				? (input as Record<string, unknown>)
				: {};
		const metadata = {
			...caller,
			tool,
			argument_hash: argumentHash(input),
			target_id:
				typeof inputRecord.target_id === "string"
					? inputRecord.target_id
					: undefined,
			...auditRequestDiagnostics(inputRecord),
		};
		audit.append({
			request_id: requestId,
			event_type: "request.accepted",
			metadata,
		});
		logger.auditEvent("request.accepted", {
			request_id: requestId,
			...metadata,
		});
		try {
			const result = await run();
			const idempotencyKey =
				typeof inputRecord.idempotency_key === "string"
					? inputRecord.idempotency_key
					: undefined;
			const processId =
				typeof result.process_id === "string" ? result.process_id : undefined;
			audit.append({
				request_id: requestId,
				event_type: "response.returned",
				metadata: {
					...caller,
					tool,
					total_ms: Date.now() - started,
					...auditResponseDiagnostics(result),
				},
				...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
				...(processId ? { process_id: processId } : {}),
			});
			return result;
		} catch (error) {
			const known = asHostSpanError(error);
			const idempotencyKey =
				typeof inputRecord.idempotency_key === "string"
					? inputRecord.idempotency_key
					: undefined;
			audit.append({
				request_id: requestId,
				event_type: "request.aborted",
				metadata: {
					...caller,
					tool,
					stage: "handler",
					...auditErrorDiagnostics(known),
					total_ms: Date.now() - started,
					...auditRequestDiagnostics(inputRecord),
					...(known.code === "CURSOR_EXPIRED"
						? {
								stdout_cursor: inputRecord.stdout_cursor,
								stderr_cursor: inputRecord.stderr_cursor,
							}
						: {}),
				},
				...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
				...(typeof inputRecord.process_id === "string"
					? { process_id: inputRecord.process_id }
					: {}),
			});
			throw error;
		}
	};

	return traced;
}
