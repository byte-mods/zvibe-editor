import { describe, expect, test, vi } from "vitest";

const { execNodePty } = vi.hoisted(() => ({
	execNodePty: vi.fn(),
}));

vi.mock("../../src/tools/node-pty", () => ({
	execNodePty,
}));

import { openInExternalEditor } from "../../src/tools/external-editor";

describe("tools/external-editor", () => {
	test("rejects an empty configured command", async () => {
		await expect(openInExternalEditor("  ", "/project/src/scripts.ts")).rejects.toThrow("Configure an external editor command");
		expect(execNodePty).not.toHaveBeenCalled();
	});

	test("rejects shell operators in the configured command", async () => {
		await expect(openInExternalEditor("code; rm -rf /", "/project/src/scripts.ts")).rejects.toThrow("single executable");
		expect(execNodePty).not.toHaveBeenCalled();
	});
});
