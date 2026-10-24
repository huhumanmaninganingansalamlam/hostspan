"""Exercise the worker's real request function without a desktop/DBus session."""
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
