import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { app, dialog } from "electron";
import { loadConfig } from "../config/loader.js";
import { daemonStatus } from "../daemon/control.js";
import {
	protectWindowsFile,
	protectWindowsTree,
} from "../security/windows-acl.js";
import {
	desktopDaemonStartupTimeoutMs,
	isDesktopLoginLaunch,
	macOSDaemonHasLoginSupervisor,
	prepareDesktopEnvironment,
	shouldStartLoginDaemon,
} from "./environment.js";
import { prepareDesktopConfig } from "./first-run.js";
import type { createDesktopDaemonController } from "./daemon-controller.js";

type DaemonController = ReturnType<typeof createDesktopDaemonController>;
export interface DesktopStartupDependencies {
	setConfigPath(path: string): void;
	refreshLinuxAutoStart(): void;
	startTray(): void;
	daemonAction: DaemonController["daemonAction"];
	refreshUi(): Promise<void>;
	scheduleStatusRefresh(): void;
}

export async function startDesktopApplication({
	setConfigPath,
	refreshLinuxAutoStart,
	startTray,
	daemonAction,
	refreshUi,
	scheduleStatusRefresh,
}: DesktopStartupDependencies): Promise<void> {
	try {
		prepareDesktopEnvironment();
		const configPath = prepareDesktopConfig(app.getPath("userData"));
		setConfigPath(configPath);
		refreshLinuxAutoStart();
		if (process.platform === "win32") {
			const config = loadConfig(configPath);
			protectWindowsFile(configPath);
			protectWindowsFile(`${configPath}.bak`);
			protectWindowsFile(join(dirname(configPath), "oauth-approval-secret"));
			protectWindowsTree(config.server.data_dir);
		}
		if (process.platform === "darwin") app.dock?.hide();
		startTray();
		const loginLaunch = isDesktopLoginLaunch(
			process.platform,
			process.argv,
			process.platform === "darwin" &&
				app.getLoginItemSettings().wasOpenedAtLogin,
		);
		const launchdManaged =
			process.platform === "darwin" &&
			macOSDaemonHasLoginSupervisor(
				configPath,
				join(homedir(), "Library", "LaunchAgents"),
			);
		if (shouldStartLoginDaemon(process.platform, loginLaunch, launchdManaged)) {
			// Do not block tray initialization behind a cold macOS desktop login.
			// Permit a bounded boot grace without pretending the daemon is ready.
			void (async () => {
				try {
					const startupTimeoutMs = desktopDaemonStartupTimeoutMs(
						process.platform,
						loginLaunch,
					);
					const result = await daemonAction("start", startupTimeoutMs);
					if ("running" in result && !result.running) {
						throw new Error(
							`HostSpan daemon did not start within ${startupTimeoutMs / 1000} seconds.`,
						);
					}
				} catch (error) {
					// A slow detached worker may have started just after the deadline.
					// Never show a false failure for an already-running daemon.
					if (!daemonStatus(configPath).running) {
						const message =
							error instanceof Error ? error.message : String(error);
						// A background login failure belongs in the dashboard, not in a
						// modal that can remain open after the daemon later becomes ready.
						if (process.platform === "darwin") {
							process.stderr.write(
								`HostSpan login daemon start failed: ${message}\n`,
							);
						} else {
							dialog.showErrorBox("HostSpan daemon could not start", message);
						}
					}
				} finally {
					await refreshUi().catch(() => undefined);
				}
			})();
		}
		await refreshUi();
		scheduleStatusRefresh();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		dialog.showErrorBox("HostSpan could not start", message);
		app.quit();
	}
}
