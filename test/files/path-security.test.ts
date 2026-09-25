import { closeSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import type { HostSpanConfig } from "../../src/config/schema.js";
import { HostSpanError } from "../../src/errors.js";
import { resolveTargetPath } from "../../src/targets/path.js";
import {
  closeOpenedDirectory,
  openDirectoryNoFollow,
  openReadNoFollow,
} from "../../src/files/path-guard.js";
import { TargetRegistry } from "../../src/targets/registry.js";

const cleanup: string[] = [];

function targetFor(root: string) {
  const config: HostSpanConfig = {
    schema_version: 1,
    policy_epoch: 1,
    server: { listen_host: "127.0.0.1", listen_port: 39393, data_dir: join(root, ".state") },
    retention: {
      completed_process_output_ttl_minutes: 60,
      operation_result_days: 14,
      audit_days: 30,
      max_total_spool_bytes: 1024 * 1024,
    },
    targets: {
      test: {
        label: "test",
        provider: "local",
        root,
        capabilities: ["read", "write", "exec"],
        exec_profile: "native",
        deny_globs: [],
        ignore_globs: [],
      },
    },
    exec_profiles: {
      native: {
        mode: "native",
        max_concurrent_processes: 2,
      },
    },
  };
  return new TargetRegistry(config).get("test");
}

function tempRoot() {
  const base = mkdtempSync(join(tmpdir(), "hostspan-path-"));
  cleanup.push(base);
  const root = join(base, "root");
  mkdirSync(root);
  return { base, root };
}

afterEach(() => {
  while (cleanup.length) {
    const path = cleanup.pop();
    if (path) rmSync(path, { recursive: true, force: true });
  }
});

describe("canonical target path guard", () => {
  it("rejects traversal, absolute paths, Windows absolute paths, and NUL", () => {
    const { root } = tempRoot();
    const target = targetFor(root);
    for (const path of ["../secret", "/etc/passwd", "C:\\Windows\\system.ini", "\\\\server\\share", "a\0b"]) {
      expect(() => resolveTargetPath(target, path)).toThrowError(HostSpanError);
    }
  });

  it.runIf(process.platform === "win32")("rejects Windows device aliases, ADS, drive-relative syntax, and normalization aliases", () => {
    const { root } = tempRoot();
    const target = targetFor(root);
    for (const path of ["file.txt:secret", "C:drive-relative", "NUL", "con.txt", "COM1.log", "name. ", "bad|name.txt"]) {
      expect(() => resolveTargetPath(target, path), path).toThrowError(
        expect.objectContaining({ code: "PATH_OUTSIDE_TARGET" }),
      );
    }
  });

  it.runIf(process.platform === "win32")("rejects Windows directory junctions as reparse-point escapes", () => {
    const { base, root } = tempRoot();
    const outside = join(base, "junction-outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(root, "junction-link"), "junction");
    const target = targetFor(root);
    expect(() => resolveTargetPath(target, "junction-link/secret.txt")).toThrowError(/Symlink/);
  });

  it.runIf(process.platform === "win32")("pins an authorized parent directory against rename while a guarded operation is active", () => {
    const { root } = tempRoot();
    const parent = join(root, "parent");
    mkdirSync(parent);
    const target = targetFor(root);
    const opened = openDirectoryNoFollow(target, "parent");
    try {
      expect(() => renameSync(parent, join(root, "moved"))).toThrow();
    } finally {
      closeOpenedDirectory(opened);
    }
    expect(() => renameSync(parent, join(root, "moved"))).not.toThrow();
  });

  it("rejects symlink files, symlink directories, and nonexistent children below a symlink", () => {
    const { base, root } = tempRoot();
    const outside = join(base, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(join(outside, "secret.txt"), join(root, "secret-link"));
    symlinkSync(outside, join(root, "dir-link"));
    const target = targetFor(root);
    expect(() => resolveTargetPath(target, "secret-link")).toThrowError(/Symlink/);
    expect(() => resolveTargetPath(target, "dir-link/secret.txt")).toThrowError(/Symlink/);
    expect(() => resolveTargetPath(target, "dir-link/new-file.txt")).toThrowError(/Symlink/);
  });

  it("rechecks the path before returning an opened descriptor", () => {
    const { root } = tempRoot();
    writeFileSync(join(root, "ok.txt"), "ok");
    const target = targetFor(root);
    const opened = openReadNoFollow(target, "ok.txt");
    expect(opened.path.relative).toBe("ok.txt");
    // Descriptor ownership is intentionally exercised by fileRead; close here to keep the corpus leak-free.
    closeSync(opened.fd);
  });

  it("rejects a parent-directory symlink swap between authorization and file open", () => {
    const { base, root } = tempRoot();
    const outside = join(base, "outside-race");
    const inside = join(root, "inside");
    mkdirSync(outside);
    mkdirSync(inside);
    writeFileSync(join(inside, "value.txt"), "inside");
    writeFileSync(join(outside, "value.txt"), "outside");
    const target = targetFor(root);
    if (process.platform === "win32") {
      let renameBlocked = false;
      const opened = openReadNoFollow(target, "inside/value.txt", () => {
        try {
          renameSync(inside, join(root, "inside-original"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EBUSY") {
            renameBlocked = true;
            return;
          }
          throw error;
        }
        symlinkSync(outside, inside);
      });
      try {
        expect(renameBlocked).toBe(true);
      } finally {
        closeSync(opened.fd);
      }
      return;
    }
    expect(() =>
      openReadNoFollow(target, "inside/value.txt", () => {
        renameSync(inside, join(root, "inside-original"));
        symlinkSync(outside, inside);
      }),
    ).toThrowError(expect.objectContaining({ code: "SYMLINK_REJECTED" }));
  });

  it("rejects a target root that was replaced after registry creation", () => {
    const { root } = tempRoot();
    writeFileSync(join(root, "value.txt"), "inside");
    const target = targetFor(root);
    renameSync(root, `${root}-original`);
    mkdirSync(root);
    writeFileSync(join(root, "value.txt"), "replacement");
    expect(() => resolveTargetPath(target, "value.txt")).toThrowError(
      expect.objectContaining({ code: "TARGET_NOT_READY" }),
    );
  });

  it("holds the traversal invariant over generated suffixes", () => {
    const { root } = tempRoot();
    const target = targetFor(root);
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-z]{1,8}$/), { minLength: 0, maxLength: 8 }), (parts) => {
        const path = ["..", ...parts].join("/");
        expect(() => resolveTargetPath(target, path)).toThrow(HostSpanError);
      }),
      { numRuns: 250 },
    );
  });
});
