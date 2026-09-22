import type { Capability } from "../config/schema.js";

export const DEFAULT_WORKSPACE_CAPABILITIES: readonly Capability[] = ["read", "write", "exec", "git"];

export function defaultWorkspaceCapability(capability: Capability): boolean {
  return DEFAULT_WORKSPACE_CAPABILITIES.includes(capability);
}
