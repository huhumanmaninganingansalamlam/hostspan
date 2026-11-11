import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// electron-builder creates package metadata after afterPack and copies the
// AppImage desktop icon from build resources. Secure both sources of modes.
if (process.platform !== "win32") process.umask(0o022);
if (process.platform === "linux") {
  const require = createRequire(import.meta.url);
  const { hardenDirectory } = require("./harden-linux-package.cjs");
  await hardenDirectory(resolve(root, "assets", "icons"));
}
const cli = resolve(root, "node_modules", "electron-builder", "cli.js");
const child = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});
if (child.error) throw child.error;
if (child.signal) {
  process.kill(process.pid, child.signal);
} else {
  process.exitCode = child.status ?? 1;
}
