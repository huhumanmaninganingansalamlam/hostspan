import {
	buildAdminSnapshot,
	resolveTerminalSession,
} from "../../admin/snapshot.js";
import { loadConfig } from "../../config/loader.js";
import { HostSpanError } from "../../errors.js";
import { PtySessionManager } from "../../processes/pty-session.js";
import { hasFlag, readOption } from "../arguments.js";
import {
	cliValidationError,
	type CliCommandContext,
	writeJsonResult,
} from "../context.js";

export async function runTerminalCommand(
	context: CliCommandContext,
): Promise<number> {
	const { argv, configPath } = context;
	const action = argv[1];
	if (action === "list") {
		writeJsonResult(context.stdout, {
			sessions: buildAdminSnapshot(configPath, { recent: 200 }).terminal
				.sessions,
		});
		return 0;
	}
	if (action === "attach") {
		const processId = readOption(argv, "--process") ?? argv[2];
		if (!processId)
			throw cliValidationError("terminal attach requires --process PROCESS_ID");
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			throw new HostSpanError(
				"TERMINAL_NOT_INTERACTIVE",
				"terminal attach requires an interactive local terminal.",
			);
		}
		const config = loadConfig(configPath);
		if (!config.terminal) {
			throw new HostSpanError(
				"TERMINAL_BACKEND_UNAVAILABLE",
				"terminal support is not configured.",
			);
		}
		const session = resolveTerminalSession(configPath, processId);
		if (!session) {
			throw new HostSpanError(
				"PROCESS_NOT_FOUND",
				`interactive process not found: ${processId}`,
				false,
				{ process_id: processId },
			);
		}
		const manager = new PtySessionManager(
			config.server.data_dir,
			config.terminal,
		);
		await manager.attach(session.session, hasFlag(argv, "--read-only"));
		return 0;
	}
	throw cliValidationError("terminal requires list or attach");
}
