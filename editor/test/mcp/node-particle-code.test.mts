import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NodeParticleBlockConnectionPointTypes, NodeParticleSystemSet, NullEngine, ParticleInputBlock, Scene } from "babylonjs";

vi.mock("babylonjs-editor-tools", async () => await import("../../../tools/src/loading/vfx-batch-release"));

import { NodeParticleSystemSetMesh } from "../../src/editor/nodes/node-particle-system";
import { deleteNode } from "../../src/mcp/nodes/nodes";
import { instantiateParticleSystem } from "../../src/mcp/particles/particles";
import { OWNED_PARTICLE_EMITTER_METADATA_KEY } from "../../src/mcp/particles/emitter";
import {
	connectNodeParticleBlocks,
	disconnectNodeParticleBlocks,
	getNodeParticleCodeGraph,
	setNodeParticleBlockInput,
	validateNodeParticleCodeGraph,
} from "../../src/mcp/particles/node-particle-code";

describe("mcp/node-particle-code", () => {
	let engine: NullEngine;
	let scene: Scene;
	let node: NodeParticleSystemSetMesh;
	const options = {
		editor: {
			layout: {
				graph: { refresh: vi.fn(async () => undefined), setSelectedNode: vi.fn() },
				inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() },
			},
		},
	} as any;

	beforeEach(async () => {
		engine = new NullEngine();
		scene = new Scene(engine);
		node = new NodeParticleSystemSetMesh("VFX Graph", scene);
		const graph = NodeParticleSystemSet.CreateDefault("VFX Graph");
		for (const systemBlock of graph.systemBlocks) {
			(graph as any)._initializeBlock(systemBlock);
		}
		const textureBlock = graph.attachedBlocks.find((block) => block.getClassName() === "ParticleTextureSourceBlock") as any;
		textureBlock.url = "";
		const testEmitRate = new ParticleInputBlock("Test emit rate", NodeParticleBlockConnectionPointTypes.Int);
		testEmitRate.value = 12;
		graph.attachedBlocks.push(testEmitRate);
		await node.buildNodeParticleSystemSet({ ...graph.serialize(), id: "vfx-graph", uniqueId: 7001 });
		graph.dispose();
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
		vi.clearAllMocks();
	});

	test("returns a bounded typed visual graph with reachability, edges, systems, and fingerprint", () => {
		const graph = getNodeParticleCodeGraph(scene, { nodeId: node.id, offset: 0, limit: 256 }) as any;
		expect(graph.nodes.length).toBeGreaterThan(0);
		expect(graph.edgeCount).toBeGreaterThan(0);
		expect(graph.systemBlockCount).toBeGreaterThan(0);
		expect(graph.reachableBlockCount).toBeGreaterThan(0);
		expect(graph.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ inputs: expect.any(Array), outputs: expect.any(Array) })]));
		expect(graph.fingerprint).toMatch(/^[a-f0-9]{64}$/);
	});

	test("creates a default buildable Node Particle graph through the shared particle MCP backend", async () => {
		options.editor.layout.graph.refresh.mockReturnValueOnce(new Promise(() => undefined));
		const created = (await instantiateParticleSystem(scene, { type: "node", name: "MCP VFX" }, options)) as any;
		const createdNode = scene.getNodeById(created.id) as NodeParticleSystemSetMesh;
		expect(createdNode).toBeInstanceOf(NodeParticleSystemSetMesh);
		const graph = getNodeParticleCodeGraph(scene, { nodeId: created.id, limit: 256 }) as any;
		expect(graph.nodes.length).toBeGreaterThan(0);
		expect(graph.systemBlockCount).toBe(1);
		expect(createdNode.particleSystemSet?.systems.length).toBe(1);
	});

	test("deletes the generated emitter with an instantiated Node Particle graph", async () => {
		const created = (await instantiateParticleSystem(scene, { type: "node", name: "Disposable MCP VFX" }, options)) as any;
		const createdNode = scene.getNodeById(created.id) as NodeParticleSystemSetMesh;
		const emitter = createdNode.parent!;
		expect(emitter.metadata?.[OWNED_PARTICLE_EMITTER_METADATA_KEY]).toBe(true);

		deleteNode(scene, { nodeId: created.id }, options);

		expect(scene.getNodeById(created.id)).toBeNull();
		expect(scene.getNodeById(emitter.id)).toBeNull();
	});

	test("sets an exact disconnected embedded input and atomically rebuilds the live particle set", async () => {
		options.editor.layout.graph.refresh.mockReturnValueOnce(new Promise(() => undefined));
		const set = node.nodeParticleSystemSet!;
		const candidate = set.attachedBlocks
			.flatMap((block) => block.inputs.map((input) => ({ block, input })))
			.find(({ input }) => !input.isConnected && typeof input.value === "number");
		expect(candidate).toBeDefined();
		const next = Number(candidate!.input.value) + 0.25;
		const beforeSet = node.particleSystemSet;
		const result = (await setNodeParticleBlockInput(scene, { nodeId: node.id, blockId: candidate!.block.uniqueId, input: candidate!.input.name, value: next }, options)) as any;
		const updated = node
			.nodeParticleSystemSet!.attachedBlocks.find((block) => block.name === candidate!.block.name)!
			.inputs.find((input) => input.name === candidate!.input.name)!;
		expect(updated.value).toBe(next);
		expect(node.particleSystemSet).not.toBe(beforeSet);
		expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
	});

	test("connects and disconnects a compatible optional edge through successful complete rebuilds", async () => {
		const set = node.nodeParticleSystemSet!;
		let match: { source: any; output: any; target: any; input: any } | undefined;
		for (const source of set.attachedBlocks) {
			for (const output of source.outputs) {
				for (const target of set.attachedBlocks) {
					const input = target.inputs.find((port) => target !== source && !port.isConnected && port.isOptional && output.canConnectTo(port));
					if (input) {
						match = { source, output, target, input };
						break;
					}
				}
				if (match) break;
			}
			if (match) break;
		}
		expect(match).toBeDefined();
		const connected = (await connectNodeParticleBlocks(
			scene,
			{
				nodeId: node.id,
				sourceBlockId: match!.source.uniqueId,
				sourceOutput: match!.output.name,
				targetBlockId: match!.target.uniqueId,
				targetInput: match!.input.name,
			},
			options
		)) as any;
		expect(connected.edges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sourceBlockName: match!.source.name,
					sourceOutput: match!.output.name,
					targetBlockName: match!.target.name,
					targetInput: match!.input.name,
				}),
			])
		);
		const liveTarget = node.nodeParticleSystemSet!.attachedBlocks.find((block) => block.name === match!.target.name)!;
		const liveInput = liveTarget.inputs.find((input) => input.name === match!.input.name)!;
		const liveSource = liveInput.connectedPoint!;
		const disconnected = (await disconnectNodeParticleBlocks(
			scene,
			{
				nodeId: node.id,
				sourceBlockId: liveSource.ownerBlock.uniqueId,
				sourceOutput: liveSource.name,
				targetBlockId: liveTarget.uniqueId,
				targetInput: liveInput.name,
			},
			options
		)) as any;
		expect(disconnected.edges).not.toEqual(expect.arrayContaining([expect.objectContaining({ targetBlockName: match!.target.name, targetInput: match!.input.name })]));
	});

	test("rejects a System trigger self-cycle before rebuilding the runtime set", async () => {
		const system = node.nodeParticleSystemSet!.systemBlocks[0];
		const originalGraph = node.nodeParticleSystemSet;
		const originalSystems = node.particleSystemSet;
		await expect(
			connectNodeParticleBlocks(
				scene,
				{ nodeId: node.id, sourceBlockId: system.uniqueId, sourceOutput: "system", targetBlockId: system.uniqueId, targetInput: "onStart" },
				options
			)
		).rejects.toThrow(/cycle/);
		expect(node.nodeParticleSystemSet).toBe(originalGraph);
		expect(node.particleSystemSet).toBe(originalSystems);
	});

	test("rejects stale disconnect guards without replacing the active graph", async () => {
		const graph = getNodeParticleCodeGraph(scene, { nodeId: node.id, limit: 256 }) as any;
		const edge = graph.edges[0];
		const original = node.nodeParticleSystemSet;
		await expect(
			disconnectNodeParticleBlocks(
				scene,
				{ nodeId: node.id, sourceBlockId: edge.sourceBlockId + 100000, sourceOutput: edge.sourceOutput, targetBlockId: edge.targetBlockId, targetInput: edge.targetInput },
				options
			)
		).rejects.toThrow(/changed after inspection/);
		expect(node.nodeParticleSystemSet).toBe(original);
	});

	test("builds an isolated clone and returns actionable diagnostics without replacing the active set", async () => {
		const original = node.nodeParticleSystemSet;
		const result = (await validateNodeParticleCodeGraph(scene, { nodeId: node.id })) as any;
		expect(result).toMatchObject({
			valid: true,
			errors: [],
			statistics: { blockCount: expect.any(Number), edgeCount: expect.any(Number), systemBlockCount: expect.any(Number), builtSystemCount: expect.any(Number) },
		});
		expect(result.statistics.builtSystemCount).toBeGreaterThan(0);
		expect(node.nodeParticleSystemSet).toBe(original);
	});

	test("preserves the active graph and runtime systems when a replacement graph cannot be parsed", async () => {
		const originalGraph = node.nodeParticleSystemSet;
		const originalSystems = node.particleSystemSet;
		await expect(node.buildNodeParticleSystemSet({ blocks: null, id: "broken-vfx", uniqueId: 7002 })).rejects.toThrow();
		expect(node.nodeParticleSystemSet).toBe(originalGraph);
		expect(node.particleSystemSet).toBe(originalSystems);
	});
});
