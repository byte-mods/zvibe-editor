import { describe, expect, test } from "vitest";

import { createDefaultScriptableAudioGeneratorGraph, listScriptableAudioGeneratorTypes } from "babylonjs-editor-tools";

import {
	addAudioGeneratorNode,
	AudioGeneratorDocumentHistory,
	connectAudioGeneratorNodes,
	removeAudioGeneratorEdge,
	removeAudioGeneratorNode,
	updateAudioGeneratorEdge,
	updateAudioGeneratorNode,
} from "../../src/editor/windows/audio-generator/model";

function summary(id: string) {
	return listScriptableAudioGeneratorTypes().find((candidate) => candidate.id === id)!;
}

describe("Audio Generator editor model", () => {
	test("commits node/edge authoring as bounded undoable validated snapshots", () => {
		const history = new AudioGeneratorDocumentHistory(createDefaultScriptableAudioGeneratorGraph());
		addAudioGeneratorNode(history, "gain", [240, 160], summary("gain"));
		const gain = history.graph.nodes.find((node) => node.type === "gain")!;
		const oscillator = history.graph.nodes.find((node) => node.type === "oscillator")!;
		const oldEdge = history.graph.edges[0];
		removeAudioGeneratorEdge(history, oldEdge.id);
		connectAudioGeneratorNodes(history, oscillator.id, gain.id);
		connectAudioGeneratorNodes(history, gain.id, history.graph.outputNodeId);

		expect(history.state).toMatchObject({ canUndo: true, canRedo: false, dirty: true });
		expect(history.graph.edges.map((edge) => [edge.sourceNodeId, edge.targetNodeId])).toEqual([
			[oscillator.id, gain.id],
			[gain.id, "output"],
		]);
		const after = history.graph;
		history.undo();
		expect(history.graph.edges).toHaveLength(1);
		expect(history.state.canRedo).toBe(true);
		history.redo();
		expect(history.graph).toEqual(after);
	});

	test("rejects cycles, duplicate edges, illegal source inputs, and output deletion without partial edits", () => {
		const history = new AudioGeneratorDocumentHistory(createDefaultScriptableAudioGeneratorGraph());
		addAudioGeneratorNode(history, "gain", [200, 100], summary("gain"));
		addAudioGeneratorNode(history, "mix", [300, 100], summary("mix"));
		const gain = history.graph.nodes.find((node) => node.type === "gain")!;
		const mix = history.graph.nodes.find((node) => node.type === "mix")!;
		connectAudioGeneratorNodes(history, gain.id, mix.id);
		const before = history.graph;

		expect(() => connectAudioGeneratorNodes(history, mix.id, gain.id)).toThrow(/feedback cycles/);
		expect(() => connectAudioGeneratorNodes(history, gain.id, mix.id)).toThrow(/already exists/);
		expect(() => connectAudioGeneratorNodes(history, gain.id, history.graph.nodes.find((node) => node.type === "oscillator")!.id)).toThrow(/cannot accept input edges/);
		expect(() => removeAudioGeneratorNode(history, history.graph.outputNodeId)).toThrow(/cannot be removed/);
		expect(history.graph).toEqual(before);
	});

	test("normalizes node data, positions, sequence timing, and exact reset state", () => {
		const history = new AudioGeneratorDocumentHistory(createDefaultScriptableAudioGeneratorGraph());
		addAudioGeneratorNode(history, "sequence", [200, 200], summary("sequence"));
		const sequence = history.graph.nodes.find((node) => node.type === "sequence")!;
		const oscillator = history.graph.nodes.find((node) => node.type === "oscillator")!;
		connectAudioGeneratorNodes(history, oscillator.id, sequence.id);
		const edge = history.graph.edges.find((candidate) => candidate.targetNodeId === sequence.id)!;
		updateAudioGeneratorNode(history, oscillator.id, (node) => {
			node.name = "Lead";
			node.position = [333, 444];
			node.data = { waveform: "square", frequency: 220, amplitude: 0.5, phase: 0 };
		});
		updateAudioGeneratorEdge(history, edge.id, (candidate) => {
			candidate.gain = 0.25;
			candidate.durationSeconds = 2;
		});
		expect(history.graph.nodes.find((node) => node.id === oscillator.id)).toMatchObject({ name: "Lead", position: [333, 444], data: { waveform: "square", frequency: 220 } });
		expect(history.graph.edges.find((candidate) => candidate.id === edge.id)).toMatchObject({ gain: 0.25, durationSeconds: 2 });

		const saved = { ...history.graph, revision: 2 };
		expect(history.reset(saved)).toMatchObject({ canUndo: false, canRedo: false, dirty: false, graph: { revision: 2 } });
	});

	test("creates project custom nodes with explicit generator type/version/parameter envelope", () => {
		const history = new AudioGeneratorDocumentHistory(createDefaultScriptableAudioGeneratorGraph());
		addAudioGeneratorNode(history, "custom", [100, 300], {
			id: "project.wind",
			displayName: "Wind",
			description: "Project wind generator",
			dataVersion: 3,
			builtIn: false,
			supportsSeeking: true,
			defaultData: { speed: 2 },
		});
		expect(history.graph.nodes.find((node) => node.type === "custom")).toMatchObject({
			name: "Wind",
			data: { generatorType: "project.wind", dataVersion: 3, parameters: { speed: 2 } },
		});
	});
});
