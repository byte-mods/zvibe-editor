import { describe, expect, it } from "vitest";

import { FBX_EXPORT_MODEL, getDefaultFbxExportSettings, normalizeFbxExportSettings } from "../../src/assets/fbx-export";

describe("FBX export contract", () => {
	it("normalizes a complete bounded export profile", () => {
		expect(FBX_EXPORT_MODEL).toBe("zvibe-fbx-export-v1");
		expect(normalizeFbxExportSettings({ axisForward: "X", axisUp: "Z", globalScale: 100, includeAnimations: false })).toMatchObject({
			axisForward: "X",
			axisUp: "Z",
			globalScale: 100,
			includeAnimations: false,
			embedTextures: true,
		});
		expect(getDefaultFbxExportSettings()).toMatchObject({ axisForward: "-Z", axisUp: "Y", addLeafBones: false, applyModifiers: true });
	});

	it("rejects unsafe axes, scalar bounds, and texture/material combinations", () => {
		expect(() => normalizeFbxExportSettings({ axisForward: "-Y", axisUp: "Y" })).toThrow(/different dimensions/i);
		expect(() => normalizeFbxExportSettings({ globalScale: 0 })).toThrow(/globalScale/i);
		expect(() => normalizeFbxExportSettings({ animationSamplingRate: Number.NaN })).toThrow(/animationSamplingRate/i);
		expect(() => normalizeFbxExportSettings({ includeMaterials: false, embedTextures: true })).toThrow(/includeMaterials=true/i);
		expect(() => normalizeFbxExportSettings({ includeLights: "yes" })).toThrow(/Boolean/i);
	});
});
