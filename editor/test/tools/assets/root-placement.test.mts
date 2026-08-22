import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, remove, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";

import { assetRootPlacementError, inspectAssetRootPlacement, isInsideAssetRoot } from "../../../src/tools/assets/root-placement";

describe("asset root placement", () => {
	const directories: string[] = [];

	afterEach(async () => {
		await Promise.all(directories.splice(0).map((directory) => remove(directory)));
	});

	async function fixture(): Promise<string> {
		const directory = await mkdtemp(join(tmpdir(), "zvibe-asset-root-"));
		directories.push(directory);
		await mkdir(join(directory, "project/assets"), { recursive: true });
		await mkdir(join(directory, "source/nested"), { recursive: true });
		return directory;
	}

	it("uses path-segment containment instead of a vulnerable prefix check", async () => {
		const directory = await fixture();
		const assetsRoot = join(directory, "project/assets");
		expect(isInsideAssetRoot(join(directory, "project/assets/ui"), assetsRoot)).toBe(true);
		expect(isInsideAssetRoot(join(directory, "project/assets-copy"), assetsRoot)).toBe(false);
	});

	it("blocks every typed asset but permits generic project JSON outside assets", async () => {
		const directory = await fixture();
		const assetsRoot = join(directory, "project/assets");
		const source = join(directory, "source/input.bin");
		await writeFile(source, "fixture");
		expect(await inspectAssetRootPlacement(source, join(directory, "project/hero.PSD"), assetsRoot)).toMatchObject({ allowed: false, reason: "required-extension" });
		expect(await inspectAssetRootPlacement(source, join(directory, "project/settings.json"), assetsRoot)).toMatchObject({ allowed: true, reason: "no-required-assets" });
		expect(await inspectAssetRootPlacement(source, join(directory, "project/assets/hero.psd"), assetsRoot)).toMatchObject({ allowed: true, reason: "inside-assets" });
	});

	it("recursively detects nested typed assets and fails closed at the scan limit", async () => {
		const directory = await fixture();
		const assetsRoot = join(directory, "project/assets");
		await writeFile(join(directory, "source/nested/model.onnx"), "model");
		const blocked = await inspectAssetRootPlacement(join(directory, "source"), join(directory, "project/imported"), assetsRoot);
		expect(blocked).toMatchObject({ allowed: false, reason: "required-extension", requiredAssetPath: join(directory, "project/imported/nested/model.onnx") });
		expect(assetRootPlacementError(blocked)).toContain("must be imported under");
		const limited = await inspectAssetRootPlacement(join(directory, "source"), join(directory, "project/imported"), assetsRoot, { maximumEntries: 1 });
		expect(limited).toMatchObject({ allowed: false, reason: "scan-limit" });
		expect(assetRootPlacementError(limited)).toContain("safety limit");
	});
});
