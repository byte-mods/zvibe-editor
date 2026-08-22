import { createServer, IncomingMessage, ServerResponse } from "http";
import { AddressInfo } from "net";
import { join } from "path/posix";

import { ensureDir, mkdtemp, pathExists, readFile, readJSON, remove, writeFile, writeJSON } from "fs-extra";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
	applyImporterArtifactWithAccelerator,
	checkImportAcceleratorConnection,
	clearImportAcceleratorDiagnostics,
	getImportAcceleratorCapabilities,
	getImportAcceleratorDiagnostics,
} from "../../src/mcp/assets/import-accelerator";
import { projectConfiguration } from "../../src/project/configuration";
import { createDefaultProjectSettings } from "../../src/project/settings";

async function body(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

describe("Import Accelerator cache core", () => {
	let directory: string;
	let sourceA: string;
	let sourceB: string;
	let endpoint: string;
	let server: ReturnType<typeof createServer>;
	let requests: number;
	const blobs = new Map<string, Buffer>();
	const manifests = new Map<string, Buffer>();

	beforeEach(async () => {
		directory = await mkdtemp("/tmp/zvibe-import-accelerator-");
		sourceA = join(directory, "assets/source-a.png");
		sourceB = join(directory, "assets/source-b.png");
		await ensureDir(join(directory, "assets"));
		await writeFile(sourceA, "same source bytes");
		await writeFile(sourceB, "same source bytes");
		requests = 0;
		blobs.clear();
		manifests.clear();
		server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
			requests++;
			const path = request.url ?? "";
			if (path === "/v1/health") {
				response.writeHead(200).end("ok");
				return;
			}
			const store = path.startsWith("/v1/blobs/") ? blobs : manifests;
			if (request.method === "PUT") {
				store.set(path, await body(request));
				response.writeHead(201).end();
				return;
			}
			const value = store.get(path);
			if (!value) {
				response.writeHead(404).end();
				return;
			}
			response.writeHead(200, { "content-type": path.startsWith("/v1/blobs/") ? "application/octet-stream" : "application/json" }).end(value);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const accelerator = createDefaultProjectSettings().assetPipeline.accelerator;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		projectConfiguration.importAccelerator = { ...accelerator, enabled: true, endpoint };
	});

	afterEach(async () => {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		projectConfiguration.path = null;
		projectConfiguration.importAccelerator = null;
		await remove(directory);
	});

	function fakeImporter(sourcePath: string, guid: string, fingerprint: string, calls: { local: number }) {
		const artifactDirectory = join(directory, `.bjseditor/imported-assets/${guid}`);
		const manifestPath = join(artifactDirectory, "texture-import.json");
		const inspect = async () => {
			let result: any = null;
			try {
				result = (await readJSON(manifestPath)).result;
			} catch {
				// Missing artifacts are normal before first import or after local cleanup.
			}
			return {
				path: sourcePath,
				artifactPath: join(artifactDirectory, "texture.png"),
				manifestPath,
				fingerprint,
				current: Boolean(result && result.fingerprint === fingerprint && (await pathExists(result.outputPath))),
				exists: Boolean(result),
				result,
			};
		};
		const applyLocal = async () => {
			calls.local++;
			await ensureDir(artifactDirectory);
			const outputPath = join(artifactDirectory, "texture.png");
			await writeFile(outputPath, "generated artifact");
			await writeJSON(manifestPath, { version: 1, fingerprint, result: { fingerprint, sourcePath, outputPath } }, { spaces: "\t" });
			return inspect();
		};
		return {
			artifactDirectory,
			manifestPath,
			inspect,
			apply: (expectedFingerprint = fingerprint) => applyImporterArtifactWithAccelerator({ kind: "texture", sourcePath, expectedFingerprint, inspect, applyLocal }),
		};
	}

	test("uploads one local miss, restores a different artifact root as a hit, and records bounded diagnostics", async () => {
		const callsA = { local: 0 };
		const callsB = { local: 0 };
		const first = fakeImporter(sourceA, "guid-a", "fingerprint-1", callsA);
		const second = fakeImporter(sourceB, "guid-b", "fingerprint-1", callsB);
		expect((await first.apply()).current).toBe(true);
		expect(callsA.local).toBe(1);
		expect(manifests.size).toBe(1);
		expect(blobs.size).toBe(2);
		expect((await second.apply()).current).toBe(true);
		expect(callsB.local).toBe(0);
		const restored = await readJSON(second.manifestPath);
		expect(restored.result).toMatchObject({ sourcePath: sourceB, outputPath: join(second.artifactDirectory, "texture.png") });
		const diagnostics = await getImportAcceleratorDiagnostics();
		expect(diagnostics.counters).toMatchObject({ hits: 1, misses: 1, errors: 0 });
		expect(diagnostics.activities).toHaveLength(2);
		expect(getImportAcceleratorCapabilities().artifactKinds).toContain("animation");
		await expect(clearImportAcceleratorDiagnostics(diagnostics.revision, false)).rejects.toThrow("confirm=true");
		expect((await clearImportAcceleratorDiagnostics(diagnostics.revision, true)).revision).toBe(diagnostics.revision + 1);
	});

	test("rejects a stale fingerprint before network access", async () => {
		const importer = fakeImporter(sourceA, "guid-stale", "current-fingerprint", { local: 0 });
		const before = requests;
		await expect(importer.apply("stale-fingerprint")).rejects.toThrow("Texture importer plan changed");
		expect(requests).toBe(before);
		expect(await pathExists(importer.artifactDirectory)).toBe(false);
	});

	test("rejects an unsafe unsaved connection-check endpoint before resolving or sending authentication", async () => {
		process.env.ZVIBE_ACCELERATOR_UNSAFE_TEST = "must-not-leave-process";
		const before = requests;
		const configuration = { ...projectConfiguration.importAccelerator!, endpoint: "http://cache.example", authenticationEnvironmentVariable: "ZVIBE_ACCELERATOR_UNSAFE_TEST" };
		const result = await checkImportAcceleratorConnection(configuration);
		expect(result).toMatchObject({ connected: false, error: expect.stringContaining("requires HTTPS") });
		expect(JSON.stringify(result)).not.toContain("must-not-leave-process");
		expect(requests).toBe(before);
		delete process.env.ZVIBE_ACCELERATOR_UNSAFE_TEST;
	});

	test("rejects traversal manifests and falls back to a verified local import", async () => {
		const seedCalls = { local: 0 };
		await fakeImporter(sourceA, "guid-seed", "fingerprint-traversal", seedCalls).apply();
		const [manifestPath, bytes] = [...manifests.entries()][0];
		const manifest = JSON.parse(bytes.toString("utf-8"));
		manifest.files[0].path = "../escape.txt";
		manifests.set(manifestPath, Buffer.from(JSON.stringify(manifest)));
		const fallbackCalls = { local: 0 };
		const fallback = fakeImporter(sourceB, "guid-safe", "fingerprint-traversal", fallbackCalls);
		expect((await fallback.apply()).current).toBe(true);
		expect(fallbackCalls.local).toBe(1);
		expect(await pathExists(join(directory, ".bjseditor/imported-assets/escape.txt"))).toBe(false);
		expect((await getImportAcceleratorDiagnostics({ outcome: "error" })).total).toBe(1);
	});

	test("rejects tampered blob bytes, preserves correctness through local fallback, and re-uploads the repair", async () => {
		await fakeImporter(sourceA, "guid-seed", "fingerprint-tamper", { local: 0 }).apply();
		const firstBlobPath = [...blobs.keys()][0];
		blobs.set(firstBlobPath, Buffer.from("tampered"));
		const calls = { local: 0 };
		const fallback = fakeImporter(sourceB, "guid-fallback", "fingerprint-tamper", calls);
		expect((await fallback.apply()).current).toBe(true);
		expect(calls.local).toBe(1);
		expect((await readFile(join(fallback.artifactDirectory, "texture.png"), "utf-8")).toString()).toBe("generated artifact");
		expect((await getImportAcceleratorDiagnostics({ outcome: "error" })).total).toBe(1);
	});

	test("treats missing required server attestations as a cache error without blocking local import", async () => {
		await fakeImporter(sourceA, "guid-attestation-seed", "fingerprint-attestation", { local: 0 }).apply();
		projectConfiguration.importAccelerator = { ...projectConfiguration.importAccelerator!, contentValidation: "required" };
		const calls = { local: 0 };
		const fallback = fakeImporter(sourceB, "guid-attestation-fallback", "fingerprint-attestation", calls);
		expect((await fallback.apply()).current).toBe(true);
		expect(calls.local).toBe(1);
		const diagnostics = await getImportAcceleratorDiagnostics({ outcome: "error" });
		expect(diagnostics.activities[0].message).toContain("missing required x-zvibe-content-sha256 attestation");
	});
});
