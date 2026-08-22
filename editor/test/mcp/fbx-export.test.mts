import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureDir, mkdtemp, pathExists, readFile, remove, writeFile } from "fs-extra";
import { Animation, AnimationGroup, FreeCamera, HemisphericLight, MeshBuilder, NullEngine, Scene, StandardMaterial, TransformNode, Vector3 } from "babylonjs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { convertGlbFileToFbx } from "babylonjs-editor-cli";
import { FBX_EXPORT_MODEL, FBX_EXPORT_VERSION, normalizeFbxExportSettings } from "babylonjs-editor-tools";

import { instantiateMeshAsset } from "../../src/mcp/assets/assets";
import { applyFbxExport, getFbxExportCapabilities, inspectFbxExport, resolveFbxGltf2Export, roundTripFbxExport } from "../../src/mcp/assets/fbx-export";
import { applyModelImporterArtifact, getModelImporterArtifactStatus } from "../../src/mcp/assets/model-importer";
import { refreshAssetRegistryPaths } from "../../src/mcp/assets/registry";
import { projectConfiguration } from "../../src/project/configuration";

vi.mock("babylonjs-editor-cli", () => ({ convertGlbFileToFbx: vi.fn() }));
vi.mock("../../src/mcp/assets/assets", () => ({ instantiateMeshAsset: vi.fn() }));
vi.mock("../../src/mcp/assets/model-importer", () => ({ applyModelImporterArtifact: vi.fn(), getModelImporterArtifactStatus: vi.fn() }));
vi.mock("../../src/mcp/assets/registry", () => ({ refreshAssetRegistryPaths: vi.fn(async () => ({ records: [] })) }));

function binaryFbx(): Uint8Array {
	const magic = Buffer.from("Kaydara FBX Binary  \0\x1a\0", "binary");
	const content = Buffer.alloc(64);
	magic.copy(content);
	content.writeUInt32LE(7400, magic.length);
	content.fill(0x5a, magic.length + 4);
	return new Uint8Array(content);
}

function glbJson(content: Uint8Array): any {
	const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
	const jsonLength = view.getUint32(12, true);
	return JSON.parse(new TextDecoder().decode(content.subarray(20, 20 + jsonLength)).replace(/\0+$/, ""));
}

describe("FBX editor export and round-trip owner", () => {
	let directory: string;
	let previousProjectPath: string | null;
	let engine: NullEngine;
	let scene: Scene;
	let selected: TransformNode;
	let options: any;
	let lastSourceGlb: Uint8Array;
	let mutateDuringConversion: boolean;
	let switchProjectDuringConversion: boolean;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "zvibe-fbx-editor-"));
		await ensureDir(join(directory, "assets", "exports"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		engine = new NullEngine();
		scene = new Scene(engine);
		const parent = new TransformNode("Parent", scene);
		parent.id = "parent";
		parent.position.set(10, 20, 30);
		selected = new TransformNode("Selected", scene);
		selected.id = "selected";
		selected.parent = parent;
		const box = MeshBuilder.CreateBox("Animated Box", { size: 2 }, scene);
		box.id = "animated-box";
		box.parent = selected;
		box.material = new StandardMaterial("Box Material", scene);
		const animation = new Animation("Move", "position.x", 30, Animation.ANIMATIONTYPE_FLOAT);
		animation.setKeys([
			{ frame: 0, value: 0 },
			{ frame: 30, value: 5 },
		]);
		const group = new AnimationGroup("Box Motion", scene);
		group.addTargetedAnimation(animation, box);
		const excluded = MeshBuilder.CreateSphere("Excluded Sphere", { segments: 8 }, scene);
		excluded.id = "excluded-sphere";
		const camera = new FreeCamera("Export Camera", new Vector3(0, 2, -5), scene);
		camera.id = "export-camera";
		const light = new HemisphericLight("Export Light", Vector3.Up(), scene);
		light.id = "export-light";
		options = {
			editor: {
				layout: {
					assets: { refresh: vi.fn() },
					graph: { refresh: vi.fn(async () => undefined), setSelectedNode: vi.fn() },
					inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() },
				},
			},
		};
		mutateDuringConversion = false;
		switchProjectDuringConversion = false;
		vi.mocked(convertGlbFileToFbx).mockImplementation(async (sourcePath, conversionOptions) => {
			const source = await readFile(sourcePath);
			lastSourceGlb = new Uint8Array(source);
			if (mutateDuringConversion) {
				selected.position.x += 1;
			}
			if (switchProjectDuringConversion) {
				projectConfiguration.path = join(directory, "other-project", "Other.bjseditor");
			}
			const content = binaryFbx();
			const settings = normalizeFbxExportSettings(conversionOptions.settings);
			return {
				content,
				executable: "/mock/blender",
				outputBytes: content.byteLength,
				stdout: "mock FBX conversion",
				stderr: "",
				evidence: {
					model: FBX_EXPORT_MODEL,
					version: FBX_EXPORT_VERSION,
					generator: "Zvibe Editor Blender FBX Adapter",
					blenderVersion: "5.1-test",
					source: { bytes: source.byteLength, sha256: createHash("sha256").update(source).digest("hex") },
					output: { bytes: content.byteLength, sha256: createHash("sha256").update(content).digest("hex"), binaryVersion: 7400 },
					settings,
					statistics: { objectCount: 2, meshCount: 1, armatureCount: 0, cameraCount: 0, lightCount: 0, materialCount: 1, actionCount: 1 },
				},
			};
		});
		vi.mocked(instantiateMeshAsset).mockResolvedValue({ rootNodeId: "round-trip-root", createdNodes: [{ id: "round-trip-root", name: "Imported FBX" }] });
	});

	afterEach(async () => {
		vi.mocked(convertGlbFileToFbx).mockReset();
		vi.mocked(instantiateMeshAsset).mockReset();
		vi.mocked(getModelImporterArtifactStatus).mockReset();
		vi.mocked(applyModelImporterArtifact).mockReset();
		vi.mocked(refreshAssetRegistryPaths).mockClear();
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = previousProjectPath;
		await remove(directory);
	});

	test("inspects a deterministic exact node scope and invalidates it after live scene changes", async () => {
		expect(getFbxExportCapabilities()).toMatchObject({ model: FBX_EXPORT_MODEL, outputExtensions: [".fbx"], limits: { rootNodes: 256, exportedNodes: 10_000 } });
		const data = { path: "assets/exports/selection.fbx", rootNodeIds: ["selected"], includeDescendants: true };
		const first = await inspectFbxExport(scene, data);
		const second = await inspectFbxExport(scene, data);
		expect(first).toMatchObject({
			path: "assets/exports/selection.fbx",
			fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
			current: false,
			exists: false,
			scope: { kind: "nodes", rootNodeIds: ["selected"], nodes: { total: 2, items: ["animated-box", "selected"] } },
			snapshot: {
				bytes: expect.any(Number),
				sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
				statistics: { nodeCount: 2, ancestorShellCount: 1, meshCount: 1, animationGroupCount: 1 },
			},
		});
		expect(second.fingerprint).toBe(first.fingerprint);
		await applyFbxExport(scene, { ...data, expectedFingerprint: first.fingerprint, confirm: true }, options);
		const exportedParent = glbJson(lastSourceGlb).nodes.find((node: any) => node.name === "Parent");
		expect(exportedParent.translation.map(Math.abs)).toEqual([10, 20, 30]);
		selected.position.x = 123;
		const changed = await inspectFbxExport(scene, data);
		expect(changed.fingerprint).not.toBe(first.fingerprint);
	});

	test("loads the build-time serializer bridge before the legacy Electron-incompatible package entry", () => {
		const glbAsync = vi.fn();
		const requests: string[] = [];
		const loaded = resolveFbxGltf2Export(
			((path: string) => {
				requests.push(path);
				return { GLTF2Export: { GLBAsync: glbAsync } };
			}) as NodeJS.Require,
			"/virtual/editor/build/src/mcp/assets"
		);
		expect(loaded.GLBAsync).toBe(glbAsync);
		expect(requests).toEqual(["/virtual/editor/build/babylonjs-serializers.cjs"]);
	});

	test("falls back to the legacy serializer and reports every failed candidate", () => {
		const glbAsync = vi.fn();
		const requests: string[] = [];
		const loaded = resolveFbxGltf2Export(
			((path: string) => {
				requests.push(path);
				if (path.endsWith("babylonjs-serializers.cjs")) {
					throw new Error("bridge missing");
				}
				return { GLTF2Export: { GLBAsync: glbAsync } };
			}) as NodeJS.Require,
			"/virtual/editor/build/src/mcp/assets"
		);
		expect(loaded.GLBAsync).toBe(glbAsync);
		expect(requests).toEqual(["/virtual/editor/build/babylonjs-serializers.cjs", "babylonjs-serializers"]);
		expect(() =>
			resolveFbxGltf2Export(
				((path: string) => {
					if (path.endsWith("babylonjs-serializers.cjs")) {
						throw new Error("bridge missing");
					}
					return {};
				}) as NodeJS.Require,
				"/virtual/editor/build/src/mcp/assets"
			)
		).toThrow(/rebuild the editor.*bridge missing.*GLTF2Export\.GLBAsync is unavailable/i);
	});

	test("rejects unsafe paths, ambiguous scopes, invalid settings, and stale or unconfirmed leases", async () => {
		await expect(inspectFbxExport(scene, { path: "../outside.fbx" })).rejects.toThrow(/inside the open project/i);
		await expect(inspectFbxExport(scene, { path: "assets/not-fbx.glb" })).rejects.toThrow(/\.fbx files/i);
		await expect(inspectFbxExport(scene, { path: "assets/out.fbx", rootNodeIds: [] })).rejects.toThrow(/from 1 through 256/i);
		await expect(inspectFbxExport(scene, { path: "assets/out.fbx", rootNodeIds: ["missing"] })).rejects.toThrow(/was not found/i);
		await expect(inspectFbxExport(scene, { path: "assets/out.fbx", includeDescendants: "true" })).rejects.toThrow(/must be a Boolean/i);
		await expect(inspectFbxExport(scene, { path: "assets/out.fbx", nodeLimit: 501 })).rejects.toThrow(/from 1 through 500/i);
		const duplicate = new TransformNode("Duplicate Id", scene);
		duplicate.id = "selected";
		await expect(inspectFbxExport(scene, { path: "assets/out.fbx", rootNodeIds: ["selected"] })).rejects.toThrow(/ambiguous/i);
		duplicate.dispose();
		const plan = await inspectFbxExport(scene, { path: "assets/out.fbx" });
		await expect(applyFbxExport(scene, { path: "assets/out.fbx", expectedFingerprint: plan.fingerprint }, options)).rejects.toThrow(/confirm=true/i);
		selected.position.y = 91;
		await expect(applyFbxExport(scene, { path: "assets/out.fbx", expectedFingerprint: plan.fingerprint, confirm: true }, options)).rejects.toThrow(/plan changed/i);
		expect(convertGlbFileToFbx).not.toHaveBeenCalled();

		const livePlan = await inspectFbxExport(scene, { path: "assets/exports/during-conversion.fbx" });
		mutateDuringConversion = true;
		await expect(applyFbxExport(scene, { path: "assets/exports/during-conversion.fbx", expectedFingerprint: livePlan.fingerprint, confirm: true }, options)).rejects.toThrow(
			/plan changed during conversion/i
		);
		expect(await pathExists(join(directory, "assets", "exports", "during-conversion.fbx"))).toBe(false);

		projectConfiguration.path = join(directory, "Game.bjseditor");
		mutateDuringConversion = false;
		const projectSwitchPlan = await inspectFbxExport(scene, { path: "assets/exports/project-switch.fbx" });
		switchProjectDuringConversion = true;
		await expect(
			applyFbxExport(scene, { path: "assets/exports/project-switch.fbx", expectedFingerprint: projectSwitchPlan.fingerprint, confirm: true }, options)
		).rejects.toThrow(/open project changed during FBX conversion/i);
		expect(await pathExists(join(directory, "assets", "exports", "project-switch.fbx"))).toBe(false);
		projectConfiguration.path = join(directory, "Game.bjseditor");
	});

	test("publishes and reuses an exact FBX while tamper and failed replacement preserve evidence", async () => {
		const data = { path: "assets/exports/scene.fbx" };
		const plan = await inspectFbxExport(scene, data);
		const applied = await applyFbxExport(scene, { ...data, expectedFingerprint: plan.fingerprint, confirm: true }, options);
		expect(applied).toMatchObject({ current: true, fingerprint: plan.fingerprint, result: { evidence: { output: { binaryVersion: 7400 } } } });
		const outputPath = join(directory, "assets", "exports", "scene.fbx");
		expect(await pathExists(outputPath)).toBe(true);
		const original = await readFile(outputPath);
		const reused = await applyFbxExport(scene, { ...data, expectedFingerprint: plan.fingerprint, confirm: true }, options);
		expect(reused.current).toBe(true);
		expect(convertGlbFileToFbx).toHaveBeenCalledTimes(1);

		selected.position.z = 44;
		const changedPlan = await inspectFbxExport(scene, data);
		vi.mocked(convertGlbFileToFbx).mockRejectedValueOnce(new Error("conversion failed intentionally"));
		await expect(applyFbxExport(scene, { ...data, expectedFingerprint: changedPlan.fingerprint, confirm: true }, options)).rejects.toThrow(/conversion failed intentionally/i);
		expect(await readFile(outputPath)).toEqual(original);
		expect((await inspectFbxExport(scene, data)).current).toBe(false);

		await writeFile(outputPath, Buffer.from("tampered"));
		expect((await inspectFbxExport(scene, data)).current).toBe(false);
	});

	test("round-trips through the normal model importer and ordinary mesh instantiation path", async () => {
		const data = { path: "assets/exports/round-trip.fbx", name: "Returned Hero", position: [4, 5, 6] };
		const plan = await inspectFbxExport(scene, data);
		const importedOutput = join(directory, ".bjseditor", "imported-assets", "fixture", "round-trip.babylon");
		const stale = { fingerprint: "c".repeat(64), current: false, result: null } as any;
		const current = {
			fingerprint: "c".repeat(64),
			current: true,
			result: {
				valid: true,
				outputPath: importedOutput,
				meshCount: 1,
				vertexCount: 24,
				triangleCount: 12,
				materialCount: 1,
				textureCount: 0,
				animationGroupCount: 1,
				skeletonCount: 0,
			},
		} as any;
		vi.mocked(getModelImporterArtifactStatus).mockResolvedValue(stale);
		vi.mocked(applyModelImporterArtifact).mockResolvedValue(current);
		const result = await roundTripFbxExport(scene, { ...data, expectedFingerprint: plan.fingerprint, confirm: true }, options);
		expect(applyModelImporterArtifact).toHaveBeenCalledWith(join(directory, "assets", "exports", "round-trip.fbx"), stale.fingerprint);
		expect(instantiateMeshAsset).toHaveBeenCalledWith(
			scene,
			{ path: data.path, name: data.name, parentId: undefined, parentName: undefined, position: data.position },
			options
		);
		expect(result).toMatchObject({ importer: { current: true, valid: true, statistics: { meshCount: 1, triangleCount: 12 } }, instance: { rootNodeId: "round-trip-root" } });
	});
});
