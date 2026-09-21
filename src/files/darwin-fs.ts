import { closeSync } from "node:fs";
import { createRequire } from "node:module";

interface DarwinFsApi {
  openat(dirfd: number, path: string, flags: number, mode: number): number;
  renameat(oldDirFd: number, oldPath: string, newDirFd: number, newPath: string): number;
  unlinkat(dirfd: number, path: string, flags: number): number;
  dup(fd: number): number;
  fdopendir(fd: number): unknown;
  readdir(dirp: unknown): unknown;
  closedir(dirp: unknown): number;
}

interface KoffiModule {
  load(path: string): { func(signature: string): unknown };
  errno(value?: number): number;
  decode(pointer: unknown, offset: number, type: string, length?: number): unknown;
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
    dup: libc.func("int dup(int fd)") as DarwinFsApi["dup"],
    fdopendir: libc.func("void * fdopendir(int fd)") as DarwinFsApi["fdopendir"],
    readdir: libc.func("void * readdir(void *dirp)") as DarwinFsApi["readdir"],
    closedir: libc.func("int closedir(void *dirp)") as DarwinFsApi["closedir"],
  };
  return cached;
}

function nativeError(operation: string, path: string): Error {
  return new Error(`${operation} failed for ${path} (errno=${nativeKoffi().errno()})`);
}

export function darwinDirentLayout(arch: NodeJS.Architecture): {
  recordLengthOffset: number;
  nameLengthOffset: number;
  nameLengthType: "uint8_t" | "uint16_t";
  nameOffset: number;
  maxNameLength: number;
  maxRecordLength: number;
} {
  if (arch === "arm64") {
    return {
      recordLengthOffset: 16,
      nameLengthOffset: 18,
      nameLengthType: "uint16_t",
      nameOffset: 21,
      maxNameLength: 1023,
      maxRecordLength: 1048,
    };
  }
  return {
    recordLengthOffset: 4,
    nameLengthOffset: 7,
    nameLengthType: "uint8_t",
    nameOffset: 8,
    maxNameLength: 255,
    maxRecordLength: 264,
  };
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

export function darwinReadDirectoryNames(fd: number): string[] {
  const native = api();
  const duplicate = native.dup(fd);
  if (duplicate < 0) throw nativeError("dup", String(fd));
  const stream = native.fdopendir(duplicate);
  if (!stream) {
    closeSync(duplicate);
    throw nativeError("fdopendir", String(fd));
  }
  const koffi = nativeKoffi();
  const names: string[] = [];
  try {
    for (;;) {
      koffi.errno(0);
      const entry = native.readdir(stream);
      if (!entry) {
        const errno = koffi.errno();
        if (errno !== 0) throw new Error(`readdir failed for fd ${fd} (errno=${errno})`);
        break;
      }
      // Darwin exposes two readdir ABIs to 64-bit processes. Intel keeps the
      // historical symbol layout for binary compatibility, while native
      // Apple Silicon's readdir uses the 64-bit inode layout from dirent.h.
      // Decode only reclen/namlen/name, selecting offsets from the process ABI.
      const {
        recordLengthOffset,
        nameLengthOffset,
        nameLengthType,
        nameOffset,
        maxNameLength,
        maxRecordLength,
      } = darwinDirentLayout(process.arch);
      const recordLength = Number(koffi.decode(entry, recordLengthOffset, "uint16_t"));
      const nameLength = Number(koffi.decode(entry, nameLengthOffset, nameLengthType));
      if (
        recordLength < nameOffset + 1 ||
        recordLength > maxRecordLength ||
        nameLength < 1 ||
        nameLength > maxNameLength ||
        nameOffset + nameLength > recordLength
      ) {
        throw new Error(
          `readdir returned an invalid Darwin dirent for ${process.arch} (reclen=${recordLength}, namlen=${nameLength})`,
        );
      }
      const decoded = koffi.decode(entry, nameOffset, "char", nameLength);
      if (typeof decoded !== "string") throw new Error("readdir returned a non-string Darwin filename");
      if (decoded !== "." && decoded !== "..") names.push(decoded);
    }
    return names;
  } finally {
    native.closedir(stream);
  }
}
