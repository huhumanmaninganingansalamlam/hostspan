import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_CAPABILITIES,
  defaultWorkspaceCapability,
} from "../../src/desktop/workspace-capabilities.js";

describe("desktop workspace capability defaults", () => {
  it("keeps interactive terminal authority opt-in", () => {
    expect(DEFAULT_WORKSPACE_CAPABILITIES).toEqual(["read", "write", "exec", "git"]);
    expect(defaultWorkspaceCapability("read")).toBe(true);
    expect(defaultWorkspaceCapability("write")).toBe(true);
    expect(defaultWorkspaceCapability("exec")).toBe(true);
    expect(defaultWorkspaceCapability("git")).toBe(true);
    expect(defaultWorkspaceCapability("terminal")).toBe(false);
  });
});
