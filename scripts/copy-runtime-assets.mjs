import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
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
