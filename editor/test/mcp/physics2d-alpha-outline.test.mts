import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { join } from "path/posix";
import { tmpdir } from "os";
import { mkdtemp, remove } from "fs-extra";
import sharp from "sharp";

import { NullEngine, Scene, TransformNode } from "babylonjs";

vi.mock("babylonjs-editor-tools", () => ({}));

import { projectConfiguration } from "../../src/project/configuration";
import { generatePhysics2DPolygonCollider, listPhysics2D } from "../../src/mcp/physics2d/physics2d";

describe("mcp/physics2d alpha outline", () => {
	let directory: string;
	let engine: NullEngine;
	let scene: Scene;
	const originalProjectPath = projectConfiguration.path;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() } } } } as any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "bjseditor-physics2d-"));
		projectConfiguration.path = join(directory, "game.bjseditor");
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(async () => {
		projectConfiguration.path = originalProjectPath;
		scene.dispose();
		engine.dispose();
		await remove(directory);
	});

	test("converts opaque image pixels into a persisted convex polygon collider", async () => {
		const pixels = Buffer.alloc(8 * 8 * 4);
		for (let y = 1; y < 7; y++) for (let x = 2; x < 6; x++) pixels[(y * 8 + x) * 4 + 3] = 255;
		await sharp(pixels, { raw: { width: 8, height: 8, channels: 4 } })
			.png()
			.toFile(join(directory, "sprite.png"));
		const node = new TransformNode("Sprite", scene);

		const result = await generatePhysics2DPolygonCollider(scene, { nodeId: node.id, imagePath: "sprite.png", size: [80, 40] }, options);

		expect(result).toMatchObject({ sourceImagePath: "sprite.png", sourceImageSize: [8, 8], collider: { shape: "polygon" } });
		expect(result.collider.points).toHaveLength(4);
		expect(listPhysics2D(scene).bodies[0].collider).toEqual(result.collider);
	});

	test("traces a concave image-alpha outline into persisted compound collider parts", async () => {
		const pixels = Buffer.alloc(8 * 8 * 4);
		for (let y = 1; y < 7; y++) for (let x = 1; x < 3; x++) pixels[(y * 8 + x) * 4 + 3] = 255;
		for (let y = 1; y < 3; y++) for (let x = 1; x < 7; x++) pixels[(y * 8 + x) * 4 + 3] = 255;
		await sharp(pixels, { raw: { width: 8, height: 8, channels: 4 } })
			.png()
			.toFile(join(directory, "concave.png"));
		const node = new TransformNode("Concave Sprite", scene);

		const result = await generatePhysics2DPolygonCollider(scene, { nodeId: node.id, imagePath: "concave.png", size: [80, 80], outline: "concave" }, options);

		expect(result).toMatchObject({ outline: "concave", collider: { shape: "polygon" } });
		expect(result.collider.points).toHaveLength(6);
		expect(result.collider.parts).toHaveLength(4);
		expect(listPhysics2D(scene).bodies[0].collider).toEqual(result.collider);
	});
});
