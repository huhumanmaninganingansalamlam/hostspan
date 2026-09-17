import { z } from "zod";

export const CapabilitySchema = z.enum(["read", "write", "exec", "git"]);

export const ExecProfileSchema = z
  .object({
    mode: z.literal("native"),
    allowed_programs: z.array(z.string().min(1)).min(1),
    env_allowlist: z.array(z.string().min(1)).default([]),
    default_deadline_ms: z.number().int().positive().default(30_000),
    max_deadline_ms: z.number().int().positive().default(600_000),
    default_output_bytes: z.number().int().positive().default(4_194_304),
    max_output_bytes: z.number().int().positive().default(67_108_864),
    max_concurrent_processes: z.number().int().positive().max(64).default(4),
  })
  .strict();

export const TargetConfigSchema = z
  .object({
    label: z.string().min(1),
    provider: z.literal("local"),
    root: z.string().min(1),
    capabilities: z.array(CapabilitySchema).min(1),
    exec_profile: z.string().min(1).optional(),
    deny_globs: z.array(z.string()).default([]),
    ignore_globs: z.array(z.string()).default([]),
  })
  .strict();

export const HostSpanConfigSchema = z
  .object({
    schema_version: z.literal(1),
    policy_epoch: z.number().int().nonnegative(),
    server: z
      .object({
        listen_host: z.literal("127.0.0.1").default("127.0.0.1"),
        listen_port: z.number().int().min(1).max(65535).default(39393),
        data_dir: z.string().min(1),
      })
      .strict(),
    retention: z
      .object({
        completed_process_output_ttl_minutes: z.number().int().positive().default(60),
        operation_result_days: z.number().int().positive().default(14),
        audit_days: z.number().int().positive().default(30),
        max_total_spool_bytes: z.number().int().positive().default(1_073_741_824),
      })
      .strict(),
    targets: z.record(z.string().min(1), TargetConfigSchema),
    exec_profiles: z.record(z.string().min(1), ExecProfileSchema),
  })
  .strict();

export type Capability = z.infer<typeof CapabilitySchema>;
export type ExecProfile = z.infer<typeof ExecProfileSchema>;
export type TargetConfig = z.infer<typeof TargetConfigSchema>;
export type HostSpanConfig = z.infer<typeof HostSpanConfigSchema>;
