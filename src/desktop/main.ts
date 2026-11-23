import { startDesktopApplication } from "./bootstrap.js";
import { createTrayController } from "./tray-controller.js";
import { createDashboardWindowController } from "./dashboard-window.js";
import { registerDashboardIpcHandlers } from "./ipc-handlers.js";
import { createDesktopDaemonController } from "./daemon-controller.js";
import { createAutoStartController } from "./autostart.js";
import { createTerminalLauncher } from "./terminal-launcher.js";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import type { AddWorkspaceInput } from "../admin/snapshot.js";
import { defaultConfigPath } from "../config/paths.js";
import { acquireDesktopPrimaryInstance } from "./single-instance.js";

declare global {
	interface Window {
		hostspan: {
			snapshot(): Promise<unknown>;
			setComputer(enabled: boolean): Promise<unknown>;
			daemon(action: "start" | "stop" | "restart"): Promise<unknown>;
			doctor(): Promise<unknown>;
			chooseWorkspace(): Promise<{ canceled: boolean; path?: string }>;
			addWorkspace(input: AddWorkspaceInput): Promise<unknown>;
			removeWorkspace(targetId: string): Promise<unknown>;
			getAutoStart(): Promise<boolean>;
			setAutoStart(enabled: boolean): Promise<boolean>;
			attach(processId: string, readOnly: boolean): Promise<unknown>;
			copy(text: string): Promise<unknown>;
			onUpdate(callback: (snapshot: unknown) => void): void;
		};
	}
}

let configPath = resolve(defaultConfigPath());
if (process.platform === "linux") app.commandLine.appendSwitch("disable-gpu");
const cliPath = fileURLToPath(new URL("../cli/index.js", import.meta.url));
const mainPath = fileURLToPath(new URL("./main.js", import.meta.url));
const linuxDevelopmentElectronPath = fileURLToPath(
	new URL("../../../node_modules/electron/dist/electron", import.meta.url),
);
const preloadPath = fileURLToPath(new URL("./preload.cjs", import.meta.url));
const iconDir = fileURLToPath(
	new URL("../../../assets/icons/", import.meta.url),
);
const appIconPath = join(iconDir, "app.png");
const nodePath = process.env.HOSTSPAN_NODE ?? process.execPath;
const { getAutoStart, setAutoStart, refreshLinuxAutoStart } =
	createAutoStartController({
		mainPath,
		linuxDevelopmentElectronPath,
	});
const { openAttach } = createTerminalLauncher({
	cliPath,
	nodePath,
	getConfigPath: () => configPath,
});

let quitting = false;
let refreshUi!: () => Promise<void>;
let scheduleStatusRefresh!: () => void;

const { createWindow, getWindow } = createDashboardWindowController({
	preloadPath,
	appIconPath,
	refreshUi: () => refreshUi(),
	scheduleStatusRefresh: () => scheduleStatusRefresh(),
	isQuitting: () => quitting,
});

const { snapshot, daemonAction, restartDaemonWithConfirmation, doctorReport } =
	createDesktopDaemonController({
		getConfigPath: () => configPath,
		cliPath,
		nodePath,
		getAutoStart,
		getWindow,
		refreshUi: () => refreshUi(),
	});

const trayController = createTrayController({
	iconDir,
	snapshot,
	daemonAction,
	restartDaemonWithConfirmation,
	getWindow,
	createWindow,
	setAutoStart,
	isQuitting: () => quitting,
	quit: () => {
		quitting = true;
		app.quit();
	},
});
refreshUi = trayController.refreshUi;
scheduleStatusRefresh = trayController.scheduleStatusRefresh;

const ownsSingleInstanceLock = acquireDesktopPrimaryInstance(app);
const unregisterDashboardIpc = ownsSingleInstanceLock
	? registerDashboardIpcHandlers({
			getWindow,
			getConfigPath: () => configPath,
			snapshot,
			daemonAction,
			restartDaemonWithConfirmation,
			doctorReport,
			refreshUi: () => refreshUi(),
			getAutoStart,
			setAutoStart,
			openAttach,
		})
	: () => {};

if (ownsSingleInstanceLock)
	app.on("second-instance", () => {
		const w = createWindow();
		w.show();
		w.focus();
	});
app.on("window-all-closed", () => undefined);

// app.quit() on a rejected instance does not guarantee that the already queued
// whenReady handler will be canceled. Never start another GUI/daemon without
// holding the process-wide single-instance lock.
if (ownsSingleInstanceLock) {
	void app.whenReady().then(() =>
		startDesktopApplication({
			setConfigPath: (path) => {
				configPath = path;
			},
			refreshLinuxAutoStart,
			startTray: trayController.startTray,
			daemonAction,
			refreshUi,
			scheduleStatusRefresh,
		}),
	);
}

app.on("before-quit", () => {
	unregisterDashboardIpc();
	quitting = true;
	trayController.dispose();
});
