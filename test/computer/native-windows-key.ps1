$ErrorActionPreference = 'Stop'
# Load only Dispatch from production source; this recorder never calls user32 or changes the clipboard.
$tokens=$null; $errors=$null
$source=Join-Path $PSScriptRoot '../../src/computer/native-windows.ps1'
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
'@
. ([scriptblock]::Create($dispatch.Extent.Text))
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
'PASS: Windows chord validation and key release; no OS input'
