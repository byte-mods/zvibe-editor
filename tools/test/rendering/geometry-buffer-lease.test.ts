import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { NullEngine, Scene } from "@babylonjs/core";
import type { GeometryBufferRenderer } from "@babylonjs/core/Rendering/geometryBufferRenderer";

import { acquireGeometryBufferLease, getGeometryBufferLeaseEvidence, releaseGeometryBufferLease } from "../../src/rendering/geometry-buffer-lease";

function createRenderer(): GeometryBufferRenderer {
	return {
		isSupported: true,
		renderTransparentMeshes: false,
		enableDepth: true,
		enableNormal: true,
		enablePosition: false,
		enableVelocity: false,
		enableVelocityLinear: false,
		enableReflectivity: false,
		enableScreenspaceDepth: false,
		enableIrradiance: false,
		getGBuffer: () => ({
			getSize: () => ({ width: 320, height: 180 }),
			isReady: () => true,
			count: 2,
		}),
	} as unknown as GeometryBufferRenderer;
}

function setSceneRenderer(scene: Scene, renderer: GeometryBufferRenderer | null): void {
	(scene as unknown as { _geometryBufferRenderer: GeometryBufferRenderer | null })._geometryBufferRenderer = renderer;
}

describe("rendering/geometry-buffer-lease", () => {
	let engine: NullEngine;
	let scene: Scene;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("combines independent requirements and disposes an owned renderer after the final release", () => {
		const renderer = createRenderer();
		scene.enableGeometryBufferRenderer = () => {
			setSceneRenderer(scene, renderer);
			return renderer;
		};
		scene.disableGeometryBufferRenderer = () => setSceneRenderer(scene, null);
		const first = acquireGeometryBufferLease(scene, "normal-pass", { normal: true, position: true });
		const second = acquireGeometryBufferLease(scene, "temporal-reconstruction", { velocityLinear: true });
		expect(second).toBe(first);
		expect(getGeometryBufferLeaseEvidence(scene)).toMatchObject({
			active: true,
			owned: true,
			holderCount: 2,
			holders: ["normal-pass", "temporal-reconstruction"],
			requirements: { normal: true, position: true, velocityLinear: true },
		});

		expect(releaseGeometryBufferLease(scene, "normal-pass")).toMatchObject({
			active: true,
			holderCount: 1,
			requirements: { position: false, velocityLinear: true },
		});
		expect(scene.geometryBufferRenderer).toBe(first);
		expect(releaseGeometryBufferLease(scene, "temporal-reconstruction")).toMatchObject({ active: false, holderCount: 0 });
		expect(scene.geometryBufferRenderer).toBeNull();
	});

	test("preserves an externally owned renderer and its exact baseline flags", () => {
		const external = createRenderer();
		setSceneRenderer(scene, external);
		external.enablePosition = true;
		external.enableReflectivity = false;
		acquireGeometryBufferLease(scene, "deferred", { transparent: true, reflectivity: true });
		expect(getGeometryBufferLeaseEvidence(scene)).toMatchObject({ owned: false, requirements: { transparent: true, position: true, reflectivity: true } });
		expect(external.enableReflectivity).toBe(true);
		expect(external.renderTransparentMeshes).toBe(true);

		releaseGeometryBufferLease(scene, "deferred");
		expect(scene.geometryBufferRenderer).toBe(external);
		expect(external.enablePosition).toBe(true);
		expect(external.enableReflectivity).toBe(false);
		expect(external.renderTransparentMeshes).toBe(false);
	});
});
