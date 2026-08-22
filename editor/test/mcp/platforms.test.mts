import { chmod, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ensureDir, pathExists, readJSON, remove, writeJSON } from "fs-extra";
import { NullEngine, Scene } from "babylonjs";

import { getEditorCapabilities } from "../../src/mcp/editor";
import { MCPEndpoints } from "../../src/mcp/mcp";
import {
	createBuildProfile,
	getBuildProfileEnvironment,
	getLinuxArm64ServerSourceBuildPlan,
	validateBuildProfile,
	verifyLinuxArm64ServerSourceBuild,
} from "../../src/mcp/project/export";
import {
	generatePlatformScaffold,
	getIosProjectGenerationCapabilities,
	getPlatformDiagnostics,
	getPlatformScaffold,
	listPlatformCapabilities,
	removePlatformScaffold,
	validateIosGeneratedProject,
	validatePlatformBuildMatrix,
} from "../../src/mcp/project/platforms";
import { getInstalledPlatformRestartStatus, planInstalledPlatformRestart, restartEditorForInstalledPlatform } from "../../src/mcp/project/platform-restart";
import { createDefaultProjectSettings } from "../../src/project/settings";

const execFileAsync = promisify(execFile);

async function unusedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	return port;
}

describe("mcp/platform support", () => {
	let directory: string;
	let scene: Scene;
	let options: any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "zvibe-platforms-"));
		await ensureDir(join(directory, "assets", "example.scene"));
		await writeJSON(join(directory, "package.json"), { name: "game", private: true, scripts: { build: 'node -e "process.exit(0)"' } }, { spaces: "\t" });
		await symlink(join(process.cwd(), "../node_modules"), join(directory, "node_modules"), "dir");
		await writeFile(join(directory, "project.bjseditor"), "{}", "utf8");
		scene = new Scene(new NullEngine());
		options = {
			editor: {
				state: {
					projectPath: join(directory, "project.bjseditor"),
					packageManager: "yarn",
					lastOpenedScenePath: join(directory, "assets", "example.scene"),
					sceneBuildSettings: { scenes: [{ path: "assets/example.scene", enabled: true }] },
					projectSettings: createDefaultProjectSettings("Platform Game"),
				},
				platformRestartEvidence: null,
				restartForInstalledPlatform: async (request: Record<string, unknown>) => ({ scheduled: true, ...request }),
			},
		};
	});

	afterEach(async () => {
		scene.dispose();
		await remove(directory);
	});

	test("reports honest built-in, scaffolded, integrated, and unsupported platform boundaries", () => {
		const capabilities = listPlatformCapabilities();
		expect(capabilities.platforms).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ target: "web", support: "built-in" }),
				expect.objectContaining({ target: "electron", support: "built-in" }),
				expect.objectContaining({ target: "android", support: "scaffolded", projectScaffold: true }),
				expect.objectContaining({ target: "ios", support: "scaffolded", projectScaffold: true }),
				expect.objectContaining({ target: "headless", name: "Dedicated Server", support: "scaffolded" }),
				expect.objectContaining({ target: "webxr", support: "integrated", buildProfileTarget: "web" }),
				expect.objectContaining({ target: "console", support: "unsupported" }),
			])
		);
		expect(capabilities.integrations).toMatchObject({ buildProfiles: true, projectSettings: true, webXR: true, deviceSimulation: true });
	});

	test("generates, verifies, revises, runs ownership, preserves game hooks, and removes a dedicated-server scaffold", async () => {
		const generated = await generatePlatformScaffold(
			scene,
			{ target: "headless", expectedRevision: 0, settings: { baseBuildScript: "build", port: 8123, tickRate: 60, maximumCatchUpSteps: 3 } },
			options
		);
		expect(generated).toMatchObject({ target: "headless", exists: true, revision: 1, integrity: true });
		const packageJson = await readJSON(join(directory, "package.json"));
		expect(packageJson.scripts).toMatchObject({ "build:headless": "node .zvibe/platforms/headless/build.mjs", "run:headless": "node .zvibe/platforms/headless/run.mjs" });
		const hookPath = join(directory, ".zvibe/platforms/headless/server-game.mjs");
		await writeFile(hookPath, "export async function onTick(context) { context.state.gameTicks = (context.state.gameTicks ?? 0) + 1; }\n", "utf8");
		const revised = await generatePlatformScaffold(scene, { target: "headless", expectedRevision: 1, settings: { tickRate: 30 } }, options);
		expect(revised).toMatchObject({ revision: 2, integrity: true });
		expect(await readFile(hookPath, "utf8")).toContain("gameTicks");
		await expect(removePlatformScaffold(scene, { target: "headless", expectedRevision: 1, confirm: true }, options)).rejects.toThrow("current revision is 2");
		const removed = await removePlatformScaffold(scene, { target: "headless", expectedRevision: 2, confirm: true }, options);
		expect(removed).toMatchObject({ removed: true, preservedUserFiles: ["server-game.mjs"] });
		expect(await pathExists(hookPath)).toBe(true);
		expect((await readJSON(join(directory, "package.json"))).scripts).not.toHaveProperty("build:headless");
		expect(await getPlatformScaffold(scene, { target: "headless" }, options)).toMatchObject({ exists: false, revision: 0 });
	});

	test("guards generated-file tampering and existing package scripts before replacement", async () => {
		await generatePlatformScaffold(scene, { target: "android", expectedRevision: 0, settings: { minimumSdk: 24, targetSdk: 35, format: "aab" } }, options);
		const buildPath = join(directory, ".zvibe/platforms/android/build.mjs");
		await writeFile(buildPath, "tampered", "utf8");
		expect(await getPlatformScaffold(scene, { target: "android" }, options)).toMatchObject({ revision: 1, integrity: false });
		await expect(generatePlatformScaffold(scene, { target: "android", expectedRevision: 1 }, options)).rejects.toThrow("modified or missing");
		await expect(generatePlatformScaffold(scene, { target: "android", expectedRevision: 1, overwrite: true }, options)).rejects.toThrow("confirm=true");
		expect(await generatePlatformScaffold(scene, { target: "android", expectedRevision: 1, overwrite: true, confirm: true }, options)).toMatchObject({
			revision: 2,
			integrity: true,
		});
	});

	test("builds and runs the generated fixed-rate dedicated-server host with preserved game hooks", async () => {
		await generatePlatformScaffold(scene, { target: "headless", expectedRevision: 0, settings: { tickRate: 60 } }, options);
		const output = join(directory, "dist/headless");
		await execFileAsync(process.execPath, [join(directory, ".zvibe/platforms/headless/build.mjs")], {
			cwd: directory,
			env: {
				...process.env,
				BJS_EDITOR_BUILD_TARGET: "headless",
				BJS_EDITOR_OUTPUT_DIRECTORY: "dist/headless",
				BJS_EDITOR_PLAYER_SETTINGS: JSON.stringify(options.editor.state.projectSettings),
				npm_config_user_agent: "yarn/1.22.22",
			},
			timeout: 30_000,
		});
		expect(await pathExists(join(output, "server.mjs"))).toBe(true);
		expect(await readJSON(join(output, "zvibe-platform-runtime.json"))).toMatchObject({ target: "headless", settings: { tickRate: 60 } });
		const port = await unusedPort();
		const server = spawn(process.execPath, [join(output, "server.mjs")], { cwd: output, env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
		let serverOutput = "";
		server.stdout?.on("data", (chunk) => (serverOutput += chunk.toString()));
		server.stderr?.on("data", (chunk) => (serverOutput += chunk.toString()));
		const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
		try {
			let health: any = null;
			// A complete Vitest run saturates the host with worker processes; retain the same
			// 50 ms poll cadence while allowing the generated Node host five seconds to boot.
			for (let attempt = 0; attempt < 100 && !(health?.ticks > 0); attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				try {
					health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
				} catch {
					// Server is still starting.
				}
			}
			expect(health, serverOutput).toMatchObject({ ok: true, target: "headless", running: true });
			expect(health.ticks).toBeGreaterThan(0);
		} finally {
			if (server.exitCode === null && server.signalCode === null) {
				server.kill("SIGTERM");
			}
			await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
		}
	});

	test("builds and verifies a real public Node source package targeted to Linux ARM64", async () => {
		await generatePlatformScaffold(scene, { target: "headless", expectedRevision: 0, settings: { tickRate: 60 } }, options);
		const created = createBuildProfile(scene, {
			expectedRevision: 0,
			id: "linux-arm64",
			name: "Linux ARM64",
			target: "headless",
			settings: { headless: { operatingSystem: "linux", architecture: "arm64", sourceBuild: true, nodeMajor: 22 } },
		});
		const sourcePlan = getLinuxArm64ServerSourceBuildPlan(scene, { id: created.profile.id }) as any;
		const environment = getBuildProfileEnvironment(scene, { id: created.profile.id }, options).environment;
		const buildScript = join(directory, ".zvibe/platforms/headless/build.mjs");
		const escapedRelativePath = `../${basename(directory)}-escape`;
		await expect(
			execFileAsync(process.execPath, [buildScript], {
				cwd: directory,
				env: { ...process.env, ...environment, BJS_EDITOR_OUTPUT_DIRECTORY: escapedRelativePath, npm_config_user_agent: "yarn/1.22.22" },
				timeout: 30_000,
			})
		).rejects.toThrow("project-relative path without traversal");
		expect(await pathExists(`${directory}-escape`)).toBe(false);
		await expect(
			execFileAsync(process.execPath, [buildScript], {
				cwd: directory,
				env: { ...process.env, ...environment, BJS_EDITOR_BUILD_PROFILE_ID: "another-profile", npm_config_user_agent: "yarn/1.22.22" },
				timeout: 30_000,
			})
		).rejects.toThrow("does not belong to the active Build Profile");
		await execFileAsync(process.execPath, [join(directory, ".zvibe/platforms/headless/build.mjs")], {
			cwd: directory,
			env: { ...process.env, ...environment, npm_config_user_agent: "yarn/1.22.22" },
			timeout: 30_000,
		});
		const output = join(directory, "dist/headless");
		const descriptor = await readJSON(join(output, "zvibe-linux-arm64-source-build.json"));
		expect(descriptor).toMatchObject({
			backend: "zvibe-public-node-linux-arm64-server-source-v1",
			profileId: "linux-arm64",
			planFingerprint: sourcePlan.plan.planFingerprint,
			target: { operatingSystem: "linux", architecture: "arm64", sourceBuild: true },
			artifacts: expect.arrayContaining([expect.objectContaining({ path: "server.mjs", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })]),
		});
		expect(await readJSON(join(output, "package.json"))).toMatchObject({ os: ["linux"], cpu: ["arm64"], engines: { node: ">=22 <23" } });
		expect(await readFile(join(output, "Dockerfile.linux-arm64"), "utf8")).toContain("--platform=linux/arm64");
		expect(
			await verifyLinuxArm64ServerSourceBuild(scene, { id: "linux-arm64", expectedRevision: 1, expectedPlanFingerprint: sourcePlan.plan.planFingerprint }, options)
		).toMatchObject({ built: true, valid: true, target: { architecture: "arm64" }, artifacts: expect.arrayContaining([expect.objectContaining({ matches: true })]) });
		await writeFile(join(output, "server.mjs"), "syntax !!!", "utf8");
		expect(
			await verifyLinuxArm64ServerSourceBuild(scene, { id: "linux-arm64", expectedRevision: 1, expectedPlanFingerprint: sourcePlan.plan.planFingerprint }, options)
		).toMatchObject({ built: true, valid: false, errors: expect.arrayContaining([expect.stringContaining("changed after"), expect.stringContaining("syntax")]) });
	});

	test("normalizes mobile wrapper settings and reports current host/toolchain readiness", async () => {
		const generated = await generatePlatformScaffold(
			scene,
			{ target: "ios", expectedRevision: 0, settings: { deploymentTarget: "17.0", deviceFamily: "ipad", orientation: "landscape", targetMinimumVisionOSVersion: "2.1" } },
			options
		);
		expect(generated.manifest.settings).toMatchObject({ deploymentTarget: "17.0", deviceFamily: "ipad", orientation: "landscape", targetMinimumVisionOSVersion: "2.1" });
		const capacitor = await readJSON(join(directory, ".zvibe/platforms/ios/capacitor.config.json"));
		expect(capacitor).toMatchObject({ appId: "com.default.zvibegame", appName: "Platform Game", zvibe: { target: "ios", deploymentTarget: "17.0" } });
		expect(capacitor.webDir).toBe("../../../dist/ios");
		const providerPath = join(directory, ".zvibe/platforms/ios/ZvibeAdaptivePerformancePlugin.swift");
		const providerSource = await readFile(providerPath, "utf8");
		expect(providerSource).toContain("ProcessInfo.thermalStateDidChangeNotification");
		expect(providerSource).toContain('notifyListeners("thermalStateChanged"');
		expect(await readFile(join(directory, ".zvibe/platforms/ios/ZvibeVisionOS.xcconfig"), "utf8")).toContain("XROS_DEPLOYMENT_TARGET = 2.1");
		if (process.platform === "darwin") {
			await execFileAsync("xcrun", ["swiftc", "-frontend", "-parse", providerPath], { timeout: 30_000 });
		}
		expect(generated.manifest.generatedFiles).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "ZvibeAdaptivePerformancePlugin.swift" }), expect.objectContaining({ path: "ZvibeVisionOS.xcconfig" })])
		);
		const diagnostics = await getPlatformDiagnostics(scene, { target: "ios" }, options);
		expect(diagnostics.diagnostics[0]).toMatchObject({ descriptor: { target: "ios" }, scaffold: { exists: true, integrity: true }, packageScript: { present: true } });
		const output = join(directory, "dist/ios");
		await execFileAsync(process.execPath, [join(directory, ".zvibe/platforms/ios/build.mjs")], {
			cwd: directory,
			env: {
				...process.env,
				BJS_EDITOR_BUILD_TARGET: "ios",
				BJS_EDITOR_OUTPUT_DIRECTORY: "dist/ios",
				BJS_EDITOR_PLAYER_SETTINGS: JSON.stringify(options.editor.state.projectSettings),
				npm_config_user_agent: "yarn/1.22.22",
			},
			timeout: 30_000,
		});
		expect(await readFile(join(output, "ZvibeAdaptivePerformancePlugin.swift"), "utf8")).toBe(providerSource);
		expect(await readFile(join(output, "ZvibeVisionOS.xcconfig"), "utf8")).toContain("XROS_DEPLOYMENT_TARGET = 2.1");
		await expect(generatePlatformScaffold(scene, { target: "android", expectedRevision: 0, settings: { minimumSdk: 35, targetSdk: 24 } }, options)).rejects.toThrow(
			"minimumSdk <= targetSdk"
		);
		await expect(generatePlatformScaffold(scene, { target: "android", expectedRevision: 0, settings: { unknown: true } }, options)).rejects.toThrow(
			"Unknown android platform setting"
		);
		await expect(generatePlatformScaffold(scene, { target: "headless", expectedRevision: 0, settings: { tickRate: "fast" } }, options)).rejects.toThrow(
			"tickRate must be an integer"
		);
	});

	test("builds the generated Android Web payload adapter without requiring a native SDK", async () => {
		await generatePlatformScaffold(scene, { target: "android", expectedRevision: 0, settings: { minimumSdk: 26, targetSdk: 35, format: "aab" } }, options);
		const output = join(directory, "dist/android");
		await execFileAsync(process.execPath, [join(directory, ".zvibe/platforms/android/build.mjs")], {
			cwd: directory,
			env: {
				...process.env,
				BJS_EDITOR_BUILD_TARGET: "android",
				BJS_EDITOR_BUILD_PROFILE_ID: "android-release",
				BJS_EDITOR_OUTPUT_DIRECTORY: "dist/android",
				BJS_EDITOR_ANDROID_BUILD_SETTINGS: JSON.stringify({ linkTimeOptimization: "thin", xrLinkTimeOptimization: "thin", initializationProfiling: true }),
				BJS_EDITOR_PLAYER_SETTINGS: JSON.stringify(options.editor.state.projectSettings),
				npm_config_user_agent: "yarn/1.22.22",
			},
			timeout: 30_000,
		});
		expect(await readJSON(join(output, "zvibe-platform-runtime.json"))).toMatchObject({ target: "android", settings: { minimumSdk: 26, targetSdk: 35, format: "aab" } });
		expect(await readJSON(join(output, "capacitor.config.json"))).toMatchObject({ appId: "com.default.zvibegame", webDir: ".", zvibe: { target: "android", format: "aab" } });
		const windowInsetsSource = await readFile(join(output, "ZvibeWindowInsetsPlugin.kt"), "utf8");
		expect(windowInsetsSource).toContain('@CapacitorPlugin(name = "ZvibeWindowInsets")');
		expect(windowInsetsSource).toContain('notifyListeners("windowInsetsChanged"');
		const initializationSource = await readFile(join(output, "ZvibePlayerInitialization.kt"), "utf8");
		expect(initializationSource).toContain("class ZvibePlayerInitializationProvider : ContentProvider()");
		expect(initializationSource).toContain("Trace.beginSection(section)");
		expect(initializationSource).toContain('@CapacitorPlugin(name = "ZvibePlayerInitialization")');
		expect(await readFile(join(directory, ".zvibe/platforms/android/build.mjs"), "utf8")).toContain("Zvibe Player Initialization: start");
		expect(await readFile(join(directory, ".zvibe/platforms/android/zvibe-build-profile.init.gradle"), "utf8")).toContain("CMAKE_INTERPROCEDURAL_OPTIMIZATION");
		try {
			await writeFile(join(directory, "settings.gradle"), "rootProject.name = 'zvibe-android-build-profile-syntax'\n", "utf8");
			await execFileAsync("gradle", ["--no-daemon", "--init-script", join(directory, ".zvibe/platforms/android/zvibe-build-profile.init.gradle"), "tasks"], {
				cwd: directory,
				env: {
					...process.env,
					ZVIBE_ANDROID_BUILD_PLAN: JSON.stringify({
						settings: { linkTimeOptimization: "thin", xrLinkTimeOptimization: "thin", initializationProfiling: true },
					}),
				},
				timeout: 30_000,
			});
		} catch (error: any) {
			if (error?.code !== "ENOENT") {
				throw error;
			}
		}
		expect(await readJSON(join(output, "zvibe-android-build-profile.json"))).toMatchObject({
			backend: "zvibe-android-project-native-lto-v1",
			profileId: "android-release",
			settings: { linkTimeOptimization: "thin", xrLinkTimeOptimization: "thin", initializationProfiling: true },
			lto: { compilerFlags: ["-flto=thin"], prebuiltLibrariesRecompiled: false },
			xr: { cmakeDefinition: "-DZVIBE_XR_LTO_MODE=THIN", prebuiltXrLibrariesRecompiled: false },
		});
	});

	test("installs and removes the early Android initialization provider during exact native sync", async () => {
		await generatePlatformScaffold(scene, { target: "android", expectedRevision: 0, settings: { syncNativeProject: true } }, options);
		const bin = join(directory, "bin");
		await ensureDir(bin);
		const npx = join(bin, "npx");
		await writeFile(
			npx,
			"#!/bin/sh\nmkdir -p android/app/src/main/java android/app/src/main\nif [ ! -f android/app/src/main/AndroidManifest.xml ]; then printf '%s' '<manifest xmlns:android=\"http://schemas.android.com/apk/res/android\"><application></application></manifest>' > android/app/src/main/AndroidManifest.xml; fi\n",
			"utf8"
		);
		await chmod(npx, 0o755);
		const build = join(directory, ".zvibe/platforms/android/build.mjs");
		const commonEnvironment = {
			...process.env,
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			BJS_EDITOR_BUILD_TARGET: "android",
			BJS_EDITOR_OUTPUT_DIRECTORY: "dist/android",
			BJS_EDITOR_PLAYER_SETTINGS: JSON.stringify(options.editor.state.projectSettings),
			npm_config_user_agent: "yarn/1.22.22",
		};
		await execFileAsync(process.execPath, [build], {
			cwd: directory,
			env: { ...commonEnvironment, BJS_EDITOR_ANDROID_BUILD_SETTINGS: JSON.stringify({ initializationProfiling: true }) },
			timeout: 30_000,
		});
		const manifestPath = join(directory, ".zvibe/platforms/android/android/app/src/main/AndroidManifest.xml");
		expect(await readFile(manifestPath, "utf8")).toContain('android:name="com.zvibe.editor.ZvibePlayerInitializationProvider"');
		await execFileAsync(process.execPath, [build], {
			cwd: directory,
			env: { ...commonEnvironment, BJS_EDITOR_ANDROID_BUILD_SETTINGS: JSON.stringify({ initializationProfiling: false }) },
			timeout: 30_000,
		});
		expect(await readFile(manifestPath, "utf8")).not.toContain("Zvibe Player Initialization");
	});

	test("generates, builds, validates, and cleanly migrates the experimental Swift iOS project type", async () => {
		expect(getIosProjectGenerationCapabilities()).toMatchObject({
			projectTypes: expect.arrayContaining([expect.objectContaining({ id: "swift", status: "experimental", minimumIosVersion: "16.0" })]),
			swiftProject: { projectPath: "SwiftProject/ZvibeGame.xcodeproj", scheme: "ZvibeGame" },
		});
		await expect(
			generatePlatformScaffold(scene, { target: "ios", expectedRevision: 0, settings: { projectType: "swift", deploymentTarget: "15.0" } }, options)
		).rejects.toThrow("16.0 or newer");
		const generated = await generatePlatformScaffold(
			scene,
			{ target: "ios", expectedRevision: 0, settings: { projectType: "swift", deploymentTarget: "16.0", deviceFamily: "universal" } },
			options
		);
		expect(generated).toMatchObject({ revision: 1, integrity: true, manifest: { settings: { projectType: "swift", deploymentTarget: "16.0" } } });
		expect(generated.manifest.generatedFiles).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "SwiftProject/ZvibeGame.xcodeproj/project.pbxproj" }),
				expect.objectContaining({ path: "SwiftProject/ZvibeGame/GameWebView.swift" }),
			])
		);
		const scaffold = join(directory, ".zvibe/platforms/ios");
		expect(await readFile(join(scaffold, "SwiftProject/ZvibeGame/ZvibeGameApp.swift"), "utf8")).toContain("@main");
		expect(await readFile(join(scaffold, "SwiftProject/ZvibeGame/GameWebView.swift"), "utf8")).toContain("WKWebView");
		expect(await validateIosGeneratedProject(scene, { expectedRevision: 1 }, options)).toMatchObject({ revision: 1, valid: true });
		await ensureDir(join(directory, "dist/ios"));
		await writeFile(join(directory, "dist/ios/index.html"), "<!doctype html><title>Game</title>", "utf8");
		await execFileAsync(process.execPath, [join(scaffold, "build.mjs")], {
			cwd: directory,
			env: {
				...process.env,
				BJS_EDITOR_BUILD_TARGET: "ios",
				BJS_EDITOR_OUTPUT_DIRECTORY: "dist/ios",
				BJS_EDITOR_PLAYER_SETTINGS: JSON.stringify(options.editor.state.projectSettings),
				npm_config_user_agent: "yarn/1.22.22",
			},
			timeout: 30_000,
		});
		expect(await pathExists(join(directory, "dist/ios/SwiftProject/ZvibeGame.xcodeproj/project.pbxproj"))).toBe(true);
		expect(await readFile(join(directory, "dist/ios/SwiftProject/ZvibeGame/Web/index.html"), "utf8")).toContain("Game");
		if (process.platform === "darwin") {
			const projectPath = join(directory, "dist/ios/SwiftProject/ZvibeGame.xcodeproj");
			const listed = await execFileAsync("xcodebuild", ["-list", "-json", "-project", projectPath], { timeout: 30_000 });
			expect(JSON.parse(listed.stdout)).toMatchObject({ project: { targets: ["ZvibeGame"], schemes: ["ZvibeGame"] } });
			await execFileAsync(
				"xcodebuild",
				[
					"-project",
					projectPath,
					"-scheme",
					"ZvibeGame",
					"-sdk",
					"iphonesimulator",
					"-configuration",
					"Debug",
					"-derivedDataPath",
					join(directory, "derived-data"),
					"CODE_SIGNING_ALLOWED=NO",
					"build",
				],
				{ timeout: 120_000, maxBuffer: 2 * 1024 * 1024 }
			);
		}
		const migrated = await generatePlatformScaffold(scene, { target: "ios", expectedRevision: 1, settings: { projectType: "capacitor", deploymentTarget: "16.0" } }, options);
		expect(migrated).toMatchObject({ revision: 2, integrity: true, manifest: { settings: { projectType: "capacitor" } } });
		expect(await pathExists(join(scaffold, "SwiftProject/ZvibeGame.xcodeproj/project.pbxproj"))).toBe(false);
		expect(await pathExists(join(scaffold, "capacitor.config.json"))).toBe(true);
	}, 180_000);

	test("validates the authored platform build matrix through the canonical Build Profile validator", async () => {
		await generatePlatformScaffold(scene, { target: "headless", expectedRevision: 0 }, options);
		createBuildProfile(scene, { expectedRevision: 0, id: "server", name: "Dedicated Server", target: "headless", settings: { outputDirectory: "dist/headless" } });
		const matrix = await validatePlatformBuildMatrix(scene, {}, options);
		expect(matrix).toMatchObject({ configurationRevision: 1, validForProjectExport: true });
		expect(matrix.profiles[0]).toMatchObject({ id: "server", target: "headless", build: { valid: true }, platform: { readyForProjectExport: true } });
	});

	test("integrates WebXR mode with the existing scene XR runtime and build environment", async () => {
		createBuildProfile(scene, {
			expectedRevision: 0,
			id: "webxr",
			name: "WebXR",
			target: "web",
			settings: { outputDirectory: "dist/xr", web: { mode: "webxr", basePath: "/xr/", clientBrowser: "chrome", optimization: "runtime-performance" } },
		});
		expect(await validateBuildProfile(scene, { id: "webxr" }, options)).toMatchObject({ valid: false, reasons: [expect.stringContaining("XR configuration")] });
		scene.metadata ??= {};
		scene.metadata.babylonEditorXR = { enabled: true, referenceSpaceType: "local-floor", floorMeshIds: [], features: [] };
		expect(await validateBuildProfile(scene, { id: "webxr" }, options)).toMatchObject({
			valid: true,
			xrValidation: { valid: true, target: "web", capabilities: { portableRuntime: "webxr", nativeProviderBoundary: ["native-openxr", "visionos", "arcore", "arkit"] } },
		});
		scene.metadata.babylonEditorXR = { version: 2, revision: 2, enabled: "invalid" };
		expect(await validateBuildProfile(scene, { id: "webxr" }, options)).toMatchObject({ valid: false, reasons: [expect.stringContaining("XR enabled must be a boolean")] });
		expect(getBuildProfileEnvironment(scene, { id: "webxr" }, options).environment).toMatchObject({
			BJS_EDITOR_WEB_MODE: "webxr",
			BJS_EDITOR_WEB_CLIENT_BROWSER: "chrome",
			BJS_EDITOR_WEB_OPTIMIZATION: "runtime-performance",
			BJS_EDITOR_WEB_BASE_PATH: "/xr/",
		});
	});

	test("plans and consumes one exact installed-platform restart lease", async () => {
		createBuildProfile(scene, { expectedRevision: 0, id: "web", name: "Web", target: "web" });
		const status = await getInstalledPlatformRestartStatus(scene, { target: "web" }, options);
		expect(status).toMatchObject({ target: "web", configurationRevision: 1, installed: true, startupEvidence: null });
		expect(status.diagnosticFingerprint).toMatch(/^[a-f0-9]{64}$/);
		const plan = await planInstalledPlatformRestart(scene, { target: "web", expectedDiagnosticFingerprint: status.diagnosticFingerprint }, options);
		await expect(
			restartEditorForInstalledPlatform(scene, { planId: plan.id, expectedDiagnosticFingerprint: plan.diagnosticFingerprint, confirm: false }, options)
		).rejects.toThrow("confirm must be true");
		const restarted = await restartEditorForInstalledPlatform(scene, { planId: plan.id, expectedDiagnosticFingerprint: plan.diagnosticFingerprint, confirm: true }, options);
		expect(restarted).toMatchObject({ accepted: true, relaunch: { scheduled: true, target: "web", planId: plan.id } });
		await expect(
			restartEditorForInstalledPlatform(scene, { planId: plan.id, expectedDiagnosticFingerprint: plan.diagnosticFingerprint, confirm: true }, options)
		).rejects.toThrow("missing or expired");
	});

	test("maps all eleven strict platform endpoints and advertises their editor capabilities", () => {
		for (const endpoint of [
			"list_platform_capabilities",
			"get_platform_diagnostics",
			"get_platform_scaffold",
			"generate_platform_scaffold",
			"remove_platform_scaffold",
			"validate_platform_build_matrix",
			"get_installed_platform_restart_status",
			"plan_installed_platform_restart",
			"restart_editor_for_installed_platform",
			"get_ios_project_generation_capabilities",
			"validate_ios_generated_project",
		]) {
			expect(MCPEndpoints[endpoint], endpoint).toBeTypeOf("function");
		}
		expect(getEditorCapabilities(scene, {}, options).features).toMatchObject({
			platformCapabilityInventory: true,
			platformToolchainDiagnostics: true,
			platformScaffolds: true,
			installedPlatformRestartFlow: true,
			experimentalSwiftIosProjectGeneration: true,
			dedicatedServerScaffold: true,
			mobileNativeWrapperScaffolds: true,
			webXRPlatformIntegration: true,
		});
	});
});
