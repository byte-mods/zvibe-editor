import { createHash, randomBytes } from "crypto";
import { dirname, isAbsolute, join, normalize, relative } from "path/posix";
import { ensureDir, lstat, pathExists, readFile, readJSON, readdir, remove, stat, writeFile, writeJSON } from "fs-extra";

import { Scene, Tools } from "babylonjs";
import { transform } from "esbuild";
import {
	getAssetStreamingBuildPlan,
	getPlatformPlayerBuildPlan,
	IAssetStreamingSettings,
	IPlatformPlayerSettings,
	IXRTargetValidationReport,
	normalizeAssetStreamingSettings,
	normalizeModelImporterPlatform,
	normalizePlatformPlayerSettings,
	validateXRTarget,
} from "babylonjs-editor-tools";

import { getProjectAssetsRootUrl } from "../../project/configuration";
import { exportProject } from "../../project/export/export";
import { normalizeProjectSettings, resolveProjectSettingsForTarget } from "../../project/settings";
import { execNodePty } from "../../tools/node-pty";

import { IMCPActionOptions } from "../action";
import { createWebBuildPlan, CURRENT_EMSCRIPTEN_VERSION, IWebBuildEvidenceSettings, probeWebBuildToolchain, verifyWebBuildManifest, writeWebBuildManifest } from "./web-build";

export const BUILD_PIPELINE_VERSION = 2 as const;

export type BuildTarget = "web" | "electron" | "headless" | "android" | "ios";
export type BuildMode = "development" | "release";
export type BuildCompression = "none" | "gzip" | "brotli";

export interface IBuildProfileOptions {
	optimize: boolean;
	mergeDecals: boolean;
	mergeGeometries: boolean;
	uploadToS3: boolean;
}

export interface IBuildSigningSettings {
	enabled: boolean;
	identityEnvironment?: string;
	certificateEnvironment?: string;
	passwordEnvironment?: string;
	provisioningProfileEnvironment?: string;
}

export interface IWebBuildSettings extends IWebBuildEvidenceSettings {
	basePath: string;
	mode: "browser" | "pwa" | "webxr";
	clientBrowser: "system" | "chrome" | "firefox" | "safari" | "edge";
	optimization: "fast-build" | "balanced" | "runtime-performance" | "small-download";
}

export type AndroidLinkTimeOptimization = "none" | "thin" | "full";
export type AndroidXrLinkTimeOptimization = "inherit" | "thin";

export interface IAndroidBuildSettings {
	linkTimeOptimization: AndroidLinkTimeOptimization;
	xrLinkTimeOptimization: AndroidXrLinkTimeOptimization;
	initializationProfiling: boolean;
}

export interface IHeadlessBuildSettings {
	operatingSystem: "linux";
	architecture: "x64" | "arm64";
	sourceBuild: true;
	nodeMajor: 22;
}

export interface IBuildProfileSettings {
	productName?: string;
	companyName?: string;
	version?: string;
	applicationId?: string;
	outputDirectory: string;
	buildMode: BuildMode;
	cleanBuild: boolean;
	incremental: boolean;
	sourceMaps: boolean;
	minify: boolean;
	codeCoverage: boolean;
	compression: BuildCompression;
	defineSymbols: string[];
	preBuildScripts: string[];
	buildScripts?: string[];
	postBuildScripts: string[];
	runScript?: string;
	signing: IBuildSigningSettings;
	web?: IWebBuildSettings;
	android?: IAndroidBuildSettings;
	headless?: IHeadlessBuildSettings;
	pwa?: Record<string, unknown>;
	electronPlatform?: "darwin" | "win32" | "linux";
	electronArch?: "x64" | "arm64";
	electronAsar?: boolean;
	electronIcon?: string;
	platformPlayer?: IPlatformPlayerSettings;
	assetStreaming?: IAssetStreamingSettings;
}

export interface IBuildProfile {
	id: string;
	name: string;
	target: BuildTarget;
	enabled: boolean;
	options: IBuildProfileOptions;
	settings: IBuildProfileSettings;
}

export interface IBuildPipelineConfiguration {
	version: typeof BUILD_PIPELINE_VERSION;
	revision: number;
	activeProfileId?: string;
	profiles: IBuildProfile[];
}

export interface IBuildStageReport {
	name: "validation" | "clean" | "export" | "pre-build" | "build" | "post-build";
	status: "passed" | "failed" | "skipped";
	startedAt: string;
	completedAt: string;
	durationMs: number;
	command?: string;
	exitCode?: number;
	outputTail?: string;
}

export interface IBuildArtifactReport {
	path: string;
	sizeBytes: number;
	sha256: string;
}

export interface IBuildProfileIdentity {
	id?: string;
	name?: string;
}

const defaultOptions: IBuildProfileOptions = {
	optimize: true,
	mergeDecals: false,
	mergeGeometries: false,
	uploadToS3: false,
};

const targets = new Set<BuildTarget>(["web", "electron", "headless", "android", "ios"]);
const environmentPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const scriptPattern = /^[A-Za-z0-9:_-]+$/;
const definePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface IActiveBuildRun {
	id: string;
	profileId: string;
	profile: string;
	target: BuildTarget;
	command: string;
	startedAt: string;
	status: "running" | "stopping" | "exited";
	exitCode?: number;
	outputTail: string;
	process: Awaited<ReturnType<typeof execNodePty>>;
}

const activeBuildRuns = new WeakMap<Scene, Map<string, IActiveBuildRun>>();

type BuildProfileJobOperation = "export" | "build" | "build-and-run";
type BuildProfileJobStatus = "queued" | "running" | "succeeded" | "failed";

interface IBuildProfileJob {
	id: string;
	operation: BuildProfileJobOperation;
	profileId: string;
	profile: string;
	target: BuildTarget;
	expectedRevision: number;
	status: BuildProfileJobStatus;
	createdAt: string;
	startedAt?: string;
	completedAt?: string;
	result?: any;
	error?: string;
}

const buildProfileJobs = new WeakMap<Scene, Map<string, IBuildProfileJob>>();

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringArray(value: unknown, maximum: number): string[] {
	return Array.isArray(value)
		? [...new Set(value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())).map((entry) => entry.trim()))].slice(0, maximum)
		: [];
}

function safeRelativePath(value: unknown, fallback: string, label: string): string {
	const result = text(value, fallback).replaceAll("\\", "/").replace(/^\.\//, "");
	if (!result || result === "." || result.startsWith("/") || /^[A-Za-z]:\//.test(result) || result.split("/").includes("..")) {
		throw new Error(`${label} must be a non-empty project-relative path without traversal.`);
	}
	return result;
}

function defaultSettings(target: BuildTarget): IBuildProfileSettings {
	return {
		outputDirectory: target === "web" ? "dist" : target === "electron" ? "electron-packages" : `dist/${target}`,
		buildMode: "release",
		cleanBuild: false,
		incremental: true,
		sourceMaps: false,
		minify: true,
		codeCoverage: false,
		compression: target === "web" ? "brotli" : "none",
		defineSymbols: [],
		preBuildScripts: [],
		postBuildScripts: [],
		runScript: target === "headless" ? "run:headless" : undefined,
		signing: { enabled: false },
		...(target === "electron"
			? {
					electronPlatform: process.platform === "win32" ? "win32" : process.platform === "linux" ? "linux" : "darwin",
					electronArch: process.arch === "arm64" ? "arm64" : "x64",
					electronAsar: true,
					platformPlayer: normalizePlatformPlayerSettings({}),
					assetStreaming: normalizeAssetStreamingSettings({}),
				}
			: target === "headless"
				? {
						headless: {
							operatingSystem: "linux",
							architecture: process.arch === "arm64" ? "arm64" : "x64",
							sourceBuild: true,
							nodeMajor: 22,
						} as IHeadlessBuildSettings,
					}
				: target === "web"
					? {
							web: {
								basePath: "/",
								mode: "browser",
								clientBrowser: "system",
								optimization: "balanced",
								moduleStripping: true,
								webAssembly2023: true,
								emscriptenToolchain: "typescript-bundler",
								emscriptenExecutable: "emcc",
							} as IWebBuildSettings,
						}
					: target === "android"
						? { android: { linkTimeOptimization: "none", xrLinkTimeOptimization: "inherit", initializationProfiling: true } as IAndroidBuildSettings }
						: {}),
	};
}

function normalizeHeadlessBuildSettings(value: unknown, fallback?: IHeadlessBuildSettings): IHeadlessBuildSettings | undefined {
	if (!fallback && (value === undefined || value === null)) {
		return undefined;
	}
	const source = asRecord(value);
	const defaults = fallback ?? { operatingSystem: "linux", architecture: "x64", sourceBuild: true, nodeMajor: 22 };
	return {
		operatingSystem: "linux",
		architecture: source.architecture === "arm64" ? "arm64" : source.architecture === "x64" ? "x64" : defaults.architecture,
		sourceBuild: true,
		nodeMajor: 22,
	};
}

function normalizeAndroidBuildSettings(value: unknown, fallback?: IAndroidBuildSettings): IAndroidBuildSettings | undefined {
	if (!fallback && (value === undefined || value === null)) {
		return undefined;
	}
	const source = asRecord(value);
	const defaults = fallback ?? { linkTimeOptimization: "none", xrLinkTimeOptimization: "inherit", initializationProfiling: true };
	return {
		linkTimeOptimization:
			source.linkTimeOptimization === "none" || source.linkTimeOptimization === "thin" || source.linkTimeOptimization === "full"
				? source.linkTimeOptimization
				: defaults.linkTimeOptimization,
		xrLinkTimeOptimization:
			source.xrLinkTimeOptimization === "inherit" || source.xrLinkTimeOptimization === "thin" ? source.xrLinkTimeOptimization : defaults.xrLinkTimeOptimization,
		initializationProfiling: typeof source.initializationProfiling === "boolean" ? source.initializationProfiling : defaults.initializationProfiling,
	};
}

function normalizeWeb(value: unknown, fallback?: IWebBuildSettings): IWebBuildSettings | undefined {
	if (!fallback && (value === undefined || value === null)) {
		return undefined;
	}
	const source = asRecord(value);
	const defaults =
		fallback ??
		({
			basePath: "/",
			mode: "browser",
			clientBrowser: "system",
			optimization: "balanced",
			moduleStripping: true,
			webAssembly2023: true,
			emscriptenToolchain: "typescript-bundler",
			emscriptenExecutable: "emcc",
		} as IWebBuildSettings);
	const basePath = typeof source.basePath === "string" && source.basePath.startsWith("/") ? source.basePath.slice(0, 2048) : defaults.basePath;
	const emscriptenExecutable =
		typeof source.emscriptenExecutable === "string" && source.emscriptenExecutable.trim() && source.emscriptenExecutable.length <= 2048
			? source.emscriptenExecutable.trim()
			: defaults.emscriptenExecutable;
	return {
		basePath,
		mode: source.mode === "pwa" || source.mode === "webxr" ? source.mode : "browser",
		clientBrowser: ["system", "chrome", "firefox", "safari", "edge"].includes(String(source.clientBrowser))
			? (source.clientBrowser as IWebBuildSettings["clientBrowser"])
			: defaults.clientBrowser,
		optimization: ["fast-build", "balanced", "runtime-performance", "small-download"].includes(String(source.optimization))
			? (source.optimization as IWebBuildSettings["optimization"])
			: defaults.optimization,
		moduleStripping: source.moduleStripping !== false,
		webAssembly2023: source.webAssembly2023 !== false,
		emscriptenToolchain: source.emscriptenToolchain === "external-4.0.19" ? "external-4.0.19" : "typescript-bundler",
		emscriptenExecutable,
	};
}

function normalizeSigning(value: unknown): IBuildSigningSettings {
	const source = asRecord(value);
	return {
		enabled: source.enabled === true,
		identityEnvironment: typeof source.identityEnvironment === "string" && source.identityEnvironment.trim() ? source.identityEnvironment.trim() : undefined,
		certificateEnvironment: typeof source.certificateEnvironment === "string" && source.certificateEnvironment.trim() ? source.certificateEnvironment.trim() : undefined,
		passwordEnvironment: typeof source.passwordEnvironment === "string" && source.passwordEnvironment.trim() ? source.passwordEnvironment.trim() : undefined,
		provisioningProfileEnvironment:
			typeof source.provisioningProfileEnvironment === "string" && source.provisioningProfileEnvironment.trim() ? source.provisioningProfileEnvironment.trim() : undefined,
	};
}

function normalizeSettings(value: unknown, target: BuildTarget): IBuildProfileSettings {
	const source = asRecord(value);
	const defaults = defaultSettings(target);
	const buildMode: BuildMode = source.buildMode === "development" ? "development" : "release";
	return {
		...defaults,
		productName: typeof source.productName === "string" && source.productName.trim() ? source.productName.trim() : undefined,
		companyName: typeof source.companyName === "string" && source.companyName.trim() ? source.companyName.trim() : undefined,
		version: typeof source.version === "string" && source.version.trim() ? source.version.trim() : undefined,
		applicationId: typeof source.applicationId === "string" && source.applicationId.trim() ? source.applicationId.trim() : undefined,
		outputDirectory: safeRelativePath(source.outputDirectory, defaults.outputDirectory, "Build outputDirectory"),
		buildMode,
		cleanBuild: source.cleanBuild === true,
		incremental: source.incremental !== false,
		sourceMaps: source.sourceMaps === true || (source.sourceMaps === undefined && buildMode === "development"),
		minify: source.minify === true || (source.minify === undefined && buildMode === "release"),
		codeCoverage: source.codeCoverage === true,
		compression: source.compression === "none" || source.compression === "gzip" || source.compression === "brotli" ? source.compression : defaults.compression,
		defineSymbols: stringArray(source.defineSymbols, 128),
		preBuildScripts: stringArray(source.preBuildScripts, 16),
		buildScripts: source.buildScripts === undefined ? undefined : stringArray(source.buildScripts, 16),
		postBuildScripts: stringArray(source.postBuildScripts, 16),
		runScript: typeof source.runScript === "string" && source.runScript.trim() ? source.runScript.trim() : undefined,
		signing: normalizeSigning(source.signing),
		web: normalizeWeb(source.web, defaults.web),
		android: target === "android" ? normalizeAndroidBuildSettings(source.android, defaults.android) : undefined,
		headless: target === "headless" ? normalizeHeadlessBuildSettings(source.headless, defaults.headless) : undefined,
		pwa: source.pwa && typeof source.pwa === "object" ? structuredClone(source.pwa as Record<string, unknown>) : undefined,
		electronPlatform:
			source.electronPlatform === "win32" || source.electronPlatform === "linux" ? source.electronPlatform : target === "electron" ? defaults.electronPlatform : undefined,
		electronArch: target === "electron" ? (source.electronArch === "arm64" || source.electronArch === "x64" ? source.electronArch : defaults.electronArch) : undefined,
		electronAsar: target === "electron" ? source.electronAsar !== false : undefined,
		electronIcon: typeof source.electronIcon === "string" && source.electronIcon.trim() ? safeRelativePath(source.electronIcon, "", "Electron icon") : undefined,
		platformPlayer: target === "electron" ? normalizePlatformPlayerSettings(source.platformPlayer ?? defaults.platformPlayer) : undefined,
		assetStreaming: target === "electron" ? normalizeAssetStreamingSettings(source.assetStreaming ?? defaults.assetStreaming) : undefined,
	};
}

function normalizeProfile(value: unknown, index: number): IBuildProfile {
	const source = asRecord(value);
	const target = targets.has(source.target as BuildTarget) ? (source.target as BuildTarget) : "web";
	return {
		id: text(source.id, `profile-${index + 1}`).slice(0, 128),
		name: text(source.name, `Build Profile ${index + 1}`).slice(0, 128),
		target,
		enabled: source.enabled !== false,
		options: {
			optimize: asRecord(source.options).optimize !== false,
			mergeDecals: asRecord(source.options).mergeDecals === true,
			mergeGeometries: asRecord(source.options).mergeGeometries === true,
			uploadToS3: asRecord(source.options).uploadToS3 === true,
		},
		settings: normalizeSettings(source.settings, target),
	};
}

export function normalizeBuildPipelineConfiguration(value: unknown, legacyProfiles: unknown = []): IBuildPipelineConfiguration {
	const source = asRecord(value);
	const rawProfiles = Array.isArray(source.profiles) ? source.profiles : Array.isArray(legacyProfiles) ? legacyProfiles : [];
	const profiles = rawProfiles.slice(0, 64).map(normalizeProfile);
	const configuration: IBuildPipelineConfiguration = {
		version: BUILD_PIPELINE_VERSION,
		revision: typeof source.revision === "number" && Number.isSafeInteger(source.revision) && source.revision >= 0 ? source.revision : 0,
		activeProfileId: typeof source.activeProfileId === "string" ? source.activeProfileId : profiles[0]?.id,
		profiles,
	};
	validateBuildPipelineConfiguration(configuration);
	return configuration;
}

export function validateBuildPipelineConfiguration(configuration: IBuildPipelineConfiguration): void {
	if (configuration.version !== BUILD_PIPELINE_VERSION || !Number.isSafeInteger(configuration.revision) || configuration.revision < 0) {
		throw new Error("Build Pipeline configuration version or revision is invalid.");
	}
	if (configuration.profiles.length > 64) {
		throw new Error("Build Pipeline supports at most 64 profiles.");
	}
	const ids = new Set<string>();
	const names = new Set<string>();
	for (const profile of configuration.profiles) {
		if (!profile.id.trim() || !profile.name.trim() || profile.id.length > 128 || profile.name.length > 128 || ids.has(profile.id) || names.has(profile.name.toLowerCase())) {
			throw new Error(`Build profile ids and names must be unique non-empty strings: ${profile.name}`);
		}
		ids.add(profile.id);
		names.add(profile.name.toLowerCase());
		if (!targets.has(profile.target)) {
			throw new Error(`Unsupported build target: ${profile.target}`);
		}
		safeRelativePath(profile.settings.outputDirectory, "", "Build outputDirectory");
		for (const script of [
			...profile.settings.preBuildScripts,
			...(profile.settings.buildScripts ?? []),
			...profile.settings.postBuildScripts,
			...(profile.settings.runScript ? [profile.settings.runScript] : []),
		]) {
			if (!scriptPattern.test(script)) {
				throw new Error(`Build profile package script name is invalid: ${script}`);
			}
		}
		if (profile.settings.defineSymbols.length > 128 || profile.settings.defineSymbols.some((value) => !definePattern.test(value))) {
			throw new Error(`Build profile "${profile.name}" contains invalid define symbols.`);
		}
		if (profile.settings.codeCoverage && (profile.target !== "electron" || profile.settings.buildMode !== "development")) {
			throw new Error(`Build profile "${profile.name}" can enable code coverage only for an Electron development build.`);
		}
		if (profile.settings.applicationId && !/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+$/.test(profile.settings.applicationId)) {
			throw new Error(`Build profile applicationId is invalid: ${profile.settings.applicationId}`);
		}
		for (const value of Object.values(profile.settings.signing).filter((entry): entry is string => typeof entry === "string")) {
			if (!environmentPattern.test(value)) {
				throw new Error(`Build signing environment name is invalid: ${value}`);
			}
		}
		if (profile.settings.web && /[\0\r\n]/.test(profile.settings.web.emscriptenExecutable)) {
			throw new Error(`Build profile "${profile.name}" contains an invalid Emscripten executable.`);
		}
		if (
			profile.target === "android" &&
			(!profile.settings.android ||
				!["none", "thin", "full"].includes(profile.settings.android.linkTimeOptimization) ||
				!["inherit", "thin"].includes(profile.settings.android.xrLinkTimeOptimization) ||
				typeof profile.settings.android.initializationProfiling !== "boolean")
		) {
			throw new Error(`Build profile "${profile.name}" contains invalid Android player settings.`);
		}
		if (
			profile.target === "headless" &&
			(!profile.settings.headless ||
				profile.settings.headless.operatingSystem !== "linux" ||
				!["x64", "arm64"].includes(profile.settings.headless.architecture) ||
				profile.settings.headless.sourceBuild !== true ||
				profile.settings.headless.nodeMajor !== 22)
		) {
			throw new Error(`Build profile "${profile.name}" contains invalid Linux Dedicated Server source-build settings.`);
		}
	}
	if (configuration.activeProfileId && !ids.has(configuration.activeProfileId)) {
		throw new Error(`Active build profile was not found: ${configuration.activeProfileId}`);
	}
}

export function getGenerateOptions(): any {
	return { options: defaultOptions };
}

function getBuildConfiguration(scene: Scene): IBuildPipelineConfiguration {
	scene.metadata ??= {};
	const configuration = normalizeBuildPipelineConfiguration(scene.metadata.babylonEditorBuildPipeline, scene.metadata.babylonEditorBuildProfiles);
	scene.metadata.babylonEditorBuildPipeline = configuration;
	delete scene.metadata.babylonEditorBuildProfiles;
	return configuration;
}
function getBuildReports(scene: Scene): any[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorBuildReports ??= []);
}
function findBuildProfileInConfiguration(configuration: IBuildPipelineConfiguration, data: IBuildProfileIdentity): IBuildProfile {
	const profile = configuration.profiles.find((item) => item.id === data.id || item.name === data.name);
	if (!profile) {
		throw new Error(`Build profile "${data.id ?? data.name ?? "unspecified"}" was not found.`);
	}
	return profile;
}

function findBuildProfile(scene: Scene, data: IBuildProfileIdentity): IBuildProfile {
	return findBuildProfileInConfiguration(getBuildConfiguration(scene), data);
}

function assertBuildRevision(configuration: IBuildPipelineConfiguration, expectedRevision: number): void {
	if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== configuration.revision) {
		throw new Error(`Stale Build Pipeline revision ${expectedRevision}; current revision is ${configuration.revision}.`);
	}
}

function commitBuildConfiguration(scene: Scene, configuration: IBuildPipelineConfiguration, expectedRevision: number): IBuildPipelineConfiguration {
	assertBuildRevision(configuration, expectedRevision);
	configuration.revision++;
	validateBuildPipelineConfiguration(configuration);
	scene.metadata.babylonEditorBuildPipeline = configuration;
	return structuredClone(configuration);
}

function getProjectOutputPath(projectPath: string, requestedPath: unknown, label: string): { directory: string; outputPath: string; relativePath: string } {
	if (typeof requestedPath !== "string" || !requestedPath.trim()) {
		throw new Error(`${label} must be a non-empty project-relative path.`);
	}
	const directory = dirname(projectPath);
	const outputPath = normalize(isAbsolute(requestedPath) ? requestedPath : join(directory, requestedPath));
	if (outputPath !== directory && !outputPath.startsWith(`${directory}/`)) {
		throw new Error(`${label} must stay inside the project.`);
	}
	return { directory, outputPath, relativePath: outputPath.slice(directory.length + 1) };
}

function getPwaStartUrl(profile: any): string {
	const startUrl = profile.settings?.pwa?.startUrl ?? profile.settings?.web?.basePath ?? "/";
	if (typeof startUrl !== "string" || !startUrl.trim()) {
		throw new Error("PWA startUrl must be a non-empty same-origin URL path.");
	}
	if (!startUrl.startsWith("/")) {
		throw new Error("PWA startUrl must begin with '/'.");
	}
	return startUrl.trim();
}

function createPwaServiceWorkerSource(profile: any): { source: string; cacheName: string; precacheUrls: string[]; startUrl: string } {
	const settings = profile.settings ?? {};
	const pwa = settings.pwa ?? {};
	const startUrl = getPwaStartUrl(profile);
	const precacheUrls = pwa.precacheUrls?.length ? pwa.precacheUrls : [startUrl];
	if (!Array.isArray(precacheUrls) || precacheUrls.some((url) => typeof url !== "string" || !url.trim() || !url.trim().startsWith("/"))) {
		throw new Error("PWA precacheUrls must be non-empty same-origin URL paths beginning with '/'.");
	}
	const version = typeof settings.version === "string" && settings.version.trim() ? settings.version.trim() : "v1";
	const cacheName = `babylon-editor-pwa-${profile.name}-${version}`.replace(/[^a-zA-Z0-9._-]/g, "-");
	const fallbackUrl = pwa.offlineFallbackUrl ?? startUrl;
	if (typeof fallbackUrl !== "string" || !fallbackUrl.trim() || !fallbackUrl.trim().startsWith("/")) {
		throw new Error("PWA offlineFallbackUrl must be a same-origin URL path beginning with '/'.");
	}
	const source = `/* Generated by Babylon.js Editor. Configure this Web profile's PWA cache URLs, then regenerate. */
const CACHE_NAME = ${JSON.stringify(cacheName)};
const PRECACHE_URLS = ${JSON.stringify([...new Set(precacheUrls.map((url) => url.trim()))], null, "\t")};
const OFFLINE_FALLBACK_URL = ${JSON.stringify(fallbackUrl.trim())};

self.addEventListener("install", (event) => {
	event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("babylon-editor-pwa-") && key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim())
	);
});

self.addEventListener("fetch", (event) => {
	if (event.request.method !== "GET") return;
	event.respondWith(
		caches.match(event.request).then((cached) =>
			cached ||
			fetch(event.request)
				.then((response) => {
					if (!response || !response.ok || new URL(event.request.url).origin !== self.location.origin) return response;
					const copy = response.clone();
					void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
					return response;
				})
				.catch(() => caches.match(OFFLINE_FALLBACK_URL))
		)
	);
});
`;
	return { source, cacheName, precacheUrls: [...new Set(precacheUrls.map((url) => url.trim()))], startUrl };
}

function getPwaServiceWorkerWebPath(serviceWorkerPath: unknown): string {
	if (typeof serviceWorkerPath !== "string" || !serviceWorkerPath.startsWith("public/") || serviceWorkerPath.length === "public/".length) {
		throw new Error("PWA serviceWorkerPath must be inside public/ so the generated web build can serve and register it.");
	}
	return `/${serviceWorkerPath.slice("public/".length)}`;
}

function getPwaServiceWorkerRegistrationSnippet(serviceWorkerUrl: string): string {
	return `<!-- Babylon.js Editor PWA service worker: start -->
<script>
if ("serviceWorker" in navigator) {
	window.addEventListener("load", () => navigator.serviceWorker.register(${JSON.stringify(serviceWorkerUrl)}));
}
</script>
<!-- Babylon.js Editor PWA service worker: end -->`;
}

function getDefaultBuildScripts(target: BuildTarget): string[] {
	return target === "electron"
		? ["build", "package"]
		: target === "headless"
			? ["build:headless"]
			: target === "android"
				? ["build:android"]
				: target === "ios"
					? ["build:ios"]
					: ["build"];
}

function getBuildScripts(profile: IBuildProfile): { pre: string[]; build: string[]; post: string[] } {
	return { pre: profile.settings.preBuildScripts, build: profile.settings.buildScripts ?? getDefaultBuildScripts(profile.target), post: profile.settings.postBuildScripts };
}

function androidBuildProfilePlan(value: IAndroidBuildSettings | undefined): object {
	const settings = normalizeAndroidBuildSettings(value, { linkTimeOptimization: "none", xrLinkTimeOptimization: "inherit", initializationProfiling: true })!;
	const compilerFlag = settings.linkTimeOptimization === "none" ? null : `-flto=${settings.linkTimeOptimization}`;
	return {
		version: 1,
		backend: "zvibe-android-project-native-lto-v1",
		settings,
		lto: {
			mode: settings.linkTimeOptimization,
			compilerFlags: compilerFlag ? [compilerFlag] : [],
			cmakeArguments: compilerFlag
				? [
						"-DCMAKE_INTERPROCEDURAL_OPTIMIZATION=TRUE",
						`-DCMAKE_C_FLAGS_RELEASE=${compilerFlag}`,
						`-DCMAKE_CXX_FLAGS_RELEASE=${compilerFlag}`,
						`-DCMAKE_EXE_LINKER_FLAGS_RELEASE=${compilerFlag}`,
						`-DCMAKE_SHARED_LINKER_FLAGS_RELEASE=${compilerFlag}`,
					]
				: ["-DCMAKE_INTERPROCEDURAL_OPTIMIZATION=FALSE"],
			scope: "project-externalNativeBuild-cmake",
			prebuiltLibrariesRecompiled: false,
		},
		xr: {
			mode: settings.xrLinkTimeOptimization,
			cmakeDefinition: `-DZVIBE_XR_LTO_MODE=${settings.xrLinkTimeOptimization.toUpperCase()}`,
			scope: "project-native-xr-adapter-handoff",
			prebuiltXrLibrariesRecompiled: false,
		},
		initializationProfiling: {
			enabled: settings.initializationProfiling,
			androidTraceSections: [
				"Zvibe.AndroidPlayer.ContentProvider",
				"Zvibe.AndroidPlayer.ActivityCreated",
				"Zvibe.AndroidPlayer.ActivityStarted",
				"Zvibe.AndroidPlayer.ActivityResumed",
				"Zvibe.AndroidPlayer.CapacitorBridgeReady",
				"Zvibe.AndroidPlayer.FirstFrame",
				"Zvibe.AndroidPlayer.SceneReady",
			],
			boundedMarkerCapacity: 128,
			source: "ZvibePlayerInitialization.kt",
		},
		boundary:
			"This portable Gradle/CMake adapter configures project externalNativeBuild inputs and generated Android Trace markers. It does not invoke Unity IL2CPP/NDK internals or rebuild precompiled engine, browser, Capacitor, or XR vendor libraries.",
	};
}

function linuxArm64ServerSourceBuildPlan(profile: IBuildProfile): any {
	if (profile.target !== "headless") {
		throw new Error(`Build profile "${profile.name}" targets ${profile.target}; a Headless profile is required.`);
	}
	const settings = normalizeHeadlessBuildSettings(profile.settings.headless, {
		operatingSystem: "linux",
		architecture: "x64",
		sourceBuild: true,
		nodeMajor: 22,
	})!;
	if (settings.architecture !== "arm64") {
		throw new Error(`Build profile "${profile.name}" targets Linux ${settings.architecture}; select arm64 for a Linux ARM64 source build.`);
	}
	const payload = {
		version: 1,
		backend: "zvibe-public-node-linux-arm64-server-source-v1",
		profileId: profile.id,
		target: { operatingSystem: "linux", architecture: "arm64", sourceBuild: true },
		publicToolchain: {
			nodeMajor: settings.nodeMajor,
			language: "JavaScript/TypeScript",
			moduleFormat: "esm",
			packageManager: "npm-compatible",
			containerPlatform: "linux/arm64",
		},
		artifacts: ["server.mjs", "server-game.mjs", "zvibe-platform-runtime.json", "package.json", "Dockerfile.linux-arm64"],
		nativeDependencies:
			"Project dependencies that contain native addons must independently provide Linux ARM64 builds; the portable source builder does not cross-compile third-party native code.",
		boundary:
			"This public Node/TypeScript source build packages the generated Babylon NullEngine server for Linux ARM64. It does not use Unity source code, Unity internal tools, IL2CPP, or Unity Dedicated Server binary identity.",
	};
	return { ...payload, planFingerprint: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
}

function developmentCoverageManifestPath(projectDirectory: string, profile: IBuildProfile): string {
	const stableName = createHash("sha256").update(profile.id).digest("hex").slice(0, 24);
	return join(projectDirectory, ".bjseditor", "build-coverage", `${stableName}.manifest.json`);
}

function getBuildEnvironment(profile: IBuildProfile, projectDirectory: string, sceneBuildSettings?: unknown, projectSettings?: unknown): Record<string, string> {
	const settings = profile.settings;
	const playerSettings = resolveProjectSettingsForTarget(normalizeProjectSettings(projectSettings), profile.target);
	const environment: Record<string, string> = {
		BJS_EDITOR_BUILD_PROFILE_ID: profile.id,
		BJS_EDITOR_BUILD_PROFILE: profile.name,
		BJS_EDITOR_BUILD_TARGET: profile.target,
		BJS_EDITOR_BUILD_PROJECT_DIRECTORY: projectDirectory,
		BJS_EDITOR_BUILD_SETTINGS: JSON.stringify(settings),
		BJS_EDITOR_BUILD_MODE: settings.buildMode,
		BJS_EDITOR_BUILD_CLEAN: String(settings.cleanBuild),
		BJS_EDITOR_BUILD_INCREMENTAL: String(settings.incremental),
		BJS_EDITOR_SOURCE_MAPS: String(settings.sourceMaps),
		BJS_EDITOR_MINIFY: String(settings.minify),
		BJS_EDITOR_CODE_COVERAGE: String(settings.codeCoverage),
		BJS_EDITOR_COMPRESSION: settings.compression,
		BJS_EDITOR_DEFINE_SYMBOLS: settings.defineSymbols.join(";"),
		BJS_EDITOR_BUILD_SCENES: JSON.stringify(asRecord(sceneBuildSettings).scenes ?? []),
		BJS_EDITOR_PLAYER_SETTINGS: JSON.stringify(playerSettings),
	};
	if (profile.target === "electron") {
		environment.BJS_EDITOR_PLATFORM_PLAYER_SETTINGS = JSON.stringify(settings.platformPlayer ?? normalizePlatformPlayerSettings({}));
		environment.BJS_EDITOR_ASSET_STREAMING_SETTINGS = JSON.stringify(settings.assetStreaming ?? normalizeAssetStreamingSettings({}));
		environment.BJS_EDITOR_CODE_COVERAGE_MANIFEST = developmentCoverageManifestPath(projectDirectory, profile);
	}
	if (profile.target === "android") {
		environment.BJS_EDITOR_ANDROID_BUILD_SETTINGS = JSON.stringify(profile.settings.android ?? normalizeAndroidBuildSettings({}));
		environment.BJS_EDITOR_ANDROID_BUILD_PLAN = JSON.stringify(androidBuildProfilePlan(profile.settings.android));
	}
	if (profile.target === "headless") {
		const headless = profile.settings.headless ?? normalizeHeadlessBuildSettings({});
		environment.BJS_EDITOR_HEADLESS_BUILD_SETTINGS = JSON.stringify(headless);
		if (headless?.architecture === "arm64") {
			environment.BJS_EDITOR_LINUX_ARM64_SERVER_SOURCE_BUILD_PLAN = JSON.stringify(linuxArm64ServerSourceBuildPlan(profile));
		}
	}
	if (settings.web) {
		environment.BJS_EDITOR_WEB_MODE = settings.web.mode;
		environment.BJS_EDITOR_WEB_CLIENT_BROWSER = settings.web.clientBrowser;
		environment.BJS_EDITOR_WEB_OPTIMIZATION = settings.web.optimization;
		environment.BJS_EDITOR_WEB_BASE_PATH = settings.web.basePath;
		environment.BJS_EDITOR_WEB_MODULE_STRIPPING = String(settings.web.moduleStripping);
		environment.BJS_EDITOR_WEBASSEMBLY_2023 = String(settings.web.webAssembly2023);
		environment.BJS_EDITOR_EMSCRIPTEN_TOOLCHAIN = settings.web.emscriptenToolchain;
		environment.BJS_EDITOR_EMSCRIPTEN_VERSION = settings.web.emscriptenToolchain === "external-4.0.19" ? CURRENT_EMSCRIPTEN_VERSION : "not-used";
		environment.BJS_EDITOR_EMSCRIPTEN_EXECUTABLE = settings.web.emscriptenExecutable;
	}
	environment.BJS_EDITOR_PRODUCT_NAME = settings.productName?.trim() || playerSettings.identity.productName;
	environment.BJS_EDITOR_PRODUCT_VERSION = settings.version?.trim() || playerSettings.identity.version;
	if (typeof settings.outputDirectory === "string" && settings.outputDirectory.trim()) {
		environment.BJS_EDITOR_OUTPUT_DIRECTORY = settings.outputDirectory.trim();
	}
	if (typeof settings.electronPlatform === "string") {
		environment.BJS_EDITOR_ELECTRON_PLATFORM = settings.electronPlatform;
	}
	if (typeof settings.electronArch === "string") {
		environment.BJS_EDITOR_ELECTRON_ARCH = settings.electronArch;
	}
	if (typeof settings.electronAsar === "boolean") {
		environment.BJS_EDITOR_ELECTRON_ASAR = String(settings.electronAsar);
	}
	if (typeof settings.electronIcon === "string" && settings.electronIcon.trim()) {
		environment.BJS_EDITOR_ELECTRON_ICON = settings.electronIcon.trim();
	}
	if (profile.target === "electron" && settings.electronPlatform) {
		environment.BJS_EDITOR_PLATFORM_PLAYER_PLAN = JSON.stringify(getPlatformPlayerBuildPlan(settings.platformPlayer, settings.electronPlatform));
		environment.BJS_EDITOR_ASSET_STREAMING_PLAN = JSON.stringify(getAssetStreamingBuildPlan(settings.assetStreaming, settings.electronPlatform));
	}
	environment.BJS_EDITOR_COMPANY_NAME = settings.companyName?.trim() || playerSettings.identity.companyName;
	environment.BJS_EDITOR_APPLICATION_ID = settings.applicationId?.trim() || playerSettings.identity.applicationId;
	for (const [key, value] of Object.entries(settings.signing)) {
		if (key !== "enabled" && typeof value === "string") {
			environment[
				`BJS_EDITOR_SIGNING_${key
					.replace(/Environment$/, "")
					.replace(/[A-Z]/g, (letter) => `_${letter}`)
					.toUpperCase()}_ENVIRONMENT`
			] = value;
		}
	}
	return environment;
}

async function readDevelopmentCoverageManifest(projectDirectory: string, profile: IBuildProfile, options: { offset?: number; limit?: number; path?: string } = {}): Promise<any> {
	const offset = options.offset ?? 0;
	const limit = options.limit ?? 500;
	if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 10_000) {
		throw new Error("Development coverage pagination requires offset >= 0 and limit from 1 through 10000.");
	}
	const compatible =
		profile.target === "electron" && profile.settings.buildMode === "development" && ["darwin", "win32", "linux"].includes(profile.settings.electronPlatform ?? "");
	const manifestPath = developmentCoverageManifestPath(projectDirectory, profile);
	const runtime = {
		global: "globalThis.__zvibeDevelopmentBuildCoverageV1",
		operations: ["snapshot", "clear", "export"],
		exportFormats: ["json", "lcov"],
		persistedSnapshotKey: "zvibe-development-build-coverage-v1",
	};
	if (!profile.settings.codeCoverage) {
		return { configured: false, compatible, profileId: profile.id, reason: "Code coverage is disabled for this Build Profile.", manifest: null, runtime };
	}
	if (!compatible) {
		return {
			configured: true,
			compatible: false,
			profileId: profile.id,
			reason: "Coverage requires an Electron development profile targeting macOS, Windows, or Linux.",
			manifest: null,
			runtime,
		};
	}
	if (!(await pathExists(manifestPath))) {
		return { configured: true, compatible: true, profileId: profile.id, reason: "Build this exact profile to produce a coverage manifest.", manifest: null, runtime };
	}
	const details = await lstat(manifestPath);
	if (!details.isFile() || details.isSymbolicLink() || details.size > 32 * 1024 * 1024) {
		throw new Error("Development coverage manifest must be a regular file of at most 32 MiB.");
	}
	const manifest = await readJSON(manifestPath);
	if (
		manifest?.version !== 1 ||
		manifest.backend !== "zvibe-development-build-coverage-v1" ||
		manifest.profileId !== profile.id ||
		!/^[a-f0-9]{64}$/.test(manifest.fingerprint ?? "") ||
		!Array.isArray(manifest.points) ||
		manifest.points.length > 100_000
	) {
		throw new Error("Development coverage manifest is malformed or belongs to another Build Profile.");
	}
	const path = options.path?.replace(/\\/g, "/");
	if (path && (!path.startsWith("src/") || path.includes("../") || path.length > 1_024)) {
		throw new Error("Development coverage path must be a project-relative source file under src/.");
	}
	const points = path ? manifest.points.filter((point: any) => point.path === path) : manifest.points;
	return {
		configured: true,
		compatible: true,
		profileId: profile.id,
		manifest: {
			version: 1,
			backend: manifest.backend,
			fingerprint: manifest.fingerprint,
			targetPlatform: manifest.targetPlatform,
			files: manifest.files,
			pointCount: points.length,
			points: structuredClone(points.slice(offset, offset + limit)),
			pagination: { offset, limit, total: points.length, hasMore: offset + limit < points.length, nextOffset: offset + limit < points.length ? offset + limit : null },
			path: relative(projectDirectory, manifestPath),
		},
		runtime,
	};
}

/** Reads exact generated instrumentation evidence for one standalone desktop development profile. */
export async function getDevelopmentBuildCoverage(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const configuration = getBuildConfiguration(scene);
	const profile = findBuildProfileInConfiguration(configuration, data);
	const projectPath = options.editor.state.projectPath;
	if (!projectPath) {
		throw new Error("No project is currently open.");
	}
	return {
		configurationRevision: configuration.revision,
		profile: structuredClone(profile),
		...(await readDevelopmentCoverageManifest(dirname(projectPath), profile, data)),
	};
}

function resolveSigningEnvironment(profile: IBuildProfile): Record<string, string> {
	if (!profile.settings.signing.enabled) {
		return {};
	}
	const result: Record<string, string> = {};
	const mappings: Array<[keyof Omit<IBuildSigningSettings, "enabled">, string]> = [
		["identityEnvironment", "BJS_EDITOR_SIGNING_IDENTITY"],
		["certificateEnvironment", "BJS_EDITOR_SIGNING_CERTIFICATE"],
		["passwordEnvironment", "BJS_EDITOR_SIGNING_PASSWORD"],
		["provisioningProfileEnvironment", "BJS_EDITOR_SIGNING_PROVISIONING_PROFILE"],
	];
	for (const [field, outputName] of mappings) {
		const environmentName = profile.settings.signing[field];
		if (environmentName) {
			const value = process.env[environmentName];
			if (!value) {
				throw new Error(`Signing environment variable is not defined: ${environmentName}`);
			}
			result[outputName] = value;
		}
	}
	if (!Object.keys(result).length) {
		throw new Error(`Build profile "${profile.name}" enables signing but defines no credential environment references.`);
	}
	return result;
}
async function getBuildProfileValidation(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const profile = findBuildProfile(scene, data);
	const projectPath = options.editor.state.projectPath;
	if (!projectPath) {
		throw new Error("No project is currently open.");
	}
	const packagePath = join(dirname(projectPath), "package.json");
	if (!(await pathExists(packagePath))) {
		return { profile: structuredClone(profile), valid: false, reasons: ["package.json is missing from the project root."], warnings: [], commands: [] };
	}
	const packageJson = await readJSON(packagePath);
	const scripts = packageJson.scripts ?? {};
	const scriptGroups = getBuildScripts(profile);
	const requiredScripts = [...scriptGroups.pre, ...scriptGroups.build, ...scriptGroups.post];
	const missingScripts = requiredScripts.filter((name) => typeof scripts[name] !== "string");
	const packageManager = options.editor.state.packageManager ?? "yarn";
	const command = (script: string): string => `${packageManager === "bun" ? "bun run" : `${packageManager} run`} ${script}`;
	const settings = profile.settings;
	const settingReasons: string[] = [];
	const warnings: string[] = [];
	let xrValidation: IXRTargetValidationReport | null = null;
	if (!profile.enabled) {
		settingReasons.push(`Build profile "${profile.name}" is disabled.`);
	}
	try {
		validateBuildPipelineConfiguration(getBuildConfiguration(scene));
	} catch (error) {
		settingReasons.push(error instanceof Error ? error.message : String(error));
	}
	const output = getProjectOutputPath(projectPath, settings.outputDirectory, "Build outputDirectory");
	if (["assets", "src", "public", ".bjseditor"].some((entry) => output.relativePath === entry || output.relativePath.startsWith(`${entry}/`))) {
		settingReasons.push("Build outputDirectory cannot overwrite source, assets, public export source, or editor metadata.");
	}
	if (profile.target === "electron" && settings.electronPlatform !== undefined && !["darwin", "win32", "linux"].includes(settings.electronPlatform)) {
		settingReasons.push('Electron platform must be "darwin", "win32", or "linux".');
	}
	if (profile.target === "electron" && settings.electronArch !== undefined && !["x64", "arm64"].includes(settings.electronArch)) {
		settingReasons.push('Electron architecture must be "x64" or "arm64".');
	}
	if (profile.target === "electron" && settings.electronIcon && !(await pathExists(join(dirname(projectPath), settings.electronIcon)))) {
		settingReasons.push(`Electron icon was not found: ${settings.electronIcon}`);
	}
	if (profile.target === "electron" && settings.electronPlatform) {
		const platformPlan = getPlatformPlayerBuildPlan(settings.platformPlayer, settings.electronPlatform);
		warnings.push(...platformPlan.warnings);
		const assetStreamingPlan = getAssetStreamingBuildPlan(settings.assetStreaming, settings.electronPlatform);
		warnings.push(...assetStreamingPlan.warnings);
	}
	if (profile.target === "android") {
		const androidPlan = androidBuildProfilePlan(settings.android) as any;
		if (androidPlan.lto.mode !== "none") {
			warnings.push(
				`Android ${androidPlan.lto.mode === "thin" ? "Thin" : "Full"} LTO is handed to project externalNativeBuild/CMake inputs; prebuilt engine, Capacitor, browser, and vendor libraries are not recompiled.`
			);
		}
		if (androidPlan.xr.mode === "thin") {
			warnings.push("Android XR ThinLTO is a ZVIBE_XR_LTO_MODE project-adapter definition; native vendor XR packages and prebuilt libraries remain external.");
		}
	}
	if (profile.target === "headless" && settings.headless?.architecture === "arm64") {
		warnings.push(
			"Linux ARM64 Dedicated Server output is a public Node/TypeScript source package. Project dependencies with native addons must independently provide Linux ARM64 builds."
		);
	}
	if (profile.target === "ios" && settings.signing.enabled && process.platform !== "darwin") {
		settingReasons.push("Signed iOS builds require a macOS host.");
	}
	if (profile.target === "web" && settings.web?.mode === "webxr") {
		try {
			xrValidation = await validateXRTarget(scene, { target: "web" });
			settingReasons.push(...xrValidation.errors.map((entry) => `XR configuration: ${entry.message}`));
			warnings.push(...xrValidation.warnings.map((entry) => `XR configuration: ${entry.message}`));
		} catch (error) {
			settingReasons.push(`XR configuration: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (profile.target === "web" && settings.web?.mode === "pwa" && !settings.pwa) {
		warnings.push("PWA mode has no authored manifest/service-worker settings yet.");
	}
	if (profile.target === "web" && settings.web) {
		if (settings.web.emscriptenToolchain === "typescript-bundler") {
			warnings.push("The portable Web build uses TypeScript/JavaScript ESM bundling; Emscripten and Unity IL2CPP are not invoked.");
		} else {
			warnings.push(`The build will verify ${settings.web.emscriptenExecutable} reports Emscripten ${CURRENT_EMSCRIPTEN_VERSION} before package scripts run.`);
		}
	}
	if (settings.signing.enabled) {
		try {
			resolveSigningEnvironment(profile);
		} catch (error) {
			settingReasons.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (settings.buildMode === "release" && settings.sourceMaps) {
		warnings.push("Release source maps can disclose authored source code.");
	}
	if (settings.buildMode === "development" && settings.minify) {
		warnings.push("Development builds are minified; debugging may be harder.");
	}
	if (profile.target !== "web" && settings.compression !== "none") {
		warnings.push(`${settings.compression} compression is passed to the target script; the selected non-Web packager must implement it.`);
	}
	const enabledScenes = options.editor.state.sceneBuildSettings?.scenes?.filter((entry: { enabled: boolean }) => entry.enabled) ?? [];
	if (!enabledScenes.length && !options.editor.state.lastOpenedScenePath) {
		settingReasons.push("No enabled project scene or active scene is available for export.");
	}
	const reasons = [...missingScripts.map((script) => `The ${profile.target} target requires a package.json "${script}" script.`), ...settingReasons];
	return {
		configurationRevision: getBuildConfiguration(scene).revision,
		profile: structuredClone(profile),
		valid: reasons.length === 0,
		reasons,
		warnings,
		xrValidation,
		packageManager,
		commands: missingScripts.length ? [] : requiredScripts.map(command),
		stages: missingScripts.length
			? []
			: [
					...(scriptGroups.pre.length ? [{ name: "pre-build", commands: scriptGroups.pre.map(command) }] : []),
					{ name: "build", commands: scriptGroups.build.map(command) },
					...(scriptGroups.post.length ? [{ name: "post-build", commands: scriptGroups.post.map(command) }] : []),
				],
		outputDirectory: output.relativePath,
	};
}
/** Lists persisted build/export profiles. */
export function listBuildProfiles(scene: Scene): IBuildPipelineConfiguration {
	return structuredClone(getBuildConfiguration(scene));
}
/** Lists the latest persisted export/build reports for this scene. */
export function listBuildReports(scene: Scene): any {
	return { reports: structuredClone(getBuildReports(scene)) };
}

/** Reads one retained report by stable id. */
export function getBuildReport(scene: Scene, data: { id: string }): any {
	const report = getBuildReports(scene).find((candidate) => candidate.id === data.id);
	if (!report) {
		throw new Error(`Build report was not found: ${data.id}`);
	}
	return structuredClone(report);
}

/** Deletes one retained report without mutating the authored Build Pipeline configuration. */
export function deleteBuildReport(scene: Scene, data: { id: string; confirm: boolean }): any {
	if (data.confirm !== true) {
		throw new Error("Deleting a build report requires confirm=true.");
	}
	const reports = getBuildReports(scene);
	const index = reports.findIndex((candidate) => candidate.id === data.id);
	if (index === -1) {
		throw new Error(`Build report was not found: ${data.id}`);
	}
	const [report] = reports.splice(index, 1);
	return { deleted: true, report: structuredClone(report) };
}

/** Stores one completed export/build report in scene metadata, retaining the newest 50 reports. */
export function recordBuildReport(scene: Scene, data: any): any {
	const report = {
		version: 2,
		id: Tools.RandomId(),
		createdAt: new Date().toISOString(),
		configurationRevision: getBuildConfiguration(scene).revision,
		...structuredClone(data),
	};
	getBuildReports(scene).unshift(report);
	getBuildReports(scene).splice(50);
	return structuredClone(report);
}
/** Creates a named export preset. */
export function createBuildProfile(scene: Scene, data: any): any {
	const configuration = getBuildConfiguration(scene);
	assertBuildRevision(configuration, data.expectedRevision);
	const profile = normalizeProfile(
		{
			id: data.id ?? Tools.RandomId(),
			name: data.name,
			target: data.target ?? "web",
			enabled: data.enabled,
			options: { ...defaultOptions, ...(data.options ?? {}) },
			settings: data.settings,
		},
		configuration.profiles.length
	);
	configuration.profiles.push(profile);
	configuration.activeProfileId ??= profile.id;
	const committed = commitBuildConfiguration(scene, configuration, data.expectedRevision);
	return { configuration: committed, profile: structuredClone(profile) };
}
/** Updates a persisted build profile's target, export options, or target settings. */
export function setBuildProfile(scene: Scene, data: any): any {
	const configuration = getBuildConfiguration(scene);
	assertBuildRevision(configuration, data.expectedRevision);
	const profile = findBuildProfileInConfiguration(configuration, data);
	if (data.name !== undefined) {
		profile.name = data.name;
	}
	if (data.enabled !== undefined) {
		profile.enabled = data.enabled;
	}
	if (data.target !== undefined) {
		profile.target = data.target;
		profile.settings = normalizeSettings(profile.settings, profile.target);
	}
	if (data.options !== undefined) {
		profile.options = { ...profile.options, ...data.options };
	}
	if (data.settings !== undefined) {
		profile.settings = normalizeSettings(data.settings, profile.target);
	}
	const committed = commitBuildConfiguration(scene, configuration, data.expectedRevision);
	return { configuration: committed, profile: structuredClone(profile) };
}

/** Duplicates one complete profile under a new stable id and unique name. */
export function duplicateBuildProfile(scene: Scene, data: any): any {
	const configuration = getBuildConfiguration(scene);
	assertBuildRevision(configuration, data.expectedRevision);
	const source = findBuildProfileInConfiguration(configuration, data);
	const profile = structuredClone(source);
	profile.id = data.newId ?? Tools.RandomId();
	profile.name = data.newName;
	configuration.profiles.push(profile);
	const committed = commitBuildConfiguration(scene, configuration, data.expectedRevision);
	return { configuration: committed, profile };
}

/** Selects the default profile used by Build/Build & Run UI and external clients. */
export function setActiveBuildProfile(scene: Scene, data: any): IBuildPipelineConfiguration {
	const configuration = getBuildConfiguration(scene);
	assertBuildRevision(configuration, data.expectedRevision);
	configuration.activeProfileId = findBuildProfileInConfiguration(configuration, data).id;
	return commitBuildConfiguration(scene, configuration, data.expectedRevision);
}

/** Gets the non-secret environment variables injected into this profile's build scripts. */
export function getBuildProfileEnvironment(scene: Scene, data: any, options: IMCPActionOptions): any {
	const projectPath = options.editor.state.projectPath;
	if (!projectPath) {
		throw new Error("No project is currently open.");
	}
	const profile = findBuildProfile(scene, data);
	return {
		configurationRevision: getBuildConfiguration(scene).revision,
		profile: profile.name,
		profileId: profile.id,
		target: profile.target,
		environment: getBuildEnvironment(profile, dirname(projectPath), options.editor.state.sceneBuildSettings, options.editor.state.projectSettings),
	};
}

/** Reads one Android profile's portable native-LTO and initialization-marker generation plan. */
export function getAndroidBuildProfilePlan(scene: Scene, data: any): object {
	const configuration = getBuildConfiguration(scene);
	const profile = findBuildProfileInConfiguration(configuration, data);
	if (profile.target !== "android") {
		throw new Error(`Build profile "${profile.name}" targets ${profile.target}; an Android profile is required.`);
	}
	return {
		configurationRevision: configuration.revision,
		profile: { id: profile.id, name: profile.name, enabled: profile.enabled },
		plan: androidBuildProfilePlan(profile.settings.android),
	};
}

/** Reads one Headless profile's public-toolchain Linux ARM64 source-build plan. */
export function getLinuxArm64ServerSourceBuildPlan(scene: Scene, data: any): object {
	const configuration = getBuildConfiguration(scene);
	const profile = findBuildProfileInConfiguration(configuration, data);
	return {
		configurationRevision: configuration.revision,
		profile: { id: profile.id, name: profile.name, enabled: profile.enabled },
		plan: linuxArm64ServerSourceBuildPlan(profile),
	};
}

/** Verifies the exact generated Linux ARM64 source package, hashes, target metadata, and Node syntax. */
export async function verifyLinuxArm64ServerSourceBuild(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const configuration = getBuildConfiguration(scene);
	assertBuildRevision(configuration, data.expectedRevision);
	const profile = findBuildProfileInConfiguration(configuration, data);
	const plan = linuxArm64ServerSourceBuildPlan(profile);
	if (data.expectedPlanFingerprint !== plan.planFingerprint) {
		throw new Error(`Stale Linux ARM64 server source-build plan fingerprint. Current fingerprint is ${plan.planFingerprint}.`);
	}
	const projectPath = options.editor.state.projectPath;
	if (!projectPath) {
		throw new Error("No project is currently open.");
	}
	const output = outputDirectory(projectPath, profile);
	const descriptorPath = join(output.outputPath, "zvibe-linux-arm64-source-build.json");
	if (!(await pathExists(descriptorPath))) {
		return {
			configurationRevision: configuration.revision,
			profileId: profile.id,
			planFingerprint: plan.planFingerprint,
			outputDirectory: output.relativePath,
			built: false,
			valid: false,
			errors: ["Build this exact Headless profile to generate the Linux ARM64 source package."],
		};
	}
	const descriptorDetails = await lstat(descriptorPath);
	if (!descriptorDetails.isFile() || descriptorDetails.isSymbolicLink() || descriptorDetails.size > 64 * 1024) {
		throw new Error("Linux ARM64 source-build descriptor must be a regular JSON file of at most 64 KiB.");
	}
	const descriptor = await readJSON(descriptorPath);
	const allowedArtifacts = new Set<string>(plan.artifacts);
	if (
		!descriptor ||
		typeof descriptor !== "object" ||
		Array.isArray(descriptor) ||
		Object.keys(descriptor).some(
			(key) =>
				!["version", "backend", "profileId", "planFingerprint", "generatedAt", "target", "publicToolchain", "artifacts", "nativeDependencies", "boundary"].includes(key)
		) ||
		descriptor?.version !== 1 ||
		descriptor.backend !== plan.backend ||
		descriptor.profileId !== profile.id ||
		descriptor.planFingerprint !== plan.planFingerprint ||
		typeof descriptor.generatedAt !== "string" ||
		Number.isNaN(Date.parse(descriptor.generatedAt)) ||
		descriptor.target?.operatingSystem !== "linux" ||
		descriptor.target?.architecture !== "arm64" ||
		descriptor.target?.sourceBuild !== true ||
		Object.keys(descriptor.target ?? {}).some((key) => !["operatingSystem", "architecture", "sourceBuild"].includes(key)) ||
		Object.keys(descriptor.publicToolchain ?? {}).some((key) => !["nodeMajor", "language", "moduleFormat", "packageManager", "containerPlatform"].includes(key)) ||
		descriptor.publicToolchain?.nodeMajor !== 22 ||
		descriptor.publicToolchain?.language !== "JavaScript/TypeScript" ||
		descriptor.publicToolchain?.moduleFormat !== "esm" ||
		descriptor.publicToolchain?.packageManager !== "npm-compatible" ||
		descriptor.publicToolchain?.containerPlatform !== "linux/arm64" ||
		descriptor.nativeDependencies !== plan.nativeDependencies ||
		descriptor.boundary !== plan.boundary ||
		!Array.isArray(descriptor.artifacts) ||
		descriptor.artifacts.length !== allowedArtifacts.size
	) {
		throw new Error("Linux ARM64 source-build descriptor is malformed, stale, or belongs to another Build Profile.");
	}
	const errors: string[] = [];
	const verifiedArtifacts: any[] = [];
	const seen = new Set<string>();
	for (const artifact of descriptor.artifacts) {
		if (
			!artifact ||
			typeof artifact !== "object" ||
			Array.isArray(artifact) ||
			Object.keys(artifact).some((key) => !["path", "sizeBytes", "sha256"].includes(key)) ||
			!allowedArtifacts.has(artifact.path) ||
			seen.has(artifact.path) ||
			!Number.isSafeInteger(artifact.sizeBytes) ||
			artifact.sizeBytes < 0 ||
			artifact.sizeBytes > 64 * 1024 * 1024 ||
			!/^([a-f0-9]{64})$/.test(artifact.sha256 ?? "")
		) {
			throw new Error("Linux ARM64 source-build descriptor contains an invalid artifact record.");
		}
		seen.add(artifact.path);
		const artifactPath = join(output.outputPath, artifact.path);
		if (!(await pathExists(artifactPath))) {
			errors.push(`Missing generated artifact: ${artifact.path}`);
			continue;
		}
		const details = await lstat(artifactPath);
		if (!details.isFile() || details.isSymbolicLink() || details.size > 64 * 1024 * 1024) {
			errors.push(`Generated artifact is not a bounded regular file: ${artifact.path}`);
			continue;
		}
		const bytes = await readFile(artifactPath);
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const matches = bytes.byteLength === artifact.sizeBytes && sha256 === artifact.sha256;
		if (!matches) {
			errors.push(`Generated artifact changed after the source build: ${artifact.path}`);
		}
		verifiedArtifacts.push({ path: artifact.path, sizeBytes: bytes.byteLength, sha256, matches });
	}
	for (const path of allowedArtifacts) {
		if (!seen.has(path)) {
			throw new Error(`Linux ARM64 source-build descriptor is missing artifact evidence for ${path}.`);
		}
	}
	const runtimePackage = await readJSON(join(output.outputPath, "package.json"));
	if (
		runtimePackage?.os?.length !== 1 ||
		runtimePackage.os[0] !== "linux" ||
		runtimePackage?.cpu?.length !== 1 ||
		runtimePackage.cpu[0] !== "arm64" ||
		runtimePackage.type !== "module" ||
		runtimePackage.engines?.node !== ">=22 <23" ||
		runtimePackage.scripts?.start !== "node server.mjs" ||
		runtimePackage.scripts?.check !== "node --check server.mjs"
	) {
		errors.push("Generated package.json does not restrict the runtime package to Linux ARM64.");
	}
	try {
		const serverSource = await readFile(join(output.outputPath, "server.mjs"), "utf8");
		if (Buffer.byteLength(serverSource, "utf8") > 8 * 1024 * 1024) {
			throw new Error("server.mjs exceeds the 8 MiB syntax-validation limit.");
		}
		await transform(serverSource, { loader: "js", format: "esm", target: "node22", sourcefile: "server.mjs", logLevel: "silent" });
	} catch (error) {
		errors.push(`Generated server.mjs failed Node 22 ESM syntax validation: ${error instanceof Error ? error.message : String(error)}`);
	}
	return {
		configurationRevision: configuration.revision,
		profileId: profile.id,
		planFingerprint: plan.planFingerprint,
		outputDirectory: output.relativePath,
		built: true,
		valid: errors.length === 0,
		target: descriptor.target,
		publicToolchain: descriptor.publicToolchain,
		artifacts: verifiedArtifacts,
		errors,
		boundary: plan.boundary,
	};
}

/** Produces one exact, deterministic Web module-stripping and compatibility plan without running a build. */
export async function inspectWebBuildPlan(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const configuration = getBuildConfiguration(scene);
	assertBuildRevision(configuration, data.expectedRevision);
	const profile = findBuildProfileInConfiguration(configuration, data);
	if (profile.target !== "web") {
		throw new Error("Web build plans require a Web build profile.");
	}
	const projectPath = options.editor.state.projectPath;
	if (!projectPath) {
		throw new Error("No project is currently open.");
	}
	return createWebBuildPlan(dirname(projectPath), profile, configuration.revision);
}

/** Verifies a generated Web evidence manifest and current artifacts under an exact plan lease. */
export async function verifyWebBuildOutput(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const configuration = getBuildConfiguration(scene);
	assertBuildRevision(configuration, data.expectedRevision);
	const profile = findBuildProfileInConfiguration(configuration, data);
	if (profile.target !== "web") {
		throw new Error("Web build output verification requires a Web build profile.");
	}
	const projectPath = options.editor.state.projectPath;
	if (!projectPath) {
		throw new Error("No project is currently open.");
	}
	const currentPlan = await createWebBuildPlan(dirname(projectPath), profile, configuration.revision);
	if (currentPlan.planFingerprint !== data.expectedPlanFingerprint) {
		throw new Error(`Stale Web build plan fingerprint. Current fingerprint is ${currentPlan.planFingerprint}.`);
	}
	const output = outputDirectory(projectPath, profile);
	const verification = await verifyWebBuildManifest(output.outputPath, data.expectedPlanFingerprint);
	return { configurationRevision: configuration.revision, profileId: profile.id, outputDirectory: output.relativePath, ...verification };
}

/** Reads one Electron profile's normalized Linux/macOS player plan without running a build. */
export function getBuildProfilePlatformPlayerPlan(scene: Scene, data: any): any {
	const configuration = getBuildConfiguration(scene);
	const profile = findBuildProfileInConfiguration(configuration, data);
	if (profile.target !== "electron") {
		throw new Error("Platform player plans require an Electron build profile.");
	}
	const platform = profile.settings.electronPlatform ?? "darwin";
	return {
		configurationRevision: configuration.revision,
		profileId: profile.id,
		profile: profile.name,
		plan: getPlatformPlayerBuildPlan(profile.settings.platformPlayer, platform),
	};
}

/** Reads one Electron profile's exact Windows async asset-streaming plan without opening files or running a build. */
export function getBuildProfileAssetStreamingPlan(scene: Scene, data: any): any {
	const configuration = getBuildConfiguration(scene);
	const profile = findBuildProfileInConfiguration(configuration, data);
	if (profile.target !== "electron") {
		throw new Error("Asset streaming plans require an Electron build profile.");
	}
	const platform = profile.settings.electronPlatform ?? "darwin";
	return {
		configurationRevision: configuration.revision,
		profileId: profile.id,
		profile: profile.name,
		plan: getAssetStreamingBuildPlan(profile.settings.assetStreaming, platform),
	};
}

/** Generates a standards-compatible web manifest from one persisted Web build profile's PWA settings. */
export async function generatePwaManifest(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	assertBuildRevision(getBuildConfiguration(scene), data.expectedRevision);
	const profile = findBuildProfile(scene, data);
	if (profile.target !== "web") {
		throw new Error("PWA manifests can only be generated from a Web build profile.");
	}
	const projectPath = options.editor.state.projectPath;
	if (!projectPath) {
		throw new Error("No project is currently open.");
	}
	const settings = profile.settings ?? {};
	const pwa = settings.pwa ?? {};
	const output = getProjectOutputPath(projectPath, pwa.manifestPath ?? "public/manifest.webmanifest", "PWA manifestPath");
	const name = pwa.name ?? settings.productName ?? profile.name;
	const shortName = pwa.shortName ?? name;
	if (typeof name !== "string" || !name.trim() || typeof shortName !== "string" || !shortName.trim()) {
		throw new Error("PWA name and shortName must be non-empty strings.");
	}
	const display = typeof pwa.display === "string" ? pwa.display : "standalone";
	if (!["fullscreen", "standalone", "minimal-ui", "browser"].includes(display)) {
		throw new Error("PWA display must be fullscreen, standalone, minimal-ui, or browser.");
	}
	const manifest = {
		name: name.trim(),
		short_name: shortName.trim(),
		start_url: getPwaStartUrl(profile),
		display,
		background_color: pwa.backgroundColor ?? "#000000",
		theme_color: pwa.themeColor ?? "#000000",
		...(Array.isArray(pwa.icons) ? { icons: pwa.icons } : {}),
	};
	await ensureDir(dirname(output.outputPath));
	await writeJSON(output.outputPath, manifest, { spaces: "\t" });
	return { profile: profile.name, path: output.relativePath, manifest };
}

/** Generates a cache-first, offline-fallback service worker from one Web build profile's persisted PWA settings. */
export async function generatePwaServiceWorker(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	assertBuildRevision(getBuildConfiguration(scene), data.expectedRevision);
	const profile = findBuildProfile(scene, data);
	if (profile.target !== "web") {
		throw new Error("PWA service workers can only be generated from a Web build profile.");
	}
	const projectPath = options.editor.state.projectPath;
	if (!projectPath) {
		throw new Error("No project is currently open.");
	}
	const serviceWorkerPath = profile.settings?.pwa?.serviceWorkerPath ?? "public/sw.js";
	const output = getProjectOutputPath(projectPath, serviceWorkerPath, "PWA serviceWorkerPath");
	const serviceWorkerUrl = getPwaServiceWorkerWebPath(serviceWorkerPath);
	const worker = createPwaServiceWorkerSource(profile);
	await ensureDir(dirname(output.outputPath));
	await writeFile(output.outputPath, worker.source, "utf8");
	return {
		profile: profile.name,
		path: output.relativePath,
		cacheName: worker.cacheName,
		precacheUrls: worker.precacheUrls,
		registration: `navigator.serviceWorker.register(${JSON.stringify(serviceWorkerUrl)});`,
	};
}

/** Installs or updates an idempotent service-worker registration snippet in a standard root index.html web project. */
export async function installPwaServiceWorkerRegistration(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	assertBuildRevision(getBuildConfiguration(scene), data.expectedRevision);
	const profile = findBuildProfile(scene, data);
	if (profile.target !== "web") {
		throw new Error("PWA service-worker registration can only be installed for a Web build profile.");
	}
	const projectPath = options.editor.state.projectPath;
	if (!projectPath) {
		throw new Error("No project is currently open.");
	}
	const serviceWorkerPath = profile.settings?.pwa?.serviceWorkerPath ?? "public/sw.js";
	const output = getProjectOutputPath(projectPath, serviceWorkerPath, "PWA serviceWorkerPath");
	const serviceWorkerUrl = getPwaServiceWorkerWebPath(serviceWorkerPath);
	if (!(await pathExists(output.outputPath))) {
		throw new Error(`PWA service worker not found at ${output.relativePath}. Generate it before installing registration.`);
	}
	const indexPath = join(output.directory, "index.html");
	if (!(await pathExists(indexPath))) {
		throw new Error("No root index.html was found. Register the generated service worker from this framework's web entry point instead.");
	}
	const html = await readFile(indexPath, "utf8");
	const startMarker = "<!-- Babylon.js Editor PWA service worker: start -->";
	const endMarker = "<!-- Babylon.js Editor PWA service worker: end -->";
	const start = html.indexOf(startMarker);
	const end = html.indexOf(endMarker);
	if ((start === -1) !== (end === -1)) {
		throw new Error("The existing PWA registration markers are incomplete. Restore or remove both markers before installing registration.");
	}
	const snippet = getPwaServiceWorkerRegistrationSnippet(serviceWorkerUrl);
	let updated: string;
	if (start !== -1 && end !== -1) {
		updated = `${html.slice(0, start)}${snippet}${html.slice(end + endMarker.length)}`;
	} else {
		const bodyEnd = html.toLowerCase().lastIndexOf("</body>");
		if (bodyEnd === -1) {
			throw new Error("Root index.html has no closing </body> tag. Register the generated worker manually from the web entry point.");
		}
		updated = `${html.slice(0, bodyEnd)}\n\t${snippet}\n${html.slice(bodyEnd)}`;
	}
	const changed = updated !== html;
	if (changed) {
		await writeFile(indexPath, updated, "utf8");
	}
	return { profile: profile.name, path: "index.html", serviceWorkerUrl, changed };
}
/** Deletes a persisted export profile without touching generated output. */
export function deleteBuildProfile(scene: Scene, data: any): any {
	const configuration = getBuildConfiguration(scene);
	assertBuildRevision(configuration, data.expectedRevision);
	const target = findBuildProfileInConfiguration(configuration, data);
	const index = configuration.profiles.findIndex((profile) => profile.id === target.id);
	configuration.profiles.splice(index, 1);
	if (configuration.activeProfileId === target.id) {
		configuration.activeProfileId = configuration.profiles[0]?.id;
	}
	return { deleted: true, id: target.id, name: target.name, configuration: commitBuildConfiguration(scene, configuration, data.expectedRevision) };
}
/** Runs the existing export pipeline with a named profile's options. */
export async function runBuildProfile(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.background === true) {
		return startBuildProfileJob(scene, "export", data, () => runBuildProfile(scene, { ...data, background: false }, options));
	}
	let profile: IBuildProfile | undefined;
	const stages: IBuildStageReport[] = [];
	try {
		const configuration = getBuildConfiguration(scene);
		assertBuildRevision(configuration, data.expectedRevision);
		profile = findBuildProfile(scene, data);
		const started = Date.now();
		const exported = await exportProject(options.editor, {
			...profile.options,
			modelPlatform: normalizeModelImporterPlatform(profile.target),
			assetPlatform: normalizeModelImporterPlatform(profile.target),
			noDialog: true,
			noProgress: true,
			throwOnError: true,
		});
		if (!exported) {
			throw new Error("Project export failed. Check the editor console for details.");
		}
		stages.push(buildStage("export", started, "passed"));
		const report = await getExportReport(scene, data, options);
		return {
			profile: structuredClone(profile),
			...report,
			buildReport: recordBuildReport(scene, {
				profileId: profile.id,
				profile: profile.name,
				target: profile.target,
				outcome: "exported",
				stages,
				output: report.output,
				exportDirectory: report.exportDirectory,
			}),
		};
	} catch (error: any) {
		if (!stages.length || stages.at(-1)?.status !== "failed") {
			stages.push(buildStage("export", Date.now(), "failed"));
		}
		recordBuildReport(scene, { profileId: profile?.id, profile: profile?.name ?? data.name, target: profile?.target, outcome: "failed", stages, error: error.message });
		throw error;
	}
}

/** Checks whether the selected target has the scripts required for a full application build. */
export async function validateBuildProfile(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	return getBuildProfileValidation(scene, data, options);
}

function buildStage(name: IBuildStageReport["name"], started: number, status: IBuildStageReport["status"], details: Partial<IBuildStageReport> = {}): IBuildStageReport {
	const completed = Date.now();
	return { name, status, startedAt: new Date(started).toISOString(), completedAt: new Date(completed).toISOString(), durationMs: Math.max(0, completed - started), ...details };
}

function cleanOutputTail(value: string): string {
	let result = "";
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code === 27 && value[index + 1] === "[") {
			index += 2;
			while (index < value.length && (value.charCodeAt(index) < 64 || value.charCodeAt(index) > 126)) {
				index++;
			}
			continue;
		}
		if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
			continue;
		}
		result += value[index];
	}
	return result.slice(-32_768);
}

async function executeBuildCommand(name: "pre-build" | "build" | "post-build", command: string, cwd: string, environment: Record<string, string>): Promise<IBuildStageReport> {
	const started = Date.now();
	let outputTail = "";
	const buildProcess = await execNodePty(command, { cwd, env: { ...process.env, ...environment } });
	const observer = buildProcess.onGetDataObservable.add((value) => {
		outputTail = cleanOutputTail(`${outputTail}${value}`);
	});
	const exitCode = await buildProcess.wait();
	buildProcess.onGetDataObservable.remove(observer);
	return buildStage(name, started, exitCode === 0 ? "passed" : "failed", { command, exitCode, outputTail });
}

function outputDirectory(projectPath: string, profile: IBuildProfile): { directory: string; outputPath: string; relativePath: string } {
	const output = getProjectOutputPath(projectPath, profile.settings.outputDirectory, "Build outputDirectory");
	if (["assets", "src", "public", ".bjseditor"].some((entry) => output.relativePath === entry || output.relativePath.startsWith(`${entry}/`))) {
		throw new Error("Build outputDirectory cannot overwrite source, assets, public export source, or editor metadata.");
	}
	return output;
}

/** Exports the active scene, then runs the project's target build scripts in its package-manager environment. */
export async function buildBuildProfile(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.background === true) {
		return startBuildProfileJob(scene, "build", data, () => buildBuildProfile(scene, { ...data, background: false }, options));
	}
	let profile: IBuildProfile | undefined;
	let commands: string[] = [];
	const stages: IBuildStageReport[] = [];
	let inputFingerprint: any;
	let webBuildPlan: any = null;
	let webBuildToolchain: any = null;
	try {
		const configuration = getBuildConfiguration(scene);
		assertBuildRevision(configuration, data.expectedRevision);
		const validationStarted = Date.now();
		const validation = await getBuildProfileValidation(scene, data, options);
		const activeProfile = validation.profile as IBuildProfile;
		profile = activeProfile;
		commands = validation.commands;
		stages.push(buildStage("validation", validationStarted, validation.valid ? "passed" : "failed"));
		if (!validation.valid) {
			throw new Error(`Build profile cannot run: ${validation.reasons.join(" ")}`);
		}
		const projectPath = options.editor.state.projectPath!;
		const projectDirectory = dirname(projectPath);
		const output = outputDirectory(projectPath, activeProfile);
		if (activeProfile.target === "web") {
			webBuildPlan = await createWebBuildPlan(projectDirectory, activeProfile, configuration.revision);
			webBuildToolchain = await probeWebBuildToolchain(activeProfile.settings.web!);
			if (!webBuildToolchain.verified) {
				throw new Error(`Web build toolchain verification failed: ${webBuildToolchain.reason}`);
			}
		}
		inputFingerprint = await getBuildInputFingerprint(
			projectDirectory,
			projectPath,
			activeProfile,
			options.editor.state.sceneBuildSettings,
			options.editor.state.projectSettings
		);
		if (activeProfile.settings.incremental && !activeProfile.settings.cleanBuild && data.force !== true) {
			const previous = getBuildReports(scene).find(
				(report) =>
					["built", "cached"].includes(report.outcome) &&
					report.profileId === activeProfile.id &&
					report.inputFingerprint?.sha256 === inputFingerprint.sha256 &&
					report.output?.completeArtifactHashes === true
			);
			if (previous && (await pathExists(output.outputPath))) {
				const currentOutput = await getExportOutputStatistics(output.outputPath);
				const webBuildEvidence = webBuildPlan ? await verifyWebBuildManifest(output.outputPath, webBuildPlan.planFingerprint).catch(() => null) : null;
				if (currentOutput.completeArtifactHashes && currentOutput.outputFingerprint === previous.output.outputFingerprint && (!webBuildPlan || webBuildEvidence?.valid)) {
					const developmentCoverage = await readDevelopmentCoverageManifest(projectDirectory, activeProfile, { limit: 1 });
					const report = recordBuildReport(scene, {
						profileId: activeProfile.id,
						profile: activeProfile.name,
						target: activeProfile.target,
						outcome: "cached",
						cacheHit: true,
						cachedFromReportId: previous.id,
						inputFingerprint,
						stages: [...stages, buildStage("clean", Date.now(), "skipped"), buildStage("export", Date.now(), "skipped"), buildStage("build", Date.now(), "skipped")],
						commands,
						warnings: validation.warnings,
						output: currentOutput,
						developmentCoverage,
						webBuildEvidence,
					});
					return { ...validation, built: false, cacheHit: true, inputFingerprint, output: currentOutput, developmentCoverage, webBuildEvidence, buildReport: report };
				}
			}
		}
		if (activeProfile.settings.cleanBuild && (await pathExists(output.outputPath))) {
			const started = Date.now();
			await remove(output.outputPath);
			stages.push(buildStage("clean", started, "passed"));
		} else {
			stages.push(buildStage("clean", Date.now(), "skipped"));
		}
		const exportStarted = Date.now();
		const exported = await exportProject(options.editor, {
			...activeProfile.options,
			modelPlatform: normalizeModelImporterPlatform(activeProfile.target),
			assetPlatform: normalizeModelImporterPlatform(activeProfile.target),
			noDialog: true,
			noProgress: true,
			throwOnError: true,
		});
		if (!exported) {
			stages.push(buildStage("export", exportStarted, "failed"));
			throw new Error("Project export failed. Check the editor console for details.");
		}
		stages.push(buildStage("export", exportStarted, "passed"));
		if (activeProfile.target === "web") {
			// Export may normalize public/scene content, so the package scripts and
			// generated manifest must lease the post-export project state.
			webBuildPlan = await createWebBuildPlan(projectDirectory, activeProfile, configuration.revision);
		}
		const environment = {
			...getBuildEnvironment(activeProfile, projectDirectory, options.editor.state.sceneBuildSettings, options.editor.state.projectSettings),
			...resolveSigningEnvironment(activeProfile),
		};
		if (webBuildPlan) {
			environment.BJS_EDITOR_WEB_BUILD_PLAN = JSON.stringify({
				version: webBuildPlan.version,
				profileId: webBuildPlan.profileId,
				planFingerprint: webBuildPlan.planFingerprint,
				settings: webBuildPlan.settings,
				modules: webBuildPlan.modules.map((entry: any) => ({ id: entry.id, decision: entry.decision })),
			});
			environment.BJS_EDITOR_WEB_BUILD_PLAN_FINGERPRINT = webBuildPlan.planFingerprint;
		}
		if (activeProfile.settings.codeCoverage) {
			await remove(developmentCoverageManifestPath(projectDirectory, activeProfile));
		}
		for (const stage of validation.stages as Array<{ name: "pre-build" | "build" | "post-build"; commands: string[] }>) {
			for (const command of stage.commands) {
				const result = await executeBuildCommand(stage.name, command, projectDirectory, environment);
				stages.push(result);
				if (result.status === "failed") {
					throw new Error(`Target ${stage.name} command failed with code ${result.exitCode}: ${command}`);
				}
			}
		}
		// Export/import processing can normalize authored importer metadata. Persist the
		// post-build fingerprint so the next unchanged build can produce a real cache hit.
		const resolvedPlayerSettings = resolveProjectSettingsForTarget(normalizeProjectSettings(options.editor.state.projectSettings), activeProfile.target);
		await writeJSON(
			join(output.outputPath, "zvibe-player-settings.json"),
			{
				...resolvedPlayerSettings,
				buildTarget: activeProfile.target,
				buildProfileId: activeProfile.id,
				...(activeProfile.settings.platformPlayer ? { platformPlayer: activeProfile.settings.platformPlayer } : {}),
			},
			{ spaces: "\t" }
		);
		const webBuildEvidence = webBuildPlan ? await writeWebBuildManifest(output.outputPath, webBuildPlan, webBuildToolchain) : null;
		if (webBuildEvidence && !webBuildEvidence.output.valid) {
			throw new Error(`Web build output verification failed: ${webBuildEvidence.output.reasons.join(" ")}`);
		}
		inputFingerprint = await getBuildInputFingerprint(
			projectDirectory,
			projectPath,
			activeProfile,
			options.editor.state.sceneBuildSettings,
			options.editor.state.projectSettings
		);
		const targetOutput = await getExportOutputStatistics(output.outputPath);
		if (!targetOutput.fileCount) {
			throw new Error(`Target build completed without artifacts in ${output.relativePath}. Make the package script honor BJS_EDITOR_OUTPUT_DIRECTORY or update the profile.`);
		}
		const exportReport = await getExportReport(scene, data, options);
		const developmentCoverage = await readDevelopmentCoverageManifest(projectDirectory, activeProfile, { limit: 1 });
		if (activeProfile.settings.codeCoverage && !developmentCoverage.manifest) {
			throw new Error("Development coverage was enabled, but the project build did not run the Zvibe coverage plugin or publish its exact manifest.");
		}
		const safeEnvironment = getBuildEnvironment(activeProfile, projectDirectory, options.editor.state.sceneBuildSettings, options.editor.state.projectSettings);
		const report = recordBuildReport(scene, {
			profileId: activeProfile.id,
			profile: activeProfile.name,
			target: activeProfile.target,
			outcome: "built",
			cacheHit: false,
			inputFingerprint,
			stages,
			commands,
			warnings: validation.warnings,
			output: targetOutput,
			exportOutput: exportReport.output,
			developmentCoverage,
			webBuildEvidence,
		});
		return {
			...validation,
			built: true,
			cacheHit: false,
			inputFingerprint,
			buildEnvironment: safeEnvironment,
			output: targetOutput,
			exportOutput: exportReport.output,
			developmentCoverage,
			webBuildEvidence,
			buildReport: report,
		};
	} catch (error: any) {
		const last = stages.at(-1);
		if (!last || last.status !== "failed") {
			stages.push(buildStage("build", Date.now(), "failed"));
		}
		recordBuildReport(scene, {
			profileId: profile?.id,
			profile: profile?.name ?? data.name,
			target: profile?.target,
			outcome: "failed",
			inputFingerprint,
			stages,
			commands,
			error: error.message,
		});
		throw error;
	}
}

async function getExportOutputStatistics(directory: string): Promise<{
	fileCount: number;
	totalBytes: number;
	extensions: Record<string, { files: number; bytes: number }>;
	artifacts: IBuildArtifactReport[];
	outputFingerprint: string;
	completeArtifactHashes: boolean;
}> {
	const statistics = { fileCount: 0, totalBytes: 0, extensions: {} as Record<string, { files: number; bytes: number }>, artifacts: [] as IBuildArtifactReport[] };
	let hashedBytes = 0;
	let completeArtifactHashes = true;
	const visit = async (path: string): Promise<void> => {
		for (const name of (await readdir(path)).sort()) {
			const child = join(path, name);
			const details = await lstat(child);
			if (details.isSymbolicLink()) {
				completeArtifactHashes = false;
				continue;
			}
			if (details.isDirectory()) {
				await visit(child);
				continue;
			}
			statistics.fileCount++;
			statistics.totalBytes += details.size;
			const extension = name.includes(".") ? `.${name.split(".").pop()!.toLowerCase()}` : "[no extension]";
			const entry = (statistics.extensions[extension] ??= { files: 0, bytes: 0 });
			entry.files++;
			entry.bytes += details.size;
			if (statistics.artifacts.length < 8192 && hashedBytes + details.size <= 2 * 1024 * 1024 * 1024) {
				const bytes = await readFile(child);
				hashedBytes += bytes.byteLength;
				statistics.artifacts.push({ path: relative(directory, child), sizeBytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
			} else {
				completeArtifactHashes = false;
			}
		}
	};
	if (await pathExists(directory)) {
		await visit(directory);
	}
	const outputFingerprint = createHash("sha256").update(JSON.stringify(statistics.artifacts)).digest("hex");
	return { ...statistics, outputFingerprint, completeArtifactHashes };
}

async function getBuildInputFingerprint(
	projectDirectory: string,
	projectPath: string,
	profile: IBuildProfile,
	sceneBuildSettings: unknown,
	projectSettings?: unknown
): Promise<object> {
	const hash = createHash("sha256");
	hash.update(JSON.stringify({ profile, sceneBuildSettings, projectSettings: normalizeProjectSettings(projectSettings) }));
	let fileCount = 0;
	let totalBytes = 0;
	const roots = [
		projectPath,
		join(projectDirectory, "package.json"),
		join(projectDirectory, "yarn.lock"),
		join(projectDirectory, "package-lock.json"),
		join(projectDirectory, "pnpm-lock.yaml"),
		join(projectDirectory, "bun.lock"),
		join(projectDirectory, "src"),
		join(projectDirectory, "assets"),
	];
	const visit = async (path: string): Promise<void> => {
		if (!(await pathExists(path))) {
			return;
		}
		const details = await lstat(path);
		if (details.isSymbolicLink()) {
			throw new Error(`Build input fingerprint does not follow symbolic links: ${relative(projectDirectory, path)}`);
		}
		if (details.isDirectory()) {
			for (const name of (await readdir(path)).sort()) {
				await visit(join(path, name));
			}
			return;
		}
		fileCount++;
		totalBytes += details.size;
		if (fileCount > 16_384 || totalBytes > 2 * 1024 * 1024 * 1024) {
			throw new Error("Build input fingerprint exceeds 16,384 files or 2 GiB; split generated content from src/assets before building.");
		}
		const relativePath = relative(projectDirectory, path).replaceAll("\\", "/");
		hash.update(relativePath);
		hash.update("\0");
		hash.update(await readFile(path));
		hash.update("\0");
	};
	for (const root of roots) {
		await visit(root);
	}
	return { sha256: hash.digest("hex"), fileCount, totalBytes, model: "bounded-project-content-sha256-v1" };
}

/** Deletes only one validated project-local target output directory. */
export async function cleanBuildProfileOutput(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("Cleaning build output requires confirm=true.");
	}
	const configuration = getBuildConfiguration(scene);
	assertBuildRevision(configuration, data.expectedRevision);
	const profile = findBuildProfile(scene, data);
	const projectPath = options.editor.state.projectPath;
	if (!projectPath) {
		throw new Error("No project is currently open.");
	}
	const output = outputDirectory(projectPath, profile);
	const before = await getExportOutputStatistics(output.outputPath);
	const started = Date.now();
	await remove(output.outputPath);
	const report = recordBuildReport(scene, {
		profileId: profile.id,
		profile: profile.name,
		target: profile.target,
		outcome: "cleaned",
		stages: [buildStage("clean", started, "passed")],
		removedOutput: { path: output.relativePath, fileCount: before.fileCount, totalBytes: before.totalBytes, outputFingerprint: before.outputFingerprint },
	});
	return { cleaned: true, profileId: profile.id, outputDirectory: output.relativePath, removedFileCount: before.fileCount, removedBytes: before.totalBytes, buildReport: report };
}

function runs(scene: Scene): Map<string, IActiveBuildRun> {
	let result = activeBuildRuns.get(scene);
	if (!result) {
		result = new Map();
		activeBuildRuns.set(scene, result);
	}
	return result;
}

/** Builds a target and launches its explicitly configured package run script. */
export async function buildAndRunBuildProfile(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.background === true) {
		return startBuildProfileJob(scene, "build-and-run", data, () => buildAndRunBuildProfile(scene, { ...data, background: false }, options));
	}
	const configuration = getBuildConfiguration(scene);
	assertBuildRevision(configuration, data.expectedRevision);
	const profile = findBuildProfile(scene, data);
	const runScript = profile.settings.runScript;
	if (!runScript) {
		throw new Error(`Build profile "${profile.name}" has no runScript. Configure an existing package.json script before Build & Run.`);
	}
	const projectPath = options.editor.state.projectPath;
	if (!projectPath) {
		throw new Error("No project is currently open.");
	}
	const packageJson = await readJSON(join(dirname(projectPath), "package.json"));
	if (typeof packageJson.scripts?.[runScript] !== "string") {
		throw new Error(`Build & Run package script was not found: ${runScript}`);
	}
	const build = await buildBuildProfile(scene, data, options);
	const existing = [...runs(scene).values()].find((candidate) => candidate.profileId === profile.id && ["running", "stopping"].includes(candidate.status));
	if (existing) {
		throw new Error(`Build profile "${profile.name}" already has an active run: ${existing.id}`);
	}
	const packageManager = options.editor.state.packageManager ?? "yarn";
	const command = `${packageManager === "bun" ? "bun run" : `${packageManager} run`} ${runScript}`;
	const childEnvironment = {
		...process.env,
		...getBuildEnvironment(profile, dirname(projectPath), options.editor.state.sceneBuildSettings, options.editor.state.projectSettings),
	};
	const processInstance = await execNodePty(command, { cwd: dirname(projectPath), env: childEnvironment });
	const run: IActiveBuildRun = {
		id: processInstance.id,
		profileId: profile.id,
		profile: profile.name,
		target: profile.target,
		command,
		startedAt: new Date().toISOString(),
		status: "running",
		outputTail: "",
		process: processInstance,
	};
	runs(scene).set(run.id, run);
	if (runs(scene).size > 64) {
		for (const candidate of runs(scene).values()) {
			if (candidate.status === "exited") {
				runs(scene).delete(candidate.id);
				if (runs(scene).size <= 64) {
					break;
				}
			}
		}
	}
	const observer = processInstance.onGetDataObservable.add((value) => {
		run.outputTail = cleanOutputTail(`${run.outputTail}${value}`);
	});
	void processInstance.wait().then((exitCode) => {
		processInstance.onGetDataObservable.remove(observer);
		run.status = "exited";
		run.exitCode = exitCode;
	});
	return { build, run: { id: run.id, profileId: run.profileId, profile: run.profile, target: run.target, command: run.command, startedAt: run.startedAt, status: run.status } };
}

/** Stops one transient Build & Run child process. */
export async function stopBuildProfileRun(scene: Scene, data: { runId: string; confirm: boolean }): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("Stopping a build run requires confirm=true.");
	}
	const run = runs(scene).get(data.runId);
	if (!run) {
		throw new Error(`Build run was not found: ${data.runId}`);
	}
	if (run.status === "exited") {
		const status = buildRunStatus(run);
		runs(scene).delete(run.id);
		return { stopped: false, reason: "already-exited", run: status, dismissed: true };
	}
	run.status = "stopping";
	run.process.kill();
	await run.process.wait();
	const status = buildRunStatus(run);
	runs(scene).delete(run.id);
	return { stopped: true, run: status, dismissed: true };
}

function buildRunStatus(run: IActiveBuildRun): object {
	return {
		id: run.id,
		profileId: run.profileId,
		profile: run.profile,
		target: run.target,
		command: run.command,
		startedAt: run.startedAt,
		status: run.status,
		exitCode: run.exitCode,
		outputTail: run.outputTail,
	};
}

function jobs(scene: Scene): Map<string, IBuildProfileJob> {
	let result = buildProfileJobs.get(scene);
	if (!result) {
		result = new Map();
		buildProfileJobs.set(scene, result);
	}
	return result;
}

function publicBuildProfileJob(job: IBuildProfileJob, includeResult: boolean): object {
	const startedAt = job.startedAt ? Date.parse(job.startedAt) : null;
	const completedAt = job.completedAt ? Date.parse(job.completedAt) : null;
	return {
		id: job.id,
		operation: job.operation,
		profileId: job.profileId,
		profile: job.profile,
		target: job.target,
		expectedRevision: job.expectedRevision,
		status: job.status,
		createdAt: job.createdAt,
		startedAt: job.startedAt ?? null,
		completedAt: job.completedAt ?? null,
		durationMs: startedAt === null ? 0 : Math.max(0, (completedAt ?? Date.now()) - startedAt),
		error: job.error ?? null,
		...(includeResult && job.status === "succeeded" ? { result: job.result } : {}),
	};
}

function startBuildProfileJob(scene: Scene, operation: BuildProfileJobOperation, data: any, execute: () => Promise<any>): object {
	const configuration = getBuildConfiguration(scene);
	assertBuildRevision(configuration, data.expectedRevision);
	const profile = findBuildProfile(scene, data);
	const store = jobs(scene);
	const active = [...store.values()].find((job) => job.status === "queued" || job.status === "running");
	if (active) {
		throw new Error(`Build Pipeline job ${active.id} is already ${active.status}; wait for it to finish before starting another build operation.`);
	}
	for (const candidate of [...store.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(31)) {
		if (candidate.status === "succeeded" || candidate.status === "failed") {
			store.delete(candidate.id);
		}
	}
	const job: IBuildProfileJob = {
		id: `build-job-${randomBytes(12).toString("hex")}`,
		operation,
		profileId: profile.id,
		profile: profile.name,
		target: profile.target,
		expectedRevision: data.expectedRevision,
		status: "queued",
		createdAt: new Date().toISOString(),
	};
	store.set(job.id, job);
	setTimeout(() => {
		job.status = "running";
		job.startedAt = new Date().toISOString();
		void execute()
			.then((result) => {
				job.result = result;
				job.status = "succeeded";
				job.completedAt = new Date().toISOString();
			})
			.catch((error: unknown) => {
				job.error = error instanceof Error ? error.message : String(error);
				job.status = "failed";
				job.completedAt = new Date().toISOString();
			});
	}, 0);
	return { accepted: true, job: publicBuildProfileJob(job, false) };
}

/** Reads bounded transient Build & Run and non-blocking Build Profile job state without exposing process handles. */
export function getBuildPipelineStatus(scene: Scene, data: { jobId?: string; includeResult?: boolean } = {}): object {
	const values = [...runs(scene).values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt)).slice(0, 32);
	const buildJobs = [...jobs(scene).values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 32);
	const exactJob = data.jobId ? buildJobs.find((job) => job.id === data.jobId) : undefined;
	if (data.jobId && !exactJob) {
		throw new Error(`Build Pipeline job was not found: ${data.jobId}`);
	}
	return {
		configurationRevision: getBuildConfiguration(scene).revision,
		activeProfileId: getBuildConfiguration(scene).activeProfileId,
		runs: values.map(buildRunStatus),
		jobs: data.jobId ? [publicBuildProfileJob(exactJob!, data.includeResult === true)] : buildJobs.map((job) => publicBuildProfileJob(job, false)),
	};
}

export async function getExportReport(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const projectDirectory = getProjectAssetsRootUrl();
	if (!projectDirectory) {
		throw new Error("No project is currently open.");
	}

	const exportDirectory = join(projectDirectory, "public/scene");
	const exists = await pathExists(exportDirectory);
	const modified = exists ? (await stat(exportDirectory)).mtime.toISOString() : null;
	const output = await getExportOutputStatistics(exportDirectory);

	return {
		profile: data?.id || data?.name ? structuredClone(findBuildProfile(scene, data)) : null,
		projectPath: options.editor.state.projectPath,
		activeScenePath: options.editor.state.lastOpenedScenePath,
		exportDirectory,
		exists,
		modified,
		output,
	};
}

export async function exportActiveScene(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	try {
		const exported = await exportProject(options.editor, {
			optimize: data.optimize ?? true,
			noDialog: true,
			noProgress: true,
			throwOnError: true,
		});
		if (!exported) {
			throw new Error("Project export failed. Check the editor console for details.");
		}

		const report = await getExportReport(_scene, data, options);
		return { ...report, buildReport: recordBuildReport(_scene, { ...report, outcome: "exported" }) };
	} catch (error: any) {
		recordBuildReport(_scene, { outcome: "failed", error: error.message });
		throw error;
	}
}
