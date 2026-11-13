import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HostSpanLogger } from "../../src/observability/logger.js";

describe("bounded operational logs", () => {
  it("does not keep rotated archives when none are allowed", () => {
    const root = mkdtempSync(join(tmpdir(), "hostspan-logging-noarchives-"));
    try {
      const logger = new HostSpanLogger(root, { maxFileBytes: 200, maxArchives: 0 });
      for (let i = 0; i < 40; i++) logger.info("runtime.event", { index: i });
      for (let i = 0; i < 40; i++) logger.auditEvent("request.accepted", { index: i });
      const names = readdirSync(join(root, "logs")).sort();
      expect(names).toEqual(["audit.jsonl", "hostspan.jsonl"]);
      for (const name of names) expect(statSync(join(root, "logs", name)).size).toBeLessThanOrEqual(200);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("trims oversized existing log files and prunes obsolete archives at startup", () => {
    const root = mkdtempSync(join(tmpdir(), "hostspan-logging-upgrade-"));
    try {
      const logDir = join(root, "logs");
      mkdirSync(logDir);
      const original = [...Array.from({ length: 40 }, (_, i) => JSON.stringify({ event: "test", i })), ""].join("\n");
      writeFileSync(join(logDir, "hostspan.jsonl"), original);
      writeFileSync(join(logDir, "hostspan.jsonl.1"), original);
      writeFileSync(join(logDir, "hostspan.jsonl.2"), original);
      const logger = new HostSpanLogger(root, { maxFileBytes: 128, maxArchives: 1 });
      logger.info("after.upgrade");
      expect(readdirSync(logDir)).not.toContain("hostspan.jsonl.2");
      for (const name of ["hostspan.jsonl", "hostspan.jsonl.1"]) {
        expect(statSync(join(logDir, name)).size).toBeLessThanOrEqual(128);
        for (const line of readFileSync(join(logDir, name), "utf8").trim().split("\n")) {
          expect(() => JSON.parse(line)).not.toThrow();
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds ordinary and audit logs including one oversized record", () => {
    const root = mkdtempSync(join(tmpdir(), "hostspan-logging-"));
    try {
      const logger = new HostSpanLogger(root, { maxFileBytes: 512, maxArchives: 2 });
      for (let i = 0; i < 100; i++) {
        logger.info("runtime.event", { index: i, detail: "ok" });
        logger.auditEvent("request.accepted", { index: i, tool: "system_status" });
      }
      logger.info("huge.record", { content: "sensitive".repeat(500) });
      const logDir = join(root, "logs");
      const files = readdirSync(logDir);
      expect(files).toHaveLength(6);
      for (const file of files) {
        expect(statSync(join(logDir, file)).size).toBeLessThanOrEqual(512);
        for (const line of readFileSync(join(logDir, file), "utf8").trim().split("\n")) {
          expect(() => JSON.parse(line)).not.toThrow();
        }
      }
      const recent = readFileSync(join(logDir, "hostspan.jsonl"), "utf8");
      expect(recent).toContain("log.entry_oversized");
      expect(recent).not.toContain("sensitive");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
