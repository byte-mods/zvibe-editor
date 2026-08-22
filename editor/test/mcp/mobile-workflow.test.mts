import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ensureDir, pathExists, remove, writeJSON } from "fs-extra";
import { NullEngine, Scene } from "babylonjs";

import { getMobileDeploymentConfiguration, setMobileDeploymentConfiguration } from "../../src/mcp/mobile/configuration";
import {
	cancelMobileJob,
	executeMobileWorkflowPlan,
	getMobileCapabilities,
	getMobileJob,
	listMobileArtifacts,
	listMobileDevices,
	listMobileJobs,
	planMobileWorkflow,
	shutdownMobileWorkflows,
	validateMobileTarget,
} from "../../src/mcp/mobile/workflow";
import { generatePlatformScaffold } from "../../src/mcp/project/platforms";
import { createDefaultProjectSettings } from "../../src/project/settings";
import { clearUndoRedo, redo, undo } from "../../src/tools/undoredo";

async function executable(path: string, source: string): Promise<void> {
	await writeFile(path, source, "utf8");
	await chmod(path, 0o755);
}

async function waitForJob(scene: Scene, jobId: string): Promise<any> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const job = getMobileJob(scene, { jobId }) as any;
		if (["succeeded", "failed", "canceled"].includes(job.status)) {
			return job;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for Mobile job ${jobId}.`);
}

describe("mcp/mobile native workflows", () => {
	let directory: string;
	let scene: Scene;
	let options: any;
	let originalPath: string | undefined;

	beforeEach(async () => {
		clearUndoRedo();
		directory = await mkdtemp(join(tmpdir(), "zvibe-mobile-"));
		await ensureDir(join(directory, "assets"));
		await writeJSON(join(directory, "package.json"), { name: "mobile-game", private: true, scripts: {} }, { spaces: "\t" });
		await writeFile(join(directory, "project.bjseditor"), "{}", "utf8");
		scene = new Scene(new NullEngine());
		options = {
			editor: {
				state: {
					projectPath: join(directory, "project.bjseditor"),
					packageManager: "yarn",
					projectSettings: createDefaultProjectSettings("Mobile Game"),
				},
				layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() }, mobile: { forceUpdate: vi.fn() } },
			},
		};
		originalPath = process.env.PATH;
	});

	afterEach(async () => {
		await shutdownMobileWorkflows();
		clearUndoRedo();
		scene.dispose();
		process.env.PATH = originalPath;
		for (const name of [
			"MOBILE_KEYSTORE",
			"MOBILE_STORE_PASSWORD",
			"MOBILE_KEY_ALIAS",
			"MOBILE_KEY_PASSWORD",
			"MOBILE_PLAY_CREDENTIAL",
			"MOBILE_APPLE_TEAM",
			"MOBILE_APPLE_IDENTITY",
		]) {
			delete process.env[name];
		}
		await remove(directory);
	});

	test("authors strict deployment settings with exact revisions and Undo/Redo", () => {
		const initial = getMobileDeploymentConfiguration(scene, options);
		expect(initial).toMatchObject({ version: 1, revision: 1, android: { format: "aab" }, ios: { exportMethod: "app-store-connect" } });
		expect(() => setMobileDeploymentConfiguration(scene, { expectedRevision: 1, changes: { android: { format: "zip" } } }, options)).toThrow("apk or aab");
		expect(() => setMobileDeploymentConfiguration(scene, { expectedRevision: 1, changes: { ios: { signing: { enabled: "yes" } } } }, options)).toThrow("must be a boolean");
		const configured = setMobileDeploymentConfiguration(
			scene,
			{ expectedRevision: 1, changes: { android: { variant: "debug", format: "apk" }, ios: { exportMethod: "development" } } },
			options
		);
		expect(configured).toMatchObject({ revision: 2, android: { variant: "debug", format: "apk" }, ios: { exportMethod: "development" } });
		undo();
		expect(getMobileDeploymentConfiguration(scene, options)).toMatchObject({ revision: 1, android: { format: "aab" } });
		redo();
		expect(getMobileDeploymentConfiguration(scene, options)).toMatchObject({ revision: 2, android: { format: "apk" } });
	});

	test("packages and signs Android through the project Gradle wrapper with redacted retained evidence", async () => {
		const scaffold = await generatePlatformScaffold(scene, { target: "android", expectedRevision: 0 }, options);
		await writeJSON(join(directory, ".zvibe/platforms/android/zvibe-android-build-profile.json"), {
			version: 1,
			backend: "zvibe-android-project-native-lto-v1",
			settings: { linkTimeOptimization: "full", xrLinkTimeOptimization: "thin", initializationProfiling: true },
		});
		const nativeDirectory = join(directory, ".zvibe/platforms/android/android");
		await ensureDir(nativeDirectory);
		await executable(
			join(nativeDirectory, "gradlew"),
			'#!/bin/sh\necho "args=$* signing=$ZVIBE_ANDROID_STORE_PASSWORD alias=$ZVIBE_ANDROID_KEY_ALIAS lto=$ZVIBE_ANDROID_BUILD_PLAN"\nmkdir -p app/build/outputs/bundle/release\nprintf artifact > app/build/outputs/bundle/release/game-release.aab\n'
		);
		process.env.MOBILE_KEYSTORE = join(directory, "release.keystore");
		process.env.MOBILE_STORE_PASSWORD = "top-secret-store-password";
		process.env.MOBILE_KEY_ALIAS = "top-secret-alias";
		process.env.MOBILE_KEY_PASSWORD = "top-secret-key-password";
		const configuration = setMobileDeploymentConfiguration(
			scene,
			{
				expectedRevision: 1,
				changes: {
					android: {
						signing: {
							enabled: true,
							keystorePathEnvironment: "MOBILE_KEYSTORE",
							keystorePasswordEnvironment: "MOBILE_STORE_PASSWORD",
							keyAliasEnvironment: "MOBILE_KEY_ALIAS",
							keyPasswordEnvironment: "MOBILE_KEY_PASSWORD",
						},
					},
				},
			},
			options
		);
		const validated = (await validateMobileTarget(scene, { target: "android" }, options)) as any;
		expect(validated).toMatchObject({
			ready: { package: true },
			scaffold: { integrity: true },
			nativeProject: { exists: true },
			androidBuildPlan: { settings: { linkTimeOptimization: "full", xrLinkTimeOptimization: "thin", initializationProfiling: true } },
		});
		const plan = (await planMobileWorkflow(
			scene,
			{ target: "android", operation: "package", expectedRevision: configuration.revision, expectedScaffoldRevision: scaffold.revision },
			options
		)) as any;
		expect(plan.androidBuildPlan).toMatchObject({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/), settings: { linkTimeOptimization: "full" } });
		expect(plan.warnings.join(" ")).toContain("prebuilt engine");
		expect(JSON.stringify(plan)).not.toContain("top-secret");
		await expect(executeMobileWorkflowPlan(scene, { planId: plan.id, confirm: false }, options)).rejects.toThrow("confirm=true");
		const started = (await executeMobileWorkflowPlan(scene, { planId: plan.id, confirm: true }, options)) as any;
		const completed = await waitForJob(scene, started.id);
		expect(completed).toMatchObject({ status: "succeeded", operation: "package", artifacts: [{ extension: ".aab", sizeBytes: 8 }] });
		expect(completed.outputTail).toContain("[REDACTED]");
		expect(completed.outputTail).not.toContain("top-secret");
		expect(completed.outputTail).toContain('"linkTimeOptimization":"full"');
		expect(completed.commands[0].args.filter((value: string) => value === "--init-script")).toHaveLength(2);
		expect(await listMobileArtifacts(scene, { target: "android" }, options)).toMatchObject({ total: 1, artifacts: [{ extension: ".aab" }] });
		expect(await pathExists(join(directory, ".zvibe/platforms/android/zvibe-signing.init.gradle"))).toBe(true);
		expect(await pathExists(join(directory, ".zvibe/platforms/android/zvibe-build-profile.init.gradle"))).toBe(true);
	});

	test("rejects an Android package plan when its exact Build Profile plan changes", async () => {
		const scaffold = await generatePlatformScaffold(scene, { target: "android", expectedRevision: 0 }, options);
		const nativeDirectory = join(directory, ".zvibe/platforms/android/android");
		await ensureDir(nativeDirectory);
		await executable(join(nativeDirectory, "gradlew"), "#!/bin/sh\nexit 0\n");
		const planPath = join(directory, ".zvibe/platforms/android/zvibe-android-build-profile.json");
		await writeJSON(planPath, {
			version: 1,
			backend: "zvibe-android-project-native-lto-v1",
			settings: { linkTimeOptimization: "thin", xrLinkTimeOptimization: "inherit", initializationProfiling: true },
		});
		const plan = (await planMobileWorkflow(
			scene,
			{ target: "android", operation: "package", expectedRevision: 1, expectedScaffoldRevision: scaffold.revision },
			options
		)) as any;
		await writeJSON(planPath, {
			version: 1,
			backend: "zvibe-android-project-native-lto-v1",
			settings: { linkTimeOptimization: "full", xrLinkTimeOptimization: "thin", initializationProfiling: true },
		});
		await expect(executeMobileWorkflowPlan(scene, { planId: plan.id, confirm: true }, options)).rejects.toThrow("Android Build Profile plan changed");
	});

	test("does not report packaging success when the native tool produces no new artifact", async () => {
		const scaffold = await generatePlatformScaffold(scene, { target: "android", expectedRevision: 0 }, options);
		const nativeDirectory = join(directory, ".zvibe/platforms/android/android");
		await ensureDir(join(nativeDirectory, "app/build/outputs/bundle/release"));
		await writeFile(join(nativeDirectory, "app/build/outputs/bundle/release/stale.aab"), "stale", "utf8");
		await executable(join(nativeDirectory, "gradlew"), '#!/bin/sh\necho "completed without output"\n');
		const plan = (await planMobileWorkflow(
			scene,
			{ target: "android", operation: "package", expectedRevision: 1, expectedScaffoldRevision: scaffold.revision },
			options
		)) as any;
		const started = (await executeMobileWorkflowPlan(scene, { planId: plan.id, confirm: true }, options)) as any;
		expect(await waitForJob(scene, started.id)).toMatchObject({ status: "failed", error: expect.stringContaining("without producing a new or changed .aab") });
	});

	test("lists devices and performs exact install, launch, and bounded log capture through adb", async () => {
		const bin = join(directory, "bin");
		await ensureDir(bin);
		await executable(
			join(bin, "adb"),
			'#!/bin/sh\nif [ "$1" = "devices" ]; then printf "List of devices attached\\nemulator-5554 device product:sdk model:Pixel_8\\n"; exit 0; fi\necho "adb:$*"\ncase "$*" in *logcat*) trap "exit 0" TERM; while true; do sleep 0.1; done;; esac\n'
		);
		process.env.PATH = `${bin}:${originalPath ?? ""}`;
		const scaffold = await generatePlatformScaffold(scene, { target: "android", expectedRevision: 0 }, options);
		const artifactPath = ".zvibe/platforms/android/android/app/build/outputs/apk/debug/game-debug.apk";
		await ensureDir(join(directory, ".zvibe/platforms/android/android/app/build/outputs/apk/debug"));
		await writeFile(join(directory, artifactPath), "apk", "utf8");
		expect(await listMobileDevices(scene, { target: "android" })).toMatchObject({ total: 1, devices: [{ id: "emulator-5554", state: "device", platform: "android" }] });

		for (const operation of ["install", "launch"] as const) {
			const plan = (await planMobileWorkflow(
				scene,
				{
					target: "android",
					operation,
					expectedRevision: 1,
					expectedScaffoldRevision: scaffold.revision,
					deviceId: "emulator-5554",
					...(operation === "install" ? { artifactPath } : {}),
				},
				options
			)) as any;
			const started = (await executeMobileWorkflowPlan(scene, { planId: plan.id, confirm: true }, options)) as any;
			expect(await waitForJob(scene, started.id)).toMatchObject({ status: "succeeded", operation });
		}

		const logPlan = (await planMobileWorkflow(
			scene,
			{ target: "android", operation: "logs", expectedRevision: 1, expectedScaffoldRevision: scaffold.revision, deviceId: "emulator-5554", durationSeconds: 1 },
			options
		)) as any;
		const logStarted = (await executeMobileWorkflowPlan(scene, { planId: logPlan.id, confirm: true }, options)) as any;
		const logJob = await waitForJob(scene, logStarted.id);
		expect(logJob).toMatchObject({ status: "succeeded", operation: "logs", durationSeconds: 1 });
		expect(logJob.outputTail).toContain("logcat");
		expect(listMobileJobs(scene, { target: "android", status: "succeeded" })).toMatchObject({ total: 3 });
		expect(cancelMobileJob(scene, { jobId: logJob.id, confirm: true })).toMatchObject({ canceled: false, reason: "already-finished" });
	});

	test("rejects stale or unsafe plans and detects artifact changes before execution", async () => {
		const scaffold = await generatePlatformScaffold(scene, { target: "android", expectedRevision: 0 }, options);
		const bin = join(directory, "bin");
		await ensureDir(bin);
		await executable(join(bin, "adb"), "#!/bin/sh\nexit 0\n");
		process.env.PATH = `${bin}:${originalPath ?? ""}`;
		const artifactPath = ".zvibe/platforms/android/android/app/build/outputs/apk/debug/game.apk";
		await ensureDir(join(directory, ".zvibe/platforms/android/android/app/build/outputs/apk/debug"));
		await writeFile(join(directory, artifactPath), "one", "utf8");
		await expect(
			planMobileWorkflow(
				scene,
				{ target: "android", operation: "install", expectedRevision: 99, expectedScaffoldRevision: scaffold.revision, artifactPath, deviceId: "emulator-5554" },
				options
			)
		).rejects.toThrow("revision is stale");
		await expect(
			planMobileWorkflow(
				scene,
				{
					target: "android",
					operation: "install",
					expectedRevision: 1,
					expectedScaffoldRevision: scaffold.revision,
					artifactPath: "../outside.apk",
					deviceId: "emulator-5554",
				},
				options
			)
		).rejects.toThrow("project-relative");
		await expect(
			planMobileWorkflow(scene, { target: "android", operation: "launch", expectedRevision: 1, expectedScaffoldRevision: scaffold.revision, deviceId: "bad device" }, options)
		).rejects.toThrow("unsupported characters");
		const plan = (await planMobileWorkflow(
			scene,
			{ target: "android", operation: "install", expectedRevision: 1, expectedScaffoldRevision: scaffold.revision, artifactPath, deviceId: "emulator-5554" },
			options
		)) as any;
		await writeFile(join(directory, artifactPath), "changed", "utf8");
		await expect(executeMobileWorkflowPlan(scene, { planId: plan.id, confirm: true }, options)).rejects.toThrow("artifact changed");
		expect(() => listMobileJobs(scene, { target: "windows" })).toThrow("android or ios");
	});

	test("submits an Android artifact through Fastlane using an environment-only credential path", async () => {
		const bin = join(directory, "bin");
		await ensureDir(bin);
		await executable(join(bin, "fastlane"), '#!/bin/sh\necho "fastlane:$*"\n');
		process.env.PATH = `${bin}:${originalPath ?? ""}`;
		process.env.MOBILE_PLAY_CREDENTIAL = "/private/play-service-account.json";
		const scaffold = await generatePlatformScaffold(scene, { target: "android", expectedRevision: 0 }, options);
		const artifactPath = ".zvibe/platforms/android/android/app/build/outputs/bundle/release/game.aab";
		await ensureDir(join(directory, ".zvibe/platforms/android/android/app/build/outputs/bundle/release"));
		await writeFile(join(directory, artifactPath), "bundle", "utf8");
		const configuration = setMobileDeploymentConfiguration(
			scene,
			{ expectedRevision: 1, changes: { android: { store: { credentialPathEnvironment: "MOBILE_PLAY_CREDENTIAL", track: "internal", releaseStatus: "draft" } } } },
			options
		);
		const plan = (await planMobileWorkflow(
			scene,
			{ target: "android", operation: "submit", expectedRevision: configuration.revision, expectedScaffoldRevision: scaffold.revision, artifactPath },
			options
		)) as any;
		const started = (await executeMobileWorkflowPlan(scene, { planId: plan.id, confirm: true }, options)) as any;
		const completed = await waitForJob(scene, started.id);
		expect(completed).toMatchObject({ status: "succeeded", commands: [{ executable: "fastlane", args: expect.arrayContaining(["[REDACTED]"]) }] });
		expect(completed.outputTail).toContain("[REDACTED]");
		expect(completed.outputTail).not.toContain("play-service-account");
	});

	test.runIf(process.platform === "darwin")("archives, signs, and exports iOS through xcodebuild without persisting identities", async () => {
		const bin = join(directory, "bin");
		await ensureDir(bin);
		await executable(
			join(bin, "xcodebuild"),
			'#!/bin/sh\necho "xcodebuild:$*"\nprevious=""\nfor argument in "$@"; do if [ "$previous" = "-exportPath" ]; then mkdir -p "$argument"; printf ipa > "$argument/game.ipa"; fi; previous="$argument"; done\n'
		);
		process.env.PATH = `${bin}:${originalPath ?? ""}`;
		process.env.MOBILE_APPLE_TEAM = "SECRETTEAM";
		process.env.MOBILE_APPLE_IDENTITY = "SECRETIDENTITY";
		const scaffold = await generatePlatformScaffold(scene, { target: "ios", expectedRevision: 0 }, options);
		await ensureDir(join(directory, ".zvibe/platforms/ios/ios/App/App.xcworkspace"));
		const configuration = setMobileDeploymentConfiguration(
			scene,
			{
				expectedRevision: 1,
				changes: { ios: { signing: { enabled: true, teamIdEnvironment: "MOBILE_APPLE_TEAM", identityEnvironment: "MOBILE_APPLE_IDENTITY" } } },
			},
			options
		);
		const plan = (await planMobileWorkflow(
			scene,
			{ target: "ios", operation: "package", expectedRevision: configuration.revision, expectedScaffoldRevision: scaffold.revision },
			options
		)) as any;
		const started = (await executeMobileWorkflowPlan(scene, { planId: plan.id, confirm: true }, options)) as any;
		const completed = await waitForJob(scene, started.id);
		expect(completed).toMatchObject({ status: "succeeded", artifacts: [{ extension: ".ipa", sizeBytes: 3 }] });
		expect(completed.outputTail).toContain("[REDACTED]");
		expect(completed.outputTail).not.toContain("SECRETTEAM");
		expect(JSON.stringify(scene.metadata)).not.toContain("SECRETTEAM");
	});

	test.runIf(process.platform === "darwin")("rejects an iOS output directory that traverses a project symlink", async () => {
		const bin = join(directory, "bin");
		await ensureDir(bin);
		await executable(join(bin, "xcodebuild"), "#!/bin/sh\nexit 0\n");
		process.env.PATH = `${bin}:${originalPath ?? ""}`;
		const scaffold = await generatePlatformScaffold(scene, { target: "ios", expectedRevision: 0 }, options);
		await ensureDir(join(directory, ".zvibe/platforms/ios/ios/App/App.xcworkspace"));
		const external = await mkdtemp(join(tmpdir(), "zvibe-mobile-outside-"));
		await symlink(external, join(directory, ".zvibe/mobile"));
		try {
			const plan = (await planMobileWorkflow(
				scene,
				{ target: "ios", operation: "package", expectedRevision: 1, expectedScaffoldRevision: scaffold.revision },
				options
			)) as any;
			await expect(executeMobileWorkflowPlan(scene, { planId: plan.id, confirm: true }, options)).rejects.toThrow("symbolic link");
		} finally {
			await remove(external);
		}
	});

	test("advertises exact portable workflows and honest external vendor boundaries", () => {
		expect(getMobileCapabilities()).toMatchObject({
			mcpToolCount: 38,
			targets: ["android", "ios"],
			workflows: expect.arrayContaining(["package", "environment-only-signing", "list-devices", "install", "launch", "bounded-logs", "store-submit"]),
			boundaries: expect.arrayContaining(["vendor SDK installation", "store review outcome"]),
		});
	});
});
