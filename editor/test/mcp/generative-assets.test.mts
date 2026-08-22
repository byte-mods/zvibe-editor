import { mkdtemp, writeFile } from "fs/promises";
import { createServer } from "http";
import { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";

import { ensureDir, pathExists, readFile, remove, writeJSON } from "fs-extra";
import { NullEngine, Scene } from "babylonjs";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
	cancelGenerativeAssetJob,
	deleteGenerativeAssetJob,
	getGenerativeAssetJob,
	getGenerativeAssetPreview,
	inspectGenerativeAssetPublicationAction,
	listGenerativeAssetJobs,
	publishGenerativeAssetCandidateAction,
	shutdownGenerativeAssets,
	startGenerativeAssetJob,
} from "../../src/mcp/ai/generative-assets";
import { readGenerativeAssetProviderInventory, setGenerativeAssetProvider } from "../../src/mcp/ai/generative-providers";
import { projectConfiguration } from "../../src/project/configuration";

const fixtureSource = `
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [requestPath, outputPath] = process.argv.slice(2);
const envelope = JSON.parse(await readFile(requestPath, "utf8"));
const prompt = envelope.request.prompt;
if (prompt === "hang") {
	await new Promise((resolve) => setTimeout(resolve, 60_000));
}
if (prompt === "fail") {
	console.error("token=" + (process.env.ZVIBE_GENERATIVE_TEST_SECRET ?? "missing"));
	process.exitCode = 7;
} else if (prompt === "split-secret") {
	process.stderr.write("fixture-secret-");
	await new Promise((resolve) => setTimeout(resolve, 20));
	process.stderr.write("must-not-leak");
	process.exitCode = 8;
} else {
	if (prompt === "delay") {
		await new Promise((resolve) => setTimeout(resolve, 350));
	}
	await mkdir(outputPath, { recursive: true });
	await copyFile(join(envelope.projectRoot ?? process.cwd(), "fixture.png"), join(outputPath, "candidate.png"));
	await writeFile(join(outputPath, "result.json"), JSON.stringify({
		version: 1,
		candidates: [{
			id: "candidate-1",
			reportedModel: "deterministic-test-fixture",
			reportedSeed: envelope.request.seed,
			providerRequestId: "fixture-request-1",
			warnings: [],
			artifacts: [{ path: "candidate.png", role: "image", mediaType: "image/png", displayName: "Fixture Image" }],
		}],
	}));
}
`;

async function waitForTerminal(scene: Scene, options: any, jobId: string, timeoutMilliseconds = 8_000): Promise<any> {
	const deadline = Date.now() + timeoutMilliseconds;
	while (Date.now() < deadline) {
		const job = await getGenerativeAssetJob(scene, { jobId }, options);
		if (["succeeded", "failed", "canceled", "timed-out"].includes(job.status)) {
			return job;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Generative job ${jobId} did not reach a terminal state.`);
}

async function waitForActive(scene: Scene, options: any, jobId: string): Promise<any> {
	const deadline = Date.now() + 4_000;
	while (Date.now() < deadline) {
		const job = await getGenerativeAssetJob(scene, { jobId }, options);
		if (["running", "canceling"].includes(job.status)) {
			return job;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Generative job ${jobId} did not start.`);
}

describe("Generative asset retained jobs", () => {
	let directory: string;
	let previousProjectPath: string | null;
	let previousSecret: string | undefined;
	let engine: NullEngine;
	let scene: Scene;
	let editor: any;
	let options: any;
	let providerFingerprint: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "zvibe-generative-assets-"));
		await ensureDir(join(directory, "assets"));
		await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 35, g: 90, b: 180, alpha: 1 } } })
			.png()
			.toFile(join(directory, "fixture.png"));
		await writeFile(join(directory, "fixture.mjs"), fixtureSource);
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeJSON(projectConfiguration.path, {});
		previousSecret = process.env.ZVIBE_GENERATIVE_TEST_SECRET;
		process.env.ZVIBE_GENERATIVE_TEST_SECRET = "fixture-secret-must-not-leak";
		engine = new NullEngine();
		scene = new Scene(engine);
		editor = { sceneWorkspace: {}, state: { projectPath: projectConfiguration.path }, layout: { preview: { scene } } };
		options = { editor };
		const inventory = await readGenerativeAssetProviderInventory();
		const created = await setGenerativeAssetProvider({
			expectedInventoryFingerprint: inventory.inventoryFingerprint,
			provider: {
				version: 1,
				id: "executable-fixture",
				name: "Executable Fixture",
				vendor: "Zvibe Tests",
				classification: "test-fixture",
				modalities: ["image"],
				hostPlatforms: [process.platform],
				maximumOutputBytes: 2 * 1024 * 1024,
				maximumDurationSeconds: 1,
				transport: {
					kind: "executable",
					executable: "node",
					args: ["${PROJECT}/fixture.mjs", "${REQUEST}", "${OUTPUT}"],
					credentialEnvironments: ["ZVIBE_GENERATIVE_TEST_SECRET"],
				},
			},
		});
		providerFingerprint = created.provider.fingerprint;
	});

	afterEach(async () => {
		await shutdownGenerativeAssets(editor);
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = previousProjectPath;
		if (previousSecret === undefined) {
			delete process.env.ZVIBE_GENERATIVE_TEST_SECRET;
		} else {
			process.env.ZVIBE_GENERATIVE_TEST_SECRET = previousSecret;
		}
		await remove(directory);
	});

	function request(prompt: string, references: Array<{ path: string; role: string }> = []): object {
		return { version: 1, modality: "image", prompt, seed: 17, count: 1, references, parameters: {}, options: { width: 64, height: 64, transparent: false } };
	}

	test("executes, validates, previews, reloads, and deletes one real retained job", async () => {
		const started = await startGenerativeAssetJob(
			scene,
			{
				providerId: "executable-fixture",
				expectedProviderFingerprint: providerFingerprint,
				request: request("create image"),
				confirm: true,
				endpoint: "start_generative_asset_job",
				collaborationToken: "transport-only-token",
			},
			options
		);
		const completed = await waitForTerminal(scene, options, started.id);
		expect(completed).toMatchObject({
			status: "succeeded",
			provider: { classification: "test-fixture", transport: "executable" },
			request: { modality: "image", prompt: "create image" },
			resultFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
			candidates: [{ id: "candidate-1", artifacts: [{ path: "candidate.png", role: "image", inspection: { width: 64, height: 64 } }] }],
		});
		const preview = await getGenerativeAssetPreview(
			scene,
			{ jobId: completed.id, expectedResultFingerprint: completed.resultFingerprint, candidateId: "candidate-1", maximumBytes: 1024 * 1024 },
			options
		);
		expect(preview).toMatchObject({ available: true, mediaType: "image/jpeg", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
		expect((await sharp(Buffer.from(preview.dataBase64, "base64")).metadata()).width).toBe(64);
		const publicationPlan = await inspectGenerativeAssetPublicationAction(
			scene,
			{
				jobId: completed.id,
				expectedRevision: completed.revision,
				expectedResultFingerprint: completed.resultFingerprint,
				candidateId: "candidate-1",
				destinationDirectory: "assets/generated",
				baseName: "fixture-image",
				endpoint: "inspect_generative_asset_publication",
			},
			options
		);
		expect(publicationPlan).toMatchObject({
			planFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
			files: [{ path: "assets/generated/fixture-image.png", action: "create", importerKind: "texture" }],
			classification: "test-fixture",
		});
		const publishing = publishGenerativeAssetCandidateAction(
			scene,
			{
				jobId: completed.id,
				expectedRevision: completed.revision,
				expectedResultFingerprint: completed.resultFingerprint,
				candidateId: "candidate-1",
				destinationDirectory: "assets/generated",
				baseName: "fixture-image",
				expectedPlanFingerprint: publicationPlan.planFingerprint,
				confirm: true,
			},
			options
		);
		await Promise.resolve();
		await expect(deleteGenerativeAssetJob(scene, { jobId: completed.id, expectedRevision: completed.revision, confirm: true }, options)).rejects.toThrow(
			/active generative publication/i
		);
		const published = await publishing;
		expect(published).toMatchObject({
			publication: {
				files: [{ path: "assets/generated/fixture-image.png", importer: { kind: "texture", current: true, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) } }],
			},
			job: { revision: completed.revision + 1, publications: [{ revision: 1 }] },
		});
		const metadata = JSON.parse(await readFile(join(directory, "assets/generated/fixture-image.png.bjsmeta.json"), "utf8"));
		expect(metadata).toMatchObject({
			tags: expect.arrayContaining(["generated", "generated-test-fixture"]),
			importer: {
				kind: "texture",
				extra: { generativeProvenance: { jobId: completed.id, provider: { classification: "test-fixture" }, candidateId: "candidate-1" } },
			},
		});
		expect(await listGenerativeAssetJobs(scene, { modality: "image", providerId: "executable-fixture", limit: 10 }, options)).toMatchObject({
			total: 1,
			jobs: [{ id: completed.id }],
		});

		await shutdownGenerativeAssets(editor);
		editor = { sceneWorkspace: {}, state: { projectPath: projectConfiguration.path }, layout: { preview: { scene } } };
		options = { editor };
		const loaded = await listGenerativeAssetJobs(scene, {}, options);
		expect(loaded).toMatchObject({ total: 1, loadErrors: [] });
		const reloaded = await getGenerativeAssetJob(scene, { jobId: completed.id }, options);
		expect(reloaded).toMatchObject({ status: "succeeded", resultFingerprint: completed.resultFingerprint, publications: [{ revision: 1 }] });
		expect(await deleteGenerativeAssetJob(scene, { jobId: reloaded.id, expectedRevision: reloaded.revision, confirm: true }, options)).toEqual({
			deleted: true,
			jobId: reloaded.id,
			publishedAssetsAffected: false,
		});
		expect(await pathExists(join(directory, ".bjseditor/generative-assets/jobs", reloaded.id))).toBe(false);
	});

	test("redacts credentials, supports cooperative cancellation, and enforces provider timeout", async () => {
		const failedStart = await startGenerativeAssetJob(
			scene,
			{ providerId: "executable-fixture", expectedProviderFingerprint: providerFingerprint, request: request("fail"), confirm: true },
			options
		);
		const failed = await waitForTerminal(scene, options, failedStart.id);
		expect(failed.status).toBe("failed");
		expect(`${failed.error}\n${failed.execution.diagnostics}`).not.toContain("fixture-secret-must-not-leak");
		expect(failed.execution.diagnostics).toContain("[redacted]");
		const splitStart = await startGenerativeAssetJob(
			scene,
			{ providerId: "executable-fixture", expectedProviderFingerprint: providerFingerprint, request: request("split-secret"), confirm: true },
			options
		);
		const splitFailed = await waitForTerminal(scene, options, splitStart.id);
		expect(splitFailed.status).toBe("failed");
		expect(splitFailed.execution.diagnostics).toContain("[redacted]");
		expect(splitFailed.execution.diagnostics).not.toContain("fixture-secret-must-not-leak");

		const cancelStart = await startGenerativeAssetJob(
			scene,
			{ providerId: "executable-fixture", expectedProviderFingerprint: providerFingerprint, request: request("hang"), confirm: true },
			options
		);
		const active = await waitForActive(scene, options, cancelStart.id);
		const canceling = await cancelGenerativeAssetJob(scene, { jobId: active.id, expectedRevision: active.revision, confirm: true }, options);
		expect(canceling.status).toBe("canceling");
		expect((await waitForTerminal(scene, options, active.id)).status).toBe("canceled");

		const timeoutStart = await startGenerativeAssetJob(
			scene,
			{ providerId: "executable-fixture", expectedProviderFingerprint: providerFingerprint, request: request("hang"), confirm: true },
			options
		);
		expect((await waitForTerminal(scene, options, timeoutStart.id)).status).toBe("timed-out");
	});

	test("executes a loopback HTTP provider with inline artifacts and bounded redacted failures", async () => {
		const fixtureBytes = await readFile(join(directory, "fixture.png"));
		const server = createServer(async (requestMessage, response) => {
			try {
				let body = "";
				for await (const chunk of requestMessage) {
					body += chunk.toString("utf8");
				}
				const envelope = JSON.parse(body);
				if (requestMessage.headers.authorization !== "Bearer fixture-secret-must-not-leak") {
					response.writeHead(403, { "Content-Type": "text/plain" }).end("missing authorization");
					return;
				}
				if (envelope.request.prompt === "http-fail") {
					response.writeHead(401, { "Content-Type": "text/plain" }).end("token=fixture-secret-must-not-leak");
					return;
				}
				if (envelope.request.prompt === "http-oversize") {
					response.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(100 * 1024 * 1024) }).end();
					return;
				}
				response.writeHead(200, { "Content-Type": "application/json" }).end(
					JSON.stringify({
						version: 1,
						candidates: [
							{
								id: "http-candidate",
								reportedModel: "loopback-http-fixture",
								artifacts: [{ path: "http-candidate.png", role: "image", mediaType: "image/png", dataBase64: fixtureBytes.toString("base64") }],
							},
						],
					})
				);
			} catch (error) {
				response.writeHead(500, { "Content-Type": "text/plain" }).end(error instanceof Error ? error.message : String(error));
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const port = (server.address() as AddressInfo).port;
			const inventory = await readGenerativeAssetProviderInventory();
			const created = await setGenerativeAssetProvider({
				expectedInventoryFingerprint: inventory.inventoryFingerprint,
				provider: {
					version: 1,
					id: "http-fixture",
					name: "HTTP Fixture",
					vendor: "Zvibe Tests",
					classification: "test-fixture",
					modalities: ["image"],
					hostPlatforms: [],
					maximumOutputBytes: 2 * 1024 * 1024,
					maximumDurationSeconds: 5,
					transport: {
						kind: "http",
						endpoint: `http://127.0.0.1:${port}/generate`,
						authorizationEnvironment: "ZVIBE_GENERATIVE_TEST_SECRET",
						headers: { "X-Fixture": "1" },
					},
				},
			});
			const succeededStart = await startGenerativeAssetJob(
				scene,
				{ providerId: "http-fixture", expectedProviderFingerprint: created.provider.fingerprint, request: request("http-success"), confirm: true },
				options
			);
			const succeeded = await waitForTerminal(scene, options, succeededStart.id);
			expect(succeeded).toMatchObject({
				status: "succeeded",
				execution: { httpStatus: 200, exitCode: null },
				candidates: [{ id: "http-candidate", artifacts: [{ path: "http-candidate.png", inspection: { width: 64, height: 64 } }] }],
			});
			const sanitizedManifest = JSON.parse(await readFile(join(directory, ".bjseditor/generative-assets/jobs", succeeded.id, "output/result.json"), "utf8"));
			expect(sanitizedManifest.candidates[0].artifacts[0].dataBase64).toBeNull();

			for (const prompt of ["http-fail", "http-oversize"]) {
				const started = await startGenerativeAssetJob(
					scene,
					{ providerId: "http-fixture", expectedProviderFingerprint: created.provider.fingerprint, request: request(prompt), confirm: true },
					options
				);
				const failed = await waitForTerminal(scene, options, started.id);
				expect(failed.status).toBe("failed");
				expect(`${failed.error}\n${failed.execution.diagnostics}`).not.toContain("fixture-secret-must-not-leak");
			}
			const failures = await listGenerativeAssetJobs(scene, { status: "failed", providerId: "http-fixture", limit: 10 }, options);
			expect(failures.total).toBe(2);
			expect(failures.jobs.map((job: any) => job.error).join(" ")).toMatch(/401|declares.*limit/i);
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});

	test("rejects changed references and changed provider manifests after real execution", async () => {
		const referencePath = join(directory, "assets/reference.png");
		await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } })
			.png()
			.toFile(referencePath);
		const referenceStart = await startGenerativeAssetJob(
			scene,
			{
				providerId: "executable-fixture",
				expectedProviderFingerprint: providerFingerprint,
				request: request("delay", [{ path: "assets/reference.png", role: "content" }]),
				confirm: true,
			},
			options
		);
		await waitForActive(scene, options, referenceStart.id);
		await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 1 } } })
			.png()
			.toFile(referencePath);
		const referenceFailed = await waitForTerminal(scene, options, referenceStart.id);
		expect(referenceFailed).toMatchObject({ status: "failed", error: expect.stringMatching(/references changed/i) });

		const providerStart = await startGenerativeAssetJob(
			scene,
			{ providerId: "executable-fixture", expectedProviderFingerprint: providerFingerprint, request: request("delay"), confirm: true },
			options
		);
		await waitForActive(scene, options, providerStart.id);
		const inventory = await readGenerativeAssetProviderInventory();
		const manifest = JSON.parse(await readFile(join(directory, ".zvibe/generative-providers/executable-fixture.json"), "utf8"));
		await setGenerativeAssetProvider({
			expectedInventoryFingerprint: inventory.inventoryFingerprint,
			expectedProviderFingerprint: providerFingerprint,
			provider: { ...manifest, name: "Changed During Execution" },
		});
		const providerFailed = await waitForTerminal(scene, options, providerStart.id);
		expect(providerFailed).toMatchObject({ status: "failed", error: expect.stringMatching(/provider manifest changed/i) });
	});

	test("persists project-switch cancellation for an active executable job", async () => {
		const started = await startGenerativeAssetJob(
			scene,
			{ providerId: "executable-fixture", expectedProviderFingerprint: providerFingerprint, request: request("hang"), confirm: true },
			options
		);
		await waitForActive(scene, options, started.id);
		const firstProjectPath = projectConfiguration.path;
		const secondProject = join(directory, "other", "Other.bjseditor");
		await ensureDir(join(directory, "other"));
		await writeJSON(secondProject, {});
		projectConfiguration.path = secondProject;
		expect(await listGenerativeAssetJobs(scene, {}, options)).toMatchObject({ total: 0 });
		projectConfiguration.path = firstProjectPath;
		await shutdownGenerativeAssets(editor);
		editor = { sceneWorkspace: {}, state: { projectPath: projectConfiguration.path }, layout: { preview: { scene } } };
		options = { editor };
		const loaded = await listGenerativeAssetJobs(scene, {}, options);
		expect(loaded).toMatchObject({ total: 1, loadErrors: [] });
		const recovered = await waitForTerminal(scene, options, started.id);
		expect(["canceled", "failed"]).toContain(recovered.status);
		expect(recovered.error ?? recovered.progress.message).toMatch(/project|canceled|stopped/i);
	});

	test("quarantines a tampered retained result instead of exposing untrusted candidate evidence", async () => {
		const started = await startGenerativeAssetJob(
			scene,
			{ providerId: "executable-fixture", expectedProviderFingerprint: providerFingerprint, request: request("create image"), confirm: true },
			options
		);
		const completed = await waitForTerminal(scene, options, started.id);
		expect(completed.status).toBe("succeeded");
		await shutdownGenerativeAssets(editor);
		const jobPath = join(directory, ".bjseditor/generative-assets/jobs", completed.id, "job.json");
		const record = JSON.parse(await readFile(jobPath, "utf8"));
		record.candidates[0].artifacts[0].sha256 = "tampered";
		await writeJSON(jobPath, record);
		editor = { sceneWorkspace: {}, state: { projectPath: projectConfiguration.path }, layout: { preview: { scene } } };
		options = { editor };
		const loaded = await listGenerativeAssetJobs(scene, {}, options);
		expect(loaded.total).toBe(0);
		expect(loaded.loadErrors).toEqual([expect.objectContaining({ path: expect.stringContaining(completed.id), error: expect.stringMatching(/artifact.*evidence/i) })]);
		await expect(getGenerativeAssetJob(scene, { jobId: completed.id }, options)).rejects.toThrow(/not found/i);
	});

	test("enforces two active executions and eight queued jobs without oversubscription", async () => {
		const jobs = [];
		for (let index = 0; index < 10; index++) {
			jobs.push(
				await startGenerativeAssetJob(
					scene,
					{ providerId: "executable-fixture", expectedProviderFingerprint: providerFingerprint, request: request("hang"), confirm: true },
					options
				)
			);
		}
		const snapshot = await listGenerativeAssetJobs(scene, { limit: 20 }, options);
		expect(snapshot.jobs.filter((job: any) => job.status === "running")).toHaveLength(2);
		expect(snapshot.jobs.filter((job: any) => job.status === "queued")).toHaveLength(8);
		await expect(
			startGenerativeAssetJob(scene, { providerId: "executable-fixture", expectedProviderFingerprint: providerFingerprint, request: request("hang"), confirm: true }, options)
		).rejects.toThrow(/queue already contains 8 jobs/i);
		for (const entry of jobs) {
			const current = await getGenerativeAssetJob(scene, { jobId: entry.id }, options);
			await cancelGenerativeAssetJob(scene, { jobId: current.id, expectedRevision: current.revision, confirm: true }, options);
		}
		for (const entry of jobs) {
			expect((await waitForTerminal(scene, options, entry.id)).status).toBe("canceled");
		}
	});
});
