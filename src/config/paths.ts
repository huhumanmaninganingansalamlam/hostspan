import { homedir } from "node:os";
import { join } from "node:path";

export function defaultConfigPath(): string {
  if (process.env.HOSTSPAN_CONFIG) return process.env.HOSTSPAN_CONFIG;
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "HostSpan", "config.yaml");
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(configHome, "hostspan", "config.yaml");
}

export function defaultDataDir(): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(localAppData, "HostSpan", "state");
  }
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "hostspan");
}
