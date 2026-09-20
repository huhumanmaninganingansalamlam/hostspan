import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function ptySocketPath(dataDir: string, session: string): string {
  const digest = createHash("sha256").update(`${dataDir}\0${session}`).digest("hex").slice(0, 32);
  if (process.platform === "win32") return `\\\\.\\pipe\\hostspan-pty-${digest}`;
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const root = join("/tmp", `hostspan-pty-${uid}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  if (!statSync(root).isDirectory()) throw new Error(`PTY IPC root is not a directory: ${root}`);
  return join(root, `${digest}.sock`);
}
