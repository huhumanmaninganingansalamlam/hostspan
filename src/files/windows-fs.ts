import { createRequire } from "node:module";

interface WindowsFsApi {
  createFile(
    path: string,
    desiredAccess: number,
    shareMode: number,
    securityAttributes: null,
    creationDisposition: number,
    flagsAndAttributes: number,
    templateFile: null,
  ): unknown;
  closeHandle(handle: unknown): boolean;
  getFileType(handle: unknown): number;
  getLastError(): number;
}

interface KoffiModule {
  load(path: string): { func(signature: string): unknown };
}

const require = createRequire(import.meta.url);
let cached: WindowsFsApi | undefined;

function api(): WindowsFsApi {
  if (process.platform !== "win32") throw new Error("Windows filesystem API requested on a non-Windows host.");
  if (cached) return cached;
  const koffi = require("koffi") as KoffiModule;
  const kernel32 = koffi.load("kernel32.dll");
  cached = {
    createFile: kernel32.func(
      "void * CreateFileW(str16 path, uint32 desired_access, uint32 share_mode, void *security_attributes, uint32 creation_disposition, uint32 flags_and_attributes, void *template_file)",
    ) as WindowsFsApi["createFile"],
    closeHandle: kernel32.func("bool CloseHandle(void *handle)") as WindowsFsApi["closeHandle"],
    getFileType: kernel32.func("uint32 GetFileType(void *handle)") as WindowsFsApi["getFileType"],
    getLastError: kernel32.func("uint32 GetLastError()") as WindowsFsApi["getLastError"],
  };
  return cached;
}

const FILE_LIST_DIRECTORY = 0x00000001;
const FILE_SHARE_READ = 0x00000001;
const FILE_SHARE_WRITE = 0x00000002;
const OPEN_EXISTING = 3;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const FILE_TYPE_UNKNOWN = 0;

export interface WindowsDirectoryGuard {
  handle: unknown;
}

export function openWindowsDirectoryGuard(path: string): WindowsDirectoryGuard {
  const native = api();
  const handle = native.createFile(
    path,
    FILE_LIST_DIRECTORY,
    FILE_SHARE_READ | FILE_SHARE_WRITE,
    null,
    OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
    null,
  );
  const fileType = native.getFileType(handle);
  if (fileType === FILE_TYPE_UNKNOWN) {
    const code = native.getLastError();
    if (code !== 0) {
      native.closeHandle(handle);
      throw new Error(`CreateFileW directory guard failed for ${path} (win32=${code})`);
    }
  }
  return { handle };
}

export function closeWindowsDirectoryGuard(guard: WindowsDirectoryGuard | undefined): void {
  if (!guard) return;
  api().closeHandle(guard.handle);
}
