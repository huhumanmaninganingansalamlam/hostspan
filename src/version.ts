import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const SERVER_VERSION = "0.13.2";
export const PROTOCOL_VERSION = "2026-07-28";
export const TOOLSET_VERSION = "hostspan-v3.5";

export type BuildVariant = "release" | "candidate" | "development";

export interface BuildIdentity {
  schema_version: 1;
  build_id: string | null;
  commit: string | null;
  tree: string | null;
  object_format: "sha1" | "sha256" | null;
  variant: BuildVariant;
  dirty: boolean | null;
}

const UNKNOWN_BUILD_IDENTITY: BuildIdentity = Object.freeze({
  schema_version: 1,
  build_id: null,
  commit: null,
  tree: null,
  object_format: null,
  variant: "development",
  dirty: null,
});

/** Load the build's immutable receipt; installed runtimes never execute Git. */
export function loadBuildIdentity(path: URL | string = new URL("./build-identity.json", import.meta.url)): BuildIdentity {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return UNKNOWN_BUILD_IDENTITY;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return UNKNOWN_BUILD_IDENTITY;
  const data = value as Record<string, unknown>;
  const { commit, tree, object_format: objectFormat, variant, dirty } = data;
  if (data.schema_version !== 1 || !["release", "candidate", "development"].includes(String(variant))) {
    return UNKNOWN_BUILD_IDENTITY;
  }
  const known = (objectFormat === "sha1" || objectFormat === "sha256") &&
    typeof commit === "string" && typeof tree === "string" &&
    new RegExp(`^[0-9a-f]{${objectFormat === "sha1" ? 40 : 64}}$`).test(commit) &&
    new RegExp(`^[0-9a-f]{${objectFormat === "sha1" ? 40 : 64}}$`).test(tree) &&
    typeof dirty === "boolean";
  if (!known && !(variant === "development" && commit === null && tree === null &&
    objectFormat === null && dirty === null && data.build_id === null)) return UNKNOWN_BUILD_IDENTITY;
  if (variant === "release" && (!known || dirty !== false)) return UNKNOWN_BUILD_IDENTITY;
  const buildId = known
    ? `sha256:${createHash("sha256").update(JSON.stringify([1, variant, commit, tree, objectFormat, dirty])).digest("hex")}`
    : null;
  if (data.build_id !== buildId) return UNKNOWN_BUILD_IDENTITY;
  return { schema_version: 1, build_id: buildId, commit: known ? commit as string : null,
    tree: known ? tree as string : null, object_format: known ? objectFormat as "sha1" | "sha256" : null,
    variant: variant as BuildVariant, dirty: known ? dirty as boolean : null };
}

export const BUILD_IDENTITY = loadBuildIdentity();
