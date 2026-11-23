import { spawn, spawnSync } from "node:child_process";

export interface TerminalLauncherDependencies {
	cliPath: string;
	nodePath: string;
	getConfigPath(): string;
}

export function createTerminalLauncher({
	cliPath,
	nodePath,
	getConfigPath,
}: TerminalLauncherDependencies) {
	function quoteShell(value: string): string {
		return `'${value.replaceAll("'", `'"'"'`)}'`;
	}

	function quotePowerShell(value: string): string {
		return `'${value.replaceAll("'", "''")}'`;
	}

	function attachCommand(
		processId: string,
		readOnly: boolean,
	): { command: string; args: string[] } {
		const configPath = getConfigPath();
		const cliArgs = [
			cliPath,
			"terminal",
			"attach",
			"--process",
			processId,
			...(readOnly ? ["--read-only"] : []),
			"--config",
			configPath,
		];
		const needsElectronNodeMode =
			!process.env.HOSTSPAN_NODE && Boolean(process.versions.electron);
		if (process.platform === "win32") {
			const script = `${needsElectronNodeMode ? "$env:ELECTRON_RUN_AS_NODE='1'; " : ""}& ${[nodePath, ...cliArgs].map(quotePowerShell).join(" ")}`;
			if (
				spawnSync("where.exe", ["wt.exe"], { stdio: "ignore" }).status === 0
			) {
				return {
					command: "wt.exe",
					args: ["powershell.exe", "-NoExit", "-Command", script],
				};
			}
			return {
				command: "powershell.exe",
				args: ["-NoExit", "-Command", script],
			};
		}
		if (process.platform === "darwin") {
			const shellArgs = [
				...(needsElectronNodeMode ? ["env", "ELECTRON_RUN_AS_NODE=1"] : []),
				nodePath,
				...cliArgs,
			];
			const shell = shellArgs.map(quoteShell).join(" ");
			return {
				command: "osascript",
				args: [
					"-e",
					`tell application "Terminal" to do script ${JSON.stringify(shell)}`,
				],
			};
		}
		const terminal = [
			"x-terminal-emulator",
			"gnome-terminal",
			"konsole",
			"xfce4-terminal",
			"xterm",
		].find(
			(candidate) =>
				spawnSync("which", [candidate], { stdio: "ignore" }).status === 0,
		);
		if (!terminal)
			throw new Error("No supported graphical terminal launcher was found.");
		const terminalArgs = [
			...(needsElectronNodeMode ? ["env", "ELECTRON_RUN_AS_NODE=1"] : []),
			nodePath,
			...cliArgs,
		];
		if (terminal === "gnome-terminal")
			return { command: terminal, args: ["--", ...terminalArgs] };
		return { command: terminal, args: ["-e", ...terminalArgs] };
	}

	function openAttach(processId: string, readOnly: boolean): void {
		const request = attachCommand(processId, readOnly);
		const child = spawn(request.command, request.args, {
			detached: true,
			stdio: "ignore",
			env: process.env,
		});
		child.unref();
	}

	return { openAttach };
}
