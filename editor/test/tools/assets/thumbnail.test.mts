import { beforeEach, describe, expect, test, vi } from "vitest";

const terminate = vi.fn();
const worker = { terminate } as unknown as Worker;

vi.mock("../../../src/tools/worker", () => ({
	loadWorker: vi.fn(() => worker),
	executeSimpleWorker: vi.fn(() => new Promise(() => undefined)),
}));

import { cancelAssetThumbnailTasks, getAssetThumbnailBase64 } from "../../../src/tools/assets/thumbnail";

describe("asset thumbnail cancellation", () => {
	beforeEach(() => {
		terminate.mockClear();
	});

	test("terminates and resolves an in-flight worker before recursive asset deletion", async () => {
		const absolutePath = "/tmp/project/assets/owned/material.material";
		const pending = getAssetThumbnailBase64(absolutePath, {
			type: "material",
			rootUrl: "/tmp/project/",
			appPath: null,
		});

		expect(cancelAssetThumbnailTasks("/tmp/project/assets/owned", true)).toBe(1);
		await expect(pending).resolves.toBe("");
		expect(terminate).toHaveBeenCalledOnce();
		expect(cancelAssetThumbnailTasks("/tmp/project/assets/owned", true)).toBe(0);
	});
});
