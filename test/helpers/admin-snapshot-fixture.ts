import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostSpanConfig } from "../../src/config/schema.js";
import { writeConfigAtomic } from "../../src/config/writer.js";

export interface AdminSnapshotProfile {
	root: string;
	targetRoot: string;
	configPath: string;
	dataDir: string;
}

/**
 * Owns only temporary admin profile roots and their generated config files.
 * Tests remain responsible for closing every runtime, control server, or database
 * they open before this context removes the profile root in `afterEach`.
 */
export class AdminSnapshotTestContext {
	readonly #roots: string[] = [];

	createAdminSnapshotProfile(): AdminSnapshotProfile {
		const root = mkdtempSync(join(tmpdir(), "hostspan-admin-"));
		this.#roots.push(root);
		const targetRoot = join(root, "target");
		const dataDir = join(root, "state");
		const configPath = join(root, "config.yaml");
		mkdirSync(targetRoot, { recursive: true });
		const config: HostSpanConfig = {
			schema_version: 1,
			policy_epoch: 9,
			server: {
				listen_host: "127.0.0.1",
				listen_port: 39393,
				data_dir: dataDir,
			},
			retention: {
				completed_process_output_ttl_minutes: 60,
				operation_result_days: 14,
				audit_days: 30,
				max_total_spool_bytes: 1024 * 1024,
			},
			terminal: {
				backend: "pty",
				max_concurrent_sessions: 2,
				attach_history_bytes: 64 * 1024,
				max_output_bytes: 1024 * 1024,
			},
			targets: {
				local: {
					label: "Local workspace",
					provider: "local",
					root: targetRoot,
					capabilities: ["read", "write", "exec", "terminal"],
					exec_profile: "native",
					deny_globs: [],
					ignore_globs: [],
				},
			},
			exec_profiles: {
				native: {
					mode: "native",
					max_concurrent_processes: 4,
				},
			},
		};
		writeConfigAtomic(configPath, config);
		return { root, targetRoot, configPath, dataDir };
	}

	dispose(): void {
		for (const root of this.#roots.splice(0))
			rmSync(root, { recursive: true, force: true });
	}
}
