import {
	existsSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listPackage } from "@electron/asar";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function option(name, fallback) {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : fallback;
}

const targetPlatform = option("--platform", process.platform);
const targetArch = option("--arch", process.arch);
const outDir = resolve(root, option("--out-dir", "out"));
if (!["linux", "darwin", "win32"].includes(targetPlatform)) {
	throw new Error(`Unsupported smoke platform: ${targetPlatform}`);
}
if (!["x64", "arm64"].includes(targetArch)) {
	throw new Error(`Unsupported smoke architecture: ${targetArch}`);
}
const packageJson = JSON.parse(
	readFileSync(join(root, "package.json"), "utf8"),
);

function findFiles(dir, name, results = []) {
	if (!existsSync(dir)) return results;
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) continue;
		if (stat.isDirectory()) findFiles(path, name, results);
		else if (entry === name) results.push(path);
	}
	return results;
}

function packagedPaths(asarPath, platform) {
	const resourcesDir = dirname(asarPath);
	if (platform === "darwin") {
		const contentsDir = dirname(resourcesDir);
		return {
			executable: join(contentsDir, "MacOS", "HostSpan"),
			cli: join(asarPath, "dist", "src", "cli", "index.js"),
			nativeModule: join(asarPath, "node_modules", "better-sqlite3"),
		};
	}
	const appDir = dirname(resourcesDir);
	return {
		executable: join(
			appDir,
			platform === "win32" ? "HostSpan.exe" : "hostspan-desktop",
		),
		cli: join(asarPath, "dist", "src", "cli", "index.js"),
		nativeModule: join(asarPath, "node_modules", "better-sqlite3"),
	};
}

function run(executable, args, extraEnv = {}) {
	const result = spawnSync(executable, args, {
		encoding: "utf8",
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...extraEnv },
		windowsHide: true,
	});
	if (result.status !== 0) {
		process.stderr.write(result.stdout ?? "");
		process.stderr.write(result.stderr ?? "");
		throw new Error(
			`Packaged command failed with exit code ${result.status}: ${args.join(" ")}`,
		);
	}
	return result.stdout.trim();
}

function smokeWindowsPackage(executable, asarPath, arch) {
	const executableHeader = readFileSync(executable).subarray(0, 2).toString("ascii");
	if (executableHeader !== "MZ") {
		throw new Error(`Packaged Windows executable is not a PE image: ${executable}`);
	}
	const entries = new Set(listPackage(asarPath).map((entry) => entry.replaceAll("\\", "/")));
	if (!entries.has("/dist/src/cli/index.js"))
		throw new Error("Packaged ASAR is missing the HostSpan CLI entrypoint");
	if (!entries.has("/dist/src/desktop/main.js"))
		throw new Error("Packaged ASAR is missing the HostSpan desktop entrypoint");
	if (!entries.has("/assets/icons/app.ico"))
		throw new Error("Packaged ASAR is missing the Windows application icon payload");

	const nativeBinding = join(
		`${asarPath}.unpacked`,
		"node_modules",
		"better-sqlite3",
		"prebuilds",
		`win32-${arch}.node`,
	);
	if (!existsSync(nativeBinding))
		throw new Error(
			`Packaged Windows native binding not found: ${nativeBinding}`,
		);
}

const candidates = findFiles(outDir, "app.asar").filter(
	(path) => {
		if (targetPlatform === "win32") return path.includes("win-unpacked");
		if (targetPlatform === "darwin") return path.includes(".app");
		return path.includes("linux-unpacked");
	},
);
if (candidates.length === 0)
	throw new Error(`No ${targetPlatform}/${targetArch} Electron app.asar was found under ${outDir}.`);

const asarPath = candidates[0];
const { executable, cli, nativeModule } = packagedPaths(asarPath, targetPlatform);
if (!existsSync(executable))
	throw new Error(`Packaged executable not found: ${executable}`);

if (targetPlatform !== "win32") {
	if (targetPlatform !== process.platform || targetArch !== process.arch) {
		throw new Error(
			`Executable smoke requires the target runtime (${targetPlatform}/${targetArch}); current runtime is ${process.platform}/${process.arch}.`,
		);
	}
	const version = run(executable, [cli, "--version"]);
	if (version !== packageJson.version) {
		throw new Error(
			`Packaged CLI version ${version} does not match package.json ${packageJson.version}`,
		);
	}

	const nativeProbe = [
		`const Database=require(${JSON.stringify(nativeModule)});`,
		"const db=new Database(':memory:');",
		"const row=db.prepare('select 1 as ok').get();",
		"db.close();",
		"if(row.ok!==1) process.exit(3);",
		"process.stdout.write('sqlite-ok');",
	].join("");
	const sqlite = run(executable, ["-e", nativeProbe]);
	if (sqlite !== "sqlite-ok")
		throw new Error(`Unexpected SQLite probe output: ${sqlite}`);

	const scratch = mkdtempSync(join(tmpdir(), "hostspan-packaged-smoke-"));
	try {
		const configPath = join(scratch, "config.yaml");
		run(executable, [cli, "init"], { HOSTSPAN_CONFIG: configPath });
		const snapshotText = run(
			executable,
			[cli, "admin", "snapshot", "--recent", "1"],
			{ HOSTSPAN_CONFIG: configPath },
		);
		const snapshot = JSON.parse(snapshotText);
		if (snapshot.server_version !== packageJson.version) {
			throw new Error(
				`Packaged admin snapshot version mismatch: ${snapshot.server_version}`,
			);
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}

	console.log(
		`Packaged HostSpan smoke passed: ${targetPlatform}/${targetArch} ${packageJson.version}`,
	);
}

if (targetPlatform === "win32") {
	smokeWindowsPackage(executable, asarPath, targetArch);
	console.log(
		`Packaged HostSpan Windows shell smoke passed: ${targetArch} ${packageJson.version}`,
	);
}
