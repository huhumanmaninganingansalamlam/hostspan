import { describe, expect, it } from "vitest";
import { trayMenuStateKey, type TrayMenuSnapshot } from "../../src/desktop/tray-menu-state.js";

function snapshot(): TrayMenuSnapshot {
  return {
    daemon: { running: true },
    auto_start: true,
    targets: [{}, {}],
  };
}

describe("tray menu state", () => {
  it("keeps the same key while stable menu state is unchanged", () => {
    expect(trayMenuStateKey(snapshot())).toBe(trayMenuStateKey(snapshot()));
  });

  it("changes the key when actionable menu state changes", () => {
    const base = snapshot();

    expect(trayMenuStateKey({ ...snapshot(), daemon: { running: false } })).not.toBe(trayMenuStateKey(base));
    expect(trayMenuStateKey({ ...snapshot(), auto_start: false })).not.toBe(trayMenuStateKey(base));
    expect(trayMenuStateKey({ ...snapshot(), targets: [{}, {}, {}] })).not.toBe(trayMenuStateKey(base));
  });
});
