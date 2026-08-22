import { execFile } from "child_process";
import { createHash } from "crypto";
import { promisify } from "util";
import { dirname, join, relative } from "path/posix";
import { ensureDir, pathExists, readFile, readJSON, remove, writeFile, writeJSON } from "fs-extra";

import { Scene } from "babylonjs";

import { IMCPActionOptions } from "../action";
import { BuildTarget, listBuildProfiles, validateBuildProfile } from "./export";
import { createIosSwiftProjectFiles, getIosProjectGenerationCapabilities, iosSwiftProjectFiles, validateIosSwiftProject } from "./ios-swift-project";

export const PLATFORM_SCAFFOLD_VERSION = 1 as const;

export type ScaffoldablePlatformTarget = "headless" | "android" | "ios";

interface IPlatformScaffoldManifest {
	version: typeof PLATFORM_SCAFFOLD_VERSION;
	revision: number;
	target: ScaffoldablePlatformTarget;
	createdAt: string;
	updatedAt: string;
	settings: Record<string, unknown>;
	packageScripts: Record<string, { value: string; previous?: string }>;
	generatedFiles: Array<{ path: string; sha256: string }>;
	preservedUserFiles: string[];
}

interface IPlatformDescriptor {
	target: BuildTarget | "webxr" | "console";
	name: string;
	category: "web" | "desktop" | "mobile" | "server" | "xr" | "closed";
	support: "built-in" | "scaffolded" | "integrated" | "external-sdk" | "unsupported";
	buildProfileTarget?: BuildTarget;
	projectScaffold: boolean;
	hosts: string[];
	requires: string[];
	integrations: string[];
	limitations: string[];
}

const execFileAsync = promisify(execFile);
const scaffoldableTargets = new Set<ScaffoldablePlatformTarget>(["headless", "android", "ios"]);
const packageScriptPattern = /^[A-Za-z0-9:_-]+$/;

function getPlatformDescriptors(): IPlatformDescriptor[] {
	return [
		{
			target: "web",
			name: "Web / PWA",
			category: "web",
			support: "built-in",
			buildProfileTarget: "web",
			projectScaffold: false,
			hosts: ["darwin", "win32", "linux"],
			requires: ["Node.js", "project build script"],
			integrations: ["four shipped Web templates", "PWA generation", "Web/Desktop importer overrides", "Build & Run"],
			limitations: ["Browser feature support remains browser/device dependent."],
		},
		{
			target: "electron",
			name: "Electron Desktop",
			category: "desktop",
			support: "built-in",
			buildProfileTarget: "electron",
			projectScaffold: false,
			hosts: ["darwin", "win32", "linux"],
			requires: ["Node.js", "Electron template or equivalent package scripts"],
			integrations: ["macOS/Windows/Linux", "x64/arm64", "ASAR", "icons", "environment-only signing"],
			limitations: ["Native signing and notarization still require vendor credentials and host services."],
		},
		{
			target: "android",
			name: "Android",
			category: "mobile",
			support: "scaffolded",
			buildProfileTarget: "android",
			projectScaffold: true,
			hosts: ["darwin", "win32", "linux"],
			requires: ["Node.js", "Java", "Android SDK for native packaging", "Capacitor CLI for native sync"],
			integrations: [
				"generated Capacitor configuration",
				"APK/AAB/project mode",
				"Build Profile project-native LTO handoff",
				"Android Trace initialization markers",
				"device simulation",
				"mobile player overrides",
			],
			limitations: ["APK/AAB compilation and device deployment require the external Android SDK/toolchain; prebuilt vendor libraries are not recompiled by project LTO."],
		},
		{
			target: "ios",
			name: "iOS / iPadOS",
			category: "mobile",
			support: "scaffolded",
			buildProfileTarget: "ios",
			projectScaffold: true,
			hosts: ["darwin"],
			requires: ["Node.js", "macOS/Xcode for native packaging", "Capacitor CLI for native sync"],
			integrations: [
				"generated Capacitor configuration",
				"experimental SwiftUI/WKWebView Xcode project",
				"Xcode project mode",
				"device simulation",
				"mobile player overrides",
				"provisioning references",
			],
			limitations: ["IPA compilation, signing, and device deployment require macOS, Xcode, and Apple credentials."],
		},
		{
			target: "headless",
			name: "Dedicated Server",
			category: "server",
			support: "scaffolded",
			buildProfileTarget: "headless",
			projectScaffold: true,
			hosts: ["darwin", "win32", "linux"],
			requires: ["Node.js"],
			integrations: ["fixed-rate server host", "health endpoint", "bounded catch-up", "game hook module", "Build & Run", "public Node/TypeScript Linux ARM64 source package"],
			limitations: [
				"Game-specific authoritative logic belongs in the preserved server-game hook module.",
				"Third-party native addons must independently provide Linux ARM64 binaries; Unity source/internal tools are not used or emulated.",
			],
		},
		{
			target: "webxr",
			name: "WebXR",
			category: "xr",
			support: "integrated",
			buildProfileTarget: "web",
			projectScaffold: false,
			hosts: ["darwin", "win32", "linux"],
			requires: ["HTTPS or loopback origin", "WebXR-capable browser/device"],
			integrations: ["scene XR configuration", "WebXR runtime loader", "XR rendering profiles", "Web build profiles"],
			limitations: ["Native OpenXR/vendor packages are outside this WebXR runtime."],
		},
		{
			target: "console",
			name: "Closed console platforms",
			category: "closed",
			support: "unsupported",
			projectScaffold: false,
			hosts: [],
			requires: ["Platform-holder approval", "proprietary SDK", "vendor build module"],
			integrations: [],
			limitations: ["No console SDK, binary packager, deployment, certification, or vendor API is bundled."],
		},
	];
}

function requireProjectDirectory(options: IMCPActionOptions): string {
	const projectPath = options.editor.state.projectPath;
	if (!projectPath) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectPath);
}

function requireScaffoldableTarget(value: unknown): ScaffoldablePlatformTarget {
	if (!scaffoldableTargets.has(value as ScaffoldablePlatformTarget)) {
		throw new Error("Platform scaffolds support headless, android, or ios.");
	}
	return value as ScaffoldablePlatformTarget;
}

function scaffoldDirectory(projectDirectory: string, target: ScaffoldablePlatformTarget): string {
	return join(projectDirectory, ".zvibe", "platforms", target);
}

function manifestPath(projectDirectory: string, target: ScaffoldablePlatformTarget): string {
	return join(scaffoldDirectory(projectDirectory, target), "zvibe-platform.json");
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function normalizeSettings(target: ScaffoldablePlatformTarget, value: unknown): Record<string, unknown> {
	if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
		throw new Error("Platform scaffold settings must be an object.");
	}
	const source = (value ?? {}) as Record<string, unknown>;
	const allowedKeys =
		target === "headless"
			? new Set(["baseBuildScript", "host", "port", "tickRate", "maximumCatchUpSteps"])
			: target === "android"
				? new Set(["baseBuildScript", "orientation", "syncNativeProject", "minimumSdk", "targetSdk", "format"])
				: new Set(["baseBuildScript", "orientation", "syncNativeProject", "deploymentTarget", "deviceFamily", "targetMinimumVisionOSVersion", "projectType"]);
	const unknownKeys = Object.keys(source).filter((key) => !allowedKeys.has(key));
	if (unknownKeys.length) {
		throw new Error(`Unknown ${target} platform setting${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}.`);
	}
	if (source.baseBuildScript !== undefined && (typeof source.baseBuildScript !== "string" || !packageScriptPattern.test(source.baseBuildScript))) {
		throw new Error("baseBuildScript must be a package-script name containing only letters, numbers, colon, underscore, or hyphen.");
	}
	const baseBuildScript = (source.baseBuildScript as string | undefined) ?? "build";
	if ([`build:${target}`, `run:${target}`].includes(baseBuildScript)) {
		throw new Error("baseBuildScript cannot recursively invoke the generated platform script.");
	}
	if (target === "headless") {
		if (source.host !== undefined && (typeof source.host !== "string" || !source.host.trim() || source.host.trim().length > 255)) {
			throw new Error("Dedicated Server host must be a non-empty string no longer than 255 characters.");
		}
		for (const key of ["port", "tickRate", "maximumCatchUpSteps"] as const) {
			if (source[key] !== undefined && !Number.isSafeInteger(source[key])) {
				throw new Error(`Dedicated Server ${key} must be an integer.`);
			}
		}
		const port = Number.isSafeInteger(source.port) ? Number(source.port) : 7777;
		const tickRate = Number.isSafeInteger(source.tickRate) ? Number(source.tickRate) : 30;
		const maximumCatchUpSteps = Number.isSafeInteger(source.maximumCatchUpSteps) ? Number(source.maximumCatchUpSteps) : 4;
		if (port < 1 || port > 65535 || tickRate < 1 || tickRate > 240 || maximumCatchUpSteps < 1 || maximumCatchUpSteps > 16) {
			throw new Error("Dedicated Server port, tickRate, or maximumCatchUpSteps is outside its supported range.");
		}
		return {
			baseBuildScript,
			host: typeof source.host === "string" && source.host.trim() ? source.host.trim().slice(0, 255) : "127.0.0.1",
			port,
			tickRate,
			maximumCatchUpSteps,
		};
	}
	if (source.orientation !== undefined && !["any", "portrait", "landscape"].includes(String(source.orientation))) {
		throw new Error("Mobile orientation must be any, portrait, or landscape.");
	}
	if (source.syncNativeProject !== undefined && typeof source.syncNativeProject !== "boolean") {
		throw new Error("syncNativeProject must be a boolean.");
	}
	const orientation = source.orientation === undefined ? "any" : String(source.orientation);
	const syncNativeProject = source.syncNativeProject ?? false;
	if (target === "android") {
		for (const key of ["minimumSdk", "targetSdk"] as const) {
			if (source[key] !== undefined && !Number.isSafeInteger(source[key])) {
				throw new Error(`Android ${key} must be an integer.`);
			}
		}
		if (source.format !== undefined && !["project", "apk", "aab"].includes(String(source.format))) {
			throw new Error("Android format must be project, apk, or aab.");
		}
		const minimumSdk = Number.isSafeInteger(source.minimumSdk) ? Number(source.minimumSdk) : 24;
		const targetSdk = Number.isSafeInteger(source.targetSdk) ? Number(source.targetSdk) : 35;
		const format = source.format === undefined ? "project" : String(source.format);
		if (minimumSdk < 21 || minimumSdk > 100 || targetSdk < minimumSdk || targetSdk > 100) {
			throw new Error("Android SDK levels must satisfy 21 <= minimumSdk <= targetSdk <= 100.");
		}
		return { baseBuildScript, orientation, syncNativeProject, minimumSdk, targetSdk, format };
	}
	if (source.deploymentTarget !== undefined && (typeof source.deploymentTarget !== "string" || !/^\d{1,2}\.\d{1,2}$/.test(source.deploymentTarget))) {
		throw new Error("iOS deploymentTarget must use major.minor notation.");
	}
	if (source.deviceFamily !== undefined && !["iphone", "ipad", "universal"].includes(String(source.deviceFamily))) {
		throw new Error("iOS deviceFamily must be iphone, ipad, or universal.");
	}
	if (source.projectType !== undefined && !["capacitor", "swift"].includes(String(source.projectType))) {
		throw new Error("iOS projectType must be capacitor or swift.");
	}
	if (
		source.targetMinimumVisionOSVersion !== undefined &&
		(typeof source.targetMinimumVisionOSVersion !== "string" || !/^\d{1,2}\.\d{1,2}$/.test(source.targetMinimumVisionOSVersion))
	) {
		throw new Error("targetMinimumVisionOSVersion must use major.minor notation.");
	}
	const projectType = source.projectType === undefined ? "capacitor" : String(source.projectType);
	const deploymentTarget = (source.deploymentTarget as string | undefined) ?? (projectType === "swift" ? "16.0" : "15.0");
	if (projectType === "swift" && Number(deploymentTarget) < 16) {
		throw new Error("Experimental Swift iOS projects require deploymentTarget 16.0 or newer.");
	}
	if (projectType === "swift" && syncNativeProject) {
		throw new Error("syncNativeProject is unavailable for Swift iOS projects because they do not use Capacitor native sync.");
	}
	const deviceFamily = source.deviceFamily === undefined ? "universal" : String(source.deviceFamily);
	const targetMinimumVisionOSVersion = (source.targetMinimumVisionOSVersion as string | undefined) ?? "2.0";
	return { baseBuildScript, orientation, syncNativeProject, deploymentTarget, deviceFamily, targetMinimumVisionOSVersion, projectType };
}

function platformBuildSource(target: ScaffoldablePlatformTarget): string {
	return `import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scaffold = dirname(fileURLToPath(import.meta.url));
const project = join(scaffold, "../../..");
const manifest = JSON.parse(await readFile(join(scaffold, "zvibe-platform.json"), "utf8"));
const target = ${JSON.stringify(target)};
if (process.env.BJS_EDITOR_BUILD_TARGET && process.env.BJS_EDITOR_BUILD_TARGET !== target) throw new Error("Platform scaffold target mismatch.");
let androidBuildPlan = null;
if (target === "android") {
	let input = {};
	try { input = JSON.parse(process.env.BJS_EDITOR_ANDROID_BUILD_SETTINGS || "{}"); } catch { throw new Error("Android Build Profile settings must be valid JSON."); }
	if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["linkTimeOptimization", "xrLinkTimeOptimization", "initializationProfiling"].includes(key))) throw new Error("Android Build Profile settings contain unsupported fields.");
	const linkTimeOptimization = ["none", "thin", "full"].includes(input.linkTimeOptimization) ? input.linkTimeOptimization : "none";
	const xrLinkTimeOptimization = input.xrLinkTimeOptimization === "thin" ? "thin" : "inherit";
	const initializationProfiling = input.initializationProfiling !== false;
	const compilerFlag = linkTimeOptimization === "none" ? null : "-flto=" + linkTimeOptimization;
	androidBuildPlan = {
		version: 1,
		backend: "zvibe-android-project-native-lto-v1",
		profileId: process.env.BJS_EDITOR_BUILD_PROFILE_ID || null,
		settings: { linkTimeOptimization, xrLinkTimeOptimization, initializationProfiling },
		lto: { mode: linkTimeOptimization, compilerFlags: compilerFlag ? [compilerFlag] : [], scope: "project-externalNativeBuild-cmake", prebuiltLibrariesRecompiled: false },
		xr: { mode: xrLinkTimeOptimization, cmakeDefinition: "-DZVIBE_XR_LTO_MODE=" + xrLinkTimeOptimization.toUpperCase(), scope: "project-native-xr-adapter-handoff", prebuiltXrLibrariesRecompiled: false },
		initializationProfiling: { enabled: initializationProfiling, source: "ZvibePlayerInitialization.kt", boundedMarkerCapacity: 128 },
	};
}
let linuxArm64SourceBuildPlan = null;
if (target === "headless" && process.env.BJS_EDITOR_LINUX_ARM64_SERVER_SOURCE_BUILD_PLAN) {
	try { linuxArm64SourceBuildPlan = JSON.parse(process.env.BJS_EDITOR_LINUX_ARM64_SERVER_SOURCE_BUILD_PLAN); } catch { throw new Error("Linux ARM64 server source-build plan must be valid JSON."); }
	const known = ["version", "backend", "profileId", "target", "publicToolchain", "artifacts", "nativeDependencies", "boundary", "planFingerprint"];
	if (!linuxArm64SourceBuildPlan || typeof linuxArm64SourceBuildPlan !== "object" || Array.isArray(linuxArm64SourceBuildPlan) || Object.keys(linuxArm64SourceBuildPlan).some((key) => !known.includes(key))) throw new Error("Linux ARM64 server source-build plan contains unsupported fields.");
	const targetKeys = ["operatingSystem", "architecture", "sourceBuild"];
	const publicToolchainKeys = ["nodeMajor", "language", "moduleFormat", "packageManager", "containerPlatform"];
	if (linuxArm64SourceBuildPlan.version !== 1 || linuxArm64SourceBuildPlan.backend !== "zvibe-public-node-linux-arm64-server-source-v1" || typeof linuxArm64SourceBuildPlan.profileId !== "string" || linuxArm64SourceBuildPlan.profileId.length < 1 || linuxArm64SourceBuildPlan.profileId.length > 128 || !linuxArm64SourceBuildPlan.target || typeof linuxArm64SourceBuildPlan.target !== "object" || Array.isArray(linuxArm64SourceBuildPlan.target) || Object.keys(linuxArm64SourceBuildPlan.target).some((key) => !targetKeys.includes(key)) || linuxArm64SourceBuildPlan.target.operatingSystem !== "linux" || linuxArm64SourceBuildPlan.target.architecture !== "arm64" || linuxArm64SourceBuildPlan.target.sourceBuild !== true || !linuxArm64SourceBuildPlan.publicToolchain || typeof linuxArm64SourceBuildPlan.publicToolchain !== "object" || Array.isArray(linuxArm64SourceBuildPlan.publicToolchain) || Object.keys(linuxArm64SourceBuildPlan.publicToolchain).some((key) => !publicToolchainKeys.includes(key)) || linuxArm64SourceBuildPlan.publicToolchain.nodeMajor !== 22 || linuxArm64SourceBuildPlan.publicToolchain.language !== "JavaScript/TypeScript" || linuxArm64SourceBuildPlan.publicToolchain.moduleFormat !== "esm" || linuxArm64SourceBuildPlan.publicToolchain.packageManager !== "npm-compatible" || linuxArm64SourceBuildPlan.publicToolchain.containerPlatform !== "linux/arm64" || linuxArm64SourceBuildPlan.nativeDependencies !== "Project dependencies that contain native addons must independently provide Linux ARM64 builds; the portable source builder does not cross-compile third-party native code." || linuxArm64SourceBuildPlan.boundary !== "This public Node/TypeScript source build packages the generated Babylon NullEngine server for Linux ARM64. It does not use Unity source code, Unity internal tools, IL2CPP, or Unity Dedicated Server binary identity." || !/^[a-f0-9]{64}$/.test(linuxArm64SourceBuildPlan.planFingerprint || "")) throw new Error("Linux ARM64 server source-build plan is malformed.");
	const expectedArtifacts = ["server.mjs", "server-game.mjs", "zvibe-platform-runtime.json", "package.json", "Dockerfile.linux-arm64"];
	if (JSON.stringify(linuxArm64SourceBuildPlan.artifacts) !== JSON.stringify(expectedArtifacts)) throw new Error("Linux ARM64 server source-build artifacts are not the fixed supported set.");
	const { planFingerprint, ...fingerprintedPlan } = linuxArm64SourceBuildPlan;
	if (createHash("sha256").update(JSON.stringify(fingerprintedPlan)).digest("hex") !== planFingerprint) throw new Error("Linux ARM64 server source-build plan fingerprint is invalid.");
	if (process.env.BJS_EDITOR_BUILD_PROFILE_ID !== linuxArm64SourceBuildPlan.profileId) throw new Error("Linux ARM64 server source-build plan does not belong to the active Build Profile.");
}
const outputInput = (process.env.BJS_EDITOR_OUTPUT_DIRECTORY || "dist/" + target).replaceAll("\\\\", "/");
if (!outputInput || outputInput === "." || outputInput.includes("\\0") || isAbsolute(outputInput) || outputInput.split("/").includes("..")) throw new Error("Platform build output must be a project-relative path without traversal.");
const output = resolve(project, outputInput);
const outputFromProject = relative(project, output);
if (!outputFromProject || outputFromProject.startsWith("..") || isAbsolute(outputFromProject)) throw new Error("Platform build output must remain inside the project.");
const packageManager = process.env.npm_config_user_agent?.startsWith("npm/") ? "npm" : process.env.npm_config_user_agent?.startsWith("pnpm/") ? "pnpm" : process.env.npm_config_user_agent?.startsWith("bun/") ? "bun" : "yarn";
const args = packageManager === "yarn" ? ["run", manifest.settings.baseBuildScript] : ["run", manifest.settings.baseBuildScript];
const executable = process.platform === "win32" && packageManager !== "bun" ? packageManager + ".cmd" : packageManager;
const result = spawnSync(executable, args, { cwd: project, env: process.env, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
await mkdir(output, { recursive: true });
const authoredScenes = JSON.parse(process.env.BJS_EDITOR_BUILD_SCENES || "[]");
const scenes = authoredScenes.filter((entry) => entry?.enabled !== false && typeof entry?.path === "string").map((entry) => ({
	sourcePath: entry.path,
	file: "scene/" + basename(entry.path, extname(entry.path)) + ".babylon",
}));
const descriptor = { version: 2, target, generatedAt: new Date().toISOString(), settings: manifest.settings, playerSettings: JSON.parse(process.env.BJS_EDITOR_PLAYER_SETTINGS || "{}"), scenes };
await writeFile(join(output, "zvibe-platform-runtime.json"), JSON.stringify(descriptor, null, "\\t") + "\\n");
	if (target === "android") {
	await writeFile(join(output, "zvibe-android-build-profile.json"), JSON.stringify(androidBuildPlan, null, "\\t") + "\\n");
	await writeFile(join(scaffold, "zvibe-android-build-profile.json"), JSON.stringify(androidBuildPlan, null, "\\t") + "\\n");
	}
	if (target === "headless") {
	await cp(join(scaffold, "server.mjs"), join(output, "server.mjs"));
	await cp(join(scaffold, "server-game.mjs"), join(output, "server-game.mjs"));
	await cp(join(scaffold, "Dockerfile"), join(output, "Dockerfile"));
	const projectPackage = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
	const runtimePackage = {
		name: (projectPackage.name || "zvibe-game") + "-dedicated-server",
		version: projectPackage.version || "1.0.0",
		private: true,
		type: "module",
		dependencies: {
			"@babylonjs/core": projectPackage.dependencies?.["@babylonjs/core"] || "^9.12.1",
			"babylonjs-editor-tools": projectPackage.dependencies?.["babylonjs-editor-tools"] || "^5.4.3-alpha.1",
		},
		...(linuxArm64SourceBuildPlan
			? {
					os: ["linux"],
					cpu: ["arm64"],
					engines: { node: ">=" + linuxArm64SourceBuildPlan.publicToolchain.nodeMajor + " <" + (linuxArm64SourceBuildPlan.publicToolchain.nodeMajor + 1) },
					scripts: { start: "node server.mjs", check: "node --check server.mjs" },
				}
			: {}),
	};
	await writeFile(join(output, "package.json"), JSON.stringify(runtimePackage, null, "\\t") + "\\n");
	if (linuxArm64SourceBuildPlan) {
		await cp(join(scaffold, "Dockerfile.linux-arm64"), join(output, "Dockerfile.linux-arm64"));
		const artifacts = [];
		for (const path of linuxArm64SourceBuildPlan.artifacts) {
			const bytes = await readFile(join(output, path));
			artifacts.push({ path, sizeBytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
		}
		const sourceBuild = {
			version: 1,
			backend: linuxArm64SourceBuildPlan.backend,
			profileId: linuxArm64SourceBuildPlan.profileId,
			planFingerprint: linuxArm64SourceBuildPlan.planFingerprint,
			generatedAt: new Date().toISOString(),
			target: linuxArm64SourceBuildPlan.target,
			publicToolchain: linuxArm64SourceBuildPlan.publicToolchain,
			artifacts,
			nativeDependencies: linuxArm64SourceBuildPlan.nativeDependencies,
			boundary: linuxArm64SourceBuildPlan.boundary,
		};
		await writeFile(join(output, "zvibe-linux-arm64-source-build.json"), JSON.stringify(sourceBuild, null, "\\t") + "\\n");
	}
	} else if (target === "ios" && manifest.settings.projectType === "swift") {
		const swiftOutput = join(output, "SwiftProject");
		await rm(swiftOutput, { recursive: true, force: true });
		await cp(join(scaffold, "SwiftProject"), swiftOutput, { recursive: true });
		const webOutput = join(swiftOutput, "ZvibeGame", "Web");
		await mkdir(webOutput, { recursive: true });
		const payloadEntries = await readdir(output, { withFileTypes: true });
		for (const entry of payloadEntries) {
			if (entry.name === "SwiftProject") continue;
			await cp(join(output, entry.name), join(webOutput, entry.name), { recursive: entry.isDirectory() });
		}
	} else {
		const capacitor = JSON.parse(await readFile(join(scaffold, "capacitor.config.json"), "utf8"));
		capacitor.webDir = ".";
		await writeFile(join(output, "capacitor.config.json"), JSON.stringify(capacitor, null, "\\t") + "\\n");
		if (target === "ios") {
			await cp(join(scaffold, "ZvibeAdaptivePerformancePlugin.swift"), join(output, "ZvibeAdaptivePerformancePlugin.swift"));
			await cp(join(scaffold, "ZvibeVisionOS.xcconfig"), join(output, "ZvibeVisionOS.xcconfig"));
		} else if (target === "android") {
			await cp(join(scaffold, "ZvibeWindowInsetsPlugin.kt"), join(output, "ZvibeWindowInsetsPlugin.kt"));
			await cp(join(scaffold, "ZvibePlayerInitialization.kt"), join(output, "ZvibePlayerInitialization.kt"));
		}
		if (manifest.settings.syncNativeProject) {
			const expectedOutput = join(project, "dist", target);
			if (output !== expectedOutput) throw new Error("Native sync requires the default dist/" + target + " output directory so the generated Capacitor configuration remains reproducible.");
			const npx = process.platform === "win32" ? "npx.cmd" : "npx";
		const sync = spawnSync(npx, ["cap", "sync", target], { cwd: scaffold, env: process.env, stdio: "inherit" });
			if (sync.error) throw sync.error;
			if (sync.status !== 0) process.exit(sync.status ?? 1);
			if (target === "ios") {
				await cp(join(scaffold, "ZvibeAdaptivePerformancePlugin.swift"), join(scaffold, "ios", "App", "App", "ZvibeAdaptivePerformancePlugin.swift"), { force: false, errorOnExist: false });
				await cp(join(scaffold, "ZvibeVisionOS.xcconfig"), join(scaffold, "ios", "App", "ZvibeVisionOS.xcconfig"), { force: false, errorOnExist: false });
			} else if (target === "android") {
				await cp(join(scaffold, "ZvibeWindowInsetsPlugin.kt"), join(scaffold, "android", "app", "src", "main", "java", "ZvibeWindowInsetsPlugin.kt"), { force: false, errorOnExist: false });
				await cp(join(scaffold, "ZvibePlayerInitialization.kt"), join(scaffold, "android", "app", "src", "main", "java", "ZvibePlayerInitialization.kt"), { force: false, errorOnExist: false });
				const nativeManifestPath = join(scaffold, "android", "app", "src", "main", "AndroidManifest.xml");
				let nativeManifest = await readFile(nativeManifestPath, "utf8");
				const startMarker = "<!-- Zvibe Player Initialization: start -->";
				const endMarker = "<!-- Zvibe Player Initialization: end -->";
				nativeManifest = nativeManifest.replace(new RegExp(startMarker + "[\\\\s\\\\S]*?" + endMarker, "g"), "");
				if (androidBuildPlan.initializationProfiling.enabled) {
					const authority = capacitor.appId + ".zvibe-player-initialization";
					const provider = startMarker + '\\n        <provider android:name="com.zvibe.editor.ZvibePlayerInitializationProvider" android:authorities="' + authority + '" android:exported="false" android:initOrder="100" />\\n        ' + endMarker;
					if (!nativeManifest.includes("</application>")) throw new Error("AndroidManifest.xml has no application element for initialization profiling.");
					nativeManifest = nativeManifest.replace("</application>", provider + "\\n    </application>");
				}
				await writeFile(nativeManifestPath, nativeManifest);
			}
	}
}
`;
}

function dedicatedServerSource(): string {
	return `import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NullEngine, Scene } from "@babylonjs/core";
import { ProductionSessionHost } from "babylonjs-editor-tools/server/production-session-host";

const require = createRequire(import.meta.url);
const { loadScene } = require("babylonjs-editor-tools");

const runtime = JSON.parse(await readFile(new URL("./zvibe-platform-runtime.json", import.meta.url), "utf8"));
const hooks = await import("./server-game.mjs");
const settings = runtime.settings;
const output = dirname(fileURLToPath(import.meta.url));
const engine = new NullEngine({ renderWidth: 1, renderHeight: 1, deterministicLockstep: true, lockstepMaxSteps: settings.maximumCatchUpSteps });
const scene = new Scene(engine);
const requestedScene = process.env.ZVIBE_SERVER_SCENE;
const sceneEntry = requestedScene ? runtime.scenes.find((entry) => entry.sourcePath === requestedScene) : runtime.scenes[0];
if (requestedScene && !sceneEntry) throw new Error("ZVIBE_SERVER_SCENE is not an enabled exported scene.");
if (sceneEntry) {
	const source = await readFile(join(output, sceneEntry.file), "utf8");
	await loadScene(new URL("./scene/", import.meta.url).href, "data:" + source, scene, hooks.scriptsMap || {}, { headless: true, skipAssetsPreload: hooks.skipAssetsPreload === true });
}
const state = { startedAt: new Date().toISOString(), ticks: 0, droppedSteps: 0, running: true, sceneLoaded: Boolean(sceneEntry), scenePath: sceneEntry?.sourcePath || null };
const configuredHost = process.env.HOST || settings.host;
const joinCode = process.env.ZVIBE_SERVER_JOIN_CODE || (["127.0.0.1", "localhost", "::1"].includes(configuredHost) ? "LOCALDEV" : null);
if (!joinCode) throw new Error("Non-loopback dedicated servers require ZVIBE_SERVER_JOIN_CODE.");
const gameplay = new ProductionSessionHost(scene, {
	joinCode,
	maximumPlayers: Number(process.env.ZVIBE_SERVER_MAXIMUM_PLAYERS || 64),
	onRpc: (message) => void hooks.onRpc?.({ message, runtime, scene, state }),
});
await hooks.onStart?.({ runtime, scene, state, gameplay });
const intervalMs = 1000 / settings.tickRate;
let nextTick = performance.now() + intervalMs;
const timer = setInterval(async () => {
	let steps = 0;
	const now = performance.now();
	while (nextTick <= now && steps < settings.maximumCatchUpSteps) {
		await hooks.onTick?.({ deltaSeconds: intervalMs / 1000, runtime, scene, state, gameplay });
		if (scene.activeCamera || scene.cameras.length) scene.render(false, false);
		gameplay.tick();
		state.ticks++;
		steps++;
		nextTick += intervalMs;
	}
	if (nextTick <= now) {
		state.droppedSteps++;
		nextTick = now + intervalMs;
	}
}, Math.max(1, Math.floor(intervalMs / 2)));
const server = createServer((request, response) => {
	if (request.method === "GET" && request.url === "/health") {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ ok: true, target: "headless", ...state, scene: { meshes: scene.meshes.length, nodes: scene.getNodes().length }, gameplay: gameplay.status() }));
		return;
	}
	if (request.method === "GET" && request.url === "/metrics") {
		const status = gameplay.status();
		response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
		response.end(["zvibe_server_ticks " + state.ticks, "zvibe_server_dropped_steps " + state.droppedSteps, "zvibe_server_connected_players " + status.connectedPlayers, "zvibe_server_network_objects " + status.networkObjectCount].join("\\n") + "\\n");
		return;
	}
	response.writeHead(404).end();
});
gameplay.attach(server);
server.listen(Number(process.env.PORT || settings.port), configuredHost);
async function stop(signal) {
	if (!state.running) return;
	state.running = false;
	clearInterval(timer);
	await hooks.onStop?.({ runtime, scene, state, gameplay, signal });
	await gameplay.close();
	scene.dispose();
	engine.dispose();
	server.close(() => process.exit(0));
}
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
`;
}

function defaultServerGameSource(): string {
	return `/** Preserved game-owned hooks for the generated Zvibe dedicated-server host. */
export const scriptsMap = {};
export async function onStart(_context) {}
export async function onTick(_context) {}
export async function onRpc(_context) {}
export async function onStop(_context) {}
`;
}

function dedicatedServerDockerfileSource(): string {
	return `FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts
COPY . ./
ENV NODE_ENV=production HOST=0.0.0.0 PORT=7777
EXPOSE 7777
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -q -O - http://127.0.0.1:7777/health || exit 1
CMD ["node", "server.mjs"]
`;
}

function dedicatedServerLinuxArm64DockerfileSource(): string {
	return `FROM --platform=linux/arm64 node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts
COPY . ./
ENV NODE_ENV=production HOST=0.0.0.0 PORT=7777
EXPOSE 7777
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD node -e "fetch('http://127.0.0.1:7777/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
`;
}

function platformReadme(target: ScaffoldablePlatformTarget, settings: Record<string, unknown>): string {
	if (target === "headless") {
		return "# Zvibe Dedicated Server scaffold\n\nBuild Profiles run `build:headless`; Build & Run uses `run:headless`. Put authoritative game logic in `server-game.mjs`, which regeneration and removal preserve. The generated host supplies a fixed-rate loop, bounded catch-up, signal cleanup, and `/health`. Headless Build Profiles targeting Linux ARM64 emit an exact public Node/TypeScript source-package descriptor, Linux/arm64 npm restrictions, artifact hashes, and `Dockerfile.linux-arm64`; third-party native addons must provide their own Linux ARM64 binaries.\n";
	}
	if (target === "ios" && settings.projectType === "swift") {
		return "# Zvibe experimental Swift iOS scaffold\n\nBuild Profiles run `build:ios` and emit `SwiftProject/ZvibeGame.xcodeproj`, a SwiftUI/WKWebView host, and the built Web payload under `ZvibeGame/Web`. This experimental path requires iOS 16+, macOS/Xcode for compilation, and Apple signing/provisioning for devices or distribution. It does not use Capacitor native sync.\n";
	}
	return `# Zvibe ${target === "android" ? "Android" : "iOS"} scaffold\n\nBuild Profiles run \`build:${target}\`. The build produces a Web payload plus Capacitor configuration. Enable native sync only after installing the Capacitor CLI and ${target === "android" ? "Android SDK" : "macOS/Xcode"}. Zvibe's Mobile workspace then plans and runs package, environment-only signing, install, launch, bounded logs, and Fastlane store submission through that installed vendor toolchain.${target === "ios" ? "\n\nAdd and register `ZvibeAdaptivePerformancePlugin.swift` in the App target for real `ProcessInfo.thermalState` and low-power events. Include `ZvibeVisionOS.xcconfig` in the visionOS target configuration to apply the authored minimum visionOS version. Generated copies never replace an existing native file." : "\n\n`zvibe-build-profile.init.gradle` applies the selected None/Thin/Full LTO policy only to project externalNativeBuild/CMake inputs. `ZvibePlayerInitialization.kt` provides a manifest-started Android Trace provider and bounded Capacitor marker bridge. `ZvibeWindowInsetsPlugin.kt` provides system-bar policy. Generated native copies never replace existing source files, and prebuilt engine/browser/vendor libraries are not recompiled."}\n`;
}

/** Capacitor-compatible Apple provider source for iOS, tvOS, and visionOS hosts. */
function appleAdaptivePerformancePluginSource(): string {
	return `import Foundation
import Capacitor

@objc(ZvibeAdaptivePerformancePlugin)
public final class ZvibeAdaptivePerformancePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ZvibeAdaptivePerformancePlugin"
    public let jsName = "ZvibeAdaptivePerformance"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise)
    ]

    private var thermalObserver: NSObjectProtocol?
    private var powerObserver: NSObjectProtocol?

    public override func load() {
        thermalObserver = NotificationCenter.default.addObserver(
            forName: ProcessInfo.thermalStateDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in self?.publishState() }
        powerObserver = NotificationCenter.default.addObserver(
            forName: Notification.Name.NSProcessInfoPowerStateDidChange,
            object: nil,
            queue: .main
        ) { [weak self] _ in self?.publishState() }
    }

    deinit {
        if let observer = thermalObserver { NotificationCenter.default.removeObserver(observer) }
        if let observer = powerObserver { NotificationCenter.default.removeObserver(observer) }
    }

    @objc public func getState(_ call: CAPPluginCall) {
        call.resolve(statePayload())
    }

    private func publishState() {
        notifyListeners("thermalStateChanged", data: statePayload())
    }

    private func statePayload() -> [String: Any] {
        let process = ProcessInfo.processInfo
        let state: String
        let normalizedLevel: Double
        switch process.thermalState {
        case .nominal: state = "nominal"; normalizedLevel = 0.1
        case .fair: state = "fair"; normalizedLevel = 0.5
        case .serious: state = "serious"; normalizedLevel = 0.8
        case .critical: state = "critical"; normalizedLevel = 1.0
        @unknown default: state = "unknown"; normalizedLevel = 0.0
        }
        return [
            "thermalState": state,
            "temperatureLevel": normalizedLevel,
            "lowPowerMode": process.isLowPowerModeEnabled
        ]
	    }
	}
	`;
}

function visionOSConfigurationSource(settings: Record<string, unknown>): string {
	return `// Include this generated file in the visionOS target's Base Configuration.\nXROS_DEPLOYMENT_TARGET = ${String(settings.targetMinimumVisionOSVersion)}\nSUPPORTED_PLATFORMS = iphoneos iphonesimulator xros xrsimulator\n`;
}

/** Capacitor-compatible AndroidX bridge for system-bar policy and live window-inset evidence. */
function androidWindowInsetsPluginSource(): string {
	return `package com.zvibe.editor

import android.os.Handler
import android.os.Looper
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "ZvibeWindowInsets")
class ZvibeWindowInsetsPlugin : Plugin() {
    private val handler = Handler(Looper.getMainLooper())
    private var requestedVisible = setOf("statusBars", "navigationBars")
    private var decorFitsSystemWindows = true
    private var behavior = "default"

    override fun load() {
        handler.post {
            ViewCompat.setOnApplyWindowInsetsListener(activity.window.decorView) { _, insets ->
                notifyListeners("windowInsetsChanged", statePayload(insets))
                insets
            }
            ViewCompat.requestApplyInsets(activity.window.decorView)
        }
    }

    @PluginMethod
    fun getState(call: PluginCall) {
        handler.post {
            val insets = ViewCompat.getRootWindowInsets(activity.window.decorView)
            if (insets == null) call.reject("WindowInsets are not available yet.") else call.resolve(statePayload(insets))
        }
    }

    @PluginMethod
    fun applyPolicy(call: PluginCall) {
        val requested = call.getArray("requestedVisibleWindowInsets") ?: JSArray()
        requestedVisible = (0 until requested.length()).mapNotNull { requested.optString(it).takeIf(String::isNotBlank) }.toSet()
        decorFitsSystemWindows = call.getBoolean("decorFitsSystemWindows", true) ?: true
        behavior = call.getString("systemBarsBehavior", "default") ?: "default"
        handler.post {
            val window = activity.window
            WindowCompat.setDecorFitsSystemWindows(window, decorFitsSystemWindows)
            val controller = WindowCompat.getInsetsController(window, window.decorView)
            controller.systemBarsBehavior = if (behavior == "show-transient-bars-by-swipe")
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            else WindowInsetsControllerCompat.BEHAVIOR_DEFAULT
            val all = supportedTypes().fold(0) { mask, entry -> mask or entry.second }
            val visible = supportedTypes().filter { requestedVisible.contains(it.first) }.fold(0) { mask, entry -> mask or entry.second }
            controller.hide(all and visible.inv())
            controller.show(visible)
            ViewCompat.requestApplyInsets(window.decorView)
            call.resolve()
        }
    }

    private fun supportedTypes() = listOf(
        "statusBars" to WindowInsetsCompat.Type.statusBars(),
        "navigationBars" to WindowInsetsCompat.Type.navigationBars(),
        "ime" to WindowInsetsCompat.Type.ime(),
        "displayCutout" to WindowInsetsCompat.Type.displayCutout(),
        "systemGestures" to WindowInsetsCompat.Type.systemGestures(),
        "mandatorySystemGestures" to WindowInsetsCompat.Type.mandatorySystemGestures(),
        "tappableElement" to WindowInsetsCompat.Type.tappableElement(),
        "captionBar" to WindowInsetsCompat.Type.captionBar()
    )

    private fun statePayload(value: WindowInsetsCompat): JSObject {
        val all = supportedTypes().fold(0) { mask, entry -> mask or entry.second }
        val insets = value.getInsets(all)
        val visible = JSArray()
        supportedTypes().filter { value.isVisible(it.second) }.forEach { visible.put(it.first) }
        return JSObject().apply {
            put("insets", JSObject().apply { put("left", insets.left); put("top", insets.top); put("right", insets.right); put("bottom", insets.bottom) })
            put("visibleWindowInsets", visible)
            put("decorFitsSystemWindows", decorFitsSystemWindows)
            put("systemBarsBehavior", behavior)
        }
    }
}
`;
}

/** Generates a manifest-started Android Trace provider plus a Capacitor bridge for bounded startup evidence. */
function androidPlayerInitializationSource(): string {
	return `package com.zvibe.editor

import android.app.Activity
import android.app.Application
import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.os.Trace
import android.view.Choreographer
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.ArrayDeque

private data class ZvibeInitializationMarker(val name: String, val elapsedNanoseconds: Long)

private object ZvibePlayerInitializationMarkers {
    private const val maximumMarkers = 128
    private const val prefix = "Zvibe.AndroidPlayer."
    private val startedAt = SystemClock.elapsedRealtimeNanos()
    private val markers = ArrayDeque<ZvibeInitializationMarker>()

    @Synchronized
    fun mark(value: String) {
        val safeName = value.filter { it.isLetterOrDigit() || it == '-' || it == '_' }.take(80).ifBlank { "Marker" }
        val section = (prefix + safeName).take(127)
        Trace.beginSection(section)
        Trace.endSection()
        if (markers.size >= maximumMarkers) markers.removeFirst()
        markers.addLast(ZvibeInitializationMarker(safeName, SystemClock.elapsedRealtimeNanos() - startedAt))
    }

    @Synchronized
    fun snapshot(): JSArray = JSArray().apply {
        markers.forEach { marker -> put(JSObject().apply { put("name", marker.name); put("elapsedNanoseconds", marker.elapsedNanoseconds) }) }
    }
}

class ZvibePlayerInitializationProvider : ContentProvider() {
    override fun onCreate(): Boolean {
        ZvibePlayerInitializationMarkers.mark("ContentProvider")
        val application = context?.applicationContext as? Application ?: return false
        application.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityCreated(activity: Activity, state: Bundle?) {
                ZvibePlayerInitializationMarkers.mark("ActivityCreated")
                Choreographer.getInstance().postFrameCallback { ZvibePlayerInitializationMarkers.mark("FirstFrame") }
            }
            override fun onActivityStarted(activity: Activity) = ZvibePlayerInitializationMarkers.mark("ActivityStarted")
            override fun onActivityResumed(activity: Activity) = ZvibePlayerInitializationMarkers.mark("ActivityResumed")
            override fun onActivityPaused(activity: Activity) = Unit
            override fun onActivityStopped(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) = Unit
            override fun onActivityDestroyed(activity: Activity) = Unit
        })
        return true
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}

@CapacitorPlugin(name = "ZvibePlayerInitialization")
class ZvibePlayerInitializationPlugin : Plugin() {
    override fun load() = ZvibePlayerInitializationMarkers.mark("CapacitorBridgeReady")

    @PluginMethod
    fun getMarkers(call: PluginCall) = call.resolve(JSObject().apply { put("markers", ZvibePlayerInitializationMarkers.snapshot()); put("capacity", 128) })

    @PluginMethod
    fun markSceneReady(call: PluginCall) {
        ZvibePlayerInitializationMarkers.mark("SceneReady")
        call.resolve()
    }

    @PluginMethod
    fun mark(call: PluginCall) {
        ZvibePlayerInitializationMarkers.mark(call.getString("name", "Custom") ?: "Custom")
        call.resolve()
    }
}
`;
}

/** Applies fixed project-native LTO flags without accepting arbitrary Gradle or compiler arguments. */
function androidBuildProfileInitSource(): string {
	return `import groovy.json.JsonSlurper

def raw = System.getenv("ZVIBE_ANDROID_BUILD_PLAN")
if (raw != null && !raw.trim().isEmpty()) {
	def plan = new JsonSlurper().parseText(raw)
	def mode = plan?.settings?.linkTimeOptimization in ["none", "thin", "full"] ? plan.settings.linkTimeOptimization : "none"
	def xrMode = plan?.settings?.xrLinkTimeOptimization == "thin" ? "thin" : "inherit"
	def flag = mode == "none" ? null : "-flto=" + mode
	def arguments = flag == null
		? ["-DCMAKE_INTERPROCEDURAL_OPTIMIZATION=FALSE"]
		: ["-DCMAKE_INTERPROCEDURAL_OPTIMIZATION=TRUE", "-DCMAKE_C_FLAGS_RELEASE=" + flag, "-DCMAKE_CXX_FLAGS_RELEASE=" + flag, "-DCMAKE_EXE_LINKER_FLAGS_RELEASE=" + flag, "-DCMAKE_SHARED_LINKER_FLAGS_RELEASE=" + flag]
	arguments.add("-DZVIBE_XR_LTO_MODE=" + xrMode.toUpperCase())
	gradle.projectsEvaluated {
		rootProject.allprojects { candidate ->
			def android = candidate.extensions.findByName("android")
			def cmake = android?.defaultConfig?.externalNativeBuild?.cmake
			if (cmake != null) cmake.arguments.addAll(arguments)
		}
	}
}
`;
}

/** Injects Android release signing from transient standardized environment values without writing secrets to Gradle files. */
function androidSigningInitSource(): string {
	return `gradle.projectsEvaluated {
	rootProject.allprojects { candidate ->
		def android = candidate.extensions.findByName("android")
		if (android != null && candidate.plugins.hasPlugin("com.android.application") && System.getenv("ZVIBE_ANDROID_KEYSTORE") != null) {
			def signing = android.signingConfigs.findByName("zvibeRelease") ?: android.signingConfigs.create("zvibeRelease")
			signing.storeFile = candidate.file(System.getenv("ZVIBE_ANDROID_KEYSTORE"))
			signing.storePassword = System.getenv("ZVIBE_ANDROID_STORE_PASSWORD")
			signing.keyAlias = System.getenv("ZVIBE_ANDROID_KEY_ALIAS")
			signing.keyPassword = System.getenv("ZVIBE_ANDROID_KEY_PASSWORD")
			android.buildTypes.findByName("release").signingConfig = signing
		}
	}
}
`;
}

function capacitorConfiguration(target: "android" | "ios", settings: Record<string, unknown>, applicationId: string, productName: string): string {
	return `${JSON.stringify(
		{
			appId: applicationId,
			appName: productName,
			webDir: `../../../dist/${target}`,
			bundledWebRuntime: false,
			server: { androidScheme: "https" },
			zvibe: { version: 1, target, ...settings },
		},
		null,
		"\t"
	)}\n`;
}

async function readManifest(projectDirectory: string, target: ScaffoldablePlatformTarget): Promise<IPlatformScaffoldManifest | null> {
	const path = manifestPath(projectDirectory, target);
	if (!(await pathExists(path))) {
		return null;
	}
	const manifest = (await readJSON(path)) as IPlatformScaffoldManifest;
	if (manifest.version !== PLATFORM_SCAFFOLD_VERSION || manifest.target !== target || !Number.isSafeInteger(manifest.revision) || manifest.revision < 1) {
		throw new Error(`The ${target} platform scaffold manifest is invalid.`);
	}
	const allowedFiles =
		target === "headless"
			? new Set(["build.mjs", "README.md", "server.mjs", "run.mjs", "Dockerfile", "Dockerfile.linux-arm64"])
			: target === "android"
				? new Set([
						"build.mjs",
						"README.md",
						"capacitor.config.json",
						"zvibe-signing.init.gradle",
						"zvibe-build-profile.init.gradle",
						"ZvibeWindowInsetsPlugin.kt",
						"ZvibePlayerInitialization.kt",
					])
				: new Set(["build.mjs", "README.md", "capacitor.config.json", "ZvibeAdaptivePerformancePlugin.swift", "ZvibeVisionOS.xcconfig", ...iosSwiftProjectFiles]);
	if (
		!Array.isArray(manifest.generatedFiles) ||
		manifest.generatedFiles.some((entry) => !entry || typeof entry.path !== "string" || !allowedFiles.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256))
	) {
		throw new Error(`The ${target} platform scaffold manifest contains invalid generated-file ownership.`);
	}
	const allowedScripts = target === "headless" ? new Set(["build:headless", "run:headless"]) : new Set([`build:${target}`]);
	if (!manifest.packageScripts || Object.keys(manifest.packageScripts).some((name) => !allowedScripts.has(name))) {
		throw new Error(`The ${target} platform scaffold manifest contains invalid package-script ownership.`);
	}
	return manifest;
}

async function captureTextFiles(paths: string[]): Promise<Map<string, string | null>> {
	return new Map(await Promise.all([...new Set(paths)].map(async (path) => [path, (await pathExists(path)) ? await readFile(path, "utf8") : null] as const)));
}

async function restoreTextFiles(snapshot: Map<string, string | null>): Promise<void> {
	for (const [path, content] of snapshot) {
		if (content === null) {
			await remove(path);
		} else {
			await ensureDir(dirname(path));
			await writeFile(path, content, "utf8");
		}
	}
}

async function scaffoldStatus(projectDirectory: string, target: ScaffoldablePlatformTarget): Promise<any> {
	const manifest = await readManifest(projectDirectory, target);
	if (!manifest) {
		return { target, exists: false, revision: 0, directory: relative(projectDirectory, scaffoldDirectory(projectDirectory, target)) };
	}
	const files = await Promise.all(
		manifest.generatedFiles.map(async (entry) => {
			const path = join(scaffoldDirectory(projectDirectory, target), entry.path);
			if (!(await pathExists(path))) {
				return { ...entry, exists: false, matches: false };
			}
			const actualSha256 = sha256(await readFile(path, "utf8"));
			return { ...entry, exists: true, actualSha256, matches: actualSha256 === entry.sha256 };
		})
	);
	return {
		target,
		exists: true,
		revision: manifest.revision,
		directory: relative(projectDirectory, scaffoldDirectory(projectDirectory, target)),
		manifest: structuredClone(manifest),
		files,
		integrity: files.every((entry) => entry.matches),
	};
}

async function commandAvailable(command: string): Promise<boolean> {
	try {
		await execFileAsync(process.platform === "win32" ? "where" : "which", [command], { timeout: 2_000 });
		return true;
	} catch {
		return false;
	}
}

async function diagnosticsForTarget(target: string, options: IMCPActionOptions): Promise<any> {
	const projectDirectory = requireProjectDirectory(options);
	const descriptor = getPlatformDescriptors().find((entry) => entry.target === target);
	if (!descriptor) {
		throw new Error(`Unknown platform target: ${target}`);
	}
	const commands =
		target === "android"
			? ["node", "java", "adb", "gradle"]
			: target === "ios"
				? ["node", "xcodebuild", "xcrun"]
				: target === "electron"
					? ["node"]
					: target === "console"
						? []
						: ["node"];
	const commandResults = Object.fromEntries(await Promise.all(commands.map(async (command) => [command, await commandAvailable(command)])));
	const scaffold = scaffoldableTargets.has(target as ScaffoldablePlatformTarget)
		? await scaffoldStatus(projectDirectory, target as ScaffoldablePlatformTarget)
		: { target, exists: false, required: false };
	const packageJson = await readJSON(join(projectDirectory, "package.json")).catch(() => ({}));
	const profileTarget = descriptor.buildProfileTarget;
	const scriptName = profileTarget ? (profileTarget === "web" || profileTarget === "electron" ? "build" : `build:${profileTarget}`) : undefined;
	const scriptReady =
		profileTarget === "web" || profileTarget === "electron" ? typeof packageJson.scripts?.build === "string" : Boolean(scriptName && packageJson.scripts?.[scriptName]);
	const hostSupported = descriptor.hosts.includes(process.platform);
	const nativeToolchainReady =
		target === "android"
			? Boolean(commandResults.java && (process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT))
			: target === "ios"
				? process.platform === "darwin" && Boolean(commandResults.xcodebuild)
				: target === "console"
					? false
					: true;
	return {
		descriptor,
		host: { platform: process.platform, architecture: process.arch, supported: hostSupported },
		commands: commandResults,
		environment: {
			androidSdkConfigured: Boolean(process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT),
			xcodeHost: process.platform === "darwin",
		},
		scaffold,
		packageScript: scriptName ? { name: scriptName, present: Boolean(packageJson.scripts?.[scriptName]), value: packageJson.scripts?.[scriptName] } : undefined,
		readyForProjectExport: descriptor.support !== "unsupported" && hostSupported && scriptReady,
		readyForNativePackage: descriptor.support !== "unsupported" && hostSupported && scriptReady && nativeToolchainReady,
	};
}

/** Lists the honest built-in, scaffolded, integrated, external-SDK, and unsupported platform surface. */
export function listPlatformCapabilities(): any {
	return {
		version: PLATFORM_SCAFFOLD_VERSION,
		platforms: getPlatformDescriptors(),
		integrations: {
			buildProfiles: true,
			projectSettings: true,
			webXR: true,
			deviceSimulation: true,
			importerOverrides: true,
			buildReports: true,
			experimentalSwiftIosProject: true,
		},
	};
}

/** Reports current host, command, SDK, package-script, and scaffold readiness without changing the project. */
export async function getPlatformDiagnostics(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const requested = data.target ? [data.target] : getPlatformDescriptors().map((entry) => entry.target);
	return { diagnostics: await Promise.all(requested.map((target) => diagnosticsForTarget(target, options))) };
}

/** Reads one editor-owned platform scaffold and verifies every generated-file hash. */
export async function getPlatformScaffold(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const target = requireScaffoldableTarget(data.target);
	return scaffoldStatus(requireProjectDirectory(options), target);
}

/** Generates or exactly replaces one project-contained mobile or dedicated-server scaffold. */
export async function generatePlatformScaffold(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const target = requireScaffoldableTarget(data.target);
	const projectDirectory = requireProjectDirectory(options);
	const current = await readManifest(projectDirectory, target);
	const currentRevision = current?.revision ?? 0;
	if (!Number.isSafeInteger(data.expectedRevision) || data.expectedRevision !== currentRevision) {
		throw new Error(`Stale ${target} platform scaffold revision ${data.expectedRevision}; current revision is ${currentRevision}.`);
	}
	if (current && (await scaffoldStatus(projectDirectory, target)).integrity !== true && data.overwrite !== true) {
		throw new Error(`The ${target} scaffold has modified or missing generated files; set overwrite=true and confirm=true to replace them.`);
	}
	if (data.overwrite === true && data.confirm !== true) {
		throw new Error("Replacing platform scaffold files requires confirm=true.");
	}
	const settings = normalizeSettings(target, data.settings);
	const directory = scaffoldDirectory(projectDirectory, target);
	const packagePath = join(projectDirectory, "package.json");
	const packageJson = await readJSON(packagePath);
	packageJson.scripts ??= {};
	const generatedScript = `node .zvibe/platforms/${target}/build.mjs`;
	const scriptName = `build:${target}`;
	const existingScript = packageJson.scripts[scriptName];
	if (typeof existingScript === "string" && existingScript !== generatedScript && data.overwrite !== true) {
		throw new Error(`package.json already defines ${scriptName}; use overwrite=true and confirm=true to preserve it in the scaffold manifest and replace it.`);
	}
	const packageScripts: IPlatformScaffoldManifest["packageScripts"] = {
		[scriptName]: {
			value: generatedScript,
			...(typeof existingScript === "string" && existingScript !== generatedScript
				? { previous: existingScript }
				: current?.packageScripts[scriptName]?.previous
					? { previous: current.packageScripts[scriptName].previous }
					: {}),
		},
	};
	packageJson.scripts[scriptName] = generatedScript;
	const files = new Map<string, string>([
		["build.mjs", platformBuildSource(target)],
		["README.md", platformReadme(target, settings)],
	]);
	const preservedUserFiles: string[] = [];
	let createDefaultServerGame = false;
	if (target === "headless") {
		files.set("server.mjs", dedicatedServerSource());
		files.set("Dockerfile", dedicatedServerDockerfileSource());
		files.set("Dockerfile.linux-arm64", dedicatedServerLinuxArm64DockerfileSource());
		const gamePath = join(directory, "server-game.mjs");
		if (!(await pathExists(gamePath))) {
			createDefaultServerGame = true;
		}
		preservedUserFiles.push("server-game.mjs");
		const runScript = "node .zvibe/platforms/headless/run.mjs";
		const existingRun = packageJson.scripts["run:headless"];
		if (typeof existingRun === "string" && existingRun !== runScript && data.overwrite !== true) {
			throw new Error("package.json already defines run:headless; use overwrite=true and confirm=true to replace it safely.");
		}
		packageScripts["run:headless"] = {
			value: runScript,
			...(typeof existingRun === "string" && existingRun !== runScript
				? { previous: existingRun }
				: current?.packageScripts["run:headless"]?.previous
					? { previous: current.packageScripts["run:headless"].previous }
					: {}),
		};
		packageJson.scripts["run:headless"] = runScript;
		files.set(
			"run.mjs",
			`import { spawn } from "node:child_process";\nimport { readFile } from "node:fs/promises";\nimport { dirname, join } from "node:path";\nimport { fileURLToPath } from "node:url";\nconst scaffold=dirname(fileURLToPath(import.meta.url));\nconst project=join(scaffold,"../../..");\nconst output=join(project,process.env.BJS_EDITOR_OUTPUT_DIRECTORY||"dist/headless");\nconst child=spawn(process.execPath,[join(output,"server.mjs")],{cwd:output,env:process.env,stdio:"inherit"});\nchild.on("exit",(code)=>process.exit(code??0));\nvoid readFile;\n`
		);
	} else {
		const projectSettings = options.editor.state.projectSettings;
		const applicationId = projectSettings?.identity?.applicationId ?? "com.zvibe.game";
		const productName = projectSettings?.identity?.productName ?? "Zvibe Game";
		if (target === "android" || settings.projectType !== "swift") {
			files.set("capacitor.config.json", capacitorConfiguration(target, settings, applicationId, productName));
		}
		if (target === "android") {
			files.set("zvibe-signing.init.gradle", androidSigningInitSource());
			files.set("zvibe-build-profile.init.gradle", androidBuildProfileInitSource());
			files.set("ZvibeWindowInsetsPlugin.kt", androidWindowInsetsPluginSource());
			files.set("ZvibePlayerInitialization.kt", androidPlayerInitializationSource());
		} else if (settings.projectType === "swift") {
			for (const [path, source] of createIosSwiftProjectFiles(settings as any, applicationId, productName)) {
				files.set(path, source);
			}
		} else {
			files.set("ZvibeAdaptivePerformancePlugin.swift", appleAdaptivePerformancePluginSource());
			files.set("ZvibeVisionOS.xcconfig", visionOSConfigurationSource(settings));
		}
	}
	const now = new Date().toISOString();
	const generatedFiles = [...files.entries()].map(([path, content]) => ({ path, sha256: sha256(content) }));
	const manifest: IPlatformScaffoldManifest = {
		version: PLATFORM_SCAFFOLD_VERSION,
		revision: currentRevision + 1,
		target,
		createdAt: current?.createdAt ?? now,
		updatedAt: now,
		settings,
		packageScripts,
		generatedFiles,
		preservedUserFiles,
	};
	const directoryExisted = await pathExists(directory);
	const obsoleteGeneratedPaths = current?.generatedFiles.filter((entry) => !files.has(entry.path)).map((entry) => join(directory, entry.path)) ?? [];
	const touchedPaths = [packagePath, manifestPath(projectDirectory, target), ...[...files.keys()].map((path) => join(directory, path)), ...obsoleteGeneratedPaths];
	if (createDefaultServerGame) {
		touchedPaths.push(join(directory, "server-game.mjs"));
	}
	const snapshot = await captureTextFiles(touchedPaths);
	try {
		await ensureDir(directory);
		for (const path of obsoleteGeneratedPaths) {
			await remove(path);
		}
		for (const [path, content] of files) {
			await ensureDir(dirname(join(directory, path)));
			await writeFile(join(directory, path), content, "utf8");
		}
		if (createDefaultServerGame) {
			await writeFile(join(directory, "server-game.mjs"), defaultServerGameSource(), "utf8");
		}
		await writeJSON(manifestPath(projectDirectory, target), manifest, { spaces: "\t" });
		await writeJSON(packagePath, packageJson, { spaces: "\t" });
	} catch (error) {
		await restoreTextFiles(snapshot);
		if (!directoryExisted) {
			await remove(directory);
		}
		throw error;
	}
	return { ...(await scaffoldStatus(projectDirectory, target)), packageScripts: structuredClone(packageScripts) };
}

export { getIosProjectGenerationCapabilities };

/** Validates the exact generated experimental Swift iOS project and its editor-owned file hashes. */
export async function validateIosGeneratedProject(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<Record<string, unknown>> {
	const input = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
	const status = await scaffoldStatus(requireProjectDirectory(options), "ios");
	if (!status.exists) {
		throw new Error("No iOS platform scaffold exists. Generate an iOS scaffold with projectType=swift first.");
	}
	if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== status.revision)) {
		throw new Error(`Stale iOS platform scaffold revision ${input.expectedRevision}; current revision is ${status.revision}.`);
	}
	if (status.manifest.settings.projectType !== "swift") {
		throw new Error("The current iOS scaffold uses the Capacitor project type. Set projectType=swift before validating a Swift Xcode project.");
	}
	const validation = await validateIosSwiftProject(scaffoldDirectory(requireProjectDirectory(options), "ios"));
	return {
		revision: status.revision,
		integrity: status.integrity,
		...validation,
		valid: status.integrity === true && validation.valid === true,
	};
}

/** Removes only editor-owned generated files and restores replaced package scripts. */
export async function removePlatformScaffold(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("Removing a platform scaffold requires confirm=true.");
	}
	const target = requireScaffoldableTarget(data.target);
	const projectDirectory = requireProjectDirectory(options);
	const manifest = await readManifest(projectDirectory, target);
	if (!manifest) {
		throw new Error(`The ${target} platform scaffold does not exist.`);
	}
	if (!Number.isSafeInteger(data.expectedRevision) || data.expectedRevision !== manifest.revision) {
		throw new Error(`Stale ${target} platform scaffold revision ${data.expectedRevision}; current revision is ${manifest.revision}.`);
	}
	const packagePath = join(projectDirectory, "package.json");
	const packageJson = await readJSON(packagePath);
	for (const [name, script] of Object.entries(manifest.packageScripts)) {
		if (packageJson.scripts?.[name] === script.value) {
			if (script.previous !== undefined) {
				packageJson.scripts[name] = script.previous;
			} else {
				delete packageJson.scripts[name];
			}
		}
	}
	const generatedPaths = manifest.generatedFiles.map((entry) => join(scaffoldDirectory(projectDirectory, target), entry.path));
	if (target === "android") {
		generatedPaths.push(join(scaffoldDirectory(projectDirectory, target), "zvibe-android-build-profile.json"));
	}
	const nativeManifestPath = target === "android" ? join(scaffoldDirectory(projectDirectory, target), "android", "app", "src", "main", "AndroidManifest.xml") : null;
	const snapshot = await captureTextFiles([packagePath, manifestPath(projectDirectory, target), ...generatedPaths, ...(nativeManifestPath ? [nativeManifestPath] : [])]);
	try {
		if (nativeManifestPath && (await pathExists(nativeManifestPath))) {
			const source = await readFile(nativeManifestPath, "utf8");
			await writeFile(nativeManifestPath, source.replace(/<!-- Zvibe Player Initialization: start -->[\s\S]*?<!-- Zvibe Player Initialization: end -->/g, ""), "utf8");
		}
		for (const path of generatedPaths) {
			await remove(path);
		}
		await remove(manifestPath(projectDirectory, target));
		await writeJSON(packagePath, packageJson, { spaces: "\t" });
	} catch (error) {
		await restoreTextFiles(snapshot);
		throw error;
	}
	return { removed: true, target, revision: manifest.revision, preservedUserFiles: manifest.preservedUserFiles };
}

/** Validates all authored Build Profiles together with platform scaffolds and host/SDK readiness. */
export async function validatePlatformBuildMatrix(scene: Scene, _data: any, options: IMCPActionOptions): Promise<any> {
	const configuration = listBuildProfiles(scene);
	const profiles = await Promise.all(
		configuration.profiles.map(async (profile) => {
			const [build, platform] = await Promise.all([validateBuildProfile(scene, { id: profile.id }, options), diagnosticsForTarget(profile.target, options)]);
			return { id: profile.id, name: profile.name, target: profile.target, enabled: profile.enabled, build, platform };
		})
	);
	return {
		configurationRevision: configuration.revision,
		profiles,
		validForProjectExport: profiles.filter((entry) => entry.enabled).every((entry) => entry.build.valid && entry.platform.readyForProjectExport),
		validForNativePackage: profiles.filter((entry) => entry.enabled).every((entry) => entry.build.valid && entry.platform.readyForNativePackage),
	};
}
