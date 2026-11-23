import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { app } from "electron";
import {
	desktopLaunchSpec,
	linuxAutoStartContents,
	linuxAutoStartPath,
} from "./environment.js";

export interface AutoStartDependencies {
	mainPath: string;
	linuxDevelopmentElectronPath: string;
}
export function createAutoStartController({
	mainPath,
	linuxDevelopmentElectronPath,
}: AutoStartDependencies) {
	function launchSpec(): { path: string; args: string[] } {
		let ozonePlatform = app.commandLine.getSwitchValue("ozone-platform");
		if (
			process.platform === "linux" &&
			!ozonePlatform &&
			existsSync(linuxAutoStartPath())
		) {
			ozonePlatform =
				readFileSync(linuxAutoStartPath(), "utf8").match(
					/^Exec=.*"--ozone-platform=([a-zA-Z0-9_-]+)"/m,
				)?.[1] ?? "";
		}
		return desktopLaunchSpec({
			platform: process.platform,
			isPackaged: app.isPackaged,
			execPath: process.execPath,
			mainPath,
			...(process.env.APPIMAGE ? { appImage: process.env.APPIMAGE } : {}),
			linuxDevelopmentExecPath: linuxDevelopmentElectronPath,
			login: true,
			ozonePlatform,
		});
	}

	function getAutoStart(): boolean {
		if (process.platform === "linux") return existsSync(linuxAutoStartPath());
		const spec = launchSpec();
		return app.getLoginItemSettings({ path: spec.path, args: spec.args })
			.openAtLogin;
	}

	function setAutoStart(enabled: boolean): boolean {
		const spec = launchSpec();
		if (process.platform === "linux") {
			const path = linuxAutoStartPath();
			if (!enabled) {
				rmSync(path, { force: true });
				return false;
			}
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			writeFileSync(path, linuxAutoStartContents(spec), { mode: 0o600 });
			return true;
		}
		app.setLoginItemSettings({
			openAtLogin: enabled,
			path: spec.path,
			args: spec.args,
		});
		return app.getLoginItemSettings({ path: spec.path, args: spec.args })
			.openAtLogin;
	}

	function refreshLinuxAutoStart(): void {
		if (process.platform !== "linux" || !existsSync(linuxAutoStartPath()))
			return;
		try {
			setAutoStart(true);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(
				`HostSpan could not refresh Linux autostart: ${message}\n`,
			);
		}
	}

	return { getAutoStart, setAutoStart, refreshLinuxAutoStart };
}
