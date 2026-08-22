import { describe, expect, it } from "vitest";

import { decodeAlembicFrame, getAlembicFrameBlend, normalizeAlembicImporterSettings, parseAlembicCache } from "../../src/assets/alembic";
import { createAlembicTestCache, rewriteAlembicFrame, rewriteAlembicManifest } from "./alembic-fixture";

describe("Alembic cache contract", () => {
	it("normalizes strict importer settings and rejects unsafe combinations", () => {
		const settings = normalizeAlembicImporterSettings({ sampleRate: 60, importCurves: false, speed: -2 });
		expect(settings.sampleRate).toBe(60);
		expect(settings.importCurves).toBe(false);
		expect(settings.speed).toBe(-2);
		expect(() => normalizeAlembicImporterSettings({ importMeshes: false, importPoints: false, importCurves: false, importCameras: false })).toThrow(
			/at least one object family/i
		);
		expect(() => normalizeAlembicImporterSettings({ speed: 0 })).toThrow(/non-zero/i);
		expect(() => normalizeAlembicImporterSettings({ startTimeSeconds: 2, endTimeSeconds: 1 })).toThrow(/endTimeSeconds/i);
	});

	it("parses and decodes meshes, points, curves, cameras, attributes, and exact evidence", async () => {
		const fixture = createAlembicTestCache();
		const document = parseAlembicCache(fixture.bytes);
		expect(document.manifest.objects.map((object) => object.kind)).toEqual(["mesh", "points", "curves", "camera"]);
		expect(document.manifest.statistics).toMatchObject({ meshCount: 1, pointCount: 1, curveCount: 1, cameraCount: 1 });
		const frame = await decodeAlembicFrame(document, 1);
		expect(frame.vertexCount).toBe(8);
		expect(frame.indexCount).toBe(3);
		expect(frame.states[0]).toMatchObject({ kind: "mesh", visible: true });
		expect(frame.states[1]).toMatchObject({ kind: "points", visible: true });
		expect(frame.states[2]).toMatchObject({ kind: "curves", visible: true });
		expect(frame.states[3]).toMatchObject({ kind: "camera", position: [5, 5, -10] });
		if (frame.states[0].kind !== "mesh" || frame.states[1].kind !== "points" || frame.states[2].kind !== "curves") throw new Error("Unexpected test frame kinds.");
		expect([...frame.states[0].indices]).toEqual([0, 1, 2]);
		expect([...(frame.states[0].materialIndices ?? [])]).toEqual([0]);
		expect([...(frame.states[1].widths ?? [])]).toEqual([2, 4]);
		expect([...frame.states[2].segmentLengths]).toEqual([3]);
	});

	it("rejects false generator, hash, coordinate, span, and aggregate-statistics evidence", () => {
		const { bytes } = createAlembicTestCache();
		const cases: Array<[RegExp, (manifest: Record<string, any>) => void]> = [
			[/generator name/i, (manifest) => (manifest.generator.name = "Other")],
			[/source sha256/i, (manifest) => (manifest.source.sha256 = "x".repeat(64))],
			[/settings sha256/i, (manifest) => (manifest.settingsSha256 = "x".repeat(64))],
			[/coordinateSystem/i, (manifest) => (manifest.coordinateSystem = "sourceRightHanded")],
			[/exactly continue/i, (manifest) => (manifest.frames[1].offset += 1)],
			[/compressed-frame statistics/i, (manifest) => (manifest.statistics.compressedFrameBytes += 1)],
			[/raw-frame statistics/i, (manifest) => (manifest.statistics.rawFrameBytes += 1)],
		];
		cases.forEach(([message, mutate]) => expect(() => parseAlembicCache(rewriteAlembicManifest(bytes, mutate))).toThrow(message));
	});

	it("rejects payload corruption and decompression beyond the declared raw size", async () => {
		const { bytes } = createAlembicTestCache();
		const corrupted = bytes.slice();
		corrupted[corrupted.length - 1] ^= 0xff;
		await expect(decodeAlembicFrame(parseAlembicCache(corrupted), 2)).rejects.toThrow(/SHA-256/i);

		const undersized = rewriteAlembicManifest(bytes, (manifest) => {
			manifest.frames[0].rawBytes -= 1;
			manifest.statistics.rawFrameBytes -= 1;
		});
		await expect(decodeAlembicFrame(parseAlembicCache(undersized), 0)).rejects.toThrow(/expands beyond its declared/i);
	});

	it("rejects unknown state flags and non-zero reserved binary fields", async () => {
		const { bytes } = createAlembicTestCache();
		const unknownFlag = rewriteAlembicFrame(bytes, 0, (raw) => new DataView(raw.buffer, raw.byteOffset, raw.byteLength).setUint16(14, 0x8000, true));
		await expect(decodeAlembicFrame(parseAlembicCache(unknownFlag), 0)).rejects.toThrow(/unsupported flags or reserved data/i);
		const reserved = rewriteAlembicFrame(bytes, 0, (raw) => new DataView(raw.buffer, raw.byteOffset, raw.byteLength).setUint32(28, 1, true));
		await expect(decodeAlembicFrame(parseAlembicCache(reserved), 0)).rejects.toThrow(/unsupported flags or reserved data/i);
	});

	it("uses ordered binary-search frame blends with clamped boundaries", () => {
		const manifest = parseAlembicCache(createAlembicTestCache().bytes).manifest;
		expect(getAlembicFrameBlend(manifest, -10)).toEqual({ current: 0, next: 1, amount: 0 });
		expect(getAlembicFrameBlend(manifest, 0.25)).toEqual({ current: 0, next: 1, amount: 0.5 });
		expect(getAlembicFrameBlend(manifest, 0.75)).toEqual({ current: 1, next: 2, amount: 0.5 });
		expect(getAlembicFrameBlend(manifest, 10)).toEqual({ current: 2, next: 2, amount: 0 });
		expect(() => getAlembicFrameBlend(manifest, Number.NaN)).toThrow(/finite/i);
	});
});
