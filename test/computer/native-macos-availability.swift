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

        // Inject permission states: no OS prompt, capture, input, or TCC mutation.
        try DesktopWorker.requireSessionPermissions(screenRecordingGranted: true, accessibilityGranted: true)
        for permissions in [(false, true), (true, false), (false, false)] {
            DesktopWorker.opened = true
            do {
                try DesktopWorker.requireSessionPermissions(
                    screenRecordingGranted: permissions.0, accessibilityGranted: permissions.1)
                fatalError("Revoked permission left the session open")
            } catch {
                let details = (error as NSError).userInfo["error_details"] as? [String: Any]
                precondition(details?["reason"] as? String == "macos_permission_revoked")
                precondition(!DesktopWorker.opened, "Revocation must close the session")
                precondition(DesktopWorker.activityPanel == nil, "Revocation must remove its indicator")
            }
        }
        // The background access monitor is tested with injected state only:
        // never change real TCC grants or lock the user's console.
        DesktopWorker.opened = true
        precondition(DesktopWorker.monitorAccess(
            screenRecordingGranted: true, accessibilityGranted: true, sessionLocked: true))
        precondition(DesktopWorker.opened, "Lock must preserve the session")
        precondition(DesktopWorker.activityPanel == nil, "Locked console must hide the badge")
        precondition(!DesktopWorker.monitorAccess(
            screenRecordingGranted: false, accessibilityGranted: true, sessionLocked: false))
        precondition(!DesktopWorker.opened, "Permission revocation must end idle access")
        precondition(DesktopWorker.activityPanel == nil, "Idle revocation must remove the badge")
        precondition(DesktopWorker.accessMonitor == nil, "Revocation must stop background polling")

        print("PASS: locked rejection/recovery, idle permission revocation fail-close, no capture/input/consent")
    }
}
