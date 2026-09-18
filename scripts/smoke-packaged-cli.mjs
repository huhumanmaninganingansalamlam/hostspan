import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "out");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

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

function packagedPaths(asarPath) {
  const resourcesDir = dirname(asarPath);
  if (process.platform === "darwin") {
    const contentsDir = dirname(resourcesDir);
    return {
      executable: join(contentsDir, "MacOS", "HostSpan"),
      cli: join(asarPath, "dist", "src", "cli", "index.js"),
      nativeModule: join(asarPath, "node_modules", "better-sqlite3"),
    };
  }
  const appDir = dirname(resourcesDir);
  return {
    executable: join(appDir, process.platform === "win32" ? "HostSpan.exe" : "hostspan-desktop"),
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
    throw new Error(`Packaged command failed with exit code ${result.status}: ${args.join(" ")}`);
  }
  return result.stdout.trim();
}

const candidates = findFiles(outDir, "app.asar").filter(
  (path) => path.includes("-unpacked") || path.includes(".app"),
);
if (candidates.length === 0) throw new Error("No unpacked Electron app.asar was found under out/.");

const asarPath = candidates[0];
const { executable, cli, nativeModule } = packagedPaths(asarPath);
if (!existsSync(executable)) throw new Error(`Packaged executable not found: ${executable}`);

const version = run(executable, [cli, "--version"]);
if (version !== packageJson.version) {
  throw new Error(`Packaged CLI version ${version} does not match package.json ${packageJson.version}`);
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
if (sqlite !== "sqlite-ok") throw new Error(`Unexpected SQLite probe output: ${sqlite}`);

const scratch = mkdtempSync(join(tmpdir(), "hostspan-packaged-smoke-"));
try {
  const configPath = join(scratch, "config.yaml");
  run(executable, [cli, "init"], { HOSTSPAN_CONFIG: configPath });
  const snapshotText = run(executable, [cli, "admin", "snapshot", "--recent", "1"], { HOSTSPAN_CONFIG: configPath });
  const snapshot = JSON.parse(snapshotText);
  if (snapshot.server_version !== packageJson.version) {
    throw new Error(`Packaged admin snapshot version mismatch: ${snapshot.server_version}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`Packaged HostSpan smoke passed: ${process.platform}/${process.arch} ${packageJson.version}`);
