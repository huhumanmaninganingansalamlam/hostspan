import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SYSTEM_SID = "S-1-5-18";
const DACL_SECURITY_INFORMATION = 0x00000004;
let cachedCurrentSid: string | undefined;
let cachedNativeApi: WindowsAclNativeApi | undefined;
const require = createRequire(import.meta.url);

interface WindowsAclNativeApi {
  convertSecurityDescriptor(source: string, revision: number, output: unknown[], size: number[]): boolean;
  setFileSecurity(path: string, securityInformation: number, descriptor: unknown): boolean;
  localFree(memory: unknown): unknown;
  getLastError(): number;
}

interface KoffiModule {
  load(path: string): { func(signature: string): unknown };
}

function requireWindows(): void {
  if (process.platform !== "win32") throw new Error("Windows ACL operation requested on a non-Windows host.");
}

function nativeApi(): WindowsAclNativeApi {
  requireWindows();
  if (cachedNativeApi) return cachedNativeApi;
  const koffi = require("koffi") as KoffiModule;
  const advapi32 = koffi.load("advapi32.dll");
  const kernel32 = koffi.load("kernel32.dll");
  cachedNativeApi = {
    convertSecurityDescriptor: advapi32.func(
      "bool __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16,uint32,_Out_ void **,uint32 *)",
    ) as WindowsAclNativeApi["convertSecurityDescriptor"],
    setFileSecurity: advapi32.func(
      "bool __stdcall SetFileSecurityW(str16,uint32,void *)",
    ) as WindowsAclNativeApi["setFileSecurity"],
    localFree: kernel32.func("void * __stdcall LocalFree(void *)") as WindowsAclNativeApi["localFree"],
    getLastError: kernel32.func("uint32 __stdcall GetLastError()") as WindowsAclNativeApi["getLastError"],
  };
  return cachedNativeApi;
}

export function currentWindowsSid(): string {
  requireWindows();
  if (cachedCurrentSid) return cachedCurrentSid;
  const result = spawnSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  });
  const match = /S-\d-(?:\d+-)+\d+/i.exec(result.stdout ?? "");
  if (result.status !== 0 || !match) {
    throw new Error(
      "Could not determine current Windows SID: " +
        (result.stderr?.trim() || result.stdout?.trim() || result.error?.message || "unknown error"),
    );
  }
  cachedCurrentSid = match[0];
  return cachedCurrentSid;
}

function restrict(path: string, directory: boolean): void {
  requireWindows();
  const sid = currentWindowsSid();
  const inheritance = directory ? "OICI" : "";
  const sddl = `D:P(A;${inheritance};FA;;;${sid})(A;${inheritance};FA;;;SY)`;
  const api = nativeApi();
  const descriptor: unknown[] = [null];
  const descriptorSize = [0];
  if (!api.convertSecurityDescriptor(sddl, 1, descriptor, descriptorSize) || !descriptor[0]) {
    throw new Error(`Could not create private Windows security descriptor for ${path} (win32=${api.getLastError()})`);
  }
  try {
    if (!api.setFileSecurity(path, DACL_SECURITY_INFORMATION, descriptor[0])) {
      throw new Error(`Could not restrict Windows ACL for ${path} (win32=${api.getLastError()})`);
    }
  } finally {
    api.localFree(descriptor[0]);
  }
}

export function protectWindowsFile(path: string): void {
  if (process.platform !== "win32" || !existsSync(path)) return;
  restrict(path, false);
}

export function protectWindowsDirectory(path: string): void {
  if (process.platform !== "win32") return;
  mkdirSync(path, { recursive: true });
  restrict(path, true);
}

export function protectWindowsTree(path: string): void {
  if (process.platform !== "win32") return;
  protectWindowsDirectory(path);
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      try {
        const stat = lstatSync(child);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          restrict(child, true);
          visit(child);
        } else {
          restrict(child, false);
        }
      } catch (error) {
        // Session workers use atomic temp-file replacement for status data.
        // A directory entry can disappear between readdir/lstat/ACL update;
        // only that proven disappearance is benign. Existing paths still fail
        // closed when their DACL cannot be restricted.
        if (!existsSync(child)) continue;
        throw error;
      }
    }
  };
  visit(path);
}

export interface WindowsAclInspection {
  private: boolean;
  unexpected_allow_sids: string[];
  missing_full_control_sids: string[];
  deny_sids: string[];
  inherited_rule_count: number;
  rule_count: number;
}

function currentTrusteeMatches(trustee: string, currentSid: string): boolean {
  const normalized = trustee.toUpperCase();
  if (normalized === currentSid) return true;
  return currentSid.endsWith("-500") && normalized === "LA";
}

function systemTrusteeMatches(trustee: string): boolean {
  const normalized = trustee.toUpperCase();
  return normalized === "SY" || normalized === SYSTEM_SID;
}

export function inspectWindowsAcl(path: string): WindowsAclInspection {
  requireWindows();
  if (!existsSync(path)) {
    return {
      private: true,
      unexpected_allow_sids: [],
      missing_full_control_sids: [],
      deny_sids: [],
      inherited_rule_count: 0,
      rule_count: 0,
    };
  }
  const savePath = join(tmpdir(), `hostspan-acl-${process.pid}-${randomBytes(6).toString("hex")}.txt`);
  let sddl: string;
  try {
    const result = spawnSync("icacls.exe", [path, "/save", savePath, "/Q"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
    });
    if (result.status !== 0 || !existsSync(savePath)) {
      throw new Error(
        result.stderr?.trim() || result.stdout?.trim() || result.error?.message || `icacls exited ${result.status}`,
      );
    }
    const text = readFileSync(savePath, "utf16le").replace(/^\uFEFF/, "");
    sddl = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("D:")) ?? "";
    if (!sddl) throw new Error("icacls did not return an SDDL DACL");
  } catch (error) {
    throw new Error(`Could not inspect Windows ACL for ${path}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(savePath, { force: true });
  }

  const currentSid = currentWindowsSid().toUpperCase();
  const prefixEnd = sddl.indexOf("(");
  const daclFlags = prefixEnd >= 0 ? sddl.slice(2, prefixEnd) : sddl.slice(2);
  const aces = [...sddl.matchAll(/\(([^()]*)\)/g)].map((match) => {
    const fields = (match[1] ?? "").split(";");
    return {
      type: fields[0] ?? "",
      flags: fields[1] ?? "",
      rights: fields[2] ?? "",
      trustee: fields[5] ?? "",
    };
  });
  const unexpected = [
    ...new Set(
      aces
        .filter(
          (ace) =>
            ace.type === "A" &&
            !currentTrusteeMatches(ace.trustee, currentSid) &&
            !systemTrusteeMatches(ace.trustee),
        )
        .map((ace) => ace.trustee),
    ),
  ];
  const denySids = [...new Set(aces.filter((ace) => ace.type === "D").map((ace) => ace.trustee))];
  const inheritedRuleCount = aces.filter((ace) => ace.flags.includes("ID")).length;
  const currentFullControl = aces.some(
    (ace) => ace.type === "A" && ace.rights === "FA" && currentTrusteeMatches(ace.trustee, currentSid),
  );
  const systemFullControl = aces.some(
    (ace) => ace.type === "A" && ace.rights === "FA" && systemTrusteeMatches(ace.trustee),
  );
  const missingFullControl = [
    ...(currentFullControl ? [] : [currentSid]),
    ...(systemFullControl ? [] : [SYSTEM_SID]),
  ];
  return {
    private:
      daclFlags.includes("P") &&
      unexpected.length === 0 &&
      denySids.length === 0 &&
      inheritedRuleCount === 0 &&
      missingFullControl.length === 0,
    unexpected_allow_sids: unexpected,
    missing_full_control_sids: missingFullControl,
    deny_sids: denySids,
    inherited_rule_count: inheritedRuleCount,
    rule_count: aces.length,
  };
}
