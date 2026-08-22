import { tmpdir } from "os";
import { join } from "path/posix";
import { ensureDir, mkdtemp, remove, writeFile } from "fs-extra";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CubeTexture, DirectionalLight, NullEngine, PointLight, Scene, SpotLight, Vector3 } from "babylonjs";

import { projectConfiguration } from "../../src/project/configuration";
import { clearLightCookie, getLight, getLightCookie, setLightCookieProperties } from "../../src/mcp/lights/lights";

describe("mcp/light-cookies", () => {
	let directory: string;
	let previousProjectPath: string | null;
	let engine: NullEngine;
	let scene: Scene;
	const options = {
		editor: {
			layout: {
				inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() },
			},
		},
	} as any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-light-cookie-"));
		await ensureDir(join(directory, "assets"));
		await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 255, g: 32, b: 8, alpha: 1 } } })
			.png()
			.toFile(join(directory, "assets", "cookie.png"));
		await writeFile(join(directory, "assets", "cookie.env"), new Uint8Array([0]));
		await writeFile(join(directory, "Game.bjseditor"), "{}");
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(async () => {
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = previousProjectPath;
		await remove(directory);
		vi.clearAllMocks();
	});

	test("assigns, reads, exact-revisions, updates, and clears a spot cookie", async () => {
		const spot = new SpotLight("Cookie Spot", new Vector3(0, 0, -100), new Vector3(0, 0, 1), Math.PI / 2, 2, scene);
		const created = await setLightCookieProperties(
			scene,
			{ nodeId: spot.id, texturePath: "assets/cookie.png", intensity: 0.75, near: 0.1, far: 500, upDirection: [0, 1, 0] },
			options
		);
		expect(created).toMatchObject({
			light: { id: spot.id },
			cookie: {
				backend: "unity-style-light-cookie-v1",
				kind: "spot-2d",
				revision: 1,
				intensity: 0.75,
				near: 0.1,
				far: 500,
				textureName: "assets/cookie.png",
				textureIsCube: false,
			},
		});
		expect(getLightCookie(scene, { nodeId: spot.id })).toMatchObject({ cookie: { revision: 1, textureUrl: "assets/cookie.png" } });
		expect(getLight(scene, { nodeId: spot.id })).toMatchObject({ cookie: { revision: 1, kind: "spot-2d" } });
		await expect(setLightCookieProperties(scene, { nodeId: spot.id, expectedRevision: 2, intensity: 0.5 }, options)).rejects.toThrow("current revision is 1");
		const updated = await setLightCookieProperties(scene, { nodeId: spot.id, expectedRevision: 1, intensity: 0.5, near: 1, far: 750 }, options);
		expect(updated.cookie).toMatchObject({ revision: 2, intensity: 0.5, near: 1, far: 750 });
		expect(() => clearLightCookie(scene, { nodeId: spot.id, expectedRevision: 1, confirm: true }, options)).toThrow("current revision is 2");
		expect(clearLightCookie(scene, { nodeId: spot.id, expectedRevision: 2, confirm: true }, options)).toMatchObject({ cookie: null });
		expect(getLightCookie(scene, { nodeId: spot.id })).toMatchObject({ cookie: null });
	});

	test("supports directional and point cookies and rejects invalid point assets before mutation", async () => {
		const directional = new DirectionalLight("Cookie Directional", new Vector3(0, 0, 1), scene);
		const result = await setLightCookieProperties(
			scene,
			{ nodeId: directional.id, texturePath: "assets/cookie.png", size: [400, 250], offset: [0.25, -0.125], intensity: 1 },
			options
		);
		expect(result.cookie).toMatchObject({ kind: "directional-2d", revision: 1, size: [400, 250], offset: [0.25, -0.125] });

		const point = new PointLight("Cookie Point", new Vector3(0, 0, -100), scene);
		await expect(setLightCookieProperties(scene, { nodeId: point.id, texturePath: "assets/cookie.png" }, options)).rejects.toThrow("require a cubemap asset");
		expect(getLightCookie(scene, { nodeId: point.id })).toMatchObject({ cookie: null });
		const cube = new CubeTexture("", scene);
		vi.spyOn(CubeTexture, "CreateFromPrefilteredData").mockReturnValue(cube as any);
		const pointResult = await setLightCookieProperties(scene, { nodeId: point.id, texturePath: "assets/cookie.env", intensity: 0.4 }, options);
		expect(pointResult.cookie).toMatchObject({ kind: "point-cube", revision: 1, intensity: 0.4, textureName: "assets/cookie.env", textureIsCube: true });
		await expect(setLightCookieProperties(scene, { nodeId: directional.id, expectedRevision: 1, near: 10, far: 5 }, options)).rejects.toThrow("far clip (5) must be greater");
		expect(getLightCookie(scene, { nodeId: directional.id })).toMatchObject({ cookie: { revision: 1 } });
	});
});
