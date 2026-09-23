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
import { startDaemon, stopDaemon } from "../cli/daemon.js";
import { runDoctor, type DoctorReport } from "../cli/doctor.js";
import { runServiceCommand, systemdServiceInstalled } from "../cli/service.js";
import { loadConfig } from "../config/loader.js";
import { defaultConfigPath } from "../config/paths.js";
import type { Capability } from "../config/schema.js";
import { PtySessionManager } from "../processes/pty-session.js";
import { protectWindowsFile, protectWindowsTree } from "../security/windows-acl.js";
import { desktopLaunchSpec, linuxAutoStartContents, prepareDesktopEnvironment } from "./environment.js";
import {
  DASHBOARD_CSP,
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
import { DEFAULT_WORKSPACE_CAPABILITIES, defaultWorkspaceCapability } from "./workspace-capabilities.js";

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

function normalizedDesktopCapabilities(input: Capability[]): Capability[] {
  const capabilities = [...new Set(input)];
  if (capabilities.includes("terminal") && !capabilities.includes("exec")) capabilities.push("exec");
  return capabilities;
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

function addWorkspace(input: AddWorkspaceInput) {
  const capabilities = normalizedDesktopCapabilities(input.capabilities);
  return addLocalWorkspace(configPath, { ...input, capabilities });
}

function removeWorkspace(targetId: string) {
  return removeLocalWorkspace(configPath, targetId);
}

function html(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${DASHBOARD_CSP}">
<title>HostSpan</title>
<style>
:root{color-scheme:dark}body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#101218;color:#e9edf5}main{padding:16px;max-width:940px;margin:auto}h1{font-size:20px;margin:0}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.grow{flex:1}.card{background:#181c25;border:1px solid #2b3241;border-radius:10px;padding:12px;margin:10px 0}.cardhead{display:flex;align-items:center;gap:8px;margin-bottom:8px}.cardhead b{flex:1}button{background:#2b66f6;color:white;border:0;border-radius:7px;padding:7px 10px;cursor:pointer}button.secondary{background:#31394b}button.danger{background:#71323a}button:disabled{opacity:.45;cursor:default}.ok{color:#70dc9b}.bad{color:#ff8080}.warn{color:#f2c56b}.muted{color:#9aa6b8;font-size:12px}.message{min-height:18px;margin-top:6px;font-size:12px}.message.error{color:#ff8080}table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:6px;border-bottom:1px solid #2b3241;vertical-align:top}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;word-break:break-all}.scroll{max-height:230px;overflow:auto}.pill{padding:2px 6px;border-radius:10px;background:#283044;font-size:11px}.caps{display:flex;gap:8px;flex-wrap:wrap}.caps label{font-size:12px}.activity{padding:5px 0;border-bottom:1px solid #242a37}dialog{width:min(560px,90vw);border:1px solid #394359;border-radius:10px;background:#181c25;color:#e9edf5;padding:16px}dialog::backdrop{background:#0008}.field{margin:10px 0}.field label.title{display:block;font-size:12px;color:#9aa6b8;margin-bottom:4px}.field input[type=text]{box-sizing:border-box;width:100%;padding:8px;border:1px solid #3b455a;border-radius:6px;background:#11151d;color:#e9edf5}.pathrow{display:flex;gap:6px}.pathrow input{flex:1}
</style>
</head><body><main>
<div class="row"><h1 class="grow">HostSpan</h1><button id="doctor" class="secondary">Run Doctor</button><button id="restart" class="secondary">Restart</button><button id="refresh" class="secondary">Refresh</button><button id="toggle">Start</button></div>
<div id="message" class="message"></div>
<div id="summary" class="card">Loading…</div>
<div class="card"><div class="cardhead"><b>Health</b><span id="healthState" class="muted">Run Doctor for full checks.</span></div><div id="health"></div></div>
<div class="card"><div class="cardhead"><b>Targets / Workspaces</b><button id="addWorkspace">Add Workspace</button></div><div id="targets"></div></div>
<div class="card"><div class="cardhead"><b>Current activity</b><span id="activityCount" class="muted"></span></div><div id="activity"></div></div>
<div class="card"><div class="cardhead"><b>Interactive terminals</b></div><div id="terminals"></div></div>
<div class="card"><div class="cardhead"><b>Recent calls</b></div><div id="calls" class="scroll"></div></div>
<dialog id="workspaceDialog">
  <form id="workspaceForm">
    <div class="cardhead"><b>Add Workspace</b></div>
    <div class="field"><label class="title">Folder</label><div class="pathrow"><input id="wsPath" type="text" readonly required><button id="browse" type="button" class="secondary">Browse</button></div></div>
    <div class="field"><label class="title">Target ID <span class="muted">(optional)</span></label><input id="wsId" type="text" placeholder="Auto-generated from folder name"></div>
    <div class="field"><label class="title">Label <span class="muted">(optional)</span></label><input id="wsLabel" type="text" placeholder="Uses folder name"></div>
    <div class="field"><label class="title">Capabilities</label><div class="caps">
      <label><input type="checkbox" data-cap="read"${defaultWorkspaceCapability("read") ? " checked" : ""}> Read</label>
      <label><input type="checkbox" data-cap="write"${defaultWorkspaceCapability("write") ? " checked" : ""}> Write</label>
      <label><input type="checkbox" data-cap="exec"${defaultWorkspaceCapability("exec") ? " checked" : ""}> Exec</label>
      <label><input type="checkbox" data-cap="git"${defaultWorkspaceCapability("git") ? " checked" : ""}> Git</label>
      <label><input type="checkbox" data-cap="terminal"${defaultWorkspaceCapability("terminal") ? " checked" : ""}> Interactive terminal</label>
    </div><div class="muted" style="margin-top:6px">Interactive terminal grants full native terminal authority as your OS user.</div></div>
    <div class="row" style="justify-content:flex-end"><button id="cancelWorkspace" type="button" class="secondary">Cancel</button><button id="saveWorkspace" type="button">Save</button></div>
  </form>
</dialog>
</main>
<script>
let snapshot;
const defaultWorkspaceCapabilities=${JSON.stringify(DEFAULT_WORKSPACE_CAPABILITIES)};
const e=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const short=v=>String(v??'').slice(0,12);
function setMessage(message,error=false){const el=e('message');el.textContent=message??'';el.className='message'+(error?' error':'')}
function targetIdFromPath(path){const part=String(path).split(/[\\/]/).filter(Boolean).pop()||'workspace';return part.toLowerCase().replace(/[^a-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,64)||'workspace'}
function folderName(path){return String(path).split(/[\\/]/).filter(Boolean).pop()||'workspace'}
function resetWorkspaceDialog(){
  e('workspaceForm').reset();
  e('wsPath').value='';
  e('wsId').value='';
  e('wsLabel').value='';
  e('wsId').placeholder='Auto-generated from folder name';
  e('wsLabel').placeholder='Uses folder name';
  document.querySelectorAll('[data-cap]').forEach(input=>{input.checked=defaultWorkspaceCapabilities.includes(input.dataset.cap)});
}
function updateWorkspaceSuggestions(path){
  e('wsId').placeholder='Auto: '+targetIdFromPath(path);
  e('wsLabel').placeholder='Auto: '+folderName(path);
}
function render(s){
  snapshot=s;
  const running=!!s.daemon?.running;
  e('toggle').textContent=running?'Stop':'Start';
  e('toggle').className=running?'secondary':'';
  e('restart').disabled=!running;
  e('summary').innerHTML='<div class="row"><span class="pill '+(running?'ok':'bad')+'">'+(running?'RUNNING':'STOPPED')+'</span><b>'+esc(s.server_version)+'</b><span class="muted">'+esc(s.toolset_version)+' · policy '+esc(s.policy_epoch)+' · pid '+esc(s.daemon?.pid??'-')+'</span><span class="grow"></span><label class="muted"><input id="autoStart" type="checkbox" '+(s.auto_start?'checked':'')+'> Start at login</label></div><div class="muted">'+esc(s.listen?.host)+':'+esc(s.listen?.port)+' · active processes '+esc(s.active_process_count)+'</div>';
  e('autoStart').onchange=async ev=>{try{await window.hostspan.setAutoStart(ev.target.checked);await refresh()}catch(err){setMessage(err.message||String(err),true)}};
  e('targets').innerHTML=s.targets.length?'<table><tr><th>ID</th><th>Root</th><th>Capabilities</th><th>Ready</th><th></th></tr>'+s.targets.map(t=>'<tr><td><b>'+esc(t.target_id)+'</b><div class="muted">'+esc(t.label)+'</div></td><td><code>'+esc(t.root)+'</code></td><td>'+esc(t.capabilities.join(', '))+'</td><td>'+(t.ready?'✓':'✕')+'</td><td><button class="danger" data-remove-target="'+esc(t.target_id)+'">Remove</button></td></tr>').join('')+'</table>':'<div class="muted">No workspaces configured.</div>';
  const requests=s.active_requests||[],processes=s.active_processes||[];
  e('activityCount').textContent=(requests.length+processes.length)+' active';
  e('activity').innerHTML=(requests.length||processes.length)?processes.map(p=>'<div class="activity"><span class="pill">'+esc(p.state)+'</span> <b>'+esc(p.target_id)+'</b> <code>'+esc(short(p.process_id))+'</code> <span class="muted">'+esc(p.backend)+'</span></div>').join('')+requests.map(r=>'<div class="activity"><span class="pill">request</span> <b>'+esc(r.metadata?.tool??'unknown')+'</b> <span class="muted">'+esc(r.metadata?.target_id??'')+' '+esc(short(r.request_id))+'</span></div>').join(''):'<div class="muted">No active work.</div>';
  e('terminals').innerHTML=s.terminal.sessions.length?'<table><tr><th>Process</th><th>Target</th><th>State</th><th></th></tr>'+s.terminal.sessions.map(t=>'<tr><td><code>'+esc(t.process_id)+'</code></td><td>'+esc(t.target_id)+'</td><td>'+esc(t.state)+(t.live?' · live':'')+'</td><td><button data-attach="'+esc(t.process_id)+'">Attach</button> <button class="secondary" data-readonly="'+esc(t.process_id)+'">Read only</button></td></tr>').join('')+'</table>':'<div class="muted">No interactive PTY sessions.</div>';
  e('calls').innerHTML=s.recent_calls.length?s.recent_calls.map(c=>'<div class="activity"><span class="muted">'+esc(c.timestamp)+'</span> <b>'+esc(c.event_type)+'</b> <code>'+esc(c.metadata?.tool??'')+'</code> <span class="'+(c.metadata?.error_code?'bad':'muted')+'">'+esc(c.metadata?.error_code??'')+'</span></div>').join(''):'<div class="muted">No recent calls.</div>';
}
function renderHealth(report){
  e('healthState').textContent=report.ok?'All required checks passed.':'One or more required checks failed.';
  e('healthState').className=report.ok?'ok':'bad';
  e('health').innerHTML='<table><tr><th>Check</th><th>Status</th><th>Details</th></tr>'+report.checks.map(c=>'<tr><td>'+esc(c.name)+'</td><td class="'+(c.status==='pass'?'ok':c.status==='warn'?'warn':'bad')+'">'+esc(c.status)+'</td><td class="muted">'+esc(c.details)+'</td></tr>').join('')+'</table>';
}
async function refresh(){try{render(await window.hostspan.snapshot())}catch(err){setMessage(err.message||String(err),true)}}
async function attach(id,ro){try{await window.hostspan.attach(id,ro)}catch(err){setMessage(err.message||String(err),true)}}
e('refresh').onclick=refresh;
e('toggle').onclick=async()=>{try{await window.hostspan.daemon(snapshot?.daemon?.running?'stop':'start');setMessage('HostSpan '+(snapshot?.daemon?.running?'stopped.':'started.'));await refresh()}catch(err){setMessage(err.message||String(err),true)}};
e('restart').onclick=async()=>{try{const result=await window.hostspan.daemon('restart');if(result?.cancelled){setMessage('Restart cancelled.');return}setMessage('HostSpan restarted.');await refresh()}catch(err){setMessage(err.message||String(err),true)}};
e('doctor').onclick=async()=>{try{e('healthState').textContent='Checking…';renderHealth(await window.hostspan.doctor())}catch(err){setMessage(err.message||String(err),true)}};
e('addWorkspace').onclick=()=>{resetWorkspaceDialog();e('workspaceDialog').showModal()};
e('cancelWorkspace').onclick=()=>e('workspaceDialog').close();
e('workspaceDialog').addEventListener('close',resetWorkspaceDialog);
e('browse').onclick=async()=>{try{const r=await window.hostspan.chooseWorkspace();if(!r.canceled&&r.path){e('wsPath').value=r.path;updateWorkspaceSuggestions(r.path)}}catch(err){setMessage(err.message||String(err),true)}};
document.querySelector('[data-cap="terminal"]').onchange=ev=>{if(ev.target.checked)document.querySelector('[data-cap="exec"]').checked=true};
e('saveWorkspace').onclick=async()=>{try{
  if(!e('wsPath').value){setMessage('Choose a workspace folder first.',true);return}
  const capabilities=[...document.querySelectorAll('[data-cap]:checked')].map(x=>x.dataset.cap);
  await window.hostspan.addWorkspace({target_id:e('wsId').value.trim()||undefined,label:e('wsLabel').value.trim()||undefined,root:e('wsPath').value,capabilities});
  e('workspaceDialog').close();
  if(snapshot?.daemon?.running){
    const restart=await window.hostspan.daemon('restart');
    setMessage(restart?.cancelled?'Workspace saved; restart is still required before MCP uses it.':'Workspace saved and applied after restart.');
  }else setMessage('Workspace saved; it will apply the next time HostSpan starts.');
  await refresh();
}catch(err){setMessage(err.message||String(err),true)}};
e('targets').onclick=async ev=>{const id=ev.target?.dataset?.removeTarget;if(!id)return;if(!confirm('Remove workspace '+id+'?'))return;try{await window.hostspan.removeWorkspace(id);if(snapshot?.daemon?.running){const restart=await window.hostspan.daemon('restart');setMessage(restart?.cancelled?'Workspace removed from config; restart is still required before MCP drops it.':'Workspace removed and applied after restart.')}else setMessage('Workspace removed; it will be absent the next time HostSpan starts.');await refresh()}catch(err){setMessage(err.message||String(err),true)}};
e('terminals').onclick=ev=>{const a=ev.target?.dataset?.attach;if(a)attach(a,false);const ro=ev.target?.dataset?.readonly;if(ro)attach(ro,true)};
window.hostspan.onUpdate(render);
refresh();
</script></body></html>`;
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
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html())}`);
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
  const result = addWorkspace(requireWorkspaceInput(rawInput));
  await refreshUi();
  return result;
});
ipcMain.handle("hostspan:remove-workspace", async (event, rawTargetId: unknown) => {
  assertDashboardSender(event);
  const result = removeWorkspace(requireString(rawTargetId, "target_id", 64));
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
