import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { hardenDirectory } = require("../../scripts/harden-linux-package.cjs") as {
  hardenDirectory: (directory: string) => Promise<void>;
};

const { installedTreeHardening, injectAfterInstallHardening } = require("../../scripts/linux-after-install.cjs") as {
  installedTreeHardening: (appDirectory: string, ownerUid: number) => string;
  injectAfterInstallHardening: (template: string) => string;
};

describe.skipIf(process.platform === "win32")("Linux desktop package mode hardening", () => {
  it("removes group/other writes without removing execute permission or following symlinks", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "hostspan-package-modes-"));
    try {
      const app = join(scratch, "linux-unpacked");
      mkdirSync(app);
      const binary = join(app, "hostspan-desktop");
      writeFileSync(binary, "binary");
      chmodSync(binary, 0o777);
      const resources = join(app, "resources");
      mkdirSync(resources);
      chmodSync(resources, 0o777);
      const asar = join(resources, "app.asar");
      writeFileSync(asar, "archive");
      chmodSync(asar, 0o664);
      const outside = join(scratch, "outside");
      writeFileSync(outside, "not in the app");
      chmodSync(outside, 0o666);
      const link = join(resources, "external");
      symlinkSync(outside, link);

      await hardenDirectory(app);

      expect(lstatSync(binary).mode & 0o777).toBe(0o755);
      expect(lstatSync(resources).mode & 0o777).toBe(0o755);
      expect(lstatSync(asar).mode & 0o777).toBe(0o644);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(lstatSync(outside).mode & 0o777).toBe(0o666);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("repairs old installation directory modes without following symlinks", () => {
    const scratch = mkdtempSync(join(tmpdir(), "hostspan-installed-modes-"));
    try {
      const app = join(scratch, "HostSpan");
      mkdirSync(app);
      const resources = join(app, "resources");
      mkdirSync(resources);
      const executable = join(app, "hostspan-desktop");
      writeFileSync(executable, "binary");
      chmodSync(executable, 0o777);
      chmodSync(resources, 0o775);
      chmodSync(app, 0o775);
      const outside = join(scratch, "outside");
      writeFileSync(outside, "user data");
      chmodSync(outside, 0o666);
      symlinkSync(outside, join(resources, "outside-link"));

      const script = installedTreeHardening(app, process.getuid?.() ?? 0);
      const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(lstatSync(app).mode & 0o777).toBe(0o755);
      expect(lstatSync(resources).mode & 0o777).toBe(0o755);
      expect(lstatSync(executable).mode & 0o777).toBe(0o755);
      expect(lstatSync(outside).mode & 0o777).toBe(0o666);

      const appLink = join(scratch, "redirected-app");
      symlinkSync(app, appLink);
      const refused = spawnSync("bash", ["-c", installedTreeHardening(appLink, process.getuid?.() ?? 0)], { encoding: "utf8" });
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("symlink");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("retains electron-builder sandbox and AppArmor setup", () => {
    const original = "#!/bin/bash\nupdate-alternatives\nchrome-sandbox\napparmor_parser\n";
    const result = injectAfterInstallHardening(original);
    expect(result).toContain("HostSpan install/upgrade hardening");
    expect(result).toContain("-perm /022");
    expect(result).toContain(original.slice("#!/bin/bash\n".length));
    expect(() => injectAfterInstallHardening("#!/bin/bash\nchrome-sandbox\n")).toThrow();
  });
});
