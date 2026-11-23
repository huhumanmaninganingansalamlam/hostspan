import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDesktopApplication } from "../../src/desktop/bootstrap.js";
import { prepareDesktopEnvironment } from "../../src/desktop/environment.js";
import { prepareDesktopConfig } from "../../src/desktop/first-run.js";

const fakeElectron = vi.hoisted(() => ({
	quit: vi.fn(),
	showErrorBox: vi.fn(),
	getPath: vi.fn(() => "/tmp/hostspan-test-user"),
	getLoginItemSettings: vi.fn(() => ({ wasOpenedAtLogin: false })),
}));
vi.mock("electron", () => ({
	app: { ...fakeElectron, dock: { hide: vi.fn() } },
	dialog: { showErrorBox: fakeElectron.showErrorBox },
}));
vi.mock("../../src/desktop/first-run.js", () => ({
	prepareDesktopConfig: vi.fn(() => "/tmp/hostspan-test-profile"),
}));
vi.mock("../../src/desktop/environment.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../src/desktop/environment.js")>();
	return { ...actual, prepareDesktopEnvironment: vi.fn() };
});

const originalArgv = [...process.argv];
beforeEach(() => {
	vi.clearAllMocks();
	process.argv = [...originalArgv];
});
afterEach(() => {
	process.argv = [...originalArgv];
});

describe.skipIf(process.platform !== "linux")(
	"desktop login bootstrap order",
	() => {
		it("prepares environment and profile before tray and never starts daemon at manual launch", async () => {
			const order: string[] = [];
			vi.mocked(prepareDesktopEnvironment).mockImplementation(() => {
				order.push("environment");
			});
			vi.mocked(prepareDesktopConfig).mockImplementation(() => {
				order.push("profile");
				return "/tmp/hostspan-test-profile";
			});
			const daemonAction = vi.fn(async () => ({ running: true }));
			const refreshUi = vi.fn(async () => {
				order.push("refresh");
			});
			await startDesktopApplication({
				setConfigPath: (path) => {
					expect(path).toBe("/tmp/hostspan-test-profile");
					order.push("config");
				},
				refreshLinuxAutoStart: () => order.push("autostart"),
				startTray: () => order.push("tray"),
				daemonAction: daemonAction as never,
				refreshUi,
				scheduleStatusRefresh: () => order.push("schedule"),
			});
			expect(order).toEqual([
				"environment",
				"profile",
				"config",
				"autostart",
				"tray",
				"refresh",
				"schedule",
			]);
			expect(daemonAction).not.toHaveBeenCalled();
			expect(fakeElectron.showErrorBox).not.toHaveBeenCalled();
		});

		it("starts daemon only on explicitly marked login after tray creation", async () => {
			process.argv.push("--hostspan-login");
			const order: string[] = [];
			const daemonAction = vi.fn(async () => {
				order.push("daemon");
				return { running: true };
			});
			const refreshUi = vi.fn(async () => {
				order.push("refresh");
			});
			await startDesktopApplication({
				setConfigPath: () => order.push("config"),
				refreshLinuxAutoStart: () => order.push("autostart"),
				startTray: () => order.push("tray"),
				daemonAction: daemonAction as never,
				refreshUi,
				scheduleStatusRefresh: () => order.push("schedule"),
			});
			await Promise.resolve();
			expect(order.indexOf("daemon")).toBeGreaterThan(order.indexOf("tray"));
			expect(daemonAction).toHaveBeenCalledOnce();
			expect(daemonAction).toHaveBeenCalledWith("start", 5_000);
			expect(fakeElectron.showErrorBox).not.toHaveBeenCalled();
		});
	},
);
