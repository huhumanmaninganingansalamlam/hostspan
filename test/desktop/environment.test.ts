import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSystemdServiceUnit, serviceExecutionPath, systemdServiceInstalled } from "../../src/services/systemd.js";
import {
  desktopLaunchSpec,
  extractMarkedPath,
  linuxAutoStartContents,
  mergePathValues,
} from "../../src/desktop/environment.js";

describe("desktop environment", () => {
  it("merges PATH values in priority order without duplicates", () => {
    expect(mergePathValues(["/custom/bin", "/usr/bin"].join(delimiter), ["/usr/bin", "/bin"].join(delimiter))).toBe(
      ["/custom/bin", "/usr/bin", "/bin"].join(delimiter),
    );
  });

  it("extracts the final marked login-shell PATH despite shell startup output", () => {
    const first = ["/first/bin", "/usr/bin"].join(delimiter);
    const final = ["/second/bin", "/usr/bin", "/bin"].join(delimiter);
    expect(extractMarkedPath(`banner\n__HOSTSPAN_PATH__=${first}\nnoise\n__HOSTSPAN_PATH__=${final}\n`)).toBe(final);
  });

  it("uses a stable direct Electron binary for Linux development autostart", () => {
    expect(
      desktopLaunchSpec({
        platform: "linux",
        isPackaged: false,
        execPath: "/repo/node_modules/.pnpm/electron@44/node_modules/electron/dist/electron",
        mainPath: "/repo/dist/src/desktop/main.js",
        linuxDevelopmentExecPath: "/repo/node_modules/electron/dist/electron",
      }),
    ).toEqual({
      path: "/repo/node_modules/electron/dist/electron",
      args: ["--no-sandbox", "/repo/dist/src/desktop/main.js"],
    });
  });

  it("uses the stable AppImage path for packaged Linux autostart", () => {
    expect(
      desktopLaunchSpec({
        platform: "linux",
        isPackaged: true,
        execPath: "/tmp/.mount_HostSpan/hostspan-desktop",
        mainPath: "/tmp/.mount_HostSpan/resources/app.asar/dist/src/desktop/main.js",
        appImage: "/home/user/Applications/HostSpan.AppImage",
      }),
    ).toEqual({ path: "/home/user/Applications/HostSpan.AppImage", args: [] });
  });

  it("writes Linux autostart without a shell or PATH-dependent Electron shim", () => {
    const contents = linuxAutoStartContents({
      path: "/opt/Host Span/hostspan-desktop",
      args: ["--no-sandbox", "/opt/Host Span/main.js"],
    });
    expect(contents).toContain('Exec="/opt/Host Span/hostspan-desktop" "--no-sandbox" "/opt/Host Span/main.js"');
    expect(contents).not.toContain("node_modules/.bin/electron");
  });

  it("preserves the inherited PATH while prioritizing the Node runtime directory for the service", () => {
    const runtimeDir = join(process.cwd(), "runtime", "bin");
    const customDir = join(process.cwd(), "custom", "bin");
    const systemDir = join(process.cwd(), "system", "bin");
    const nodePath = join(runtimeDir, "node");
    const inherited = [customDir, runtimeDir, systemDir, customDir].join(delimiter);
    expect(serviceExecutionPath(nodePath, inherited)).toBe([runtimeDir, customDir, systemDir].join(delimiter));
  });

  it("detects an installed Linux systemd service unit without enabling other platforms", () => {
    const root = mkdtempSync(join(tmpdir(), "hostspan-service-unit-"));
    const unit = join(root, "hostspan.service");
    try {
      expect(systemdServiceInstalled(unit, "linux")).toBe(false);
      writeFileSync(unit, "[Unit]\n");
      expect(systemdServiceInstalled(unit, "linux")).toBe(true);
      expect(systemdServiceInstalled(unit, "darwin")).toBe(false);
      expect(systemdServiceInstalled(unit, "win32")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")("preserves PTY workers across systemd daemon restart", () => {
    const runtimeDir = join(process.cwd(), "runtime", "bin");
    const nodePath = join(runtimeDir, "node");
    const inherited = ["/custom/bin", runtimeDir, "/usr/bin"].join(delimiter);
    const unit = buildSystemdServiceUnit("/tmp/hostspan config.yaml", "/tmp/hostspan cli.js", nodePath, inherited);
    expect(unit).toContain("\nKillMode=process\n");
    expect(unit).not.toMatch(/^PrivateTmp=/m);
    expect(unit).not.toMatch(/^NoNewPrivileges=/m);
    expect(unit).toContain(`Environment="PATH=${[runtimeDir, "/custom/bin", "/usr/bin"].join(delimiter)}"`);
  });
});
