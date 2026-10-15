"""Session-local Wayland capture/input. Private parent pipe; no listening service."""

import base64
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
from gi.repository import GLib, Gst

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


def request(method, *args, **values):
    token = "hostspan_" + uuid.uuid4().hex
    sender = bus.get_unique_name()[1:].replace(".", "_")
    path = f"/org/freedesktop/portal/desktop/request/{sender}/{token}"
    pending = GLib.MainLoop()
    response = []

    def received(code, result):
        response.extend([int(code), result])
        pending.quit()

    def expired():
        response.extend([2, {}])
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
    timer = GLib.timeout_add_seconds(60, expired)
    try:
        actual = method(*args, options(handle_token=token, **values))
        if str(actual) != path:
            raise RuntimeError("Portal returned an unexpected request handle")
        if not response:
            pending.run()
        if response[0] != 0:
            raise RuntimeError(f"Portal request denied, canceled or expired (response={response[0]})")
        return response[1]
    finally:
        match.remove()
        if GLib.MainContext.default().find_source_by_id(timer):
            GLib.source_remove(timer)


def close_session():
    global session, stream, stream_size, pipewire_fd, closed_match, clipboard_enabled, clipboard_text
    previous, session = session, None
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
        created = request(remote.CreateSession, session_handle_token="hostspan_" + uuid.uuid4().hex)
        session = str(created["session_handle"])
        closed_match = bus.add_signal_receiver(
            session_closed, signal_name="Closed",
            dbus_interface="org.freedesktop.portal.Session", bus_name=BUS_NAME, path=session)
        request(remote.SelectDevices, session, types=dbus.UInt32(3), persist_mode=dbus.UInt32(0))
        # Screen selection is explicit. No restore token or persistent permission is created.
        request(cast.SelectSources, session, types=dbus.UInt32(1), multiple=False,
                cursor_mode=dbus.UInt32(2))
        try:
            clipboard.RequestClipboard(session, options())
        except dbus.DBusException:
            pass  # Older portals still support observation/pointer/keys; text must fail explicitly.
        started = request(remote.Start, session, "")
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
        return {"backend": "wayland-portal", "text_supported": clipboard_enabled, "coordinate_width": stream_size[0],
                "coordinate_height": stream_size[1]}
    except Exception:
        close_session()
        raise


def observe():
    if not session or pipewire_fd is None:
        raise RuntimeError("Desktop session is closed")
    pipeline = Gst.parse_launch(
        f"pipewiresrc fd={pipewire_fd} path={int(stream)} do-timestamp=true ! "
        "videoconvert ! pngenc snapshot=true ! appsink name=frame sync=false max-buffers=1 drop=true emit-signals=true")
    capture_wait = GLib.MainLoop()
    samples = []

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
            message = pipeline.get_bus().pop_filtered(Gst.MessageType.ERROR)
            reason = str(message.parse_error()[0]) if message else "No frame within capture deadline"
            raise RuntimeError(reason)
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
        pipeline.set_state(Gst.State.NULL)


def key(keysym):
    try:
        remote.NotifyKeyboardKeysym(session, options(), dbus.Int32(keysym), dbus.UInt32(1))
    finally:
        remote.NotifyKeyboardKeysym(session, options(), dbus.Int32(keysym), dbus.UInt32(0))


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
        key({"Enter": 0xFF0D, "Tab": 0xFF09, "Escape": 0xFF1B, "Backspace": 0xFF08,
             "Delete": 0xFFFF, "Left": 0xFF51, "Up": 0xFF52, "Right": 0xFF53,
             "Down": 0xFF54, "Home": 0xFF50, "End": 0xFF57}[command["key"]])
    elif action == "scroll":
        remote.NotifyPointerAxis(session, options(finish=True), float(command["dx"]), float(command["dy"]))
    else:
        raise ValueError("Unsupported desktop action")
    # Dispatch success does not claim the application processed the event.
    return {"dispatched": True}


def reply(command):
    try:
        result = {"id": command["id"], "result": dispatch(command)}
    except Exception as error:
        result = {"id": command.get("id"), "error": str(error)}
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
