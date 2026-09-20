import koffi from "koffi";

interface DarwinFsApi {
  openat(dirfd: number, path: string, flags: number, mode: number): number;
  renameat(oldDirFd: number, oldPath: string, newDirFd: number, newPath: string): number;
  unlinkat(dirfd: number, path: string, flags: number): number;
}

let cached: DarwinFsApi | undefined;

function api(): DarwinFsApi {
  if (process.platform !== "darwin") throw new Error("Darwin descriptor-relative filesystem API requested on a non-Darwin host.");
  if (cached) return cached;
  const libc = koffi.load("/usr/lib/libSystem.B.dylib");
  cached = {
    openat: libc.func("int openat(int dirfd, const char *path, int oflag, int mode)"),
    renameat: libc.func("int renameat(int olddirfd, const char *oldpath, int newdirfd, const char *newpath)"),
    unlinkat: libc.func("int unlinkat(int dirfd, const char *path, int flags)"),
  };
  return cached;
}

function nativeError(operation: string, path: string): Error {
  return new Error(`${operation} failed for ${path} (errno=${koffi.errno()})`);
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
  if (koffi.errno() === 2) return;
  throw nativeError("unlinkat", path);
}
