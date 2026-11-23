import { describe, expect, it } from "vitest";
import { withTransientSegmentReadRetry } from "../../src/processes/output-spool-store.mjs";

describe("Windows spool segment read sharing violations", () => {
	it("retries transient Windows access errors without masking missing files or Unix failures", () => {
		for (const code of ["EPERM", "EBUSY", "EACCES"]) {
			let attempts = 0;
			const result = withTransientSegmentReadRetry(() => {
				attempts += 1;
				if (attempts === 1)
					throw Object.assign(new Error("transient lock"), { code });
				return 7;
			}, "win32");
			expect(result).toBe(7);
			expect(attempts).toBe(2);
		}
		let missing = 0;
		expect(() =>
			withTransientSegmentReadRetry(() => {
				missing += 1;
				throw Object.assign(new Error("missing segment"), { code: "ENOENT" });
			}, "win32"),
		).toThrow("missing segment");
		expect(missing).toBe(1);
		let unix = 0;
		expect(() =>
			withTransientSegmentReadRetry(() => {
				unix += 1;
				throw Object.assign(new Error("denied"), { code: "EPERM" });
			}, "linux"),
		).toThrow("denied");
		expect(unix).toBe(1);
	});
});
