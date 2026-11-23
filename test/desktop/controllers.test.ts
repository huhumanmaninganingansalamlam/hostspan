import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, MenuItem } from "electron";

const mockedElectron = vi.hoisted(() => {
	const handlers = new Map<
		string,
		(event: unknown, ...args: unknown[]) => unknown
	>();
	const menuSnapshots: unknown[] = [];
	const tooltips: string[] = [];
	return {
		handlers,
		menuSnapshots,
		tooltips,
		destroyed: vi.fn(),
		showErrorBox: vi.fn(),
		clipboardWrite: vi.fn(),
	};
});

vi.mock("electron", () => ({
	app: {
		quit: vi.fn(),
		getPath: vi.fn(),
		getLoginItemSettings: vi.fn(),
		setLoginItemSettings: vi.fn(),
	},
	ipcMain: {
		handle: vi.fn(
			(
				name: string,
				handler: (event: unknown, ...args: unknown[]) => unknown,
			) => {
				if (mockedElectron.handlers.has(name))
					throw new Error("duplicate desktop IPC handler");
				mockedElectron.handlers.set(name, handler);
			},
		),
		removeHandler: vi.fn((name: string) =>
			mockedElectron.handlers.delete(name),
		),
	},
	clipboard: { writeText: mockedElectron.clipboardWrite },
	dialog: { showErrorBox: mockedElectron.showErrorBox },
	Menu: {
		buildFromTemplate: vi.fn((template: unknown) => {
			mockedElectron.menuSnapshots.push(template);
			return template;
		}),
	},
	nativeTheme: { shouldUseDarkColorsForSystemIntegratedUI: false, on: vi.fn() },
	nativeImage: {
		createFromPath: vi.fn(() => ({
			isEmpty: () => false,
			setTemplateImage: vi.fn(),
		})),
	},
	Tray: class {
		on = vi.fn();
		setToolTip = vi.fn((value: string) => mockedElectron.tooltips.push(value));
		setContextMenu = vi.fn();
		setImage = vi.fn();
		destroy = mockedElectron.destroyed;
	},
}));

import {
	buildTrayMenuTemplate,
	createTrayController,
} from "../../src/desktop/tray-controller.js";
import { registerDashboardIpcHandlers } from "../../src/desktop/ipc-handlers.js";
import type { DesktopSnapshot } from "../../src/desktop/daemon-controller.js";

function fakeSnapshot(running: boolean, autoStart = false): DesktopSnapshot {
	return {
		daemon: { running },
		targets: [{ target_id: "local" }, { target_id: "other" }],
		auto_start: autoStart,
	} as DesktopSnapshot;
}

beforeEach(() => {
	mockedElectron.handlers.clear();
	mockedElectron.menuSnapshots.length = 0;
	mockedElectron.tooltips.length = 0;
	vi.clearAllMocks();
});

describe("desktop controllers", () => {
	it("builds the same pure tray actions from daemon and login state", () => {
		const actions = {
			openDashboard: vi.fn(),
			runDaemon: vi.fn(),
			restart: vi.fn(),
			setAutoStart: vi.fn(),
			quit: vi.fn(),
		};
		const stopped = buildTrayMenuTemplate(fakeSnapshot(false, false), actions);
		expect(stopped.map((item) => item.label)).toContain("Start HostSpan");
		expect(
			stopped.find((item) => item.label === "Restart HostSpan")?.enabled,
		).toBe(false);
		expect(
			stopped.find((item) => item.label === "Start at login")?.checked,
		).toBe(false);
		const started = buildTrayMenuTemplate(fakeSnapshot(true, true), actions);
		expect(started.map((item) => item.label)).toContain("Stop HostSpan");
		expect(
			started.find((item) => item.label === "Restart HostSpan")?.enabled,
		).toBe(true);
		expect(
			started.find((item) => item.label === "Start at login")?.checked,
		).toBe(true);
		expect(started.find((item) => item.label === "Targets: 2")).toMatchObject({
			enabled: false,
		});
		const stop = started.find((item) => item.label === "Stop HostSpan");
		stop?.click?.({} as MenuItem, {} as BrowserWindow, {} as KeyboardEvent);
		expect(actions.runDaemon).toHaveBeenCalledExactlyOnceWith("stop");
		const login = started.find((item) => item.label === "Start at login");
		login?.click?.(
			{ checked: false } as MenuItem,
			{} as BrowserWindow,
			{} as KeyboardEvent,
		);
		expect(actions.setAutoStart).toHaveBeenCalledExactlyOnceWith(false);
	});

	it("does not poll an idle tray and closes owned resources without stopping the daemon", async () => {
		vi.useFakeTimers();
		const snapshot = vi.fn(async () => fakeSnapshot(false));
		const daemonAction = vi.fn(async () => ({ running: false }));
		const controller = createTrayController({
			iconDir: "/tmp/hostspan-icons",
			snapshot: snapshot as never,
			daemonAction: daemonAction as never,
			restartDaemonWithConfirmation: vi.fn() as never,
			getWindow: () => undefined,
			createWindow: vi.fn() as never,
			setAutoStart: vi.fn(),
			isQuitting: () => false,
			quit: vi.fn(),
		});
		try {
			controller.startTray();
			await controller.refreshUi();
			controller.scheduleStatusRefresh();
			expect(mockedElectron.tooltips).toEqual(["HostSpan stopped"]);
			expect(mockedElectron.menuSnapshots).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(20_000);
			expect(snapshot).toHaveBeenCalledTimes(1);
		} finally {
			controller.dispose();
			vi.useRealTimers();
		}
		expect(mockedElectron.destroyed).toHaveBeenCalledOnce();
		expect(daemonAction).not.toHaveBeenCalled();
	});

	it("registers exactly 11 trusted IPC handlers and removes them on dispose", async () => {
		const contents = { mainFrame: {} };
		const dashboardWindow = {
			isDestroyed: () => false,
			webContents: contents,
		} as unknown as BrowserWindow;
		const daemonAction = vi.fn(async () => ({ running: true }));
		const snapshot = vi.fn(async () => fakeSnapshot(true));
		const refreshUi = vi.fn(async () => undefined);
		const dispose = registerDashboardIpcHandlers({
			getWindow: () => dashboardWindow,
			getConfigPath: () => "/tmp/hostspan-test-config",
			snapshot: snapshot as never,
			daemonAction: daemonAction as never,
			restartDaemonWithConfirmation: vi.fn() as never,
			doctorReport: vi.fn() as never,
			refreshUi,
			getAutoStart: () => false,
			setAutoStart: vi.fn(),
			openAttach: vi.fn(),
		});
		try {
			expect(mockedElectron.handlers.size).toBe(11);
			const invalidSender = { sender: {}, senderFrame: contents.mainFrame };
			await expect(
				mockedElectron.handlers.get("hostspan:daemon")?.(
					invalidSender,
					"start",
				),
			).rejects.toThrow(/untrusted renderer/);
			expect(daemonAction).not.toHaveBeenCalled();
			const trusted = { sender: contents, senderFrame: contents.mainFrame };
			expect(
				await mockedElectron.handlers.get("hostspan:snapshot")?.(trusted),
			).toMatchObject({
				daemon: { running: true },
			});
			expect(
				await mockedElectron.handlers.get("hostspan:daemon")?.(
					trusted,
					"start",
				),
			).toMatchObject({
				running: true,
			});
			expect(daemonAction).toHaveBeenCalledExactlyOnceWith("start");
			expect(refreshUi).toHaveBeenCalledOnce();
			expect(() =>
				registerDashboardIpcHandlers({
					getWindow: () => dashboardWindow,
					getConfigPath: () => "/tmp/hostspan-test-config",
					snapshot: snapshot as never,
					daemonAction: daemonAction as never,
					restartDaemonWithConfirmation: vi.fn() as never,
					doctorReport: vi.fn() as never,
					refreshUi,
					getAutoStart: () => false,
					setAutoStart: vi.fn(),
					openAttach: vi.fn(),
				}),
			).toThrow(/duplicate desktop IPC/);
		} finally {
			dispose();
		}
		expect(mockedElectron.handlers.size).toBe(0);
	});
});
