import {
	computerRuntimeState,
	setComputerEnabled,
} from "../../admin/snapshot.js";
import { loadConfig } from "../../config/loader.js";
import {
	ComputerInputSchema,
	supportedDesktopSession,
} from "../../computer/portal.js";
import { daemonStatus, requestDaemonComputer } from "../../daemon/control.js";
import { hasFlag, readOption } from "../arguments.js";
import {
	cliValidationError,
	type CliCommandContext,
	writeJsonResult,
} from "../context.js";

export async function runComputerCommand(
	context: CliCommandContext,
): Promise<number> {
	const { argv, configPath } = context;
	const action = argv[1] ?? "status";
	if (action === "inspect") {
		writeJsonResult(
			context.stdout,
			await requestDaemonComputer(configPath, { action: "status" }),
		);
		return 0;
	}
	if (action === "call") {
		const raw = readOption(argv, "--input");
		let input: unknown;
		try {
			input = JSON.parse(raw ?? "");
		} catch {
			throw cliValidationError("computer call requires --input JSON");
		}
		const parsed = ComputerInputSchema.safeParse(input);
		if (!parsed.success)
			throw cliValidationError("Invalid computer arguments.");
		const result = await requestDaemonComputer(configPath, parsed.data);
		writeJsonResult(context.stdout, result);
		return result.isError ? 1 : 0;
	}
	if (!["status", "enable", "disable"].includes(action)) {
		throw cliValidationError(
			"computer requires status, enable, disable, inspect, or call",
		);
	}

	const config = loadConfig(configPath);
	const changed =
		action !== "status" && Boolean(config.computer) !== (action === "enable");
	if (changed) setComputerEnabled(configPath, action === "enable");
	const running = daemonStatus(configPath).running;
	const configured =
		action === "status" ? Boolean(config.computer) : action === "enable";
	const runtime = await computerRuntimeState(configPath);
	const restartRequired =
		running && (runtime.enabled === null || runtime.enabled !== configured);
	const supported =
		typeof runtime.supported_session === "boolean"
			? runtime.supported_session
			: supportedDesktopSession();
	const message = changed
		? `Desktop control ${configured ? "enabled" : "disabled"} in this profile.`
		: `Desktop control is ${configured ? "configured" : "off"}.`;
	const next = restartRequired
		? "Restart this daemon explicitly when safe to apply the change. Existing work was not interrupted."
		: configured && running
			? "Computer-use is ON in the running daemon. Existing OS permissions and session state still apply."
			: configured
				? "Start HostSpan in your logged-in desktop. Ask your MCP assistant to open computer, complete any OS permission dialog, then observe and act."
				: "Run hostspan computer enable with the same --config to enable desktop control.";
	const result = {
		configured,
		enabled_by_default: false,
		runtime,
		restart_required: restartRequired,
		supported_session: supported,
		changed,
		daemon_running: running,
		message,
		next,
		config_path: configPath,
		runtime_note:
			"This describes saved configuration, not an active desktop grant. Remote callers also need hostspan.computer.",
		...(!supported && configured
			? {
					limitation:
						"This session does not provide a supported interactive desktop.",
				}
			: {}),
	};
	if (hasFlag(argv, "--json")) {
		writeJsonResult(context.stdout, result);
	} else {
		context.stdout.write(
			`${message}\nRunning computer-use: ${runtime.enabled === null ? "UNKNOWN" : runtime.enabled ? "ON" : "OFF"}${restartRequired ? " (restart required to apply saved setting)" : ""}\n${next}\n${result.runtime_note}\n${result.limitation ?? ""}\nProfile: ${configPath}\n`,
		);
	}
	return 0;
}
