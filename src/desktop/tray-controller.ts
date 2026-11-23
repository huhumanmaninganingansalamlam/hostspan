import { join } from "node:path";
import {
	type BrowserWindow,
	dialog,
	Menu,
	nativeImage,
	nativeTheme,
	Tray,
	type MenuItemConstructorOptions,
} from "electron";
import { desktopStatusRefreshIntervalMs } from "./environment.js";
import { trayMenuStateKey } from "./tray-menu-state.js";
import type {
	createDesktopDaemonController,
	DesktopSnapshot,
} from "./daemon-controller.js";

type DaemonController = ReturnType<typeof createDesktopDaemonController>;
export interface TrayMenuActions {
	openDashboard(): void;
	runDaemon(action: "start" | "stop"): void;
	restart(): void;
	setAutoStart(enabled: boolean): void;
	quit(): void;
}
export function buildTrayMenuTemplate(
	desktopSnapshot: DesktopSnapshot,
	actions: TrayMenuActions,
): MenuItemConstructorOptions[] {
	return [
		{
			label: `HostSpan ${desktopSnapshot.daemon.running ? "Running" : "Stopped"}`,
			enabled: false,
		},
		{ label: "Open Dashboard", click: () => actions.openDashboard() },
		{ type: "separator" },
		desktopSnapshot.daemon.running
			? { label: "Stop HostSpan", click: () => actions.runDaemon("stop") }
			: { label: "Start HostSpan", click: () => actions.runDaemon("start") },
		{
			label: "Restart HostSpan",
			enabled: desktopSnapshot.daemon.running,
			click: () => actions.restart(),
		},
		{
			label: "Start at login",
			type: "checkbox",
			checked: desktopSnapshot.auto_start,
			click: (item) => actions.setAutoStart(item.checked),
		},
		{ type: "separator" },
		{ label: `Targets: ${desktopSnapshot.targets.length}`, enabled: false },
		{ type: "separator" },
		{ label: "Quit Tray", click: () => actions.quit() },
	];
}

export interface TrayControllerDependencies {
	iconDir: string;
	snapshot: DaemonController["snapshot"];
	daemonAction: DaemonController["daemonAction"];
	restartDaemonWithConfirmation: DaemonController["restartDaemonWithConfirmation"];
	getWindow(): BrowserWindow | undefined;
	createWindow(): BrowserWindow;
	setAutoStart(enabled: boolean): boolean;
	isQuitting(): boolean;
	quit(): void;
}

export function createTrayController({
	iconDir,
	snapshot,
	daemonAction,
	restartDaemonWithConfirmation,
	getWindow,
	createWindow,
	setAutoStart,
	isQuitting,
	quit,
}: TrayControllerDependencies) {
	let tray: Tray | undefined;
	let refreshTimer: NodeJS.Timeout | undefined;
	let lastTrayMenuStateKey: string | undefined;
	let lastTrayTooltip: string | undefined;
	function scheduleStatusRefresh(): void {
		if (refreshTimer) clearTimeout(refreshTimer);
		if (isQuitting()) return;
		const dashboardWindow = getWindow();
		const dashboardVisible = Boolean(
			dashboardWindow &&
				!dashboardWindow.isDestroyed() &&
				dashboardWindow.isVisible(),
		);
		const intervalMs = desktopStatusRefreshIntervalMs(dashboardVisible);
		if (intervalMs === null) return;
		refreshTimer = setTimeout(() => {
			void refreshUi()
				.catch(() => undefined)
				.finally(scheduleStatusRefresh);
		}, intervalMs);
		refreshTimer.unref();
	}

	function icon() {
		const name =
			process.platform === "darwin"
				? "hostspanTemplate.png"
				: process.platform === "win32"
					? `tray-on-${nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ? "dark" : "light"}.png`
					: "tray.png";
		const path = join(iconDir, name);
		const branded = nativeImage.createFromPath(path);
		if (branded.isEmpty())
			throw new Error(`HostSpan tray icon is missing or invalid: ${path}`);
		if (process.platform === "darwin") branded.setTemplateImage(true);
		return branded;
	}

	function showDaemonActionError(
		action: "start" | "stop" | "restart",
		error: unknown,
	): void {
		dialog.showErrorBox(
			`HostSpan could not ${action}`,
			error instanceof Error ? error.message : String(error),
		);
	}

	function runTrayDaemonAction(action: "start" | "stop"): void {
		void daemonAction(action)
			.then(refreshUi)
			.catch((error: unknown) => showDaemonActionError(action, error));
	}

	async function refreshUi(): Promise<void> {
		const data = await snapshot();
		const tooltip = `HostSpan ${data.daemon.running ? "running" : "stopped"}`;
		if (tray && tooltip !== lastTrayTooltip) {
			tray.setToolTip(tooltip);
			lastTrayTooltip = tooltip;
		}
		const menuStateKey = trayMenuStateKey(data);
		if (tray && menuStateKey !== lastTrayMenuStateKey) {
			tray.setContextMenu(
				Menu.buildFromTemplate(
					buildTrayMenuTemplate(data, {
						openDashboard: () => {
							const w = createWindow();
							w.show();
							w.focus();
						},
						runDaemon: runTrayDaemonAction,
						restart: () =>
							void restartDaemonWithConfirmation().catch((error: unknown) =>
								showDaemonActionError("restart", error),
							),
						setAutoStart: (enabled) => {
							setAutoStart(enabled);
							void refreshUi();
						},
						quit,
					}),
				),
			);
			lastTrayMenuStateKey = menuStateKey;
		}
		const dashboardWindow = getWindow();
		if (dashboardWindow && !dashboardWindow.isDestroyed())
			dashboardWindow.webContents.send("hostspan:update", data);
	}

	const onThemeUpdated = () => tray?.setImage(icon());

	function startTray(): void {
		if (tray) return;
		tray = new Tray(icon());
		if (process.platform === "win32") nativeTheme.on("updated", onThemeUpdated);
		tray.on("right-click", () => {
			void refreshUi().catch(() => undefined);
		});
		tray.on("click", () => {
			void refreshUi().catch(() => undefined);
			const w = createWindow();
			if (w.isVisible()) w.hide();
			else {
				w.show();
				w.focus();
			}
		});
	}

	function dispose(): void {
		if (process.platform === "win32")
			nativeTheme.off("updated", onThemeUpdated);
		if (refreshTimer) clearTimeout(refreshTimer);
		refreshTimer = undefined;
		tray?.destroy();
		tray = undefined;
	}
	return { startTray, refreshUi, scheduleStatusRefresh, dispose };
}
