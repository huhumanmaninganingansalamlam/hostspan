import {
	clipboard,
	dialog,
	ipcMain,
	type BrowserWindow,
	type IpcMainInvokeEvent,
} from "electron";
import {
	addLocalWorkspace,
	removeLocalWorkspace,
	resolveTerminalSession,
	setComputerEnabled,
} from "../admin/snapshot.js";
import { loadConfig } from "../config/loader.js";
import { PtySessionManager } from "../processes/pty-session.js";
import {
	isTrustedDashboardIpc,
	requireAttachInput,
	requireBoolean,
	requireDaemonAction,
	requireString,
	requireWorkspaceInput,
} from "./ipc-security.js";
import type { createDesktopDaemonController } from "./daemon-controller.js";

type DaemonController = ReturnType<typeof createDesktopDaemonController>;
export interface DashboardIpcDependencies {
	getWindow(): BrowserWindow | undefined;
	getConfigPath(): string;
	snapshot: DaemonController["snapshot"];
	daemonAction: DaemonController["daemonAction"];
	restartDaemonWithConfirmation: DaemonController["restartDaemonWithConfirmation"];
	doctorReport: DaemonController["doctorReport"];
	refreshUi(): Promise<void>;
	getAutoStart(): boolean;
	setAutoStart(enabled: boolean): boolean;
	openAttach(processId: string, readOnly: boolean): void;
}

export function registerDashboardIpcHandlers({
	getWindow,
	getConfigPath,
	snapshot,
	daemonAction,
	restartDaemonWithConfirmation,
	doctorReport,
	refreshUi,
	getAutoStart,
	setAutoStart,
	openAttach,
}: DashboardIpcDependencies): () => void {
	function assertDashboardSender(event: IpcMainInvokeEvent): void {
		const dashboardWindow = getWindow();
		const contents =
			dashboardWindow && !dashboardWindow.isDestroyed()
				? dashboardWindow.webContents
				: undefined;
		if (!contents || !isTrustedDashboardIpc(event, contents))
			throw new Error("desktop IPC rejected from untrusted renderer");
	}

	ipcMain.handle("hostspan:snapshot", (event) => {
		assertDashboardSender(event);
		return snapshot();
	});
	ipcMain.handle("hostspan:daemon", async (event, rawAction: unknown) => {
		assertDashboardSender(event);
		const action = requireDaemonAction(rawAction);
		if (action === "restart") return restartDaemonWithConfirmation();
		const result = await daemonAction(action);
		await refreshUi();
		return result;
	});
	ipcMain.handle(
		"hostspan:set-computer",
		async (event, rawEnabled: unknown) => {
			assertDashboardSender(event);
			setComputerEnabled(
				getConfigPath(),
				requireBoolean(rawEnabled, "computer"),
			);
			await refreshUi();
			return { saved: true };
		},
	);
	ipcMain.handle("hostspan:doctor", (event) => {
		assertDashboardSender(event);
		return doctorReport();
	});
	ipcMain.handle("hostspan:choose-workspace", async (event) => {
		assertDashboardSender(event);
		const result = await dialog.showOpenDialog({
			title: "Add HostSpan Workspace",
			properties: ["openDirectory"],
		});
		return {
			canceled: result.canceled,
			...(result.filePaths[0] ? { path: result.filePaths[0] } : {}),
		};
	});
	ipcMain.handle("hostspan:add-workspace", async (event, rawInput: unknown) => {
		assertDashboardSender(event);
		const result = addLocalWorkspace(
			getConfigPath(),
			requireWorkspaceInput(rawInput),
		);
		await refreshUi();
		return result;
	});
	ipcMain.handle(
		"hostspan:remove-workspace",
		async (event, rawTargetId: unknown) => {
			assertDashboardSender(event);
			const result = removeLocalWorkspace(
				getConfigPath(),
				requireString(rawTargetId, "target_id", 64),
			);
			await refreshUi();
			return result;
		},
	);
	ipcMain.handle("hostspan:get-autostart", (event) => {
		assertDashboardSender(event);
		return getAutoStart();
	});
	ipcMain.handle("hostspan:set-autostart", (event, rawEnabled: unknown) => {
		assertDashboardSender(event);
		return setAutoStart(requireBoolean(rawEnabled, "autostart"));
	});
	ipcMain.handle("hostspan:attach", (event, rawInput: unknown) => {
		assertDashboardSender(event);
		const input = requireAttachInput(rawInput);
		const config = loadConfig(getConfigPath());
		if (!config.terminal) throw new Error("terminal support is not configured");
		const session = resolveTerminalSession(getConfigPath(), input.processId);
		if (!session)
			throw new Error(`terminal process not found: ${input.processId}`);
		const manager = new PtySessionManager(
			config.server.data_dir,
			config.terminal,
		);
		if (!manager.inspectSync(session.session).exists)
			throw new Error("PTY session is no longer live");
		openAttach(input.processId, input.readOnly);
		return { ok: true };
	});
	ipcMain.handle("hostspan:copy", (event, rawText: unknown) => {
		assertDashboardSender(event);
		clipboard.writeText(requireString(rawText, "clipboard text", 1_048_576));
		return { ok: true };
	});

	return () => {
		ipcMain.removeHandler("hostspan:snapshot");
		ipcMain.removeHandler("hostspan:daemon");
		ipcMain.removeHandler("hostspan:set-computer");
		ipcMain.removeHandler("hostspan:doctor");
		ipcMain.removeHandler("hostspan:choose-workspace");
		ipcMain.removeHandler("hostspan:add-workspace");
		ipcMain.removeHandler("hostspan:remove-workspace");
		ipcMain.removeHandler("hostspan:get-autostart");
		ipcMain.removeHandler("hostspan:set-autostart");
		ipcMain.removeHandler("hostspan:attach");
		ipcMain.removeHandler("hostspan:copy");
	};
}
