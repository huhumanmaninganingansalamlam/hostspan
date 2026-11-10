import { DASHBOARD_CSP } from "./ipc-security.js";
import { DEFAULT_WORKSPACE_CAPABILITIES, defaultWorkspaceCapability } from "./workspace-capabilities.js";

export function dashboardHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${DASHBOARD_CSP}">
<title>HostSpan</title>
<style>
:root{color-scheme:dark}body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#101218;color:#e9edf5}main{padding:16px;max-width:940px;margin:auto}h1{font-size:20px;margin:0}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.grow{flex:1}.card{background:#181c25;border:1px solid #2b3241;border-radius:10px;padding:12px;margin:10px 0}.cardhead{display:flex;align-items:center;gap:8px;margin-bottom:8px}.cardhead b{flex:1}button{background:#2b66f6;color:white;border:0;border-radius:7px;padding:7px 10px;cursor:pointer}button.secondary{background:#31394b}button.danger{background:#71323a}button:disabled{opacity:.45;cursor:default}.ok{color:#70dc9b}.bad{color:#ff8080}.warn{color:#f2c56b}.muted{color:#9aa6b8;font-size:12px}.message{min-height:18px;margin-top:6px;font-size:12px}.message.error{color:#ff8080}table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:6px;border-bottom:1px solid #2b3241;vertical-align:top}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;word-break:break-all}.scroll{max-height:230px;overflow:auto}.pill{padding:2px 6px;border-radius:10px;background:#283044;font-size:11px}.caps{display:flex;gap:8px;flex-wrap:wrap}.caps label{font-size:12px}.activity{padding:5px 0;border-bottom:1px solid #242a37}dialog{width:min(560px,90vw);border:1px solid #394359;border-radius:10px;background:#181c25;color:#e9edf5;padding:16px}dialog::backdrop{background:#0008}.field{margin:10px 0}.field label.title{display:block;font-size:12px;color:#9aa6b8;margin-bottom:4px}.field input[type=text]{box-sizing:border-box;width:100%;padding:8px;border:1px solid #3b455a;border-radius:6px;background:#11151d;color:#e9edf5}.pathrow{display:flex;gap:6px}.pathrow input{flex:1}
.screen-description{margin:0 0 10px}.screen-banner{display:flex;align-items:center;gap:9px;padding:9px 10px;border:1px solid #31394b;border-left-width:3px;border-radius:8px;background:#141923}.screen-dot{width:9px;height:9px;border-radius:50%;flex:0 0 9px}.screen-banner.ready{border-left-color:#aab4c3}.screen-banner.ready .screen-dot{background:#aab4c3}.screen-banner.viewing{border-left-color:#8ec5ff;background:#14213c}.screen-banner.viewing .screen-dot{background:#8ec5ff}.screen-banner.controlling{border-left-color:#ffc08a;background:#2a1918}.screen-banner.controlling .screen-dot{background:#ffc08a}.screen-banner.waiting{border-left-color:#f2c56b;background:#292315}.screen-banner.waiting .screen-dot{background:#f2c56b}.screen-banner.closed{border-left-color:#667085}.screen-banner.closed .screen-dot{background:#667085}.screen-banner.attention{border-left-color:#ff8080;background:#2a171b}.screen-banner.attention .screen-dot{background:#ff8080}.screen-grid{display:grid;grid-template-columns:max-content 1fr;gap:5px 14px;margin-top:10px;font-size:13px}.screen-grid span{color:#9aa6b8}.technical{margin-top:10px}.technical summary{cursor:pointer;color:#9aa6b8;font-size:12px}.technical div{margin-top:5px}
</style>
</head><body><main>
<div class="row"><h1 class="grow">HostSpan</h1><button id="doctor" class="secondary">Run Doctor</button><button id="restart" class="secondary">Restart</button><button id="refresh" class="secondary">Refresh</button><button id="toggle">Start</button></div>
<div id="message" class="message" role="status" aria-live="polite"></div><details id="errorDetails" hidden><summary>Technical details</summary><pre id="errorText"></pre></details>
<div id="summary" class="card">Loading…</div>
<div class="card"><div class="cardhead"><b>Screen access</b><button id="computerToggle">Loading…</button></div><div id="computer">Loading…</div></div>
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
function setMessage(message,error=false){const el=e('message');const raw=String(message??'');el.textContent=error&&raw.includes('ENOENT')&&raw.includes('config')?'HostSpan settings could not be found. Restore the selected profile, then click Refresh.':raw.replace(/^Error invoking remote method '[^']+': (Error: )?/,'');el.className='message'+(error?' error':'');e('errorDetails').hidden=!error;e('errorText').textContent=error?raw:''}
function folderName(path){return String(path).split(/[\\/]/).filter(Boolean).pop()||'workspace'}
function screenSession(runtime,running,currentOn){
  const state=runtime?.state,activity=runtime?.activity;
  if(!running||!currentOn||['stopped','disabled','closed'].includes(state))return{label:'Closed',headline:'No screen session',tone:'closed',note:'Open a screen session when it is needed.'};
  if(state==='awaiting_consent')return{label:'Waiting for screen approval',headline:'Waiting for screen approval',tone:'waiting',note:"Approve in the operating system's screen sharing window."};
  if(state==='connecting')return{label:'Opening',headline:'Opening screen access',tone:'waiting',note:'HostSpan is connecting to the logged-in desktop.'};
  if(activity==='controlling')return{label:'Controlling',headline:'Controlling this screen',tone:'controlling',note:'Pointer or keyboard input is being sent.'};
  if(activity==='viewing')return{label:'Viewing',headline:'Viewing this screen',tone:'viewing',note:'A screen image is being captured.'};
  if(state==='ready')return{label:'Ready',headline:'Screen access is on',tone:'ready',note:'HostSpan can view or control this screen when requested.'};
  if(state==='unavailable'||state==='failed'||state==='unknown')return{label:'Needs attention',headline:'Screen access needs attention',tone:'attention',note:'Open Technical details for the runtime message.'};
  return{label:'Working',headline:'Screen access is working',tone:'viewing',note:'A screen action is still finishing.'};
}
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
  e('wsLabel').placeholder='Auto: '+folderName(path);
}
function render(s){
  snapshot=s;
  const running=!!s.daemon?.running;
  const saved=!!s.computer?.configured,active=s.computer?.runtime?.enabled;
  const pending=running&&(active==null||active!==saved);
  const currentLabel=!running?'Off':active==null?'Unknown':active?'On':'Off';
  const session=screenSession(s.computer?.runtime,running,running&&active===true);
  e('computerToggle').textContent='Save '+(saved?'Off':'On');
  e('computer').innerHTML='<p class="screen-description">Allows HostSpan to view and control this screen after OS approval.</p>'+
    '<div class="screen-banner '+session.tone+'"><span class="screen-dot" aria-hidden="true"></span><div><b>'+esc(session.headline)+'</b><div class="muted">'+esc(session.note)+'</div></div></div>'+
    '<div class="screen-grid"><span>Saved</span><b>'+(saved?'On':'Off')+'</b><span>Current</span><b>'+esc(currentLabel)+'</b><span>Session</span><b>'+esc(session.label)+'</b></div>'+
    (pending?'<div class="warn" style="margin-top:9px">Restart HostSpan to apply the saved change.</div>':'')+
    '<div class="muted" style="margin-top:9px">Screen access is off by default. Operating-system approval is required before a session can view or control the screen.</div>'+
    '<details class="technical"><summary>Technical details</summary><div class="muted">Runtime state: <code>'+esc(s.computer?.runtime?.state??'unknown')+'</code></div><div class="muted">Profile: <code>'+esc(s.computer?.profile??'unknown')+'</code></div><div class="muted">'+esc(s.computer?.runtime?.message??s.computer?.message??'')+'</div></details>';
  e('toggle').textContent=running?'Stop':'Start';
  e('toggle').className=running?'secondary':'';
  e('restart').disabled=!running;
  e('summary').innerHTML='<div class="row"><span class="pill '+(running?'ok':'bad')+'">'+(running?'RUNNING':'STOPPED')+'</span><b>'+esc(s.server_version)+'</b><span class="muted">'+esc(s.toolset_version)+' · policy '+esc(s.policy_epoch)+' · pid '+esc(s.daemon?.pid??'-')+'</span><span class="grow"></span><label class="muted"><input id="autoStart" type="checkbox" '+(s.auto_start?'checked':'')+'> Start at login</label></div><div class="muted">'+esc(s.listen?.host)+':'+esc(s.listen?.port)+' · active processes '+esc(s.active_process_count)+'</div><div class="muted">Installed build: '+esc(s.build?.variant??'unknown')+' · commit <code title="'+esc(s.build?.commit??'unknown')+'">'+esc(short(s.build?.commit??'unknown'))+'</code> · tree <code title="'+esc(s.build?.tree??'unknown')+'">'+esc(short(s.build?.tree??'unknown'))+'</code> ('+esc(s.build?.object_format??'unknown')+') · dirty '+esc(s.build?.dirty??'unknown')+' · ID <code title="'+esc(s.build?.build_id??'unknown')+'">'+esc(short(s.build?.build_id??'unknown'))+'</code></div>';
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
e('refresh').onclick=async()=>{e('refresh').disabled=true;setMessage('Refreshing…');try{render(await window.hostspan.snapshot());setMessage('Status refreshed.')}catch(err){setMessage((err.message||String(err))+' Click Refresh to retry.',true)}finally{e('refresh').disabled=false}};
e('toggle').onclick=async()=>{const action=snapshot?.daemon?.running?'stop':'start';e('toggle').disabled=true;setMessage(action==='start'?'Starting…':'Stopping…');try{const result=await window.hostspan.daemon(action);setMessage(result?.cancelled?'Action cancelled.':'HostSpan '+(action==='stop'?'stopped.':'started.'));await refresh()}catch(err){setMessage((err.message||String(err))+' Refresh status before retrying.',true)}finally{e('toggle').disabled=false}};
e('restart').onclick=async()=>{try{const result=await window.hostspan.daemon('restart');if(result?.cancelled){setMessage('Restart cancelled.');return}setMessage('HostSpan restarted.');await refresh()}catch(err){setMessage(err.message||String(err),true)}};
e('computerToggle').onclick=async()=>{e('computerToggle').disabled=true;try{await window.hostspan.setComputer(!snapshot?.computer?.configured);setMessage('Screen access setting saved. '+(snapshot?.daemon?.running?'The current setting still applies. Finish the current screen session, then use Restart.':'It will apply when HostSpan starts.'));await refresh()}catch(err){setMessage(err.message||String(err),true)}finally{e('computerToggle').disabled=false}};
e('doctor').onclick=async()=>{e('doctor').disabled=true;try{e('healthState').textContent='Checking…';renderHealth(await window.hostspan.doctor())}catch(err){e('healthState').textContent='Check failed. Run Doctor to retry.';e('healthState').className='bad';setMessage(err.message||String(err),true)}finally{e('doctor').disabled=false}};
e('addWorkspace').onclick=()=>{resetWorkspaceDialog();e('workspaceDialog').showModal()};
e('cancelWorkspace').onclick=()=>e('workspaceDialog').close();
e('workspaceDialog').addEventListener('close',resetWorkspaceDialog);
e('browse').onclick=async()=>{try{const r=await window.hostspan.chooseWorkspace();if(!r.canceled&&r.path){e('wsPath').value=r.path;updateWorkspaceSuggestions(r.path)}}catch(err){setMessage(err.message||String(err),true)}};
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
