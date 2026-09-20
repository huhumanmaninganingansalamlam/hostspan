import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const PATH_MARKER = "__HOSTSPAN_PATH__=";

export function mergePathValues(...values: Array<string | undefined>): string {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const value of values) {
    for (const entry of (value ?? "").split(delimiter)) {
      const normalized = entry.trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      entries.push(normalized);
    }
  }
  return entries.join(delimiter);
}

export function extractMarkedPath(stdout: string): string | undefined {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.startsWith(PATH_MARKER));
  const value = line?.slice(PATH_MARKER.length).trim();
  return value || undefined;
}

function commonMacDevPaths(home: string): string {
  return [
    join(home, ".local", "bin"),
    join(home, ".cargo", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".asdf", "shims"),
    join(home, ".local", "share", "mise", "shims"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(delimiter);
}

export function prepareDesktopEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  if (process.platform !== "darwin") return;

  const fallback = mergePathValues(env.PATH, commonMacDevPaths(homedir()));
  const shell = env.SHELL || "/bin/zsh";
  const markerCommand = `printf '\\n${PATH_MARKER}%s\\n' "$PATH"`;
  const result = spawnSync(shell, ["-ilc", markerCommand], {
    encoding: "utf8",
    env: { ...env, PATH: fallback, TERM: "dumb" },
    timeout: 2_000,
    windowsHide: true,
  });
  const loginPath = result.status === 0 ? extractMarkedPath(result.stdout) : undefined;
  env.PATH = mergePathValues(loginPath, fallback);
}
