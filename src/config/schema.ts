import { isIP } from "node:net";
import { z } from "zod";

function validHostname(value: string): boolean {
  if (value.length > 253 || value.endsWith(".")) return false;
  return value.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

function validBindHost(value: string): boolean {
  if (value.includes("://") || value.includes("/") || /\s/.test(value)) return false;
  return isIP(value) !== 0 || validHostname(value);
}

function validAllowedHost(value: string): boolean {
  if (value.includes("://") || value.includes("/") || /\s/.test(value)) return false;
  if (value.startsWith("[") && value.endsWith("]")) return isIP(value.slice(1, -1)) === 6;
  return isIP(value) !== 0 || validHostname(value);
}

function validPublicMcpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname === "/mcp" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

const BindHostSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(validBindHost, {
    message: "listen_host must be a hostname or IP address without scheme, path, or whitespace",
  });

const AllowedHostSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(validAllowedHost, {
    message: "allowed_hosts entries must be hostnames or IP addresses without scheme, path, or port",
  });

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

export const OAuthConfigSchema = z
  .object({
    public_mcp_url: z.string().refine(validPublicMcpUrl, {
      message: "public_mcp_url must be an HTTPS URL whose path is exactly /mcp",
    }),
    issuer_identification: z.boolean().default(true),
    approval_secret_salt: z.string().regex(/^[A-Za-z0-9_-]{16,}$/),
    approval_secret_hash: z.string().regex(/^[A-Za-z0-9_-]{32,}$/),
    access_token_ttl_minutes: z.number().int().min(5).max(60).default(15),
    refresh_token_ttl_days: z.number().int().min(1).max(90).default(30),
    authorization_code_ttl_seconds: z.number().int().min(60).max(600).default(300),
    max_registered_clients: z.number().int().min(1).max(1000).default(100),
  })
  .strict();

export const HostSpanConfigSchema = z
  .object({
    schema_version: z.literal(1),
    policy_epoch: z.number().int().nonnegative(),
    server: z
      .object({
        listen_host: BindHostSchema.default("127.0.0.1"),
        listen_port: z.number().int().min(1).max(65535).default(39393),
        allowed_hosts: z.array(AllowedHostSchema).max(64).optional(),
        data_dir: z.string().min(1),
      })
      .strict()
      .superRefine((server, context) => {
        if (["0.0.0.0", "::"].includes(server.listen_host) && !(server.allowed_hosts?.length)) {
          context.addIssue({
            code: "custom",
            path: ["allowed_hosts"],
            message: "wildcard listen_host requires at least one allowed_hosts entry",
          });
        }
      }),
    retention: z
      .object({
        completed_process_output_ttl_minutes: z.number().int().positive().default(60),
        operation_result_days: z.number().int().positive().default(14),
        audit_days: z.number().int().positive().default(30),
        max_total_spool_bytes: z.number().int().positive().default(1_073_741_824),
      })
      .strict(),
    oauth: OAuthConfigSchema.optional(),
    targets: z.record(z.string().min(1), TargetConfigSchema),
    exec_profiles: z.record(z.string().min(1), ExecProfileSchema),
  })
  .strict();

export type Capability = z.infer<typeof CapabilitySchema>;
export type ExecProfile = z.infer<typeof ExecProfileSchema>;
export type TargetConfig = z.infer<typeof TargetConfigSchema>;
export type OAuthConfig = z.infer<typeof OAuthConfigSchema>;
export type HostSpanConfig = z.infer<typeof HostSpanConfigSchema>;
