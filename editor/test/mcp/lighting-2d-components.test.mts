import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene, TransformNode } from "babylonjs";
import { getLighting2DRuntimeEvidence, getRuntimeGameObjectComponents, registerLight2DProvider, registerShadowShape2DProvider } from "babylonjs-editor-tools";

import {
	addGameObjectComponent,
	copyGameObjectComponent,
	inspectGameObjectComponents,
	listGameObjectComponentTypes,
	pasteGameObjectComponent,
	resetGameObjectComponent,
	setGameObjectComponent,
} from "../../src/mcp/components/components";
import { clearUndoRedo, undo } from "../../src/tools/undoredo";

describe("mcp/lighting-2d-components", () => {
	let engine: NullEngine;
	let scene: Scene;
	const disposals: Array<() => void> = [];
	const options = {
		editor: {
			layout: {
				inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() },
				preview: { play: null },
			},
		},
	} as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		clearUndoRedo();
	});

	afterEach(() => {
		disposals
			.splice(0)
			.reverse()
			.forEach((dispose) => dispose());
		clearUndoRedo();
		scene.dispose();
		engine.dispose();
	});

	test("authors, validates, updates, copies, resets, and materializes both component families", () => {
		const source = new TransformNode("Lighting Source", scene);
		const target = new TransformNode("Lighting Target", scene);
		const registry = listGameObjectComponentTypes(scene, { nodeId: source.id });
		expect(registry.types.find((entry: any) => entry.type === "light2d")).toMatchObject({ label: "Light 2D", allowMultiple: false, canAdd: true });
		expect(registry.types.find((entry: any) => entry.type === "shadowcaster2d")).toMatchObject({ label: "Shadow Caster 2D", allowMultiple: false, canAdd: true });

		const initial = inspectGameObjectComponents(scene, { nodeId: source.id });
		expect(() =>
			addGameObjectComponent(scene, { nodeId: source.id, expectedFingerprint: initial.fingerprint, type: "light2d", data: { unknownField: true } }, options)
		).toThrow("unknownField is not supported");
		expect(() =>
			addGameObjectComponent(
				scene,
				{ nodeId: source.id, expectedFingerprint: initial.fingerprint, type: "light2d", data: { lightType: "point", providerId: "project.wrong" } },
				options
			)
		).toThrow("must use providerId");

		const withLight = addGameObjectComponent(
			scene,
			{
				nodeId: source.id,
				expectedFingerprint: initial.fingerprint,
				type: "light2d",
				data: { lightType: "point", providerId: "builtin.point", color: [1, 0.5, 0.25, 1], intensity: 2, outerRadius: 750 },
			},
			options
		);
		const light = withLight.components.find((entry: any) => entry.type === "light2d");
		expect(light.data).toMatchObject({ model: "unity-light2d-v1", lightType: "point", intensity: 2, outerRadius: 750 });
		expect(getRuntimeGameObjectComponents(source as any).find((entry: any) => entry.type === "light2d")?.data).toMatchObject({ intensity: 2 });
		expect(() => addGameObjectComponent(scene, { nodeId: source.id, expectedFingerprint: withLight.fingerprint, type: "light2d" }, options)).toThrow(
			"does not allow duplicates"
		);

		const withCaster = addGameObjectComponent(
			scene,
			{
				nodeId: source.id,
				expectedFingerprint: withLight.fingerprint,
				type: "shadowcaster2d",
				data: { sourceType: "shape-editor", providerId: "builtin.shape-editor", castingOption: "cast-and-self-shadow", priority: 7 },
			},
			options
		);
		const caster = withCaster.components.find((entry: any) => entry.type === "shadowcaster2d");
		expect(caster.data).toMatchObject({ model: "unity-shadow-caster2d-v1", priority: 7, castingOption: "cast-and-self-shadow" });
		expect(getLighting2DRuntimeEvidence(scene as any)).toMatchObject({ configured: true, activeLightCount: 1, activeCasterCount: 1 });

		const changed = setGameObjectComponent(
			scene,
			{ nodeId: source.id, expectedFingerprint: withCaster.fingerprint, componentId: light.id, data: { intensity: 4, overlapOperation: "alpha-blend" } },
			options
		);
		expect(changed.components.find((entry: any) => entry.id === light.id).data).toMatchObject({ intensity: 4, overlapOperation: "alpha-blend" });
		expect(() =>
			setGameObjectComponent(scene, { nodeId: source.id, expectedFingerprint: changed.fingerprint, componentId: light.id, data: { intensity: "bright" } }, options)
		).toThrow();

		const copied = copyGameObjectComponent(scene, { nodeId: source.id, expectedFingerprint: changed.fingerprint, componentId: light.id });
		const targetInitial = inspectGameObjectComponents(scene, { nodeId: target.id });
		const pasted = pasteGameObjectComponent(
			scene,
			{ nodeId: target.id, expectedFingerprint: targetInitial.fingerprint, expectedClipboardFingerprint: copied.clipboardFingerprint, mode: "new" },
			options
		);
		const pastedLight = pasted.components.find((entry: any) => entry.type === "light2d");
		expect(pastedLight.data).toMatchObject({ intensity: 4, overlapOperation: "alpha-blend" });

		const reset = resetGameObjectComponent(scene, { nodeId: target.id, expectedFingerprint: pasted.fingerprint, componentId: pastedLight.id }, options);
		expect(reset.components.find((entry: any) => entry.id === pastedLight.id).data).toMatchObject({ lightType: "point", providerId: "builtin.point", intensity: 1 });
		undo();
		expect(inspectGameObjectComponents(scene, { nodeId: target.id }).components.find((entry: any) => entry.id === pastedLight.id).data.intensity).toBe(4);
	});

	test("reports valid and mismatched project providers through runtime evidence", () => {
		disposals.push(
			registerLight2DProvider({ id: "tests.editor-light", dataVersion: 2, getShape: () => ({ kind: "global" }) }),
			registerShadowShape2DProvider({
				id: "tests.editor-shadow",
				dataVersion: 1,
				onBeforeRender: (_context, writer) =>
					writer.setShape([
						[-10, -10],
						[10, -10],
						[0, 10],
					]),
			})
		);
		const node = new TransformNode("Providers", scene);
		let inspection = inspectGameObjectComponents(scene, { nodeId: node.id });
		inspection = addGameObjectComponent(
			scene,
			{
				nodeId: node.id,
				expectedFingerprint: inspection.fingerprint,
				type: "light2d",
				data: { lightType: "provider", providerId: "tests.editor-light", providerVersion: 2, providerData: {} },
			},
			options
		);
		inspection = addGameObjectComponent(
			scene,
			{
				nodeId: node.id,
				expectedFingerprint: inspection.fingerprint,
				type: "shadowcaster2d",
				data: { sourceType: "provider", providerId: "tests.editor-shadow", providerVersion: 1, providerData: {} },
			},
			options
		);
		let evidence = getLighting2DRuntimeEvidence(scene as any) as any;
		expect(evidence.providers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ providerId: "tests.editor-light", registeredVersion: 2, valid: true }),
				expect.objectContaining({ providerId: "tests.editor-shadow", registeredVersion: 1, valid: true }),
			])
		);

		const light = inspection.components.find((entry: any) => entry.type === "light2d");
		setGameObjectComponent(scene, { nodeId: node.id, expectedFingerprint: inspection.fingerprint, componentId: light.id, data: { providerVersion: 1 } }, options);
		evidence = getLighting2DRuntimeEvidence(scene as any) as any;
		expect(evidence.providers.find((entry: any) => entry.providerId === "tests.editor-light")).toMatchObject({
			registeredVersion: 2,
			providerVersion: 1,
			valid: false,
			lastError: expect.stringContaining("does not match"),
		});
	});
});
