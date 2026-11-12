"""Exercise consent and keyboard dispatch without a desktop/DBus session."""
import ast
import ctypes
from pathlib import Path
from types import SimpleNamespace
import uuid

source = ast.parse(Path("src/computer/portal-worker.py").read_text())
request_code = compile(ast.Module(body=[node for node in source.body
    if isinstance(node, (ast.ClassDef, ast.FunctionDef))
    and node.name in ("PortalRequestError", "request")], type_ignores=[]), "portal-worker.py", "exec")


def exercise(response_code=None, consent=False):
    callbacks = {}
    timers = {}
    removed = []
    closed = []
    clock = [0]
    match = SimpleNamespace(remove=lambda: removed.append(True))

    def subscribe(callback, **kwargs):
        callbacks["response"] = callback
        return match

    def method(*args):
        return "/org/freedesktop/portal/desktop/request/1_2/" + args[-1]["handle_token"]

    def run():
        # The user chooses after both former 60s and 190s deadlines.
        if timers:
            seconds, callback = timers[1]
            clock[0] += seconds
            callback()
        else:
            clock[0] += 240
            callbacks["response"](response_code, {"streams": ["selected"]})

    def timeout(seconds, callback):
        timers[1] = (seconds, callback)
        return 1

    namespace = {
        "uuid": uuid,
        "BUS_NAME": "org.freedesktop.portal.Desktop",
        "options": lambda **values: values,
        "bus": SimpleNamespace(get_unique_name=lambda: ":1.2", add_signal_receiver=subscribe,
                               get_object=lambda *args: None),
        "dbus": SimpleNamespace(Interface=lambda *args: SimpleNamespace(Close=lambda: closed.append(True)),
                                DBusException=Exception),
        "GLib": SimpleNamespace(MainLoop=lambda: SimpleNamespace(run=run, quit=lambda: None),
                                timeout_add_seconds=timeout, source_remove=lambda value: timers.pop(value),
                                MainContext=SimpleNamespace(default=lambda: SimpleNamespace(
                                    find_source_by_id=lambda value: value in timers))),
    }
    exec(request_code, namespace)
    try:
        result = namespace["request"](method, phase="Start" if consent else "CreateSession",
                                      wait_for_consent=consent)
        assert result == {"streams": ["selected"]}
        assert response_code == 0 and clock[0] == 240 and not closed
    except namespace["PortalRequestError"] as error:
        if consent:
            assert error.details == {"reason": "portal_response", "portal_phase": "Start",
                                     "portal_response": response_code}
            assert response_code in (1, 2) and clock[0] == 240 and not closed
        else:
            assert error.details == {"reason": "portal_local_timeout", "portal_phase": "CreateSession"}
            assert closed == [True]
    finally:
        assert removed == [True] and not timers


for code in (0, 1, 2):
    exercise(code, consent=True)
exercise()

keyboard_code = compile(ast.Module(body=[node for node in source.body
    if isinstance(node, ast.FunctionDef) and node.name in ("key", "dispatch")], type_ignores=[]),
    "portal-worker.py", "exec")


def exercise_keyboard(name, modifiers=(), fail=None):
    events = []

    def notify(kind, owner, opts, code, state):
        assert owner == "existing-session" and opts == {}
        event = (kind, code, state)
        events.append(event)
        if event == fail:
            raise RuntimeError("injected input failure")

    namespace = {
        "session": "existing-session", "options": lambda: {},
        "dbus": SimpleNamespace(Int32=int, UInt32=int),
        "remote": SimpleNamespace(
            NotifyKeyboardKeycode=lambda *args: notify("code", *args),
            NotifyKeyboardKeysym=lambda *args: notify("symbol", *args)),
    }
    exec(keyboard_code, namespace)
    command = {"action": "key", "key": name}
    if modifiers != ():
        command["modifiers"] = modifiers
    try:
        assert namespace["dispatch"](command) == {"dispatched": True}
        assert fail is None
    except RuntimeError as error:
        assert fail is not None and str(error) == "injected input failure"
    return events


for row, start in (("QWERTYUIOP", 16), ("ASDFGHJKL", 30), ("ZXCVBNM", 44)):
    for code, letter in enumerate(row, start):
        assert exercise_keyboard("Key" + letter) == [("code", code, 1), ("code", code, 0)]

shift_r = [("code", 42, 1), ("code", 19, 1), ("code", 19, 0), ("code", 42, 0)]
assert exercise_keyboard("KeyR", ["Shift"]) == shift_r
for event in shift_r:
    expected = [shift_r[0], shift_r[-1]] if event == shift_r[0] else shift_r
    assert exercise_keyboard("KeyR", ["Shift"], fail=event) == expected
assert exercise_keyboard("Enter") == [("symbol", 0xFF0D, 1), ("symbol", 0xFF0D, 0)]
assert exercise_keyboard("Left", ["Shift"]) == [
    ("code", 42, 1), ("symbol", 0xFF51, 1), ("symbol", 0xFF51, 0), ("code", 42, 0)]
for modifiers in (["Control"], ["Shift", "Shift"], "Shift", None):
    try:
        exercise_keyboard("KeyR", modifiers)
    except ValueError:
        pass
    else:
        raise AssertionError("Unsupported modifiers were accepted")

# An active request is distinct from an idle connection or a consent prompt.
reply_code = compile(ast.Module(body=[node for node in source.body
    if isinstance(node, ast.FunctionDef) and node.name == "reply"], type_ignores=[]),
    "portal-worker.py", "exec")
for action in ("observe", "move", "click", "key", "text", "scroll", "open", "close"):
    for fails in (False, True):
        events = []
        def dispatch(command):
            events.append("dispatch")
            if fails:
                raise RuntimeError("request failed")
            return {"dispatched": True}
        namespace = {"session": "existing-session", "activity": lambda active: events.append(active),
                     "dispatch": dispatch, "hold_controlling_visible": lambda: events.append("hold"),
                     "PortalRequestError": RuntimeError,
                     "json": __import__("json"), "print": lambda *args, **kwargs: None}
        # The fake ordinary failure carries no structured portal details.
        namespace["PortalRequestError"] = type("PortalFailure", (Exception,), {})
        exec(reply_code, namespace)
        namespace["reply"]({"id": "status-test", "action": action, "text": "private input"})
        if action in ("open", "close"):
            expected = ["dispatch"]
        elif action == "observe":
            expected = ["viewing", "dispatch", "ready"]
        elif fails:
            expected = ["controlling", "dispatch", "ready"]
        else:
            expected = ["controlling", "dispatch", "hold", "ready"]
        assert events == expected, (action, fails, events)

# The visibility dwell must paint pending GTK work and delay only successful input.
hold_node = next(node for node in source.body
                 if isinstance(node, ast.FunctionDef) and node.name == "hold_controlling_visible")
hold_code = compile(ast.Module(body=[hold_node], type_ignores=[]), "portal-worker.py", "exec")
minimum_node = next(node for node in source.body if isinstance(node, ast.Assign)
                    and any(isinstance(target, ast.Name)
                            and target.id == "MINIMUM_CONTROLLING_VISIBLE_SECONDS"
                            for target in node.targets))
minimum_seconds = ast.literal_eval(minimum_node.value)
assert minimum_seconds == 0.25
hold_events = []
pending = [True, False]
context = SimpleNamespace(
    pending=lambda: pending.pop(0),
    iteration=lambda may_block: hold_events.append(("iteration", may_block)))
hold_namespace = {
    "GLib": SimpleNamespace(MainContext=SimpleNamespace(default=lambda: context)),
    "time": SimpleNamespace(sleep=lambda seconds: hold_events.append(("sleep", seconds))),
    "MINIMUM_CONTROLLING_VISIBLE_SECONDS": minimum_seconds,
}
exec(hold_code, hold_namespace)
hold_namespace["hold_controlling_visible"]()
assert hold_events == [("iteration", False), ("sleep", 0.25)]

# XWayland may report GDK pass-through while its ShapeInput still covers the
# entire strip. The X server's actual input shape must be empty (or fail closed).
shape_code = compile(ast.Module(body=[node for node in source.body
    if isinstance(node, ast.FunctionDef) and node.name == "enforce_x11_click_through"],
    type_ignores=[]), "portal-worker.py", "exec")


class XCall:
    def __init__(self, action):
        self.action = action

    def __call__(self, *args):
        return self.action(*args)


for injected_rectangles in (0, 1):
    shape_calls = []
    native = SimpleNamespace(set_pass_through=lambda enabled: shape_calls.append(("gdk", enabled)))
    x11 = SimpleNamespace(
        XOpenDisplay=XCall(lambda name: 101 if name == b":0" else 0),
        XCloseDisplay=XCall(lambda value: shape_calls.append(("close", value))),
        XSync=XCall(lambda *args: shape_calls.append(("sync", args[1]))),
        XFree=XCall(lambda *_: shape_calls.append(("free",))),
    )
    def shape_count(display, xid, kind, count, order):
        assert (display, xid, kind) == (101, 73, 2)
        count._obj.value = injected_rectangles
        return None

    xext = SimpleNamespace(
        XShapeQueryExtension=XCall(lambda *args: 1),
        XShapeCombineRectangles=XCall(lambda *args: shape_calls.append(("shape", args))),
        XShapeGetRectangles=XCall(shape_count),
    )
    fake_ctypes = SimpleNamespace(
        CDLL=lambda library: x11 if library == "libX11.so.6" else xext,
        c_void_p=ctypes.c_void_p, c_char_p=ctypes.c_char_p,
        c_int=ctypes.c_int, c_ulong=ctypes.c_ulong,
        POINTER=ctypes.POINTER, byref=ctypes.byref,
    )
    shape_namespace = {
        "ctypes": fake_ctypes, "os": SimpleNamespace(environ={"DISPLAY": ":0"}),
        "GdkX11": SimpleNamespace(X11Window=SimpleNamespace(get_xid=lambda *_: 73)),
    }
    exec(shape_code, shape_namespace)
    try:
        shape_namespace["enforce_x11_click_through"](
            SimpleNamespace(get_window=lambda: native))
        assert injected_rectangles == 0
    except RuntimeError as error:
        assert injected_rectangles == 1 and "not click-through" in str(error)
    assert ("gdk", True) in shape_calls
    assert ("shape", (101, 73, 2, 0, 0, None, 0, 0, 0)) in shape_calls
    assert ("sync", 0) in shape_calls
    assert shape_calls[-1] == ("close", 101)

# A request returns to a persistent, non-focusing session status strip.
# Only an explicit session close (or helper teardown) removes it.
activity_code = compile(ast.Module(body=[node for node in source.body
    if isinstance(node, ast.FunctionDef) and node.name == "activity"], type_ignores=[]),
    "portal-worker.py", "exec")
events = []
class Widget:
    def __init__(self, **kwargs):
        pass
    def __getattr__(self, name):
        return lambda *args: events.append((name, args))
    def connect(self, name, callback):
        callback(SimpleNamespace(get_window=lambda: self))
    def get_display(self):
        return SimpleNamespace(flush=lambda: None)
    def get_screen(self):
        return SimpleNamespace(get_primary_monitor=lambda: 0,
                               get_monitor_geometry=lambda i: SimpleNamespace(x=0, y=0, width=1366, height=768))
    def get_style_context(self):
        return self
namespace = {"activity_window": None, "activity_label": None, "activity_icon": None,
             "activity_card": None,
             "Gtk": SimpleNamespace(Window=Widget, Label=Widget, Image=Widget, Box=Widget, CssProvider=Widget,
                                    StyleContext=SimpleNamespace(add_provider_for_screen=lambda *args: None),
                                    STYLE_PROVIDER_PRIORITY_APPLICATION=600,
                                    Orientation=SimpleNamespace(VERTICAL=1, HORIZONTAL=2),
                                    IconSize=SimpleNamespace(BUTTON=1),
                                    StateFlags=SimpleNamespace(NORMAL=0)),
             "Gdk": SimpleNamespace(WindowTypeHint=SimpleNamespace(NOTIFICATION=1),
                                    RGBA=lambda **values: SimpleNamespace(**values),
                                    Display=SimpleNamespace(open=lambda name: SimpleNamespace(
                                        get_name=lambda: name, get_default_screen=lambda: SimpleNamespace(
                                            get_rgba_visual=lambda: None, get_primary_monitor=lambda: 0,
                                            get_monitor_geometry=lambda i: SimpleNamespace(x=0, y=0, width=1366, height=768))))),
             "Pango": SimpleNamespace(EllipsizeMode=SimpleNamespace(END=3)),
             "enforce_x11_click_through": lambda window: events.append(("shape_input_empty", ())),
             "os": SimpleNamespace(environ={"DISPLAY": ":0"})}
exec(activity_code, namespace)
namespace["activity"]("waiting")
assert ("set_text", ("Waiting to share screen with HostSpan",)) in events
namespace["activity"]("ready")
assert ("set_accept_focus", (False,)) in events
assert ("set_pass_through", (True,)) in events
assert ("set_default_size", (320, 40)) in events
assert ("set_resizable", (False,)) in events
assert ("set_app_paintable", (True,)) in events
assert ("move", (1038, 8)) in events
assert ("set_text", ("HostSpan has screen access",)) in events
namespace["activity"]("viewing")
assert ("set_text", ("HostSpan is viewing this screen",)) in events
namespace["activity"]("controlling")
assert ("set_text", ("HostSpan is controlling this screen",)) in events
assert len([1 for name, _ in events if name == "shape_input_empty"]) == 8
css = [args[0].decode("utf-8") for name, args in events if name == "load_from_data"]
assert len(css) == 1 and "border-radius: 8px" in css[0]
assert "@theme_bg_color" in css[0] and "@theme_fg_color" in css[0]
assert "rgba(23, 33, 47" not in css[0]
assert "hostspan-access-accent" not in css[0]
icons = [args[0] for name, args in events if name == "set_from_icon_name"]
assert icons == ["content-loading-symbolic", "video-display-symbolic",
                 "view-reveal-symbolic", "input-mouse-symbolic"]
assert not any(name == "set_markup" for name, _ in events)
assert not any(name in ("hide", "destroy") for name, _ in events)
namespace["activity"]()
assert ("destroy", ()) in events and namespace["activity_window"] is None
assert namespace["activity_label"] is None and namespace["activity_icon"] is None

# The waiting badge must be visible before portal consent, with the approved
# session badge shown only after actual OS approval. Exception cleanup removes
# either state without spoofing or auto-approving the system dialog.
open_function = next(node for node in source.body
                     if isinstance(node, ast.FunctionDef) and node.name == "open_session")
try_body = next(node for node in open_function.body if isinstance(node, ast.Try))
assert isinstance(try_body.body[0], ast.Expr)
assert isinstance(try_body.body[0].value, ast.Call)
assert isinstance(try_body.body[0].value.func, ast.Name)
assert try_body.body[0].value.func.id == "activity"
assert isinstance(try_body.body[0].value.args[0], ast.Constant)
assert try_body.body[0].value.args[0].value == "waiting"
portal_start = next(node for node in ast.walk(try_body)
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    and node.func.id == "request" and node.args
    and isinstance(node.args[0], ast.Attribute) and node.args[0].attr == "Start")
approved_badge = next(node for node in ast.walk(try_body)
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    and node.func.id == "activity" and node.args
    and isinstance(node.args[0], ast.Constant) and node.args[0].value == "ready")
assert try_body.body[0].lineno < portal_start.lineno < approved_badge.lineno
assert any(isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
           and node.func.id == "close_session" for handler in try_body.handlers
           for node in ast.walk(handler))

# Missing non-focusing display must prevent the badge and reject open.
namespace["os"].environ.clear()
try:
    namespace["activity"]("ready")
    raise AssertionError("missing display was accepted")
except RuntimeError as error:
    assert "X11 display" in str(error)
assert namespace["activity_window"] is None
