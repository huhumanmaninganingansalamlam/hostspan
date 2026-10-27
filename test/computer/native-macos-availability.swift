import Foundation

// No permission request, capture, input or original worker/session is used by this fixture.
@main
struct DesktopAvailabilityTest {
    @MainActor
    static func main() throws {
        DesktopWorker.opened = true
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
        }
        try DesktopWorker.requireUnlockedDesktop(["CGSSessionScreenIsLocked": false])
        precondition(DesktopWorker.opened)
        print("PASS: locked rejection, same-session recovery, no capture/input/consent")
    }
}
