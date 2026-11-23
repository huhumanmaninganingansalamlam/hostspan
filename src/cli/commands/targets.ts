import {
	addLocalWorkspace,
	removeLocalWorkspace,
} from "../../admin/snapshot.js";
import { loadConfig } from "../../config/loader.js";
import { HostSpanError } from "../../errors.js";
import { TargetRegistry } from "../../targets/registry.js";
import { readOption } from "../arguments.js";
import {
	cliValidationError,
	type CliCommandContext,
	writeJsonResult,
} from "../context.js";

export async function runTargetsCommand(
	context: CliCommandContext,
): Promise<number> {
	const { argv, configPath } = context;
	const action = argv[1];
	const config = loadConfig(configPath);
	if (action === "list") {
		const registry = new TargetRegistry(config);
		writeJsonResult(context.stdout, {
			targets: registry.list().map((target) => ({
				target_id: target.target_id,
				label: target.label,
				root: target.root_real,
				capabilities: target.capabilities,
			})),
		});
		return 0;
	}
	if (action === "add") {
		const targetId = readOption(argv, "--id");
		const root = readOption(argv, "--root");
		if (!targetId || !root)
			throw cliValidationError("targets add requires --id and --root");
		const capabilities = (readOption(argv, "--capabilities") ?? "read")
			.split(",")
			.filter(Boolean) as Array<"read" | "write" | "exec" | "terminal">;
		const execProfile = readOption(argv, "--exec-profile");
		writeJsonResult(
			context.stdout,
			addLocalWorkspace(configPath, {
				target_id: targetId,
				label: readOption(argv, "--label") ?? targetId,
				root,
				capabilities,
				...(execProfile ? { exec_profile: execProfile } : {}),
			}),
		);
		return 0;
	}
	if (action === "remove") {
		const targetId = readOption(argv, "--id") ?? argv[2];
		if (!targetId) {
			throw cliValidationError(
				"targets remove requires an existing target id",
				{
					reason: "missing_argument",
					argument: "--id",
				},
			);
		}
		if (!config.targets[targetId]) {
			throw new HostSpanError(
				"TARGET_NOT_FOUND",
				`Unknown target_id: ${targetId}`,
				false,
				{
					target_id: targetId,
				},
			);
		}
		writeJsonResult(context.stdout, removeLocalWorkspace(configPath, targetId));
		return 0;
	}
	throw cliValidationError("targets requires list, add, or remove");
}

export async function runPolicyValidateCommand(
	context: CliCommandContext,
): Promise<number> {
	const config = loadConfig(context.configPath);
	for (const [targetId, target] of Object.entries(config.targets)) {
		if (target.exec_profile && !config.exec_profiles[target.exec_profile]) {
			throw cliValidationError(
				`target ${targetId} references missing exec profile ${target.exec_profile}`,
			);
		}
	}
	writeJsonResult(context.stdout, {
		ok: true,
		policy_epoch: config.policy_epoch,
		native_execution: true,
		sandboxed: false,
	});
	return 0;
}
