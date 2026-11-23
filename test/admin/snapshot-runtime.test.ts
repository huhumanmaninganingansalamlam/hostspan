import { existsSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildAdminSnapshot,
	computerRuntimeState,
	setComputerEnabled,
} from "../../src/admin/snapshot.js";
import {
	removeDaemonPid,
	requestDaemonShutdown,
	startDaemonControlServer,
	stopDaemon,
	writeDaemonPid,
} from "../../src/daemon/control.js";
import { PortalDesktop } from "../../src/computer/portal.js";
import { createInitialConfig } from "../../src/config/defaults.js";
import { createRuntime } from "../../src/runtime/create-runtime.js";
import { loadConfig } from "../../src/config/loader.js";
import { runDoctor } from "../../src/diagnostics/doctor.js";
import { writeConfigAtomic } from "../../src/config/writer.js";
import { BUILD_IDENTITY, loadBuildIdentity } from "../../src/version.js";
import { AdminSnapshotTestContext } from "../helpers/admin-snapshot-fixture.js";

const adminProfiles = new AdminSnapshotTestContext();

afterEach(() => {
	adminProfiles.dispose();
});

describe("admin snapshot runtime and daemon state", () => {
	it("loads a validated build receipt and rejects a tampered or missing file", () => {
		const { root } = adminProfiles.createAdminSnapshotProfile();
		const path = join(root, "build-identity.json");
		const commit = "a".repeat(40);
		const tree = "b".repeat(40);
		const variant = "candidate";
		const object_format = "sha1";
		const dirty = false;
		const build_id = `sha256:${createHash("sha256")
			.update(JSON.stringify([1, variant, commit, tree, object_format, dirty]))
			.digest("hex")}`;
		const receipt = {
			schema_version: 1,
			build_id,
			commit,
			tree,
			object_format,
			variant,
			dirty,
		};
		writeFileSync(path, JSON.stringify(receipt));
		expect(loadBuildIdentity(path)).toEqual(receipt);
		writeFileSync(path, JSON.stringify({ ...receipt, tree: "c".repeat(40) }));
		expect(loadBuildIdentity(path)).toMatchObject({
			build_id: null,
			commit: null,
			variant: "development",
		});
		const releaseDigest = (releaseDirty: boolean) =>
			`sha256:${createHash("sha256")
				.update(
					JSON.stringify([
						1,
						"release",
						commit,
						tree,
						object_format,
						releaseDirty,
					]),
				)
				.digest("hex")}`;
		const cleanRelease = {
			...receipt,
			variant: "release",
			build_id: releaseDigest(false),
		};
		writeFileSync(path, JSON.stringify(cleanRelease));
		expect(loadBuildIdentity(path)).toEqual(cleanRelease);
		// The digest is valid for the dirty release too: only the release-specific guard can reject it.
		writeFileSync(
			path,
			JSON.stringify({
				...cleanRelease,
				dirty: true,
				build_id: releaseDigest(true),
			}),
		);
		expect(loadBuildIdentity(path)).toMatchObject({
			build_id: null,
			commit: null,
			variant: "development",
		});
		rmSync(path);
		expect(loadBuildIdentity(path)).toMatchObject({
			build_id: null,
			commit: null,
			dirty: null,
		});
	});

	it("reports one build identity in runtime status and the admin snapshot", async () => {
		const { configPath } = adminProfiles.createAdminSnapshotProfile();
		const runtime = createRuntime(configPath);
		try {
			const status = await runtime.handlers.system_status(
				{},
				"req_build_identity",
			);
			expect(status).toMatchObject({ build: BUILD_IDENTITY });
			expect(buildAdminSnapshot(configPath).build).toEqual(BUILD_IDENTITY);
		} finally {
			await runtime.close();
		}
	});

	it("keeps authenticated tray status off the MCP audit path while retaining external tool auditing", async () => {
		const { configPath } = adminProfiles.createAdminSnapshotProfile();
		const runtime = createRuntime(configPath);
		writeDaemonPid(configPath);
		const control = await startDaemonControlServer(
			configPath,
			() => {},
			async (input) => {
				if (input.action !== "status")
					throw new Error("Unexpected computer action.");
				return { structuredContent: runtime.desktopComputerStatus() };
			},
		);
		const count = () =>
			(
				runtime.db
					.prepare("SELECT count(*) AS count FROM audit_events")
					.get() as { count: number }
			).count;
		try {
			const initial = count();
			for (let i = 0; i < 12; i++) {
				expect(await computerRuntimeState(configPath)).toMatchObject({
					enabled: false,
					state: "disabled",
				});
			}
			expect(count()).toBe(initial);
			const remote = await runtime.handlers.system_status(
				{},
				"req_external_system_status",
			);
			expect(runtime.desktopComputerStatus().backends.computer).toEqual(
				(remote.backends as { computer: Record<string, unknown> }).computer,
			);
			expect(count()).toBe(initial + 2);
		} finally {
			await control.close();
			removeDaemonPid(configPath);
			await runtime.close();
		}
	});

	it("defaults computer-use OFF and applies explicit ON/OFF only at the restart boundary", async () => {
		const { configPath } = adminProfiles.createAdminSnapshotProfile();
		expect(createInitialConfig().computer).toBeUndefined();
		const before = loadConfig(configPath);
		const run = vi
			.spyOn(PortalDesktop.prototype, "run")
			.mockResolvedValue({ state: "ready" });
		let runtime = createRuntime(configPath);
		const denied = async () => {
			const session_id = "0199e78d-4c00-7000-8000-000000000901";
			for (const input of [
				{ action: "open" as const },
				{ action: "observe" as const, session_id },
				{
					action: "key" as const,
					key: "Enter" as const,
					session_id,
					observation_id: session_id,
					idempotency_key: "off-key",
				},
				{
					action: "click" as const,
					button: "left" as const,
					x: 0,
					y: 0,
					session_id,
					observation_id: session_id,
					idempotency_key: "off-click",
				},
			]) {
				await expect(
					runtime.handlers.computer(input, "req_off"),
				).rejects.toMatchObject({ code: "SCOPE_DENIED" });
			}
		};
		try {
			await denied();
			setComputerEnabled(configPath, true);
			await denied(); // Saved ON must not masquerade as applied ON.
			expect(run).not.toHaveBeenCalled(); // Saving ON never opens a portal/consent dialog.
			await runtime.close();
			runtime = createRuntime(configPath);
			expect(run).not.toHaveBeenCalled(); // Starting enabled also never opens a portal.
			await runtime.handlers.computer({ action: "open" }, "req_explicit_open");
			expect(run).toHaveBeenCalledTimes(1);
			setComputerEnabled(configPath, false);
			expect(
				(
					(await runtime.handlers.system_status({}, "req_pending_off")) as {
						backends: { computer: { configured: boolean } };
					}
				).backends.computer.configured,
			).toBe(true);
			await runtime.close();
			runtime = createRuntime(configPath);
			await denied();
			expect(
				(
					(await runtime.handlers.system_status({}, "req_applied_off")) as {
						backends: { computer: { state: string } };
					}
				).backends.computer.state,
			).toBe("disabled");
			expect(loadConfig(configPath)).toEqual(before); // Terminal/targets/policy unchanged.
		} finally {
			await runtime.close();
			run.mockRestore();
		}
	});

	it("reports effective state independently of saved state and fails unknown rather than claiming OFF", async () => {
		const { configPath } = adminProfiles.createAdminSnapshotProfile();
		writeDaemonPid(configPath);
		const inputs: unknown[] = [];
		const control = await startDaemonControlServer(
			configPath,
			() => {},
			async (input) => {
				inputs.push(input);
				return {
					structuredContent: {
						backends: {
							computer: {
								configured: true,
								state: "ready",
								session_id: "preserved",
							},
						},
					},
				};
			},
		);
		try {
			expect(buildAdminSnapshot(configPath).computer.configured).toBe(false);
			expect(await computerRuntimeState(configPath)).toMatchObject({
				enabled: true,
				state: "ready",
				session_id: "preserved",
			});
			expect(inputs).toEqual([{ action: "status" }]);
			await control.close();
			expect(await computerRuntimeState(configPath)).toMatchObject({
				enabled: null,
				state: "unknown",
			});
		} finally {
			removeDaemonPid(configPath);
		}
		expect(await computerRuntimeState(configPath)).toMatchObject({
			enabled: false,
			state: "stopped",
		});
	});

	it("reads only existing loopback system_status when a running older daemon lacks computer IPC", async () => {
		const { configPath } = adminProfiles.createAdminSnapshotProfile();
		writeDaemonPid(configPath);
		const control = await startDaemonControlServer(configPath, () => {});
		const fetchStatus = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					result: {
						structuredContent: {
							backends: {
								computer: {
									configured: true,
									state: "ready",
									session_id: "original",
								},
							},
						},
					},
				}),
			),
		);
		try {
			expect(await computerRuntimeState(configPath)).toMatchObject({
				enabled: true,
				session_id: "original",
			});
			expect(fetchStatus).toHaveBeenCalledTimes(1);
			const [url, options] = fetchStatus.mock.calls[0] ?? [];
			expect(url).toBe("http://127.0.0.1:39393/mcp");
			expect(JSON.parse(String(options?.body))).toMatchObject({
				method: "tools/call",
				params: { name: "system_status", arguments: {} },
			});
			fetchStatus.mockResolvedValue(new Response("", { status: 401 }));
			expect(await computerRuntimeState(configPath)).toMatchObject({
				enabled: null,
				state: "unknown",
			});
			const config = loadConfig(configPath);
			config.server.listen_host = "192.0.2.1";
			writeConfigAtomic(configPath, config);
			fetchStatus.mockClear();
			expect(await computerRuntimeState(configPath)).toMatchObject({
				enabled: null,
				state: "unknown",
			});
			expect(fetchStatus).not.toHaveBeenCalled();
		} finally {
			fetchStatus.mockRestore();
			await control.close();
			removeDaemonPid(configPath);
		}
	});

	it("runs Doctor without creating or migrating the durable state database", async () => {
		const { configPath, dataDir } = adminProfiles.createAdminSnapshotProfile();
		const statePath = join(dataDir, "state.db");
		expect(existsSync(statePath)).toBe(false);
		const report = await runDoctor(configPath);
		expect(
			report.checks.find((check) => check.name === "sqlite"),
		).toMatchObject({ status: "pass" });
		expect(existsSync(statePath)).toBe(false);
	});

	it("uses authenticated local IPC for graceful daemon shutdown requests", async () => {
		const { configPath } = adminProfiles.createAdminSnapshotProfile();
		let requested = false;
		const control = await startDaemonControlServer(configPath, () => {
			requested = true;
		});
		try {
			expect(await requestDaemonShutdown(configPath)).toEqual({
				ok: true,
				pid: process.pid,
			});
			await new Promise((resolve) => setImmediate(resolve));
			expect(requested).toBe(true);
		} finally {
			await control.close();
		}
		expect(await requestDaemonShutdown(configPath)).toBeNull();
	});

	it("refuses to signal a live PID that is not authenticated by the daemon control channel", async () => {
		const { configPath } = adminProfiles.createAdminSnapshotProfile();
		writeDaemonPid(configPath, process.pid);
		try {
			await expect(stopDaemon(configPath)).rejects.toThrow(
				/Refusing to signal pid/,
			);
			expect(() => process.kill(process.pid, 0)).not.toThrow();
		} finally {
			removeDaemonPid(configPath, process.pid);
		}
	});
});
