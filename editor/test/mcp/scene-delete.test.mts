import { describe, expect, test, vi } from "vitest";

import { removeSceneDirectory } from "../../src/mcp/scene/scene";

describe("mcp/scene delete", () => {
	test("retries transient directory races caused by watcher or generated-geometry writes", async () => {
		const remove = vi
			.fn<(path: string) => Promise<void>>()
			.mockRejectedValueOnce(Object.assign(new Error("directory not empty"), { code: "ENOTEMPTY" }))
			.mockRejectedValueOnce(Object.assign(new Error("resource busy"), { code: "EBUSY" }))
			.mockResolvedValueOnce();
		await expect(removeSceneDirectory("/project/assets/temp.scene", remove)).resolves.toBeUndefined();
		expect(remove).toHaveBeenCalledTimes(3);
	});

	test("does not hide non-transient deletion failures", async () => {
		const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
		await expect(removeSceneDirectory("/project/assets/temp.scene", vi.fn().mockRejectedValue(error))).rejects.toBe(error);
	});
});
