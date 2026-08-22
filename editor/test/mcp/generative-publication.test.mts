import { createHash } from "crypto";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { ensureDir, pathExists, readFile, remove, writeFile, writeJSON } from "fs-extra";
import { Animation } from "babylonjs";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { getDefaultAssetImporterConfiguration, IGenerativeAssetRequest, normalizeGenerativeAssetProviderResult, normalizeGenerativeAssetRequest } from "babylonjs-editor-tools";

import { IGenerativeAssetPublicationJobLease, inspectGenerativeAssetPublication, publishGenerativeAssetCandidate } from "../../src/mcp/ai/generative-publication";
import { readGenerativeAssetProviderInventory, setGenerativeAssetProvider } from "../../src/mcp/ai/generative-providers";
import { materializeGenerativeProviderResult, validateGenerativeProviderOutput } from "../../src/mcp/ai/generative-validation";
import { projectConfiguration } from "../../src/project/configuration";

vi.mock("../../src/mcp/assets/media-executables", () => ({
	resolveMediaExecutable: vi.fn(async (_editor: unknown, name: string) => name),
	runMediaProcess: vi.fn(async (executable: string, args: string[]) => {
		if (executable === "ffprobe") {
			return JSON.stringify({
				streams: [{ codec_name: "pcm_s16le", sample_rate: "48000", channels: 2, bit_rate: "1536000", width: 64, height: 64 }],
				format: { format_name: "wav", duration: "1" },
			});
		}
		await writeFile(args.at(-1)!, Buffer.from("media-output"));
		return "";
	}),
}));

interface IArtifactInput {
	path: string;
	role: string;
	mediaType: string;
	displayName?: string;
}

describe("Generative asset transactional publication", () => {
	let directory: string;
	let previousProjectPath: string | null;
	let providerFingerprint: string;
	let jobCounter: number;
	const editor = {} as any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "zvibe-generative-publication-"));
		await ensureDir(join(directory, "assets"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeJSON(projectConfiguration.path, {});
		jobCounter = 0;
		const inventory = await readGenerativeAssetProviderInventory();
		const created = await setGenerativeAssetProvider({
			expectedInventoryFingerprint: inventory.inventoryFingerprint,
			provider: {
				version: 1,
				id: "publication-fixture",
				name: "Publication Fixture",
				vendor: "Zvibe Tests",
				classification: "test-fixture",
				modalities: ["image", "sprite", "material", "animation", "audio"],
				hostPlatforms: [process.platform],
				maximumOutputBytes: 64 * 1024 * 1024,
				maximumDurationSeconds: 30,
				transport: { kind: "executable", executable: "node", args: ["${REQUEST}", "${OUTPUT}"], credentialEnvironments: [] },
			},
		});
		providerFingerprint = created.provider.fingerprint;
	});

	afterEach(async () => {
		projectConfiguration.path = previousProjectPath;
		await remove(directory);
	});

	async function png(red: number, green: number, blue: number): Promise<Buffer> {
		return sharp({ create: { width: 64, height: 64, channels: 4, background: { r: red, g: green, b: blue, alpha: 1 } } })
			.png()
			.toBuffer();
	}

	async function lease(requestValue: object, artifacts: IArtifactInput[], files: Record<string, Buffer | string>): Promise<IGenerativeAssetPublicationJobLease> {
		jobCounter++;
		const id = `generative-job-${jobCounter.toString(16).padStart(24, "0")}`;
		const jobDirectory = join(directory, ".bjseditor/generative-assets/jobs", id);
		const outputDirectory = join(jobDirectory, "output");
		await ensureDir(outputDirectory);
		for (const [path, bytes] of Object.entries(files)) {
			const destination = join(outputDirectory, path);
			await ensureDir(join(destination, ".."));
			await writeFile(destination, bytes);
		}
		const request = normalizeGenerativeAssetRequest(requestValue);
		const result = normalizeGenerativeAssetProviderResult(
			{ version: 1, candidates: [{ id: "candidate-1", reportedModel: "publication-model", reportedSeed: 9, providerRequestId: "request-1", warnings: [], artifacts }] },
			request
		);
		const clean = await materializeGenerativeProviderResult(outputDirectory, result, 64 * 1024 * 1024);
		const validated = await validateGenerativeProviderOutput(jobDirectory, outputDirectory, clean, request, 64 * 1024 * 1024, { editor, createPreviews: false });
		return {
			root: directory,
			jobDirectory,
			outputDirectory,
			id,
			revision: 1,
			status: "succeeded",
			provider: {
				id: "publication-fixture",
				name: "Publication Fixture",
				vendor: "Zvibe Tests",
				classification: "test-fixture",
				fingerprint: providerFingerprint,
				transport: "executable",
			},
			request,
			requestFingerprint: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
			references: [],
			startedAt: "2026-08-16T00:00:00.000Z",
			completedAt: "2026-08-16T00:00:01.000Z",
			resultFingerprint: validated.resultFingerprint,
			candidates: validated.candidates,
			execution: { durationMilliseconds: 1000, exitCode: 0, httpStatus: null },
			publicationCount: 0,
		};
	}

	async function publish(leaseValue: IGenerativeAssetPublicationJobLease, baseName: string, destinationDirectory = "assets/generated"): Promise<any> {
		const input = { candidateId: "candidate-1", baseName, destinationDirectory };
		const plan = await inspectGenerativeAssetPublication(leaseValue, input, editor);
		let committed: unknown = null;
		const record = await publishGenerativeAssetCandidate(leaseValue, { ...input, expectedPlanFingerprint: plan.planFingerprint, confirm: true }, editor, async (value) => {
			committed = value;
		});
		expect(committed).toEqual(record);
		return { plan, record };
	}

	test("publishes image, sprite, material maps, animation, and audio through their normal importers", async () => {
		const image = await lease({ modality: "image", prompt: "Image", options: { width: 64, height: 64 } }, [{ path: "image.png", role: "image", mediaType: "image/png" }], {
			"image.png": await png(180, 20, 30),
		});
		const imageResult = await publish(image, "generated-image");
		expect(imageResult.record.files).toEqual([
			expect.objectContaining({ path: "assets/generated/generated-image.png", importer: expect.objectContaining({ kind: "texture", current: true }) }),
		]);

		const sprite = await lease(
			{
				modality: "sprite",
				prompt: "Sprite",
				options: { width: 64, height: 64, pixelsPerUnit: 256, spritesheet: { columns: 2, rows: 2, framesPerSecond: 12 } },
			},
			[{ path: "sheet.png", role: "spritesheet", mediaType: "image/png" }],
			{ "sheet.png": await png(20, 180, 30) }
		);
		const spriteResult = await publish(sprite, "generated-sprite");
		const spriteMetadata = JSON.parse(await readFile(join(directory, `${spriteResult.record.files[0].path}.bjsmeta.json`), "utf8"));
		expect(spriteMetadata.importer).toMatchObject({ kind: "texture", settings: { textureType: "sprite", spritePixelsPerUnit: 256 } });

		const material = await lease(
			{
				modality: "material",
				prompt: "Material",
				options: { resolution: 64, tileable: true, maps: ["base-color", "normal", "metallic", "roughness", "ambient-occlusion"] },
			},
			[
				{ path: "base.png", role: "base-color", mediaType: "image/png" },
				{ path: "normal.png", role: "normal", mediaType: "image/png" },
				{ path: "metallic.png", role: "metallic", mediaType: "image/png" },
				{ path: "roughness.png", role: "roughness", mediaType: "image/png" },
				{ path: "ao.png", role: "ambient-occlusion", mediaType: "image/png" },
			],
			{
				"base.png": await png(120, 80, 40),
				"normal.png": await png(128, 128, 255),
				"metallic.png": await png(192, 192, 192),
				"roughness.png": await png(128, 128, 128),
				"ao.png": await png(64, 64, 64),
			}
		);
		const materialResult = await publish(material, "generated-material");
		const materialRecord = materialResult.record.files.find((entry: any) => entry.role === "material");
		const ormRecord = materialResult.record.files.find((entry: any) => entry.role === "material-packed-orm");
		expect(materialRecord.importer).toMatchObject({ kind: "material", current: true });
		expect(ormRecord.importer).toMatchObject({ kind: "texture", current: true });
		const materialJson = JSON.parse(await readFile(join(directory, materialRecord.path), "utf8"));
		expect(materialJson).toMatchObject({
			customType: "BABYLON.PBRMaterial",
			albedoTexture: { name: "assets/generated/generated-material-base-color.png" },
			bumpTexture: { name: "assets/generated/generated-material-normal.png" },
			metallicTexture: { name: "assets/generated/generated-material-material-packed-orm.png" },
			useRoughnessFromMetallicTextureGreen: true,
			useMetallnessFromMetallicTextureBlue: true,
			useAmbientOcclusionFromMetallicTextureRed: true,
		});
		const ormPixel = await sharp(join(directory, ormRecord.path)).raw().toBuffer();
		expect([...ormPixel.subarray(0, 4)]).toEqual([64, 128, 192, 255]);

		const animation = new Animation("Move", "position.x", 30, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
		animation.setKeys([
			{ frame: 0, value: 0 },
			{ frame: 30, value: 1 },
		]);
		const motion = await lease(
			{ modality: "animation", prompt: "Move", options: { durationSeconds: 1, framesPerSecond: 30, loop: true, rig: "generic" } },
			[{ path: "move.animation", role: "animation", mediaType: "application/json" }],
			{
				"move.animation": JSON.stringify({
					name: "Move",
					from: 0,
					to: 30,
					loopAnimation: true,
					targetedAnimations: [{ targetId: "Root", animation: animation.serialize() }],
				}),
			}
		);
		const motionResult = await publish(motion, "generated-motion");
		expect(motionResult.record.files[0].importer).toMatchObject({ kind: "animation", current: true });

		const audio = await lease(
			{ modality: "audio", prompt: "Tone", options: { durationSeconds: 1, sampleRate: 48_000, channels: 2, loop: false } },
			[{ path: "tone.wav", role: "audio", mediaType: "audio/wav" }],
			{ "tone.wav": Buffer.from("fixture-wave") }
		);
		const audioResult = await publish(audio, "generated-tone");
		expect(audioResult.record.files[0].importer).toMatchObject({ kind: "audio", current: true });
	});

	test("uses collision-safe names and serializes simultaneous publication to one destination", async () => {
		const firstLease = await lease(
			{ modality: "image", prompt: "Collision", options: { width: 64, height: 64 } },
			[{ path: "image.png", role: "image", mediaType: "image/png" }],
			{ "image.png": await png(10, 20, 30) }
		);
		await publish(firstLease, "collision");
		const secondLease = await lease(
			{ modality: "image", prompt: "Collision", options: { width: 64, height: 64 } },
			[{ path: "image.png", role: "image", mediaType: "image/png" }],
			{ "image.png": await png(30, 20, 10) }
		);
		const safePlan = await inspectGenerativeAssetPublication(
			secondLease,
			{ candidateId: "candidate-1", baseName: "collision", destinationDirectory: "assets/generated" },
			editor
		);
		expect(safePlan.files[0].path).toBe("assets/generated/collision-2.png");

		const thirdLease = await lease({ modality: "image", prompt: "Race", options: { width: 64, height: 64 } }, [{ path: "image.png", role: "image", mediaType: "image/png" }], {
			"image.png": await png(80, 90, 100),
		});
		const input = { candidateId: "candidate-1", baseName: "race", destinationDirectory: "assets/race" };
		const plan = await inspectGenerativeAssetPublication(thirdLease, input, editor);
		const operations = await Promise.allSettled([
			publishGenerativeAssetCandidate(thirdLease, { ...input, expectedPlanFingerprint: plan.planFingerprint, confirm: true }, editor, async () => undefined),
			publishGenerativeAssetCandidate(thirdLease, { ...input, expectedPlanFingerprint: plan.planFingerprint, confirm: true }, editor, async () => undefined),
		]);
		expect(operations.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
		expect(operations.filter((entry) => entry.status === "rejected")).toEqual([
			expect.objectContaining({ reason: expect.objectContaining({ message: expect.stringMatching(/plan changed/i) }) }),
		]);
	});

	test("restores replaced assets, metadata, and importer caches when the retained-job commit fails", async () => {
		const target = join(directory, "assets/generated/rollback.png");
		const guid = "11111111-1111-4111-8111-111111111111";
		await ensureDir(join(target, ".."));
		await writeFile(target, Buffer.from("original-asset"));
		await writeJSON(`${target}.bjsmeta.json`, {
			guid,
			labels: ["original"],
			tags: ["original"],
			favorite: true,
			importer: getDefaultAssetImporterConfiguration(target),
			importState: { status: "native" },
		});
		const originalMetadata = await readFile(`${target}.bjsmeta.json`);
		const importerDirectory = join(directory, ".bjseditor/imported-assets", guid);
		await ensureDir(importerDirectory);
		await writeFile(join(importerDirectory, "marker.txt"), "original-importer-cache");
		const leaseValue = await lease(
			{ modality: "image", prompt: "Rollback", options: { width: 64, height: 64 } },
			[{ path: "image.png", role: "image", mediaType: "image/png" }],
			{ "image.png": await png(220, 30, 40) }
		);
		const input = { candidateId: "candidate-1", baseName: "rollback", destinationDirectory: "assets/generated", overwrite: true };
		const plan = await inspectGenerativeAssetPublication(leaseValue, input, editor);
		expect(plan.files[0]).toMatchObject({ path: "assets/generated/rollback.png", action: "replace", guid });
		await expect(
			publishGenerativeAssetCandidate(leaseValue, { ...input, expectedPlanFingerprint: plan.planFingerprint, confirm: true }, editor, async () => {
				throw new Error("retained job persistence failed");
			})
		).rejects.toThrow(/persistence failed/i);
		expect(await readFile(target, "utf8")).toBe("original-asset");
		expect(await readFile(`${target}.bjsmeta.json`)).toEqual(originalMetadata);
		expect(await readFile(join(importerDirectory, "marker.txt"), "utf8")).toBe("original-importer-cache");
	});

	test("rejects stale staged output and stale provider leases without mutating project assets", async () => {
		const leaseValue = await lease({ modality: "image", prompt: "Stale", options: { width: 64, height: 64 } }, [{ path: "image.png", role: "image", mediaType: "image/png" }], {
			"image.png": await png(1, 2, 3),
		});
		const input = { candidateId: "candidate-1", baseName: "stale", destinationDirectory: "assets/generated" };
		const plan = await inspectGenerativeAssetPublication(leaseValue, input, editor);
		await writeFile(join(leaseValue.outputDirectory, "image.png"), await png(3, 2, 1));
		await expect(
			publishGenerativeAssetCandidate(leaseValue, { ...input, expectedPlanFingerprint: plan.planFingerprint, confirm: true }, editor, async () => undefined)
		).rejects.toThrow(/staged output changed/i);
		expect(await pathExists(join(directory, "assets/generated/stale.png"))).toBe(false);

		const providerLease = await lease(
			{ modality: "image", prompt: "Provider stale", options: { width: 64, height: 64 } },
			[{ path: "image.png", role: "image", mediaType: "image/png" }],
			{ "image.png": await png(4, 5, 6) }
		);
		providerLease.provider.fingerprint = "f".repeat(64);
		await expect(inspectGenerativeAssetPublication(providerLease, { candidateId: "candidate-1", baseName: "provider-stale" }, editor)).rejects.toThrow(
			/provider manifest changed/i
		);

		const duplicateLease = await lease(
			{ modality: "image", prompt: "Duplicate GUID", options: { width: 64, height: 64 } },
			[{ path: "image.png", role: "image", mediaType: "image/png" }],
			{ "image.png": await png(7, 8, 9) }
		);
		const duplicateInput = { candidateId: "candidate-1", baseName: "duplicate-guid", destinationDirectory: "assets/generated" };
		const duplicatePlan = await inspectGenerativeAssetPublication(duplicateLease, duplicateInput, editor);
		const unrelated = join(directory, "assets/unrelated.png");
		await writeFile(unrelated, await png(9, 8, 7));
		await writeJSON(`${unrelated}.bjsmeta.json`, {
			guid: duplicatePlan.files[0].guid,
			labels: [],
			tags: [],
			favorite: false,
			importer: getDefaultAssetImporterConfiguration(unrelated),
			importState: { status: "native" },
		});
		await expect(
			publishGenerativeAssetCandidate(
				duplicateLease,
				{ ...duplicateInput, expectedPlanFingerprint: duplicatePlan.planFingerprint, confirm: true },
				editor,
				async () => undefined
			)
		).rejects.toThrow(/reuse asset GUID/i);
		expect(await pathExists(join(directory, "assets/generated/duplicate-guid.png"))).toBe(false);
	});
});
