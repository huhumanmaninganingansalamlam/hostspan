import { existsSync, readFileSync, unwatchFile, watchFile } from "node:fs";
import { join, resolve } from "node:path";
import { buildAdminSnapshot } from "../../admin/snapshot.js";
import { createInitialConfig } from "../../config/defaults.js";
import { loadConfig } from "../../config/loader.js";
import { writeConfigAtomic } from "../../config/writer.js";
import { daemonStatus } from "../../daemon/control.js";
import { runDoctor } from "../../diagnostics/doctor.js";
import { TOOLSET_HASH } from "../../mcp/registry.js";
import {
	buildSupportExport,
	writeSupportExportAtomic,
} from "../../observability/support-export.js";
import { createRuntime } from "../../runtime/create-runtime.js";
import { AuditRepo } from "../../state/audit-repo.js";
import {
	openMemoryDatabase,
	openReadOnlyDatabase,
} from "../../state/database.js";
import { ProcessesRepo } from "../../state/processes-repo.js";
import { TargetRegistry } from "../../targets/registry.js";
import { PROTOCOL_VERSION } from "../../version.js";
import { hasFlag, readOption } from "../arguments.js";
import {
	cliValidationError,
	type CliCommandContext,
	writeJsonResult,
} from "../context.js";
import { runSmoke } from "../smoke.js";

export async function runInitCommand(
	context: CliCommandContext,
): Promise<number> {
	if (existsSync(context.configPath))
		throw cliValidationError(`config already exists: ${context.configPath}`);
	writeConfigAtomic(context.configPath, createInitialConfig());
	writeJsonResult(context.stdout, {
		ok: true,
		config_path: context.configPath,
		next: "hostspan targets add --id <target> --root <absolute-path>",
	});
	return 0;
}

export async function runDoctorCommand(
	context: CliCommandContext,
): Promise<number> {
	const report = await runDoctor(context.configPath);
	writeJsonResult(context.stdout, report);
	return report.ok ? 0 : 1;
}

export async function runStatusCommand(
	context: CliCommandContext,
): Promise<number> {
	const snapshot = buildAdminSnapshot(context.configPath, { recent: 20 });
	writeJsonResult(context.stdout, {
		server_version: snapshot.server_version,
		build: snapshot.build,
		protocol_version: PROTOCOL_VERSION,
		toolset_hash: TOOLSET_HASH,
		toolset_version: snapshot.toolset_version,
		policy_epoch: snapshot.policy_epoch,
		daemon: snapshot.daemon,
		computer: snapshot.computer,
		listen_host: snapshot.listen.host,
		listen_port: snapshot.listen.port,
		native_execution: true,
		sandboxed: false,
		targets: snapshot.targets.map((target) => ({
			target_id: target.target_id,
			label: target.label,
			ready: target.ready,
			capabilities: target.capabilities,
			...(hasFlag(context.argv, "--verbose") ? { root: target.root } : {}),
		})),
		active_process_count: snapshot.active_process_count,
		terminal_sessions: snapshot.terminal.sessions,
	});
	return 0;
}

export async function runAdminSnapshotCommand(
	context: CliCommandContext,
): Promise<number> {
	const recent = Number(readOption(context.argv, "--recent") ?? "30");
	writeJsonResult(
		context.stdout,
		buildAdminSnapshot(context.configPath, {
			recent: Number.isFinite(recent) ? recent : 30,
		}),
	);
	return 0;
}

export async function runSmokeCommand(
	context: CliCommandContext,
): Promise<number> {
	const targetId = readOption(context.argv, "--target");
	if (!targetId) {
		throw cliValidationError("smoke requires --target TARGET", {
			reason: "missing_argument",
			argument: "--target",
		});
	}
	if (daemonStatus(context.configPath).running) {
		throw cliValidationError(
			"hostspan smoke requires the daemon to be stopped so validation cannot mutate live recovery state.",
			{ reason: "daemon_running" },
		);
	}
	const runtime = createRuntime(context.configPath);
	try {
		const report = await runSmoke(runtime, targetId);
		writeJsonResult(context.stdout, report);
		return report.ok ? 0 : 1;
	} finally {
		await runtime.close();
	}
}

export async function runSupportExportCommand(
	context: CliCommandContext,
): Promise<number> {
	const config = loadConfig(context.configPath);
	const targets = new TargetRegistry(config);
	const statePath = join(config.server.data_dir, "state.db");
	const db = existsSync(statePath)
		? openReadOnlyDatabase(statePath)
		: openMemoryDatabase();
	try {
		const configValue = readOption(context.argv, "--config");
		const positional = context.argv
			.slice(1)
			.find((item) => !item.startsWith("--") && item !== configValue);
		const output = resolve(
			positional ??
				`hostspan-support-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
		);
		writeSupportExportAtomic(
			output,
			buildSupportExport(
				{
					config,
					targets,
					audit: new AuditRepo(db),
					processes: new ProcessesRepo(db),
				},
				TOOLSET_HASH,
			),
		);
		writeJsonResult(context.stdout, { ok: true, path: output });
	} finally {
		db.close();
	}
	return 0;
}

export async function runLogsCommand(
	context: CliCommandContext,
): Promise<number> {
	const config = loadConfig(context.configPath);
	const path = join(config.server.data_dir, "logs", "hostspan.jsonl");
	if (existsSync(path)) context.stdout.write(readFileSync(path, "utf8"));
	if (!hasFlag(context.argv, "--follow")) return 0;
	let offset = existsSync(path) ? readFileSync(path).length : 0;
	await new Promise<void>((resolveFollow) => {
		watchFile(path, { interval: 500 }, () => {
			if (!existsSync(path)) return;
			const data = readFileSync(path);
			if (data.length < offset) offset = 0;
			if (data.length > offset) context.stdout.write(data.subarray(offset));
			offset = data.length;
		});
		const stop = () => {
			unwatchFile(path);
			resolveFollow();
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	});
	return 0;
}
