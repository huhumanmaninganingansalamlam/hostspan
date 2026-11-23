import type { BrowserWindow } from "electron";
import { dialog } from "electron";
import { buildAdminSnapshot, computerRuntimeState } from "../admin/snapshot.js";
import { startDaemon, stopDaemon } from "../daemon/control.js";
import { runDoctor, type DoctorReport } from "../diagnostics/doctor.js";
import {
	runServiceCommand,
	systemdServiceInstalled,
} from "../services/systemd.js";

export interface DesktopDaemonDependencies {
	getConfigPath(): string;
	cliPath: string;
	nodePath: string;
	getAutoStart(): boolean;
	getWindow(): BrowserWindow | undefined;
	refreshUi(): Promise<void>;
}

type AdminSnapshot = ReturnType<typeof buildAdminSnapshot>;
export type DesktopSnapshot = Omit<AdminSnapshot, "computer"> & {
	computer: AdminSnapshot["computer"] & { runtime: Record<string, unknown> };
	auto_start: boolean;
};

export function createDesktopDaemonController({
	getConfigPath,
	cliPath,
	nodePath,
	getAutoStart,
	getWindow,
	refreshUi,
}: DesktopDaemonDependencies) {
	async function snapshot(): Promise<DesktopSnapshot> {
		const base = buildAdminSnapshot(getConfigPath(), { recent: 40 });
		const runtime = await computerRuntimeState(getConfigPath());
		return {
			...base,
			computer: { ...base.computer, runtime },
			auto_start: getAutoStart(),
		};
	}

	function checkedServiceAction(action: "start" | "stop") {
		const result = runServiceCommand(action);
		if (!result.ok)
			throw new Error(
				`systemctl --user ${action} hostspan.service failed: ${result.output || "unknown error"}`,
			);
		return result;
	}

	async function daemonAction(
		action: "start" | "stop" | "restart",
		startupTimeoutMs?: number,
	) {
		if (systemdServiceInstalled()) {
			if (action === "start") return checkedServiceAction("start");
			await stopDaemon(getConfigPath());
			return action === "stop"
				? checkedServiceAction("stop")
				: checkedServiceAction("start");
		}
		if (action === "restart") {
			await stopDaemon(getConfigPath());
			return startDaemon(getConfigPath(), cliPath, nodePath, startupTimeoutMs);
		}
		return action === "start"
			? startDaemon(getConfigPath(), cliPath, nodePath, startupTimeoutMs)
			: stopDaemon(getConfigPath());
	}

	async function confirmDaemonRestart(): Promise<boolean> {
		const current = await snapshot();
		const activeNative = current.active_processes.filter(
			(process) => process.backend !== "pty" && !process.backend_ref,
		).length;
		const durableNative = current.active_processes.filter(
			(process) => process.backend === "native" && process.backend_ref,
		).length;
		const activePty = current.active_processes.filter(
			(process) => process.backend === "pty",
		).length;
		const impact = [
			"HostSpan loads target and policy configuration once when the daemon starts.",
			"Restarting applies saved workspace, capability, and screen-access settings atomically.",
			"Finish the current screen session before restarting. Restart ends screen sharing; Linux requires OS approval again. Saving Screen access does not open an approval dialog.",
			activeNative > 0
				? `${activeNative} active native process(es) will be stopped.`
				: "No active native process will be stopped.",
			...(durableNative > 0
				? [
						`${durableNative} durable native process(es) will remain alive and reconnect after restart.`,
					]
				: []),
			activePty > 0
				? `${activePty} durable PTY session(s) will remain alive and reconnect after restart.`
				: "No live PTY session needs recovery.",
		].join("\n\n");
		const options = {
			type: activeNative > 0 ? ("warning" as const) : ("question" as const),
			title: "Restart HostSpan",
			message: "Restart HostSpan now?",
			detail: impact,
			buttons: ["Restart", "Cancel"],
			defaultId: 0,
			cancelId: 1,
			noLink: true,
		};
		const dashboardWindow = getWindow();
		const result =
			dashboardWindow && !dashboardWindow.isDestroyed()
				? await dialog.showMessageBox(dashboardWindow, options)
				: await dialog.showMessageBox(options);
		return result.response === 0;
	}

	async function restartDaemonWithConfirmation() {
		if (!(await confirmDaemonRestart())) return { cancelled: true };
		const result = await daemonAction("restart");
		await refreshUi();
		return { cancelled: false, result };
	}

	async function doctorReport(): Promise<DoctorReport> {
		return runDoctor(getConfigPath());
	}

	return {
		snapshot,
		daemonAction,
		restartDaemonWithConfirmation,
		doctorReport,
	};
}
