# Private JSON-lines helper. Run in the logged-in user's desktop, never Session 0.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new()
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class HostSpanInput {
    [StructLayout(LayoutKind.Sequential)] struct Mouse { public int x,y; public uint data,flags,time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct Keyboard { public ushort key,scan; public uint flags,time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct Data { [FieldOffset(0)] public Mouse mouse; [FieldOffset(0)] public Keyboard keyboard; }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public Data data; }
    [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError=true)] static extern bool GetCursorPos(out System.Drawing.Point point);
    [DllImport("user32.dll", SetLastError=true)] static extern bool GetClipCursor(out System.Drawing.Rectangle rectangle);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, int length, out int needed);
    static string DesktopName(IntPtr desktop) {
        if (desktop == IntPtr.Zero) return "unavailable";
        var value = new StringBuilder(256);
        int needed;
        return GetUserObjectInformation(desktop, 2, value, value.Capacity * 2, out needed) ? value.ToString() : "unavailable";
    }
    public static string CurrentDesktop() { return DesktopName(GetThreadDesktop(GetCurrentThreadId())); }
    public static string WindowStation() { return DesktopName(GetProcessWindowStation()); }
    public static object PointerState() {
        System.Drawing.Point point;
        bool readable = GetCursorPos(out point);
        int error = readable ? 0 : Marshal.GetLastWin32Error();
        System.Drawing.Rectangle clip;
        bool clipReadable = GetClipCursor(out clip);
        return new { readable=readable, error=error, x=point.X, y=point.Y,
                     clip_readable=clipReadable, clip_left=clip.X, clip_top=clip.Y,
                     clip_right=clip.Width, clip_bottom=clip.Height };
    }
    public static string InputDesktop() {
        var desktop = OpenInputDesktop(0, false, 1);
        try { return DesktopName(desktop); }
        finally { if (desktop != IntPtr.Zero) CloseDesktop(desktop); }
    }
    static void Send(params Input[] events) {
        if (SendInput((uint)events.Length, events, Marshal.SizeOf(typeof(Input))) != events.Length)
            throw new InvalidOperationException("Windows did not accept all input events; do not replay the input");
    }
    public static void MovePointer(int x, int y) {
        if (!SetCursorPos(x, y))
            throw new InvalidOperationException("Windows pointer positioning failed (Win32 " + Marshal.GetLastWin32Error() + ")");
        System.Drawing.Point actual;
        if (!GetCursorPos(out actual) || actual.X != x || actual.Y != y)
            throw new InvalidOperationException("Pointer did not reach the requested position; no click was sent");
    }
    public static void Key(ushort key, bool up) {
        Send(new Input { type=1, data=new Data { keyboard=new Keyboard { key=key, flags=(up ? 2u : 0u) | ((key >= 33 && key <= 46) ? 1u : 0u) } } });
    }
    public static void ScanKey(ushort scan, bool up) {
        Send(new Input { type=1, data=new Data { keyboard=new Keyboard { scan=scan, flags=8u | (up ? 2u : 0u) } } });
    }
    public static void MouseButton(uint down, uint up, uint data) {
        try { Send(new Input { data=new Data { mouse=new Mouse { flags=down, data=data } } }); }
        finally { Send(new Input { data=new Data { mouse=new Mouse { flags=up, data=data } } }); }
    }
    public static void Scroll(uint flags, int delta) {
        Send(new Input { data=new Data { mouse=new Mouse { flags=flags, data=unchecked((uint)delta) } } });
    }
}
public sealed class HostSpanActivity : System.Windows.Forms.Form {
    static HostSpanActivity window;
    static Exception startupError;
    static System.Threading.Thread thread;
    static readonly System.Threading.ManualResetEvent ready = new System.Threading.ManualResetEvent(false);
    readonly System.Windows.Forms.Label label = new System.Windows.Forms.Label();
    readonly System.Windows.Forms.Timer finished = new System.Windows.Forms.Timer { Interval = 1000 };
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override System.Windows.Forms.CreateParams CreateParams {
        get { var p = base.CreateParams; p.ExStyle |= 0x08000000 | 0x20 | 0x80 | 0x80000; return p; }
    }
    protected override void WndProc(ref System.Windows.Forms.Message m) {
        if (m.Msg == 0x84) { m.Result = new IntPtr(-1); return; }
        base.WndProc(ref m);
    }
    HostSpanActivity() {
        Text = "HostSpan computer use";
        FormBorderStyle = System.Windows.Forms.FormBorderStyle.None;
        ShowInTaskbar = false; TopMost = true; Opacity = 0.95;
        StartPosition = System.Windows.Forms.FormStartPosition.Manual;
        var area = System.Windows.Forms.Screen.PrimaryScreen.WorkingArea;
        Bounds = new System.Drawing.Rectangle(area.Right - 310, area.Top + 12, 298, 36);
        BackColor = System.Drawing.Color.FromArgb(25, 69, 150);
        ForeColor = System.Drawing.Color.White;
        label.Dock = System.Windows.Forms.DockStyle.Fill;
        label.TextAlign = System.Drawing.ContentAlignment.MiddleCenter;
        label.Text = "HostSpan - Using this computer";
        Controls.Add(label);
        finished.Tick += delegate { finished.Stop(); Hide(); };
        Shown += delegate { ready.Set(); };
        FormClosed += delegate { finished.Dispose(); };
    }
    public static void SetActive(bool active) {
        if (thread == null) {
            thread = new System.Threading.Thread(delegate() {
                try { window = new HostSpanActivity(); System.Windows.Forms.Application.Run(window); }
                catch (Exception e) { startupError = e; ready.Set(); }
            });
            thread.IsBackground = true;
            thread.SetApartmentState(System.Threading.ApartmentState.STA);
            thread.Start();
            if (!ready.WaitOne(5000)) throw new InvalidOperationException("Could not show HostSpan activity indicator");
        }
        if (startupError != null) throw new InvalidOperationException("Could not show HostSpan activity indicator", startupError);
        window.Invoke(new Action(delegate {
            window.finished.Stop();
            window.label.Text = active ? "HostSpan - Using this computer" : "HostSpan - Activity finished";
            window.Show(); window.Update();
            if (!active) window.finished.Start();
        }));
    }
    public static void MovePointer(int x, int y) {
        window.Invoke(new Action(delegate { HostSpanInput.MovePointer(x, y); }));
    }
    public static void CloseIndicator() {
        if (window != null && window.IsHandleCreated && !window.IsDisposed)
            window.Invoke(new Action(delegate { window.Close(); }));
    }
}
'@
[void][HostSpanInput]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
$opened = $false

function Geometry {
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen
    return @{ backend='windows-native'; display_id=$screen.DeviceName; coordinate_width=$screen.Bounds.Width;
        coordinate_height=$screen.Bounds.Height; text_supported=$true;
        windows_session_id=[System.Diagnostics.Process]::GetCurrentProcess().SessionId;
        desktop=[HostSpanInput]::CurrentDesktop(); input_desktop=[HostSpanInput]::InputDesktop();
        window_station=[HostSpanInput]::WindowStation(); pointer=[HostSpanInput]::PointerState() }
}

function Dispatch($command) {
    $action = $command.action
    if ($action -eq 'close') { $script:opened=$false; [HostSpanActivity]::CloseIndicator(); return @{closed=$true} }
    if ($action -eq 'open') {
        if ([System.Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0 -or -not [Environment]::UserInteractive) {
            throw 'Start HostSpan in the logged-in Windows desktop. Session 0 cannot capture or control the user screen.'
        }
        $script:opened=$true
        return (Geometry)
    }
    if (-not $opened) { throw 'Desktop session is closed' }
    if ($action -eq 'observe') {
        $bounds=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bitmap=[System.Drawing.Bitmap]::new($bounds.Width,$bounds.Height)
        $graphics=$null; $stream=$null
        try {
            $graphics=[System.Drawing.Graphics]::FromImage($bitmap)
            $graphics.CopyFromScreen($bounds.Location,[System.Drawing.Point]::Empty,$bounds.Size)
            $stream=[System.IO.MemoryStream]::new()
            $bitmap.Save($stream,[System.Drawing.Imaging.ImageFormat]::Png)
            if ($stream.Length -gt 16MB) { throw 'Captured PNG exceeds 16 MiB' }
            $result=Geometry
            $result.image=[Convert]::ToBase64String($stream.ToArray())
            $result.mime_type='image/png'; $result.width=$bounds.Width; $result.height=$bounds.Height
            return $result
        } finally {
            if ($stream) { $stream.Dispose() }
            if ($graphics) { $graphics.Dispose() }
            $bitmap.Dispose()
        }
    }
    switch ($action) {
        { $_ -in 'move','click' } {
            $bounds=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
            $x=[double]$command.x; $y=[double]$command.y
            if ([double]::IsNaN($x) -or [double]::IsInfinity($x) -or [double]::IsNaN($y) -or [double]::IsInfinity($y) -or
                $x -lt 0 -or $y -lt 0 -or $x -ge $bounds.Width -or $y -ge $bounds.Height) { throw 'Pointer coordinates are outside the selected screen' }
            [HostSpanActivity]::MovePointer($bounds.X+[int]$x,$bounds.Y+[int]$y)
            if ($action -eq 'click') {
                switch ($command.button) {
                    'right' { [HostSpanInput]::MouseButton(8,16,0) }
                    'middle' { [HostSpanInput]::MouseButton(32,64,0) }
                    { $_ -in $null,'left' } { [HostSpanInput]::MouseButton(2,4,0) }
                    default { throw 'Unsupported mouse button' }
                }
            }
        }
        'key' {
            $keys=@{Enter=13;Tab=9;Escape=27;Backspace=8;Delete=46;Left=37;Up=38;Right=39;Down=40;Home=36;End=35}
            $physical=@{KeyA=30;KeyB=48;KeyC=46;KeyD=32;KeyE=18;KeyF=33;KeyG=34;KeyH=35;KeyI=23;
                KeyJ=36;KeyK=37;KeyL=38;KeyM=50;KeyN=49;KeyO=24;KeyP=25;KeyQ=16;KeyR=19;
                KeyS=31;KeyT=20;KeyU=22;KeyV=47;KeyW=17;KeyX=45;KeyY=21;KeyZ=44}
            if (-not $keys.ContainsKey($command.key) -and -not $physical.ContainsKey($command.key)) { throw 'Unsupported key' }
            if ($null -ne $command.modifiers -and ($command.modifiers -isnot [array] -or
                $command.modifiers.Count -gt 1 -or ($command.modifiers.Count -eq 1 -and $command.modifiers[0] -cne 'Shift'))) {
                throw 'Unsupported modifiers'
            }
            $shifted=$command.modifiers -contains 'Shift'
            try {
                if ($shifted) { [HostSpanInput]::ScanKey(42,$false) }
                try {
                    if ($physical.ContainsKey($command.key)) { [HostSpanInput]::ScanKey($physical[$command.key],$false) }
                    else { [HostSpanInput]::Key($keys[$command.key],$false) }
                } finally {
                    if ($physical.ContainsKey($command.key)) { [HostSpanInput]::ScanKey($physical[$command.key],$true) }
                    else { [HostSpanInput]::Key($keys[$command.key],$true) }
                }
            } finally { if ($shifted) { [HostSpanInput]::ScanKey(42,$true) } }
        }
        'text' {
            if ($command.text -isnot [string] -or $command.text.Length -gt 4096) { throw 'Text exceeds 4096 characters' }
            [System.Windows.Forms.Clipboard]::SetText($command.text)
            try {
                [HostSpanInput]::Key(17,$false)
                try { [HostSpanInput]::Key(86,$false) }
                finally { [HostSpanInput]::Key(86,$true) }
            } finally { [HostSpanInput]::Key(17,$true) }
        }
        'scroll' {
            foreach ($entry in @(@('dx',4096),@('dy',2048))) {
                $delta=[double]$command.($entry[0])
                if ([double]::IsNaN($delta) -or [double]::IsInfinity($delta) -or [Math]::Abs($delta) -gt 10000) { throw 'Invalid scroll delta' }
                if ($delta -ne 0) { [HostSpanInput]::Scroll($entry[1],[int]($(if ($entry[0] -eq 'dx') { $delta } else { -$delta }))) }
            }
        }
        default { throw 'Unsupported desktop action' }
    }
    return @{dispatched=$true}
}

try { while ($null -ne ($line=[Console]::ReadLine())) {
    if ([System.Text.Encoding]::UTF8.GetByteCount($line) -gt 65536) { break }
    $command=$null
    $usingDesktop=$false
    try {
        $command=$line | ConvertFrom-Json
        if ($null -eq $command.id -or $command.id -isnot [string]) { break }
        if ($opened -and $command.action -in @('observe','move','click','key','text','scroll')) {
            [HostSpanActivity]::SetActive($true)
            $usingDesktop=$true
        }
        $reply=@{id=$command.id;result=(Dispatch $command)}
    } catch { $reply=@{id=$command.id;error=$_.Exception.Message} }
    finally { if ($usingDesktop) { [HostSpanActivity]::SetActive($false) } }
    [Console]::WriteLine(($reply | ConvertTo-Json -Depth 8 -Compress))
} } finally { [HostSpanActivity]::CloseIndicator() }
