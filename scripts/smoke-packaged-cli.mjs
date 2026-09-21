import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listPackage } from "@electron/asar";
import { v7 as uuidv7 } from "uuid";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function option(name, fallback) {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : fallback;
}

const targetPlatform = option("--platform", process.platform);
const targetArch = option("--arch", process.arch);
const outDir = resolve(root, option("--out-dir", "out"));
const installedDir = option("--installed-dir");
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
			ptyModule: join(asarPath, "node_modules", "node-pty"),
			ripgrepModule: join(asarPath, "dist", "src", "files", "ripgrep.js"),
			jobModule: join(asarPath, "dist", "src", "processes", "windows-job-process.js"),
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
		ptyModule: join(asarPath, "node_modules", "node-pty"),
		ripgrepModule: join(asarPath, "dist", "src", "files", "ripgrep.js"),
		jobModule: join(asarPath, "dist", "src", "processes", "windows-job-process.js"),
	};
}

function run(executable, args, extraEnv = {}) {
	const result = spawnSync(executable, args, {
		encoding: "utf8",
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...extraEnv },
		windowsHide: true,
		timeout: 120_000,
		maxBuffer: 8 * 1024 * 1024,
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
	const ptyBinding = join(
		`${asarPath}.unpacked`,
		"node_modules",
		"node-pty",
		"prebuilds",
		`win32-${arch}`,
		"conpty.node",
	);
	if (!existsSync(ptyBinding))
		throw new Error(`Packaged Windows ConPTY binding not found: ${ptyBinding}`);
	const ripgrepBinary = join(
		`${asarPath}.unpacked`,
		"node_modules",
		"@vscode",
		`ripgrep-win32-${arch}`,
		"bin",
		"rg.exe",
	);
	if (!existsSync(ripgrepBinary))
		throw new Error(`Packaged Windows ripgrep binary not found: ${ripgrepBinary}`);
}

function smokePackagedRuntime(executable, cli, nativeModule, ptyModule, ripgrepModule, jobModule) {
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

	const ptyProbe = [
		`const pty=require(${JSON.stringify(ptyModule)});`,
		"if(typeof pty.spawn!=='function') process.exit(4);",
		"let output='';",
		"const win=process.platform==='win32';",
		"const program=win?(process.env.ComSpec||process.env.COMSPEC||'cmd.exe'):'/bin/sh';",
		"const args=win?['/d','/s','/c','echo pty-spawn-ok']:['-lc','printf pty-spawn-ok'];",
		"const child=pty.spawn(program,args,{name:'xterm-256color',cols:80,rows:24,cwd:process.cwd(),env:process.env});",
		"const timer=setTimeout(()=>process.exit(7),5000);",
		"child.onData(d=>{output+=d;});",
		"child.onExit(e=>{clearTimeout(timer);if(e.exitCode!==0||!output.includes('pty-spawn-ok')){console.error(JSON.stringify({exit:e,output}));process.exit(8);}process.stdout.write('pty-ok');process.exit(0);});",
	].join("");
	const pty = run(executable, ["-e", ptyProbe]);
	if (pty !== "pty-ok")
		throw new Error(`Unexpected PTY probe output: ${pty}`);

	const ripgrepProbe = [
		"const {spawnSync}=require('node:child_process');",
		"const {pathToFileURL}=require('node:url');",
		`import(pathToFileURL(${JSON.stringify(ripgrepModule)}).href).then(m=>{`,
		"const r=spawnSync(m.ripgrepExecutable(),['--version'],{encoding:'utf8',windowsHide:true});",
		"if(r.status!==0||!String(r.stdout||'').startsWith('ripgrep ')){console.error(r.stderr||r.stdout||String(r.error||''));process.exit(9);}",
		"process.stdout.write('ripgrep-ok');",
		"}).catch(e=>{console.error(e);process.exit(10);});",
	].join("");
	const ripgrep = run(executable, ["-e", ripgrepProbe]);
	if (ripgrep !== "ripgrep-ok")
		throw new Error(`Unexpected ripgrep probe output: ${ripgrep}`);

	if (targetPlatform === "win32") {
		const jobProbe = [
			"const {pathToFileURL}=require('node:url');",
			`import(pathToFileURL(${JSON.stringify(jobModule)}).href).then(m=>{`,
			"const r=m.windowsJobObjectProbe();",
			"if(!r.ok){console.error(r.details);process.exit(5);}",
			"process.stdout.write('job-ok');",
			"}).catch(e=>{console.error(e);process.exit(6);});",
		].join("");
		const job = run(executable, ["-e", jobProbe]);
		if (job !== "job-ok") throw new Error(`Unexpected Job Object probe output: ${job}`);
	}

	const scratch = mkdtempSync(join(tmpdir(), "hostspan-packaged-smoke-"));
	try {
		const configPath = join(scratch, "config.yaml");
		const targetRoot = join(scratch, "target");
		const smokeEnv = {
			HOSTSPAN_CONFIG: configPath,
			...(targetPlatform === "win32"
				? {
					APPDATA: join(scratch, "app-data"),
					LOCALAPPDATA: join(scratch, "local-app-data"),
				}
				: {
					XDG_CONFIG_HOME: join(scratch, "config-home"),
					XDG_STATE_HOME: join(scratch, "state-home"),
				}),
		};
		mkdirSync(targetRoot);
		writeFileSync(join(targetRoot, "README.txt"), "packaged smoke\n");
		const gitInit = spawnSync("git", ["-C", targetRoot, "init", "-q"], {
			encoding: "utf8",
			windowsHide: true,
		});
		if (gitInit.status !== 0) {
			throw new Error(
				["Packaged smoke could not initialize Git target: ", gitInit.stderr || gitInit.stdout].join(""),
			);
		}
		run(executable, [cli, "init"], smokeEnv);
		run(
			executable,
			[
				cli,
				"targets",
				"add",
				"--id",
				"packaged-smoke",
				"--root",
				targetRoot,
				"--capabilities",
				"read,write,exec,git,terminal",
				"--exec-profile",
				"native-dev",
			],
			smokeEnv,
		);
		const doctor = JSON.parse(
			run(executable, [cli, "doctor"], smokeEnv),
		);
		if (doctor.ok !== true) {
			throw new Error(
				`Packaged Doctor failed: ${JSON.stringify(doctor.checks)}`,
			);
		}
		const workflow = JSON.parse(
			run(executable, [cli, "smoke", "--target", "packaged-smoke"], {
				...smokeEnv,
			}),
		);
		if (workflow.ok !== true) {
			throw new Error(
				["Packaged full smoke failed: ", JSON.stringify(workflow.steps)].join(""),
			);
		}

		const ptyStartKey = uuidv7();
		const ptyWriteKey = uuidv7();
		const hostspanPtyProbe = [
			"const {pathToFileURL}=require('node:url');",
			`import(pathToFileURL(${JSON.stringify(cli)}).href).then(async m=>{`,
			`const rt=m.createRuntime(${JSON.stringify(configPath)});`,
			"try{",
			"const ttyArgv=process.platform==='win32'?['cmd.exe','/V:ON','/Q','/D','/C','echo READY & set /p name= & echo HELLO !name!']:['/bin/sh','-lc','printf \"READY\\n\"; IFS= read -r name; printf \"HELLO %s\\n\" \"$name\"'];",
			`const started=await rt.handlers.process_start({idempotency_key:${JSON.stringify(ptyStartKey)},target_id:'packaged-smoke',argv:ttyArgv,cwd:'.',env:{},wait_ms:700,deadline_ms:10000,max_output_bytes:65536,tty:true,columns:100,rows:30},'packaged_pty_start');`,
			"let transcript=String(started.stdout||'');",
			`let current=await rt.handlers.process_write({idempotency_key:${JSON.stringify(ptyWriteKey)},process_id:String(started.process_id),chars:'packaged',control_keys:['Enter'],columns:132,rows:42,stdout_cursor:Number(started.next_stdout_cursor||0),wait_ms:1000,max_bytes:65536},'packaged_pty_write');`,
			"transcript+=String(current.stdout||'');",
			"const attempts=process.platform==='win32'?24:8;",
			"for(let i=0;i<attempts&&(current.state==='running'||!transcript.includes('HELLO packaged'));i++){current=await rt.handlers.process_poll({process_id:String(started.process_id),stdout_cursor:Number(current.next_stdout_cursor||0),stderr_cursor:0,wait_ms:500,max_bytes:65536},'packaged_pty_poll_'+i);transcript+=String(current.stdout||'');}",
			"if(current.state!=='succeeded'||!transcript.includes('HELLO packaged')){console.error(JSON.stringify({started,current,transcript}));process.exitCode=11;return;}",
			"process.stdout.write('hostspan-pty-ok');",
			"}finally{await rt.close();}",
			"}).catch(e=>{console.error(e?.stack||String(e));process.exit(12);});",
		].join("");
		const hostspanPty = run(executable, ["-e", hostspanPtyProbe], {
			...smokeEnv,
		});
		if (hostspanPty !== "hostspan-pty-ok") {
			throw new Error(`Unexpected HostSpan PTY lifecycle probe output: ${hostspanPty}`);
		}

		const snapshotText = run(
			executable,
			[cli, "admin", "snapshot", "--recent", "1"],
			smokeEnv,
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

const candidates = installedDir
	? (() => {
			const installedRoot = resolve(root, installedDir);
			const asarPath =
				targetPlatform === "darwin"
					? join(installedRoot, "Contents", "Resources", "app.asar")
					: join(installedRoot, "resources", "app.asar");
			return existsSync(asarPath) ? [asarPath] : [];
		})()
	: findFiles(outDir, "app.asar").filter((path) => {
			if (targetPlatform === "win32") return path.includes("win-unpacked");
			if (targetPlatform === "darwin") return path.includes(".app");
			return path.includes("linux-unpacked");
		});
if (candidates.length === 0)
	throw new Error(
		installedDir
			? `No ${targetPlatform}/${targetArch} installed Electron app.asar was found under ${installedDir}.`
			: `No ${targetPlatform}/${targetArch} Electron app.asar was found under ${outDir}.`,
	);

const asarPath = candidates[0];
const { executable, cli, nativeModule, ptyModule, ripgrepModule, jobModule } = packagedPaths(asarPath, targetPlatform);
if (!existsSync(executable))
	throw new Error(`Packaged executable not found: ${executable}`);

if (targetPlatform === "win32") {
	smokeWindowsPackage(executable, asarPath, targetArch);
	if (targetPlatform !== process.platform || targetArch !== process.arch) {
		console.log(
			`Packaged HostSpan Windows static smoke passed: ${targetArch} ${packageJson.version}`,
		);
	}
}

if (targetPlatform === process.platform && targetArch === process.arch) {
	smokePackagedRuntime(executable, cli, nativeModule, ptyModule, ripgrepModule, jobModule);
} else if (targetPlatform !== "win32") {
	throw new Error(
		`Executable smoke requires the target runtime (${targetPlatform}/${targetArch}); current runtime is ${process.platform}/${process.arch}.`,
	);
}
