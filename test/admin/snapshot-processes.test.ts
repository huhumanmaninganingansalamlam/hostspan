import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
	buildAdminSnapshot,
	removeLocalWorkspace,
} from "../../src/admin/snapshot.js";
import {
	daemonStatus,
	removeDaemonPid,
	writeDaemonPid,
} from "../../src/daemon/control.js";
import { createRuntime } from "../../src/runtime/create-runtime.js";
import { loadConfig } from "../../src/config/loader.js";
import { writeConfigAtomic } from "../../src/config/writer.js";
import { AuditRepo } from "../../src/state/audit-repo.js";
import { DB_SCHEMA_VERSION, openDatabase } from "../../src/state/database.js";
import { ProcessesRepo } from "../../src/state/processes-repo.js";
import { AdminSnapshotTestContext } from "../helpers/admin-snapshot-fixture.js";

const adminProfiles = new AdminSnapshotTestContext();

afterEach(() => {
	adminProfiles.dispose();
});

describe("admin snapshot process and database visibility", () => {
	it("reads targets, active work, calls, process state, and daemon pid without mutating running records", async () => {
		const { configPath, dataDir } = adminProfiles.createAdminSnapshotProfile();
		const runtime = createRuntime(configPath);
		const db = runtime.db;
		const processes = new ProcessesRepo(db);
		processes.create({
			process_id: "proc_admin",
			idempotency_key: "0199e78d-4c00-7000-8000-000000000901",
			target_id: "local",
			argv_digest: "sha256:test",
			cwd_relative: ".",
			backend: "pty",
			backend_ref: "proc_admin",
			deadline_at: new Date(Date.now() + 60_000).toISOString(),
			max_output_bytes: 1024 * 1024,
		});
		processes.markRunning("proc_admin", 12345, null);
		new AuditRepo(db).append({
			request_id: "req_admin",
			event_type: "request.accepted",
			metadata: { tool: "system_status" },
		});
		await runtime.close();
		rmSync(join(dataDir, "sessions"), { recursive: true, force: true });
		writeDaemonPid(configPath, process.pid);

		try {
			expect(existsSync(join(dataDir, "sessions"))).toBe(false);
			const snapshot = buildAdminSnapshot(configPath, { recent: 20 });
			expect(existsSync(join(dataDir, "sessions"))).toBe(false);
			expect(snapshot.daemon).toMatchObject({
				running: true,
				pid: process.pid,
			});
			expect(snapshot.active_process_count).toBe(1);
			expect(snapshot.active_requests).toContainEqual(
				expect.objectContaining({ request_id: "req_admin" }),
			);
			expect(snapshot.active_processes).toContainEqual(
				expect.objectContaining({
					process_id: "proc_admin",
					target_id: "local",
				}),
			);
			expect(snapshot.targets).toContainEqual(
				expect.objectContaining({
					target_id: "local",
					label: "Local workspace",
					ready: true,
				}),
			);
			expect(snapshot.recent_calls).toContainEqual(
				expect.objectContaining({
					request_id: "req_admin",
					event_type: "request.accepted",
				}),
			);
			const terminalSession = snapshot.terminal.sessions.find(
				(session) =>
					(session as Record<string, unknown>).process_id === "proc_admin",
			);
			expect(terminalSession).toMatchObject({
				process_id: "proc_admin",
				state: "running",
				live: false,
			});
			expect(terminalSession).not.toHaveProperty("attach_command");
			expect(terminalSession).not.toHaveProperty("attach_read_only_command");
			expect(() => removeLocalWorkspace(configPath, "local")).toThrow(
				/process\(es\) are active/,
			);

			const readonly = new Database(join(dataDir, "state.db"), {
				readonly: true,
			});
			try {
				expect(
					(
						readonly
							.prepare("SELECT state FROM processes WHERE process_id=?")
							.get("proc_admin") as { state: string }
					).state,
				).toBe("running");
			} finally {
				readonly.close();
			}
		} finally {
			removeDaemonPid(configPath, process.pid);
		}
		expect(daemonStatus(configPath).running).toBe(false);
	});

	it("does not present a newly available or changed folder as ready in the running daemon", async () => {
		const { configPath, targetRoot } =
			adminProfiles.createAdminSnapshotProfile();
		rmSync(targetRoot, { recursive: true });
		let runtime = createRuntime(configPath);
		writeDaemonPid(configPath);
		try {
			mkdirSync(targetRoot);
			expect(buildAdminSnapshot(configPath).targets[0]?.ready).toBe(false);
			await runtime.close();
			runtime = createRuntime(configPath);
			expect(buildAdminSnapshot(configPath).targets[0]?.ready).toBe(true);
			const config = loadConfig(configPath);
			for (const target of Object.values(config.targets))
				target.capabilities = ["read"];
			writeConfigAtomic(configPath, config);
			expect(buildAdminSnapshot(configPath).targets[0]?.ready).toBe(false);
		} finally {
			await runtime.close();
			removeDaemonPid(configPath);
		}
		expect(buildAdminSnapshot(configPath).targets[0]?.ready).toBe(true);
	});

	it("limits active-request matching to the same recent window returned by the snapshot", () => {
		const { configPath, dataDir } = adminProfiles.createAdminSnapshotProfile();
		const db = openDatabase(join(dataDir, "state.db"));
		const audit = new AuditRepo(db);
		audit.append({
			request_id: "req_recent_active",
			event_type: "request.accepted",
			metadata: { tool: "file_read" },
		});
		audit.append({
			request_id: "req_recent_done",
			event_type: "request.accepted",
			metadata: { tool: "file_list" },
		});
		audit.append({
			request_id: "req_recent_done",
			event_type: "response.returned",
			metadata: { tool: "file_list" },
		});
		db.prepare(
			"INSERT INTO audit_events(event_id,request_id,idempotency_key,process_id,event_type,metadata_json,timestamp) VALUES(?,?,?,?,?,?,?)",
		).run(
			"evt_old_active",
			"req_old_active",
			null,
			null,
			"request.accepted",
			JSON.stringify({ tool: "file_search" }),
			new Date(Date.now() - 10 * 60_000).toISOString(),
		);
		db.close();

		const snapshot = buildAdminSnapshot(configPath, { recent: 20 });
		expect(snapshot.active_requests).toContainEqual(
			expect.objectContaining({ request_id: "req_recent_active" }),
		);
		expect(snapshot.active_requests).not.toContainEqual(
			expect.objectContaining({ request_id: "req_recent_done" }),
		);
		expect(snapshot.active_requests).not.toContainEqual(
			expect.objectContaining({ request_id: "req_old_active" }),
		);
	});

	it("keeps active PTY sessions visible outside the recent-process limit", () => {
		const { configPath, dataDir } = adminProfiles.createAdminSnapshotProfile();
		const db = openDatabase(join(dataDir, "state.db"));
		const processes = new ProcessesRepo(db);
		processes.create({
			process_id: "proc_active_terminal",
			idempotency_key: "0199e78d-4c00-7000-8000-000000000911",
			target_id: "local",
			argv_digest: "sha256:terminal",
			cwd_relative: ".",
			backend: "pty",
			backend_ref: "proc_active_terminal",
			deadline_at: new Date(Date.now() + 60_000).toISOString(),
			max_output_bytes: 1024 * 1024,
		});
		processes.markRunning("proc_active_terminal", 12345, null);
		processes.create({
			process_id: "proc_newer_completed",
			idempotency_key: "0199e78d-4c00-7000-8000-000000000912",
			target_id: "local",
			argv_digest: "sha256:newer",
			cwd_relative: ".",
		});
		processes.markRunning("proc_newer_completed", 12346, 12346);
		processes.markTerminal("proc_newer_completed", "succeeded", 0, null, null);
		db.prepare(
			"UPDATE processes SET started_at='2026-09-18T00:00:00.000Z' WHERE process_id='proc_active_terminal'",
		).run();
		db.prepare(
			"UPDATE processes SET started_at='2026-09-18T00:01:00.000Z', ended_at='2026-09-18T00:01:01.000Z' WHERE process_id='proc_newer_completed'",
		).run();
		db.close();

		const spoolDir = join(
			dataDir,
			"spools",
			"processes",
			"proc_active_terminal",
		);
		mkdirSync(spoolDir, { recursive: true });
		writeFileSync(join(spoolDir, "stdout.bin"), "prompt\n");

		const snapshot = buildAdminSnapshot(configPath, { recent: 1 });
		expect(snapshot.recent_processes).toEqual([
			expect.objectContaining({ process_id: "proc_newer_completed" }),
		]);
		expect(snapshot.terminal.sessions).toContainEqual(
			expect.objectContaining({
				process_id: "proc_active_terminal",
				state: "running",
				live: false,
				output_bytes: 7,
				last_output_at: expect.any(String),
			}),
		);
	});

	it("rejects an unsupported state database instead of silently adapting it", () => {
		const { configPath, dataDir } = adminProfiles.createAdminSnapshotProfile();
		const path = join(dataDir, "state.db");
		mkdirSync(dataDir, { recursive: true });
		rmSync(path, { force: true });
		const unsupported = new Database(path);
		unsupported.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta(key,value) VALUES('schema_version','3');
      CREATE TABLE processes (
        process_id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, target_id TEXT NOT NULL,
        argv_digest TEXT NOT NULL, cwd_relative TEXT NOT NULL, pid INTEGER, pgid INTEGER,
        state TEXT NOT NULL, exit_code INTEGER, term_signal TEXT, reason TEXT,
        started_at TEXT, ended_at TEXT, stdout_bytes INTEGER NOT NULL DEFAULT 0,
        stderr_bytes INTEGER NOT NULL DEFAULT 0, output_expires_at TEXT
      );
      CREATE TABLE audit_events (
        event_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, idempotency_key TEXT, process_id TEXT,
        event_type TEXT NOT NULL, metadata_json TEXT NOT NULL, timestamp TEXT NOT NULL
      );
      INSERT INTO processes(process_id,idempotency_key,target_id,argv_digest,cwd_relative,state,started_at)
      VALUES('proc_unsupported','0199e78d-4c00-7000-8000-000000000902','local','sha256:test','.','running','2026-09-18T00:00:00.000Z');
    `);
		unsupported.close();

		expect(() => buildAdminSnapshot(configPath, { recent: 20 })).toThrow(
			/unsupported HostSpan database schema 3/,
		);

		const check = new Database(path, { readonly: true });
		try {
			const columns = check
				.prepare("PRAGMA table_info(processes)")
				.all() as Array<{ name: string }>;
			expect(columns.some((column) => column.name === "backend")).toBe(false);
			expect(
				(
					check
						.prepare("SELECT value FROM meta WHERE key='schema_version'")
						.get() as { value: string }
				).value,
			).toBe("3");
		} finally {
			check.close();
		}
	});

	it("rejects a current-version database whose required schema shape is incomplete", () => {
		const { configPath, dataDir } = adminProfiles.createAdminSnapshotProfile();
		const path = join(dataDir, "state.db");
		const created = openDatabase(path);
		created.close();

		const damaged = new Database(path);
		damaged.exec("ALTER TABLE processes DROP COLUMN backend_ref");
		damaged.close();

		expect(() => buildAdminSnapshot(configPath, { recent: 20 })).toThrow(
			new RegExp(
				`schema ${DB_SCHEMA_VERSION} is incomplete; processes is missing columns: backend_ref`,
			),
		);
	});
});
