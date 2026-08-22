import { describe, expect, it } from "vitest";

import {
	GENERATIVE_ASSET_CONTRACT,
	normalizeGenerativeAssetProviderManifest,
	normalizeGenerativeAssetProviderResult,
	normalizeGenerativeAssetRequest,
} from "../../src/assets/generative-assets";

describe("Generative asset contract", () => {
	it("normalizes all five bounded modalities", () => {
		expect(GENERATIVE_ASSET_CONTRACT).toBe("zvibe-generative-assets-v1");
		const image = normalizeGenerativeAssetRequest({ modality: "image", prompt: "Moonlit ruins" });
		expect(image).toMatchObject({ count: 1, options: { value: { width: 1024, height: 1024 } } });
		expect(normalizeGenerativeAssetRequest(image)).toEqual(image);
		expect(normalizeGenerativeAssetRequest({ modality: "sprite", prompt: "Knight", options: { spritesheet: {} } })).toMatchObject({
			options: { value: { removeBackground: true, spritesheet: { columns: 4, rows: 4, framesPerSecond: 12 } } },
		});
		expect(normalizeGenerativeAssetRequest({ modality: "material", prompt: "Wet stone" })).toMatchObject({ options: { value: { tileable: true } } });
		expect(normalizeGenerativeAssetRequest({ modality: "animation", prompt: "Heavy walk" })).toMatchObject({ options: { value: { rig: "generic", loop: true } } });
		expect(normalizeGenerativeAssetRequest({ modality: "audio", prompt: "Distant thunder" })).toMatchObject({ options: { value: { sampleRate: 48_000, channels: 2 } } });
	});

	it("normalizes executable and credential-safe HTTP providers", () => {
		expect(
			normalizeGenerativeAssetProviderManifest({
				version: 1,
				id: "local-comfy-adapter",
				name: "Local adapter",
				vendor: "Project",
				classification: "generative-ai",
				modalities: ["image", "sprite", "material"],
				hostPlatforms: ["darwin", "linux"],
				transport: { kind: "executable", executable: "node", args: ["${PROJECT}/adapter.mjs", "${REQUEST}", "${OUTPUT}"], credentialEnvironments: [] },
			})
		).toMatchObject({ maximumDurationSeconds: 300, transport: { executable: "node" } });
		expect(
			normalizeGenerativeAssetProviderManifest({
				version: 1,
				id: "remote-provider",
				name: "Remote provider",
				vendor: "Example",
				classification: "generative-ai",
				modalities: ["audio"],
				hostPlatforms: [],
				transport: { kind: "http", endpoint: "https://example.com/v1/generate", authorizationEnvironment: "EXAMPLE_TOKEN", headers: { "X-Api-Version": "1" } },
			})
		).toMatchObject({ transport: { kind: "http", authorizationEnvironment: "EXAMPLE_TOKEN" } });
	});

	it("validates provider candidates against the requested modality", () => {
		const request = normalizeGenerativeAssetRequest({ modality: "material", prompt: "Basalt", count: 2, options: { maps: ["base-color", "normal"] } });
		const result = normalizeGenerativeAssetProviderResult(
			{
				version: 1,
				candidates: [
					{
						id: "candidate-1",
						reportedModel: "example-model",
						artifacts: [
							{ path: "candidate-1/base.png", role: "base-color", mediaType: "image/png" },
							{ path: "candidate-1/normal.png", role: "normal", mediaType: "image/png" },
						],
					},
				],
			},
			request
		);
		expect(result.candidates[0]).toMatchObject({ id: "candidate-1", reportedModel: "example-model" });
		expect(result.candidates[0].artifacts.map((artifact) => artifact.role)).toEqual(["base-color", "normal"]);
		expect(() =>
			normalizeGenerativeAssetProviderResult(
				{ version: 1, candidates: [{ id: "incomplete", artifacts: [{ path: "base.png", role: "base-color", mediaType: "image/png" }] }] },
				request
			)
		).toThrow(/missing required material.*normal/i);
		const sheetRequest = normalizeGenerativeAssetRequest({ modality: "sprite", prompt: "Run", options: { width: 64, height: 64, spritesheet: { columns: 2, rows: 2 } } });
		expect(() =>
			normalizeGenerativeAssetProviderResult(
				{ version: 1, candidates: [{ id: "single", artifacts: [{ path: "sprite.png", role: "sprite", mediaType: "image/png" }] }] },
				sheetRequest
			)
		).toThrow(/missing required sprite.*spritesheet/i);
		expect(() =>
			normalizeGenerativeAssetProviderResult(
				{
					version: 1,
					candidates: [
						{
							id: "ambiguous",
							artifacts: [
								{ path: "first.png", role: "base-color", mediaType: "image/png" },
								{ path: "second.png", role: "base-color", mediaType: "image/png" },
								{ path: "normal.png", role: "normal", mediaType: "image/png" },
							],
						},
					],
				},
				request
			)
		).toThrow(/duplicate primary artifact role base-color/i);
	});

	it("rejects traversal, unknown fields, secrets, oversized sheets, and wrong result roles", () => {
		expect(() => normalizeGenerativeAssetRequest({ modality: "image", prompt: "x", references: [{ path: "../secret", role: "content" }] })).toThrow(/assets/i);
		expect(() => normalizeGenerativeAssetRequest({ modality: "image", prompt: "x", surprise: true })).toThrow(/unsupported fields/i);
		expect(() => normalizeGenerativeAssetRequest({ modality: "sprite", prompt: "x", options: { spritesheet: { columns: 16, rows: 17 } } })).toThrow(/rows/i);
		expect(() =>
			normalizeGenerativeAssetProviderManifest({
				version: 1,
				id: "bad",
				name: "Bad",
				vendor: "Bad",
				classification: "generative-ai",
				modalities: ["image"],
				hostPlatforms: [],
				transport: { kind: "http", endpoint: "https://user:secret@example.com/generate", headers: {} },
			})
		).toThrow(/credentials/i);
		expect(() =>
			normalizeGenerativeAssetProviderManifest({
				version: 1,
				id: "bad-header",
				name: "Bad",
				vendor: "Bad",
				classification: "generative-ai",
				modalities: ["image"],
				hostPlatforms: [],
				transport: { kind: "http", endpoint: "https://example.com/generate", headers: { "X-Api-Key": "secret" } },
			})
		).toThrow(/unsafe/i);
		const request = normalizeGenerativeAssetRequest({ modality: "audio", prompt: "x" });
		expect(() =>
			normalizeGenerativeAssetProviderResult(
				{ version: 1, candidates: [{ id: "candidate", artifacts: [{ path: "preview.png", role: "preview-image", mediaType: "image/png" }] }] },
				request
			)
		).toThrow(/missing required audio/i);
		expect(() =>
			normalizeGenerativeAssetProviderResult(
				{ version: 1, candidates: [{ id: "candidate", artifacts: [{ path: "sound.wav", role: "audio", mediaType: "audio/wav", dataBase64: "not base64" }] }] },
				request
			)
		).toThrow(/canonical base64/i);
	});
});
