const fs = require("node:fs/promises");
const path = require("node:path");

// Never follow symlinks: this hook must affect only the staged application.
// Keep existing owner execute bits; remove unsafe group/other write bits.
async function hardenDirectory(root) {
  const stats = await fs.lstat(root);
  if (stats.isSymbolicLink()) return;
  if (!stats.isFile() && !stats.isDirectory()) {
    throw new Error("Unexpected non-file in Linux package staging: " + root);
  }
  const mode = stats.mode & 0o7777;
  if ((mode & 0o022) !== 0) await fs.chmod(root, mode & ~0o022);
  if (stats.isDirectory()) {
    const entries = await fs.readdir(root);
    for (const name of entries) await hardenDirectory(path.join(root, name));
  }
}

async function afterPack(context) {
  if (context.electronPlatformName !== "linux") return;
  const root = context.appOutDir;
  if (typeof root !== "string" || !root) {
    throw new Error("Missing Linux app output directory");
  }
  const binary = path.join(root, "hostspan-desktop");
  const stats = await fs.lstat(binary);
  if (!stats.isFile()) throw new Error("Linux packaged executable must be a regular file");
  await hardenDirectory(root);
}

module.exports = afterPack;
module.exports.hardenDirectory = hardenDirectory;
