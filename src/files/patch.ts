import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { applyPatch } from "diff";
import { parse as parseYaml } from "yaml";
import { v7 as uuidv7 } from "uuid";
import type { FilePatchToolInput } from "../mcp/schemas.js";
import { HostSpanError, asHostSpanError } from "../mcp/errors.js";
import type { PolicyEvaluator } from "../policy/evaluator.js";
import type { OperationsRepo } from "../state/operations-repo.js";
import type { TransactionsRepo } from "../state/transactions-repo.js";
import type { TargetRegistry, TargetRuntime } from "../targets/registry.js";
import {
  assertDirectoryStillCurrent,
  closeOpenedDirectory,
  openDirectoryNoFollow,
  openReadNoFollow,
  recheckTargetPath,
} from "./path-guard.js";
import { darwinOpenAt, darwinRenameAt, darwinUnlinkAtIfExists } from "./darwin-fs.js";
import { sha256File } from "./read.js";

interface PreparedFile {
  path: string;
  absolute: string;
  mode: number;
  before: Buffer;
  before_sha256: string;
  after: Buffer;
  after_sha256: string;
  unified_diff: string;
}

interface JournalFile {
  path: string;
  mode: number;
  before_base64: string;
  before_sha256: string;
  after_sha256: string;
}

interface PatchJournal {
  schema_version: 1;
  transaction_id: string;
  idempotency_key: string;
  target_id: string;
  state: "prepared" | "committing" | "verified" | "rolled_back" | "unknown";
  committed_count: number;
  created_at: string;
  files: JournalFile[];
}

interface ValidatorResult {
  name: string;
  status: "passed" | "unavailable";
  details?: string;
}

function sha256(buffer: Uint8Array | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function fsyncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    const fd = openSync(temp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    fsyncDirectory(dirname(path));
  } finally {
    rmSync(temp, { force: true });
  }
}

function removeTerminalJournal(path: string): boolean {
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    // The durable DB outcome is authoritative once the transaction is terminal.
    return false;
  }
}

export function cleanupTerminalPatchJournals(transactions: TransactionsRepo): string[] {
  const removed: string[] = [];
  for (const { transaction_id: transactionId, journal_path: path } of transactions.terminalJournals()) {
    if (!path) continue;
    if (!existsSync(path)) {
      transactions.clearJournalPath(transactionId);
      continue;
    }
    try {
      rmSync(path, { force: true });
      removed.push(path);
      transactions.clearJournalPath(transactionId);
    } catch {
      // A terminal database outcome is authoritative. A later maintenance
      // pass can retry cleanup if the filesystem temporarily rejects removal.
    }
  }
  return removed;
}

function readTextStrict(buffer: Buffer, path: string): string {
  if (buffer.includes(0)) throw new HostSpanError("BINARY_FILE", `Binary file cannot be patched as text: ${path}`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new HostSpanError("BINARY_FILE", `File is not valid UTF-8 text: ${path}`);
  }
}

function assertGitDiffCheck(file: PreparedFile): void {
  const bad = file.unified_diff
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++") && /[ \t]+$/.test(line));
  if (bad.length) {
    throw new HostSpanError("VALIDATION_FAILED", `git_diff_check found trailing whitespace in ${file.path}.`, false, {
      validator: "git_diff_check",
      line_count: bad.length,
    });
  }
}

function syntaxCheck(file: PreparedFile): ValidatorResult {
  const extension = extname(file.path).toLowerCase();
  const text = readTextStrict(file.after, file.path);
  try {
    if (extension === ".json") JSON.parse(text);
    else if (extension === ".yaml" || extension === ".yml") parseYaml(text);
    else return { name: "syntax_check", status: "unavailable", details: `No Alpha syntax validator for ${extension || "extensionless files"}.` };
  } catch (error) {
    throw new HostSpanError("VALIDATION_FAILED", `syntax_check failed for ${file.path}.`, false, {
      validator: "syntax_check",
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  return { name: "syntax_check", status: "passed" };
}

function runValidators(files: PreparedFile[], validators: FilePatchToolInput["validators"]): ValidatorResult[] {
  const results: ValidatorResult[] = [];
  for (const validator of validators) {
    if (validator === "git_diff_check") {
      for (const file of files) assertGitDiffCheck(file);
      results.push({ name: validator, status: "passed" });
    } else if (validator === "syntax_check") {
      let unavailable: ValidatorResult | undefined;
      for (const file of files) {
        const result = syntaxCheck(file);
        if (result.status === "unavailable") unavailable = result;
      }
      results.push(unavailable ?? { name: validator, status: "passed" });
    }
  }
  return results;
}

function atomicReplace(target: TargetRuntime, relativePath: string, content: Buffer, mode: number): void {
  const before = recheckTargetPath(target, relativePath, "write");
  const parentRelative = dirname(before.relative);
  const parent = openDirectoryNoFollow(target, parentRelative, "write");
  const tempName = `.hostspan-${process.pid}-${uuidv7()}.tmp`;
  const destinationName = basename(before.relative);
  const temp = join(parent.stable_path, tempName);
  const destination = join(parent.stable_path, destinationName);
  try {
    if (process.platform === "darwin") {
      if (parent.fd === null) throw new HostSpanError("POLICY_UNENFORCEABLE", "Darwin directory handle is unavailable.");
      const flags =
        constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0);
      const fd = darwinOpenAt(parent.fd, tempName, flags, mode & 0o777);
      try {
        writeFileSync(fd, content);
        fchmodSync(fd, mode & 0o777);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } else {
      writeFileSync(temp, content, { mode: mode & 0o777 });
      chmodSync(temp, mode & 0o777);
      const fd = openSync(temp, "r+");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    const rechecked = recheckTargetPath(target, relativePath, "write");
    if (rechecked.absolute !== before.absolute) throw new HostSpanError("PATH_OUTSIDE_TARGET", "Path changed while preparing atomic replace.");
    assertDirectoryStillCurrent(target, parentRelative, parent, "write");
    if (process.platform === "darwin") {
      if (parent.fd === null) throw new HostSpanError("POLICY_UNENFORCEABLE", "Darwin directory handle is unavailable.");
      darwinRenameAt(parent.fd, tempName, destinationName);
    } else {
      renameSync(temp, destination);
    }
    if (parent.fd !== null) fsyncSync(parent.fd);
    recheckTargetPath(target, relativePath, "write");
    assertDirectoryStillCurrent(target, parentRelative, parent, "write");
  } finally {
    if (process.platform === "darwin" && parent.fd !== null) darwinUnlinkAtIfExists(parent.fd, tempName);
    else rmSync(temp, { force: true });
    closeOpenedDirectory(parent);
  }
}

function prepareFiles(target: TargetRuntime, input: FilePatchToolInput, policy: PolicyEvaluator): PreparedFile[] {
  const seen = new Set<string>();
  const prepared: PreparedFile[] = [];
  for (const requested of input.files) {
    const opened = openReadNoFollow(target, requested.path);
    const guarded = opened.path;
    let stat: ReturnType<typeof fstatSync>;
    let before: Buffer;
    try {
      stat = fstatSync(opened.fd);
      if (!stat.isFile()) throw new HostSpanError("PATCH_REJECTED", `Patch target is not a regular file: ${requested.path}`);
      before = readFileSync(opened.fd);
    } finally {
      closeSync(opened.fd);
    }
    policy.assertFileAllowed(target, guarded.relative, guarded.absolute, true);
    if (seen.has(guarded.relative)) throw new HostSpanError("PATCH_REJECTED", `Duplicate path in patch batch: ${guarded.relative}`);
    seen.add(guarded.relative);
    const beforeHash = sha256(before);
    if (beforeHash !== requested.expected_sha256.toLowerCase()) {
      throw new HostSpanError("STALE_CONTENT", `File changed since it was read: ${guarded.relative}`, false, {
        path: guarded.relative,
        expected_sha256: requested.expected_sha256.toLowerCase(),
        actual_sha256: beforeHash,
      });
    }
    const text = readTextStrict(before, guarded.relative);
    let patched: string | false;
    try {
      patched = applyPatch(text, requested.unified_diff, { autoConvertLineEndings: true });
    } catch (error) {
      throw new HostSpanError("PATCH_REJECTED", `Unified diff is malformed for ${guarded.relative}.`, false, {
        path: guarded.relative,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    if (patched === false) throw new HostSpanError("PATCH_REJECTED", `Unified diff does not apply cleanly: ${guarded.relative}`, false, { path: guarded.relative });
    const after = Buffer.from(patched, "utf8");
    prepared.push({
      path: guarded.relative,
      absolute: guarded.absolute,
      mode: stat.mode,
      before,
      before_sha256: beforeHash,
      after,
      after_sha256: sha256(after),
      unified_diff: requested.unified_diff,
    });
  }
  return prepared;
}

function resultFor(files: PreparedFile[], validators: ValidatorResult[], dryRun: boolean, state: "verified" | "unverified") {
  return {
    state,
    dry_run: dryRun,
    files: files.map((file) => ({
      path: file.path,
      before_sha256: file.before_sha256,
      after_sha256: file.after_sha256,
      unified_diff: file.unified_diff,
    })),
    validators,
  };
}

export interface FilePatchServiceOptions {
  data_dir: string;
  operations: OperationsRepo;
  transactions: TransactionsRepo;
  policy: PolicyEvaluator;
}

export class FilePatchService {
  constructor(private readonly options: FilePatchServiceOptions) {}

  apply(target: TargetRuntime, input: FilePatchToolInput): Record<string, unknown> {
    const resolution = this.options.operations.resolve(input.idempotency_key, "file_patch", input, input.target_id);
    if (resolution.kind === "replay") {
      if (resolution.error) throw resolution.error;
      return (resolution.result as Record<string, unknown> | null) ?? { state: resolution.state };
    }
    if (resolution.kind === "unknown") return (resolution.result as Record<string, unknown> | null) ?? { state: resolution.state };
    if (resolution.kind === "join") return (resolution.result as Record<string, unknown> | null) ?? { state: resolution.state };

    try {
      const files = prepareFiles(target, input, this.options.policy);
      const validators = runValidators(files, input.validators);
      const resultState = validators.some((item) => item.status === "unavailable") ? "unverified" : "verified";
      if (input.dry_run) {
        const result = resultFor(files, validators, true, resultState);
        this.options.operations.setState(input.idempotency_key, resultState, result);
        return result;
      }

      const transactionId = `txn_${uuidv7().replaceAll("-", "")}`;
      const journalPath = join(this.options.data_dir, "transactions", `${transactionId}.json`);
      const journal: PatchJournal = {
        schema_version: 1,
        transaction_id: transactionId,
        idempotency_key: input.idempotency_key,
        target_id: input.target_id,
        state: "prepared",
        committed_count: 0,
        created_at: new Date().toISOString(),
        files: files.map((file) => ({
          path: file.path,
          mode: file.mode,
          before_base64: file.before.toString("base64"),
          before_sha256: file.before_sha256,
          after_sha256: file.after_sha256,
        })),
      };
      writeJsonAtomic(journalPath, journal);
      this.options.transactions.create(transactionId, input.idempotency_key, input.target_id, journalPath);
      journal.state = "committing";
      writeJsonAtomic(journalPath, journal);
      this.options.transactions.setOutcome(
        transactionId,
        "committing",
        input.idempotency_key,
        "committing",
        { transaction_id: transactionId },
      );

      try {
        for (const [index, file] of files.entries()) {
          const currentHash = sha256File(target, file.path);
          if (currentHash !== file.before_sha256) throw new HostSpanError("STALE_CONTENT", `File changed during patch commit: ${file.path}`);
          atomicReplace(target, file.path, file.after, file.mode);
          const afterHash = sha256File(target, file.path);
          if (afterHash !== file.after_sha256) throw new HostSpanError("PATCH_REJECTED", `Postcondition hash mismatch after writing ${file.path}.`);
          journal.committed_count = index + 1;
          writeJsonAtomic(journalPath, journal);
        }
      } catch (commitError) {
        let rolledBack = true;
        for (const file of files) {
          try {
            const actual = existsSync(file.absolute) ? sha256File(target, file.path) : "";
            if (actual === file.after_sha256) atomicReplace(target, file.path, file.before, file.mode);
            if (sha256File(target, file.path) !== file.before_sha256) rolledBack = false;
          } catch {
            rolledBack = false;
          }
        }
        journal.state = rolledBack ? "rolled_back" : "unknown";
        writeJsonAtomic(journalPath, journal);
        if (rolledBack) {
          const error = asHostSpanError(commitError);
          this.options.transactions.setOutcome(
            transactionId,
            "rolled_back",
            input.idempotency_key,
            "rolled_back",
            { state: "rolled_back", transaction_id: transactionId },
            error,
          );
          if (removeTerminalJournal(journalPath)) this.options.transactions.clearJournalPath(transactionId);
          throw error;
        }
        const unknown = new HostSpanError("PATCH_REJECTED", "Patch commit outcome is unknown after rollback failure.", false, { transaction_id: transactionId });
        this.options.transactions.setOutcome(
          transactionId,
          "unknown",
          input.idempotency_key,
          "unknown",
          { state: "unknown", transaction_id: transactionId },
          unknown,
        );
        throw unknown;
      }

      journal.state = "verified";
      writeJsonAtomic(journalPath, journal);
      const result = { ...resultFor(files, validators, false, resultState), transaction_id: transactionId };
      this.options.transactions.setOutcome(transactionId, "verified", input.idempotency_key, resultState, result);
      if (removeTerminalJournal(journalPath)) this.options.transactions.clearJournalPath(transactionId);
      return result;
    } catch (error) {
      const existing = this.options.operations.get(input.idempotency_key);
      if (existing?.state === "accepted") this.options.operations.setState(input.idempotency_key, "failed", undefined, asHostSpanError(error));
      throw error;
    }
  }
}

function parseJournal(path: string): PatchJournal {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as PatchJournal;
  if (parsed.schema_version !== 1 || !Array.isArray(parsed.files)) throw new Error("unsupported patch journal");
  return parsed;
}

export function recoverPatchTransactions(
  targets: TargetRegistry,
  transactions: TransactionsRepo,
): Array<{ transaction_id: string; state: string }> {
  const recovered: Array<{ transaction_id: string; state: string }> = [];
  for (const transaction of transactions.active()) {
    let journal: PatchJournal;
    try {
      journal = parseJournal(transaction.journal_path);
    } catch {
      transactions.setOutcome(
        transaction.transaction_id,
        "unknown",
        transaction.idempotency_key,
        "unknown",
        { state: "unknown", transaction_id: transaction.transaction_id },
      );
      recovered.push({ transaction_id: transaction.transaction_id, state: "unknown" });
      continue;
    }
    let target: TargetRuntime;
    try {
      target = targets.get(journal.target_id, "write");
    } catch {
      transactions.setOutcome(
        transaction.transaction_id,
        "unknown",
        transaction.idempotency_key,
        "unknown",
        { state: "unknown", transaction_id: transaction.transaction_id },
      );
      recovered.push({ transaction_id: transaction.transaction_id, state: "unknown" });
      continue;
    }

    const states = journal.files.map((file) => {
      try {
        const actual = sha256File(target, file.path);
        if (actual === file.after_sha256) return "after" as const;
        if (actual === file.before_sha256) return "before" as const;
        return "other" as const;
      } catch {
        return "other" as const;
      }
    });

    if (states.every((state) => state === "after")) {
      journal.state = "verified";
      writeJsonAtomic(transaction.journal_path, journal);
      const result = {
        state: "verified",
        recovered: true,
        transaction_id: transaction.transaction_id,
        files: journal.files.map((file) => ({ path: file.path, before_sha256: file.before_sha256, after_sha256: file.after_sha256 })),
      };
      transactions.setOutcome(transaction.transaction_id, "verified", transaction.idempotency_key, "verified", result);
      if (removeTerminalJournal(transaction.journal_path)) {
        transactions.clearJournalPath(transaction.transaction_id);
      }
      recovered.push({ transaction_id: transaction.transaction_id, state: "verified" });
      continue;
    }

    if (states.some((state) => state === "other")) {
      journal.state = "unknown";
      writeJsonAtomic(transaction.journal_path, journal);
      transactions.setOutcome(
        transaction.transaction_id,
        "unknown",
        transaction.idempotency_key,
        "unknown",
        { state: "unknown", transaction_id: transaction.transaction_id },
      );
      recovered.push({ transaction_id: transaction.transaction_id, state: "unknown" });
      continue;
    }

    let rollbackOk = true;
    for (const [index, file] of journal.files.entries()) {
      if (states[index] !== "after") continue;
      try {
        atomicReplace(target, file.path, Buffer.from(file.before_base64, "base64"), file.mode);
        if (sha256File(target, file.path) !== file.before_sha256) rollbackOk = false;
      } catch {
        rollbackOk = false;
      }
    }
    journal.state = rollbackOk ? "rolled_back" : "unknown";
    writeJsonAtomic(transaction.journal_path, journal);
    transactions.setOutcome(
      transaction.transaction_id,
      journal.state,
      transaction.idempotency_key,
      journal.state,
      { state: journal.state, recovered: true, transaction_id: transaction.transaction_id },
    );
    if (rollbackOk && removeTerminalJournal(transaction.journal_path)) {
      transactions.clearJournalPath(transaction.transaction_id);
    }
    recovered.push({ transaction_id: transaction.transaction_id, state: journal.state });
  }
  return recovered;
}
