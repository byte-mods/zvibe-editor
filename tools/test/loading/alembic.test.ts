import { NullEngine, Scene, VertexBuffer } from "@babylonjs/core";
import { GreasedLineBaseMesh } from "@babylonjs/core/Meshes/GreasedLine/greasedLineBaseMesh";
import { afterEach, describe, expect, it } from "vitest";

import {
	ALEMBIC_PLAYER_CONFIGURATION_VERSION,
	createAlembicPlayer,
	getAlembicPlayer,
	IAlembicPlayerConfiguration,
	listAlembicPlayers,
	normalizeAlembicPlayerConfiguration,
} from "../../src/loading/alembic";
import { createAlembicTestCache, rewriteAlembicFrame } from "../assets/alembic-fixture";

const resources: Array<{ engine: NullEngine; scene: Scene }> = [];

function createScene(): { engine: NullEngine; scene: Scene } {
	const engine = new NullEngine();
	const scene = new Scene(engine);
	resources.push({ engine, scene });
	return { engine, scene };
}

function configuration(overrides: Partial<IAlembicPlayerConfiguration> = {}): IAlembicPlayerConfiguration {
	return {
		version: ALEMBIC_PLAYER_CONFIGURATION_VERSION,
		id: "cache-player",
		name: "Complex Cache",
		assetPath: "assets/complex.abc",
		revision: 1,
		enabled: true,
		playOnAwake: false,
		loop: true,
		speed: 1,
		interpolation: "linear",
		startTimeSeconds: null,
		endTimeSeconds: null,
		pointSize: 2,
		curveWidth: 1,
		...overrides,
	};
}

afterEach(() => {
	resources.splice(0).forEach(({ scene, engine }) => {
		scene.dispose();
		engine.dispose();
	});
});

describe("Alembic runtime player", () => {
	it("instantiates every object kind, interpolates stable topology, and holds variable topology", async () => {
		const { scene } = createScene();
		const player = await createAlembicPlayer(scene, createAlembicTestCache().bytes, configuration());
		expect(player.nodes.size).toBe(4);
		expect(listAlembicPlayers(scene)).toEqual([player]);
		await player.seek(0.25);
		const mesh = player.nodes.get(0);
		const points = player.nodes.get(1);
		const curve = player.nodes.get(2);
		const camera = player.nodes.get(3);
		expect(mesh?.getClassName()).toBe("Mesh");
		expect(points?.getClassName()).toBe("Mesh");
		expect(curve?.getClassName()).toBe("GreasedLineMesh");
		expect(camera?.getClassName()).toBe("FreeCamera");
		expect(mesh && "getVerticesData" in mesh ? mesh.getVerticesData(VertexBuffer.PositionKind)?.[0] : null).toBeCloseTo(5);
		expect(points && "getVerticesData" in points ? points.getVerticesData(VertexBuffer.PositionKind)?.[0] : null).toBeCloseTo(0);
		expect(curve instanceof GreasedLineBaseMesh ? curve.points[0][1] : null).toBeCloseTo(5);
		expect(curve instanceof GreasedLineBaseMesh ? curve.greasedLineMaterial?.width : null).toBeCloseTo(1);
		expect(camera && "position" in camera ? camera.position.x : null).toBeCloseTo(2.5);
		expect(player.state).toMatchObject({ currentFrame: 0, nextFrame: 1, blendAmount: 0.5, objectCount: 4, lastError: null });
	});

	it("bounds residency, supports controls and exact configuration updates, and releases all ownership", async () => {
		const { scene } = createScene();
		const player = await createAlembicPlayer(scene, createAlembicTestCache().bytes, configuration());
		await player.seek(0);
		await player.seek(0.5);
		await player.seek(1);
		expect(player.state.loadedFrameIndices.length).toBeLessThanOrEqual(2);
		player.play();
		expect(player.state.playing).toBe(true);
		player.pause();
		expect(player.state.playing).toBe(false);
		await player.updateConfiguration(configuration({ revision: 2, name: "Renamed", speed: -2, pointSize: 6, curveWidth: 3, interpolation: "hold" }));
		expect(player.configuration).toMatchObject({ revision: 2, name: "Renamed", speed: -2, pointSize: 6, curveWidth: 3, interpolation: "hold" });
		const curve = player.nodes.get(2);
		expect(curve instanceof GreasedLineBaseMesh ? curve.greasedLineMaterial?.width : null).toBeCloseTo(3);
		expect(scene.materials.length).toBeGreaterThan(0);
		await player.stop();
		expect(player.state.currentTimeSeconds).toBe(1);
		player.dispose(true);
		expect(getAlembicPlayer(scene, "cache-player")).toBeNull();
		expect(scene.transformNodes.some((node) => node.id === "cache-player")).toBe(false);
		expect(scene.materials).toHaveLength(0);
		expect(() => player.play()).toThrow(/disposed/i);
	});

	it("rejects duplicate identities and malformed playback ranges without leaking scene registrations", async () => {
		const { scene } = createScene();
		const bytes = createAlembicTestCache().bytes;
		const player = await createAlembicPlayer(scene, bytes, configuration());
		await expect(createAlembicPlayer(scene, bytes, configuration())).rejects.toThrow(/already exists/i);
		expect(() => normalizeAlembicPlayerConfiguration(configuration({ startTimeSeconds: 2, endTimeSeconds: 1 }))).toThrow(/endTimeSeconds/i);
		expect(listAlembicPlayers(scene)).toEqual([player]);
		player.root.dispose();
		expect(listAlembicPlayers(scene)).toEqual([]);
		expect(scene.materials).toHaveLength(0);
	});

	it("refuses to interpolate a falsely stable mesh when its index topology changes", async () => {
		const { scene } = createScene();
		const fixture = createAlembicTestCache();
		// The first mesh index array starts after the 8-byte frame header, 88-byte state header, and 144 bytes of vertex attributes.
		const changedTopology = rewriteAlembicFrame(fixture.bytes, 1, (raw) => {
			const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
			view.setUint32(240, 1, true);
			view.setUint32(244, 0, true);
		});
		const player = await createAlembicPlayer(scene, changedTopology, configuration());
		await player.seek(0.25);
		const mesh = player.nodes.get(0);
		expect(mesh && "getVerticesData" in mesh ? mesh.getVerticesData(VertexBuffer.PositionKind)?.[0] : null).toBeCloseTo(0);
	});
});
