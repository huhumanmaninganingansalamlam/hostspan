import { fileURLToPath } from "node:url";
import {
	installSystemdService,
	runServiceCommand,
} from "../../services/systemd.js";
import {
	cliValidationError,
	type CliCommandContext,
	writeJsonResult,
} from "../context.js";

export async function runServiceCliCommand(
	context: CliCommandContext,
): Promise<number> {
	const action = context.argv[1];
	if (action === "install") {
		const result = installSystemdService(
			context.configPath,
			fileURLToPath(context.entryModuleUrl),
		);
		writeJsonResult(context.stdout, result);
		return result.ok ? 0 : 1;
	}
	if (["start", "stop", "restart", "status"].includes(action ?? "")) {
		const result = runServiceCommand(
			action as "start" | "stop" | "restart" | "status",
		);
		writeJsonResult(context.stdout, result);
		return result.ok ? 0 : 1;
	}
	throw cliValidationError(
		"service requires install|start|stop|restart|status",
	);
}
