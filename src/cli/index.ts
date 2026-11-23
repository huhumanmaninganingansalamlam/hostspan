#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfigPath } from "../config/paths.js";
import { asHostSpanError } from "../errors.js";
import { TOOLSET_HASH, toolsetDocument } from "../mcp/registry.js";
import {
	BUILD_IDENTITY,
	PROTOCOL_VERSION,
	SERVER_VERSION,
	TOOLSET_VERSION,
} from "../version.js";
import { hasFlag, readOption } from "./arguments.js";
import { runAccessTokenCommand } from "./commands/access-token.js";
import { runComputerCommand } from "./commands/computer.js";
import { runDaemonCommand } from "./commands/daemon.js";
import {
	runAdminSnapshotCommand,
	runDoctorCommand,
	runInitCommand,
	runLogsCommand,
	runSmokeCommand,
	runStatusCommand,
	runSupportExportCommand,
} from "./commands/diagnostics.js";
import { runOAuthCommand } from "./commands/oauth.js";
import { runProcessCommand } from "./commands/process.js";
import { runServeCommand } from "./commands/serve.js";
import { runServiceCliCommand } from "./commands/service.js";
import { runTerminalCommand } from "./commands/terminal.js";
import {
	runPolicyValidateCommand,
	runTargetsCommand,
} from "./commands/targets.js";
import {
	cliValidationError,
	type CliCommandContext,
	type CliCommandHandler,
	writeJsonResult,
} from "./context.js";
import { cliUsage } from "./usage.js";

const ROOT_COMMAND_HANDLERS: Readonly<Record<string, CliCommandHandler>> = {
	access: runAccessTokenCommand,
	computer: runComputerCommand,
	daemon: runDaemonCommand,
	doctor: runDoctorCommand,
	init: runInitCommand,
	logs: runLogsCommand,
	oauth: runOAuthCommand,
	process: runProcessCommand,
	serve: runServeCommand,
	service: runServiceCliCommand,
	smoke: runSmokeCommand,
	status: runStatusCommand,
	"support-export": runSupportExportCommand,
	targets: runTargetsCommand,
	terminal: runTerminalCommand,
};

function commandHandler(
	context: CliCommandContext,
): CliCommandHandler | undefined {
	if (context.command === "admin" && context.argv[1] === "snapshot") {
		return runAdminSnapshotCommand;
	}
	if (context.command === "policy" && context.argv[1] === "validate") {
		return runPolicyValidateCommand;
	}
	return ROOT_COMMAND_HANDLERS[context.command];
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
	const command = argv[0];
	if (
		!command ||
		command === "help" ||
		command === "--help" ||
		command === "-h"
	) {
		process.stdout.write(cliUsage());
		return 0;
	}
	if (command === "--version" || command === "version") {
		if (hasFlag(argv, "--verbose")) {
			writeJsonResult(process.stdout, {
				server_version: SERVER_VERSION,
				protocol_version: PROTOCOL_VERSION,
				toolset_version: TOOLSET_VERSION,
				toolset_hash: TOOLSET_HASH,
				build: BUILD_IDENTITY,
			});
		} else {
			process.stdout.write(`${SERVER_VERSION}\n`);
		}
		return 0;
	}
	if (command === "print-toolset") {
		writeJsonResult(process.stdout, {
			toolset_hash: TOOLSET_HASH,
			...toolsetDocument(),
		});
		return 0;
	}

	const context: CliCommandContext = {
		argv,
		command,
		configPath: resolve(readOption(argv, "--config") ?? defaultConfigPath()),
		stdout: process.stdout,
		stderr: process.stderr,
		entryModuleUrl: import.meta.url,
	};
	const handler = commandHandler(context);
	if (!handler) {
		throw cliValidationError(`unknown command: ${command}`, {
			reason: "unknown_command",
			command,
		});
	}
	return handler(context);
}

function isDirectCliEntry(argvPath: string | undefined): boolean {
	if (!argvPath) return false;
	const modulePath = fileURLToPath(import.meta.url);
	try {
		return realpathSync(argvPath) === realpathSync(modulePath);
	} catch {
		return resolve(argvPath) === resolve(modulePath);
	}
}

if (isDirectCliEntry(process.argv[1])) {
	main().then(
		(code) => {
			process.exitCode = code;
		},
		(error) => {
			const known = asHostSpanError(error);
			process.stderr.write(
				`${JSON.stringify({
					error: {
						code: known.code,
						message: known.message,
						retryable: known.retryable,
						details: known.details,
					},
				})}\n`,
			);
			process.exitCode = 1;
		},
	);
}
