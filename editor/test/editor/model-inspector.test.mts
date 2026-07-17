import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { emptyExecutedModelImport, IModelImporterResult, normalizeModelImporterSettings } from "babylonjs-editor-tools";

import { EditorInspectorModelComponent } from "../../src/editor/layout/inspector/file/model";
import { IModelImporterArtifactStatus } from "../../src/mcp/assets/model-importer";

describe("editor/model-inspector", () => {
	test("renders cached generated LOD evidence created before deformation fields existed", () => {
		const settings = normalizeModelImporterSettings({ generatedLods: [{ quality: 0.5, distance: 500 }] });
		const result: IModelImporterResult = {
			...emptyExecutedModelImport(settings),
			baseSettings: settings,
			platform: "default",
			platformOverrideApplied: false,
			sourcePath: "assets/legacy.babylon",
			outputPath: "assets/legacy.babylon",
			sourceFormat: "babylon",
			sourceBytes: 1,
			supported: true,
			embeddedResourceCount: 0,
			dependencyPaths: [],
			legacyConversion: null,
			valid: true,
			generatedLods: [
				{
					sourceMesh: "Legacy Character",
					sourceVertexCount: 100,
					sourceTriangleCount: 50,
					levels: [
						{
							quality: 0.5,
							distance: 500,
							level: 1,
							meshName: "Legacy Character_LOD1",
							vertexCount: 50,
							triangleCount: 20,
							reduction: 0.6,
						},
					],
				} as IModelImporterResult["generatedLods"][number],
			],
			lodSourceMeshCount: 1,
			generatedLodMeshCount: 1,
		};
		const artifact: IModelImporterArtifactStatus = {
			path: "/project/assets/legacy.babylon",
			artifactDirectory: "/project/.babylonjs-editor/imported/legacy",
			manifestPath: "/project/.babylonjs-editor/imported/legacy/import.json",
			fingerprint: "legacy",
			current: true,
			exists: true,
			result,
		};

		const markup = renderToStaticMarkup(
			createElement(EditorInspectorModelComponent, {
				artifact,
				settings: { authoredLods: "{", generatedLods: JSON.stringify(settings.generatedLods) },
				onAnimationClipsChange: () => undefined,
				onMaterialRemapsChange: () => undefined,
				onAuthoredLodsChange: () => undefined,
				onGeneratedLodsChange: () => undefined,
				onPlatformOverridesChange: () => undefined,
				onExtractMaterials: async () => "",
				onExtractTextures: async () => "",
			})
		);

		expect(markup).toContain("Legacy Character");
		expect(markup).toContain("static (legacy evidence)");
		expect(markup).toContain("50 mapped vertices");
		expect(markup).toContain("0 preserved stream(s)");
		expect(markup).toContain("Authored LOD groups must be valid JSON");
	});

	test("renders artist-authored LOD controls, suffix detection, and applied evidence", () => {
		const authoredLods = [{ sourceMesh: "Tree_LOD0", levels: [{ mesh: "Tree_LOD1", distance: 500 }] }];
		const settings = normalizeModelImporterSettings({ authoredLods });
		const mesh = (name: string, triangleCount: number): IModelImporterResult["meshes"][number] => ({
			name,
			vertexCount: triangleCount * 2,
			indexCount: triangleCount * 3,
			triangleCount,
			hasNormals: true,
			hasTangents: true,
			hasUVs: true,
			skinned: false,
			morphTargetCount: 0,
			collider: false,
			welded: false,
			optimized: false,
			quantized: false,
		});
		const result: IModelImporterResult = {
			...emptyExecutedModelImport(settings),
			baseSettings: settings,
			platform: "default",
			platformOverrideApplied: false,
			sourcePath: "assets/tree.babylon",
			outputPath: "assets/tree.babylon",
			sourceFormat: "babylon",
			sourceBytes: 1,
			supported: true,
			embeddedResourceCount: 0,
			dependencyPaths: [],
			legacyConversion: null,
			valid: true,
			meshes: [mesh("Tree_LOD0", 100), mesh("Tree_LOD1", 30)],
			authoredLods: [
				{
					sourceMesh: "Tree_LOD0",
					sourceVertexCount: 200,
					sourceTriangleCount: 100,
					levels: [{ mesh: "Tree_LOD1", distance: 500, level: 1, vertexCount: 60, triangleCount: 30, deformationMode: "static" }],
				},
			],
			authoredLodSourceMeshCount: 1,
			authoredLodMeshCount: 1,
		};
		const artifact: IModelImporterArtifactStatus = {
			path: "/project/assets/tree.babylon",
			artifactDirectory: "/project/.babylonjs-editor/imported/tree",
			manifestPath: "/project/.babylonjs-editor/imported/tree/import.json",
			fingerprint: "tree",
			current: true,
			exists: true,
			result,
		};

		const markup = renderToStaticMarkup(
			createElement(EditorInspectorModelComponent, {
				artifact,
				settings: { authoredLods: JSON.stringify(authoredLods) },
				onAnimationClipsChange: () => undefined,
				onMaterialRemapsChange: () => undefined,
				onAuthoredLodsChange: () => undefined,
				onGeneratedLodsChange: () => undefined,
				onPlatformOverridesChange: () => undefined,
				onExtractMaterials: async () => "",
				onExtractTextures: async () => "",
			})
		);

		expect(markup).toContain("Artist-authored Model LODs");
		expect(markup).toContain("Detect _LOD#");
		expect(markup).toContain("Tree_LOD0");
		expect(markup).toContain("LOD 1: Tree_LOD1");
		expect(markup).toContain("Authored LOD groups");
	});
});
