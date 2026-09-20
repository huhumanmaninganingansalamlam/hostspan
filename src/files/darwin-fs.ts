import { createRequire } from "node:module";

interface DarwinFsApi {
  openat(dirfd: number, path: string, flags: number, mode: number): number;
  renameat(oldDirFd: number, oldPath: string, newDirFd: number, newPath: string): number;
  unlinkat(dirfd: number, path: string, flags: number): number;
}

interface KoffiModule {
  load(path: string): { func(signature: string): unknown };
  errno(): number;
}

let cached: DarwinFsApi | undefined;
let cachedKoffi: KoffiModule | undefined;
const require = createRequire(import.meta.url);

function nativeKoffi(): KoffiModule {
  if (process.platform !== "darwin") throw new Error("Darwin Koffi binding requested on a non-Darwin host.");
  cachedKoffi ??= require("koffi") as KoffiModule;
  return cachedKoffi;
}

function api(): DarwinFsApi {
  if (process.platform !== "darwin") throw new Error("Darwin descriptor-relative filesystem API requested on a non-Darwin host.");
  if (cached) return cached;
  const libc = nativeKoffi().load("/usr/lib/libSystem.B.dylib");
  cached = {
    openat: libc.func("int openat(int dirfd, const char *path, int oflag, int mode)") as DarwinFsApi["openat"],
    renameat: libc.func("int renameat(int olddirfd, const char *oldpath, int newdirfd, const char *newpath)") as DarwinFsApi["renameat"],
    unlinkat: libc.func("int unlinkat(int dirfd, const char *path, int flags)") as DarwinFsApi["unlinkat"],
  };
  return cached;
}

function nativeError(operation: string, path: string): Error {
  return new Error(`${operation} failed for ${path} (errno=${nativeKoffi().errno()})`);
}

export function darwinOpenAt(dirfd: number, path: string, flags: number, mode = 0): number {
  const fd = api().openat(dirfd, path, flags, mode);
  if (fd < 0) throw nativeError("openat", path);
  return fd;
}

export function darwinRenameAt(dirfd: number, from: string, to: string): void {
  if (api().renameat(dirfd, from, dirfd, to) !== 0) throw nativeError("renameat", `${from} -> ${to}`);
}

export function darwinUnlinkAtIfExists(dirfd: number, path: string): void {
  if (api().unlinkat(dirfd, path, 0) === 0) return;
  if (nativeKoffi().errno() === 2) return;
  throw nativeError("unlinkat", path);
}
