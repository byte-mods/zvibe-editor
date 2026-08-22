import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene } from "babylonjs";

import { createAreaLight, getAreaLight, setAreaLight } from "../../src/mcp/lights/area-lights";
import { addLightToClusteredContainer, getLight, setLightProperties, setLightShadows } from "../../src/mcp/lights/lights";

describe("mcp/area-lights", () => {
	let engine: NullEngine;
	let scene: Scene;
	let options: any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		options = {
			editor: {
				layout: {
					preview: {
						scene,
						gizmo: { setAttachedObject: vi.fn() },
						clusteredLightContainer: { addLight: vi.fn() },
					},
					graph: { refresh: vi.fn().mockResolvedValue(undefined), setSelectedNode: vi.fn() },
					inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() },
				},
			},
		};
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
		vi.clearAllMocks();
	});

	test("creates, reads, exact-revisions, shape-switches, and exposes generic light evidence", () => {
		const created = createAreaLight(
			scene,
			{
				shape: "rectangle",
				name: "MCP Area",
				position: [10, 20, 30],
				direction: [0, -1, 0],
				upDirection: [0, 0, 1],
				width: 400,
				height: 150,
				color: [1, 0.25, 0.1],
				intensity: 3,
				range: 2000,
			},
			options
		) as any;
		expect(created.areaLight).toMatchObject({
			backend: "unity-style-area-light-v1",
			revision: 1,
			shape: "rectangle",
			width: 400,
			height: 150,
			position: [10, 20, 30],
			worldDirection: [0, -1, 0],
			intensity: 3,
			range: 2000,
			deferredModel: "babylon-ltc-rectangle",
			castsRealtimeShadows: false,
		});
		const nodeId = created.light.id;
		expect(getAreaLight(scene, { nodeId })).toMatchObject({ areaLight: { revision: 1, shape: "rectangle" } });
		expect(getLight(scene, { nodeId })).toMatchObject({ className: "RectAreaLight", areaLight: { revision: 1, shape: "rectangle" } });

		expect(() => setAreaLight(scene, { nodeId, expectedRevision: 2, radius: 50 }, options)).toThrow("current revision is 1");
		const changed = setAreaLight(scene, { nodeId, expectedRevision: 1, shape: "disc", radius: 80, direction: [0, 0, 1], enabled: false, intensity: 5 }, options) as any;
		expect(changed.areaLight).toMatchObject({
			revision: 2,
			shape: "disc",
			radius: 80,
			worldDirection: [0, 0, 1],
			enabled: false,
			intensity: 5,
			deferredModel: "bounded-ltc-disc-16-gon",
		});
		expect(() => setAreaLight(scene, { nodeId, expectedRevision: 2 }, options)).toThrow("at least one area-light property");
		expect(() => setAreaLight(scene, { nodeId, expectedRevision: 2, direction: [0, 0, 0] }, options)).toThrow("direction must be a non-zero vector");
	});

	test("rejects generic mutation, realtime shadows, and clustered placement", () => {
		const created = createAreaLight(scene, { shape: "disc", name: "Protected Disc", radius: 50 }, options) as any;
		const nodeId = created.light.id;
		expect(() => setLightProperties(scene, { nodeId, properties: { intensity: 2 } }, options)).toThrow("Use set_area_light");
		expect(() => setLightShadows(scene, { nodeId, enabled: true }, options)).toThrow("does not support realtime shadow generators");
		expect(() => addLightToClusteredContainer(scene, { nodeId }, options)).toThrow("requires Babylon LTC textures");
		expect(options.editor.layout.preview.clusteredLightContainer.addLight).not.toHaveBeenCalled();
	});
});
