import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, clipboard, dialog, ipcMain, type IpcMainInvokeEvent, Menu, nativeImage, Tray } from "electron";
import {
  addLocalWorkspace,
  buildAdminSnapshot,
  removeLocalWorkspace,
  resolveTerminalSession,
  type AddWorkspaceInput,
} from "../admin/snapshot.js";
import { startDaemon, stopDaemon } from "../daemon/control.js";
import { runDoctor, type DoctorReport } from "../diagnostics/doctor.js";
import { runServiceCommand, systemdServiceInstalled } from "../services/systemd.js";
import { loadConfig } from "../config/loader.js";
import { defaultConfigPath } from "../config/paths.js";
import { PtySessionManager } from "../processes/pty-session.js";
import { protectWindowsFile, protectWindowsTree } from "../security/windows-acl.js";
import { desktopLaunchSpec, linuxAutoStartContents, prepareDesktopEnvironment } from "./environment.js";
import {
  installDashboardNavigationGuards,
  isTrustedDashboardIpc,
  requireAttachInput,
  requireBoolean,
  requireDaemonAction,
  requireString,
  requireWorkspaceInput,
} from "./ipc-security.js";
import { ensureDesktopConfig } from "./first-run.js";
import { trayMenuStateKey } from "./tray-menu-state.js";
import { dashboardHtml } from "./dashboard.js";

declare global {
  interface Window {
    hostspan: {
      snapshot(): Promise<unknown>;
      daemon(action: "start" | "stop" | "restart"): Promise<unknown>;
      doctor(): Promise<unknown>;
      chooseWorkspace(): Promise<{ canceled: boolean; path?: string }>;
      addWorkspace(input: AddWorkspaceInput): Promise<unknown>;
      removeWorkspace(targetId: string): Promise<unknown>;
      getAutoStart(): Promise<boolean>;
      setAutoStart(enabled: boolean): Promise<boolean>;
      attach(processId: string, readOnly: boolean): Promise<unknown>;
      copy(text: string): Promise<unknown>;
      onUpdate(callback: (snapshot: unknown) => void): void;
    };
  }
}

const configPath = resolve(defaultConfigPath());
if (process.platform === "linux") app.commandLine.appendSwitch("disable-gpu");
const cliPath = fileURLToPath(new URL("../cli/index.js", import.meta.url));
const mainPath = fileURLToPath(new URL("./main.js", import.meta.url));
const linuxDevelopmentElectronPath = fileURLToPath(new URL("../../../node_modules/electron/dist/electron", import.meta.url));
const preloadPath = fileURLToPath(new URL("./preload.cjs", import.meta.url));
const iconDir = fileURLToPath(new URL("../../../assets/icons/", import.meta.url));
const appIconPath = join(iconDir, "app.png");
const nodePath = process.env.HOSTSPAN_NODE ?? process.execPath;

let tray: Tray | undefined;
let window: BrowserWindow | undefined;
let refreshTimer: NodeJS.Timeout | undefined;
let lastTrayMenuStateKey: string | undefined;
let lastTrayTooltip: string | undefined;
let quitting = false;

function icon() {
  const path = join(iconDir, process.platform === "darwin" ? "hostspanTemplate.png" : "tray.png");
  const branded = nativeImage.createFromPath(path);
  if (!branded.isEmpty()) {
    if (process.platform === "darwin") branded.setTemplateImage(true);
    return branded;
  }
  return nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAA8SURBVHgB7ZAxCgAgDAMv4v9/ubg4OAhFQfBKQ5uQkBByyJxz9oA5QFZUVFS0AjYgC0gB6QAtIAekALSAbAB2FQugKf4BhwAAAABJRU5ErkJggg==",
  );
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function attachCommand(processId: string, readOnly: boolean): { command: string; args: string[] } {
  const cliArgs = [cliPath, "terminal", "attach", "--process", processId, ...(readOnly ? ["--read-only"] : []), "--config", configPath];
  const needsElectronNodeMode = !process.env.HOSTSPAN_NODE && Boolean(process.versions.electron);
  if (process.platform === "win32") {
    const script = `${needsElectronNodeMode ? "$env:ELECTRON_RUN_AS_NODE='1'; " : ""}& ${[nodePath, ...cliArgs].map(quotePowerShell).join(" ")}`;
    if (spawnSync("where.exe", ["wt.exe"], { stdio: "ignore" }).status === 0) {
      return { command: "wt.exe", args: ["powershell.exe", "-NoExit", "-Command", script] };
    }
    return { command: "powershell.exe", args: ["-NoExit", "-Command", script] };
  }
  if (process.platform === "darwin") {
    const shellArgs = [...(needsElectronNodeMode ? ["env", "ELECTRON_RUN_AS_NODE=1"] : []), nodePath, ...cliArgs];
    const shell = shellArgs.map(quoteShell).join(" ");
    return { command: "osascript", args: ["-e", `tell application "Terminal" to do script ${JSON.stringify(shell)}`] };
  }
  const terminal = ["x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal", "xterm"].find(
    (candidate) => spawnSync("which", [candidate], { stdio: "ignore" }).status === 0,
  );
  if (!terminal) throw new Error("No supported graphical terminal launcher was found.");
  const terminalArgs = [...(needsElectronNodeMode ? ["env", "ELECTRON_RUN_AS_NODE=1"] : []), nodePath, ...cliArgs];
  if (terminal === "gnome-terminal") return { command: terminal, args: ["--", ...terminalArgs] };
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

function launchSpec(): { path: string; args: string[] } {
  return desktopLaunchSpec({
    platform: process.platform,
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    mainPath,
    ...(process.env.APPIMAGE ? { appImage: process.env.APPIMAGE } : {}),
    linuxDevelopmentExecPath: linuxDevelopmentElectronPath,
  });
}

function linuxAutoStartPath(): string {
  return join(homedir(), ".config", "autostart", "hostspan.desktop");
}

function getAutoStart(): boolean {
  if (process.platform === "linux") return existsSync(linuxAutoStartPath());
  const spec = launchSpec();
  return app.getLoginItemSettings({ path: spec.path, args: spec.args }).openAtLogin;
}

function setAutoStart(enabled: boolean): boolean {
  const spec = launchSpec();
  if (process.platform === "linux") {
    const path = linuxAutoStartPath();
    if (!enabled) {
      rmSync(path, { force: true });
      return false;
    }
    mkdirSync(join(homedir(), ".config", "autostart"), { recursive: true, mode: 0o700 });
    writeFileSync(path, linuxAutoStartContents(spec), { mode: 0o600 });
    return true;
  }
  app.setLoginItemSettings({ openAtLogin: enabled, path: spec.path, args: spec.args });
  return app.getLoginItemSettings({ path: spec.path, args: spec.args }).openAtLogin;
}

function refreshLinuxAutoStart(): void {
  if (process.platform !== "linux" || !existsSync(linuxAutoStartPath())) return;
  try {
    setAutoStart(true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`HostSpan could not refresh Linux autostart: ${message}\n`);
  }
}

type AdminSnapshot = ReturnType<typeof buildAdminSnapshot>;
type DesktopSnapshot = AdminSnapshot & { auto_start: boolean };

async function snapshot(): Promise<DesktopSnapshot> {
  const base = buildAdminSnapshot(configPath, { recent: 40 });
  return { ...base, auto_start: getAutoStart() };
}

function checkedServiceAction(action: "start" | "stop") {
  const result = runServiceCommand(action);
  if (!result.ok) throw new Error(`systemctl --user ${action} hostspan.service failed: ${result.output || "unknown error"}`);
  return result;
}

async function daemonAction(action: "start" | "stop" | "restart") {
  if (systemdServiceInstalled()) {
    if (action === "start") return checkedServiceAction("start");
    await stopDaemon(configPath);
    return action === "stop" ? checkedServiceAction("stop") : checkedServiceAction("start");
  }
  if (action === "restart") {
    await stopDaemon(configPath);
    return startDaemon(configPath, cliPath, nodePath);
  }
  return action === "start" ? startDaemon(configPath, cliPath, nodePath) : stopDaemon(configPath);
}

async function confirmDaemonRestart(): Promise<boolean> {
  const current = await snapshot();
  const activeNative = current.active_processes.filter((process) => process.backend !== "pty").length;
  const activePty = current.active_processes.filter((process) => process.backend === "pty").length;
  const impact = [
    "HostSpan loads target and policy configuration once when the daemon starts.",
    "Restarting is the intentional boundary that applies workspace additions, removals, and capability changes atomically.",
    activeNative > 0 ? `${activeNative} active native process(es) will be stopped.` : "No active native process will be stopped.",
    activePty > 0 ? `${activePty} durable PTY session(s) will remain alive and reconnect after restart.` : "No live PTY session needs recovery.",
  ].join("\n\n");
  const options = {
    type: activeNative > 0 ? ("warning" as const) : ("question" as const),
    title: "Restart HostSpan",
    message: "Restart HostSpan now?",
    detail: impact,
    buttons: ["Restart", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const result = window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  return result.response === 0;
}

async function restartDaemonWithConfirmation() {
  if (!(await confirmDaemonRestart())) return { cancelled: true };
  const result = await daemonAction("restart");
  await refreshUi();
  return { cancelled: false, result };
}

async function doctorReport(): Promise<DoctorReport> {
  return runDoctor(configPath);
}


function createWindow(): BrowserWindow {
  if (window && !window.isDestroyed()) return window;
  window = new BrowserWindow({
    width: 860,
    height: 720,
    show: false,
    title: "HostSpan",
    ...(process.platform !== "darwin" && existsSync(appIconPath) ? { icon: appIconPath } : {}),
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  installDashboardNavigationGuards(window.webContents);
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(dashboardHtml())}`);
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window?.hide();
    }
  });
  return window;
}

async function refreshUi(): Promise<void> {
  const data = await snapshot();
  const tooltip = `HostSpan ${data.daemon.running ? "running" : "stopped"}`;
  if (tray && tooltip !== lastTrayTooltip) {
    tray.setToolTip(tooltip);
    lastTrayTooltip = tooltip;
  }
  const menuStateKey = trayMenuStateKey(data);
  if (tray && menuStateKey !== lastTrayMenuStateKey) {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `HostSpan ${data.daemon.running ? "Running" : "Stopped"}`, enabled: false },
        { label: "Open Dashboard", click: () => { const w = createWindow(); w.show(); w.focus(); } },
        { type: "separator" },
        data.daemon.running
          ? { label: "Stop HostSpan", click: () => void daemonAction("stop").then(refreshUi) }
          : { label: "Start HostSpan", click: () => void daemonAction("start").then(refreshUi) },
        { label: "Restart HostSpan", enabled: data.daemon.running, click: () => void restartDaemonWithConfirmation() },
        { label: "Start at login", type: "checkbox", checked: data.auto_start, click: (item) => { setAutoStart(item.checked); void refreshUi(); } },
        { type: "separator" },
        { label: `Targets: ${data.targets.length}`, enabled: false },
        { type: "separator" },
        { label: "Quit Tray", click: () => { quitting = true; app.quit(); } },
      ]),
    );
    lastTrayMenuStateKey = menuStateKey;
  }
  if (window && !window.isDestroyed()) window.webContents.send("hostspan:update", data);
}

function assertDashboardSender(event: IpcMainInvokeEvent): void {
  const contents = window && !window.isDestroyed() ? window.webContents : undefined;
  if (!contents || !isTrustedDashboardIpc(event, contents)) throw new Error("desktop IPC rejected from untrusted renderer");
}

ipcMain.handle("hostspan:snapshot", (event) => {
  assertDashboardSender(event);
  return snapshot();
});
ipcMain.handle("hostspan:daemon", async (event, rawAction: unknown) => {
  assertDashboardSender(event);
  const action = requireDaemonAction(rawAction);
  if (action === "restart") return restartDaemonWithConfirmation();
  const result = await daemonAction(action);
  await refreshUi();
  return result;
});
ipcMain.handle("hostspan:doctor", (event) => {
  assertDashboardSender(event);
  return doctorReport();
});
ipcMain.handle("hostspan:choose-workspace", async (event) => {
  assertDashboardSender(event);
  const result = await dialog.showOpenDialog({ title: "Add HostSpan Workspace", properties: ["openDirectory"] });
  return { canceled: result.canceled, ...(result.filePaths[0] ? { path: result.filePaths[0] } : {}) };
});
ipcMain.handle("hostspan:add-workspace", async (event, rawInput: unknown) => {
  assertDashboardSender(event);
  const result = addLocalWorkspace(configPath, requireWorkspaceInput(rawInput));
  await refreshUi();
  return result;
});
ipcMain.handle("hostspan:remove-workspace", async (event, rawTargetId: unknown) => {
  assertDashboardSender(event);
  const result = removeLocalWorkspace(configPath, requireString(rawTargetId, "target_id", 64));
  await refreshUi();
  return result;
});
ipcMain.handle("hostspan:get-autostart", (event) => {
  assertDashboardSender(event);
  return getAutoStart();
});
ipcMain.handle("hostspan:set-autostart", (event, rawEnabled: unknown) => {
  assertDashboardSender(event);
  return setAutoStart(requireBoolean(rawEnabled, "autostart"));
});
ipcMain.handle("hostspan:attach", (event, rawInput: unknown) => {
  assertDashboardSender(event);
  const input = requireAttachInput(rawInput);
  const config = loadConfig(configPath);
  if (!config.terminal) throw new Error("terminal support is not configured");
  const session = resolveTerminalSession(configPath, input.processId);
  if (!session) throw new Error(`terminal process not found: ${input.processId}`);
  const manager = new PtySessionManager(config.server.data_dir, config.terminal);
  if (!manager.inspectSync(session.session).exists) throw new Error("PTY session is no longer live");
  openAttach(input.processId, input.readOnly);
  return { ok: true };
});
ipcMain.handle("hostspan:copy", (event, rawText: unknown) => {
  assertDashboardSender(event);
  clipboard.writeText(requireString(rawText, "clipboard text", 1_048_576));
  return { ok: true };
});

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => { const w = createWindow(); w.show(); w.focus(); });
app.on("window-all-closed", () => undefined);

void app.whenReady().then(async () => {
  try {
    prepareDesktopEnvironment();
    ensureDesktopConfig(configPath);
    refreshLinuxAutoStart();
    if (process.platform === "win32") {
      const config = loadConfig(configPath);
      protectWindowsFile(configPath);
      protectWindowsFile(`${configPath}.bak`);
      protectWindowsFile(join(dirname(configPath), "oauth-approval-secret"));
      protectWindowsTree(config.server.data_dir);
    }
    if (process.platform === "darwin") app.dock?.hide();
    tray = new Tray(icon());
    tray.on("click", () => {
      const w = createWindow();
      if (w.isVisible()) w.hide();
      else {
        w.show();
        w.focus();
      }
    });
    await refreshUi();
    refreshTimer = setInterval(() => void refreshUi().catch(() => undefined), 2_000);
    refreshTimer.unref();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox("HostSpan could not start", message);
    app.quit();
  }
});

app.on("before-quit", () => {
  quitting = true;
  if (refreshTimer) clearInterval(refreshTimer);
});
