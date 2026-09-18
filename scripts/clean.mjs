import { rm } from "node:fs/promises";

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("Usage: node scripts/clean.mjs <path> [...path]");
  process.exitCode = 2;
} else {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
}
