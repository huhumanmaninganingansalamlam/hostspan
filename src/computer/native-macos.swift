import AppKit
import ApplicationServices
import ImageIO
import ScreenCaptureKit

// Private JSON-lines helper, launched by the logged-in HostSpan desktop runtime.
#if !HOSTSPAN_DESKTOP_AVAILABILITY_TEST
@main
#endif
struct DesktopWorker {
    static var opened = false
    static var displayID = CGMainDisplayID()
    static var capture: DisplayCapture?
    @MainActor static var activityPanel: NSPanel?
    @MainActor static var activityLabel: NSTextField?
    @MainActor static var activityTimer: Timer?

    @MainActor
    static func activity(_ active: Bool?) {
        activityTimer?.invalidate()
        activityTimer = nil
        guard let active else {
            activityPanel?.orderOut(nil)
            activityPanel = nil
            activityLabel = nil
            return
        }
        if activityPanel == nil {
            let screen = NSScreen.screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == displayID }
            let area = screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? .zero
            let panel = NSPanel(contentRect: NSRect(x: area.maxX - 310, y: area.maxY - 48, width: 298, height: 36),
                                styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.title = "HostSpan computer use"
            panel.level = .statusBar
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            panel.ignoresMouseEvents = true
            panel.hidesOnDeactivate = false
            panel.backgroundColor = NSColor(calibratedRed: 0.10, green: 0.27, blue: 0.59, alpha: 0.95)
            let label = NSTextField(labelWithString: "")
            label.frame = NSRect(x: 0, y: 9, width: 298, height: 18)
            label.alignment = .center
            label.textColor = .white
            panel.contentView?.addSubview(label)
            activityPanel = panel
            activityLabel = label
        }
        activityLabel?.stringValue = active ? "● HostSpan · Using this computer" : "HostSpan · Activity finished"
        activityPanel?.orderFrontRegardless()
        activityPanel?.displayIfNeeded()
        if !active {
            activityTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: false) { _ in
                MainActor.assumeIsolated { activityPanel?.orderOut(nil); activityTimer = nil }
            }
        }
    }

    final class DisplayCapture: @unchecked Sendable {
        let completed = DispatchGroup()
        let process = Process()
        let directory: URL
        let startedAt = Date()
        var image: CGImage?
        var png: Data?
        var completedAt = Date()
        var error: Error?

        init(displayID: CGDirectDisplayID) throws {
            directory = FileManager.default.temporaryDirectory.appendingPathComponent("hostspan-capture-\(UUID())", isDirectory: true)
            let directory = self.directory
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
                                                   attributes: [.posixPermissions: 0o700])
            let file = directory.appendingPathComponent("frame.png")
            let bounds = CGDisplayBounds(displayID)
            process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            process.arguments = ["-x", "-T", "0", "-R", "\(Int(bounds.minX)),\(Int(bounds.minY)),\(Int(bounds.width)),\(Int(bounds.height))", "-t", "png", file.path]
            process.standardOutput = FileHandle.nullDevice
            completed.enter()
            process.terminationHandler = { process in
                defer {
                    process.terminationHandler = nil
                    try? FileManager.default.removeItem(at: directory)
                }
                if process.terminationStatus == 0,
                   let data = try? Data(contentsOf: file),
                   let source = CGImageSourceCreateWithData(data as CFData, nil) {
                    self.png = data
                    self.image = CGImageSourceCreateImageAtIndex(source, 0, nil)
                } else {
                    self.error = NSError(domain: "HostSpanDesktop", code: Int(process.terminationStatus),
                                         userInfo: [NSLocalizedDescriptionKey: "macOS screencapture failed (exit \(process.terminationStatus))"])
                }
                self.completedAt = Date()
                self.completed.leave()
                Task { @MainActor in
                    if capture?.process === process { activity(false) }
                }
            }
            do { try process.run() }
            catch {
                process.terminationHandler = nil
                try? FileManager.default.removeItem(at: directory)
                throw error
            }
        }

        func cancel() {
            if process.isRunning { process.terminate(); process.waitUntilExit() }
            try? FileManager.default.removeItem(at: directory)
        }

        func ready(until deadline: DispatchTime) async -> Bool {
            await withCheckedContinuation { reply in
                DispatchQueue.global(qos: .userInitiated).async {
                    reply.resume(returning: self.completed.wait(timeout: deadline) == .success)
                }
            }
        }
    }

    static func capturePending() -> NSError {
        NSError(domain: "HostSpanDesktop", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "Display capture is still processing. Observe this same session again; do not open another session or resend input.",
            "error_details": ["reason": "native_capture_pending", "capture_phase": "screen_capture", "retry_after_ms": 1000]
        ])
    }

    static func send(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value),
              let line = String(data: data, encoding: .utf8) else { return }
        print(line)
        fflush(stdout)
    }

    static func failure(_ message: String) -> NSError {
        NSError(domain: "HostSpanDesktop", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }

    @MainActor
    static func requireUnlockedDesktop(_ session: [String: Any]? = CGSessionCopyCurrentDictionary() as? [String: Any]) throws {
        if session?["CGSSessionScreenIsLocked"] as? Bool == true {
            // Discard a capture retained after an earlier bounded observe; never return it after unlock.
            capture?.cancel()
            capture = nil
            activity(nil)
            throw NSError(domain: "HostSpanDesktop", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Desktop capture and input are unavailable while the macOS console is locked. Keep this session and observe again when the desktop is available.",
                "error_details": ["reason": "macos_desktop_locked", "dispatched": false]
            ])
        }
    }

    static func requireGUILaunch(for permission: String) throws {
        let environment = ProcessInfo.processInfo.environment
        if environment["SSH_CONNECTION"] != nil || environment["SSH_TTY"] != nil {
            throw NSError(domain: "HostSpanDesktop", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "macOS permission cannot be requested from this SSH-launched runtime. Start HostSpan from its macOS app, then open computer again.",
                "error_details": ["reason": "macos_gui_launch_required", "permission": permission]
            ])
        }
    }

    static func geometry() -> [String: Any] {
        let bounds = CGDisplayBounds(displayID)
        return ["backend": "macos-native", "display_id": String(displayID),
                "coordinate_width": Int(bounds.width), "coordinate_height": Int(bounds.height),
                "text_supported": true]
    }

    static func postKey(_ code: CGKeyCode, flags: CGEventFlags = []) throws {
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else {
            throw failure("Could not create a keyboard event")
        }
        down.flags = flags
        up.flags = flags
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }

    @MainActor
    static func dispatch(_ command: [String: Any]) async throws -> [String: Any] {
        // Stay inside the parent's unchanged 10s request budget, including encoding/IPC.
        let responseDeadline = DispatchTime.now() + 8
        let action = command["action"] as? String ?? ""
        if action == "close" { opened = false; capture?.cancel(); capture = nil; activity(nil); return ["closed": true] }
        if action == "open" {
            guard #available(macOS 14.0, *) else {
                throw failure("Native screen capture requires macOS 14 or newer")
            }
            if !CGPreflightScreenCaptureAccess() {
                try requireGUILaunch(for: "screen_recording")
                send(["event": "permission_required", "permission": "screen_recording"])
                _ = CGRequestScreenCaptureAccess()
                NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
                while !CGPreflightScreenCaptureAccess() { try await Task.sleep(nanoseconds: 500_000_000) }
            }
            if !AXIsProcessTrusted() {
                try requireGUILaunch(for: "accessibility")
                send(["event": "permission_required", "permission": "accessibility"])
                let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
                _ = AXIsProcessTrustedWithOptions(options)
                NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
                while !AXIsProcessTrusted() { try await Task.sleep(nanoseconds: 500_000_000) }
            }
            displayID = CGMainDisplayID()
            opened = true
            return geometry()
        }
        guard opened else { throw failure("Desktop session is closed") }
        try requireUnlockedDesktop()
        activity(true)
        defer { if capture?.process.isRunning != true && activityPanel != nil { activity(false) } }
        if action == "observe" {
            guard #available(macOS 14.0, *) else { throw failure("Native capture is unavailable") }
            guard CGPreflightScreenCaptureAccess() else { throw failure("Screen Recording permission was revoked") }
            let image: CGImage
            var capturedPNG: Data?
            var startedAt = Date()
            var completedAt: Date?
            if #unavailable(macOS 15.0) {
                // Sonoma virtual displays can stall hardware readback or crash display streams.
                // The system rectangle capture includes system UI, unlike window composition.
                if capture == nil { capture = try DisplayCapture(displayID: displayID) }
                guard let pending = capture else { throw failure("Could not start display capture") }
                let ready = await pending.ready(until: responseDeadline)
                try requireUnlockedDesktop()
                guard ready else {
                    throw capturePending()
                }
                capture = nil
                if let error = pending.error { throw error }
                guard let captured = pending.image else {
                    throw failure("Could not capture the selected display")
                }
                image = captured
                capturedPNG = pending.png
                startedAt = pending.startedAt
                completedAt = pending.completedAt
            } else {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
                guard let display = content.displays.first(where: { $0.displayID == displayID }) else {
                    throw failure("Selected display disconnected; open the desktop again")
                }
                let configuration = SCStreamConfiguration()
                configuration.width = display.width
                configuration.height = display.height
                configuration.showsCursor = true
                let filter = SCContentFilter(display: display, excludingWindows: [])
                image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
            }
            // The console may have locked while capture was awaiting its result.
            try requireUnlockedDesktop()
            guard let png = capturedPNG ?? NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
                throw failure("Could not encode captured PNG")
            }
            guard png.count <= 16 * 1024 * 1024 else { throw failure("Captured PNG exceeds 16 MiB") }
            let timestamp = ISO8601DateFormatter()
            timestamp.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return geometry().merging(["image": png.base64EncodedString(), "mime_type": "image/png",
                                       "capture_started_at": timestamp.string(from: startedAt),
                                       "capture_completed_at": timestamp.string(from: completedAt ?? Date()),
                                       "width": image.width, "height": image.height]) { _, new in new }
        }
        guard capture == nil else { throw capturePending() }
        guard AXIsProcessTrusted() else { throw failure("Accessibility permission was revoked; input was not sent") }
        switch action {
        case "move", "click":
            guard let x = command["x"] as? Double, let y = command["y"] as? Double else { throw failure("Missing coordinates") }
            let bounds = CGDisplayBounds(displayID)
            guard x.isFinite, y.isFinite, x >= 0, y >= 0, x < bounds.width, y < bounds.height else {
                throw failure("Pointer coordinates are outside the selected screen")
            }
            let point = CGPoint(x: bounds.minX + x, y: bounds.minY + y)
            guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else {
                throw failure("Could not create a pointer event")
            }
            move.post(tap: .cghidEventTap)
            if action == "click" {
                let button = command["button"] as? String ?? "left"
                let types: (CGMouseButton, CGEventType, CGEventType)
                switch button {
                case "left": types = (.left, .leftMouseDown, .leftMouseUp)
                case "right": types = (.right, .rightMouseDown, .rightMouseUp)
                case "middle": types = (.center, .otherMouseDown, .otherMouseUp)
                default: throw failure("Unsupported mouse button")
                }
                guard let down = CGEvent(mouseEventSource: nil, mouseType: types.1, mouseCursorPosition: point, mouseButton: types.0),
                      let up = CGEvent(mouseEventSource: nil, mouseType: types.2, mouseCursorPosition: point, mouseButton: types.0) else {
                    throw failure("Could not create a pointer event")
                }
                down.post(tap: .cghidEventTap)
                up.post(tap: .cghidEventTap)
            }
        case "key":
            let keys: [String: CGKeyCode] = ["Enter": 36, "Tab": 48, "Escape": 53, "Backspace": 51, "Delete": 117,
                "Left": 123, "Up": 126, "Right": 124, "Down": 125, "Home": 115, "End": 119,
                "KeyA": 0, "KeyB": 11, "KeyC": 8, "KeyD": 2, "KeyE": 14, "KeyF": 3, "KeyG": 5,
                "KeyH": 4, "KeyI": 34, "KeyJ": 38, "KeyK": 40, "KeyL": 37, "KeyM": 46, "KeyN": 45,
                "KeyO": 31, "KeyP": 35, "KeyQ": 12, "KeyR": 15, "KeyS": 1, "KeyT": 17, "KeyU": 32,
                "KeyV": 9, "KeyW": 13, "KeyX": 7, "KeyY": 16, "KeyZ": 6]
            guard let name = command["key"] as? String, let code = keys[name] else { throw failure("Unsupported key") }
            let modifiers = command["modifiers"] as? [String] ?? []
            guard (command["modifiers"] == nil || command["modifiers"] is [String]),
                  modifiers.isEmpty || modifiers == ["Shift"] else { throw failure("Unsupported modifiers") }
            if modifiers == ["Shift"] {
                guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 56, keyDown: true),
                      let up = CGEvent(keyboardEventSource: nil, virtualKey: 56, keyDown: false) else {
                    throw failure("Could not create Shift events")
                }
                down.flags = .maskShift
                up.flags = []
                down.post(tap: .cghidEventTap)
                defer { up.post(tap: .cghidEventTap) }
                try postKey(code, flags: .maskShift)
            } else { try postKey(code) }
        case "text":
            guard let text = command["text"] as? String, text.count <= 4096 else { throw failure("Text exceeds 4096 characters") }
            NSPasteboard.general.clearContents()
            guard NSPasteboard.general.setString(text, forType: .string) else { throw failure("Clipboard write failed; input was not sent") }
            try postKey(9, flags: .maskCommand)
        case "scroll":
            guard let dx = command["dx"] as? Double, let dy = command["dy"] as? Double,
                  dx.isFinite, dy.isFinite, abs(dx) <= 10000, abs(dy) <= 10000,
                  let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
                                      wheel1: Int32(-dy), wheel2: Int32(-dx), wheel3: 0) else {
                throw failure("Invalid scroll event")
            }
            event.post(tap: .cghidEventTap)
        default: throw failure("Unsupported desktop action")
        }
        return ["dispatched": true]
    }

    @MainActor
    static func receive(_ line: String) async -> Bool {
        guard line.utf8.count <= 65536,
                  let data = line.data(using: .utf8),
                  let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let id = command["id"] as? String else { return false }
        do { send(["id": id, "result": try await dispatch(command)]) }
        catch {
            var reply: [String: Any] = ["id": id, "error": error.localizedDescription]
            if let details = (error as NSError).userInfo["error_details"] { reply["error_details"] = details }
            send(reply)
        }
        return true
    }

    @MainActor
    static func main() {
        // AppKit stays responsive while the private input pipe waits for commands.
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        Task.detached {
            while let line = readLine() {
                if !(await receive(line)) { break }
            }
            await shutdown()
        }
        application.run()
    }

    @MainActor
    static func shutdown() {
        capture?.cancel()
        activity(nil)
        NSApplication.shared.terminate(nil)
    }
}
