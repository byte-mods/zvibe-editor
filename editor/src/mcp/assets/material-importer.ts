import { createHash } from "crypto";
import { createReadStream } from "fs";
import { basename, dirname, extname, join, relative } from "path/posix";
import { copyFile, ensureDir, move, pathExists, readFile, readJSON, remove, stat, writeFile, writeJSON } from "fs-extra";

import { NodeMaterial, NullEngine, Scene } from "babylonjs";
import {
	collectBabylonMaterialTextureCandidates,
	collectMtlTextureCandidates,
	classifyMaterialTextureReference,
	getMaterialSourceKind,
	groupMaterialTextureCandidates,
	IMaterialCompileResult,
	IMaterialImporterSettings,
	IMaterialImportResult,
	IMaterialTextureCandidate,
	normalizeMaterialImporterSettings,
} from "babylonjs-editor-tools";

import { projectConfiguration } from "../../project/configuration";
import { applyImporterArtifactWithAccelerator } from "./import-accelerator";
import { readAssetMetadata } from "./registry";

const MAX_EMBEDDED_TEXTURE_BYTES = 32 * 1024 * 1024;

export interface IMaterialImporterArtifactStatus {
	path: string;
	artifactDirectory: string;
	manifestPath: string;
	fingerprint: string;
	current: boolean;
	exists: boolean;
	result: IMaterialImportResult | null;
}

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectConfiguration.path);
}

async function contentHash(path: string): Promise<string> {
	const hash = createHash("sha256");
	await new Promise<void>((resolve, reject) => {
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", resolve);
	});
	return hash.digest("hex");
}

async function materialImporterFingerprint(path: string, settings: IMaterialImporterSettings): Promise<string> {
	return createHash("sha256")
		.update(await contentHash(path))
		.update("\0")
		.update(JSON.stringify(settings))
		.digest("hex");
}

function compileNodeMaterial(data: Record<string, unknown>, rootUrl: string, requested: boolean): IMaterialCompileResult {
	if (!requested) {
		return {
			requested: false,
			attempted: false,
			valid: null,
			errors: [],
			warnings: [],
			statistics: null,
		};
	}
	const engine = new NullEngine();
	const scene = new Scene(engine);
	const errors: string[] = [];
	const warnings: string[] = [];
	let material: NodeMaterial | null = null;
	try {
		material = NodeMaterial.Parse(data, scene, rootUrl);
		const observer = material.onBuildErrorObservable.add((message) => errors.push(message));
		try {
			material.build(false, true, false);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		} finally {
			material.onBuildErrorObservable.remove(observer);
		}
		const outputs = [...material._vertexOutputNodes, ...material._fragmentOutputNodes];
		if (!outputs.length) {
			errors.push("The Node Material graph has no vertex or fragment output blocks.");
		}
		const disconnected = material.attachedBlocks.flatMap((block) =>
			block.inputs.filter((input) => !input.isOptional && !input.isConnected && !input.connectInputBlock).map((input) => `${block.name}.${input.name}`)
		);
		if (disconnected.length) {
			warnings.push(`Required inputs are disconnected: ${disconnected.join(", ")}.`);
		}
		return {
			requested: true,
			attempted: true,
			valid: errors.length === 0,
			errors: [...new Set(errors)],
			warnings,
			statistics: {
				attachedBlockCount: material.attachedBlocks.length,
				outputBlockCount: outputs.length,
				textureBlockCount: material.getAllTextureBlocks().length,
				compiledShaderCharacters: (() => {
					try {
						return material!.compiledShaders.length;
					} catch {
						return 0;
					}
				})(),
			},
		};
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
		return {
			requested: true,
			attempted: true,
			valid: false,
			errors,
			warnings,
			statistics: null,
		};
	} finally {
		material?.dispose();
		scene.dispose();
		engine.dispose();
	}
}

function embeddedTexture(buffer: Buffer): { extension: ".png" | ".jpg" } {
	if (buffer.length > MAX_EMBEDDED_TEXTURE_BYTES) {
		throw new Error(`Embedded material textures are limited to ${MAX_EMBEDDED_TEXTURE_BYTES} bytes.`);
	}
	if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
		return { extension: ".png" };
	}
	if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
		return { extension: ".jpg" };
	}
	throw new Error("Embedded material textures must contain PNG or JPEG bytes.");
}

async function extractEmbeddedTexture(value: string, outputRoot: string): Promise<string> {
	const separator = value.indexOf(",");
	if (separator < 0) {
		throw new Error("Embedded material texture data URI is malformed.");
	}
	const buffer = Buffer.from(value.slice(separator + 1), "base64");
	const { extension } = embeddedTexture(buffer);
	const name = `${createHash("sha256").update(buffer).digest("hex")}${extension}`;
	const relativePath = join("assets", "editor-generated_extracted-textures", name);
	const outputPath = join(outputRoot, relativePath);
	await ensureDir(dirname(outputPath));
	if (!(await pathExists(outputPath))) {
		await writeFile(outputPath, buffer);
	}
	return relativePath;
}

/** Executes texture validation/extraction and Node Material compilation into one portable material artifact. */
export async function processMaterialImporterOutput(
	sourcePath: string,
	requestedOutputPath: string,
	outputRoot: string,
	projectRoot: string,
	settings: IMaterialImporterSettings
): Promise<IMaterialImportResult> {
	const extension = extname(sourcePath).toLowerCase();
	if (extension !== ".material" && extension !== ".mtl") {
		throw new Error("Material importer supports .material and .mtl assets.");
	}
	const sourceDetails = await stat(sourcePath);
	const sourceProjectPath = relative(projectRoot, sourcePath).replace(/\\/g, "/");
	const errors: string[] = [];
	const warnings: string[] = [];
	const extractedTextures: string[] = [];
	let candidates: IMaterialTextureCandidate[];
	let materialData: Record<string, unknown> | null = null;
	let sourceKind = getMaterialSourceKind(sourcePath);

	if (extension === ".mtl") {
		const source = await readFile(sourcePath, "utf-8");
		candidates = collectMtlTextureCandidates(source);
		await ensureDir(dirname(requestedOutputPath));
		await copyFile(sourcePath, requestedOutputPath);
	} else {
		try {
			materialData = (await readJSON(sourcePath)) as Record<string, unknown>;
		} catch (error) {
			throw new Error(`Material JSON is malformed: ${error instanceof Error ? error.message : String(error)}`);
		}
		sourceKind = getMaterialSourceKind(sourcePath, materialData!);
		candidates = collectBabylonMaterialTextureCandidates(materialData!);
		if (settings.extractEmbeddedTextures) {
			for (const candidate of candidates) {
				if (!candidate.value.startsWith("data:image/")) {
					continue;
				}
				try {
					const extracted = await extractEmbeddedTexture(candidate.value, outputRoot);
					candidate.setValue?.(extracted);
					extractedTextures.push(extracted);
				} catch (error) {
					errors.push(`${candidate.location || "texture"}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
		await ensureDir(dirname(requestedOutputPath));
		await writeJSON(requestedOutputPath, materialData, { spaces: "\t" });
	}

	const projectPaths = [
		...new Set(
			candidates
				.map((candidate) => classifyMaterialTextureReference(sourceProjectPath, candidate.value))
				.filter((reference) => reference.kind === "project" && reference.resolvedPath !== null)
				.map((reference) => reference.resolvedPath as string)
		),
	];
	const existsByPath = new Map<string, boolean>();
	await Promise.all(
		projectPaths.map(async (path) => {
			existsByPath.set(path, (await pathExists(join(outputRoot, path))) || (await pathExists(join(projectRoot, path))));
		})
	);
	const references = groupMaterialTextureCandidates(sourceProjectPath, candidates, existsByPath);
	const missingTextures = references
		.filter((reference) => reference.kind === "project" && reference.exists === false)
		.map((reference) => reference.resolvedPath ?? reference.value);
	if (settings.validateTextures && missingTextures.length) {
		errors.push(`Missing project textures: ${missingTextures.join(", ")}.`);
	}
	if (references.some((reference) => reference.kind === "remote")) {
		warnings.push("Remote texture URLs remain external and are not embedded into deterministic builds.");
	}
	if (!settings.extractEmbeddedTextures && references.some((reference) => reference.kind === "embedded")) {
		warnings.push("Embedded texture extraction is disabled; data URI textures remain inside the material.");
	}
	const compile =
		sourceKind === "node-material" && materialData
			? compileNodeMaterial(materialData, `${projectRoot}/`, settings.compileNodeMaterial)
			: {
					requested: settings.compileNodeMaterial,
					attempted: false,
					valid: null,
					errors: [],
					warnings: settings.compileNodeMaterial ? ["Compilation applies only to Babylon Node Material assets."] : [],
					statistics: null,
				};
	errors.push(...compile.errors);
	warnings.push(...compile.warnings);
	return {
		sourcePath,
		outputPath: requestedOutputPath,
		sourceKind,
		settings,
		sourceBytes: sourceDetails.size,
		textureReferences: references,
		missingTextures,
		extractedTextures: [...new Set(extractedTextures)],
		compile,
		valid: errors.length === 0,
		errors: [...new Set(errors)],
		warnings: [...new Set(warnings)],
	};
}

async function artifactPaths(path: string): Promise<{ artifactDirectory: string; manifestPath: string }> {
	const metadata = await readAssetMetadata(path);
	const artifactDirectory = join(projectDirectory(), ".bjseditor/imported-assets", metadata.guid);
	return { artifactDirectory, manifestPath: join(artifactDirectory, "material-import.json") };
}

export async function getMaterialImporterArtifactStatus(path: string): Promise<IMaterialImporterArtifactStatus> {
	const metadata = await readAssetMetadata(path);
	if (metadata.importer.kind !== "material") {
		throw new Error("Material importer artifacts are only available for material assets.");
	}
	const settings = normalizeMaterialImporterSettings(metadata.importer.settings);
	const fingerprint = await materialImporterFingerprint(path, settings);
	const { artifactDirectory, manifestPath } = await artifactPaths(path);
	let result: IMaterialImportResult | null = null;
	try {
		const manifest = await readJSON(manifestPath);
		if (manifest?.fingerprint === fingerprint && manifest?.result) {
			result = manifest.result;
		}
	} catch {
		// A missing or malformed lease manifest makes the artifact stale.
	}
	const exists = result ? await pathExists(result.outputPath) : await pathExists(artifactDirectory);
	return { path, artifactDirectory, manifestPath, fingerprint, current: result !== null && exists, exists, result };
}

export async function applyMaterialImporterArtifact(path: string, expectedFingerprint: string): Promise<IMaterialImporterArtifactStatus> {
	return applyImporterArtifactWithAccelerator({
		kind: "material",
		sourcePath: path,
		expectedFingerprint,
		inspect: () => getMaterialImporterArtifactStatus(path),
		applyLocal: () => applyMaterialImporterArtifactLocally(path, expectedFingerprint),
	});
}

async function applyMaterialImporterArtifactLocally(path: string, expectedFingerprint: string): Promise<IMaterialImporterArtifactStatus> {
	const status = await getMaterialImporterArtifactStatus(path);
	if (status.fingerprint !== expectedFingerprint) {
		throw new Error(`Material importer plan changed. Inspect again and use current fingerprint ${status.fingerprint}.`);
	}
	const metadata = await readAssetMetadata(path);
	const settings = normalizeMaterialImporterSettings(metadata.importer.settings);
	const temporaryDirectory = `${status.artifactDirectory}.tmp-${process.pid}-${Date.now()}`;
	await remove(temporaryDirectory);
	try {
		const outputPath = join(temporaryDirectory, basename(path));
		const generated = await processMaterialImporterOutput(path, outputPath, temporaryDirectory, projectDirectory(), settings);
		await remove(status.artifactDirectory);
		await ensureDir(dirname(status.artifactDirectory));
		await move(temporaryDirectory, status.artifactDirectory, { overwrite: true });
		const remap = (value: string): string => value.replace(temporaryDirectory, status.artifactDirectory);
		const result = {
			...generated,
			outputPath: remap(generated.outputPath),
			extractedTextures: generated.extractedTextures.map((value) => remap(join(temporaryDirectory, value))),
		};
		await writeJSON(status.manifestPath, { version: 1, fingerprint: status.fingerprint, generatedAt: new Date().toISOString(), result }, { spaces: "\t" });
		return { ...status, current: true, exists: true, result };
	} catch (error) {
		await remove(temporaryDirectory).catch(() => undefined);
		throw error;
	}
}
