import { symlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { ensureDir, mkdtemp, remove, writeFile, writeJSON } from "fs-extra";
import { Animation } from "babylonjs";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { normalizeGenerativeAssetProviderResult, normalizeGenerativeAssetRequest } from "babylonjs-editor-tools";

import { materializeGenerativeProviderResult, readGenerativeProviderResultManifest, validateGenerativeProviderOutput } from "../../src/mcp/ai/generative-validation";

vi.mock("../../src/mcp/assets/media-executables", () => ({
	resolveMediaExecutable: vi.fn(async (_editor: unknown, name: string) => name),
	runMediaProcess: vi.fn(async (executable: string, args: string[]) => {
		if (executable === "ffprobe") {
			return JSON.stringify({
				streams: [{ codec_name: "pcm_s16le", sample_rate: "48000", channels: 2, bit_rate: "1536000" }],
				format: { format_name: "wav", duration: "1.25" },
			});
		}
		await writeFile(args.at(-1)!, Buffer.from("bounded-wave-preview"));
		return "";
	}),
}));

describe("Generative provider artifact validation", () => {
	let directory: string;
	const editor = {} as any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "zvibe-generative-validation-"));
	});

	afterEach(async () => {
		await remove(directory);
	});

	async function imageBuffer(red: number, green: number, blue: number, width = 64, height = 64): Promise<Buffer> {
		return sharp({ create: { width, height, channels: 4, background: { r: red, g: green, b: blue, alpha: 1 } } })
			.png()
			.toBuffer();
	}

	async function validate(
		name: string,
		requestValue: object,
		artifacts: Array<{ path: string; role: string; mediaType: string; displayName?: string }>,
		files: Record<string, Buffer | string>
	): Promise<any> {
		const jobRoot = join(directory, name);
		const outputRoot = join(jobRoot, "output");
		await ensureDir(outputRoot);
		for (const [path, bytes] of Object.entries(files)) {
			const destination = join(outputRoot, path);
			await ensureDir(join(destination, ".."));
			await writeFile(destination, bytes);
		}
		const request = normalizeGenerativeAssetRequest(requestValue);
		const result = normalizeGenerativeAssetProviderResult({ version: 1, candidates: [{ id: `${name}-candidate`, reportedModel: "fixture-model", artifacts }] }, request);
		const clean = await materializeGenerativeProviderResult(outputRoot, result, 16 * 1024 * 1024);
		return validateGenerativeProviderOutput(jobRoot, outputRoot, clean, request, 16 * 1024 * 1024, editor);
	}

	test("decodes and fingerprints image, sprite sheet, material set, animation, and audio outputs", async () => {
		const image = await validate(
			"image",
			{ modality: "image", prompt: "Image", options: { width: 64, height: 64 } },
			[{ path: "image.png", role: "image", mediaType: "image/png" }],
			{ "image.png": await imageBuffer(200, 20, 40) }
		);
		expect(image).toMatchObject({
			resultFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
			candidates: [{ artifacts: [{ role: "image", inspection: { kind: "image", width: 64, height: 64 } }], preview: { mediaType: "image/jpeg" } }],
		});

		const sprite = await validate(
			"sprite",
			{ modality: "sprite", prompt: "Sprite sheet", options: { width: 64, height: 64, spritesheet: { columns: 2, rows: 2, framesPerSecond: 12 } } },
			[{ path: "sheet.png", role: "spritesheet", mediaType: "image/png" }],
			{ "sheet.png": await imageBuffer(20, 200, 40) }
		);
		expect(sprite.candidates[0]).toMatchObject({ artifacts: [{ role: "spritesheet", inspection: { width: 64, height: 64 } }], preview: { mediaType: "image/jpeg" } });

		const material = await validate(
			"material",
			{ modality: "material", prompt: "Material", options: { resolution: 64, maps: ["base-color", "normal"] } },
			[
				{ path: "surface.material", role: "material", mediaType: "application/json" },
				{ path: "base.png", role: "base-color", mediaType: "image/png" },
				{ path: "normal.png", role: "normal", mediaType: "image/png" },
			],
			{
				"surface.material": JSON.stringify({ customType: "BABYLON.PBRMaterial", name: "Generated Surface" }),
				"base.png": await imageBuffer(100, 90, 80),
				"normal.png": await imageBuffer(128, 128, 255),
			}
		);
		expect(material.candidates[0].artifacts.map((artifact: any) => artifact.role)).toEqual(["material", "base-color", "normal"]);
		expect(material.candidates[0].artifacts[0].inspection).toMatchObject({ kind: "material", customType: "BABYLON.PBRMaterial" });

		const animation = new Animation("Generated Move", "position.x", 30, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
		animation.setKeys([
			{ frame: 0, value: 0 },
			{ frame: 30, value: 1 },
		]);
		const animationDocument = { name: "Generated Move", from: 0, to: 30, loopAnimation: true, targetedAnimations: [{ targetId: "Root", animation: animation.serialize() }] };
		const motion = await validate(
			"animation",
			{ modality: "animation", prompt: "Move", options: { durationSeconds: 1, framesPerSecond: 30, loop: true, rig: "generic" } },
			[{ path: "move.animation", role: "animation", mediaType: "application/json" }],
			{ "move.animation": JSON.stringify(animationDocument) }
		);
		expect(motion.candidates[0]).toMatchObject({ artifacts: [{ role: "animation", inspection: { kind: "animation", durationSeconds: 1, loop: true } }], preview: null });

		const audio = await validate(
			"audio",
			{ modality: "audio", prompt: "Tone", options: { durationSeconds: 1.25, sampleRate: 48_000, channels: 2 } },
			[{ path: "tone.wav", role: "audio", mediaType: "audio/wav" }],
			{ "tone.wav": Buffer.from("fixture-wave-bytes") }
		);
		expect(audio.candidates[0]).toMatchObject({
			artifacts: [{ role: "audio", inspection: { kind: "audio", codec: "pcm_s16le", durationSeconds: 1.25, sampleRate: 48_000, channels: 2 } }],
			preview: { path: expect.stringMatching(/\.wav$/), mediaType: "audio/wav" },
		});
	});

	test("rejects wrong dimensions, undeclared files, shared paths, and symbolic-link manifests", async () => {
		await expect(
			validate("wrong-size", { modality: "image", prompt: "Wrong", options: { width: 64, height: 64 } }, [{ path: "wrong.png", role: "image", mediaType: "image/png" }], {
				"wrong.png": await imageBuffer(0, 0, 0, 128, 64),
			})
		).rejects.toThrow(/do not match requested 64x64/i);

		const extraRoot = join(directory, "extra");
		await ensureDir(join(extraRoot, "output"));
		await writeFile(join(extraRoot, "output/image.png"), await imageBuffer(0, 0, 0));
		await writeFile(join(extraRoot, "output/undeclared.bin"), "extra");
		const extraRequest = normalizeGenerativeAssetRequest({ modality: "image", prompt: "Extra", options: { width: 64, height: 64 } });
		const extraResult = normalizeGenerativeAssetProviderResult(
			{ version: 1, candidates: [{ id: "extra-candidate", artifacts: [{ path: "image.png", role: "image", mediaType: "image/png" }] }] },
			extraRequest
		);
		const extraClean = await materializeGenerativeProviderResult(join(extraRoot, "output"), extraResult, 16 * 1024 * 1024);
		await expect(validateGenerativeProviderOutput(extraRoot, join(extraRoot, "output"), extraClean, extraRequest, 16 * 1024 * 1024, editor)).rejects.toThrow(
			/undeclared files/i
		);

		const sharedRoot = join(directory, "shared");
		await ensureDir(join(sharedRoot, "output"));
		await writeFile(join(sharedRoot, "output/shared.png"), await imageBuffer(0, 0, 0));
		const sharedRequest = normalizeGenerativeAssetRequest({ modality: "image", prompt: "Shared", count: 2, options: { width: 64, height: 64 } });
		const sharedResult = normalizeGenerativeAssetProviderResult(
			{
				version: 1,
				candidates: [
					{ id: "first", artifacts: [{ path: "shared.png", role: "image", mediaType: "image/png" }] },
					{ id: "second", artifacts: [{ path: "shared.png", role: "image", mediaType: "image/png" }] },
				],
			},
			sharedRequest
		);
		const sharedClean = await materializeGenerativeProviderResult(join(sharedRoot, "output"), sharedResult, 16 * 1024 * 1024);
		await expect(validateGenerativeProviderOutput(sharedRoot, join(sharedRoot, "output"), sharedClean, sharedRequest, 16 * 1024 * 1024, editor)).rejects.toThrow(
			/cannot share artifact path/i
		);

		const manifestTarget = join(directory, "external-result.json");
		const manifestLink = join(directory, "linked-result.json");
		await writeJSON(manifestTarget, { version: 1, candidates: [] });
		await symlink(manifestTarget, manifestLink);
		await expect(readGenerativeProviderResultManifest(manifestLink)).rejects.toThrow(/non-symlink/i);
	});
});
