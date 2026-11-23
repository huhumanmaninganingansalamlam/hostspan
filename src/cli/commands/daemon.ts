import { daemonStatus, startDaemon, stopDaemon } from "../../daemon/control.js";
import {
	cliValidationError,
	type CliCommandContext,
	writeJsonResult,
} from "../context.js";

export async function runDaemonCommand(
	context: CliCommandContext,
): Promise<number> {
	const action = context.argv[1];
	if (action === "start") {
		writeJsonResult(context.stdout, await startDaemon(context.configPath));
		return 0;
	}
	if (action === "stop") {
		writeJsonResult(context.stdout, await stopDaemon(context.configPath));
		return 0;
	}
	if (action === "status") {
		writeJsonResult(context.stdout, daemonStatus(context.configPath));
		return 0;
	}
	throw cliValidationError("daemon requires start, stop, or status");
}
