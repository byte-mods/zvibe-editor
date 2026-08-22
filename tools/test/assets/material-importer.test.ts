import { describe, expect, test } from "vitest";

import {
	classifyMaterialTextureReference,
	collectBabylonMaterialTextureCandidates,
	collectMtlTextureCandidates,
	groupMaterialTextureCandidates,
	normalizeMaterialImporterSettings,
	resolveBabylonMaterialTextureReferencesForLoading,
} from "../../src/assets/material-importer";

describe("material importer", () => {
	test("collects Babylon texture objects and classifies project, embedded, and remote references", () => {
		const data = {
			albedoTexture: { name: "assets/albedo.png", url: "assets/albedo.png", coordinatesMode: 0 },
			bumpTexture: { name: "normal.png", samplingMode: 3 },
			emissiveTexture: { name: "embedded-emissive.png", url: "", base64String: "data:image/png;base64,BBBB", samplingMode: 3 },
			blocks: [{ texture: { name: "data:image/png;base64,AAAA", isCube: false } }, { texture: { url: "https://example.com/remote.png" } }],
		};
		const candidates = collectBabylonMaterialTextureCandidates(data);
		expect(candidates.map((candidate) => candidate.value)).toEqual(
			expect.arrayContaining(["assets/albedo.png", "normal.png", "data:image/png;base64,AAAA", "data:image/png;base64,BBBB", "https://example.com/remote.png"])
		);
		const exists = new Map([
			["assets/albedo.png", true],
			["assets/materials/normal.png", false],
		]);
		const references = groupMaterialTextureCandidates("assets/materials/game.material", candidates, exists);
		expect(references).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "project", resolvedPath: "assets/albedo.png", exists: true }),
				expect.objectContaining({ kind: "project", resolvedPath: "assets/materials/normal.png", exists: false }),
				expect.objectContaining({ kind: "embedded", exists: null }),
				expect.objectContaining({ kind: "remote", exists: null }),
			])
		);
		candidates.find((candidate) => candidate.value.endsWith("AAAA"))!.setValue!("assets/extracted.png");
		expect(data.blocks[0].texture).toMatchObject({ name: "assets/extracted.png", url: "assets/extracted.png" });
		const base64Candidate = candidates.find((candidate) => candidate.value.endsWith("BBBB"))!;
		expect(base64Candidate.suggestedName).toBe("embedded-emissive.png");
		base64Candidate.setValue!("assets/emissive.png");
		expect(data.emissiveTexture).toEqual(expect.objectContaining({ name: "assets/emissive.png", url: "assets/emissive.png" }));
		expect(data.emissiveTexture).not.toHaveProperty("base64String");
	});

	test("parses Wavefront map directives and validates path containment", () => {
		const candidates = collectMtlTextureCandidates('newmtl Body\nmap_Kd -s 1 1 1 "textures/body albedo.png"\nmap_Bump -bm 0.5 normal.png\n');
		expect(candidates).toEqual([
			{ value: "textures/body albedo.png", location: "line 2" },
			{ value: "normal.png", location: "line 3" },
		]);
		expect(classifyMaterialTextureReference("assets/car/materials/body.mtl", "normal.png")).toEqual({
			kind: "project",
			resolvedPath: "assets/car/materials/normal.png",
		});
		expect(classifyMaterialTextureReference("assets/car/body.mtl", "../../../secret.png")).toEqual({ kind: "project", resolvedPath: null });
		expect(groupMaterialTextureCandidates("assets/car/body.mtl", [{ value: "../../../secret.png", location: "line 1" }], new Map())).toMatchObject([
			{ value: "../../../secret.png", kind: "project", resolvedPath: null, exists: false },
		]);
		expect(normalizeMaterialImporterSettings({ validateTextures: true, extractEmbeddedTextures: false, compileNodeMaterial: true })).toEqual({
			validateTextures: true,
			extractEmbeddedTextures: false,
			compileNodeMaterial: true,
		});
	});

	test("resolves project texture references before Babylon material loading", () => {
		const data = {
			albedoTexture: { name: "assets/shared/albedo.png", coordinatesMode: 0 },
			bumpTexture: { name: "normal.png", samplingMode: 3 },
			emissiveTexture: { name: "data:image/png;base64,AAAA", samplingMode: 3 },
			reflectionTexture: { url: "https://example.com/environment.png" },
		};
		expect(resolveBabylonMaterialTextureReferencesForLoading("assets/materials/body.material", data, "/project")).toEqual([
			"/project/assets/materials/normal.png",
			"/project/assets/shared/albedo.png",
		]);
		expect(data.albedoTexture.name).toBe("/project/assets/shared/albedo.png");
		expect(data.bumpTexture.name).toBe("/project/assets/materials/normal.png");
		expect(data.emissiveTexture.name).toBe("data:image/png;base64,AAAA");
		expect(data.reflectionTexture.url).toBe("https://example.com/environment.png");
	});
});
