import { z } from "zod";

const RelativePathSchema = z.string().min(1).max(4096);
const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/i, "expected a 64-character SHA-256 hex digest");
const UuidV7Schema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, "expected a UUIDv7 idempotency key");

export const SystemStatusInputSchema = z.object({}).strict();
export const TargetListInputSchema = z.object({}).strict();

export const FileListInputSchema = z
  .object({
    target_id: z.string().min(1),
    path: RelativePathSchema.default("."),
    depth: z.number().int().min(0).max(16).default(2),
    max_entries: z.number().int().min(1).max(10_000).default(500),
    include_hidden: z.boolean().default(false),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export const FileReadInputSchema = z
  .object({
    target_id: z.string().min(1),
    path: RelativePathSchema,
    start_line: z.number().int().min(1).default(1),
    end_line: z.number().int().min(1).max(10_000_000).default(240),
    max_bytes: z.number().int().min(1).max(4 * 1024 * 1024).default(131_072),
    include_sha256: z.boolean().default(true),
  })
  .strict()
  .refine((value) => value.end_line >= value.start_line, {
    message: "end_line must be greater than or equal to start_line",
    path: ["end_line"],
  });

export const FileSearchInputSchema = z
  .object({
    target_id: z.string().min(1),
    query: z.string().max(16_384),
    paths: z.array(RelativePathSchema).max(64).default(["."]),
    glob: z.string().min(1).max(1024).optional(),
    context_before: z.number().int().min(0).max(50).default(3),
    context_after: z.number().int().min(0).max(50).default(5),
    max_matches: z.number().int().min(1).max(5_000).default(50),
    max_bytes: z.number().int().min(1).max(8 * 1024 * 1024).default(131_072),
    deadline_ms: z.number().int().min(50).max(30_000).default(5_000),
  })
  .strict();

export const FilePatchInputSchema = z
  .object({
    idempotency_key: UuidV7Schema,
    target_id: z.string().min(1),
    dry_run: z.boolean().default(false),
    files: z
      .array(
        z
          .object({
            path: RelativePathSchema,
            expected_sha256: Sha256HexSchema,
            unified_diff: z.string().min(1).max(4 * 1024 * 1024),
          })
          .strict(),
      )
      .min(1)
      .max(128),
    validators: z.array(z.enum(["git_diff_check", "syntax_check"])).max(8).default([]),
  })
  .strict();

export const ProcessStartInputSchema = z
  .object({
    idempotency_key: UuidV7Schema,
    target_id: z.string().min(1),
    argv: z.array(z.string().max(65_536)).min(1).max(256),
    cwd: RelativePathSchema.default("."),
    env: z.record(z.string().min(1).max(256), z.string().max(131_072)).default({}),
    wait_ms: z.number().int().min(0).max(1_500).default(1_200),
    deadline_ms: z.number().int().min(1).max(86_400_000).default(30_000),
    max_output_bytes: z.number().int().min(1).max(256 * 1024 * 1024).default(4_194_304),
    tty: z.boolean().optional(),
    columns: z.number().int().min(1).max(1_000).optional(),
    rows: z.number().int().min(1).max(1_000).optional(),
  })
  .strict();

export const ProcessPollInputSchema = z
  .object({
    process_id: z.string().min(1),
    stdout_cursor: z.number().int().nonnegative().default(0),
    stderr_cursor: z.number().int().nonnegative().default(0),
    wait_ms: z.number().int().min(0).max(1_500).default(0),
    max_bytes: z.number().int().min(1).max(4 * 1024 * 1024).default(131_072),
  })
  .strict();

export const ProcessCancelInputSchema = z
  .object({
    idempotency_key: UuidV7Schema,
    process_id: z.string().min(1),
    grace_ms: z.number().int().min(0).max(30_000).default(3_000),
  })
  .strict();

export const ProcessWriteInputSchema = z
  .object({
    idempotency_key: UuidV7Schema,
    process_id: z.string().min(1),
    chars: z.string().max(131_072).default(""),
    control_keys: z.array(z.enum(["Enter", "Escape", "Tab", "C-c", "C-d", "C-z"])).max(32).default([]),
    columns: z.number().int().min(1).max(1_000).optional(),
    rows: z.number().int().min(1).max(1_000).optional(),
    stdout_cursor: z.number().int().nonnegative().default(0),
    wait_ms: z.number().int().min(0).max(1_500).default(250),
    max_bytes: z.number().int().min(1).max(4 * 1024 * 1024).default(131_072),
  })
  .strict();

export type SystemStatusInput = z.infer<typeof SystemStatusInputSchema>;
export type TargetListInput = z.infer<typeof TargetListInputSchema>;
export type FileListToolInput = z.infer<typeof FileListInputSchema>;
export type FileReadToolInput = z.infer<typeof FileReadInputSchema>;
export type FileSearchToolInput = z.infer<typeof FileSearchInputSchema>;
export type FilePatchToolInput = z.infer<typeof FilePatchInputSchema>;
export type ProcessStartToolInput = z.infer<typeof ProcessStartInputSchema>;
export type ProcessPollToolInput = z.infer<typeof ProcessPollInputSchema>;
export type ProcessCancelToolInput = z.infer<typeof ProcessCancelInputSchema>;
export type ProcessWriteToolInput = z.infer<typeof ProcessWriteInputSchema>;
