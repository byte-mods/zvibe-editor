import { afterEach, describe, expect, test } from "vitest";

import {
	createDefaultScriptableAudioGeneratorGraph,
	getScriptableAudioDependencyPaths,
	IScriptableAudioGeneratorGraph,
	listScriptableAudioGeneratorTypes,
	normalizeScriptableAudioGeneratorDraftGraph,
	normalizeScriptableAudioGeneratorGraph,
	registerScriptableAudioGenerator,
	ScriptableAudioGeneratorRuntime,
	serializeScriptableAudioRuntimeFingerprintInput,
	validateScriptableAudioGeneratorGraph,
} from "../../src/loading/scriptable-audio";

const unregister: Array<() => void> = [];

afterEach(() => {
	unregister.splice(0).forEach((dispose) => dispose());
});

function graphWith(nodes: IScriptableAudioGeneratorGraph["nodes"], edges: IScriptableAudioGeneratorGraph["edges"], changes: Partial<IScriptableAudioGeneratorGraph> = {}) {
	return {
		version: 1 as const,
		revision: 1,
		name: "Test Generator",
		sampleRate: 8_000,
		channels: 1,
		durationSeconds: 0.01,
		streaming: false,
		seed: 42,
		outputNodeId: "output",
		nodes,
		edges,
		...changes,
	};
}

const outputNode = { id: "output", name: "Output", type: "output" as const, position: [400, 100] as [number, number], enabled: true, data: {} };

describe("loading/scriptable audio", () => {
	test("normalizes the default graph and lists built-in generator types", () => {
		const graph = normalizeScriptableAudioGeneratorGraph(createDefaultScriptableAudioGeneratorGraph());
		expect(graph).toMatchObject({ version: 1, revision: 1, sampleRate: 48_000, channels: 2, outputNodeId: "output" });
		expect(
			listScriptableAudioGeneratorTypes()
				.filter((type) => type.builtIn)
				.map((type) => type.id)
		).toEqual(["audioClip", "gain", "mix", "noise", "oscillator", "output", "random", "sequence"]);
	});

	test("extracts only exact AudioClip leaf dependencies in stable order", () => {
		const graph = graphWith(
			[
				{ id: "second", name: "Second", type: "audioClip", position: [0, 0], enabled: true, data: { path: "assets/z.wav" } },
				{ id: "first", name: "First", type: "audioClip", position: [0, 100], enabled: true, data: { path: "assets/a.wav" } },
				{ id: "duplicate", name: "Duplicate", type: "audioClip", position: [0, 200], enabled: true, data: { path: "assets/z.wav" } },
				{
					id: "custom",
					name: "Custom",
					type: "custom",
					position: [0, 300],
					enabled: false,
					data: { generatorType: "project.asset", dataVersion: 1, parameters: { path: "assets/not-a-leaf.wav" } },
				},
				{ id: "mix", name: "Mix", type: "mix", position: [200, 100], enabled: true, data: {} },
				outputNode,
			],
			[
				{ id: "second-mix", sourceNodeId: "second", targetNodeId: "mix", order: 0, gain: 1 },
				{ id: "first-mix", sourceNodeId: "first", targetNodeId: "mix", order: 1, gain: 1 },
				{ id: "duplicate-mix", sourceNodeId: "duplicate", targetNodeId: "mix", order: 2, gain: 1 },
				{ id: "custom-mix", sourceNodeId: "custom", targetNodeId: "mix", order: 3, gain: 1 },
				{ id: "mix-output", sourceNodeId: "mix", targetNodeId: "output", order: 0, gain: 1 },
			]
		);
		expect(getScriptableAudioDependencyPaths(graph)).toEqual(["assets/a.wav", "assets/z.wav"]);
	});

	test("serializes stable exact build fingerprint evidence", () => {
		const result = serializeScriptableAudioRuntimeFingerprintInput("graph-hash", [
			{ path: "assets/z.wav", contentHash: "z-hash", sizeBytes: 2 },
			{ path: "assets/a.wav", contentHash: "a-hash", sizeBytes: 1 },
		]);
		expect(JSON.parse(result)).toEqual({
			version: 1,
			kind: "audio-generator",
			contentHash: "graph-hash",
			dependencies: [
				{ path: "assets/a.wav", contentHash: "a-hash", sizeBytes: 1 },
				{ path: "assets/z.wav", contentHash: "z-hash", sizeBytes: 2 },
			],
		});
	});

	test("rejects unsafe paths, feedback cycles, and oversized static output", () => {
		const clipGraph = graphWith(
			[{ id: "clip", name: "Clip", type: "audioClip", position: [0, 0], enabled: true, data: { path: "../voice.wav" } }, outputNode],
			[{ id: "clip-output", sourceNodeId: "clip", targetNodeId: "output", order: 0, gain: 1 }]
		);
		expect(validateScriptableAudioGeneratorGraph(clipGraph).errors[0]).toMatch(/project-relative/);
		clipGraph.nodes[0].data.path = "https://example.com/voice.wav";
		expect(validateScriptableAudioGeneratorGraph(clipGraph).errors[0]).toMatch(/project-relative/);

		const cyclic = graphWith(
			[
				{ id: "gain", name: "Gain", type: "gain", position: [0, 0], enabled: true, data: {} },
				{ id: "mix", name: "Mix", type: "mix", position: [200, 0], enabled: true, data: {} },
				outputNode,
			],
			[
				{ id: "gain-mix", sourceNodeId: "gain", targetNodeId: "mix", order: 0, gain: 1 },
				{ id: "mix-gain", sourceNodeId: "mix", targetNodeId: "gain", order: 0, gain: 1 },
				{ id: "mix-output", sourceNodeId: "mix", targetNodeId: "output", order: 1, gain: 1 },
			]
		);
		expect(validateScriptableAudioGeneratorGraph(cyclic).errors[0]).toMatch(/feedback cycles/);

		const oversized = { ...createDefaultScriptableAudioGeneratorGraph(), durationSeconds: 3_600, sampleRate: 192_000, channels: 8 };
		expect(validateScriptableAudioGeneratorGraph(oversized).errors[0]).toMatch(/enable streaming/);

		const malformed = createDefaultScriptableAudioGeneratorGraph();
		malformed.nodes[0].data.frequency = "fast";
		expect(validateScriptableAudioGeneratorGraph(malformed).errors[0]).toMatch(/frequency must be a finite number/);
	});

	test("allows incomplete editor drafts while retaining structural and cycle safety", () => {
		const draft = createDefaultScriptableAudioGeneratorGraph();
		draft.nodes.push({ id: "gain", name: "Gain", type: "gain", position: [200, 300], enabled: true, data: { gain: 1 } });
		expect(normalizeScriptableAudioGeneratorDraftGraph(draft).nodes).toHaveLength(3);
		expect(() => normalizeScriptableAudioGeneratorGraph(draft)).toThrow(/requires exactly one input edge/);

		draft.edges.push({ id: "gain-output", sourceNodeId: "gain", targetNodeId: "output", order: 1, gain: 1 });
		expect(() => normalizeScriptableAudioGeneratorDraftGraph(draft)).toThrow(/requires exactly one input edge/);
	});

	test("renders seek-stable oscillator and white noise blocks", async () => {
		const graph = graphWith(
			[
				{ id: "osc", name: "Osc", type: "oscillator", position: [0, 0], enabled: true, data: { waveform: "sine", frequency: 1_000, amplitude: 0.5 } },
				{ id: "noise", name: "Noise", type: "noise", position: [0, 100], enabled: true, data: { amplitude: 0.05 } },
				{ id: "mix", name: "Mix", type: "mix", position: [200, 50], enabled: true, data: {} },
				outputNode,
			],
			[
				{ id: "osc-mix", sourceNodeId: "osc", targetNodeId: "mix", order: 0, gain: 1 },
				{ id: "noise-mix", sourceNodeId: "noise", targetNodeId: "mix", order: 1, gain: 1 },
				{ id: "mix-output", sourceNodeId: "mix", targetNodeId: "output", order: 0, gain: 1 },
			]
		);
		const runtime = await ScriptableAudioGeneratorRuntime.CreateAsync(graph, { loadAudioClip: async () => Promise.reject(new Error("unused")) });
		const first = runtime.renderFrames(8, 32)[0];
		expect(runtime.renderFrames(8, 32)[0]).toEqual(first);
		expect(Math.max(...first.map(Math.abs))).toBeGreaterThan(0.45);
		runtime.dispose();
	});

	test("decodes an AudioClip leaf with interpolation, looping, gain, and mono downmix", async () => {
		const graph = graphWith(
			[{ id: "clip", name: "Clip", type: "audioClip", position: [0, 0], enabled: true, data: { path: "assets/voice.wav", loop: true, gain: 0.5 } }, outputNode],
			[{ id: "clip-output", sourceNodeId: "clip", targetNodeId: "output", order: 0, gain: 1 }]
		);
		const runtime = await ScriptableAudioGeneratorRuntime.CreateAsync(graph, {
			loadAudioClip: async (path) => {
				expect(path).toBe("assets/voice.wav");
				return { sampleRate: 8_000, channels: [Float32Array.from([1, 0, -1, 0]), Float32Array.from([0, 1, 0, -1])] };
			},
		});
		expect([...runtime.renderFrames(0, 8)[0]]).toEqual([0.25, 0.25, -0.25, -0.25, 0.25, 0.25, -0.25, -0.25]);
	});

	test("renders sequence timing and random-container choices identically across block boundaries", async () => {
		const graph = graphWith(
			[
				{ id: "positive", name: "Positive", type: "oscillator", position: [0, 0], enabled: true, data: { waveform: "square", frequency: 0, amplitude: 0.25 } },
				{
					id: "negative",
					name: "Negative",
					type: "oscillator",
					position: [0, 100],
					enabled: true,
					data: { waveform: "square", frequency: 0, amplitude: 0.5, phase: Math.PI },
				},
				{ id: "sequence", name: "Sequence", type: "sequence", position: [160, 0], enabled: true, data: {} },
				{ id: "random", name: "Random", type: "random", position: [160, 120], enabled: true, data: { intervalSeconds: 0.002 } },
				{ id: "mix", name: "Mix", type: "mix", position: [300, 60], enabled: true, data: {} },
				outputNode,
			],
			[
				{ id: "positive-sequence", sourceNodeId: "positive", targetNodeId: "sequence", order: 0, gain: 1, durationSeconds: 0.005 },
				{ id: "negative-sequence", sourceNodeId: "negative", targetNodeId: "sequence", order: 1, gain: 1, durationSeconds: 0.005 },
				{ id: "positive-random", sourceNodeId: "positive", targetNodeId: "random", order: 0, gain: 1 },
				{ id: "negative-random", sourceNodeId: "negative", targetNodeId: "random", order: 1, gain: 1 },
				{ id: "sequence-mix", sourceNodeId: "sequence", targetNodeId: "mix", order: 0, gain: 1 },
				{ id: "random-mix", sourceNodeId: "random", targetNodeId: "mix", order: 1, gain: 0.25 },
				{ id: "mix-output", sourceNodeId: "mix", targetNodeId: "output", order: 0, gain: 1 },
			]
		);
		const wholeRuntime = await ScriptableAudioGeneratorRuntime.CreateAsync(graph, { loadAudioClip: async () => Promise.reject(new Error("unused")) });
		const chunkRuntime = await ScriptableAudioGeneratorRuntime.CreateAsync(graph, { loadAudioClip: async () => Promise.reject(new Error("unused")) });
		const whole = wholeRuntime.renderFrames(0, 80)[0];
		const chunks = new Float32Array(80);
		chunks.set(chunkRuntime.renderFrames(0, 31)[0], 0);
		chunks.set(chunkRuntime.renderFrames(31, 49)[0], 31);
		expect(chunks).toEqual(whole);
		expect(whole[0]).not.toBe(whole[79]);
	});

	test("runs custom generator validation, create, process, seek, finish, and destroy lifecycle", async () => {
		const lifecycle: string[] = [];
		unregister.push(
			registerScriptableAudioGenerator<{ value: number }, { position: number }>({
				id: "project.constant",
				displayName: "Project Constant",
				dataVersion: 1,
				setDefaultValues: () => ({ value: 0.25 }),
				validate: ({ data }) => (typeof data.value === "number" ? true : "value must be numeric"),
				create: () => {
					lifecycle.push("create");
					return { position: 0 };
				},
				setPosition: (frame, _context, state) => {
					lifecycle.push(`seek:${frame}`);
					state.position = frame;
				},
				process: ({ output, frameCount, data }, state) => {
					lifecycle.push(`process:${state.position}:${frameCount}`);
					output.forEach((channel) => channel.fill(data.value));
					state.position += frameCount;
					return { processedFrames: frameCount, isFinished: state.position >= 10 };
				},
				destroy: () => lifecycle.push("destroy"),
			})
		);
		const graph = graphWith(
			[
				{
					id: "custom",
					name: "Custom",
					type: "custom",
					position: [0, 0],
					enabled: true,
					data: { generatorType: "project.constant", dataVersion: 1, parameters: { value: 0.75 } },
				},
				outputNode,
			],
			[{ id: "custom-output", sourceNodeId: "custom", targetNodeId: "output", order: 0, gain: 1 }]
		);
		const runtime = await ScriptableAudioGeneratorRuntime.CreateAsync(graph, { loadAudioClip: async () => Promise.reject(new Error("unused")) });
		expect(listScriptableAudioGeneratorTypes().find((type) => type.id === "project.constant")).toMatchObject({
			builtIn: false,
			supportsSeeking: true,
			defaultData: { value: 0.25 },
		});
		expect([...runtime.renderFrames(0, 6)[0]]).toEqual(Array(6).fill(0.75));
		expect([...runtime.renderFrames(6, 4)[0]]).toEqual(Array(4).fill(0.75));
		expect(runtime.finishedNodeIds).toEqual(["custom"]);
		expect([...runtime.renderFrames(2, 2)[0]]).toEqual([0.75, 0.75]);
		expect(runtime.finishedNodeIds).toEqual([]);
		runtime.dispose();
		runtime.dispose();
		expect(lifecycle).toEqual(["create", "process:0:6", "process:6:4", "seek:2", "process:2:2", "destroy"]);
	});

	test("contains custom callback failures as silence with bounded diagnostics", async () => {
		unregister.push(
			registerScriptableAudioGenerator({
				id: "project.failure",
				dataVersion: 1,
				process: () => {
					throw new Error("intentional generator failure");
				},
			})
		);
		const graph = graphWith(
			[
				{ id: "failure", name: "Failure", type: "custom", position: [0, 0], enabled: true, data: { generatorType: "project.failure", dataVersion: 1, parameters: {} } },
				outputNode,
			],
			[{ id: "failure-output", sourceNodeId: "failure", targetNodeId: "output", order: 0, gain: 1 }]
		);
		const runtime = await ScriptableAudioGeneratorRuntime.CreateAsync(graph, { loadAudioClip: async () => Promise.reject(new Error("unused")) });
		expect([...runtime.renderFrames(0, 8)[0]]).toEqual(Array(8).fill(0));
		expect(runtime.diagnostics).toEqual([{ nodeId: "failure", severity: "error", message: "intentional generator failure", frame: 0 }]);
	});

	test("rolls back created custom states when a later generator cannot initialize", async () => {
		const lifecycle: string[] = [];
		unregister.push(
			registerScriptableAudioGenerator({
				id: "project.created-first",
				dataVersion: 1,
				create: () => lifecycle.push("create"),
				process: () => undefined,
				destroy: () => lifecycle.push("destroy"),
			})
		);
		const graph = graphWith(
			[
				{ id: "first", name: "First", type: "custom", position: [0, 0], enabled: true, data: { generatorType: "project.created-first", dataVersion: 1, parameters: {} } },
				{ id: "missing", name: "Missing", type: "custom", position: [0, 100], enabled: true, data: { generatorType: "project.missing", dataVersion: 1, parameters: {} } },
				{ id: "mix", name: "Mix", type: "mix", position: [200, 50], enabled: true, data: {} },
				outputNode,
			],
			[
				{ id: "first-mix", sourceNodeId: "first", targetNodeId: "mix", order: 0, gain: 1 },
				{ id: "missing-mix", sourceNodeId: "missing", targetNodeId: "mix", order: 1, gain: 1 },
				{ id: "mix-output", sourceNodeId: "mix", targetNodeId: "output", order: 0, gain: 1 },
			]
		);
		await expect(ScriptableAudioGeneratorRuntime.CreateAsync(graph, { loadAudioClip: async () => Promise.reject(new Error("unused")) })).rejects.toThrow(
			/ project\.missing|"project\.missing"/
		);
		expect(lifecycle).toEqual(["create", "destroy"]);
	});

	test("repairs non-finite and out-of-range custom samples and rejects malformed callback results", async () => {
		unregister.push(
			registerScriptableAudioGenerator({
				id: "project.unsafe-samples",
				dataVersion: 1,
				process: ({ output }) => {
					output[0].set([Number.NaN, Number.POSITIVE_INFINITY, 2, -2]);
				},
			}),
			registerScriptableAudioGenerator({
				id: "project.invalid-result",
				dataVersion: 1,
				process: () => ({ processedFrames: Number.NaN }),
			})
		);
		const createGraph = (generatorType: string) =>
			graphWith(
				[{ id: "custom", name: "Custom", type: "custom", position: [0, 0], enabled: true, data: { generatorType, dataVersion: 1, parameters: {} } }, outputNode],
				[{ id: "custom-output", sourceNodeId: "custom", targetNodeId: "output", order: 0, gain: 1 }]
			);
		const samples = await ScriptableAudioGeneratorRuntime.CreateAsync(createGraph("project.unsafe-samples"), {
			loadAudioClip: async () => Promise.reject(new Error("unused")),
		});
		expect([...samples.renderFrames(0, 4)[0]]).toEqual([0, 0, 1, -1]);
		expect(samples.diagnostics[0]).toMatchObject({ nodeId: "custom", severity: "warning", frame: 0 });

		const result = await ScriptableAudioGeneratorRuntime.CreateAsync(createGraph("project.invalid-result"), { loadAudioClip: async () => Promise.reject(new Error("unused")) });
		expect([...result.renderFrames(0, 4)[0]]).toEqual([0, 0, 0, 0]);
		expect(result.diagnostics[0].message).toMatch(/invalid processedFrames/);
	});
});
