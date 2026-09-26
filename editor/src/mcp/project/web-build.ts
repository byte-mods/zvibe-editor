import { execFile } from "child_process";
import { createHash } from "crypto";
import { createReadStream } from "fs";
import { lstat, pathExists, readFile, readdir, realpath, writeJSON } from "fs-extra";
import { join, relative } from "path/posix";
import { promisify } from "util";

export const WEB_BUILD_EVIDENCE_VERSION = 1 as const;
export const CURRENT_EMSCRIPTEN_VERSION = "4.0.19" as const;
export const WEB_BUILD_MANIFEST = "zvibe-web-build-manifest.json" as const;

export type WebBuildEmscriptenToolchain = "typescript-bundler" | "external-4.0.19";

export interface IWebBuildEvidenceSettings {
	moduleStripping: boolean;
	webAssembly2023: boolean;
	emscriptenToolchain: WebBuildEmscriptenToolchain;
	emscriptenExecutable: string;
}

export interface IWebBuildProfileDescriptor {
	id: string;
	settings: { web?: IWebBuildEvidenceSettings };
}

export interface IWebBuildModuleDecision {
	id: string;
	label: string;
	decision: "retain" | "strip" | "preserve";
	reason: string;
	evidencePaths: string[];
	markers: string[];
}

export interface IWebBuildPlan {
	version: typeof WEB_BUILD_EVIDENCE_VERSION;
	backend: "zvibe-web-module-stripping-v1";
	configurationRevision: number;
	profileId: string;
	planFingerprint: string;
	settings: IWebBuildEvidenceSettings;
	source: { fingerprint: string; fileCount: number; totalBytes: number; complete: true };
	/** The editor runtime package the project imports to load scenes, when present. Its reachable code constrains module stripping. */
	runtime?: { package: string; fingerprint: string; fileCount: number; totalBytes: number };
	modules: IWebBuildModuleDecision[];
	images: {
		png: { files: number; bytes: number; paths: string[] };
		jpeg: { files: number; bytes: number; paths: string[] };
		decoderBoundary: "browser-native-no-bundled-libpng-or-libjpeg";
	};
	wasm: { files: number; bytes: number; paths: string[]; webAssembly2023: boolean };
	toolchain: IWebBuildToolchainEvidence;
	limits: { maximumFiles: number; maximumBytes: number; maximumEvidencePathsPerCategory: number };
}

export interface IWebBuildToolchainEvidence {
	selection: WebBuildEmscriptenToolchain;
	executable: string | null;
	requestedVersion: typeof CURRENT_EMSCRIPTEN_VERSION | null;
	detectedVersion: string | null;
	verified: boolean;
	boundary: string;
	reason: string;
}

interface IScannedFile {
	path: string;
	size: number;
	sha256: string;
	markers: string[];
	wasmBytes: Buffer | null;
}

const execFileAsync = promisify(execFile);
const maximumFiles = 16_384;
const maximumBytes = 2 * 1024 * 1024 * 1024;
const maximumEvidencePaths = 64;
const maximumWasmBytes = 256 * 1024 * 1024;
const textExtensions = new Set([".cjs", ".css", ".html", ".js", ".json", ".jsx", ".mjs", ".mts", ".ts", ".tsx", ".vue"]);
const modules = [
	{ id: "animation", label: "Animation", markers: ["@babylonjs/core/animations", "animationgroup", "beginanimation("] },
	{ id: "physics", label: "3D Physics", markers: ["@babylonjs/core/physics", "@babylonjs/havok", "havokplugin", "physicsaggregate"] },
	{ id: "physics-2d", label: "2D Physics", markers: ["planck-js", "matter-js", "box2d", "physics2d"] },
	{ id: "navigation", label: "Navigation", markers: ["@babylonjs/core/navigation", "recastjs", "recastjsplugin", "navmesh"] },
	{ id: "particles", label: "Particles and VFX", markers: ["@babylonjs/core/particles", "particlesystem", "nodeparticlesystem"] },
	{ id: "node-materials", label: "Node Materials", markers: ["@babylonjs/core/materials/node", "nodematerial"] },
	{ id: "gui", label: "GUI", markers: ["@babylonjs/gui", "advanceddynamictexture"] },
	{ id: "audio", label: "Audio", markers: ["@babylonjs/core/audio", "soundtrack", "new sound("] },
	{ id: "sprites", label: "Sprites", markers: ["@babylonjs/core/sprites", "spritemanager"] },
	{ id: "xr", label: "WebXR", markers: ["@babylonjs/core/xr", "webxrdefaultperience", "webxrdefaultexperience"] },
	{ id: "gltf-loaders", label: "glTF Loaders", markers: ["@babylonjs/loaders", "gltf2"] },
	{ id: "procedural-materials", label: "Procedural Materials", markers: ["@babylonjs/materials", "proceduraltexture"] },
] as const;
const nativeCodecMarkers = ["libpng", "png_create_read_struct", "png_create_write_struct", "libjpeg", "jpeg_std_error", "jpeg_create_decompress", "jpeg_create_compress"];
const markerCatalog = [...new Set([...modules.flatMap((module) => module.markers), ...nativeCodecMarkers])];
const maximumMarkerLength = Math.max(...markerCatalog.map((marker) => marker.length));

function extension(path: string): string {
	const name = path.split("/").at(-1) ?? path;
	return name.includes(".") ? `.${name.split(".").at(-1)!.toLowerCase()}` : "";
}

function stableFingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function scanFiles(root: string, paths: string[], excludedRelativePath?: string): Promise<{ files: IScannedFile[]; totalBytes: number }> {
	const files: IScannedFile[] = [];
	let totalBytes = 0;
	const visit = async (path: string): Promise<void> => {
		if (!(await pathExists(path))) {
			return;
		}
		const details = await lstat(path);
		const relativePath = relative(root, path).replaceAll("\\", "/");
		if (details.isSymbolicLink()) {
			throw new Error(`Web build evidence does not follow symbolic links: ${relativePath}`);
		}
		if (details.isDirectory()) {
			for (const name of (await readdir(path)).sort()) {
				await visit(join(path, name));
			}
			return;
		}
		if (relativePath === excludedRelativePath) {
			return;
		}
		if (files.length + 1 > maximumFiles || (totalBytes += details.size) > maximumBytes) {
			throw new Error("Web build evidence exceeds 16,384 files or 2 GiB; move generated or unrelated content outside the analyzed roots.");
		}
		const keepWasmBytes = extension(relativePath) === ".wasm";
		if (keepWasmBytes && details.size > maximumWasmBytes) {
			throw new Error(`WebAssembly evidence is limited to 256 MiB per module: ${relativePath}`);
		}
		const hash = createHash("sha256");
		const found = new Set<string>();
		const wasmChunks: Buffer[] = [];
		let carry = "";
		for await (const value of createReadStream(path)) {
			const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
			hash.update(chunk);
			if (keepWasmBytes) {
				wasmChunks.push(chunk);
			}
			const searchable = `${carry}${chunk.toString("latin1")}`.toLowerCase();
			for (const marker of markerCatalog) {
				if (!found.has(marker) && searchable.includes(marker)) {
					found.add(marker);
				}
			}
			carry = searchable.slice(-(maximumMarkerLength - 1));
		}
		files.push({ path: relativePath, size: details.size, sha256: hash.digest("hex"), markers: [...found].sort(), wasmBytes: keepWasmBytes ? Buffer.concat(wasmChunks) : null });
	};
	for (const path of paths) {
		await visit(path);
	}
	files.sort((left, right) => left.path.localeCompare(right.path));
	return { files, totalBytes };
}

function fileFingerprint(files: IScannedFile[]): string {
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(file.path).update("\0").update(file.sha256).update("\0");
	}
	return hash.digest("hex");
}

function imageEvidence(files: IScannedFile[], extensions: Set<string>): { files: number; bytes: number; paths: string[] } {
	const matches = files.filter((file) => extensions.has(extension(file.path)));
	return { files: matches.length, bytes: matches.reduce((sum, file) => sum + file.size, 0), paths: matches.slice(0, maximumEvidencePaths).map((file) => file.path) };
}

export function inspectWebBuildToolchain(settings: IWebBuildEvidenceSettings): IWebBuildToolchainEvidence {
	if (settings.emscriptenToolchain === "typescript-bundler") {
		return {
			selection: settings.emscriptenToolchain,
			executable: null,
			requestedVersion: null,
			detectedVersion: null,
			verified: true,
			boundary: "The portable TypeScript/JavaScript build does not invoke Emscripten; ESM bundling and browser WebAssembly loading remain the active pipeline.",
			reason: "No native C/C++ or Unity IL2CPP player is compiled by the default Web build.",
		};
	}
	return {
		selection: settings.emscriptenToolchain,
		executable: settings.emscriptenExecutable,
		requestedVersion: CURRENT_EMSCRIPTEN_VERSION,
		detectedVersion: null,
		verified: false,
		boundary: "Read-only inspection never executes an authored program. The destructive build operation probes the configured executable before package scripts run.",
		reason: `External Emscripten ${CURRENT_EMSCRIPTEN_VERSION} is selected and awaits build-time executable verification.`,
	};
}

export async function probeWebBuildToolchain(settings: IWebBuildEvidenceSettings): Promise<IWebBuildToolchainEvidence> {
	if (settings.emscriptenToolchain === "typescript-bundler") {
		return inspectWebBuildToolchain(settings);
	}
	try {
		const result = await execFileAsync(settings.emscriptenExecutable, ["--version"], { timeout: 10_000, maxBuffer: 1024 * 1024 });
		const output = `${result.stdout}\n${result.stderr}`.trim().slice(0, 4096);
		const detectedVersion = output.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null;
		return {
			selection: settings.emscriptenToolchain,
			executable: settings.emscriptenExecutable,
			requestedVersion: CURRENT_EMSCRIPTEN_VERSION,
			detectedVersion,
			verified: detectedVersion === CURRENT_EMSCRIPTEN_VERSION,
			boundary:
				"The project package scripts own external Emscripten invocation; Zvibe verifies the selected executable and passes the exact adapter contract through BJS_EDITOR_* variables.",
			reason:
				detectedVersion === CURRENT_EMSCRIPTEN_VERSION
					? `External Emscripten ${CURRENT_EMSCRIPTEN_VERSION} is available.`
					: `Expected Emscripten ${CURRENT_EMSCRIPTEN_VERSION}, detected ${detectedVersion ?? "no semantic version"}.`,
		};
	} catch (error) {
		return {
			selection: settings.emscriptenToolchain,
			executable: settings.emscriptenExecutable,
			requestedVersion: CURRENT_EMSCRIPTEN_VERSION,
			detectedVersion: null,
			verified: false,
			boundary:
				"The project package scripts own external Emscripten invocation; Zvibe verifies the selected executable and passes the exact adapter contract through BJS_EDITOR_* variables.",
			reason: `Unable to execute ${settings.emscriptenExecutable} --version: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * The runtime library exported projects import to load editor scenes (`loadScene`). Its scene loader statically reaches
 * animation, audio, sprites, navigation and more, so those modules stay in the bundle even when project sources never mention them.
 */
const editorRuntimePackage = "babylonjs-editor-tools";

/** Scans the installed editor runtime's ESM sources when the project depends on it; returns project-relative evidence paths. */
async function scanEditorRuntime(projectDirectory: string): Promise<{ files: IScannedFile[]; totalBytes: number } | null> {
	let manifest: any;
	try {
		manifest = JSON.parse(await readFile(join(projectDirectory, "package.json"), "utf-8"));
	} catch {
		return null;
	}
	if (!manifest?.dependencies?.[editorRuntimePackage]) {
		return null;
	}

	const packageDirectory = join(projectDirectory, "node_modules", editorRuntimePackage);
	if (!(await pathExists(packageDirectory))) {
		return null;
	}

	// Linked or workspace installs resolve to the real package directory; evidence paths stay project-relative.
	const root = (await realpath(packageDirectory)).replaceAll("\\", "/");
	const scan = await scanFiles(root, [join(root, "build/src")]);
	return {
		files: scan.files.map((file) => ({ ...file, path: `node_modules/${editorRuntimePackage}/${file.path}` })),
		totalBytes: scan.totalBytes,
	};
}

export async function createWebBuildPlan(projectDirectory: string, profile: IWebBuildProfileDescriptor, configurationRevision: number): Promise<IWebBuildPlan> {
	if (!profile.settings.web) {
		throw new Error("A Web build plan requires normalized Web profile settings.");
	}
	const roots = [join(projectDirectory, "package.json"), join(projectDirectory, "src"), join(projectDirectory, "assets"), join(projectDirectory, "public")];
	const scan = await scanFiles(projectDirectory, roots);
	const runtimeScan = await scanEditorRuntime(projectDirectory);
	const searchable = scan.files.filter((file) => textExtensions.has(extension(file.path)));
	const runtimeSearchable = (runtimeScan?.files ?? []).filter((file) => textExtensions.has(extension(file.path)));
	const decisions: IWebBuildModuleDecision[] = modules.map((module) => {
		const hasMarker = (file: IScannedFile): boolean => module.markers.some((marker) => file.markers.includes(marker));
		const projectEvidence = searchable.filter(hasMarker);
		const runtimeEvidence = projectEvidence.length ? [] : runtimeSearchable.filter(hasMarker);
		const evidencePaths = [...projectEvidence, ...runtimeEvidence].slice(0, maximumEvidencePaths).map((file) => file.path);
		const decision = evidencePaths.length ? "retain" : profile.settings.web!.moduleStripping ? "strip" : "preserve";
		return {
			id: module.id,
			label: module.label,
			decision,
			reason: projectEvidence.length
				? "Project source or package metadata contains a bounded module marker, so the ESM dependency remains reachable."
				: runtimeEvidence.length
					? `The ${editorRuntimePackage} scene loader the project imports references this module, so the ESM dependency remains reachable.`
					: decision === "strip"
						? "No project marker was found; production ESM tree-shaking may omit the unreachable module and output verification must prove marker absence."
						: "Module stripping is disabled, so no absence claim is made for this unreferenced module.",
			evidencePaths,
			markers: [...module.markers],
		};
	});
	const settings = { ...profile.settings.web };
	const source = { fingerprint: fileFingerprint(scan.files), fileCount: scan.files.length, totalBytes: scan.totalBytes, complete: true as const };
	const png = imageEvidence(scan.files, new Set([".png"]));
	const jpeg = imageEvidence(scan.files, new Set([".jpeg", ".jpg"]));
	const wasm = imageEvidence(scan.files, new Set([".wasm"]));
	const toolchain = inspectWebBuildToolchain(settings);
	const body = {
		version: WEB_BUILD_EVIDENCE_VERSION,
		backend: "zvibe-web-module-stripping-v1" as const,
		configurationRevision,
		profileId: profile.id,
		settings,
		source,
		...(runtimeScan
			? {
					runtime: {
						package: editorRuntimePackage,
						fingerprint: fileFingerprint(runtimeScan.files),
						fileCount: runtimeScan.files.length,
						totalBytes: runtimeScan.totalBytes,
					},
				}
			: {}),
		modules: decisions,
		images: { png, jpeg, decoderBoundary: "browser-native-no-bundled-libpng-or-libjpeg" as const },
		wasm: { ...wasm, webAssembly2023: settings.webAssembly2023 },
		toolchain,
		limits: { maximumFiles, maximumBytes, maximumEvidencePathsPerCategory: maximumEvidencePaths },
	};
	return { ...body, planFingerprint: stableFingerprint(body) };
}

export async function inspectWebBuildOutput(outputDirectory: string, plan: IWebBuildPlan): Promise<any> {
	const scan = await scanFiles(outputDirectory, [outputDirectory], WEB_BUILD_MANIFEST);
	const textFiles = scan.files.filter((file) => textExtensions.has(extension(file.path)));
	const markerHits = (markers: string[]): string[] =>
		textFiles
			.filter((file) => markers.some((marker) => file.markers.includes(marker)))
			.slice(0, maximumEvidencePaths)
			.map((file) => file.path);
	const binaryMarkerHits = (markers: string[]): string[] =>
		scan.files
			.filter((file) => markers.some((marker) => file.markers.includes(marker)))
			.slice(0, maximumEvidencePaths)
			.map((file) => file.path);
	const nativeCodecMarkerPaths = {
		png: binaryMarkerHits(["libpng", "png_create_read_struct", "png_create_write_struct"]),
		jpeg: binaryMarkerHits(["libjpeg", "jpeg_std_error", "jpeg_create_decompress", "jpeg_create_compress"]),
	};
	const moduleEvidence = plan.modules.map((module) => {
		const artifactMarkerPaths = markerHits(module.markers);
		return {
			id: module.id,
			decision: module.decision,
			artifactMarkerPaths,
			verified: module.decision !== "strip" || artifactMarkerPaths.length === 0,
		};
	});
	const wasmFiles = scan.files.filter((file) => extension(file.path) === ".wasm");
	const invalidWasmPaths = wasmFiles
		.filter((file) => !file.wasmBytes || !WebAssembly.validate(Uint8Array.from(file.wasmBytes)))
		.slice(0, maximumEvidencePaths)
		.map((file) => file.path);
	const png = imageEvidence(scan.files, new Set([".png"]));
	const jpeg = imageEvidence(scan.files, new Set([".jpeg", ".jpg"]));
	const scanFingerprint = fileFingerprint(scan.files);
	const reasons = [
		...moduleEvidence.filter((entry) => !entry.verified).map((entry) => `${entry.id} was planned for stripping but module markers remain in output.`),
		...(nativeCodecMarkerPaths.png.length ? ["Native libpng markers remain in Web output."] : []),
		...(nativeCodecMarkerPaths.jpeg.length ? ["Native libjpeg markers remain in Web output."] : []),
		...invalidWasmPaths.map((path) => `WebAssembly.validate rejected ${path}.`),
	];
	return {
		planFingerprint: plan.planFingerprint,
		scan: { fingerprint: scanFingerprint, fileCount: scan.files.length, totalBytes: scan.totalBytes, complete: true },
		modules: moduleEvidence,
		images: {
			png: { ...png, nativeLibraryMarkers: nativeCodecMarkerPaths.png, nativeLibraryMarkersAbsent: nativeCodecMarkerPaths.png.length === 0 },
			jpeg: { ...jpeg, nativeLibraryMarkers: nativeCodecMarkerPaths.jpeg, nativeLibraryMarkersAbsent: nativeCodecMarkerPaths.jpeg.length === 0 },
			decoderBoundary: plan.images.decoderBoundary,
		},
		wasm: {
			files: wasmFiles.length,
			bytes: wasmFiles.reduce((sum, file) => sum + file.size, 0),
			validFiles: wasmFiles.length - invalidWasmPaths.length,
			invalidPaths: invalidWasmPaths,
			webAssembly2023: plan.settings.webAssembly2023,
			validationBoundary:
				"WebAssembly.validate checks binary validity on the current host; custom package scripts or the verified external Emscripten adapter own feature-level compilation.",
		},
		valid: reasons.length === 0,
		reasons,
	};
}

export async function writeWebBuildManifest(outputDirectory: string, plan: IWebBuildPlan, toolchain: IWebBuildToolchainEvidence = plan.toolchain): Promise<any> {
	const output = await inspectWebBuildOutput(outputDirectory, plan);
	const manifest = { version: WEB_BUILD_EVIDENCE_VERSION, backend: "zvibe-web-build-evidence-v1", plan, toolchain, output };
	await writeJSON(join(outputDirectory, WEB_BUILD_MANIFEST), manifest, { spaces: "\t" });
	return manifest;
}

export async function verifyWebBuildManifest(outputDirectory: string, expectedPlanFingerprint: string): Promise<any> {
	const manifestPath = join(outputDirectory, WEB_BUILD_MANIFEST);
	if (!(await pathExists(manifestPath))) {
		throw new Error(`Web build evidence manifest is missing: ${WEB_BUILD_MANIFEST}`);
	}
	const manifest = JSON.parse((await readFile(manifestPath, "utf8")) as string) as {
		version?: number;
		backend?: string;
		plan?: IWebBuildPlan;
		toolchain?: IWebBuildToolchainEvidence;
		output?: any;
	};
	if (manifest.version !== WEB_BUILD_EVIDENCE_VERSION || manifest.backend !== "zvibe-web-build-evidence-v1" || !manifest.plan) {
		throw new Error("Web build evidence manifest has an unsupported version or backend.");
	}
	const { planFingerprint, ...planBody } = manifest.plan;
	if (stableFingerprint(planBody) !== planFingerprint) {
		throw new Error("Web build evidence manifest plan integrity check failed.");
	}
	if (manifest.plan.planFingerprint !== expectedPlanFingerprint) {
		throw new Error(`Stale Web build plan fingerprint. Expected ${manifest.plan.planFingerprint}, received ${expectedPlanFingerprint}.`);
	}
	const current = await inspectWebBuildOutput(outputDirectory, manifest.plan);
	const reasons = [...current.reasons];
	if (
		manifest.toolchain?.selection !== manifest.plan.settings.emscriptenToolchain ||
		manifest.toolchain?.verified !== true ||
		(manifest.plan.settings.emscriptenToolchain === "external-4.0.19" &&
			(manifest.toolchain.requestedVersion !== CURRENT_EMSCRIPTEN_VERSION || manifest.toolchain.detectedVersion !== CURRENT_EMSCRIPTEN_VERSION))
	) {
		reasons.push("The generated manifest lacks valid evidence for the selected Web toolchain.");
	}
	if (manifest.output?.scan?.fingerprint !== current.scan.fingerprint) {
		reasons.push("Web output changed after the evidence manifest was generated.");
	}
	return { manifestPath: WEB_BUILD_MANIFEST, plan: manifest.plan, toolchain: manifest.toolchain, output: current, valid: reasons.length === 0, reasons };
}
