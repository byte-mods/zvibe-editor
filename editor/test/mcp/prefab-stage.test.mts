import { mkdtemp, readFile, remove, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";

import { MeshBuilder, NullEngine, Scene, SceneSerializer } from "babylonjs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { projectConfiguration } from "../../src/project/configuration";
import { defaultPrefabStageSettings, normalizePrefabStageSettings, prefabStageSettingsFingerprint } from "../../src/project/prefab-stage";
import { getPrefabStageSettings, openPrefabStage, setPrefabStageSettings } from "../../src/mcp/prefabs/stage";
import {
	applyPrefabInstancesOverrides,
	applyPrefabInstanceOverrides,
	getPrefab,
	inspectPrefabInstanceLinks,
	inspectPrefabInstanceOverrides,
	inspectPrefabInstancesOverrides,
	inspectPrefabVariantRebase,
	instantiatePrefab,
	revertPrefabInstancesOverrides,
	revertPrefabInstanceOverrides,
	setPrefabAssetNodesProperties,
} from "../../src/mcp/prefabs/prefabs";

function prefabEditorOptions(overrides: any = {}): any {
	return {
		editor: {
			layout: {
				assets: { refresh: () => undefined },
				graph: { refresh: async () => undefined, setSelectedNode: () => undefined },
				inspector: { setEditedObject: () => undefined, forceUpdate: () => undefined },
				...overrides,
			},
		},
	};
}

function bulkOperations(inspection: any, kind = "position"): any[] {
	return inspection.targets.map((target: any) => {
		const entry = inspection.entries.find((candidate: any) => candidate.targetId === target.targetId && candidate.entry.kind === kind);
		if (!entry) {
			throw new Error(`Missing ${kind} override for ${target.rootNodeName}.`);
		}
		return {
			targetId: target.targetId,
			nodeId: target.nodeId,
			targetPath: target.targetPath,
			targetIndex: target.targetIndex,
			expectedRevision: target.revision,
			expectedFingerprint: target.fingerprint,
			entryIds: [entry.entry.id],
		};
	});
}

describe("mcp/prefab-stage", () => {
	let directory: string;
	let previousProjectPath: string | null;

	beforeEach(async () => {
		previousProjectPath = projectConfiguration.path;
		directory = await mkdtemp(join(tmpdir(), "babylon-editor-prefab-stage-"));
		projectConfiguration.path = join(directory, "project.bjseditor");
		await writeFile(projectConfiguration.path, JSON.stringify({ version: "1.0.0", plugins: [], compressedTexturesEnabled: false }));

		const engine = new NullEngine();
		const scene = new Scene(engine);
		try {
			const root = MeshBuilder.CreateBox("Root", {}, scene);
			const child = MeshBuilder.CreateBox("Child", {}, scene);
			child.parent = root;
			root.metadata = { babylonEditorPrefabSourceNodeName: "Root" };
			child.metadata = { babylonEditorPrefabSourceNodeName: "Child" };
			const document = SceneSerializer.Serialize(scene);
			document.metadata = { babylonEditorPrefab: { version: 1, rootName: "Root", rootClassName: "Mesh" } };
			await writeFile(join(directory, "base.prefab"), `${JSON.stringify(document, null, "\t")}\n`);
		} finally {
			scene.dispose();
			engine.dispose();
		}
	});

	afterEach(async () => {
		projectConfiguration.path = previousProjectPath;
		await remove(directory);
	});

	test("normalizes and fingerprints the complete versioned stage settings", () => {
		const normalized = normalizePrefabStageSettings({
			mode: "context",
			contextAppearance: "hidden",
			showOverrides: false,
			autoSave: true,
			environment: "scene",
			backgroundColor: [-2, 0.5, 4, 0.25],
			lightIntensity: 40,
		});
		expect(normalized).toEqual({
			version: 1,
			mode: "context",
			contextAppearance: "hidden",
			showOverrides: false,
			autoSave: true,
			environment: "scene",
			backgroundColor: [0, 0.5, 1, 0.25],
			lightIntensity: 16,
		});
		expect(prefabStageSettingsFingerprint(normalized)).toMatch(/^[a-f0-9]{64}$/);
		expect(prefabStageSettingsFingerprint({ ...normalized })).toBe(prefabStageSettingsFingerprint(normalized));
		expect(normalizePrefabStageSettings(null)).toEqual(defaultPrefabStageSettings);
	});

	test("atomically saves multiple stage nodes and exposes name overrides with exact boundary roots", async () => {
		const revision = (await inspectPrefabVariantRebase({} as Scene, { path: "base.prefab" })).resolvedRevision;
		const saved = await setPrefabAssetNodesProperties({} as Scene, {
			path: "base.prefab",
			expectedRevision: revision,
			changes: [
				{ sourceNodeName: "Root", properties: { name: "Authored Root", position: [1, 0, 0] } },
				{ sourceNodeName: "Child", properties: { name: "Authored Child", position: [4, 0, 0] } },
			],
			confirm: true,
		});
		expect(saved).toMatchObject({ updated: true, changes: [{ sourceNodeName: "Root" }, { sourceNodeName: "Child" }] });
		const document = await getPrefab({} as Scene, { path: "base.prefab" });
		expect(document.meshes.find((node: any) => node.metadata.babylonEditorPrefabSourceNodeName === "Root")).toMatchObject({ name: "Authored Root", position: [1, 0, 0] });
		expect(document.meshes.find((node: any) => node.metadata.babylonEditorPrefabSourceNodeName === "Child")).toMatchObject({ name: "Authored Child", position: [4, 0, 0] });

		const engine = new NullEngine();
		const scene = new Scene(engine);
		const options = {
			editor: {
				layout: {
					assets: { refresh: () => undefined },
					graph: { refresh: async () => undefined, setSelectedNode: () => undefined },
					inspector: { setEditedObject: () => undefined, forceUpdate: () => undefined },
				},
			},
		} as any;
		try {
			const result = await instantiatePrefab(scene, { path: "base.prefab" }, options);
			const root = scene.getMeshById(result.root.id)!;
			const child = root.getDescendants(false).find((node: any) => node.metadata?.prefab?.sourceNodeName === "Child") as any;
			root.name = "Live Root";
			child.position.x = 9;

			const links = await inspectPrefabInstanceLinks(scene, { nodeId: child.id });
			expect(links.links[0]).toMatchObject({ index: 0, path: "base.prefab", boundaryRootNodeId: root.id, boundaryRootNodeName: "Live Root" });

			const inspection = await inspectPrefabInstanceOverrides(scene, { nodeId: child.id, categories: ["transform"], limit: 500 });
			const nameEntry = inspection.entries.find((entry: any) => entry.nodeId === root.id && entry.kind === "name");
			const positionEntry = inspection.entries.find((entry: any) => entry.nodeId === child.id && entry.kind === "position");
			expect(nameEntry).toMatchObject({ currentValue: "Live Root", sourceValue: "Authored Root", canApply: true, canRevert: true });
			expect(positionEntry).toMatchObject({ currentValue: [9, 0, 0], sourceValue: [4, 0, 0] });

			await applyPrefabInstanceOverrides(
				scene,
				{
					nodeId: child.id,
					expectedRevision: inspection.revision,
					expectedFingerprint: inspection.fingerprint,
					entryIds: [nameEntry.id],
					confirm: true,
				},
				options
			);
			expect((await getPrefab(scene, { path: "base.prefab" })).meshes.find((node: any) => node.metadata.babylonEditorPrefabSourceNodeName === "Root").name).toBe("Live Root");

			const afterApply = await inspectPrefabInstanceOverrides(scene, { nodeId: child.id, categories: ["transform"], limit: 500 });
			const remainingPosition = afterApply.entries.find((entry: any) => entry.nodeId === child.id && entry.kind === "position");
			await revertPrefabInstanceOverrides(
				scene,
				{
					nodeId: child.id,
					expectedRevision: afterApply.revision,
					expectedFingerprint: afterApply.fingerprint,
					entryIds: [remainingPosition.id],
					confirm: true,
				},
				options
			);
			expect(child.position.asArray()).toEqual([4, 0, 0]);
		} finally {
			scene.dispose();
			engine.dispose();
		}
	});

	test("inspects, applies, and reverts exact serialized component rows", async () => {
		const source = JSON.parse(await readFile(join(directory, "base.prefab"), "utf-8"));
		const sourceRoot = source.meshes.find((node: any) => node.metadata?.babylonEditorPrefabSourceNodeName === "Root");
		sourceRoot.metadata.customMetadata = { difficulty: "normal", lives: 3 };
		await writeFile(join(directory, "base.prefab"), `${JSON.stringify(source, null, "\t")}\n`);

		const engine = new NullEngine();
		const scene = new Scene(engine);
		const options = prefabEditorOptions();
		try {
			const instantiated = await instantiatePrefab(scene, { path: "base.prefab" }, options);
			const root = scene.getMeshById(instantiated.root.id)!;
			root.metadata.customMetadata = { difficulty: "hard", lives: 2 };

			const inspection = await inspectPrefabInstanceOverrides(scene, { nodeId: root.id, categories: ["component"], limit: 500 });
			const component = inspection.entries.find((entry: any) => entry.kind === "customMetadata");
			expect(component).toMatchObject({
				category: "component",
				currentValue: { difficulty: "hard", lives: 2 },
				sourceValue: { difficulty: "normal", lives: 3 },
				canApply: true,
				canRevert: true,
			});

			await applyPrefabInstanceOverrides(
				scene,
				{
					nodeId: root.id,
					expectedRevision: inspection.revision,
					expectedFingerprint: inspection.fingerprint,
					entryIds: [component.id],
					confirm: true,
				},
				options
			);
			const appliedSource = await getPrefab(scene, { path: "base.prefab" });
			expect(appliedSource.meshes.find((node: any) => node.metadata.babylonEditorPrefabSourceNodeName === "Root").metadata.customMetadata).toEqual({
				difficulty: "hard",
				lives: 2,
			});

			root.metadata.customMetadata = { difficulty: "nightmare", lives: 1 };
			const afterApply = await inspectPrefabInstanceOverrides(scene, { nodeId: root.id, categories: ["component"], limit: 500 });
			const changed = afterApply.entries.find((entry: any) => entry.kind === "customMetadata");
			await revertPrefabInstanceOverrides(
				scene,
				{
					nodeId: root.id,
					expectedRevision: afterApply.revision,
					expectedFingerprint: afterApply.fingerprint,
					entryIds: [changed.id],
					confirm: true,
				},
				options
			);
			expect(root.metadata.customMetadata).toEqual({ difficulty: "hard", lives: 2 });
		} finally {
			scene.dispose();
			engine.dispose();
		}
	});

	test("inspects and atomically applies selected overrides across distinct prefab assets", async () => {
		await writeFile(join(directory, "second.prefab"), await readFile(join(directory, "base.prefab"), "utf-8"));
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const options = prefabEditorOptions();
		try {
			const first = await instantiatePrefab(scene, { path: "base.prefab", name: "First Instance" }, options);
			const second = await instantiatePrefab(scene, { path: "second.prefab", name: "Second Instance" }, options);
			const firstRoot = scene.getMeshById(first.root.id)!;
			const secondRoot = scene.getMeshById(second.root.id)!;
			firstRoot.position.x = 10;
			secondRoot.position.x = 20;

			const inspection = await inspectPrefabInstancesOverrides(scene, { all: true, limit: 500 });
			expect(inspection).toMatchObject({ targetCount: 2, total: 2, truncated: false, counts: { transform: 2, component: 0, structure: 0 } });
			expect(inspection.batchFingerprint).toMatch(/^[a-f0-9]{64}$/);
			const result = await applyPrefabInstancesOverrides(
				scene,
				{ expectedBatchFingerprint: inspection.batchFingerprint, operations: bulkOperations(inspection), mode: "atomic", confirm: true },
				options
			);
			expect(result).toMatchObject({ action: "apply", mode: "atomic", attempted: 2, succeeded: 2, failed: 0, partial: false });
			expect((await getPrefab(scene, { path: "base.prefab" })).meshes[0].position).toEqual([10, 0, 0]);
			expect((await getPrefab(scene, { path: "second.prefab" })).meshes[0].position).toEqual([20, 0, 0]);
		} finally {
			scene.dispose();
			engine.dispose();
		}
	});

	test("paginates path-wide inspection and rejects unsafe same-source atomic Apply", async () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const options = prefabEditorOptions();
		try {
			const first = await instantiatePrefab(scene, { path: "base.prefab", name: "First Same Source" }, options);
			const second = await instantiatePrefab(scene, { path: "base.prefab", name: "Second Same Source" }, options);
			scene.getMeshById(first.root.id)!.position.x = 11;
			scene.getMeshById(second.root.id)!.position.x = 22;

			const firstPage = await inspectPrefabInstancesOverrides(scene, { path: "base.prefab", limit: 1 });
			expect(firstPage).toMatchObject({ targetCount: 2, total: 2, offset: 0, limit: 1, hasMore: true, nextOffset: 1 });
			const secondPage = await inspectPrefabInstancesOverrides(scene, { path: "base.prefab", offset: firstPage.nextOffset, limit: 1 });
			expect(secondPage).toMatchObject({ batchFingerprint: firstPage.batchFingerprint, total: 2, offset: 1, hasMore: false, nextOffset: null });
			const complete = await inspectPrefabInstancesOverrides(scene, {
				targets: firstPage.targets.map((target: any) => ({ nodeId: target.nodeId, targetPath: target.targetPath, targetIndex: target.targetIndex })),
				limit: 500,
			});
			expect(complete.batchFingerprint).toBe(firstPage.batchFingerprint);

			await expect(
				applyPrefabInstancesOverrides(
					scene,
					{ expectedBatchFingerprint: complete.batchFingerprint, operations: bulkOperations(complete), mode: "atomic", confirm: true },
					options
				)
			).rejects.toThrow("at most one target per source asset");
			await expect(inspectPrefabInstancesOverrides(scene, { all: true, path: "base.prefab" })).rejects.toThrow("exactly one bulk selector");
			await expect(
				inspectPrefabInstancesOverrides(scene, {
					targets: [
						{ nodeId: first.root.id, targetPath: "base.prefab", targetIndex: 0 },
						{ nodeId: first.root.id, targetPath: "base.prefab", targetIndex: 0 },
					],
				})
			).rejects.toThrow("repeats one exact live prefab boundary");
		} finally {
			scene.dispose();
			engine.dispose();
		}
	});

	test("rolls every source back when atomic bulk Apply fails after publication", async () => {
		await writeFile(join(directory, "second.prefab"), await readFile(join(directory, "base.prefab"), "utf-8"));
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const setupOptions = prefabEditorOptions();
		try {
			const first = await instantiatePrefab(scene, { path: "base.prefab", name: "First Rollback" }, setupOptions);
			const second = await instantiatePrefab(scene, { path: "second.prefab", name: "Second Rollback" }, setupOptions);
			scene.getMeshById(first.root.id)!.position.x = 30;
			scene.getMeshById(second.root.id)!.position.x = 40;
			const inspection = await inspectPrefabInstancesOverrides(scene, { all: true, limit: 500 });
			const failingOptions = prefabEditorOptions({
				assets: {
					refresh: () => {
						throw new Error("simulated presentation failure");
					},
				},
			});
			await expect(
				applyPrefabInstancesOverrides(
					scene,
					{ expectedBatchFingerprint: inspection.batchFingerprint, operations: bulkOperations(inspection), mode: "atomic", confirm: true },
					failingOptions
				)
			).rejects.toThrow("every source asset");
			expect((await getPrefab(scene, { path: "base.prefab" })).meshes[0].position).toEqual([0, 0, 0]);
			expect((await getPrefab(scene, { path: "second.prefab" })).meshes[0].position).toEqual([0, 0, 0]);
		} finally {
			scene.dispose();
			engine.dispose();
		}
	});

	test("reports best-effort partial results and safely rolls back atomic bulk Revert failures", async () => {
		await writeFile(join(directory, "second.prefab"), await readFile(join(directory, "base.prefab"), "utf-8"));
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const options = prefabEditorOptions();
		try {
			const first = await instantiatePrefab(scene, { path: "base.prefab", name: "First Partial" }, options);
			const second = await instantiatePrefab(scene, { path: "second.prefab", name: "Second Partial" }, options);
			const firstRoot = scene.getMeshById(first.root.id)!;
			const secondRoot = scene.getMeshById(second.root.id)!;
			firstRoot.position.x = 50;
			secondRoot.position.x = 60;
			const inspection = await inspectPrefabInstancesOverrides(scene, { all: true, limit: 500 });
			const operations = bulkOperations(inspection);
			const staleRoot = scene.getMeshById(operations[0].nodeId)!;
			staleRoot.position.y = 5;
			const partial = await applyPrefabInstancesOverrides(
				scene,
				{ expectedBatchFingerprint: inspection.batchFingerprint, operations, mode: "bestEffort", confirm: true },
				options
			);
			expect(partial).toMatchObject({ action: "apply", mode: "bestEffort", attempted: 2, succeeded: 1, failed: 1, partial: true, batchFingerprintMatched: false });
			expect(partial.results.filter((entry: any) => entry.ok)).toHaveLength(1);
			expect(partial.results.filter((entry: any) => !entry.ok)[0].error).toContain("changed since override inspection");

			firstRoot.position.set(70, 0, 0);
			secondRoot.position.set(80, 0, 0);
			const revertInspection = await inspectPrefabInstancesOverrides(scene, { all: true, categories: ["transform"], limit: 500 });
			const revertOperations = bulkOperations(revertInspection);
			const failingRevert = prefabEditorOptions({
				graph: {
					refresh: async () => {
						throw new Error("simulated graph failure");
					},
					setSelectedNode: () => undefined,
				},
			});
			await expect(
				revertPrefabInstancesOverrides(
					scene,
					{ expectedBatchFingerprint: revertInspection.batchFingerprint, operations: revertOperations, mode: "atomic", confirm: true },
					failingRevert
				)
			).rejects.toThrow("every selected live value was restored");
			expect(firstRoot.position.asArray()).toEqual([70, 0, 0]);
			expect(secondRoot.position.asArray()).toEqual([80, 0, 0]);

			const fresh = await inspectPrefabInstancesOverrides(scene, { all: true, categories: ["transform"], limit: 500 });
			const reverted = await revertPrefabInstancesOverrides(
				scene,
				{ expectedBatchFingerprint: fresh.batchFingerprint, operations: bulkOperations(fresh), mode: "atomic", confirm: true },
				options
			);
			expect(reverted).toMatchObject({ action: "revert", mode: "atomic", succeeded: 2, failed: 0 });
			expect(firstRoot.position.asArray()).toEqual((await getPrefab(scene, { path: "base.prefab" })).meshes[0].position);
			expect(secondRoot.position.asArray()).toEqual((await getPrefab(scene, { path: "second.prefab" })).meshes[0].position);
		} finally {
			scene.dispose();
			engine.dispose();
		}
	});

	test("serializes concurrent stage saves so only one exact revision can publish", async () => {
		const revision = (await inspectPrefabVariantRebase({} as Scene, { path: "base.prefab" })).resolvedRevision;
		const results = await Promise.allSettled([
			setPrefabAssetNodesProperties({} as Scene, {
				path: "base.prefab",
				expectedRevision: revision,
				changes: [{ sourceNodeName: "Root", properties: { position: [2, 0, 0] } }],
				confirm: true,
			}),
			setPrefabAssetNodesProperties({} as Scene, {
				path: "base.prefab",
				expectedRevision: revision,
				changes: [{ sourceNodeName: "Root", properties: { position: [3, 0, 0] } }],
				confirm: true,
			}),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((result) => result.status === "rejected");
		expect(rejected).toMatchObject({ status: "rejected" });
		expect(String((rejected as PromiseRejectedResult).reason)).toContain("changed since inspection");
		const document = await getPrefab({} as Scene, { path: "base.prefab" });
		expect(document.meshes.find((node: any) => node.metadata.babylonEditorPrefabSourceNodeName === "Root").position).toEqual([2, 0, 0]);
	});

	test("serializes exact Stage settings leases and persists only the winning replacement", async () => {
		const state: any = {
			projectPath: projectConfiguration.path,
			lastOpenedScenePath: null,
			plugins: [],
			packageManager: "yarn",
			sceneBuildSettings: { version: 1, scenes: [] },
			prefabStage: defaultPrefabStageSettings,
			compressedTextureSoftware: "PVRTexTool",
			compressedTexturesEnabled: false,
			compressedTexturesEnabledInPreview: false,
			compressedEtc2Enabled: false,
			compressedPvrtcEnabled: false,
			compressedTextureQuality: "very-fast",
			externalEditorCommand: "code",
			scriptExecutionOrders: {},
		};
		const workspace = { version: 1, loadedScenes: [], activeScene: null, lightingScene: null };
		const editor: any = {
			state,
			props: { editedScenePath: null },
			layout: { preview: { state: { gizmoSnap: undefined } } },
			sceneWorkspace: { getSettings: () => workspace, applySettings: () => undefined },
			setState: (patch: any, callback?: () => void) =>
				setTimeout(() => {
					Object.assign(state, patch);
					callback?.();
				}, 10),
		};
		const options = { editor } as any;
		const initial = getPrefabStageSettings({} as Scene, {}, options);
		const first = { ...defaultPrefabStageSettings, mode: "context" as const };
		const second = { ...defaultPrefabStageSettings, contextAppearance: "hidden" as const };
		const results = await Promise.allSettled([
			setPrefabStageSettings({} as Scene, { expectedFingerprint: initial.fingerprint, settings: first }, options),
			setPrefabStageSettings({} as Scene, { expectedFingerprint: initial.fingerprint, settings: second }, options),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(String((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason)).toContain("settings changed");
		expect(state.prefabStage).toEqual(first);
		const persisted = JSON.parse(await readFile(projectConfiguration.path!, "utf-8"));
		expect(persisted.prefabStage).toEqual(first);

		const current = getPrefabStageSettings({} as Scene, {}, options);
		state.projectPath = join(directory, "missing", "project.bjseditor");
		await expect(setPrefabStageSettings({} as Scene, { expectedFingerprint: current.fingerprint, settings: second }, options)).rejects.toThrow();
		expect(state.prefabStage).toEqual(first);
	});

	test("rejects context Stage requests before opening when their live boundary is missing or mismatched", async () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const editor: any = {
			state: { projectPath: projectConfiguration.path, prefabStage: defaultPrefabStageSettings },
			layout: {
				preview: { scene },
				assets: { refresh: () => undefined },
				graph: { refresh: async () => undefined, setSelectedNode: () => undefined },
				inspector: { setEditedObject: () => undefined, forceUpdate: () => undefined },
			},
		};
		try {
			await expect(openPrefabStage(scene, { path: "base.prefab", mode: "context" }, { editor } as any)).rejects.toThrow("requires a live prefab");
			await expect(openPrefabStage(scene, { path: "base.prefab", targetIndex: 0 }, { editor } as any)).rejects.toThrow("targetIndex requires");
			const instantiated = await instantiatePrefab(scene, { path: "base.prefab" }, { editor } as any);
			await writeFile(join(directory, "other.prefab"), await readFile(join(directory, "base.prefab"), "utf-8"));
			await expect(openPrefabStage(scene, { path: "other.prefab", nodeId: instantiated.root.id, targetIndex: 0, mode: "context" }, { editor } as any)).rejects.toThrow(
				"references base.prefab, not other.prefab"
			);
		} finally {
			scene.dispose();
			engine.dispose();
		}
	});
});
