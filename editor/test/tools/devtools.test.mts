import { describe, expect, test } from "vitest";

import { shouldAutoOpenDevTools } from "../../src/tools/devtools";

describe("tools/devtools", () => {
	test("does not auto-open DevTools merely because an unpackaged build is in development mode", () => {
		expect(shouldAutoOpenDevTools({ DEBUG: "true" })).toBe(false);
	});

	test("requires both development mode and the explicit auto-open switch", () => {
		expect(shouldAutoOpenDevTools({ AUTO_OPEN_DEVTOOLS: "true" })).toBe(false);
		expect(shouldAutoOpenDevTools({ DEBUG: "false", AUTO_OPEN_DEVTOOLS: "true" })).toBe(false);
		expect(shouldAutoOpenDevTools({ DEBUG: "true", AUTO_OPEN_DEVTOOLS: "false" })).toBe(false);
		expect(shouldAutoOpenDevTools({ DEBUG: "true", AUTO_OPEN_DEVTOOLS: "true" })).toBe(true);
	});
});
