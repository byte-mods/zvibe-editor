import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { mkdtemp, pathExists, readJSON, remove, writeFile, writeJSON } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path";
import { NullEngine, Scene } from "babylonjs";
import { ProjectServiceError, ProjectServicesClient, normalizeProjectServicesConfiguration, projectServiceCategories } from "babylonjs-editor-tools";

import {
	deleteProjectServiceEnvironment,
	getProjectServicesConfiguration,
	normalizeProjectServicesControlConfiguration,
	setActiveProjectServiceEnvironment,
	setProjectServiceCategory,
	setProjectServiceEnvironment,
	setProjectServiceResources,
	validateProjectServicesReadiness,
} from "../../src/mcp/project/services/configuration";
import {
	deleteProjectServicesDeploymentReport,
	deployProjectServices,
	getProjectServicesDeploymentReport,
	listProjectServicesDeploymentReports,
	planProjectServicesDeployment,
} from "../../src/mcp/project/services/deployment";
import {
	getProjectServicesEmulatorEvents,
	getProjectServicesEmulatorStatus,
	resetProjectServicesEmulator,
	startProjectServicesEmulator,
	stopProjectServicesEmulator,
} from "../../src/mcp/project/services/emulator";
import { getEditorCapabilities } from "../../src/mcp/editor";

describe("mcp/project-services", () => {
	let directory: string;
	let engine: NullEngine;
	let scene: Scene;
	const credentialName = "ZVIBE_SERVICES_TEST_CREDENTIAL";
	const options = { editor: { state: { projectPath: "", packageManager: "npm" } } } as any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "zvibe-services-"));
		options.editor.state.projectPath = join(directory, "Game.bjseditor");
		await writeFile(join(directory, "deploy.mjs"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
		await writeJSON(join(directory, "package.json"), { name: "services-game", private: true, scripts: { "services:deploy": "node deploy.mjs" } });
		engine = new NullEngine();
		scene = new Scene(engine);
		delete process.env[credentialName];
	});

	afterEach(async () => {
		delete process.env[credentialName];
		await stopProjectServicesEmulator(scene);
		scene.dispose();
		engine.dispose();
		await remove(directory);
	});

	test("migrates the legacy runtime contract on first mutation while keeping reads pure", () => {
		scene.metadata = {
			babylonEditorServices: {
				auth: { enabled: true, provider: "rest", endpoint: "https://services.example.test", options: { audience: "game" } },
			},
		};
		const initial = getProjectServicesConfiguration(scene, {});
		expect(initial).toMatchObject({ revision: 0, activeEnvironmentId: "development" });
		expect(initial.environments[0].services.auth).toMatchObject({ enabled: true, provider: "rest" });
		expect(scene.metadata.babylonEditorServicesControl).toBeUndefined();

		const updated = setProjectServiceEnvironment(scene, { expectedRevision: 0, id: "development", name: "Local Development", kind: "development" });
		expect(updated.revision).toBe(1);
		expect(scene.metadata.babylonEditorServicesControl.revision).toBe(1);
		expect(scene.metadata.babylonEditorServices.environment).toBe("development");
	});

	test("rejects malformed current-version state instead of silently resetting it", () => {
		expect(() => normalizeProjectServicesControlConfiguration({ version: 1, revision: 4, activeEnvironmentId: "missing", environments: [], extra: true }, undefined)).toThrow(
			/Unknown project services configuration field|require/
		);
	});

	test("manages exact-revision environments and protects active deletion", () => {
		let configuration = setProjectServiceEnvironment(scene, { expectedRevision: 0, id: "staging", name: "Staging", kind: "staging" });
		expect(configuration.environments.map((entry) => entry.id)).toEqual(["development", "staging"]);
		expect(() => setActiveProjectServiceEnvironment(scene, { expectedRevision: 0, id: "staging" })).toThrow(/current revision 1/);
		configuration = setActiveProjectServiceEnvironment(scene, { expectedRevision: 1, id: "staging" });
		expect(configuration.activeEnvironmentId).toBe("staging");
		expect(scene.metadata.babylonEditorServices.environment).toBe("staging");
		expect(() => deleteProjectServiceEnvironment(scene, { expectedRevision: 2, id: "staging", confirm: true })).toThrow(/active/);
		configuration = setActiveProjectServiceEnvironment(scene, { expectedRevision: 2, id: "development" });
		expect(deleteProjectServiceEnvironment(scene, { expectedRevision: 3, id: "staging", confirm: true }).environments).toHaveLength(1);
	});

	test("validates service settings and provider-neutral resource catalogs", () => {
		let configuration = setProjectServiceCategory(scene, {
			expectedRevision: 0,
			environmentId: "development",
			category: "analytics",
			settings: { enabled: true, provider: "rest", endpoint: "https://services.example.test", options: { batchSize: 20 } },
		});
		configuration = setProjectServiceResources(scene, {
			expectedRevision: configuration.revision,
			environmentId: "development",
			resources: {
				analyticsEvents: [{ name: "level_complete", description: "Completed a level", enabled: true, parameters: [{ name: "level", type: "integer", required: true }] }],
				iapProducts: [
					{
						id: "coins.small",
						type: "consumable",
						title: "Small Coins",
						description: "100 coins",
						currency: "USD",
						priceMicros: 990000,
						payouts: [{ id: "coins", quantity: 100 }],
					},
				],
				adPlacements: [{ id: "reward_coins", type: "rewarded", reward: { id: "coins", quantity: 10 } }],
				matchmakingQueues: [{ id: "ranked", minPlayers: 2, maxPlayers: 8, ticketTimeoutSeconds: 60, skillTolerance: 100, relaxationSeconds: 15 }],
			},
		});
		expect(configuration.environments[0].resources.analyticsEvents[0].parameters[0]).toEqual({ name: "level", type: "integer", required: true });
		expect(() =>
			setProjectServiceCategory(scene, {
				expectedRevision: configuration.revision,
				environmentId: "development",
				category: "analytics",
				settings: { enabled: true, provider: "rest", endpoint: "https://services.example.test", options: { accessToken: "must-not-persist" } },
			})
		).toThrow(/secret-like key/);
		expect(() =>
			setProjectServiceResources(scene, {
				expectedRevision: configuration.revision,
				environmentId: "development",
				resources: { analyticsEvents: [], iapProducts: [], adPlacements: [{ id: "reward", type: "rewarded", reward: null }], matchmakingQueues: [] },
			})
		).toThrow(/requires a reward/);
	});

	test("reports runtime and deployment readiness without exposing credential values", async () => {
		let configuration = setProjectServiceCategory(scene, {
			expectedRevision: 0,
			environmentId: "development",
			category: "auth",
			settings: { enabled: true, provider: "local", endpoint: "http://127.0.0.1:8787", options: {} },
		});
		configuration = setProjectServiceEnvironment(scene, {
			expectedRevision: configuration.revision,
			id: "development",
			deployment: { script: "services:deploy", credentialEnvironmentVariables: [credentialName] },
		});
		let readiness = await validateProjectServicesReadiness(scene, {}, options);
		expect(readiness.readiness).toEqual({ runtime: true, deployment: false });
		expect(readiness.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "credential_unavailable", severity: "error" })]));
		process.env[credentialName] = "not-returned";
		readiness = await validateProjectServicesReadiness(scene, {}, options);
		expect(readiness.readiness).toEqual({ runtime: true, deployment: true });
		expect(JSON.stringify(readiness)).not.toContain("not-returned");
	});

	test("plans without side effects, deploys an exact reviewed revision, and retains bounded reports", async () => {
		let configuration = setProjectServiceCategory(scene, {
			expectedRevision: 0,
			environmentId: "development",
			category: "cloudSave",
			settings: { enabled: true, provider: "local", endpoint: "http://127.0.0.1:8787", options: {} },
		});
		configuration = setProjectServiceResources(scene, {
			expectedRevision: configuration.revision,
			environmentId: "development",
			resources: { analyticsEvents: [], iapProducts: [], adPlacements: [], matchmakingQueues: [] },
		});
		const plan = await planProjectServicesDeployment(scene, { expectedRevision: configuration.revision, dryRun: true, reconcile: true, timeoutMs: 10_000 }, options);
		expect(plan).toMatchObject({ valid: true, dryRun: true, reconcile: true, environmentId: "development" });
		expect(plan.fingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(await pathExists(join(directory, ".zvibe"))).toBe(false);
		await expect(deployProjectServices(scene, { planId: plan.id, expectedFingerprint: plan.fingerprint, confirm: false }, options)).rejects.toThrow(/confirm=true/);

		const report = await deployProjectServices(scene, { planId: plan.id, expectedFingerprint: plan.fingerprint, confirm: true }, options);
		expect(report).toMatchObject({ status: "succeeded", planId: plan.id, dryRun: true, reconcile: true });
		expect(report.stdout).toContain("--environment");
		const artifact = await readJSON(join(directory, ".zvibe", "services", "environments", "development.json"));
		expect(artifact).toMatchObject({ configurationRevision: configuration.revision, fingerprint: plan.fingerprint, environment: { id: "development" } });
		expect(listProjectServicesDeploymentReports(scene)).toHaveLength(1);
		expect(getProjectServicesDeploymentReport(scene, { reportId: report.id })).toEqual(report);
		expect(deleteProjectServicesDeploymentReport(scene, { reportId: report.id, confirm: true })).toEqual({ deleted: true, reportId: report.id });
		expect(listProjectServicesDeploymentReports(scene)).toEqual([]);
	});

	test("rejects stale deployment plans after service or package drift", async () => {
		const plan = await planProjectServicesDeployment(scene, { expectedRevision: 0, dryRun: true }, options);
		setProjectServiceEnvironment(scene, { expectedRevision: 0, id: "development", name: "Changed" });
		await expect(deployProjectServices(scene, { planId: plan.id, expectedFingerprint: plan.fingerprint, confirm: true }, options)).rejects.toThrow(/changed after planning/);

		const current = getProjectServicesConfiguration(scene, {});
		const packagePlan = await planProjectServicesDeployment(scene, { expectedRevision: current.revision, dryRun: true }, options);
		await writeJSON(join(directory, "package.json"), { name: "services-game-changed", private: true, scripts: { "services:deploy": "node deploy.mjs" } });
		await expect(deployProjectServices(scene, { planId: packagePlan.id, expectedFingerprint: packagePlan.fingerprint, confirm: true }, options)).rejects.toThrow(
			/changed after planning/
		);
	});

	test("runs all ten service categories end to end and persists local player data across restarts", async () => {
		const configuration = setProjectServiceResources(scene, {
			expectedRevision: 0,
			environmentId: "development",
			resources: {
				analyticsEvents: [{ name: "level_complete", description: "Completed a level", enabled: true, parameters: [{ name: "level", type: "integer", required: true }] }],
				iapProducts: [
					{
						id: "coins.small",
						type: "consumable",
						title: "Small Coins",
						description: "100 coins",
						currency: "USD",
						priceMicros: 990000,
						payouts: [{ id: "coins", quantity: 100 }],
					},
				],
				adPlacements: [{ id: "reward_coins", type: "rewarded", reward: { id: "coins", quantity: 10 } }],
				matchmakingQueues: [{ id: "ranked", minPlayers: 2, maxPlayers: 4, ticketTimeoutSeconds: 60, skillTolerance: null, relaxationSeconds: null }],
				leaderboards: [{ id: "career", name: "Career", sortOrder: "descending", keepBest: true, maxEntries: 100 }],
				remoteConfig: [{ key: "difficulty", value: "hard" }],
				contentDeliveryBuckets: [
					{
						id: "game",
						badges: [{ id: "latest", releaseId: "r1" }],
						releases: [
							{
								id: "r1",
								entries: [{ key: "level", url: "https://cdn.example.test/level.glb", sha256: "a".repeat(64), bytes: 1024, contentType: "model/gltf-binary" }],
							},
						],
					},
				],
				cloudFunctions: [{ id: "grant", entryPoint: "deploy.mjs", timeoutMs: 5_000, authenticated: true, emulatorResponse: { granted: true } }],
			},
		});
		let status = await startProjectServicesEmulator(scene, { expectedRevision: configuration.revision, environmentId: "development", port: 0 }, options);
		expect(status).toMatchObject({ running: true, environmentId: "development", host: "127.0.0.1" });
		expect(status.port).toBeGreaterThan(0);

		const runtime = normalizeProjectServicesConfiguration({
			environment: "development",
			...Object.fromEntries(projectServiceCategories.map((category) => [category, { enabled: true, provider: "local", endpoint: status.endpoint, options: {} }])),
		});
		const first = new ProjectServicesClient(runtime);
		const second = new ProjectServicesClient(runtime);
		const firstSession = await first.signInAnonymously("player-one");
		await second.signInAnonymously("player-two");

		const written = await first.writeCloudSave([{ key: "progress", value: { level: 3 }, expectedRevision: 0 }]);
		expect(written[0]).toMatchObject({ key: "progress", value: { level: 3 }, revision: 1 });
		await expect(first.writeCloudSave([{ key: "progress", value: { level: 4 }, expectedRevision: 0 }])).rejects.toMatchObject<ProjectServiceError>({
			code: "revision_conflict",
			status: 409,
		});
		expect(await first.readCloudSave(["progress"])).toEqual([expect.objectContaining({ key: "progress", revision: 1 })]);

		expect(
			await first.recordAnalyticsEvents([
				{ name: "level_complete", parameters: { level: 3 } },
				{ name: "unknown_event", parameters: {} },
			])
		).toEqual({ accepted: 1, rejected: 1 });
		expect(await first.listIapProducts()).toEqual([expect.objectContaining({ id: "coins.small", priceMicros: 990000 })]);
		const purchase = await first.purchaseProduct("coins.small", "purchase_0001");
		expect(await first.purchaseProduct("coins.small", "purchase_0001")).toEqual(purchase);
		expect(await first.restorePurchases()).toMatchObject({ purchases: [expect.objectContaining({ productId: "coins.small" })] });
		expect(await first.listAdPlacements()).toEqual([expect.objectContaining({ id: "reward_coins", type: "rewarded" })]);
		expect(await first.showAd("reward_coins")).toMatchObject({ completed: true, reward: { id: "coins", quantity: 10 } });

		const firstTicket = await first.createMatchTicket("ranked", { skill: 42 }, "ticket_0001");
		expect(firstTicket.status).toBe("searching");
		expect((await second.createMatchTicket("ranked", { skill: 44 }, "ticket_0002")).status).toBe("matched");
		expect(await first.getMatchTicket(firstTicket.id)).toMatchObject({ status: "matched", match: { playerIds: expect.arrayContaining([firstSession.playerId]) } });
		expect(await first.submitLeaderboardScore("career", 42, { level: 3 })).toMatchObject({ rank: 1, score: 42 });
		expect(await first.submitLeaderboardScore("career", 12)).toMatchObject({ rank: 1, score: 42 });
		expect((await first.getLeaderboardScores("career")).entries).toEqual([expect.objectContaining({ playerId: firstSession.playerId, score: 42, rank: 1 })]);
		expect(await first.fetchRemoteConfig(["difficulty"])).toMatchObject({ revision: expect.stringMatching(/^[a-f0-9]{64}$/), values: { difficulty: "hard" } });
		expect(await first.getContentDeliveryManifest("game", "latest")).toMatchObject({ releaseId: "r1", entries: [expect.objectContaining({ key: "level" })] });
		const functionResult = await first.callCloudFunction("grant", { amount: 1 }, "function_0001");
		expect(functionResult).toMatchObject({ functionId: "grant", result: { granted: true } });
		expect(await first.callCloudFunction("grant", { amount: 2 }, "function_0001")).toEqual(functionResult);

		const events = getProjectServicesEmulatorEvents(scene, { category: "cloudSave", limit: 20 });
		expect(events.events).toEqual(expect.arrayContaining([expect.objectContaining({ action: "write", playerId: firstSession.playerId })]));
		expect(getProjectServicesEmulatorStatus(scene).counts).toMatchObject({
			players: 2,
			cloudSaveItems: 1,
			analyticsEvents: 1,
			purchases: 1,
			adImpressions: 1,
			matchTickets: 2,
			leaderboardScores: 1,
			functionExecutions: 1,
		});

		expect(await stopProjectServicesEmulator(scene)).toMatchObject({ stopped: true, environmentId: "development" });
		status = await startProjectServicesEmulator(scene, { expectedRevision: configuration.revision, environmentId: "development", port: 0 }, options);
		const restartedRuntime = normalizeProjectServicesConfiguration({
			environment: "development",
			...Object.fromEntries(projectServiceCategories.map((category) => [category, { enabled: true, provider: "local", endpoint: status.endpoint, options: {} }])),
		});
		const restarted = new ProjectServicesClient(restartedRuntime);
		expect((await restarted.signInAnonymously("player-one")).playerId).toBe(firstSession.playerId);
		expect(await restarted.readCloudSave(["progress"])).toEqual([expect.objectContaining({ key: "progress", value: { level: 3 } })]);
		expect((await resetProjectServicesEmulator(scene, { confirm: true })).status.counts).toMatchObject({ players: 0, cloudSaveItems: 0, purchases: 0 });
	});

	test("limits emulator cross-origin browser access to local development origins", async () => {
		const status = await startProjectServicesEmulator(scene, { expectedRevision: 0, port: 0 }, options);
		const forbidden = await fetch(`${status.endpoint}/v1/iap/products`, { headers: { Origin: "https://attacker.example", "X-Zvibe-Environment": "development" } });
		expect(forbidden.status).toBe(403);
		const preflight = await fetch(`${status.endpoint}/v1/iap/products`, { method: "OPTIONS", headers: { Origin: "http://localhost:3000" } });
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
	});

	test("publishes the complete implemented Services feature flags", () => {
		expect(getEditorCapabilities(scene, {}, options).features).toMatchObject({
			projectServices: true,
			projectServiceEnvironments: true,
			projectServiceDeploymentPlans: true,
			projectServicesEmulator: true,
			projectServicesPortableRuntimeClient: true,
		});
	});
});
