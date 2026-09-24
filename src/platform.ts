export function isQualifiedCorePlatform(): boolean {
  return (
    ((process.platform === "linux" || process.platform === "win32") && process.arch === "x64") ||
    (process.platform === "darwin" && (process.arch === "x64" || process.arch === "arm64"))
  );
}
