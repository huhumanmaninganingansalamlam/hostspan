import { describe, expect, it, vi } from "vitest";
import {
  DASHBOARD_CSP,
  installDashboardNavigationGuards,
  isTrustedDashboardIpc,
  requireAttachInput,
  requireBoolean,
  requireDaemonAction,
  requireString,
  requireWorkspaceInput,
} from "../../src/desktop/ipc-security.js";

describe("desktop IPC security", () => {
  it("accepts only exact daemon actions", () => {
    expect(requireDaemonAction("start")).toBe("start");
    expect(requireDaemonAction("stop")).toBe("stop");
    expect(requireDaemonAction("restart")).toBe("restart");
    expect(() => requireDaemonAction("reload")).toThrow("invalid daemon action");
    expect(() => requireDaemonAction("stop ")).toThrow("invalid daemon action");
    expect(() => requireDaemonAction(1)).toThrow("invalid daemon action");
  });

  it("does not coerce privileged boolean and string inputs", () => {
    expect(requireBoolean(false, "autostart")).toBe(false);
    expect(() => requireBoolean("false", "autostart")).toThrow("invalid autostart");
    expect(requireString("proc_123", "process_id", 32)).toBe("proc_123");
    expect(() => requireString("", "process_id", 32)).toThrow("invalid process_id");
    expect(() => requireString("x".repeat(33), "process_id", 32)).toThrow("invalid process_id");
  });

  it("validates terminal attach and workspace payloads at runtime", () => {
    expect(requireAttachInput({ processId: "proc_123", readOnly: true })).toEqual({
      processId: "proc_123",
      readOnly: true,
    });
    expect(() => requireAttachInput({ processId: "proc_123", readOnly: "false" })).toThrow("invalid read_only");

    expect(
      requireWorkspaceInput({
        root: "/tmp/project",
        capabilities: ["read", "write", "exec"],
        target_id: "project",
      }),
    ).toMatchObject({
      root: "/tmp/project",
      capabilities: ["read", "write", "exec"],
      target_id: "project",
    });
    expect(() => requireWorkspaceInput({ root: "/tmp/project", capabilities: ["read", "shell"] })).toThrow(
      "invalid workspace capability",
    );
    expect(() => requireWorkspaceInput(null)).toThrow("invalid workspace input");
  });



  it("locks the dashboard to its local document and blocks renderer-created windows", () => {
    let openHandler: (() => { action: "deny" }) | undefined;
    let navigationHandler: ((event: { preventDefault(): void }) => void) | undefined;
    const contents = {
      setWindowOpenHandler(handler: () => { action: "deny" }) {
        openHandler = handler;
      },
      on(event: "will-frame-navigate", listener: (event: { preventDefault(): void }) => void) {
        expect(event).toBe("will-frame-navigate");
        navigationHandler = listener;
      },
    };

    installDashboardNavigationGuards(contents);
    expect(openHandler?.()).toEqual({ action: "deny" });
    const navigation = { preventDefault: vi.fn() };
    navigationHandler?.(navigation);
    expect(navigation.preventDefault).toHaveBeenCalledOnce();

    expect(DASHBOARD_CSP).toContain("default-src 'none'");
    expect(DASHBOARD_CSP).toContain("connect-src 'none'");
    expect(DASHBOARD_CSP).toContain("frame-src 'none'");
    expect(DASHBOARD_CSP).toContain("form-action 'none'");
  });

  it("trusts only the dashboard webContents main frame", () => {
    const contents = { mainFrame: {} };
    const trusted = { sender: contents, senderFrame: contents.mainFrame };
    expect(isTrustedDashboardIpc(trusted, contents)).toBe(true);
    expect(isTrustedDashboardIpc({ sender: {}, senderFrame: contents.mainFrame }, contents)).toBe(false);
    expect(isTrustedDashboardIpc({ sender: contents, senderFrame: {} }, contents)).toBe(false);
  });
});
