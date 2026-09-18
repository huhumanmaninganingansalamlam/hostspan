import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, Tray } from "electron";
import { buildAdminSnapshot, resolveTerminalSession } from "../admin/snapshot.js";
import { startDaemon, stopDaemon } from "../cli/daemon.js";
import { loadConfig } from "../config/loader.js";
import { TmuxTerminalManager } from "../processes/tmux-terminal.js";

declare global {
  interface Window {
    hostspan: {
      snapshot(): Promise<unknown>;
      daemon(action: "start" | "stop"): Promise<unknown>;
      attach(processId: string, readOnly: boolean): Promise<unknown>;
      copy(text: string): Promise<unknown>;
      onUpdate(callback: (snapshot: unknown) => void): void;
    };
  }
}

const configPath = resolve(
  process.env.HOSTSPAN_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "hostspan", "config.yaml"),
);
if (process.platform === "linux") app.commandLine.appendSwitch("disable-gpu");
const cliPath = fileURLToPath(new URL("../cli/index.js", import.meta.url));
const preloadPath = fileURLToPath(new URL("./preload.cjs", import.meta.url));
const nodePath = process.env.HOSTSPAN_NODE ?? process.execPath;

let tray: Tray | undefined;
let window: BrowserWindow | undefined;
let refreshTimer: NodeJS.Timeout | undefined;
let quitting = false;

function icon() {
  return nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAA8SURBVHgB7ZAxCgAgDAMv4v9/ubg4OAhFQfBKQ5uQkBByyJxz9oA5QFZUVFS0AjYgC0gB6QAtIAekALSAbAB2FQugKf4BhwAAAABJRU5ErkJggg==",
  );
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function attachCommand(processId: string, readOnly: boolean): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      command: "wt.exe",
      args: ["wsl.exe", "hostspan", "terminal", "attach", "--process", processId, ...(readOnly ? ["--read-only"] : [])],
    };
  }
  const args = [nodePath, cliPath, "terminal", "attach", "--process", processId, ...(readOnly ? ["--read-only"] : []), "--config", configPath];
  if (process.platform === "darwin") {
    const shell = args.map(quoteShell).join(" ");
    return { command: "osascript", args: ["-e", `tell application "Terminal" to do script ${JSON.stringify(shell)}`] };
  }
  const terminal = ["x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal", "xterm"].find(
    (candidate) => spawnSync("which", [candidate], { stdio: "ignore" }).status === 0,
  );
  if (!terminal) throw new Error("No supported graphical terminal launcher was found.");
  if (terminal === "gnome-terminal") return { command: terminal, args: ["--", ...args] };
  if (terminal === "konsole") return { command: terminal, args: ["-e", ...args] };
  return { command: terminal, args: ["-e", ...args] };
}

function openAttach(processId: string, readOnly: boolean): void {
  const request = attachCommand(processId, readOnly);
  const child = spawn(request.command, request.args, { detached: true, stdio: "ignore" });
  child.unref();
}

function html(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HostSpan</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#101218;color:#e9edf5}main{padding:16px;max-width:900px;margin:auto}h1{font-size:20px;margin:0 0 12px}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.card{background:#181c25;border:1px solid #2b3241;border-radius:10px;padding:12px;margin:10px 0}button{background:#2b66f6;color:white;border:0;border-radius:7px;padding:7px 10px;cursor:pointer}button.secondary{background:#31394b}.ok{color:#70dc9b}.bad{color:#ff8080}.muted{color:#9aa6b8;font-size:12px}table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:6px;border-bottom:1px solid #2b3241;vertical-align:top}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;word-break:break-all}.scroll{max-height:220px;overflow:auto}.pill{padding:2px 6px;border-radius:10px;background:#283044;font-size:11px}</style>
</head><body><main>
<div class="row"><h1 style="flex:1">HostSpan</h1><button id="refresh" class="secondary">Refresh</button><button id="toggle">Start</button></div>
<div id="summary" class="card">Loading…</div>
<div class="card"><b>Targets / Workspaces</b><div id="targets"></div></div>
<div class="card"><b>Interactive terminals</b><div id="terminals"></div></div>
<div class="card"><b>Recent calls</b><div id="calls" class="scroll"></div></div>
</main>
<script>
let snapshot;
const e=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function render(s){snapshot=s;const running=!!s.daemon?.running;e('toggle').textContent=running?'Stop':'Start';e('toggle').className=running?'secondary':'';
e('summary').innerHTML='<div class="row"><span class="pill '+(running?'ok':'bad')+'">'+(running?'RUNNING':'STOPPED')+'</span><b>'+esc(s.server_version)+'</b><span class="muted">'+esc(s.toolset_version)+' · policy '+esc(s.policy_epoch)+' · pid '+esc(s.daemon?.pid??'-')+'</span></div><div class="muted">'+esc(s.listen?.host)+':'+esc(s.listen?.port)+'</div>';
e('targets').innerHTML='<table><tr><th>ID</th><th>Root</th><th>Capabilities</th><th>Ready</th></tr>'+s.targets.map(t=>'<tr><td><b>'+esc(t.target_id)+'</b><div class="muted">'+esc(t.label)+'</div></td><td><code>'+esc(t.root)+'</code></td><td>'+esc(t.capabilities.join(', '))+'</td><td>'+(t.ready?'✓':'✕')+'</td></tr>').join('')+'</table>';
e('terminals').innerHTML=s.terminal.sessions.length?'<table><tr><th>Process</th><th>Target</th><th>State</th><th></th></tr>'+s.terminal.sessions.map(t=>'<tr><td><code>'+esc(t.process_id)+'</code></td><td>'+esc(t.target_id)+'</td><td>'+esc(t.state)+(t.live?' · live':'')+'</td><td><button onclick="attach(\\''+esc(t.process_id)+'\\',false)">Attach</button> <button class="secondary" onclick="attach(\\''+esc(t.process_id)+'\\',true)">Read only</button></td></tr>').join('')+'</table>':'<div class="muted">No tmux-backed sessions.</div>';
e('calls').innerHTML=s.recent_calls.map(c=>'<div style="padding:5px 0;border-bottom:1px solid #242a37"><span class="muted">'+esc(c.timestamp)+'</span> <b>'+esc(c.event_type)+'</b> <code>'+esc(c.metadata?.tool??'')+'</code> <span class="muted">'+esc(c.metadata?.error_code??'')+'</span></div>').join('');}
async function refresh(){render(await window.hostspan.snapshot())}async function attach(id,ro){await window.hostspan.attach(id,ro)}
e('refresh').onclick=refresh;e('toggle').onclick=async()=>{await window.hostspan.daemon(snapshot?.daemon?.running?'stop':'start');await refresh()};window.hostspan.onUpdate(render);refresh();
</script></body></html>`;
}

function createWindow(): BrowserWindow {
  if (window && !window.isDestroyed()) return window;
  window = new BrowserWindow({
    width: 780,
    height: 620,
    show: false,
    title: "HostSpan",
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html())}`);
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window?.hide();
    }
  });
  return window;
}

function wslJson(args: string[]): ReturnType<typeof buildAdminSnapshot> {
  const result = spawnSync("wsl.exe", ["hostspan", ...args], { encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error((result.stderr || result.error?.message || "WSL HostSpan command failed").trim());
  return JSON.parse(result.stdout) as ReturnType<typeof buildAdminSnapshot>;
}

async function snapshot(): Promise<ReturnType<typeof buildAdminSnapshot>> {
  if (process.platform === "win32") return wslJson(["admin", "snapshot", "--recent", "40"]);
  return buildAdminSnapshot(configPath, { recent: 40 });
}

async function daemonAction(action: "start" | "stop") {
  if (process.platform === "win32") return wslJson(["daemon", action]);
  return action === "start" ? startDaemon(configPath, cliPath, nodePath) : stopDaemon(configPath);
}

async function refreshUi(): Promise<void> {
  const data = await snapshot();
  tray?.setToolTip(`HostSpan ${data.daemon.running ? "running" : "stopped"}`);
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: `HostSpan ${data.daemon.running ? "Running" : "Stopped"}`, enabled: false },
      { label: "Open Dashboard", click: () => { const w = createWindow(); w.show(); w.focus(); } },
      { type: "separator" },
      data.daemon.running
        ? { label: "Stop HostSpan", click: () => void daemonAction("stop").then(refreshUi) }
        : { label: "Start HostSpan", click: () => void daemonAction("start").then(refreshUi) },
      { label: `Targets: ${data.targets.length}`, enabled: false },
      { label: `Terminal sessions: ${data.terminal.sessions.filter((session) => session.live).length}`, enabled: false },
      { type: "separator" },
      { label: "Quit Tray", click: () => { quitting = true; app.quit(); } },
    ]),
  );
  if (window && !window.isDestroyed()) window.webContents.send("hostspan:update", data);
}

ipcMain.handle("hostspan:snapshot", () => snapshot());
ipcMain.handle("hostspan:daemon", async (_event, action: "start" | "stop") => {
  const result = await daemonAction(action);
  await refreshUi();
  return result;
});
ipcMain.handle("hostspan:attach", (_event, input: { processId: string; readOnly: boolean }) => {
  if (process.platform === "win32") {
    openAttach(input.processId, input.readOnly);
    return { ok: true };
  }
  const config = loadConfig(configPath);
  if (!config.terminal) throw new Error("terminal support is not configured");
  const session = resolveTerminalSession(configPath, input.processId);
  if (!session) throw new Error(`terminal process not found: ${input.processId}`);
  const manager = new TmuxTerminalManager(config.server.data_dir, config.terminal);
  if (!manager.inspectSync(session.session).exists) throw new Error("tmux session is no longer live");
  openAttach(input.processId, input.readOnly);
  return { ok: true };
});
ipcMain.handle("hostspan:copy", (_event, text: string) => {
  clipboard.writeText(text);
  return { ok: true };
});

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => { const w = createWindow(); w.show(); w.focus(); });
app.on("window-all-closed", () => undefined);

void app.whenReady().then(async () => {
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
  refreshTimer = setInterval(() => void refreshUi(), 2_000);
  refreshTimer.unref();
});

app.on("before-quit", () => {
  quitting = true;
  if (refreshTimer) clearInterval(refreshTimer);
});
