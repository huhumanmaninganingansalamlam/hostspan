import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	addLocalWorkspace,
	removeLocalWorkspace,
} from "../../src/admin/snapshot.js";
import { loadConfig } from "../../src/config/loader.js";
import { AdminSnapshotTestContext } from "../helpers/admin-snapshot-fixture.js";

const adminProfiles = new AdminSnapshotTestContext();

afterEach(() => {
	adminProfiles.dispose();
});

describe("admin snapshot target configuration", () => {
	it("adds a local workspace with explicit capabilities and removes it safely", () => {
		const { root, configPath } = adminProfiles.createAdminSnapshotProfile();
		const workspace = join(root, "another-workspace");
		mkdirSync(workspace, { recursive: true });

		const originalProfiles = loadConfig(configPath).exec_profiles;
		const added = addLocalWorkspace(configPath, {
			target_id: "another-workspace",
			label: "Another workspace",
			root: workspace,
			capabilities: ["read", "terminal"],
		});
		expect(added).toMatchObject({
			ok: true,
			target_id: "another-workspace",
			capabilities: ["read", "terminal"],
			restart_required: true,
		});

		const afterAdd = loadConfig(configPath);
		expect(afterAdd.targets["another-workspace"]).toMatchObject({
			label: "Another workspace",
			capabilities: ["read", "terminal"],
		});
		expect(afterAdd.targets["another-workspace"]).not.toHaveProperty(
			"exec_profile",
		);
		expect(afterAdd.targets.local?.exec_profile).toBe("native");
		expect(afterAdd.exec_profiles).toEqual(originalProfiles);

		const removed = removeLocalWorkspace(configPath, "another-workspace");
		expect(removed).toMatchObject({
			ok: true,
			target_id: "another-workspace",
			restart_required: true,
		});
		expect(loadConfig(configPath).targets["another-workspace"]).toBeUndefined();
	});

	it("preserves an explicitly selected exec profile", () => {
		const { root, configPath } = adminProfiles.createAdminSnapshotProfile();
		const workspace = join(root, "restricted-workspace");
		mkdirSync(workspace, { recursive: true });

		addLocalWorkspace(configPath, {
			target_id: "restricted-workspace",
			root: workspace,
			capabilities: ["read", "exec"],
			exec_profile: "native",
		});
		const config = loadConfig(configPath);
		expect(config.targets["restricted-workspace"]?.exec_profile).toBe("native");
		expect(Object.keys(config.exec_profiles)).toEqual(["native"]);
	});

	it("derives target id and label from the folder and avoids id collisions", () => {
		const { root, configPath } = adminProfiles.createAdminSnapshotProfile();
		const first = join(root, "My Project");
		const secondParent = join(root, "nested");
		const second = join(secondParent, "My Project");
		mkdirSync(first, { recursive: true });
		mkdirSync(second, { recursive: true });

		const addedFirst = addLocalWorkspace(configPath, {
			root: first,
			capabilities: ["read", "write", "exec", "terminal"],
		});
		expect(addedFirst).toMatchObject({ target_id: "my-project" });
		expect(loadConfig(configPath).targets["my-project"]).toMatchObject({
			label: "My Project",
			capabilities: ["read", "write", "exec", "terminal"],
		});

		const addedSecond = addLocalWorkspace(configPath, {
			root: second,
			capabilities: ["read"],
		});
		expect(addedSecond).toMatchObject({ target_id: "my-project-2" });
		expect(loadConfig(configPath).targets["my-project-2"]?.label).toBe(
			"My Project",
		);
	});

	it("rejects duplicate roots and invalid target ids", () => {
		const { root, targetRoot, configPath } =
			adminProfiles.createAdminSnapshotProfile();
		expect(() =>
			addLocalWorkspace(configPath, {
				target_id: "duplicate",
				root: targetRoot,
				capabilities: ["read"],
			}),
		).toThrow(/already registered/);

		const unused = join(root, "unused");
		mkdirSync(unused, { recursive: true });
		expect(() =>
			addLocalWorkspace(configPath, {
				target_id: "Bad ID",
				root: unused,
				capabilities: ["read"],
			}),
		).toThrow(/target_id/);
	});
});
