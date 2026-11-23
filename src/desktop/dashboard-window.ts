import { existsSync } from "node:fs";
import { BrowserWindow } from "electron";
import { dashboardHtml } from "./dashboard.js";
import { installDashboardNavigationGuards } from "./ipc-security.js";

export interface DashboardWindowDependencies {
	preloadPath: string;
	appIconPath: string;
	refreshUi(): Promise<void>;
	scheduleStatusRefresh(): void;
	isQuitting(): boolean;
}
export function createDashboardWindowController({
	preloadPath,
	appIconPath,
	refreshUi,
	scheduleStatusRefresh,
	isQuitting,
}: DashboardWindowDependencies) {
	let window: BrowserWindow | undefined;
	function createWindow(): BrowserWindow {
		if (window && !window.isDestroyed()) return window;
		window = new BrowserWindow({
			width: 860,
			height: 720,
			show: false,
			title: "HostSpan",
			...(process.platform !== "darwin" && existsSync(appIconPath)
				? { icon: appIconPath }
				: {}),
			webPreferences: {
				preload: preloadPath,
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
			},
		});
		installDashboardNavigationGuards(window.webContents);
		window.on("show", () => {
			void refreshUi().catch(() => undefined);
			scheduleStatusRefresh();
		});
		window.on("hide", scheduleStatusRefresh);
		void window.loadURL(
			`data:text/html;charset=utf-8,${encodeURIComponent(dashboardHtml())}`,
		);
		window.on("close", (event) => {
			if (!isQuitting()) {
				event.preventDefault();
				window?.hide();
			}
		});
		return window;
	}

	return { createWindow, getWindow: () => window };
}
