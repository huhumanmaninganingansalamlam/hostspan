import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_CAPABILITIES,
  defaultWorkspaceCapability,
} from "../../src/desktop/workspace-capabilities.js";

describe("desktop workspace capability defaults", () => {
  it("defaults new workspaces to read-only authority", () => {
    expect(DEFAULT_WORKSPACE_CAPABILITIES).toEqual(["read"]);
    expect(defaultWorkspaceCapability("read")).toBe(true);
    expect(defaultWorkspaceCapability("write")).toBe(false);
    expect(defaultWorkspaceCapability("exec")).toBe(false);
    expect(defaultWorkspaceCapability("terminal")).toBe(false);
  });
});
