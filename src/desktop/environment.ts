import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
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

export interface DesktopLaunchSpec {
  path: string;
  args: string[];
}

export function desktopLaunchSpec(input: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  execPath: string;
  mainPath: string;
  appImage?: string;
  linuxDevelopmentExecPath?: string;
  login?: boolean;
  ozonePlatform?: string;
}): DesktopLaunchSpec {
  const args = input.login && input.platform !== "darwin" ? ["--hostspan-login"] : [];
  if (input.platform === "linux" && input.ozonePlatform) args.unshift(`--ozone-platform=${input.ozonePlatform}`);
  const appImage = input.appImage?.trim();
  if (input.platform === "linux" && input.isPackaged && appImage) return { path: appImage, args };
  if (input.isPackaged) return { path: input.execPath, args };
  const execPath =
    input.platform === "linux" && input.linuxDevelopmentExecPath ? input.linuxDevelopmentExecPath : input.execPath;
  return { path: execPath, args: ["--no-sandbox", input.mainPath, ...args] };
}

export function isDesktopLoginLaunch(platform: NodeJS.Platform, argv: string[], wasOpenedAtLogin: boolean): boolean {
  return platform === "darwin" ? wasOpenedAtLogin : argv.includes("--hostspan-login");
}

/**
 * macOS LaunchAgents may own the daemon independently of the GUI login item.
 * Never start it a second time from Electron during desktop login. The agent
 * is installed per user, has RunAtLoad, and refers to the selected profile.
 */
export function macOSDaemonHasLoginSupervisor(configPath: string, launchAgentDir: string): boolean {
  try {
    return readdirSync(launchAgentDir).some((name) => {
      if (!/^io\.hostspan\.[a-z0-9.-]+\.plist$/i.test(name)) return false;
      const content = readFileSync(join(launchAgentDir, name), "utf8");
      return content.includes("<key>RunAtLoad</key>") &&
        content.includes(configPath) &&
        (content.includes("serve --config") || content.includes("<string>serve</string>"));
    });
  } catch {
    return false;
  }
}

export function shouldStartLoginDaemon(platform: NodeJS.Platform, loginLaunch: boolean, supervised: boolean): boolean {
  return loginLaunch && !(platform === "darwin" && supervised);
}

export function desktopDaemonStartupTimeoutMs(platform: NodeJS.Platform, loginLaunch: boolean): number {
  return platform === "darwin" && loginLaunch ? 180_000 : 5_000;
}

/** Refresh live dashboards promptly, but do not poll an idle tray every two seconds. */
export function desktopStatusRefreshIntervalMs(dashboardVisible: boolean): number | null {
  return dashboardVisible ? 2_000 : null;
}

function desktopExecQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function linuxAutoStartContents(spec: DesktopLaunchSpec): string {
  const exec = [spec.path, ...spec.args].map(desktopExecQuote).join(" ");
  return `[Desktop Entry]
Type=Application
Name=HostSpan
Comment=HostSpan tray companion
Exec=${exec}
Terminal=false
X-GNOME-Autostart-enabled=true
`;
}

export function linuxAutoStartPath(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "autostart", "hostspan.desktop");
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
