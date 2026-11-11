import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { hardenDirectory } = require("../../scripts/harden-linux-package.cjs") as {
  hardenDirectory: (directory: string) => Promise<void>;
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
});
