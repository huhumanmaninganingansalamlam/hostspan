$ErrorActionPreference = 'Stop'
# Load only Dispatch from production source; this recorder never calls user32 or changes the clipboard.
$tokens=$null; $errors=$null
$source=Join-Path $PSScriptRoot '../../src/computer/native-windows.ps1'
$sourceText=[System.IO.File]::ReadAllText((Resolve-Path $source))
foreach ($expected in @('Screen access is on','Viewing this screen','Controlling this screen','HostSpanActivityState.Viewing','HostSpanActivityState.Controlling','FromArgb(27, 39, 59)','FromArgb(25, 69, 150)','FromArgb(122, 46, 32)')) {
    if (-not $sourceText.Contains($expected)) { throw "Missing indicator contract: $expected" }
}
foreach ($forbidden in @('SESSION OPEN','IN USE - Agent','Screen access available','Computer access')) {
    if ($sourceText.Contains($forbidden)) { throw "Old indicator wording remains: $forbidden" }
}
$ast=[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $source),[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$dispatch=$ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Dispatch' },$true)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
public static class HostSpanInput {
    public static readonly List<string> Events = new List<string>();
    public static string FailOn;
    static void Record(string kind, ushort key, bool up) {
        string value = kind + ":" + key + ":" + (up ? "up" : "down");
        Events.Add(value);
        if (value == FailOn) { FailOn = null; throw new InvalidOperationException("Injected input failure"); }
    }
    public static void Key(ushort key, bool up) { Record("key", key, up); }
    public static void ScanKey(ushort key, bool up) { Record("scan", key, up); }
}
public enum HostSpanActivityState { Ready, Viewing, Controlling }
public static class HostSpanActivity {
    public static readonly List<string> Events = new List<string>();
    public static bool FailNextOpen;
    public static void SetState(HostSpanActivityState state) {
        Events.Add(state.ToString().ToLowerInvariant());
        if (state == HostSpanActivityState.Ready && FailNextOpen) { FailNextOpen = false; throw new InvalidOperationException("badge-unavailable"); }
    }
    public static void HideIndicator() { Events.Add("hide"); }
}
'@
. ([scriptblock]::Create($dispatch.Extent.Text))
function AssertInteractiveDesktop { }  # Recorder bypasses live OS checks; policy is tested below.
$opened=$true
function CheckChord($key,$modifiers,$expected) {
    [HostSpanInput]::Events.Clear()
    $null=Dispatch ([pscustomobject]@{action='key';key=$key;modifiers=$modifiers})
    if (([HostSpanInput]::Events -join ',') -cne $expected) { throw "Unexpected key sequence: $([HostSpanInput]::Events -join ',')" }
}
CheckChord 'KeyE' @('Meta') 'key:91:down,scan:18:down,scan:18:up,key:91:up'
CheckChord 'Tab' @('Alt') 'key:18:down,key:9:down,key:9:up,key:18:up'
CheckChord 'KeyR' @('Shift') 'scan:42:down,scan:19:down,scan:19:up,scan:42:up'
foreach ($fail in @('key:91:down','scan:18:down','scan:18:up','key:91:up','key:18:up')) {
    [HostSpanInput]::Events.Clear(); [HostSpanInput]::FailOn=$fail
    $caught=$false
    try { $null=Dispatch ([pscustomobject]@{action='key';key='KeyE';modifiers=@('Shift','Alt','Meta')}) }
    catch { $caught=$true }
    if (-not $caught) { throw "Failure not surfaced: $fail" }
    foreach ($release in @('key:91:up','key:18:up','scan:42:up')) {
        if (-not [HostSpanInput]::Events.Contains($release)) { throw "Modifier not released after ${fail}: $release" }
    }
}
foreach ($invalid in @(@('Alt','Alt'),@('Control'),@('Win'),@('meta'),'Alt')) {
    [HostSpanInput]::Events.Clear(); $caught=$false
    try { $null=Dispatch ([pscustomobject]@{action='key';key='KeyE';modifiers=$invalid}) }
    catch { $caught=$true }
    if (-not $caught -or [HostSpanInput]::Events.Count) { throw 'Invalid modifier reached input' }
}
# Exercise production desktop policy without consulting Windows desktop APIs.
$policy = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'TestInteractiveDesktop'
}, $true)
if (-not $policy) { throw 'Missing interactive desktop policy' }
. ([scriptblock]::Create($policy.Extent.Text))
if (-not (TestInteractiveDesktop 7 7 $true 'WinSta0' 'Default' 'Default')) {
    throw 'Valid unlocked console session was rejected'
}
function AssertDenied($label, $sessionId, $consoleSessionId, $userInteractive, $station, $desktop, $inputDesktop) {
    if (TestInteractiveDesktop $sessionId $consoleSessionId $userInteractive $station $desktop $inputDesktop) {
        throw "Unsafe desktop was accepted: $label"
    }
}
AssertDenied 'session-zero' 0 0 $true 'WinSta0' 'Default' 'Default'
AssertDenied 'different-console-session' 7 8 $true 'WinSta0' 'Default' 'Default'
AssertDenied 'console-switch-in-progress' 7 4294967295 $true 'WinSta0' 'Default' 'Default'
AssertDenied 'noninteractive' 7 7 $false 'WinSta0' 'Default' 'Default'
AssertDenied 'service-station' 7 7 $true 'Service-0x0-3e7$' 'Default' 'Default'
AssertDenied 'non-default-thread-desktop' 7 7 $true 'WinSta0' 'Winlogon' 'Default'
AssertDenied 'locked-or-uac-desktop' 7 7 $true 'WinSta0' 'Default' 'Winlogon'
AssertDenied 'desktop-access-denied' 7 7 $true 'WinSta0' 'Default' 'unavailable'

# A previously opened helper must reject captures and input before touching OS APIs.
function AssertInteractiveDesktop { throw 'guard-denied' }
$script:opened = $true
foreach ($action in @('observe', 'move', 'click', 'key', 'text', 'scroll')) {
    $caught = $false
    try { $null = Dispatch ([pscustomobject]@{ action = $action }) }
    catch {
        if ($_.Exception.Message -ne 'guard-denied') { throw }
        $caught = $true
    }
    if (-not $caught) { throw "Dispatch did not check desktop before $action" }
}
$script:opened = $false
$caught = $false
try { $null = Dispatch ([pscustomobject]@{ action = 'open' }) }
catch {
    if ($_.Exception.Message -ne 'guard-denied') { throw }
    $caught = $true
}
if (-not $caught -or $script:opened) { throw 'Open bypassed desktop guard' }
# Simulate repeated open -> idle -> close without creating any Windows UI.
function AssertInteractiveDesktop { }
function Geometry { return @{ backend = 'fixture' } }
[HostSpanActivity]::Events.Clear()
$script:opened = $false
$null = Dispatch ([pscustomobject]@{ action = 'open' })
if (-not $script:opened -or [HostSpanActivity]::Events[0] -cne 'ready') { throw 'Open has no persistent access badge' }
$null = Dispatch ([pscustomobject]@{ action = 'close' })
if ($script:opened -or [HostSpanActivity]::Events[1] -cne 'hide') { throw 'Close did not hide badge' }
$null = Dispatch ([pscustomobject]@{ action = 'open' })
if (-not $script:opened -or [HostSpanActivity]::Events[2] -cne 'ready') { throw 'Reopen did not restore badge' }
$null = Dispatch ([pscustomobject]@{ action = 'close' })

# Refuse a session when the desktop badge cannot be shown.
[HostSpanActivity]::FailNextOpen = $true
$script:opened = $false
$caught = $false
try { $null = Dispatch ([pscustomobject]@{ action = 'open' }) }
catch { if ($_.Exception.Message -notmatch 'badge-unavailable') { throw }; $caught = $true }
if (-not $caught -or $script:opened) { throw 'Badge failure left a session open' }

'PASS: Windows chords, guard and ready/viewing/controlling indicator contract; no OS input'
