import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

// npm-installed CLI tarballs do not consume pnpm's patchedDependencies.
// Reuse the same single-hunk patch; an already-patched pnpm install is a no-op.
const require = createRequire(import.meta.url);
const target = require.resolve("node-pty/lib/unixTerminal.js");
const patch = readFileSync(new URL("../patches/node-pty@1.2.0-beta.14.patch", import.meta.url), "utf8");
const lines = patch.trimEnd().split("\n");
const hunks = lines.filter((line) => line.startsWith("@@"));
if (hunks.length !== 1) throw new Error("Expected the pinned single-hunk node-pty patch");
const hunk = lines.slice(lines.indexOf(hunks[0]) + 1);
const before = hunk.filter((line) => !line.startsWith("+")).map((line) => line.slice(1)).join("\n");
const after = hunk.filter((line) => !line.startsWith("-")).map((line) => line.slice(1)).join("\n");
const source = readFileSync(target, "utf8");
if (!source.includes(after)) {
  if (source.split(before).length !== 2) throw new Error("Installed node-pty does not match its pinned patch");
  writeFileSync(target, source.replace(before, after));
}
