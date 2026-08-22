import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NodeParticleSystemSet, NullEngine, Scene } from "babylonjs";

vi.mock("babylonjs-editor-tools", async () => await import("../../../tools/src/loading/vfx-batch-release"));

import { NodeParticleSystemSetMesh } from "../../src/editor/nodes/node-particle-system";
import { getNodeParticleBatchRelease, setNodeParticleBatchRelease } from "../../src/mcp/particles/batch-release";

describe("mcp/vfx-batch-release-65", () => {
	let engine: NullEngine;
	let scene: Scene;
	let node: NodeParticleSystemSetMesh;
	const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

	beforeEach(async () => {
		engine = new NullEngine();
		scene = new Scene(engine);
		node = new NodeParticleSystemSetMesh("Release VFX", scene);
		const graph = NodeParticleSystemSet.CreateDefault("Release VFX");
		for (const systemBlock of graph.systemBlocks) {
			(graph as any)._initializeBlock(systemBlock);
		}
		const textureBlock = graph.attachedBlocks.find((block) => block.getClassName() === "ParticleTextureSourceBlock") as any;
		textureBlock.url = "";
		await node.buildNodeParticleSystemSet({ ...graph.serialize(), id: "release-vfx", uniqueId: 8112 });
		graph.dispose();
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
		vi.clearAllMocks();
	});

	test("exactly configures, serializes, releases, and rebuilds the live batch", async () => {
		const inspected = getNodeParticleBatchRelease(scene, { nodeId: node.id }) as any;
		expect(inspected).toMatchObject({ policyEnabled: false, state: "active", batchPresent: true, systemCount: 1 });
		const configured = (await setNodeParticleBatchRelease(scene, { nodeId: node.id, expectedRevision: inspected.revision, releaseOnDisable: true }, options)) as any;
		expect(configured).toMatchObject({ policyEnabled: true, state: "active" });
		expect(node.serialize().releaseVfxBatchOnDisable).toBe(true);
		await expect(setNodeParticleBatchRelease(scene, { nodeId: node.id, expectedRevision: inspected.revision, releaseOnDisable: false }, options)).rejects.toThrow(
			"changed after inspection"
		);

		const previousBatch = node.particleSystemSet;
		node.setEnabled(false);
		await vi.waitFor(() => expect((getNodeParticleBatchRelease(scene, { nodeId: node.id }) as any).state).toBe("released"));
		expect(node.particleSystemSet).toBeNull();
		expect(previousBatch?.systems).toHaveLength(0);

		node.setEnabled(true);
		await vi.waitFor(() => expect((getNodeParticleBatchRelease(scene, { nodeId: node.id }) as any).state).toBe("active"));
		expect(node.particleSystemSet).not.toBe(previousBatch);
		expect(node.particleSystemSet?.systems).toHaveLength(1);
		expect(getNodeParticleBatchRelease(scene, { nodeId: node.id })).toMatchObject({ releaseCount: 1, rebuildCount: 1, batchPresent: true });
	});

	test("retains the batch while disabled when the policy is off", async () => {
		node.setEnabled(false);
		await vi.waitFor(() => expect((getNodeParticleBatchRelease(scene, { nodeId: node.id }) as any).state).toBe("retained-disabled"));
		expect(node.particleSystemSet?.systems).toHaveLength(1);
	});
});
