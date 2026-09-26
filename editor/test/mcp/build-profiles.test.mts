import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { execNodePty, exportProject } = vi.hoisted(() => ({ execNodePty: vi.fn(), exportProject: vi.fn(async () => true) }));

vi.mock("../../src/tools/node-pty", () => ({ execNodePty }));
vi.mock("../../src/project/export/export", () => ({ exportProject }));

import { NullEngine, Observable, Scene } from "babylonjs";
import { chmod, ensureDir, mkdtemp, readFile, readJSON, remove, writeFile, writeJSON } from "fs-extra";
import { tmpdir } from "os";
import { dirname, join } from "path/posix";

import { projectConfiguration } from "../../src/project/configuration";
import { getEditorCapabilities } from "../../src/mcp/editor";
import { MCPEndpoints } from "../../src/mcp/mcp";
import {
	buildAndRunBuildProfile,
	buildBuildProfile,
	cleanBuildProfileOutput,
	createBuildProfile,
	deleteBuildProfile,
	deleteBuildReport,
	duplicateBuildProfile,
	generatePwaManifest,
	generatePwaServiceWorker,
	getAndroidBuildProfilePlan,
	getLinuxArm64ServerSourceBuildPlan,
	getBuildPipelineStatus,
	getBuildProfileEnvironment,
	getDevelopmentBuildCoverage,
	getBuildReport,
	installPwaServiceWorkerRegistration,
	inspectWebBuildPlan,
	listBuildProfiles,
	listBuildReports,
	recordBuildReport,
	runBuildProfile,
	setActiveBuildProfile,
	setBuildProfile,
	stopBuildProfileRun,
	validateBuildProfile,
	verifyWebBuildOutput,
	verifyLinuxArm64ServerSourceBuild,
} from "../../src/mcp/project/export";

describe("mcp/build profiles", () => {
	let directory: string;
	let projectPath: string;
	let engine: NullEngine;
	let scene: Scene;
	let releaseRun: ((code: number) => void) | undefined;
	const options = {
		editor: {
			state: {
				projectPath: "",
				packageManager: "yarn",
				lastOpenedScenePath: "scene/main.scene",
				sceneBuildSettings: { scenes: [{ path: "scene/main.scene", enabled: true }] },
			},
		},
	} as any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "zvibe-build-pipeline-"));
		projectPath = join(directory, "Game.bjseditor");
		await writeJSON(projectPath, {});
		await writeJSON(join(directory, "package.json"), { scripts: { "build:test": "build-test", "dev:test": "dev-test" } });
		await ensureDir(join(directory, "src"));
		await writeFile(join(directory, "src/index.ts"), "export const game = true;\n");
		await ensureDir(join(directory, "public/scene"));
		await writeFile(join(directory, "public/scene/scene.babylon"), "scene");
		projectConfiguration.path = projectPath;
		options.editor.state.projectPath = projectPath;
		engine = new NullEngine();
		scene = new Scene(engine);
		releaseRun = undefined;
		exportProject.mockClear();
		execNodePty.mockReset();
		execNodePty.mockImplementation(async (command: string, processOptions: any) => {
			const observable = new Observable<string>();
			if (command.includes("build:test")) {
				const output = join(processOptions.cwd, processOptions.env.BJS_EDITOR_OUTPUT_DIRECTORY);
				await ensureDir(output);
				await writeFile(join(output, "game.js"), `built:${execNodePty.mock.calls.length}`);
				await writeFile(join(output, "texture.png"), Buffer.from([137, 80, 78, 71]));
				await writeFile(join(output, "photo.jpg"), Buffer.from([255, 216, 255, 217]));
				queueMicrotask(() => observable.notifyObservers("build complete\n"));
				return { id: `build-${execNodePty.mock.calls.length}`, onGetDataObservable: observable, wait: vi.fn(async () => 0), kill: vi.fn() };
			}
			let resolve!: (code: number) => void;
			const exited = new Promise<number>((done) => (resolve = done));
			releaseRun = resolve;
			return { id: "run-1", onGetDataObservable: observable, wait: vi.fn(() => exited), kill: vi.fn(() => resolve(143)) };
		});
	});

	afterEach(async () => {
		releaseRun?.(143);
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = null;
		delete process.env.ZVIBE_TEST_SIGNING_IDENTITY;
		await remove(directory);
	});

	test("keeps an explicit Electron target platform instead of replacing it with the host platform", () => {
		const hostPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
		Object.defineProperty(process, "platform", { ...hostPlatform, value: "linux" });
		try {
			createBuildProfile(scene, { expectedRevision: 0, id: "mac", name: "Mac", target: "electron", settings: { electronPlatform: "darwin" } });
			createBuildProfile(scene, { expectedRevision: 1, id: "windows", name: "Windows", target: "electron", settings: { electronPlatform: "win32" } });
			createBuildProfile(scene, { expectedRevision: 2, id: "host", name: "Host", target: "electron" });
			expect(listBuildProfiles(scene).profiles.map((profile: any) => [profile.id, profile.settings.electronPlatform])).toEqual([
				["mac", "darwin"],
				["windows", "win32"],
				["host", "linux"],
			]);
		} finally {
			Object.defineProperty(process, "platform", hostPlatform);
		}
	});

	test("migrates legacy profiles and enforces exact revisions, stable ids, active selection, duplicate, rename, and delete", () => {
		(scene.metadata ??= {}).babylonEditorBuildProfiles = [{ name: "Legacy Web", target: "web", settings: { outputDirectory: "dist/legacy" } }];
		const migrated = listBuildProfiles(scene);
		expect(migrated).toMatchObject({ version: 2, revision: 0, profiles: [{ id: "profile-1", name: "Legacy Web", target: "web" }] });
		expect(scene.metadata.babylonEditorBuildProfiles).toBeUndefined();
		const created = createBuildProfile(scene, { expectedRevision: 0, id: "desktop", name: "Desktop", target: "electron" });
		expect(created.configuration).toMatchObject({ revision: 1, activeProfileId: "profile-1" });
		expect(() => createBuildProfile(scene, { expectedRevision: 0, name: "Stale" })).toThrow(/Stale Build Pipeline revision/);
		const duplicate = duplicateBuildProfile(scene, { expectedRevision: 1, id: "desktop", newId: "desktop-copy", newName: "Desktop Copy" });
		expect(duplicate.profile).toMatchObject({ id: "desktop-copy", name: "Desktop Copy", target: "electron" });
		expect(setActiveBuildProfile(scene, { expectedRevision: 2, id: "desktop-copy" })).toMatchObject({ revision: 3, activeProfileId: "desktop-copy" });
		expect(setBuildProfile(scene, { expectedRevision: 3, id: "desktop-copy", name: "Desktop Release", enabled: false }).profile).toMatchObject({
			name: "Desktop Release",
			enabled: false,
		});
		expect(deleteBuildProfile(scene, { expectedRevision: 4, id: "desktop-copy" })).toMatchObject({
			deleted: true,
			configuration: { revision: 5, activeProfileId: "profile-1" },
		});
	});

	test("normalizes all five targets and exposes explicit non-secret settings and signing references", () => {
		let revision = 0;
		for (const target of ["web", "electron", "headless", "android", "ios"] as const) {
			createBuildProfile(scene, {
				expectedRevision: revision++,
				id: target,
				name: target.toUpperCase(),
				target,
				settings: { applicationId: "com.example.game", outputDirectory: `dist/${target}` },
			});
		}
		const updated = setBuildProfile(scene, {
			expectedRevision: revision,
			id: "electron",
			settings: {
				productName: "Nebula",
				companyName: "Zvibe",
				version: "1.0.0",
				applicationId: "com.zvibe.nebula",
				outputDirectory: "dist/electron",
				buildMode: "release",
				compression: "none",
				defineSymbols: ["RELEASE"],
				buildScripts: ["build:test"],
				runScript: "dev:test",
				electronPlatform: "win32",
				electronArch: "arm64",
				electronAsar: false,
				signing: { enabled: true, identityEnvironment: "ZVIBE_TEST_SIGNING_IDENTITY" },
			},
		}).profile;
		expect(updated.settings).toMatchObject({ buildMode: "release", sourceMaps: false, minify: true, electronPlatform: "win32", electronArch: "arm64", electronAsar: false });
		const result = getBuildProfileEnvironment(scene, { id: "electron" }, options);
		expect(result.environment).toMatchObject({
			BJS_EDITOR_BUILD_PROFILE_ID: "electron",
			BJS_EDITOR_BUILD_TARGET: "electron",
			BJS_EDITOR_PRODUCT_NAME: "Nebula",
			BJS_EDITOR_APPLICATION_ID: "com.zvibe.nebula",
			BJS_EDITOR_SIGNING_IDENTITY_ENVIRONMENT: "ZVIBE_TEST_SIGNING_IDENTITY",
		});
		expect(JSON.stringify(result)).not.toContain("secret-value");
		expect(listBuildProfiles(scene).profiles.map((profile) => profile.target)).toEqual(["web", "electron", "headless", "android", "ios"]);
		expect(listBuildProfiles(scene).profiles[0].settings.web).toMatchObject({
			moduleStripping: true,
			webAssembly2023: true,
			emscriptenToolchain: "typescript-bundler",
			emscriptenExecutable: "emcc",
		});
		const webEnvironment = getBuildProfileEnvironment(scene, { id: "web" }, options).environment;
		expect(webEnvironment).toMatchObject({
			BJS_EDITOR_WEB_MODULE_STRIPPING: "true",
			BJS_EDITOR_WEBASSEMBLY_2023: "true",
			BJS_EDITOR_EMSCRIPTEN_TOOLCHAIN: "typescript-bundler",
			BJS_EDITOR_EMSCRIPTEN_VERSION: "not-used",
		});
	});

	test("authors exact Android LTO, XR ThinLTO, and initialization-marker plans through Build Profiles", async () => {
		await writeJSON(join(directory, "package.json"), { scripts: { "build:test": "build-test" } });
		const created = createBuildProfile(scene, {
			expectedRevision: 0,
			id: "android-release",
			name: "Android Release",
			target: "android",
			settings: {
				buildScripts: ["build:test"],
				android: { linkTimeOptimization: "full", xrLinkTimeOptimization: "thin", initializationProfiling: true },
			},
		});
		expect(created.profile.settings.android).toEqual({ linkTimeOptimization: "full", xrLinkTimeOptimization: "thin", initializationProfiling: true });
		const plan = getAndroidBuildProfilePlan(scene, { id: "android-release" }) as any;
		expect(plan).toMatchObject({
			configurationRevision: 1,
			plan: {
				backend: "zvibe-android-project-native-lto-v1",
				lto: { mode: "full", compilerFlags: ["-flto=full"], scope: "project-externalNativeBuild-cmake", prebuiltLibrariesRecompiled: false },
				xr: { mode: "thin", cmakeDefinition: "-DZVIBE_XR_LTO_MODE=THIN", prebuiltXrLibrariesRecompiled: false },
				initializationProfiling: { enabled: true, boundedMarkerCapacity: 128, source: "ZvibePlayerInitialization.kt" },
			},
		});
		expect(plan.plan.initializationProfiling.androidTraceSections).toContain("Zvibe.AndroidPlayer.FirstFrame");
		const environment = getBuildProfileEnvironment(scene, { id: "android-release" }, options).environment;
		expect(JSON.parse(environment.BJS_EDITOR_ANDROID_BUILD_SETTINGS)).toEqual(created.profile.settings.android);
		expect(JSON.parse(environment.BJS_EDITOR_ANDROID_BUILD_PLAN)).toMatchObject({ lto: { mode: "full" }, xr: { mode: "thin" } });
		const validation = await validateBuildProfile(scene, { id: "android-release" }, options);
		expect(validation).toMatchObject({ valid: true });
		expect(validation.warnings.join(" ")).toContain("prebuilt engine");
		expect(() => getAndroidBuildProfilePlan(scene, { id: "missing" })).toThrow("was not found");

		const web = createBuildProfile(scene, { expectedRevision: 1, id: "web-only", name: "Web Only", target: "web" });
		expect(() => getAndroidBuildProfilePlan(scene, { id: web.profile.id })).toThrow("an Android profile is required");
	});

	test("authors a deterministic public-toolchain Linux ARM64 Dedicated Server source-build plan", async () => {
		const created = createBuildProfile(scene, {
			expectedRevision: 0,
			id: "linux-arm64-server",
			name: "Linux ARM64 Server",
			target: "headless",
			settings: { headless: { operatingSystem: "linux", architecture: "arm64", sourceBuild: true, nodeMajor: 22 } },
		});
		expect(created.profile.settings.headless).toEqual({ operatingSystem: "linux", architecture: "arm64", sourceBuild: true, nodeMajor: 22 });
		const result = getLinuxArm64ServerSourceBuildPlan(scene, { id: created.profile.id }) as any;
		expect(result).toMatchObject({
			configurationRevision: 1,
			profile: { id: "linux-arm64-server", enabled: true },
			plan: {
				backend: "zvibe-public-node-linux-arm64-server-source-v1",
				target: { operatingSystem: "linux", architecture: "arm64", sourceBuild: true },
				publicToolchain: { nodeMajor: 22, moduleFormat: "esm", containerPlatform: "linux/arm64" },
				artifacts: ["server.mjs", "server-game.mjs", "zvibe-platform-runtime.json", "package.json", "Dockerfile.linux-arm64"],
				planFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
			},
		});
		const environment = getBuildProfileEnvironment(scene, { id: created.profile.id }, options).environment;
		expect(JSON.parse(environment.BJS_EDITOR_HEADLESS_BUILD_SETTINGS)).toEqual(created.profile.settings.headless);
		expect(JSON.parse(environment.BJS_EDITOR_LINUX_ARM64_SERVER_SOURCE_BUILD_PLAN)).toMatchObject({ planFingerprint: result.plan.planFingerprint });
		const packageJson = await readJSON(join(directory, "package.json"));
		packageJson.scripts["build:headless"] = "build-test";
		await writeJSON(join(directory, "package.json"), packageJson);
		expect(await validateBuildProfile(scene, { id: created.profile.id }, options)).toMatchObject({
			valid: true,
			warnings: expect.arrayContaining([expect.stringContaining("native addons")]),
		});
		expect(
			await verifyLinuxArm64ServerSourceBuild(scene, { id: created.profile.id, expectedRevision: 1, expectedPlanFingerprint: result.plan.planFingerprint }, options)
		).toMatchObject({ built: false, valid: false });
		const x64 = createBuildProfile(scene, {
			expectedRevision: 1,
			id: "linux-x64-server",
			name: "Linux x64 Server",
			target: "headless",
			settings: { headless: { operatingSystem: "linux", architecture: "x64", sourceBuild: true, nodeMajor: 22 } },
		});
		expect(() => getLinuxArm64ServerSourceBuildPlan(scene, { id: x64.profile.id })).toThrow("select arm64");
	});

	test("creates deterministic Web module plans and validates the opt-in external Emscripten 4.0.19 adapter", async () => {
		await writeFile(join(directory, "src/index.ts"), 'import { AnimationGroup } from "@babylonjs/core/Animations";\nexport { AnimationGroup };\n');
		await writeFile(join(directory, "public/texture.png"), Buffer.from([137, 80, 78, 71]));
		await writeFile(join(directory, "public/photo.jpg"), Buffer.from([255, 216, 255, 217]));
		const created = createBuildProfile(scene, { expectedRevision: 0, id: "web-plan", name: "Web Plan", target: "web", settings: { buildScripts: ["build:test"] } });
		const plan = await inspectWebBuildPlan(scene, { id: "web-plan", expectedRevision: created.configuration.revision }, options);
		expect(plan).toMatchObject({
			backend: "zvibe-web-module-stripping-v1",
			configurationRevision: created.configuration.revision,
			settings: { moduleStripping: true, webAssembly2023: true, emscriptenToolchain: "typescript-bundler" },
			images: { png: { files: 1 }, jpeg: { files: 1 }, decoderBoundary: "browser-native-no-bundled-libpng-or-libjpeg" },
			toolchain: { verified: true, detectedVersion: null },
		});
		expect(plan.planFingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(plan.modules.find((entry: any) => entry.id === "animation")).toMatchObject({ decision: "retain", evidencePaths: ["src/index.ts"] });
		expect(plan.modules.find((entry: any) => entry.id === "physics")).toMatchObject({ decision: "strip", evidencePaths: [] });
		expect((await inspectWebBuildPlan(scene, { id: "web-plan", expectedRevision: created.configuration.revision }, options)).planFingerprint).toBe(plan.planFingerprint);
		await expect(inspectWebBuildPlan(scene, { id: "web-plan", expectedRevision: 0 }, options)).rejects.toThrow(/Stale Build Pipeline revision/);

		const emcc = join(directory, "emcc-test");
		await writeFile(emcc, "#!/bin/sh\necho 'emcc (Emscripten) 4.0.19'\n");
		await chmod(emcc, 0o755);
		const updated = setBuildProfile(scene, {
			expectedRevision: created.configuration.revision,
			id: "web-plan",
			settings: { ...created.profile.settings, web: { ...created.profile.settings.web, emscriptenToolchain: "external-4.0.19", emscriptenExecutable: emcc } },
		});
		const externalPlan = await inspectWebBuildPlan(scene, { id: "web-plan", expectedRevision: updated.configuration.revision }, options);
		expect(externalPlan.toolchain).toMatchObject({ requestedVersion: "4.0.19", detectedVersion: null, verified: false, reason: expect.stringContaining("awaits build-time") });
		expect(await validateBuildProfile(scene, { id: "web-plan" }, options)).toMatchObject({ valid: true });
		const externalBuild = await buildBuildProfile(scene, { id: "web-plan", expectedRevision: updated.configuration.revision }, options);
		expect(externalBuild.webBuildEvidence.toolchain).toMatchObject({ requestedVersion: "4.0.19", detectedVersion: "4.0.19", verified: true });
	});

	test("rejects native PNG or JPEG codec evidence even when it is embedded in a valid WebAssembly artifact", async () => {
		const created = createBuildProfile(scene, {
			expectedRevision: 0,
			id: "codec-proof",
			name: "Codec Proof",
			target: "web",
			settings: { outputDirectory: "dist/codec-proof", buildScripts: ["build:test"] },
		});
		execNodePty.mockImplementationOnce(async (_command: string, processOptions: any) => {
			const output = join(processOptions.cwd, processOptions.env.BJS_EDITOR_OUTPUT_DIRECTORY);
			await ensureDir(output);
			const wasmWithLibPngCustomSection = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x00, 0x07, 0x06, 0x6c, 0x69, 0x62, 0x70, 0x6e, 0x67]);
			expect(WebAssembly.validate(wasmWithLibPngCustomSection)).toBe(true);
			await writeFile(join(output, "codec.wasm"), wasmWithLibPngCustomSection);
			const observable = new Observable<string>();
			return { id: "codec-build", onGetDataObservable: observable, wait: vi.fn(async () => 0), kill: vi.fn() };
		});
		await expect(buildBuildProfile(scene, { expectedRevision: created.configuration.revision, id: "codec-proof" }, options)).rejects.toThrow(/Native libpng markers remain/);
		expect(listBuildReports(scene).reports[0]).toMatchObject({ profile: "Codec Proof", outcome: "failed" });
	});

	test("enables bounded source coverage only for standalone Electron development profiles and reads the exact generated manifest", async () => {
		const created = createBuildProfile(scene, {
			expectedRevision: 0,
			id: "desktop-coverage",
			name: "Desktop Coverage",
			target: "electron",
			settings: { buildMode: "development", codeCoverage: true, electronPlatform: "win32", buildScripts: ["build:test"] },
		});
		const environment = getBuildProfileEnvironment(scene, { id: "desktop-coverage" }, options).environment;
		expect(environment).toMatchObject({ BJS_EDITOR_CODE_COVERAGE: "true", BJS_EDITOR_ELECTRON_PLATFORM: "win32" });
		expect(environment.BJS_EDITOR_CODE_COVERAGE_MANIFEST).toContain("/.bjseditor/build-coverage/");
		expect(await getDevelopmentBuildCoverage(scene, { id: "desktop-coverage" }, options)).toMatchObject({
			configured: true,
			compatible: true,
			reason: expect.stringContaining("Build this exact profile"),
			manifest: null,
			runtime: { global: "globalThis.__zvibeDevelopmentBuildCoverageV1", operations: ["snapshot", "clear", "export"] },
		});
		await ensureDir(dirname(environment.BJS_EDITOR_CODE_COVERAGE_MANIFEST));
		await writeJSON(environment.BJS_EDITOR_CODE_COVERAGE_MANIFEST, {
			version: 1,
			backend: "zvibe-development-build-coverage-v1",
			fingerprint: "a".repeat(64),
			profileId: "desktop-coverage",
			targetPlatform: "win32",
			files: 1,
			points: [{ id: "function:1:1:0", path: "src/game.ts", line: 1, column: 1, kind: "function", functionName: "game" }],
		});
		expect(await getDevelopmentBuildCoverage(scene, { id: "desktop-coverage", limit: 1 }, options)).toMatchObject({
			configured: true,
			compatible: true,
			configurationRevision: created.configuration.revision,
			manifest: { fingerprint: "a".repeat(64), pointCount: 1, pagination: { total: 1, hasMore: false } },
			runtime: { exportFormats: ["json", "lcov"] },
		});
		expect(() =>
			createBuildProfile(scene, {
				expectedRevision: created.configuration.revision,
				id: "web-coverage",
				name: "Web Coverage",
				target: "web",
				settings: { buildMode: "development", codeCoverage: true },
			})
		).toThrow(/only for an Electron development build/);
	});

	test("validates signing prerequisites and executes staged builds with redaction, artifact hashes, verified incremental caching, tamper detection, and cleaning", async () => {
		process.env.ZVIBE_TEST_SIGNING_IDENTITY = "secret-value";
		const created = createBuildProfile(scene, {
			expectedRevision: 0,
			id: "web-release",
			name: "Web Release",
			settings: {
				outputDirectory: "dist/web",
				buildScripts: ["build:test"],
				runScript: "dev:test",
				incremental: true,
				signing: { enabled: true, identityEnvironment: "ZVIBE_TEST_SIGNING_IDENTITY" },
			},
		});
		const revision = created.configuration.revision;
		expect(await validateBuildProfile(scene, { id: "web-release" }, options)).toMatchObject({ valid: true, configurationRevision: revision, stages: [{ name: "build" }] });
		const first = await buildBuildProfile(scene, { expectedRevision: revision, id: "web-release" }, options);
		expect(first).toMatchObject({
			built: true,
			cacheHit: false,
			output: { fileCount: 5, completeArtifactHashes: true },
			webBuildEvidence: {
				backend: "zvibe-web-build-evidence-v1",
				output: { valid: true, images: { png: { files: 1, nativeLibraryMarkersAbsent: true }, jpeg: { files: 1, nativeLibraryMarkersAbsent: true } } },
			},
		});
		expect(first.output.artifacts[0]).toMatchObject({ path: "game.js", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
		expect(await readJSON(join(directory, "dist/web/zvibe-player-settings.json"))).toMatchObject({ version: 2, buildTarget: "web", identity: { productName: "Zvibe Game" } });
		expect(first.buildReport.stages.map((stage: any) => [stage.name, stage.status])).toEqual([
			["validation", "passed"],
			["clean", "skipped"],
			["export", "passed"],
			["build", "passed"],
		]);
		expect(execNodePty.mock.calls[0][1].env.BJS_EDITOR_SIGNING_IDENTITY).toBe("secret-value");
		expect(JSON.parse(execNodePty.mock.calls[0][1].env.BJS_EDITOR_WEB_BUILD_PLAN)).toMatchObject({
			profileId: "web-release",
			planFingerprint: first.webBuildEvidence.plan.planFingerprint,
			settings: { webAssembly2023: true, moduleStripping: true },
		});
		expect(JSON.stringify(first)).not.toContain("secret-value");
		const verified = await verifyWebBuildOutput(
			scene,
			{ expectedRevision: revision, id: "web-release", expectedPlanFingerprint: first.webBuildEvidence.plan.planFingerprint },
			options
		);
		expect(verified).toMatchObject({ valid: true, output: { valid: true }, manifestPath: "zvibe-web-build-manifest.json" });
		const evidenceManifestPath = join(directory, "dist/web/zvibe-web-build-manifest.json");
		const evidenceManifestBytes = await readFile(evidenceManifestPath);
		const tamperedEvidenceManifest = JSON.parse(evidenceManifestBytes.toString("utf8"));
		tamperedEvidenceManifest.plan.modules[0].decision = "preserve";
		await writeJSON(evidenceManifestPath, tamperedEvidenceManifest, { spaces: "\t" });
		await expect(
			verifyWebBuildOutput(scene, { expectedRevision: revision, id: "web-release", expectedPlanFingerprint: first.webBuildEvidence.plan.planFingerprint }, options)
		).rejects.toThrow(/plan integrity check failed/);
		await writeFile(evidenceManifestPath, evidenceManifestBytes);
		await expect(verifyWebBuildOutput(scene, { expectedRevision: revision, id: "web-release", expectedPlanFingerprint: "0".repeat(64) }, options)).rejects.toThrow(
			/Stale Web build plan fingerprint/
		);
		const second = await buildBuildProfile(scene, { expectedRevision: revision, id: "web-release" }, options);
		expect(second).toMatchObject({ built: false, cacheHit: true, buildReport: { cachedFromReportId: first.buildReport.id } });
		expect(execNodePty).toHaveBeenCalledTimes(1);
		await writeFile(join(directory, "dist/web/game.js"), "tampered");
		const third = await buildBuildProfile(scene, { expectedRevision: revision, id: "web-release" }, options);
		expect(third).toMatchObject({ built: true, cacheHit: false });
		expect(execNodePty).toHaveBeenCalledTimes(2);
		const cleaned = await cleanBuildProfileOutput(scene, { expectedRevision: revision, id: "web-release", confirm: true }, options);
		expect(cleaned).toMatchObject({ cleaned: true, removedFileCount: 5, outputDirectory: "dist/web" });
		expect(await readFile(join(directory, "public/scene/scene.babylon"), "utf8")).toBe("scene");
	});

	test("builds, launches, reports, stops, and dismisses an explicit Build & Run process", async () => {
		const created = createBuildProfile(scene, {
			expectedRevision: 0,
			id: "play-web",
			name: "Play Web",
			settings: { outputDirectory: "dist/play", buildScripts: ["build:test"], runScript: "dev:test" },
		});
		const result = await buildAndRunBuildProfile(scene, { expectedRevision: created.configuration.revision, id: "play-web" }, options);
		expect(result.run).toMatchObject({ id: "run-1", status: "running", command: "yarn run dev:test" });
		expect(getBuildPipelineStatus(scene)).toMatchObject({ configurationRevision: 1, activeProfileId: "play-web", runs: [{ id: "run-1", status: "running" }] });
		expect(await stopBuildProfileRun(scene, { runId: "run-1", confirm: true })).toMatchObject({
			stopped: true,
			dismissed: true,
			run: { id: "run-1", status: "exited", exitCode: 143 },
		});
		expect(getBuildPipelineStatus(scene)).toMatchObject({ runs: [] });
	});

	test("runs long export and build operations as pollable non-blocking jobs", async () => {
		let finishExport!: (value: boolean) => void;
		exportProject.mockImplementationOnce(() => new Promise<boolean>((resolve) => (finishExport = resolve)));
		const created = createBuildProfile(scene, {
			expectedRevision: 0,
			id: "background-web",
			name: "Background Web",
			settings: { outputDirectory: "dist/background", buildScripts: ["build:test"] },
		});
		const accepted = await runBuildProfile(scene, { expectedRevision: created.configuration.revision, id: "background-web", background: true }, options);
		expect(accepted).toMatchObject({ accepted: true, job: { operation: "export", profileId: "background-web", status: "queued" } });
		expect(getBuildPipelineStatus(scene)).toMatchObject({ jobs: [{ id: accepted.job.id, status: "queued" }] });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(getBuildPipelineStatus(scene, { jobId: accepted.job.id })).toMatchObject({ jobs: [{ status: "running" }] });
		await expect(buildBuildProfile(scene, { expectedRevision: created.configuration.revision, id: "background-web", background: true }, options)).rejects.toThrow(
			/already running/
		);
		finishExport(true);
		await vi.waitFor(() => expect(getBuildPipelineStatus(scene, { jobId: accepted.job.id })).toMatchObject({ jobs: [{ status: "succeeded" }] }));
		const completed = getBuildPipelineStatus(scene, { jobId: accepted.job.id, includeResult: true }) as any;
		expect(completed.jobs[0]).toMatchObject({ result: { buildReport: { outcome: "exported" } } });
	});

	test("retains the newest 50 reports and supports exact report reads and cleanup", () => {
		for (let index = 0; index < 51; index++) recordBuildReport(scene, { profile: `Web ${index}`, outcome: "exported" });
		const reports = listBuildReports(scene).reports;
		expect(reports).toHaveLength(50);
		expect(reports[0]).toMatchObject({ version: 2, profile: "Web 50" });
		expect(reports[49].profile).toBe("Web 1");
		expect(getBuildReport(scene, { id: reports[0].id })).toMatchObject({ profile: "Web 50" });
		expect(deleteBuildReport(scene, { id: reports[0].id, confirm: true })).toMatchObject({ deleted: true });
		expect(listBuildReports(scene).reports).toHaveLength(49);
	});

	test("generates an offline-capable PWA manifest, worker, and idempotent registration at an exact revision", async () => {
		const created = createBuildProfile(scene, {
			expectedRevision: 0,
			id: "pwa",
			name: "Web Offline",
			settings: {
				productName: "Nebula",
				version: "2.0.0",
				web: { basePath: "/game" },
				pwa: {
					name: "Nebula PWA",
					shortName: "Neb",
					startUrl: "/launch",
					display: "minimal-ui",
					manifestPath: "public/manifest.webmanifest",
					serviceWorkerPath: "public/worker.js",
					offlineFallbackUrl: "/offline.html",
					precacheUrls: ["/launch", "/offline.html"],
				},
			},
		});
		const request = { expectedRevision: created.configuration.revision, id: "pwa" };
		expect(await generatePwaManifest(scene, request, options)).toMatchObject({ path: "public/manifest.webmanifest", manifest: { name: "Nebula PWA", start_url: "/launch" } });
		expect(await readJSON(join(directory, "public/manifest.webmanifest"))).toMatchObject({ short_name: "Neb", display: "minimal-ui" });
		expect(await generatePwaServiceWorker(scene, request, options)).toMatchObject({ path: "public/worker.js", precacheUrls: ["/launch", "/offline.html"] });
		expect(await readFile(join(directory, "public/worker.js"), "utf8")).toContain('const OFFLINE_FALLBACK_URL = "/offline.html";');
		await writeFile(join(directory, "index.html"), "<!doctype html><html><body><main></main></body></html>");
		expect(await installPwaServiceWorkerRegistration(scene, request, options)).toMatchObject({ path: "index.html", changed: true });
		expect(await installPwaServiceWorkerRegistration(scene, request, options)).toMatchObject({ changed: false });
	});

	test("rejects missing package scripts, missing signing variables, unsafe output paths, and stale PWA writes", async () => {
		const created = createBuildProfile(scene, {
			expectedRevision: 0,
			id: "broken",
			name: "Broken",
			settings: { outputDirectory: "src/generated", buildScripts: ["missing"], signing: { enabled: true, identityEnvironment: "MISSING_SIGNING_SECRET" } },
		});
		const validation = await validateBuildProfile(scene, { id: "broken" }, options);
		expect(validation.valid).toBe(false);
		expect(validation.reasons.join(" ")).toMatch(/missing.*script|requires.*script/i);
		expect(validation.reasons.join(" ")).toContain("Signing environment variable is not defined");
		expect(validation.reasons.join(" ")).toContain("cannot overwrite source");
		await expect(buildBuildProfile(scene, { expectedRevision: created.configuration.revision, id: "broken" }, options)).rejects.toThrow("Build profile cannot run");
		await expect(generatePwaManifest(scene, { expectedRevision: 0, id: "broken" }, options)).rejects.toThrow(/Stale Build Pipeline revision/);
		expect(listBuildReports(scene).reports[0]).toMatchObject({ profile: "Broken", outcome: "failed" });
	});

	test("exposes complete editor and MCP surfaces for external clients", () => {
		const capabilities = getEditorCapabilities(scene, {}, options).features;
		expect(capabilities.buildPipelineExactRevisions).toBe(true);
		expect(capabilities.buildPipelineIncrementalCache).toBe(true);
		expect(capabilities.buildPipelineSigningEnvironment).toBe(true);
		expect(capabilities.buildPipelineStageReports).toBe(true);
		expect(capabilities.buildPipelineBackgroundJobs).toBe(true);
		expect(capabilities.androidBuildProfileLtoAndInitializationMarkers).toBe(true);
		expect(capabilities.linuxArm64DedicatedServerPublicSourceBuild).toBe(true);
		expect(capabilities.webBuildModuleStrippingEvidence).toBe(true);
		expect(capabilities.webAssembly2023BuildProfiles).toBe(true);
		expect(capabilities.emscripten4019AdapterValidation).toBe(true);
		expect(capabilities.browserNativeImageCodecEvidence).toBe(true);
		expect(capabilities.developmentBuildCodeCoverage).toBe(true);
		expect(capabilities.serializationSessionDiagnostics).toBe(true);
		expect(capabilities.buildAndRun).toBe(true);
		for (const endpoint of [
			"list_build_profiles",
			"create_build_profile",
			"duplicate_build_profile",
			"set_active_build_profile",
			"set_build_profile",
			"delete_build_profile",
			"validate_build_profile",
			"build_build_profile",
			"build_and_run_build_profile",
			"stop_build_profile_run",
			"get_build_pipeline_status",
			"get_android_build_profile_plan",
			"get_linux_arm64_server_source_build_plan",
			"verify_linux_arm64_server_source_build",
			"inspect_web_build_plan",
			"verify_web_build_output",
			"clean_build_profile_output",
			"list_build_reports",
			"get_build_report",
			"delete_build_report",
			"get_development_build_coverage",
			"get_project_serialization_session",
		]) {
			expect(MCPEndpoints[endpoint]).toBeTypeOf("function");
		}
	});
});
