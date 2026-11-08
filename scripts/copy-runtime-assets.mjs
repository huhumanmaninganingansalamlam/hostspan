import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const destination = new URL("../dist/src/computer/", import.meta.url);
await mkdir(destination, { recursive: true });
await copyFile(new URL("../src/computer/portal-worker.py", import.meta.url), new URL("portal-worker.py", destination));
await copyFile(new URL("../src/computer/native-windows.ps1", import.meta.url), new URL("native-windows.ps1", destination));
if (process.platform === "darwin") {
  const temporary = await mkdtemp(join(tmpdir(), "hostspan-native-macos-"));
  try {
    const binaries = [];
    for (const arch of ["arm64", "x86_64"]) {
      const binary = join(temporary, arch);
      execFileSync("xcrun", ["swiftc", "-parse-as-library", "-O", "-target", `${arch}-apple-macosx14.0`,
        fileURLToPath(new URL("../src/computer/native-macos.swift", import.meta.url)), "-o", binary], { stdio: "inherit" });
      binaries.push(binary);
    }
    execFileSync("xcrun", ["lipo", "-create", ...binaries, "-output", fileURLToPath(new URL("native-macos", destination))], { stdio: "inherit" });
  } finally { await rm(temporary, { recursive: true, force: true }); }
} else if (process.env.HOSTSPAN_NATIVE_MACOS_HELPER) {
  await copyFile(process.env.HOSTSPAN_NATIVE_MACOS_HELPER, new URL("native-macos", destination));
  await chmod(new URL("native-macos", destination), 0o755);
}

// One artifact receipt is generated at build time and included in both the CLI
// tarball and Electron ASAR. Neither installed runtime needs Git or a checkout.
const repository = fileURLToPath(new URL("../", import.meta.url));
const git = (args) => {
  try {
    return execFileSync("git", ["-C", repository, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000,
    }).trim();
  } catch {
    return null;
  }
};
const variant = process.env.HOSTSPAN_BUILD_VARIANT ?? (process.env.GITHUB_ACTIONS === "true" ? "candidate" : "development");
if (!["release", "candidate", "development"].includes(variant)) {
  throw new Error(`Unsupported HOSTSPAN_BUILD_VARIANT: ${variant}`);
}
const commit = git(["rev-parse", "--verify", "HEAD"]);
const tree = git(["rev-parse", "--verify", "HEAD^{tree}"]);
const objectFormat = git(["rev-parse", "--show-object-format"]);
const porcelain = git(["status", "--porcelain=v1", "--untracked-files=normal"]);
const dirty = porcelain === null ? null : porcelain.length > 0;
const length = objectFormat === "sha1" ? 40 : objectFormat === "sha256" ? 64 : 0;
const validGit = length > 0 && commit !== null && tree !== null &&
  new RegExp(`^[0-9a-f]{${length}}$`).test(commit) && new RegExp(`^[0-9a-f]{${length}}$`).test(tree) &&
  dirty !== null;
if (variant !== "development" && !validGit) {
  throw new Error(`${variant} builds require a complete Git commit/tree/working-tree identity`);
}
if (variant === "release" && dirty !== false) {
  throw new Error("release builds require a clean Git working tree");
}
const known = validGit;
const receipt = {
  schema_version: 1,
  build_id: known ? `sha256:${createHash("sha256").update(JSON.stringify([1, variant, commit, tree, objectFormat, dirty])).digest("hex")}` : null,
  commit: known ? commit : null,
  tree: known ? tree : null,
  object_format: known ? objectFormat : null,
  variant,
  dirty: known ? dirty : null,
};
await writeFile(new URL("../dist/src/build-identity.json", import.meta.url), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`[build-identity] ${receipt.variant} ${receipt.commit ?? "unknown"} dirty=${receipt.dirty ?? "unknown"}`);
