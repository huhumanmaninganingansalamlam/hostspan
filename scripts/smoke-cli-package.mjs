import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);

function option(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function quoteCmdArgument(value) {
  const text = String(value);
  if (!/[\s&()\[\]{}^=;!'+,`~|<>"]/u.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function run(command, args, options = {}) {
  const npmExecPath = process.env.npm_execpath;
  const npmNodeExecPath = process.env.npm_node_execpath;
  if (command === "pnpm" && npmExecPath && /pnpm/i.test(basename(npmExecPath))) {
    if (/\.[cm]?js$/i.test(npmExecPath)) {
      return run(
        npmNodeExecPath || process.execPath,
        [npmExecPath, ...args],
        options,
      );
    }
    return run(npmExecPath, args, options);
  }
  const useCmd =
    process.platform === "win32" &&
    (command === "pnpm" || command === "npm" || command.toLowerCase().endsWith(".cmd"));
  const executable = useCmd ? (process.env.ComSpec ?? "cmd.exe") : command;
  const commandToken = /^[A-Za-z0-9._-]+$/.test(command) ? command : quoteCmdArgument(command);
  const spawnArgs = useCmd
    ? ["/d", "/c", ["call", commandToken, ...args.map(quoteCmdArgument)].join(" ")]
    : args;
  const result = spawnSync(executable, spawnArgs, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: options.timeout ?? 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}: ${result.error?.message ?? "no spawn error"}`,
    );
  }
  return result.stdout.trim();
}

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const scratch = mkdtempSync(join(tmpdir(), "hostspan-cli-package-smoke-"));

try {
  let tarball = option("--tarball");
  if (tarball) {
    tarball = resolve(root, tarball);
    if (!existsSync(tarball)) throw new Error(`Tarball not found: ${tarball}`);
  } else {
    const outDir = join(scratch, "pack");
    const packed = run("pnpm", ["pack", "--pack-destination", outDir]);
    const lastLine = packed.split(/\r?\n/).filter(Boolean).at(-1);
    if (!lastLine) throw new Error("pnpm pack did not report a tarball path");
    tarball = resolve(root, lastLine);
    if (!existsSync(tarball)) {
      const candidate = join(outDir, basename(lastLine));
      if (!existsSync(candidate)) throw new Error(`Packed tarball not found: ${lastLine}`);
      tarball = candidate;
    }
  }

  const installDir = join(scratch, "install");
  if (process.platform === "win32") {
    mkdirSync(installDir, { recursive: true });
    writeFileSync(
      join(installDir, "package.json"),
      `${JSON.stringify({ name: "hostspan-cli-package-smoke", version: "0.0.0", private: true }, null, 2)}\n`,
    );
    writeFileSync(
      join(installDir, "pnpm-workspace.yaml"),
      [
        "allowBuilds:",
        "  better-sqlite3: true",
        "  koffi: true",
        "  node-pty: true",
        "",
      ].join("\n"),
    );
    run("pnpm", ["--dir", installDir, "add", tarball], { timeout: 180_000 });
  } else {
    run("npm", ["install", "--no-audit", "--no-fund", "--prefix", installDir, tarball], { timeout: 180_000 });
  }

  const bin = join(installDir, "node_modules", ".bin", process.platform === "win32" ? "hostspan.cmd" : "hostspan");
  if (!existsSync(bin)) throw new Error(`Installed HostSpan bin not found: ${bin}`);
  const version = run(bin, ["--version"]);
  if (version !== packageJson.version) {
    throw new Error(`Installed CLI version ${version} does not match package.json ${packageJson.version}`);
  }
  const help = run(bin, ["--help"]);
  if (!help.includes("Commands:")) throw new Error("Installed CLI help output is incomplete");

  const configPath = join(scratch, "config", "config.yaml");
  const env = { HOSTSPAN_CONFIG: configPath };
  run(bin, ["init"], { env });
  const doctor = JSON.parse(run(bin, ["doctor"], { env }));
  if (doctor.ok !== true) throw new Error(`Installed CLI doctor failed: ${JSON.stringify(doctor.checks)}`);
  const snapshot = JSON.parse(run(bin, ["admin", "snapshot", "--recent", "1"], { env }));
  if (snapshot.server_version !== packageJson.version) {
    throw new Error(`Installed admin snapshot version ${snapshot.server_version} does not match package.json ${packageJson.version}`);
  }

  console.log(`HostSpan CLI package smoke passed: ${process.platform}/${process.arch} ${packageJson.version}`);
} catch (error) {
  if (process.env.GITHUB_ACTIONS === "true") {
    const message = (error instanceof Error ? error.stack ?? error.message : String(error))
      .replaceAll("%", "%25")
      .replaceAll("\r", "%0D")
      .replaceAll("\n", "%0A");
    process.stderr.write(`::error title=HostSpan CLI package smoke failed::${message}\n`);
  }
  throw error;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
