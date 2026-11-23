import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export function cachedExecutableProbe(
	command: string,
	args: string[] = ["--version"],
	ttlMs = 5_000,
): () => boolean {
	let checkedAt = 0;
	let ready = false;
	return () => {
		const now = Date.now();
		if (checkedAt === 0 || now - checkedAt >= ttlMs) {
			ready =
				spawnSync(command, args, {
					stdio: "ignore",
					timeout: 5_000,
					windowsHide: true,
				}).status === 0;
			checkedAt = now;
		}
		return ready;
	};
}

export function cachedNodeModuleProbe(
	specifier: string,
	ttlMs = 5_000,
): () => boolean {
	const resolvedUrl = pathToFileURL(
		createRequire(import.meta.url).resolve(specifier),
	).href;
	let checkedAt = 0;
	let ready = false;
	return () => {
		const now = Date.now();
		if (checkedAt === 0 || now - checkedAt >= ttlMs) {
			const script = `import(${JSON.stringify(resolvedUrl)}).then(()=>process.exit(0)).catch(()=>process.exit(1))`;
			ready =
				["linux", "darwin", "win32"].includes(process.platform) &&
				spawnSync(process.execPath, ["-e", script], {
					stdio: "ignore",
					timeout: 5_000,
					windowsHide: true,
					env: {
						...process.env,
						...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
					},
				}).status === 0;
			checkedAt = now;
		}
		return ready;
	};
}
