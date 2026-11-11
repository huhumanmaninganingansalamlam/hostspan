import Foundation

// No permission request, capture, input or original worker/session is used by this fixture.
@main
struct DesktopAvailabilityTest {
    @MainActor
    static func main() throws {
        DesktopWorker.opened = true
        let ready = DesktopWorker.activityAppearance(.ready)
        let viewing = DesktopWorker.activityAppearance(.viewing)
        let controlling = DesktopWorker.activityAppearance(.controlling)
        precondition(ready.message == "Screen access is on")
        precondition(viewing.message == "Viewing this screen")
        precondition(controlling.message == "Controlling this screen")
        precondition(DesktopWorker.minimumControllingVisibilityNanoseconds == 250_000_000)
        let backgrounds = [ready.background, viewing.background, controlling.background]
            .map { "\($0.0),\($0.1),\($0.2)" }
        let markers = [ready.marker, viewing.marker, controlling.marker]
            .map { "\($0.0),\($0.1),\($0.2)" }
        precondition(Set(backgrounds).count == 3)
        precondition(Set(markers).count == 3)
        let sessions: [[String: Any]?] = [nil, [:], ["CGSSessionScreenIsLocked": false]]
        for session in sessions {
            try DesktopWorker.requireUnlockedDesktop(session)
            precondition(DesktopWorker.opened)
        }
        do {
            try DesktopWorker.requireUnlockedDesktop(["CGSSessionScreenIsLocked": true])
            fatalError("Locked desktop was accepted")
        } catch {
            let details = (error as NSError).userInfo["error_details"] as? [String: Any]
            precondition(details?["reason"] as? String == "macos_desktop_locked")
            precondition(details?["dispatched"] as? Bool == false)
            precondition(DesktopWorker.opened, "Desktop lock must preserve the session")
            precondition(DesktopWorker.activityPanel == nil)
            precondition(DesktopWorker.activityMarker == nil)
        }
        try DesktopWorker.requireUnlockedDesktop(["CGSSessionScreenIsLocked": false])
        precondition(DesktopWorker.opened)
        print("PASS: locked rejection, same-session recovery, no capture/input/consent")
    }
}
