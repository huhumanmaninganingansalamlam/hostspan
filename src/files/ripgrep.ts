import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function unpackedElectronPath(path: string): string {
  if (!path.includes("app.asar")) return path;
  const unpacked = path.replace("app.asar", "app.asar.unpacked");
  return existsSync(unpacked) ? unpacked : path;
}

export function bundledRipgrepPath(): string | undefined {
  const binary = process.platform === "win32" ? "rg.exe" : "rg";
  const packageName = `@vscode/ripgrep-${process.platform}-${process.arch}`;
  try {
    return unpackedElectronPath(require.resolve(`${packageName}/bin/${binary}`));
  } catch {
    return undefined;
  }
}

export function ripgrepExecutable(): string {
  return bundledRipgrepPath() ?? "rg";
}
