import type { AddWorkspaceInput } from "../admin/snapshot.js";
import { CapabilitySchema, type Capability } from "../config/schema.js";

const CAPABILITIES = new Set<Capability>(CapabilitySchema.options);

export const DASHBOARD_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";

export type DaemonAction = "start" | "stop" | "restart";

export interface DashboardIpcEventLike {
  sender: unknown;
  senderFrame: unknown;
}

export interface DashboardWebContentsLike {
  mainFrame: unknown;
}

export interface PreventableNavigationEventLike {
  preventDefault(): void;
}

export interface DashboardNavigationContentsLike {
  setWindowOpenHandler(handler: () => { action: "deny" }): void;
  on(event: "will-frame-navigate", listener: (event: PreventableNavigationEventLike) => void): unknown;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid ${label}`);
  return value as Record<string, unknown>;
}

export function requireDaemonAction(value: unknown): DaemonAction {
  if (value === "start" || value === "stop" || value === "restart") return value;
  throw new Error("invalid daemon action");
}

export function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`invalid ${label}`);
  return value;
}

export function requireString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) throw new Error(`invalid ${label}`);
  return value;
}

export function requireAttachInput(value: unknown): { processId: string; readOnly: boolean } {
  const input = record(value, "terminal attach input");
  return {
    processId: requireString(input.processId, "process_id", 256),
    readOnly: requireBoolean(input.readOnly, "read_only"),
  };
}

export function requireWorkspaceInput(value: unknown): AddWorkspaceInput {
  const input = record(value, "workspace input");
  if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) throw new Error("invalid workspace capabilities");
  const capabilities = input.capabilities.map((capability) => {
    if (typeof capability !== "string" || !CAPABILITIES.has(capability as Capability)) {
      throw new Error("invalid workspace capability");
    }
    return capability as Capability;
  });
  const result: AddWorkspaceInput = {
    root: requireString(input.root, "workspace root", 32_768),
    capabilities,
  };
  if (input.target_id !== undefined) result.target_id = requireString(input.target_id, "target_id", 64);
  if (input.label !== undefined) result.label = requireString(input.label, "workspace label", 512);
  if (input.exec_profile !== undefined) result.exec_profile = requireString(input.exec_profile, "exec profile", 256);
  return result;
}

export function isTrustedDashboardIpc(event: DashboardIpcEventLike, contents: DashboardWebContentsLike): boolean {
  return event.sender === contents && event.senderFrame === contents.mainFrame;
}

export function installDashboardNavigationGuards(contents: DashboardNavigationContentsLike): void {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-frame-navigate", (event) => event.preventDefault());
}
