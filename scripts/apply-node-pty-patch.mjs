import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

// npm-installed CLI tarballs do not consume pnpm's patchedDependencies.
// Reuse the same pinned patch; an already-patched pnpm install is a no-op.
const require = createRequire(import.meta.url);
const target = require.resolve("node-pty/lib/unixTerminal.js");
const patch = readFileSync(new URL("../patches/node-pty@1.2.0-beta.14.patch", import.meta.url), "utf8");
const lines = patch.trimEnd().split(/\r?\n/);
const hunks = [];
for (const line of lines.slice(lines.findIndex((line) => line.startsWith("@@")))) {
  if (line.startsWith("@@")) hunks.push([]);
  else if (/^[ +\-]/.test(line)) hunks.at(-1).push(line);
}
if (hunks.length === 0) throw new Error("Expected the pinned node-pty patch");
let source = readFileSync(target, "utf8").replace(/\r\n/g, "\n");
const original = source;
for (const hunk of hunks) {
  const before = hunk.filter((line) => !line.startsWith("+")).map((line) => line.slice(1)).join("\n");
  const after = hunk.filter((line) => !line.startsWith("-")).map((line) => line.slice(1)).join("\n");
  if (source.includes(after)) continue;
  if (source.split(before).length !== 2) throw new Error("Installed node-pty does not match its pinned patch");
  source = source.replace(before, after);
}
if (source !== original) {
  // Replace this installation's file without modifying pnpm's shared hard links.
  const temporary = `${target}.hostspan-patch-${process.pid}`;
  writeFileSync(temporary, source, { flag: "wx" });
  renameSync(temporary, target);
}
