import { tmpdir } from "os";
import { join } from "path/posix";

import { FreeCamera, Mesh, MeshBuilder, NullEngine, Scene, StandardMaterial, TransformNode, Vector3 } from "babylonjs";
import { ALEMBIC_OBJECT_METADATA_KEY, ALEMBIC_PLAYER_METADATA_KEY } from "babylonjs-editor-tools";
import { mkdir, mkdtemp, pathExists, readJSON, remove } from "fs-extra";
import { afterEach, describe, expect, test, vi } from "vitest";

import { EditorSceneWorkspace } from "../../src/project/scene-workspace-runtime";

vi.mock("../../src/project/save/dialog", () => ({
	showSaveSceneProgressDialog: async () => ({ step: vi.fn(), setName: vi.fn(), dispose: vi.fn() }),
}));

import { saveScene } from "../../src/project/save/scene";

const cleanupPaths: string[] = [];
const scenes: Scene[] = [];

afterEach(async () => {
	scenes.splice(0).forEach((scene) => scene.dispose());
	await Promise.all(cleanupPaths.splice(0).map((path) => remove(path)));
});

describe("project/save additive scene integration", () => {
	test("writes only the target scene nodes and preserves its non-lighting global configuration", async () => {
		const projectDirectory = await mkdtemp(join(tmpdir(), "zvibe-additive-save-"));
		cleanupPaths.push(projectDirectory);
		const sceneAPath = join(projectDirectory, "assets/A.scene");
		const sceneBPath = join(projectDirectory, "assets/B.scene");
		await Promise.all([mkdir(sceneAPath, { recursive: true }), mkdir(sceneBPath, { recursive: true })]);

		const scene = new Scene(new NullEngine());
		scenes.push(scene);
		const nodeA = new TransformNode("A", scene);
		nodeA.id = "A-node";
		const nodeB = new TransformNode("B", scene);
		nodeB.id = "B-node";
		const meshA = MeshBuilder.CreateBox("A Mesh", { size: 1 }, scene);
		meshA.id = "shared-mesh-id";
		const meshB = MeshBuilder.CreateBox("B Mesh", { size: 2 }, scene);
		meshB.id = "shared-mesh-id";
		const emptyMeshB = new Mesh("B Empty Mesh", scene);
		emptyMeshB.id = "empty-mesh-id";
		const alembicRoot = new TransformNode("Alembic Root", scene);
		alembicRoot.id = "alembic-root-id";
		alembicRoot.metadata = {
			[ALEMBIC_PLAYER_METADATA_KEY]: { version: 1, id: alembicRoot.id, name: alembicRoot.name, assetPath: "assets/cache.abc", revision: 3 },
		};
		const generatedAlembicMesh = MeshBuilder.CreateBox("Generated Alembic Mesh", { size: 3 }, scene);
		generatedAlembicMesh.id = "generated-alembic-mesh-id";
		generatedAlembicMesh.parent = alembicRoot;
		generatedAlembicMesh.metadata = { [ALEMBIC_OBJECT_METADATA_KEY]: { version: 1, objectId: "mesh-0" } };
		const generatedAlembicCamera = new FreeCamera("Generated Alembic Camera", Vector3.Zero(), scene);
		generatedAlembicCamera.id = "generated-alembic-camera-id";
		generatedAlembicCamera.parent = alembicRoot;
		generatedAlembicCamera.metadata = { [ALEMBIC_OBJECT_METADATA_KEY]: { version: 1, objectId: "camera-0" } };
		const sharedMaterial = new StandardMaterial("Shared Material", scene);
		sharedMaterial.id = "shared-material";
		meshA.material = sharedMaterial;
		meshB.material = sharedMaterial;
		const camera = new FreeCamera("Editor Camera", Vector3.Zero(), scene);
		const sceneWorkspace = new EditorSceneWorkspace();
		sceneWorkspace.configure({
			version: 1,
			loadedScenes: ["assets/A.scene", "assets/B.scene"],
			activeScene: "assets/A.scene",
			lightingScene: "assets/A.scene",
		});
		sceneWorkspace.claimObjects("assets/A.scene", [nodeA, meshA, meshA.geometry!, sharedMaterial]);
		sceneWorkspace.claimObjects("assets/B.scene", [
			nodeB,
			meshB,
			meshB.geometry!,
			emptyMeshB,
			alembicRoot,
			generatedAlembicMesh,
			generatedAlembicMesh.geometry!,
			generatedAlembicCamera,
		]);
		sceneWorkspace.setLoadedSceneHandle("assets/A.scene", { configuration: {}, dispose: vi.fn() });
		sceneWorkspace.setLoadedSceneHandle("assets/B.scene", {
			configuration: {
				clearColor: [1, 0, 0, 1],
				ambientColor: [0.25, 0.25, 0.25],
				metadata: { owner: "B" },
				environment: { environmentIntensity: 0.5 },
				fog: { fogEnabled: false },
				physics: { gravity: [0, -981, 0] },
				editorCamera: { name: "B editor camera" },
				clusteredLight: { horizontalTiles: 12, lights: [] },
			},
			dispose: vi.fn(),
		});

		const editor = {
			sceneWorkspace,
			state: { scriptExecutionOrders: {} },
			layout: {
				preview: {
					scene,
					camera,
					clusteredLightContainer: { lights: [], maxRange: 1000, depthSlices: 16, verticalTiles: 8, horizontalTiles: 8 },
				},
				console: { error: vi.fn(), warn: vi.fn(), log: vi.fn() },
			},
		} as any;

		await saveScene(editor, projectDirectory, sceneBPath, { ownerScenePath: "assets/B.scene" });

		expect(await pathExists(join(sceneBPath, "nodes/B-node.json"))).toBe(true);
		expect(await pathExists(join(sceneBPath, "nodes/A-node.json"))).toBe(false);
		const serializedMesh = await readJSON(join(sceneBPath, "meshes/shared-mesh-id.json"));
		expect(serializedMesh.meshes[0].name).toBe("B Mesh");
		expect(serializedMesh.meshes[0].boundingBoxMaximum).toEqual([1, 1, 1]);
		expect(serializedMesh.materials).toContainEqual(expect.objectContaining({ id: "shared-material" }));
		const editableSource = serializedMesh.meshes[0].metadata.babylonEditorEditableMeshSource;
		expect(editableSource).toMatchObject({
			version: 1,
			model: "unity-editable-source-generated-export-v1",
			revision: 1,
			exportSettingsRevision: 1,
			exportSettings: { optimize: true },
			lastGenerated: {
				file: "generatedGeometries/shared-mesh-id.babylonbinarymeshdata",
				sourceFingerprint: expect.stringMatching(/^mesh-editable-source-fnv32x2-v1:/),
				generatedFingerprint: expect.stringMatching(/^mesh-editable-source-fnv32x2-v1:/),
			},
		});
		expect(await pathExists(join(sceneBPath, "geometries", `${meshB.geometry!.id}.babylonbinarymeshdata`))).toBe(true);
		expect(await pathExists(join(sceneBPath, editableSource.lastGenerated.file))).toBe(true);
		const serializedEmptyMesh = await readJSON(join(sceneBPath, "meshes/empty-mesh-id.json"));
		expect(serializedEmptyMesh.meshes[0]).toMatchObject({ id: "empty-mesh-id", name: "B Empty Mesh" });
		expect(serializedEmptyMesh.meshes[0].metadata?.babylonEditorEditableMeshSource).toBeUndefined();
		const serializedAlembicRoot = await readJSON(join(sceneBPath, "nodes/alembic-root-id.json"));
		expect(serializedAlembicRoot.metadata[ALEMBIC_PLAYER_METADATA_KEY]).toMatchObject({ id: "alembic-root-id", assetPath: "assets/cache.abc", revision: 3 });
		expect(await pathExists(join(sceneBPath, "meshes/generated-alembic-mesh-id.json"))).toBe(false);
		expect(await pathExists(join(sceneBPath, "cameras/generated-alembic-camera-id.json"))).toBe(false);
		const configuration = await readJSON(join(sceneBPath, "config.json"));
		expect(configuration).toMatchObject({
			clearColor: [1, 0, 0, 1],
			metadata: { owner: "B" },
			clusteredLight: { horizontalTiles: 12, lights: [] },
		});
	});
});
