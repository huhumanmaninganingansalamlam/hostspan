"""Session-local Wayland capture/input. Private parent pipe; no listening service."""

import base64
import ctypes
import json
import os
import select
import sys
import threading
import time
import uuid

import dbus
from dbus.mainloop.glib import DBusGMainLoop
import gi

gi.require_version("Gst", "1.0")
gi.require_version("Gtk", "3.0")
gi.require_version("GdkX11", "3.0")
from gi.repository import GLib, Gst, Gtk, Gdk, GdkX11, Pango

DBusGMainLoop(set_as_default=True)
Gst.init(None)
BUS_NAME = "org.freedesktop.portal.Desktop"
OBJECT_PATH = "/org/freedesktop/portal/desktop"
bus = dbus.SessionBus()
portal = bus.get_object(BUS_NAME, OBJECT_PATH)
remote = dbus.Interface(portal, "org.freedesktop.portal.RemoteDesktop")
cast = dbus.Interface(portal, "org.freedesktop.portal.ScreenCast")
clipboard = dbus.Interface(portal, "org.freedesktop.portal.Clipboard")
loop = GLib.MainLoop()
session = None
stream = None
stream_size = None
pipewire_fd = None
closed_match = None
clipboard_enabled = False
clipboard_text = b""
paste_wait = None
paste_transferred = False
activity_window = None
activity_label = None
activity_icon = None
activity_card = None
# Input is posted before this dwell. Holding the acknowledgement prevents the
# parent's automatic observation from replacing the controlling state too fast
# for a person (or a display refresh) to see it.
MINIMUM_CONTROLLING_VISIBLE_SECONDS = 0.25


def enforce_x11_click_through(window):
    """Fail closed unless XWayland's actual ShapeInput is empty.

    Gdk.Window.set_pass_through(True) alone can report success while the X11
    window still has a full-size input region (observed on Ubuntu XWayland).
    Use XShape directly on this *own* GTK window and verify the server result.
    No screen, portal grant, or other window is modified.
    """
    native = window.get_window()
    if native is None:
        raise RuntimeError("Screen access indicator has no native X11 window")
    native.set_pass_through(True)
    xid = int(GdkX11.X11Window.get_xid(native))
    if not xid:
        raise RuntimeError("Screen access indicator has no X11 window ID")

    x11 = ctypes.CDLL("libX11.so.6")
    xext = ctypes.CDLL("libXext.so.6")
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x11.XFree.argtypes = [ctypes.c_void_p]
    xext.XShapeQueryExtension.argtypes = [
        ctypes.c_void_p, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)
    ]
    xext.XShapeQueryExtension.restype = ctypes.c_int
    xext.XShapeCombineRectangles.argtypes = [
        ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int,
        ctypes.c_int, ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int
    ]
    xext.XShapeGetRectangles.argtypes = [
        ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int,
        ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)
    ]
    xext.XShapeGetRectangles.restype = ctypes.c_void_p

    display_name = os.environ.get("DISPLAY")
    display = x11.XOpenDisplay(display_name.encode("utf-8") if display_name else None)
    if not display:
        raise RuntimeError("Cannot verify screen access indicator X11 input region")
    try:
        event = ctypes.c_int()
        error = ctypes.c_int()
        if not xext.XShapeQueryExtension(display, ctypes.byref(event), ctypes.byref(error)):
            raise RuntimeError("X11 Shape extension is required for click-through")
        # ShapeInput=2, ShapeSet=0, Unsorted=0: no area intercepts a click.
        xext.XShapeCombineRectangles(display, xid, 2, 0, 0, None, 0, 0, 0)
        x11.XSync(display, 0)
        count = ctypes.c_int()
        ordering = ctypes.c_int()
        rectangles = xext.XShapeGetRectangles(
            display, xid, 2, ctypes.byref(count), ctypes.byref(ordering)
        )
        if rectangles:
            x11.XFree(rectangles)
        if count.value != 0:
            raise RuntimeError("Screen access indicator is not click-through")
    finally:
        x11.XCloseDisplay(display)


def activity(state=None):
    """Persistent, non-focusing and click-through screen access status strip."""
    global activity_window, activity_label, activity_icon, activity_card
    if state is None:
        if activity_window:
            activity_window.destroy()
            activity_window = activity_label = activity_icon = activity_card = None
        return False
    # A single sentence and a symbolic icon carry the state. The surface uses
    # the desktop theme rather than reproducing a branded dashboard card.
    states = {
        "waiting": ("Waiting to share screen with HostSpan", "content-loading-symbolic"),
        "ready": ("HostSpan has screen access", "video-display-symbolic"),
        "viewing": ("HostSpan is viewing this screen", "view-reveal-symbolic"),
        "controlling": ("HostSpan is controlling this screen", "input-mouse-symbolic"),
    }
    if state not in states:
        raise ValueError("Unknown screen access indicator state")
    if activity_window is None:
        # Wayland toplevels cannot honor accept_focus=False. Use the existing
        # XWayland display for this noninteractive status strip; capture/input stay portal-native.
        display_name = os.environ.get("DISPLAY")
        display = Gdk.Display.open(display_name) if display_name else None
        if display is None or display.get_name() != display_name:
            raise RuntimeError("The non-focusing activity indicator requires the desktop X11 display")
        screen = display.get_default_screen()
        activity_window = Gtk.Window(title="HostSpan screen access")
        activity_window.set_screen(screen)
        activity_window.set_app_paintable(True)
        visual = screen.get_rgba_visual()
        if visual:
            activity_window.set_visual(visual)
        activity_window.set_decorated(False)
        activity_window.set_accept_focus(False)
        activity_window.set_focus_on_map(False)
        activity_window.set_keep_above(True)
        activity_window.set_skip_taskbar_hint(True)
        activity_window.set_skip_pager_hint(True)
        activity_window.set_type_hint(Gdk.WindowTypeHint.NOTIFICATION)
        activity_window.connect("realize", lambda window: window.get_window().set_pass_through(True))
        activity_window.set_resizable(False)
        activity_window.set_default_size(320, 40)
        css = Gtk.CssProvider()
        css.load_from_data(b"""
          #hostspan-access-window { background-color: transparent; }
          #hostspan-access-card {
              background-color: @theme_bg_color;
              color: @theme_fg_color;
              border: 1px solid @borders;
              border-radius: 8px;
              box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
          }
          #hostspan-access-icon { color: @theme_fg_color; }
          #hostspan-access-status {
              color: @theme_fg_color;
              font-size: 13px;
              font-weight: 500;
          }
        """)
        Gtk.StyleContext.add_provider_for_screen(screen, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        activity_window.set_name("hostspan-access-window")

        card = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=0)
        card.set_name("hostspan-access-card")
        card.set_size_request(320, 40)
        icon = Gtk.Image()
        icon.set_name("hostspan-access-icon")
        icon.set_pixel_size(18)
        icon.set_margin_start(14)
        icon.set_margin_end(12)
        card.pack_start(icon, False, False, 0)

        label = Gtk.Label()
        label.set_name("hostspan-access-status")
        label.set_xalign(0)
        label.set_single_line_mode(True)
        label.set_ellipsize(Pango.EllipsizeMode.END)
        label.set_margin_end(14)
        card.pack_start(label, True, True, 0)
        activity_window.add(card)
        activity_label = label
        activity_icon = icon
        activity_card = card
    message, icon_name = states[state]
    activity_window.set_title(message)
    activity_icon.set_from_icon_name(icon_name, Gtk.IconSize.BUTTON)
    activity_icon.set_pixel_size(18)
    activity_label.set_text(message)
    # Set ShapeInput before mapping as well as after; GTK/XWayland can reset
    # the input shape while mapping or changing the displayed status.
    try:
        activity_window.realize()
        enforce_x11_click_through(activity_window)
        activity_window.show_all()
        enforce_x11_click_through(activity_window)
    except Exception:
        activity(None)
        raise
    # Keep the strip inside the primary monitor's usable top-right corner.
    screen = activity_window.get_screen()
    primary = screen.get_primary_monitor()
    monitor = primary if primary >= 0 else 0
    if hasattr(screen, "get_monitor_workarea"):
        area = screen.get_monitor_workarea(monitor)
    else:
        area = screen.get_monitor_geometry(monitor)
    activity_window.move(area.x + area.width - 328, area.y + 8)
    activity_window.get_display().flush()
    return False

def hold_controlling_visible():
    """Paint the controlling state, then retain it for a human-visible interval."""
    context = GLib.MainContext.default()
    while context.pending():
        context.iteration(False)
    time.sleep(MINIMUM_CONTROLLING_VISIBLE_SECONDS)


def selection_transfer(handle, mime, serial):
    if str(handle) != session:
        return
    if mime not in ("text/plain;charset=utf-8", "text/plain"):
        clipboard.SelectionWriteDone(session, serial, False)
        return
    owner = session
    payload = clipboard_text
    waiter = paste_wait
    fd = clipboard.SelectionWrite(owner, serial).take()

    def completed(success):
        global paste_transferred
        if session != owner:
            return False
        clipboard.SelectionWriteDone(owner, serial, success)
        if success and paste_wait is waiter:
            paste_transferred = True
        if waiter:
            waiter.quit()
        return False

    def write():
        success = False
        try:
            os.set_blocking(fd, False)
            remaining = memoryview(payload)
            deadline = time.monotonic() + 5
            while remaining:
                timeout = deadline - time.monotonic()
                if timeout <= 0 or not select.select([], [fd], [], timeout)[1]:
                    raise TimeoutError("Clipboard transfer deadline exceeded")
                remaining = remaining[os.write(fd, remaining):]
            success = True
        except (OSError, TimeoutError):
            success = False
        finally:
            os.close(fd)
            GLib.idle_add(completed, success)

    threading.Thread(target=write, daemon=True).start()


bus.add_signal_receiver(selection_transfer, signal_name="SelectionTransfer",
                        dbus_interface="org.freedesktop.portal.Clipboard",
                        bus_name=BUS_NAME, path=OBJECT_PATH)


def options(**values):
    return dbus.Dictionary(values, signature="sv")


class PortalRequestError(RuntimeError):
    def __init__(self, message, **details):
        super().__init__(message)
        self.details = details


def request(method, *args, phase, wait_for_consent=False, **values):
    token = "hostspan_" + uuid.uuid4().hex
    sender = bus.get_unique_name()[1:].replace(".", "_")
    path = f"/org/freedesktop/portal/desktop/request/{sender}/{token}"
    pending = GLib.MainLoop()
    response = []
    timed_out = False

    def received(code, result):
        response.extend([int(code), result])
        pending.quit()

    def expired():
        nonlocal timed_out
        timed_out = True
        pending.quit()
        try:
            dbus.Interface(bus.get_object(BUS_NAME, path),
                           "org.freedesktop.portal.Request").Close()
        except dbus.DBusException:
            pass
        return False

    match = bus.add_signal_receiver(received, signal_name="Response",
                                    dbus_interface="org.freedesktop.portal.Request",
                                    bus_name=BUS_NAME, path=path)
    # Start waits for the human until the portal responds or this worker is closed.
    # Only noninteractive setup has a local deadline; it is never an OS response.
    timer = None if wait_for_consent else GLib.timeout_add_seconds(60, expired)
    try:
        actual = method(*args, options(handle_token=token, **values))
        if str(actual) != path:
            raise RuntimeError("Portal returned an unexpected request handle")
        if not response and not timed_out:
            pending.run()
        if timed_out:
            raise PortalRequestError(f"Portal setup timed out locally during {phase}",
                                     reason="portal_local_timeout", portal_phase=phase)
        if response[0] != 0:
            raise PortalRequestError(f"Portal returned response={response[0]} during {phase}",
                                     reason="portal_response", portal_phase=phase,
                                     portal_response=response[0])
        return response[1]
    finally:
        match.remove()
        if timer is not None and GLib.MainContext.default().find_source_by_id(timer):
            GLib.source_remove(timer)


def close_session():
    global session, stream, stream_size, pipewire_fd, closed_match, clipboard_enabled, clipboard_text
    previous, session = session, None
    activity()
    stream = stream_size = None
    clipboard_enabled = False
    clipboard_text = b""
    if paste_wait:
        paste_wait.quit()
    if closed_match:
        closed_match.remove()
        closed_match = None
    if pipewire_fd is not None:
        os.close(pipewire_fd)
        pipewire_fd = None
    if previous:
        try:
            dbus.Interface(bus.get_object(BUS_NAME, previous),
                           "org.freedesktop.portal.Session").Close()
        except dbus.DBusException:
            pass


def session_closed(*unused):
    print(json.dumps({"event": "closed"}), flush=True)
    close_session()
    loop.quit()


def open_session():
    global session, stream, stream_size, pipewire_fd, closed_match, clipboard_enabled
    if session:
        raise RuntimeError("A desktop session is already open")
    # Check capture dependencies before asking the user for screen/input consent.
    for plugin in ("pipewiresrc", "videoconvert", "pngenc", "appsink"):
        if not Gst.ElementFactory.find(plugin):
            raise RuntimeError(f"Required GStreamer plugin is unavailable: {plugin}")
    try:
        # Display the non-focusing, click-through waiting state while the actual
        # operating-system portal remains the sole authority for consent.
        activity("waiting")
        created = request(remote.CreateSession, phase="CreateSession", session_handle_token="hostspan_" + uuid.uuid4().hex)
        session = str(created["session_handle"])
        closed_match = bus.add_signal_receiver(
            session_closed, signal_name="Closed",
            dbus_interface="org.freedesktop.portal.Session", bus_name=BUS_NAME, path=session)
        request(remote.SelectDevices, session, phase="SelectDevices", types=dbus.UInt32(3), persist_mode=dbus.UInt32(0))
        # Screen selection is explicit. No restore token or persistent permission is created.
        request(cast.SelectSources, session, phase="SelectSources", types=dbus.UInt32(1), multiple=False,
                cursor_mode=dbus.UInt32(2))
        try:
            clipboard.RequestClipboard(session, options())
        except dbus.DBusException:
            pass  # Older portals still support observation/pointer/keys; text must fail explicitly.
        started = request(remote.Start, session, "", phase="Start", wait_for_consent=True)
        clipboard_enabled = bool(started.get("clipboard_enabled", False))
        if int(started.get("devices", 0)) & 3 != 3:
            raise RuntimeError("Portal did not grant both pointer and keyboard")
        streams = started.get("streams", [])
        if len(streams) != 1:
            raise RuntimeError("Portal must return exactly one selected screen")
        stream, properties = streams[0]
        stream_size = tuple(int(n) for n in properties["size"])
        pipewire_fd = cast.OpenPipeWireRemote(session, options()).take()
        # Mutter creates the virtual keyboard lazily. Register it before the required
        # first observation, so headless clients receive their keymap before input.
        # VoidSymbol has no key mapping, so it creates no application key or modifier.
        remote.NotifyKeyboardKeysym(session, options(), dbus.Int32(0xFFFFFF), dbus.UInt32(1))
        remote.NotifyKeyboardKeysym(session, options(), dbus.Int32(0xFFFFFF), dbus.UInt32(0))
        # A successfully consented session must be visible even between calls.
        # Failing to display the non-focusing badge closes the portal session.
        activity("ready")
        return {"pipewire_node_id": int(stream), "backend": "wayland-portal", "text_supported": clipboard_enabled, "coordinate_width": stream_size[0],
                "coordinate_height": stream_size[1]}
    except Exception:
        close_session()
        raise


def observe():
    if not session or pipewire_fd is None:
        raise RuntimeError("Desktop session is closed")
    pipeline = Gst.parse_launch(
        f"pipewiresrc name=capture_source fd={pipewire_fd} path={int(stream)} do-timestamp=true ! "
        "videoconvert ! pngenc snapshot=true ! appsink name=frame sync=false max-buffers=1 drop=true emit-signals=true")
    capture_wait = GLib.MainLoop()
    samples = []
    source_buffers = 0

    def source_frame(pad, info):
        nonlocal source_buffers
        source_buffers += 1
        return Gst.PadProbeReturn.OK

    source_pad = pipeline.get_by_name("capture_source").get_static_pad("src")
    probe = source_pad.add_probe(Gst.PadProbeType.BUFFER, source_frame)

    def frame_ready(sink):
        samples.append(sink.emit("pull-sample"))
        GLib.idle_add(capture_wait.quit)
        return Gst.FlowReturn.OK

    sink = pipeline.get_by_name("frame")
    handler = sink.connect("new-sample", frame_ready)
    timer = GLib.timeout_add(5000, lambda: (capture_wait.quit(), False)[1])
    try:
        pipeline.set_state(Gst.State.PLAYING)
        # Keep portal Closed and clipboard signals flowing while waiting for a frame.
        if not samples:
            capture_wait.run()
        sample = samples[0] if samples else None
        if sample is None:
            message = pipeline.get_bus().pop_filtered(Gst.MessageType.ERROR | Gst.MessageType.EOS)
            failed = message is not None and message.type == Gst.MessageType.ERROR
            _, current, pending = pipeline.get_state(0)
            raise PortalRequestError(str(message.parse_error()[0]) if failed else "No frame within capture deadline",
                                     reason="portal_capture_error" if failed else "portal_capture_no_frame",
                                     capture_source_buffers=source_buffers,
                                     capture_pipeline_state=current.value_nick,
                                     capture_pending_state=pending.value_nick,
                                     capture_eos=message is not None and message.type == Gst.MessageType.EOS)
        buffer = sample.get_buffer()
        if buffer.get_size() > 16 * 1024 * 1024:
            raise RuntimeError("Captured PNG exceeds 16 MiB")
        caps = sample.get_caps().get_structure(0)
        return {"text_supported": clipboard_enabled,
                "image": base64.b64encode(buffer.extract_dup(0, buffer.get_size())).decode("ascii"),
                "mime_type": "image/png", "width": caps.get_value("width"),
                "height": caps.get_value("height"), "coordinate_width": stream_size[0],
                "coordinate_height": stream_size[1]}
    finally:
        if GLib.MainContext.default().find_source_by_id(timer):
            GLib.source_remove(timer)
        sink.disconnect(handler)
        source_pad.remove_probe(probe)
        pipeline.set_state(Gst.State.NULL)


def key(code, physical=False):
    notify = remote.NotifyKeyboardKeycode if physical else remote.NotifyKeyboardKeysym
    try:
        notify(session, options(), dbus.Int32(code), dbus.UInt32(1))
    finally:
        notify(session, options(), dbus.Int32(code), dbus.UInt32(0))


def dispatch(command):
    global clipboard_text, paste_wait, paste_transferred
    action = command["action"]
    if action == "open":
        return open_session()
    if action == "close":
        close_session()
        return {"closed": True}
    if not session:
        raise RuntimeError("Desktop session is closed")
    if action == "observe":
        return observe()
    if action == "click" or action == "move":
        x, y = command["x"], command["y"]
        if not (0 <= x < stream_size[0] and 0 <= y < stream_size[1]):
            raise ValueError("Pointer coordinates are outside the selected screen")
        remote.NotifyPointerMotionAbsolute(session, options(), dbus.UInt32(stream), float(x), float(y))
        if action == "click":
            button = {"left": 272, "right": 273, "middle": 274}[command.get("button", "left")]
            try:
                remote.NotifyPointerButton(session, options(), dbus.Int32(button), dbus.UInt32(1))
            finally:
                remote.NotifyPointerButton(session, options(), dbus.Int32(button), dbus.UInt32(0))
    elif action == "text":
        if not clipboard_enabled:
            raise RuntimeError("Portal clipboard permission is required for exact text input; key simulation cannot preserve IME text")
        text = command["text"]
        if not isinstance(text, str) or len(text) > 4096:
            raise ValueError("Text must contain at most 4096 characters")
        clipboard_text = text.encode("utf-8")
        clipboard.SetSelection(session, options(mime_types=dbus.Array(
            ["text/plain;charset=utf-8", "text/plain"], signature="s")))
        paste_transferred = False
        paste_wait = GLib.MainLoop()
        timer = GLib.timeout_add_seconds(6, lambda: (paste_wait.quit(), False)[1])
        try:
            # Physical Ctrl+V selects the application's paste command; no text passes through the IME.
            try:
                remote.NotifyKeyboardKeycode(session, options(), dbus.Int32(29), dbus.UInt32(1))
                try:
                    remote.NotifyKeyboardKeycode(session, options(), dbus.Int32(47), dbus.UInt32(1))
                finally:
                    remote.NotifyKeyboardKeycode(session, options(), dbus.Int32(47), dbus.UInt32(0))
            finally:
                remote.NotifyKeyboardKeycode(session, options(), dbus.Int32(29), dbus.UInt32(0))
            if not paste_transferred:
                paste_wait.run()
            if not paste_transferred:
                raise RuntimeError("Paste dispatched but clipboard transfer was not confirmed; do not resend automatically")
        finally:
            if GLib.MainContext.default().find_source_by_id(timer):
                GLib.source_remove(timer)
            paste_wait = None
    elif action == "key":
        physical = {"KeyA": 30, "KeyB": 48, "KeyC": 46, "KeyD": 32, "KeyE": 18, "KeyF": 33,
                    "KeyG": 34, "KeyH": 35, "KeyI": 23, "KeyJ": 36, "KeyK": 37, "KeyL": 38,
                    "KeyM": 50, "KeyN": 49, "KeyO": 24, "KeyP": 25, "KeyQ": 16, "KeyR": 19,
                    "KeyS": 31, "KeyT": 20, "KeyU": 22, "KeyV": 47, "KeyW": 17, "KeyX": 45,
                    "KeyY": 21, "KeyZ": 44}
        symbols = {"Enter": 0xFF0D, "Tab": 0xFF09, "Escape": 0xFF1B, "Backspace": 0xFF08,
                   "Delete": 0xFFFF, "Left": 0xFF51, "Up": 0xFF52, "Right": 0xFF53,
                   "Down": 0xFF54, "Home": 0xFF50, "End": 0xFF57}
        name = command["key"]
        modifiers = command.get("modifiers", [])
        if name not in physical and name not in symbols or modifiers not in ([], ["Shift"]):
            raise ValueError("Unsupported key or modifiers")
        shifted = modifiers == ["Shift"]
        try:
            if shifted:
                remote.NotifyKeyboardKeycode(session, options(), dbus.Int32(42), dbus.UInt32(1))
            key(physical[name] if name in physical else symbols[name], physical=name in physical)
        finally:
            if shifted:
                remote.NotifyKeyboardKeycode(session, options(), dbus.Int32(42), dbus.UInt32(0))
    elif action == "scroll":
        remote.NotifyPointerAxis(session, options(finish=True), float(command["dx"]), float(command["dy"]))
    else:
        raise ValueError("Unsupported desktop action")
    # Dispatch success does not claim the application processed the event.
    return {"dispatched": True}


def reply(command):
    indicator_state = None
    try:
        if session and command.get("action") in ("observe", "move", "click", "key", "text", "scroll"):
            indicator_state = "viewing" if command.get("action") == "observe" else "controlling"
            activity(indicator_state)
        dispatch_result = dispatch(command)
        if indicator_state == "controlling" and dispatch_result.get("dispatched") is True:
            hold_controlling_visible()
        result = {"id": command["id"], "result": dispatch_result}
    except Exception as error:
        result = {"id": command.get("id"), "error": str(error)}
        if isinstance(error, PortalRequestError):
            result["error_details"] = error.details
    finally:
        if indicator_state and session:
            activity("ready")
    print(json.dumps(result, ensure_ascii=True), flush=True)
    return False


def read_commands():
    while True:
        line = sys.stdin.buffer.readline(65537)
        if not line:
            GLib.idle_add(loop.quit)
            return
        if len(line) > 65536:
            GLib.idle_add(loop.quit)
            return
        try:
            command = json.loads(line)
            if not isinstance(command, dict):
                raise ValueError("Expected object")
        except (ValueError, UnicodeError):
            GLib.idle_add(loop.quit)
            return
        GLib.idle_add(reply, command)


threading.Thread(target=read_commands, daemon=True).start()
try:
    loop.run()
finally:
    close_session()
