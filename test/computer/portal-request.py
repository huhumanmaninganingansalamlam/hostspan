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
        expected = ["dispatch"] if action in ("open", "close") else [True, "dispatch", False]
        assert events == expected, (action, fails, events)

# A new request cancels the previous hide timer; close removes the badge immediately.
activity_code = compile(ast.Module(body=[node for node in source.body
    if isinstance(node, ast.FunctionDef) and node.name == "activity"], type_ignores=[]),
    "portal-worker.py", "exec")
events, timers = [], {}
class Widget:
    def __init__(self, **kwargs):
        pass
    def __getattr__(self, name):
        return lambda *args: events.append((name, args))
    def connect(self, name, callback):
        callback(SimpleNamespace(get_window=lambda: self))
    def get_display(self):
        return SimpleNamespace(flush=lambda: None)
def timeout(milliseconds, callback):
    assert milliseconds == 1000
    timers[1] = callback
    return 1
namespace = {"activity_window": None, "activity_label": None, "activity_timer": None,
             "Gtk": SimpleNamespace(Window=Widget, Label=Widget),
             "Gdk": SimpleNamespace(WindowTypeHint=SimpleNamespace(NOTIFICATION=1),
                                    Display=SimpleNamespace(open=lambda name: SimpleNamespace(
                                        get_name=lambda: name, get_default_screen=lambda: "x11-screen"))),
             "os": SimpleNamespace(environ={"DISPLAY": ":0"}),
             "GLib": SimpleNamespace(timeout_add=timeout, source_remove=lambda key: timers.pop(key))}
exec(activity_code, namespace)
namespace["activity"](True)
assert ("set_accept_focus", (False,)) in events
assert ("set_pass_through", (True,)) in events
assert ("set_screen", ("x11-screen",)) in events
namespace["activity"](False)
assert timers
namespace["activity"](True)
assert not timers
namespace["activity"](False)
timers.pop(1)()
assert ("hide", ()) in events and namespace["activity_timer"] is None
namespace["activity"]()
assert ("destroy", ()) in events and namespace["activity_window"] is None

# Missing non-focusing display must stop before a badge or input is created.
namespace["os"].environ.clear()
try:
    namespace["activity"](True)
    raise AssertionError("missing display was accepted")
except RuntimeError as error:
    assert "X11 display" in str(error)
assert namespace["activity_window"] is None
