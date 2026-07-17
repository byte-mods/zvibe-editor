import { Component } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { pathExists, sharp, toastError, toastSuccess, toBuffer, writeFile } = vi.hoisted(() => ({
	pathExists: vi.fn(),
	sharp: vi.fn(),
	toastError: vi.fn(),
	toastSuccess: vi.fn(),
	toBuffer: vi.fn(),
	writeFile: vi.fn(),
}));

vi.mock("fs-extra", () => ({
	pathExists,
	writeFile,
}));

vi.mock("sharp", () => ({
	default: sharp,
}));

vi.mock("sonner", () => ({
	toast: { error: toastError, success: toastSuccess },
}));

vi.mock("../../src/editor/layout/assets-browser/items/item", () => ({
	AssetsBrowserItem: class extends Component<any, any> {
		public async componentDidMount(): Promise<void> {}
		public forceUpdate(): void {}
	},
}));

vi.mock("../../src/mcp/assets/assets", () => ({
	convertImageAsset: vi.fn(),
}));

vi.mock("../../src/project/configuration", () => ({
	projectConfiguration: { path: null },
}));

import { AssetBrowserImageItem } from "../../src/editor/layout/assets-browser/items/image-item";

describe("editor/assets-browser/image-item", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		pathExists.mockResolvedValue(true);
		toBuffer.mockRejectedValue(new Error("Input file contains unsupported image format"));
		sharp.mockReturnValue({
			resize: () => ({ toBuffer }),
		});
	});

	test("invalid image content uses a stable fallback without rejecting the mount lifecycle", async () => {
		const item = new AssetBrowserImageItem({
			absolutePath: "/project/assets/not-really-an-image.png",
		} as any);

		await expect(item.componentDidMount()).resolves.toBeUndefined();

		expect(sharp).toHaveBeenCalledWith("/project/assets/not-really-an-image.png");
		expect((item as any)._thumbnailError).toBe(true);
		expect((item as any)._thumbnailPath).toBeNull();
		expect((item as any)._availableResizes).toEqual([]);
	});

	test("invalid image content cannot reject or block valid files in a multi-image resize", async () => {
		const resized = Buffer.from("resized");
		sharp.mockImplementation((path: string) => {
			if (path.endsWith("invalid.png")) {
				return { metadata: () => Promise.reject(new Error("Input file contains unsupported image format")) };
			}
			return {
				metadata: () => Promise.resolve({ width: 128, height: 128 }),
				resize: () => ({ toBuffer: () => Promise.resolve(resized) }),
			};
		});
		const forceUpdate = vi.fn();
		const item = new AssetBrowserImageItem({
			absolutePath: "/project/assets/valid.png",
			editor: { layout: { assets: { state: { selectedKeys: ["/project/assets/valid.png", "/project/assets/invalid.png"] }, forceUpdate } } },
		} as any);

		await expect((item as any)._handleResize(64, 64)).resolves.toBeUndefined();

		expect(writeFile).toHaveBeenCalledWith("/project/assets/valid.png", resized);
		expect(forceUpdate).toHaveBeenCalledOnce();
		expect(toastSuccess).toHaveBeenCalledWith("1 image resized successfully.");
		expect(toastError).toHaveBeenCalledWith("1 image could not be decoded and was skipped.");
	});
});
