const fs = require("node:fs/promises");
const { createRequire } = require("node:module");
const path = require("node:path");

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

// dpkg can keep directory modes from an older installation during upgrades.
// This is intentionally separate from afterPack, which only sees build staging.
function installedTreeHardening(appDirectory = "/opt/" + "$" + "{sanitizedProductName}", ownerUid = 0) {
  return [
    "# HostSpan install/upgrade hardening: normalize pre-existing package directories.",
    "umask 022",
    "hostspan_install_root=" + shellQuote(appDirectory),
    'if [ -L "$hostspan_install_root" ] || [ ! -d "$hostspan_install_root" ]; then',
    '  echo "HostSpan package directory is missing or a symlink" >&2',
    "  exit 1",
    "fi",
    'if [ "$(stat -c %u -- "$hostspan_install_root")" != ' + shellQuote(ownerUid) + " ]; then",
    '  echo "HostSpan package directory has an unexpected owner" >&2',
    "  exit 1",
    "fi",
    "# No symlink traversal, no crossing mount points; keep existing execute/setuid bits.",
    'find -P "$hostspan_install_root" -xdev \\( -type f -o -type d \\) -perm /022 -exec chmod go-w -- {} + || {',
    '  echo "Could not harden installed HostSpan package permissions" >&2',
    "  exit 1",
    "}",
    'if find -P "$hostspan_install_root" -xdev \\( -type f -o -type d \\) -perm /022 -print -quit | grep -q .; then',
    '  echo "Unsafe writable HostSpan package entry remains after installation" >&2',
    "  exit 1",
    "fi",
  ].join("\n") + "\n";
}

function injectAfterInstallHardening(template) {
  const shebang = "#!/bin/bash\n";
  if (!template.startsWith(shebang) ||
      !template.includes("update-alternatives") ||
      !template.includes("chrome-sandbox") ||
      !template.includes("apparmor_parser")) {
    throw new Error("Unexpected electron-builder Linux post-install template; refusing to drop sandbox/AppArmor setup.");
  }
  return shebang + "\n" + installedTreeHardening() + "\n" + template.slice(shebang.length);
}

async function prepareLinuxAfterInstall(root) {
  // Resolve the actual pnpm package path, not the node_modules symlink.
  const cli = await fs.realpath(path.resolve(root, "node_modules", "electron-builder", "cli.js"));
  const builderRequire = createRequire(cli);
  const builderPackage = builderRequire.resolve("app-builder-lib/package.json");
  const builtinTemplatePath = path.resolve(path.dirname(builderPackage), "templates", "linux", "after-install.tpl");
  const builtinTemplate = await fs.readFile(builtinTemplatePath, "utf8");
  const output = path.resolve(root, "out", "linux-after-install.tpl");
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, injectAfterInstallHardening(builtinTemplate), { mode: 0o644 });
  await fs.chmod(output, 0o644);
}

module.exports = { installedTreeHardening, injectAfterInstallHardening, prepareLinuxAfterInstall };
