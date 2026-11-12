import { describe, expect, it, vi } from "vitest";
import { acquireDesktopPrimaryInstance } from "../../src/desktop/single-instance.js";

describe("desktop single-instance ownership", () => {
  it("allows startup only after acquiring the instance lock", () => {
    const app = { requestSingleInstanceLock: vi.fn(() => true), quit: vi.fn() };

    expect(acquireDesktopPrimaryInstance(app)).toBe(true);
    expect(app.requestSingleInstanceLock).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it("requests quit and denies startup for a rejected second instance", () => {
    const app = { requestSingleInstanceLock: vi.fn(() => false), quit: vi.fn() };

    expect(acquireDesktopPrimaryInstance(app)).toBe(false);
    expect(app.requestSingleInstanceLock).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
  });
});
