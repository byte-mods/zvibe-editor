import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path/posix";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { MeshBuilder, NullEngine, Scene, TransformNode } from "babylonjs";

import {
	applyPrefabInstanceBoundary,
	capturePrefabInstanceStructure,
	comparePrefabInstances,
	createPrefabVariant,
	getPrefab,
	inspectPrefabAssetNodeProperty,
	inspectPrefabInstanceLinks,
	inspectPrefabInstanceStructure,
	inspectPrefabVariantRebase,
	inspectPrefabVariantComponents,
	inspectPrefabVariantStructure,
	instantiatePrefab,
	promotePrefabInstanceBoundaryOverrides,
	rebasePrefabVariant,
	revertPrefabInstanceBoundary,
	setPrefabAssetNodeProperties,
	setPrefabAssetNodeProperty,
	setPrefabVariantOverrides,
	setPrefabVariantStructure,
	setPrefabVariantComponents,
	unpackPrefabInstance,
} from "../../src/mcp/prefabs/prefabs";
import { projectConfiguration } from "../../src/project/configuration";

function prefab(rootPosition: number[], childPosition: number[] = [0, 0, 0]): any {
	return {
		version: 5,
		producer: { name: "Prefab test", version: "1" },
		metadata: { babylonEditorPrefab: { version: 1, rootName: "Root", rootClassName: "Mesh" } },
		meshes: [
			{
				name: "Root",
				id: "root",
				type: "Mesh",
				position: rootPosition,
				rotation: [0, 0, 0],
				scaling: [1, 1, 1],
				visibility: 1,
				isVisible: true,
				metadata: { gameplay: { health: 100 } },
			},
			{
				name: "Child",
				id: "child",
				parentId: "root",
				type: "Mesh",
				position: childPosition,
				rotation: [0, 0, 0],
				scaling: [1, 1, 1],
				visibility: 1,
				isVisible: true,
				metadata: { rendering: { exposure: 1 } },
			},
		],
	};
}

describe("mcp/prefabs dynamic variants", () => {
	let directory: string;
	let previousProjectPath: string | null;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-editor-prefab-variants-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}\n");
		await writeFile(join(directory, "base.prefab"), `${JSON.stringify(prefab([0, 0, 0]), null, "\t")}\n`);
	});

	afterEach(async () => {
		projectConfiguration.path = previousProjectPath;
		await rm(directory, { recursive: true, force: true });
	});

	test("dynamically inherits changed bases, preserves overrides, and persists only under an exact base lease", async () => {
		await createPrefabVariant({} as any, {
			basePath: "base.prefab",
			path: "variant.prefab",
			rootOverrides: { visibility: 0.75 },
			nodeOverrides: [{ nodeName: "Child", properties: { position: [5, 0, 0] } }],
		});
		const initial = await inspectPrefabVariantRebase({} as any, { path: "variant.prefab" });
		expect(initial).toMatchObject({ variant: true, basePath: "base.prefab", stale: false, conflicts: [], chain: ["base.prefab", "variant.prefab"], nodeCount: 2 });

		const changedBase = prefab([10, 0, 0], [0, 2, 0]);
		changedBase.meshes[1].scaling = [2, 2, 2];
		changedBase.meshes.push({ name: "NewChild", id: "new", parentId: "root", type: "Mesh", position: [0, 0, 3], rotation: [0, 0, 0], scaling: [1, 1, 1] });
		await writeFile(join(directory, "base.prefab"), `${JSON.stringify(changedBase, null, "\t")}\n`);

		const stale = await inspectPrefabVariantRebase({} as any, { path: "variant.prefab" });
		expect(stale).toMatchObject({ stale: true, conflicts: [], nodeCount: 3 });
		const resolved = await getPrefab({} as any, { path: "variant.prefab" });
		expect(resolved.meshes[0]).toMatchObject({ position: [10, 0, 0], visibility: 0.75 });
		expect(resolved.meshes.find((node: any) => node.name === "Child")).toMatchObject({ position: [5, 0, 0], scaling: [2, 2, 2] });
		expect(resolved.meshes.find((node: any) => node.name === "NewChild")).toBeTruthy();

		await expect(rebasePrefabVariant({} as any, { path: "variant.prefab", expectedBaseRevision: "0".repeat(64), confirm: true })).rejects.toThrow(
			"base changed since rebase inspection"
		);
		expect(await rebasePrefabVariant({} as any, { path: "variant.prefab", expectedBaseRevision: stale.baseRevision, confirm: true })).toMatchObject({
			rebased: true,
			staleBefore: true,
			baseRevision: stale.baseRevision,
		});
		expect(await inspectPrefabVariantRebase({} as any, { path: "variant.prefab" })).toMatchObject({ stale: false, conflicts: [] });
		const stored = JSON.parse(await readFile(join(directory, "variant.prefab"), "utf-8"));
		expect(stored.metadata.babylonEditorPrefabVariant).toMatchObject({ version: 2, baseRevision: stale.baseRevision });
	});

	test("stores Prefab Mode changes as variant overrides and rejects stale edits", async () => {
		await createPrefabVariant({} as any, { basePath: "base.prefab", path: "variant.prefab", nodeOverrides: [{ nodeName: "Child", properties: { position: [1, 0, 0] } }] });
		const inspection = await inspectPrefabVariantRebase({} as any, { path: "variant.prefab" });
		await expect(
			setPrefabAssetNodeProperties({} as any, {
				path: "variant.prefab",
				sourceNodeName: "Child",
				properties: { scaling: [3, 3, 3] },
				expectedRevision: "f".repeat(64),
				confirm: true,
			})
		).rejects.toThrow("changed since inspection");
		const update = await setPrefabAssetNodeProperties({} as any, {
			path: "variant.prefab",
			sourceNodeName: "Child",
			properties: { scaling: [3, 3, 3], isVisible: false },
			expectedRevision: inspection.resolvedRevision,
			confirm: true,
		});
		expect(update).toMatchObject({ updated: true, variant: true, sourceNodeName: "Child" });
		const stored = JSON.parse(await readFile(join(directory, "variant.prefab"), "utf-8"));
		expect(stored.metadata.babylonEditorPrefabVariant.nodeOverrides).toEqual([
			{ nodeName: "Child", properties: { position: [1, 0, 0], scaling: [3, 3, 3], isVisible: false } },
		]);

		await writeFile(join(directory, "base.prefab"), `${JSON.stringify(prefab([8, 0, 0], [0, 4, 0]), null, "\t")}\n`);
		const resolved = await getPrefab({} as any, { path: "variant.prefab" });
		expect(resolved.meshes[0].position).toEqual([8, 0, 0]);
		expect(resolved.meshes.find((node: any) => node.name === "Child")).toMatchObject({ position: [1, 0, 0], scaling: [3, 3, 3], isVisible: false });
	});

	test("inspects, writes, inherits, and resets arbitrary existing serialized property overrides", async () => {
		await createPrefabVariant({} as any, { basePath: "base.prefab", path: "variant.prefab" });
		const property = await inspectPrefabAssetNodeProperty({} as any, { path: "variant.prefab", sourceNodeName: "Root", propertyPath: "/metadata/gameplay/health" });
		expect(property).toMatchObject({ variant: true, value: 100, overridden: false });
		await expect(
			setPrefabAssetNodeProperty({} as any, {
				path: "variant.prefab",
				sourceNodeName: "Root",
				propertyPath: "/metadata/gameplay/health",
				value: 250,
				expectedRevision: "0".repeat(64),
				confirm: true,
			})
		).rejects.toThrow("changed since property inspection");
		await setPrefabAssetNodeProperty({} as any, {
			path: "variant.prefab",
			sourceNodeName: "Root",
			propertyPath: "/metadata/gameplay/health",
			value: 250,
			expectedRevision: property.revision,
			confirm: true,
		});
		expect(await inspectPrefabAssetNodeProperty({} as any, { path: "variant.prefab", sourceNodeName: "Root", propertyPath: "/metadata/gameplay/health" })).toMatchObject({
			value: 250,
			overridden: true,
		});

		const changedBase = prefab([4, 0, 0]);
		changedBase.meshes[0].metadata.gameplay.health = 125;
		await writeFile(join(directory, "base.prefab"), `${JSON.stringify(changedBase, null, "\t")}\n`);
		expect((await getPrefab({} as any, { path: "variant.prefab" })).meshes[0].metadata.gameplay.health).toBe(250);

		const inspection = await inspectPrefabVariantRebase({} as any, { path: "variant.prefab" });
		expect(inspection.propertyOverrides).toEqual([{ nodeName: "Root", path: "/metadata/gameplay/health", value: 250 }]);
		await setPrefabVariantOverrides({} as any, {
			path: "variant.prefab",
			expectedRevision: inspection.resolvedRevision,
			rootOverrides: inspection.rootOverrides,
			nodeOverrides: inspection.nodeOverrides,
			propertyOverrides: [],
			confirm: true,
		});
		expect(await inspectPrefabAssetNodeProperty({} as any, { path: "variant.prefab", sourceNodeName: "Root", propertyPath: "/metadata/gameplay/health" })).toMatchObject({
			value: 125,
			overridden: false,
		});
	});

	test("reports removed property conflicts and protects identity, structure, prototypes, and bounded JSON", async () => {
		await createPrefabVariant({} as any, {
			basePath: "base.prefab",
			path: "variant.prefab",
			propertyOverrides: [{ nodeName: "Root", path: "/metadata/gameplay/health", value: 200 }],
		});
		const baseWithoutProperty = prefab([0, 0, 0]);
		delete baseWithoutProperty.meshes[0].metadata.gameplay.health;
		await writeFile(join(directory, "base.prefab"), `${JSON.stringify(baseWithoutProperty, null, "\t")}\n`);
		expect(await inspectPrefabVariantRebase({} as any, { path: "variant.prefab" })).toMatchObject({
			conflicts: [{ code: "missingProperty", nodeName: "Root", path: "/metadata/gameplay/health" }],
		});

		const baseInspection = await inspectPrefabAssetNodeProperty({} as any, { path: "base.prefab", sourceNodeName: "Root", propertyPath: "/metadata/gameplay" });
		for (const propertyPath of ["/id", "/parentId", "/position", "/metadata", "/metadata/babylonEditorPrefabSourceNodeName", "/metadata/__proto__/polluted"]) {
			await expect(
				setPrefabAssetNodeProperty({} as any, {
					path: "base.prefab",
					sourceNodeName: "Root",
					propertyPath,
					value: {},
					expectedRevision: baseInspection.revision,
					confirm: true,
				})
			).rejects.toThrow(/reserved|identity|unsafe/);
		}
		await expect(
			setPrefabAssetNodeProperty({} as any, {
				path: "base.prefab",
				sourceNodeName: "Root",
				propertyPath: "/metadata/gameplay",
				value: Number.NaN,
				expectedRevision: baseInspection.revision,
				confirm: true,
			})
		).rejects.toThrow("non-finite");
	});

	test("composes leased add, clone, remove-subtree, and reparent overrides across base changes", async () => {
		const structuralBase = prefab([0, 0, 0]);
		structuralBase.meshes.push(
			{ name: "RemoveMe", id: "remove", parentId: "root", type: "Mesh", position: [0, 0, 0], rotation: [0, 0, 0], scaling: [1, 1, 1] },
			{ name: "RemoveChild", id: "remove-child", parentId: "remove", type: "Mesh", position: [0, 0, 0], rotation: [0, 0, 0], scaling: [1, 1, 1] }
		);
		await writeFile(join(directory, "base.prefab"), `${JSON.stringify(structuralBase, null, "\t")}\n`);
		const structuralOverrides = {
			removals: ["RemoveMe"],
			additions: [
				{ nodeName: "AddedParent", displayName: "Added Parent", parentNodeName: "Root", kind: "transform", properties: { position: [1, 2, 3] } },
				{
					nodeName: "AddedClone",
					displayName: "Added Clone",
					parentNodeName: "AddedParent",
					kind: "cloneMesh",
					cloneSourceNodeName: "Child",
					properties: { scaling: [2, 2, 2] },
				},
			],
			reparents: [{ nodeName: "Child", parentNodeName: "AddedParent" }],
		};
		await createPrefabVariant({} as any, {
			basePath: "base.prefab",
			path: "variant.prefab",
			propertyOverrides: [{ nodeName: "Root", path: "/metadata/gameplay/health", value: 300 }],
			structuralOverrides,
		});
		const inspection = await inspectPrefabVariantStructure({} as any, { path: "variant.prefab" });
		expect(inspection).toMatchObject({ variant: true, conflicts: [], structuralOverrides });
		expect(inspection.nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ nodeName: "AddedParent", displayName: "Added Parent", parentNodeName: "Root", kind: "transform", addedHere: true }),
				expect.objectContaining({ nodeName: "AddedClone", displayName: "Added Clone", parentNodeName: "AddedParent", kind: "cloneMesh", addedHere: true }),
				expect.objectContaining({ nodeName: "Child", parentNodeName: "AddedParent", kind: "mesh", addedHere: false }),
			])
		);
		expect(inspection.nodes.some((node: any) => node.nodeName === "RemoveMe" || node.nodeName === "RemoveChild")).toBe(false);

		const resolved = await getPrefab({} as any, { path: "variant.prefab" });
		expect(resolved.meshes.find((node: any) => node.metadata?.babylonEditorPrefabSourceNodeName === "AddedClone")).toMatchObject({ name: "Added Clone", scaling: [2, 2, 2] });
		expect(resolved.meshes[0].metadata.gameplay.health).toBe(300);
		const engine = new NullEngine();
		const scene = new Scene(engine);
		try {
			const instantiated = await instantiatePrefab(scene, { path: "variant.prefab" }, {
				editor: { layout: { graph: { refresh: async () => undefined, setSelectedNode: () => undefined }, inspector: { setEditedObject: () => undefined } } },
			} as any);
			const addedParent = scene.meshes.find((node) => node.metadata?.prefab?.sourceNodeName === "AddedParent")!;
			const addedClone = scene.meshes.find((node) => node.metadata?.prefab?.sourceNodeName === "AddedClone")!;
			expect(instantiated.meshes).toHaveLength(4);
			expect(addedParent.getTotalVertices()).toBe(0);
			expect(addedClone.parent).toBe(addedParent);
			expect(scene.meshes.find((node) => node.metadata?.prefab?.sourceNodeName === "Child")?.parent).toBe(addedParent);
		} finally {
			scene.dispose();
			engine.dispose();
		}
		await expect(setPrefabVariantStructure({} as any, { path: "variant.prefab", expectedRevision: "0".repeat(64), structuralOverrides, confirm: true })).rejects.toThrow(
			"changed since variant inspection"
		);

		structuralBase.meshes[1].position = [9, 0, 0];
		await writeFile(join(directory, "base.prefab"), `${JSON.stringify(structuralBase, null, "\t")}\n`);
		const changed = await inspectPrefabVariantStructure({} as any, { path: "variant.prefab" });
		expect(changed).toMatchObject({ stale: true, conflicts: [] });
		expect((await getPrefab({} as any, { path: "variant.prefab" })).meshes.find((node: any) => node.metadata?.babylonEditorPrefabSourceNodeName === "Child").position).toEqual([
			9, 0, 0,
		]);
		await setPrefabVariantStructure({} as any, {
			path: "variant.prefab",
			expectedRevision: changed.revision,
			structuralOverrides: { ...structuralOverrides, reparents: [{ nodeName: "Child", parentNodeName: null }] },
			confirm: true,
		});
		const rooted = await inspectPrefabVariantStructure({} as any, { path: "variant.prefab" });
		expect(rooted.nodes.find((node: any) => node.nodeName === "Child").parentNodeName).toBe("Root");
		expect(
			await setPrefabVariantStructure({} as any, {
				path: "variant.prefab",
				expectedRevision: rooted.revision,
				structuralOverrides: { removals: [], additions: [], reparents: [] },
				confirm: true,
			})
		).toMatchObject({ updated: true, structuralOverrides: { removals: [], additions: [], reparents: [] } });
		expect((await inspectPrefabAssetNodeProperty({} as any, { path: "variant.prefab", sourceNodeName: "Root", propertyPath: "/metadata/gameplay/health" })).value).toBe(300);
	});

	test("rejects root removal and cycles and reports structurally invalidated clone sources", async () => {
		await expect(
			createPrefabVariant({} as any, { basePath: "base.prefab", path: "bad-root.prefab", structuralOverrides: { removals: ["Root"], additions: [], reparents: [] } })
		).rejects.toThrow("cannot remove the prefab root");
		await expect(
			createPrefabVariant({} as any, {
				basePath: "base.prefab",
				path: "bad-cycle.prefab",
				structuralOverrides: { removals: [], additions: [], reparents: [{ nodeName: "Child", parentNodeName: "Child" }] },
			})
		).rejects.toThrow("hierarchy cycle");
		await createPrefabVariant({} as any, {
			basePath: "base.prefab",
			path: "variant.prefab",
			structuralOverrides: {
				removals: [],
				additions: [{ nodeName: "AddedClone", displayName: "Clone", parentNodeName: "Root", kind: "cloneMesh", cloneSourceNodeName: "Child", properties: {} }],
				reparents: [],
			},
		});
		const withoutChild = prefab([0, 0, 0]);
		withoutChild.meshes.splice(1, 1);
		await writeFile(join(directory, "base.prefab"), `${JSON.stringify(withoutChild, null, "\t")}\n`);
		expect(await inspectPrefabVariantStructure({} as any, { path: "variant.prefab" })).toMatchObject({
			conflicts: [{ code: "structuralMissingNode", nodeName: "AddedClone" }],
		});
	});

	test("adds, removes, inspects, and resets runtime metadata components under an exact lease", async () => {
		const scripts = [{ enabled: true, key: "scripts/health.ts", executionOrder: 5, values: { amount: { type: "number", value: 10 } } }];
		const componentOverrides = {
			additions: [
				{ nodeName: "Child", componentKey: "scripts", value: scripts },
				{ nodeName: "Root", componentKey: "gameplayStats", value: { armor: 50, factions: ["player"] } },
			],
			removals: [{ nodeName: "Child", componentKey: "rendering" }],
		};
		await createPrefabVariant({} as any, { basePath: "base.prefab", path: "variant.prefab", componentOverrides });
		const resolved = await getPrefab({} as any, { path: "variant.prefab" });
		expect(resolved.meshes[0].metadata.gameplayStats).toEqual({ armor: 50, factions: ["player"] });
		expect(resolved.meshes[1].metadata.scripts).toEqual(scripts);
		expect(resolved.meshes[1].metadata.rendering).toBeUndefined();
		const inspection = await inspectPrefabVariantComponents({} as any, { path: "variant.prefab" });
		expect(inspection).toMatchObject({ variant: true, conflicts: [], componentOverrides });
		expect(inspection.nodes.find((node: any) => node.nodeName === "Child").components).toEqual(
			expect.arrayContaining([expect.objectContaining({ componentKey: "scripts", valueType: "array", addedHere: true })])
		);
		await expect(setPrefabVariantComponents({} as any, { path: "variant.prefab", expectedRevision: "0".repeat(64), componentOverrides, confirm: true })).rejects.toThrow(
			"changed since variant inspection"
		);
		await setPrefabVariantComponents({} as any, {
			path: "variant.prefab",
			expectedRevision: inspection.revision,
			componentOverrides: { additions: [], removals: [] },
			confirm: true,
		});
		const inherited = await getPrefab({} as any, { path: "variant.prefab" });
		expect(inherited.meshes[0].metadata.gameplayStats).toBeUndefined();
		expect(inherited.meshes[1].metadata.rendering).toEqual({ exposure: 1 });
	});

	test("validates component identities and known script/physics shapes", async () => {
		await expect(
			createPrefabVariant({} as any, {
				basePath: "base.prefab",
				path: "invalid.prefab",
				componentOverrides: { additions: [{ nodeName: "Root", componentKey: "prefab", value: {} }], removals: [] },
			})
		).rejects.toThrow("protected prefab identity");
		await expect(
			createPrefabVariant({} as any, {
				basePath: "base.prefab",
				path: "invalid.prefab",
				componentOverrides: { additions: [{ nodeName: "Root", componentKey: "scripts", value: [{ key: "../escape.ts" }] }], removals: [] },
			})
		).rejects.toThrow("safe scripts/");
		await expect(
			createPrefabVariant({} as any, {
				basePath: "base.prefab",
				path: "invalid.prefab",
				componentOverrides: { additions: [{ nodeName: "Root", componentKey: "physicsAggregate", value: { shape: {} } }], removals: [] },
			})
		).rejects.toThrow("finite shape");
		await expect(
			createPrefabVariant({} as any, {
				basePath: "base.prefab",
				path: "invalid.prefab",
				componentOverrides: { additions: [{ nodeName: "Root", componentKey: "gameplay", value: {} }], removals: [] },
			})
		).rejects.toThrow("already exists");
	});

	test("composes contained nested prefab assets with namespaced identities and live child changes", async () => {
		const child = prefab([2, 0, 0], [0, 3, 0]);
		child.meshes[0].name = "ChildRoot";
		child.meshes[0].id = "child-root";
		child.meshes[1].name = "ChildLeaf";
		child.meshes[1].id = "child-leaf";
		child.meshes[1].parentId = "child-root";
		await writeFile(join(directory, "child.prefab"), `${JSON.stringify(child, null, "\t")}\n`);
		await createPrefabVariant({} as any, {
			basePath: "base.prefab",
			path: "variant.prefab",
			structuralOverrides: {
				removals: [],
				additions: [
					{
						nodeName: "NestedWeapon",
						displayName: "Nested Weapon",
						parentNodeName: "Root",
						kind: "nestedPrefab",
						prefabPath: "child.prefab",
						properties: { scaling: [0.5, 0.5, 0.5] },
					},
				],
				reparents: [],
			},
			componentOverrides: { additions: [{ nodeName: "NestedWeapon/ChildLeaf", componentKey: "damage", value: { amount: 25 } }], removals: [] },
		});
		const structure = await inspectPrefabVariantStructure({} as any, { path: "variant.prefab" });
		expect(structure).toMatchObject({ conflicts: [] });
		expect(structure.nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ nodeName: "NestedWeapon", displayName: "Nested Weapon", parentNodeName: "Root", kind: "nestedPrefab" }),
				expect.objectContaining({ nodeName: "NestedWeapon/ChildLeaf", parentNodeName: "NestedWeapon", kind: "nestedPrefab" }),
			])
		);
		const nested = await getPrefab({} as any, { path: "variant.prefab" });
		const nestedRoot = nested.meshes.find((node: any) => node.metadata?.babylonEditorPrefabSourceNodeName === "NestedWeapon");
		const nestedLeaf = nested.meshes.find((node: any) => node.metadata?.babylonEditorPrefabSourceNodeName === "NestedWeapon/ChildLeaf");
		expect(nestedRoot).toMatchObject({ name: "Nested Weapon", scaling: [0.5, 0.5, 0.5] });
		expect(nestedLeaf.metadata.damage).toEqual({ amount: 25 });
		expect(nestedLeaf.parentId).toBe(nestedRoot.id);
		const engine = new NullEngine();
		const scene = new Scene(engine);
		try {
			await instantiatePrefab(scene, { path: "variant.prefab" }, {
				editor: { layout: { graph: { refresh: async () => undefined, setSelectedNode: () => undefined }, inspector: { setEditedObject: () => undefined } } },
			} as any);
			const runtimeRoot = scene.meshes.find((node) => node.metadata?.prefab?.sourceNodeName === "NestedWeapon")!;
			const runtimeLeaf = scene.meshes.find((node) => node.metadata?.prefab?.sourceNodeName === "NestedWeapon/ChildLeaf")!;
			expect(runtimeLeaf.parent).toBe(runtimeRoot);
			expect(runtimeLeaf.metadata.damage).toEqual({ amount: 25 });
		} finally {
			scene.dispose();
			engine.dispose();
		}

		child.meshes[1].position = [0, 9, 0];
		await writeFile(join(directory, "child.prefab"), `${JSON.stringify(child, null, "\t")}\n`);
		expect(
			(await getPrefab({} as any, { path: "variant.prefab" })).meshes.find((node: any) => node.metadata?.babylonEditorPrefabSourceNodeName === "NestedWeapon/ChildLeaf")
				.position
		).toEqual([0, 9, 0]);
		const beforeRemoval = await inspectPrefabVariantRebase({} as any, { path: "variant.prefab" });
		await setPrefabVariantOverrides({} as any, {
			path: "variant.prefab",
			expectedRevision: beforeRemoval.resolvedRevision,
			rootOverrides: beforeRemoval.rootOverrides,
			nodeOverrides: beforeRemoval.nodeOverrides,
			propertyOverrides: beforeRemoval.propertyOverrides,
			componentOverrides: { additions: [], removals: [] },
			structuralOverrides: { ...beforeRemoval.structuralOverrides, removals: ["NestedWeapon/ChildLeaf"] },
			confirm: true,
		});
		expect((await inspectPrefabVariantStructure({} as any, { path: "variant.prefab" })).nodes.some((node: any) => node.nodeName === "NestedWeapon/ChildLeaf")).toBe(false);
	});

	test("reports missing nested assets and nested-prefab dependency cycles without partial composition", async () => {
		await expect(
			createPrefabVariant({} as any, {
				basePath: "base.prefab",
				path: "missing-nested.prefab",
				structuralOverrides: {
					removals: [],
					additions: [{ nodeName: "Missing", displayName: "Missing", parentNodeName: "Root", kind: "nestedPrefab", prefabPath: "does-not-exist.prefab", properties: {} }],
					reparents: [],
				},
			})
		).rejects.toThrow("could not be composed");
		const a = prefab([0, 0, 0]);
		a.metadata.babylonEditorPrefabVariant = {
			version: 2,
			basePath: "base.prefab",
			baseRevision: "0".repeat(64),
			rootOverrides: {},
			nodeOverrides: [],
			propertyOverrides: [],
			componentOverrides: { additions: [], removals: [] },
			structuralOverrides: {
				removals: [],
				additions: [{ nodeName: "B", displayName: "B", parentNodeName: "Root", kind: "nestedPrefab", prefabPath: "b.prefab", properties: {} }],
				reparents: [],
			},
		};
		const b = structuredClone(a);
		b.metadata.babylonEditorPrefabVariant.structuralOverrides.additions[0] = {
			nodeName: "A",
			displayName: "A",
			parentNodeName: "Root",
			kind: "nestedPrefab",
			prefabPath: "a.prefab",
			properties: {},
		};
		await writeFile(join(directory, "a.prefab"), `${JSON.stringify(a)}\n`);
		await writeFile(join(directory, "b.prefab"), `${JSON.stringify(b)}\n`);
		expect(await inspectPrefabVariantStructure({} as any, { path: "a.prefab" })).toMatchObject({ conflicts: [{ code: "nestedPrefabConflict", nodeName: "B" }] });
	});

	test("applies and reverts exact nested source boundaries and supports outermost or complete unpack", async () => {
		const child = prefab([2, 0, 0], [0, 3, 0]);
		child.meshes[0].name = "ChildRoot";
		child.meshes[0].id = "child-root";
		child.meshes[1].name = "ChildLeaf";
		child.meshes[1].id = "child-leaf";
		child.meshes[1].parentId = "child-root";
		await writeFile(join(directory, "child.prefab"), `${JSON.stringify(child, null, "\t")}\n`);
		await createPrefabVariant({} as any, {
			basePath: "base.prefab",
			path: "variant.prefab",
			structuralOverrides: {
				removals: [],
				additions: [{ nodeName: "NestedWeapon", displayName: "Nested Weapon", parentNodeName: "Root", kind: "nestedPrefab", prefabPath: "child.prefab", properties: {} }],
				reparents: [],
			},
		});
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const options = {
			editor: {
				layout: {
					graph: { refresh: async () => undefined, setSelectedNode: () => undefined },
					inspector: { setEditedObject: () => undefined, forceUpdate: () => undefined },
				},
			},
		} as any;
		try {
			const result = await instantiatePrefab(scene, { path: "variant.prefab" }, options);
			const root = scene.getMeshById(result.root.id)!;
			const nestedRoot = scene.meshes.find((node) => node.metadata?.prefab?.sourceNodeName === "NestedWeapon")!;
			const links = await inspectPrefabInstanceLinks(scene, { nodeId: nestedRoot.id });
			expect(links.links).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ index: 0, path: "variant.prefab", sourceNodeName: "NestedWeapon", targetExists: true }),
					expect.objectContaining({ index: 1, path: "child.prefab", sourceNodeName: "ChildRoot", targetExists: true }),
				])
			);
			const storedChildPath = nestedRoot.metadata.prefab.links[1].path;
			nestedRoot.metadata.prefab.links[1].path = "../outside.prefab";
			await expect(inspectPrefabInstanceLinks(scene, { nodeId: nestedRoot.id })).rejects.toThrow("inside the open project");
			nestedRoot.metadata.prefab.links[1].path = storedChildPath;
			await expect(
				applyPrefabInstanceBoundary(
					scene,
					{
						nodeId: nestedRoot.id,
						targetPath: "child.prefab",
						expectedRevision: links.links[1].revision,
						transformVisibility: false,
						componentChanges: [{ action: "set", componentKey: "prefab", value: {} }],
						confirm: true,
					},
					options
				)
			).rejects.toThrow("protected prefab");
			await expect(unpackPrefabInstance(scene, { nodeId: nestedRoot.id, mode: "completely", targetPath: "child.prefab", confirm: false }, options)).rejects.toThrow(
				"confirm must be true"
			);
			nestedRoot.position.set(7, 8, 9);
			nestedRoot.metadata.boundaryStats = { health: 250 };
			const applied = await applyPrefabInstanceBoundary(
				scene,
				{
					nodeId: nestedRoot.id,
					targetPath: "child.prefab",
					expectedRevision: links.links[1].revision,
					transformVisibility: true,
					componentChanges: [{ action: "set", componentKey: "boundaryStats", value: nestedRoot.metadata.boundaryStats }],
					confirm: true,
				},
				options
			);
			const childAfterApply = await getPrefab({} as any, { path: "child.prefab" });
			expect(childAfterApply.meshes[0]).toMatchObject({ position: [7, 8, 9], metadata: { boundaryStats: { health: 250 } } });
			nestedRoot.position.set(0, 0, 0);
			nestedRoot.metadata.boundaryStats = { health: 1 };
			await revertPrefabInstanceBoundary(
				scene,
				{
					nodeId: nestedRoot.id,
					targetPath: "child.prefab",
					expectedRevision: applied.revision,
					transformVisibility: true,
					componentKeys: ["boundaryStats"],
					confirm: true,
				},
				options
			);
			expect(nestedRoot.position.asArray()).toEqual([7, 8, 9]);
			expect(nestedRoot.metadata.boundaryStats).toEqual({ health: 250 });
			await expect(
				applyPrefabInstanceBoundary(scene, { nodeId: nestedRoot.id, targetPath: "child.prefab", expectedRevision: links.links[1].revision, confirm: true }, options)
			).rejects.toThrow("changed since inspection");

			const outermost = await unpackPrefabInstance(scene, { nodeId: root.id, mode: "outermost", targetPath: "variant.prefab", confirm: true }, options);
			expect(outermost).toMatchObject({ unpacked: true, detached: 2, preservedNested: 2 });
			expect(root.metadata.prefab).toBeUndefined();
			expect(nestedRoot.metadata.prefab).toMatchObject({ path: "child.prefab", sourceNodeName: "ChildRoot" });
			const complete = await unpackPrefabInstance(scene, { nodeId: nestedRoot.id, mode: "completely", targetPath: "child.prefab", confirm: true }, options);
			expect(complete).toMatchObject({ unpacked: true, detached: 2, preservedNested: 0 });
			expect(nestedRoot.metadata.prefab).toBeUndefined();
		} finally {
			scene.dispose();
			engine.dispose();
		}
	});

	test("promotes transform, property, component, and structural overrides into a nested source atomically", async () => {
		const child = prefab([2, 0, 0], [0, 3, 0]);
		child.meshes[0].name = "ChildRoot";
		child.meshes[0].id = "child-root";
		child.meshes[1].name = "ChildLeaf";
		child.meshes[1].id = "child-leaf";
		child.meshes[1].parentId = "child-root";
		await writeFile(join(directory, "child.prefab"), `${JSON.stringify(child, null, "\t")}\n`);
		await createPrefabVariant({} as any, {
			basePath: "base.prefab",
			path: "variant.prefab",
			nodeOverrides: [{ nodeName: "NestedWeapon/ChildLeaf", properties: { position: [4, 5, 6] } }],
			propertyOverrides: [{ nodeName: "NestedWeapon/ChildLeaf", path: "/metadata/rendering/exposure", value: 2.5 }],
			componentOverrides: { additions: [{ nodeName: "NestedWeapon", componentKey: "weaponStats", value: { damage: 50 } }], removals: [] },
			structuralOverrides: {
				removals: [],
				additions: [
					{ nodeName: "NestedWeapon", displayName: "Nested Weapon", parentNodeName: "Root", kind: "nestedPrefab", prefabPath: "child.prefab", properties: {} },
					{ nodeName: "Socket", displayName: "Socket", parentNodeName: "NestedWeapon", kind: "transform", properties: { position: [1, 0, 0] } },
				],
				reparents: [{ nodeName: "NestedWeapon/ChildLeaf", parentNodeName: "Socket" }],
			},
		});
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const options = {
			editor: {
				layout: {
					graph: { refresh: async () => undefined, setSelectedNode: () => undefined },
					inspector: { setEditedObject: () => undefined, forceUpdate: () => undefined },
				},
			},
		} as any;
		try {
			await instantiatePrefab(scene, { path: "variant.prefab" }, options);
			const nestedRoot = scene.meshes.find((node) => node.metadata?.prefab?.sourceNodeName === "NestedWeapon")!;
			const links = await inspectPrefabInstanceLinks(scene, { nodeId: nestedRoot.id });
			const promoted = await promotePrefabInstanceBoundaryOverrides(
				scene,
				{
					nodeId: nestedRoot.id,
					targetPath: "child.prefab",
					expectedContainerRevision: links.links[0].revision,
					expectedTargetRevision: links.links[1].revision,
					categories: ["transforms", "properties", "components", "structure"],
					confirm: true,
				},
				options
			);
			expect(promoted.counts).toMatchObject({ transforms: 1, properties: 1, componentAdditions: 1, structuralAdditions: 1, structuralReparents: 1 });
			const childAfter = await getPrefab({} as any, { path: "child.prefab" });
			const childRoot = childAfter.meshes.find((node: any) => node.metadata?.babylonEditorPrefabSourceNodeName === "ChildRoot");
			const childLeaf = childAfter.meshes.find((node: any) => node.metadata?.babylonEditorPrefabSourceNodeName === "ChildLeaf");
			const socket = childAfter.meshes.find((node: any) => node.metadata?.babylonEditorPrefabSourceNodeName === "Socket");
			expect(childRoot.metadata.weaponStats).toEqual({ damage: 50 });
			expect(childLeaf).toMatchObject({ position: [4, 5, 6], metadata: { rendering: { exposure: 2.5 } }, parentId: socket.id });
			const outer = await inspectPrefabVariantRebase({} as any, { path: "variant.prefab" });
			expect(outer).toMatchObject({ nodeOverrides: [], propertyOverrides: [], componentOverrides: { additions: [], removals: [] }, conflicts: [] });
			expect(outer.structuralOverrides.additions).toHaveLength(1);
			expect(outer.structuralOverrides.additions[0]).toMatchObject({ nodeName: "NestedWeapon", kind: "nestedPrefab" });
			expect(outer.structuralOverrides.reparents).toEqual([]);
		} finally {
			scene.dispose();
			engine.dispose();
		}
	});

	test("reports removed override targets and blocks conflicted rebase and editing", async () => {
		await createPrefabVariant({} as any, { basePath: "base.prefab", path: "variant.prefab", nodeOverrides: [{ nodeName: "Child", properties: { position: [1, 0, 0] } }] });
		const withoutChild = prefab([0, 0, 0]);
		withoutChild.meshes.splice(1, 1);
		await writeFile(join(directory, "base.prefab"), `${JSON.stringify(withoutChild, null, "\t")}\n`);
		const inspection = await inspectPrefabVariantRebase({} as any, { path: "variant.prefab" });
		expect(inspection).toMatchObject({ stale: true, conflicts: [{ code: "missingNode", nodeName: "Child" }] });
		await expect(rebasePrefabVariant({} as any, { path: "variant.prefab", expectedBaseRevision: inspection.baseRevision, confirm: true })).rejects.toThrow("unresolved");
		await expect(setPrefabAssetNodeProperties({} as any, { path: "variant.prefab", sourceNodeName: "Root", properties: { visibility: 0.5 }, confirm: true })).rejects.toThrow(
			"unresolved rebase conflicts"
		);
		expect(
			await setPrefabVariantOverrides({} as any, {
				path: "variant.prefab",
				expectedRevision: inspection.resolvedRevision,
				rootOverrides: { visibility: 0.5 },
				nodeOverrides: [],
				confirm: true,
			})
		).toMatchObject({ updated: true, nodeOverrides: [], rootOverrides: { visibility: 0.5 } });
		expect(await inspectPrefabVariantRebase({} as any, { path: "variant.prefab" })).toMatchObject({ stale: false, conflicts: [] });
	});

	test("supports nested dynamic variants and rejects inheritance cycles", async () => {
		await createPrefabVariant({} as any, { basePath: "base.prefab", path: "middle.prefab", rootOverrides: { visibility: 0.8 } });
		await createPrefabVariant({} as any, { basePath: "middle.prefab", path: "leaf.prefab", nodeOverrides: [{ nodeName: "Child", properties: { position: [7, 0, 0] } }] });
		await writeFile(join(directory, "base.prefab"), `${JSON.stringify(prefab([12, 0, 0]), null, "\t")}\n`);
		const leaf = await getPrefab({} as any, { path: "leaf.prefab" });
		expect(leaf.meshes[0]).toMatchObject({ position: [12, 0, 0], visibility: 0.8 });
		expect(leaf.meshes.find((node: any) => node.name === "Child").position).toEqual([7, 0, 0]);
		expect(await inspectPrefabVariantRebase({} as any, { path: "leaf.prefab" })).toMatchObject({ chain: ["base.prefab", "middle.prefab", "leaf.prefab"], stale: true });

		const cycleA = prefab([0, 0, 0]);
		cycleA.metadata.babylonEditorPrefabVariant = { version: 2, basePath: "cycle-b.prefab", rootOverrides: {}, nodeOverrides: [] };
		const cycleB = prefab([0, 0, 0]);
		cycleB.metadata.babylonEditorPrefabVariant = { version: 2, basePath: "cycle-a.prefab", rootOverrides: {}, nodeOverrides: [] };
		await writeFile(join(directory, "cycle-a.prefab"), `${JSON.stringify(cycleA)}\n`);
		await writeFile(join(directory, "cycle-b.prefab"), `${JSON.stringify(cycleB)}\n`);
		await expect(inspectPrefabVariantRebase({} as any, { path: "cycle-a.prefab" })).rejects.toThrow("inheritance cycle");
	});

	test("instantiates the dynamically resolved hierarchy into a real Babylon scene", async () => {
		await createPrefabVariant({} as any, { basePath: "base.prefab", path: "variant.prefab", nodeOverrides: [{ nodeName: "Child", properties: { position: [6, 0, 0] } }] });
		await writeFile(join(directory, "base.prefab"), `${JSON.stringify(prefab([9, 0, 0]), null, "\t")}\n`);
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const options = {
			editor: {
				layout: {
					graph: { refresh: async () => undefined, setSelectedNode: () => undefined },
					inspector: { setEditedObject: () => undefined },
				},
			},
		} as any;
		try {
			const result = await instantiatePrefab(scene, { path: "variant.prefab" }, options);
			expect(result).toMatchObject({ path: "variant.prefab", variant: true, dynamicallyRebased: true });
			const root = scene.getMeshById(result.root.id)!;
			expect(root.position.asArray()).toEqual([9, 0, 0]);
			expect(root.metadata.prefab).toMatchObject({ path: "variant.prefab", variantOf: "base.prefab", sourceNodeName: "Root" });
			const child = scene.meshes.find((mesh) => mesh.metadata?.prefab?.sourceNodeName === "Child")!;
			expect(child.position.asArray()).toEqual([6, 0, 0]);
		} finally {
			scene.dispose();
			engine.dispose();
		}
	});

	test("detects, compares, and captures live prefab instance structural differences", async () => {
		await createPrefabVariant({} as any, { basePath: "base.prefab", path: "variant.prefab" });
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const options = {
			editor: {
				layout: {
					graph: { refresh: async () => undefined, setSelectedNode: () => undefined },
					inspector: { setEditedObject: () => undefined, forceUpdate: () => undefined },
				},
			},
		} as any;
		try {
			const first = await instantiatePrefab(scene, { path: "variant.prefab", name: "First" }, options);
			await instantiatePrefab(scene, { path: "variant.prefab", name: "Second" }, options);
			const firstRoot = scene.getMeshById(first.root.id)!;
			const firstChild = firstRoot.getDescendants(false).find((node: any) => node.metadata?.prefab?.sourceNodeName === "Child")!;
			firstChild.dispose();
			const socket = new TransformNode("Live Socket", scene);
			socket.parent = firstRoot;

			const inspection = await inspectPrefabInstanceStructure(scene, { nodeId: firstRoot.id });
			expect(inspection).toMatchObject({
				variant: true,
				removals: ["Child"],
				reparents: [],
				blockers: [],
				hasStructuralOverrides: true,
			});
			expect(inspection.additions).toEqual([
				expect.objectContaining({
					displayName: "Live Socket",
					parentNodeName: "Root",
					kind: "transform",
					properties: expect.objectContaining({ position: [0, 0, 0] }),
				}),
			]);
			const comparison = await comparePrefabInstances(scene, { path: "variant.prefab" });
			expect(comparison).toMatchObject({ instanceCount: 2, distinctSignatureCount: 2 });
			expect(comparison.instances.map((instance: any) => instance.hasOverrides).sort()).toEqual([false, true]);
			await expect(capturePrefabInstanceStructure(scene, { nodeId: firstRoot.id, expectedRevision: "0".repeat(64), confirm: true }, options)).rejects.toThrow(
				"changed since inspection"
			);
			expect(socket.metadata?.prefab).toBeUndefined();

			const captured = await capturePrefabInstanceStructure(scene, { nodeId: firstRoot.id, expectedRevision: inspection.revision, confirm: true }, options);
			expect(captured).toMatchObject({ captured: true, capturedCounts: { removals: 1, additions: 1, reparents: 0 } });
			const structure = await inspectPrefabVariantStructure(scene, { path: "variant.prefab" });
			expect(structure.structuralOverrides.removals).toEqual(["Child"]);
			expect(structure.structuralOverrides.additions).toEqual([expect.objectContaining({ displayName: "Live Socket", kind: "transform", parentNodeName: "Root" })]);
			const after = await inspectPrefabInstanceStructure(scene, { nodeId: firstRoot.id });
			expect(after).toMatchObject({ removals: [], additions: [], reparents: [], blockers: [], hasStructuralOverrides: false });
		} finally {
			scene.dispose();
			engine.dispose();
		}
	});

	test("captures arbitrary live mesh geometry and separately instantiated nested prefabs with provenance", async () => {
		const nested = prefab([0, 0, 0], [0, 2, 0]);
		nested.meshes[0].name = "NestedRoot";
		nested.meshes[0].id = "nested-root";
		nested.meshes[1].name = "NestedLeaf";
		nested.meshes[1].id = "nested-leaf";
		nested.meshes[1].parentId = "nested-root";
		await writeFile(join(directory, "nested.prefab"), `${JSON.stringify(nested, null, "\t")}\n`);
		await createPrefabVariant({} as any, { basePath: "base.prefab", path: "variant.prefab" });
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const options = {
			editor: {
				layout: {
					graph: { refresh: async () => undefined, setSelectedNode: () => undefined },
					inspector: { setEditedObject: () => undefined, forceUpdate: () => undefined },
				},
			},
		} as any;
		try {
			const outerResult = await instantiatePrefab(scene, { path: "variant.prefab", name: "Outer" }, options);
			const nestedResult = await instantiatePrefab(scene, { path: "nested.prefab", name: "Nested Live" }, options);
			const outerRoot = scene.getMeshById(outerResult.root.id)!;
			const nestedRoot = scene.getMeshById(nestedResult.root.id)!;
			nestedRoot.parent = outerRoot;
			const liveBox = MeshBuilder.CreateBox("Authored Box", { width: 2, height: 3, depth: 4 }, scene);
			liveBox.parent = outerRoot;
			liveBox.position.set(5, 6, 7);

			const inspection = await inspectPrefabInstanceStructure(scene, { nodeId: outerRoot.id });
			expect(inspection.blockers).toEqual([]);
			expect(inspection.additions).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						displayName: "Authored Box",
						kind: "mesh",
						serializedMeshSummary: expect.objectContaining({ meshCount: 1, geometryCount: 1, byteLength: expect.any(Number) }),
					}),
					expect.objectContaining({ displayName: "Nested Live", kind: "nestedPrefab", prefabPath: "nested.prefab" }),
				])
			);
			const captured = await capturePrefabInstanceStructure(scene, { nodeId: outerRoot.id, expectedRevision: inspection.revision, confirm: true }, options);
			expect(captured).toMatchObject({ captured: true, capturedCounts: { removals: 0, additions: 2, reparents: 0 } });
			const after = await inspectPrefabInstanceStructure(scene, { nodeId: outerRoot.id });
			expect(after).toMatchObject({ additions: [], blockers: [], hasStructuralOverrides: false });
			expect(nestedRoot.metadata.prefab).toMatchObject({
				path: "variant.prefab",
				instanceId: outerRoot.metadata.prefab.instanceId,
				links: [expect.objectContaining({ path: "variant.prefab" }), expect.objectContaining({ path: "nested.prefab", sourceNodeName: "NestedRoot" })],
			});
			const nestedLeaf = nestedRoot.getDescendants(false)[0] as any;
			expect(nestedLeaf.metadata.prefab.links[0]).toMatchObject({ path: "variant.prefab" });

			const reloaded = await instantiatePrefab(scene, { path: "variant.prefab", name: "Reloaded" }, options);
			const reloadedRoot = scene.getMeshById(reloaded.root.id)!;
			const reloadedBox = reloadedRoot.getDescendants(false).find((node: any) => node.name === "Authored Box") as any;
			const reloadedNested = reloadedRoot.getDescendants(false).find((node: any) => node.name === "Nested Live") as any;
			expect(reloadedBox.getTotalVertices()).toBeGreaterThan(0);
			expect(reloadedBox.position.asArray()).toEqual([5, 6, 7]);
			expect(reloadedNested.metadata.prefab.links).toEqual(
				expect.arrayContaining([expect.objectContaining({ path: "variant.prefab" }), expect.objectContaining({ path: "nested.prefab" })])
			);
		} finally {
			scene.dispose();
			engine.dispose();
		}
	});
});
