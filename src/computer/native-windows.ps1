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
using System.Drawing;
using System.Drawing.Drawing2D;
public static class HostSpanInput {
    [StructLayout(LayoutKind.Sequential)] struct Mouse { public int x,y; public uint data,flags,time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct Keyboard { public ushort key,scan; public uint flags,time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct Data { [FieldOffset(0)] public Mouse mouse; [FieldOffset(0)] public Keyboard keyboard; }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public Data data; }
    [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
    public static uint ActiveConsoleSessionId() { return WTSGetActiveConsoleSessionId(); }
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
        Send(new Input { type=1, data=new Data { keyboard=new Keyboard { key=key, flags=(up ? 2u : 0u) | ((key >= 33 && key <= 46 || key == 91) ? 1u : 0u) } } });
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
public enum HostSpanActivityState { Ready, Viewing, Controlling }

public sealed class HostSpanStateIcon : System.Windows.Forms.Control {
    HostSpanActivityState state = HostSpanActivityState.Ready;
    public HostSpanActivityState State {
        get { return state; }
        set { state = value; Invalidate(); }
    }
    public HostSpanStateIcon() {
        SetStyle(System.Windows.Forms.ControlStyles.AllPaintingInWmPaint |
                 System.Windows.Forms.ControlStyles.OptimizedDoubleBuffer |
                 System.Windows.Forms.ControlStyles.SupportsTransparentBackColor |
                 System.Windows.Forms.ControlStyles.UserPaint, true);
        BackColor = Color.Transparent;
        TabStop = false;
        AccessibleRole = System.Windows.Forms.AccessibleRole.Graphic;
    }
    static Color StateColor(HostSpanActivityState value) {
        if (System.Windows.Forms.SystemInformation.HighContrast) return SystemColors.WindowText;
        if (value == HostSpanActivityState.Viewing) return SystemColors.Highlight;
        if (value == HostSpanActivityState.Controlling) return Color.FromArgb(196, 80, 0);
        return SystemColors.GrayText;
    }
    protected override void OnPaint(System.Windows.Forms.PaintEventArgs e) {
        base.OnPaint(e);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        Color color = StateColor(state);
        using (var pen = new Pen(color, 1.6f)) {
            pen.StartCap = LineCap.Round;
            pen.EndCap = LineCap.Round;
            pen.LineJoin = LineJoin.Round;
            if (state == HostSpanActivityState.Ready) {
                e.Graphics.DrawRectangle(pen, 2.5f, 2.5f, 13f, 10f);
                e.Graphics.DrawLine(pen, 9f, 12.5f, 9f, 16f);
                e.Graphics.DrawLine(pen, 5.5f, 16f, 12.5f, 16f);
                return;
            }
            if (state == HostSpanActivityState.Viewing) {
                using (var eye = new GraphicsPath()) {
                    eye.AddBezier(1f, 9f, 4f, 3f, 14f, 3f, 17f, 9f);
                    eye.AddBezier(17f, 9f, 14f, 15f, 4f, 15f, 1f, 9f);
                    e.Graphics.DrawPath(pen, eye);
                }
                using (var brush = new SolidBrush(color))
                    e.Graphics.FillEllipse(brush, 7f, 7f, 4f, 4f);
                return;
            }
        }
        using (var brush = new SolidBrush(color)) {
            var points = new[] {
                new PointF(3f, 1.5f), new PointF(3f, 16.5f),
                new PointF(7.3f, 12f), new PointF(10.5f, 17f),
                new PointF(13f, 15.5f), new PointF(10f, 10.5f),
                new PointF(16.5f, 10.5f)
            };
            e.Graphics.FillPolygon(brush, points);
        }
    }
}

public sealed class HostSpanActivity : System.Windows.Forms.Form {
    static HostSpanActivity window;
    static Exception startupError;
    static System.Threading.Thread thread;
    static readonly System.Threading.ManualResetEvent ready = new System.Threading.ManualResetEvent(false);
    readonly HostSpanStateIcon statusIcon = new HostSpanStateIcon();
    readonly System.Windows.Forms.Label statusText = new System.Windows.Forms.Label();

    protected override bool ShowWithoutActivation { get { return true; } }
    protected override System.Windows.Forms.CreateParams CreateParams {
        get { var p = base.CreateParams; p.ExStyle |= 0x08000000 | 0x20 | 0x80 | 0x80000; return p; }
    }
    protected override void WndProc(ref System.Windows.Forms.Message m) {
        if (m.Msg == 0x84) { m.Result = new IntPtr(-1); return; }
        base.WndProc(ref m);
    }
    static GraphicsPath RoundedRectangle(Rectangle bounds, int radius) {
        var p = new GraphicsPath();
        int d = radius * 2;
        p.AddArc(bounds.X, bounds.Y, d, d, 180, 90);
        p.AddArc(bounds.Right - d, bounds.Y, d, d, 270, 90);
        p.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
        p.AddArc(bounds.X, bounds.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }
    protected override void OnSizeChanged(EventArgs e) {
        base.OnSizeChanged(e);
        if (Width < 16 || Height < 16) return;
        using (var path = RoundedRectangle(new Rectangle(0, 0, Width, Height), 8)) {
            var previous = Region;
            Region = new Region(path);
            if (previous != null) previous.Dispose();
        }
    }
    protected override void OnPaint(System.Windows.Forms.PaintEventArgs e) {
        base.OnPaint(e);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using (var path = RoundedRectangle(new Rectangle(1, 1, Width - 2, Height - 2), 7))
        using (var outline = new Pen(SystemColors.ActiveBorder, 1.0f))
            e.Graphics.DrawPath(outline, path);
    }
    HostSpanActivity() {
        Text = "HostSpan screen access";
        FormBorderStyle = System.Windows.Forms.FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        SetStyle(System.Windows.Forms.ControlStyles.AllPaintingInWmPaint |
                 System.Windows.Forms.ControlStyles.OptimizedDoubleBuffer |
                 System.Windows.Forms.ControlStyles.UserPaint, true);
        StartPosition = System.Windows.Forms.FormStartPosition.Manual;
        var area = System.Windows.Forms.Screen.PrimaryScreen.WorkingArea;
        Bounds = new Rectangle(area.Right - 328, area.Top + 8, 320, 40);
        BackColor = SystemColors.Window;
        ForeColor = SystemColors.WindowText;
        statusIcon.Bounds = new Rectangle(14, 11, 18, 18);
        statusText.Bounds = new Rectangle(44, 0, 262, 40);
        statusText.Font = new Font("Segoe UI", 10.0f, FontStyle.Regular);
        statusText.ForeColor = SystemColors.WindowText;
        statusText.BackColor = Color.Transparent;
        statusText.TextAlign = ContentAlignment.MiddleLeft;
        statusText.AutoEllipsis = true;
        Controls.Add(statusIcon);
        Controls.Add(statusText);
        Shown += delegate { ready.Set(); };
    }
    public static string Message(HostSpanActivityState state) {
        if (state == HostSpanActivityState.Viewing) return "HostSpan is viewing this screen";
        if (state == HostSpanActivityState.Controlling) return "HostSpan is controlling this screen";
        return "HostSpan has screen access";
    }
    public static void SetState(HostSpanActivityState state) {
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
            string message = Message(state);
            window.Text = message;
            window.statusIcon.State = state;
            window.statusIcon.AccessibleName = message;
            window.statusText.Text = message;
            window.statusText.AccessibleName = message;
            window.Show(); window.Invalidate(); window.Update();
        }));
    }
    public static void MovePointer(int x, int y) {
        window.Invoke(new Action(delegate { HostSpanInput.MovePointer(x, y); }));
    }
    public static void HideIndicator() {
        if (window != null && window.IsHandleCreated && !window.IsDisposed)
            window.Invoke(new Action(delegate { window.Hide(); }));
    }
    public static void CloseIndicator() {
        if (window != null && window.IsHandleCreated && !window.IsDisposed)
            window.Invoke(new Action(delegate { window.Close(); }));
    }
}
'@
[void][HostSpanInput]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
$opened = $false
# Input is sent immediately; only its acknowledgement waits long enough for the
# controlling indicator to survive multiple display refreshes.
$MinimumControllingVisibilityMilliseconds = 250

# The input desktop can change after open (lock, UAC, console switch).
# Recheck console ownership and input desktop before every capture/input.
function TestInteractiveDesktop($sessionId, $consoleSessionId, $userInteractive, $station, $desktop, $inputDesktop) {
    return ($sessionId -gt 0 -and $sessionId -eq $consoleSessionId -and
        $userInteractive -eq $true -and $station -ieq 'WinSta0' -and
        $desktop -ieq 'Default' -and $inputDesktop -ieq 'Default')
}
function AssertInteractiveDesktop {
    $sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
    $consoleSessionId = [HostSpanInput]::ActiveConsoleSessionId()
    $userInteractive = [Environment]::UserInteractive
    $station = [HostSpanInput]::WindowStation()
    $desktop = [HostSpanInput]::CurrentDesktop()
    $inputDesktop = [HostSpanInput]::InputDesktop()
    if (-not (TestInteractiveDesktop $sessionId $consoleSessionId $userInteractive $station $desktop $inputDesktop)) {
        throw 'HostSpan requires the unlocked active Windows console desktop; Session 0, disconnected sessions and secure desktops are unavailable.'
    }
}

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
    if ($action -eq 'close') { $script:opened=$false; [HostSpanActivity]::HideIndicator(); return @{closed=$true} }
    if ($action -eq 'open') {
        AssertInteractiveDesktop
        $geometry=Geometry
        # Fail closed if the session cannot show a non-focusing access badge.
        [HostSpanActivity]::SetState([HostSpanActivityState]::Ready)
        $script:opened=$true
        return $geometry
    }
    if (-not $opened) { throw 'Desktop session is closed' }
    if ($action -in @('observe','move','click','key','text','scroll')) { AssertInteractiveDesktop }
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
                $command.modifiers.Count -gt 3 -or
                @($command.modifiers | Where-Object { $_ -isnot [string] -or $_ -cnotin @('Shift','Alt','Meta') }).Count -gt 0 -or
                @($command.modifiers | Select-Object -Unique).Count -ne $command.modifiers.Count)) {
                throw 'Unsupported modifiers'
            }
            $shifted=$command.modifiers -contains 'Shift'
            $alt=$command.modifiers -contains 'Alt'
            $meta=$command.modifiers -contains 'Meta'
            try {
                if ($shifted) { [HostSpanInput]::ScanKey(42,$false) }
                try {
                    if ($alt) { [HostSpanInput]::Key(18,$false) }
                    try {
                        if ($meta) { [HostSpanInput]::Key(91,$false) }
                        try {
                            if ($physical.ContainsKey($command.key)) { [HostSpanInput]::ScanKey($physical[$command.key],$false) }
                            else { [HostSpanInput]::Key($keys[$command.key],$false) }
                        } finally {
                            if ($physical.ContainsKey($command.key)) { [HostSpanInput]::ScanKey($physical[$command.key],$true) }
                            else { [HostSpanInput]::Key($keys[$command.key],$true) }
                        }
                    } finally { if ($meta) { [HostSpanInput]::Key(91,$true) } }
                } finally { if ($alt) { [HostSpanInput]::Key(18,$true) } }
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
    $indicatorState=$null
    try {
        $command=$line | ConvertFrom-Json
        if ($null -eq $command.id -or $command.id -isnot [string]) { break }
        if ($opened -and $command.action -in @('observe','move','click','key','text','scroll')) {
            AssertInteractiveDesktop
            $indicatorState = if ($command.action -eq 'observe') {
                [HostSpanActivityState]::Viewing
            } else {
                [HostSpanActivityState]::Controlling
            }
            [HostSpanActivity]::SetState($indicatorState)
        }
        $dispatchResult = Dispatch $command
        if ($indicatorState -eq [HostSpanActivityState]::Controlling) {
            [System.Threading.Thread]::Sleep($MinimumControllingVisibilityMilliseconds)
        }
        $reply=@{id=$command.id;result=$dispatchResult}
    } catch { $reply=@{id=$command.id;error=$_.Exception.Message} }
    finally { if ($null -ne $indicatorState) { [HostSpanActivity]::SetState([HostSpanActivityState]::Ready) } }
    [Console]::WriteLine(($reply | ConvertTo-Json -Depth 8 -Compress))
} } finally { [HostSpanActivity]::CloseIndicator() }
