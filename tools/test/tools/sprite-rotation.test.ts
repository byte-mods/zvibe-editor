import { describe, expect, test } from "vitest";

import { configureRotatedPackedSpriteManager, installRotatedPackedSpriteShaders } from "../../src/tools/sprite";

describe("rotated packed sprite runtime", () => {
	test("installs GLSL/WGSL UV rotation and marks only rotated cells", () => {
		const shaderStore: { ShadersStore: Record<string, string>; ShadersStoreWGSL: Record<string, string> } = { ShadersStore: {}, ShadersStoreWGSL: {} };
		installRotatedPackedSpriteShaders(shaderStore);
		expect(shaderStore.ShadersStore.spritesVertexShader).toContain("babylonEditorPackedRotation");
		expect(shaderStore.ShadersStoreWGSL.spritesVertexShader).toContain("babylonEditorPackedRotation");

		const manager = {
			_customUpdate(sprite: any): void {
				sprite._xSize = 5;
				sprite._ySize = 3;
			},
		};
		configureRotatedPackedSpriteManager(manager as any, {
			frames: {
				hero: { frame: { w: 5, h: 3 }, rotated: true },
				enemy: { frame: { w: 7, h: 2 }, rotated: false },
			},
		});
		const rotated = { cellRef: "hero" } as any;
		(manager as any)._customUpdate(rotated, { width: 16, height: 8 });
		expect(rotated).toMatchObject({ _xSize: -5, _ySize: 3 });
		const plain = { cellRef: "enemy" } as any;
		(manager as any)._customUpdate(plain, { width: 16, height: 8 });
		expect(plain).toMatchObject({ _xSize: 5, _ySize: 3 });
	});
});
