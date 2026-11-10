"""Exercise consent and keyboard dispatch without a desktop/DBus session."""
import ast
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
                     "dispatch": dispatch, "PortalRequestError": RuntimeError,
                     "json": __import__("json"), "print": lambda *args, **kwargs: None}
        # The fake ordinary failure carries no structured portal details.
        namespace["PortalRequestError"] = type("PortalFailure", (Exception,), {})
        exec(reply_code, namespace)
        namespace["reply"]({"id": "status-test", "action": action, "text": "private input"})
        expected = ["dispatch"] if action in ("open", "close") else [
            "viewing" if action == "observe" else "controlling", "dispatch", "ready"]
        assert events == expected, (action, fails, events)

# A request returns to a persistent, non-focusing session-open badge.
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
namespace = {"activity_window": None, "activity_label": None, "activity_marker": None,
             "Gtk": SimpleNamespace(Window=Widget, Label=Widget, Box=Widget,
                                    Orientation=SimpleNamespace(VERTICAL=1, HORIZONTAL=2),
                                    StateFlags=SimpleNamespace(NORMAL=0)),
             "Gdk": SimpleNamespace(WindowTypeHint=SimpleNamespace(NOTIFICATION=1),
                                    RGBA=lambda **values: SimpleNamespace(**values),
                                    Display=SimpleNamespace(open=lambda name: SimpleNamespace(
                                        get_name=lambda: name, get_default_screen=lambda: "x11-screen"))),
             "os": SimpleNamespace(environ={"DISPLAY": ":0"})}
exec(activity_code, namespace)
namespace["activity"]("ready")
assert ("set_accept_focus", (False,)) in events
assert ("set_pass_through", (True,)) in events
assert ("set_screen", ("x11-screen",)) in events
assert ("set_default_size", (360, 58)) in events
assert ("set_markup", ('<span foreground="#FFFFFF">Screen access is on</span>',)) in events
namespace["activity"]("viewing")
assert ("set_markup", ('<span foreground="#FFFFFF">Viewing this screen</span>',)) in events
namespace["activity"]("controlling")
assert ("set_markup", ('<span foreground="#FFFFFF">Controlling this screen</span>',)) in events
backgrounds = [args[1] for name, args in events if name == "override_background_color"]
assert len(backgrounds) == 3
assert len({(value.red, value.green, value.blue) for value in backgrounds}) == 3
markers = [args[0] for name, args in events if name == "set_markup" and "●" in args[0]]
assert markers == ['<span foreground="#AAB4C3">●</span>',
                   '<span foreground="#8EC5FF">●</span>',
                   '<span foreground="#FFC08A">●</span>']
assert not any(name in ("hide", "destroy") for name, _ in events)
namespace["activity"]()
assert ("destroy", ()) in events and namespace["activity_window"] is None

# The real open path must show the session badge after portal consent,
# with the existing exception cleanup guaranteeing fail-closed behavior.
open_function = next(node for node in source.body
                     if isinstance(node, ast.FunctionDef) and node.name == "open_session")
try_body = next(node for node in open_function.body if isinstance(node, ast.Try))
assert any(isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
           and node.func.id == "activity" and node.args
           and isinstance(node.args[0], ast.Constant) and node.args[0].value == "ready"
           for node in ast.walk(try_body))
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
