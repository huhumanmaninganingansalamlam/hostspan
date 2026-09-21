import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { serviceExecutionPath, systemdServiceInstalled } from "../../src/cli/service.js";
import { extractMarkedPath, mergePathValues } from "../../src/desktop/environment.js";

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
});
