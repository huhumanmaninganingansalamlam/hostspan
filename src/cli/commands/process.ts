import {
	requestDaemonProcessList,
	requestDaemonProcessPoll,
} from "../../daemon/control.js";
import {
	ProcessListInputSchema,
	ProcessPollInputSchema,
} from "../../tools/schemas.js";
import { parseNamedOptions } from "../arguments.js";
import {
	cliValidationError,
	type CliCommandContext,
	writeJsonResult,
} from "../context.js";

const PROCESS_LIST_OPTIONS = {
	"--target": { field: "target_id" },
	"--cwd": { field: "cwd" },
	"--active-only": {
		field: "active_only",
		parse(value: string) {
			if (value !== "true" && value !== "false") {
				throw cliValidationError("--active-only requires true or false");
			}
			return value === "true";
		},
	},
	"--limit": { field: "limit", parse: Number },
	"--cursor": { field: "cursor" },
} as const;

const PROCESS_POLL_OPTIONS = {
	"--process": { field: "process_id" },
	"--stdout-cursor": { field: "stdout_cursor", parse: Number },
	"--stderr-cursor": { field: "stderr_cursor", parse: Number },
	"--wait-ms": { field: "wait_ms", parse: Number },
	"--max-bytes": { field: "max_bytes", parse: Number },
} as const;

export async function runProcessCommand(
	context: CliCommandContext,
): Promise<number> {
	const { argv, configPath } = context;
	if (argv[1] === "list") {
		const input = parseNamedOptions(argv, {
			startIndex: 2,
			specifications: PROCESS_LIST_OPTIONS,
			passthrough: ["--config"],
			invalidOption: (option) =>
				cliValidationError(`Invalid or missing process list option: ${option}`),
		});
		const parsed = ProcessListInputSchema.safeParse(input);
		if (!parsed.success)
			throw cliValidationError(
				`Invalid process list arguments: ${parsed.error.message}`,
			);
		writeJsonResult(
			context.stdout,
			await requestDaemonProcessList(configPath, parsed.data),
		);
		return 0;
	}

	if (argv[1] !== "poll") {
		throw cliValidationError(
			"process requires list --target TARGET or poll --process PROCESS_ID",
		);
	}
	const input = parseNamedOptions(argv, {
		startIndex: 2,
		specifications: PROCESS_POLL_OPTIONS,
		passthrough: ["--config"],
		invalidOption: (option) =>
			cliValidationError(`Invalid or missing process poll option: ${option}`),
	});
	const parsed = ProcessPollInputSchema.safeParse(input);
	if (!parsed.success)
		throw cliValidationError(
			`Invalid process poll arguments: ${parsed.error.message}`,
		);
	writeJsonResult(
		context.stdout,
		await requestDaemonProcessPoll(configPath, parsed.data),
	);
	return 0;
}
