import { createHash } from "node:crypto";
import { dirname, extname, join, relative } from "node:path/posix";

import fs from "fs-extra";
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
} from "babylonjs-editor-tools";

import { extractTextureAssetFromDataString, extractTextureAssetFromUrl } from "../../tools/extract.mjs";

import { compressFileToKtx } from "./ktx.mjs";
import { compressFileToKtx2 } from "./ktx2.mjs";
import { EditorProjectCompressedTextureSoftware, getExtractedTextureOutputPath } from "./texture.mjs";

const MAX_EMBEDDED_TEXTURE_BYTES = 32 * 1024 * 1024;

export interface IProcessExportedMaterialOptions {
	force: boolean;
	publicDir: string;
	exportedAssets: string[];
	optimize: boolean;
	compressedTextureSoftware?: EditorProjectCompressedTextureSoftware;
}

export async function processExportedMaterial(absolutePath: string, options: IProcessExportedMaterialOptions) {
	const materialData = await fs.readJSON(absolutePath);
	if (materialData.customType !== "BABYLON.NodeMaterial") {
		return;
	}

	const extractedTexturesOutputPath = getExtractedTextureOutputPath(options.publicDir);
	await fs.ensureDir(extractedTexturesOutputPath);

	const relativePaths = await extractNodeMaterialTextures(materialData, {
		extractedTexturesOutputPath,
	});

	await fs.writeJSON(absolutePath, materialData, {
		encoding: "utf-8",
	});

	await Promise.all(
		relativePaths.map(async (relativePath) => {
			const finalPath = join(options.publicDir, relativePath);

			options.exportedAssets.push(finalPath);

			if (options.compressedTextureSoftware === "PVRTexTool") {
				await compressFileToKtx(finalPath, { force: options.force, exportedAssets: options.exportedAssets });
			} else if (options.compressedTextureSoftware === "Khronos KTX-Software") {
				await compressFileToKtx2(finalPath, { force: options.force, exportedAssets: options.exportedAssets });
			}
		})
	);
}

export interface IExtractNodeMaterialTexturesOptions {
	extractedTexturesOutputPath: string;
	extractRemote?: boolean;
}

export async function extractNodeMaterialTextures(materialData: any, options: IExtractNodeMaterialTexturesOptions) {
	const blocks = materialData.blocks.filter(
		(block: any) => (block.customType === "BABYLON.TextureBlock" || block.customType === "BABYLON.ImageSourceBlock") && block.texture?.name
	);

	const relativePaths: string[] = [];

	await Promise.all(
		blocks.map(async (block: any) => {
			if (options.extractRemote !== false && (block.texture?.name?.startsWith("http://") || block.texture.name.startsWith("https://"))) {
				const relativePath = await extractTextureAssetFromUrl(block.texture.name, {
					...options,
				});

				if (relativePath) {
					relativePaths.push(relativePath);
					block.texture.name = block.texture.url = relativePath;
				}
			}

			if (block.texture.name?.startsWith("data:")) {
				const relativePath = await extractTextureAssetFromDataString(block.texture.name, {
					...options,
				});

				if (relativePath) {
					relativePaths.push(relativePath);
					block.texture.name = block.texture.url = relativePath;
				}
			}
		})
	);

	return relativePaths;
}

function compileNodeMaterial(data: Record<string, unknown>, rootUrl: string, requested: boolean): IMaterialCompileResult {
	if (!requested) {
		return { requested: false, attempted: false, valid: null, errors: [], warnings: [], statistics: null };
	}
	const engine = new NullEngine();
	const scene = new Scene(engine);
	const errors: string[] = [];
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
		return {
			requested: true,
			attempted: true,
			valid: errors.length === 0,
			errors: [...new Set(errors)],
			warnings: [],
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
		return {
			requested: true,
			attempted: true,
			valid: false,
			errors: [error instanceof Error ? error.message : String(error)],
			warnings: [],
			statistics: null,
		};
	} finally {
		material?.dispose();
		scene.dispose();
		engine.dispose();
	}
}

function embeddedTextureExtension(buffer: Buffer): ".png" | ".jpg" {
	if (buffer.length > MAX_EMBEDDED_TEXTURE_BYTES) {
		throw new Error(`Embedded material textures are limited to ${MAX_EMBEDDED_TEXTURE_BYTES} bytes.`);
	}
	if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
		return ".png";
	}
	if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
		return ".jpg";
	}
	throw new Error("Embedded material textures must contain PNG or JPEG bytes.");
}

async function extractEmbeddedMaterialTexture(value: string, publicDir: string): Promise<string> {
	const match = /^data:image\/[^;,]+;base64,([a-z0-9+/]*={0,2})$/i.exec(value);
	if (!match) {
		throw new Error("Embedded material texture data URI is malformed or is not base64 encoded.");
	}
	const buffer = Buffer.from(match[1], "base64");
	const extension = embeddedTextureExtension(buffer);
	const filename = `${createHash("sha256").update(buffer).digest("hex")}${extension}`;
	const relativePath = join("assets", "editor-generated_extracted-textures", filename);
	const outputPath = join(publicDir, relativePath);
	await fs.ensureDir(dirname(outputPath));
	if (!(await fs.pathExists(outputPath))) {
		await fs.writeFile(outputPath, buffer);
	}
	return relativePath;
}

/** Executes material texture validation/extraction and Node Material compilation for CLI builds. */
export async function processExportedMaterialImporter(
	sourcePath: string,
	outputPath: string,
	publicDir: string,
	projectDir: string,
	settings: IMaterialImporterSettings
): Promise<IMaterialImportResult> {
	const extension = extname(sourcePath).toLowerCase();
	if (extension !== ".material" && extension !== ".mtl") {
		throw new Error("Material importer supports .material and .mtl assets.");
	}
	const sourceProjectPath = relative(projectDir, sourcePath).replace(/\\/g, "/");
	const errors: string[] = [];
	const warnings: string[] = [];
	const extractedTextures: string[] = [];
	let candidates: IMaterialTextureCandidate[];
	let materialData: Record<string, unknown> | null = null;
	let sourceKind = getMaterialSourceKind(sourcePath);
	await fs.ensureDir(dirname(outputPath));

	if (extension === ".mtl") {
		const source = await fs.readFile(sourcePath, "utf-8");
		candidates = collectMtlTextureCandidates(source);
		await fs.copyFile(sourcePath, outputPath);
	} else {
		materialData = (await fs.readJSON(sourcePath)) as Record<string, unknown>;
		sourceKind = getMaterialSourceKind(sourcePath, materialData);
		candidates = collectBabylonMaterialTextureCandidates(materialData);
		if (settings.extractEmbeddedTextures) {
			for (const candidate of candidates) {
				if (!candidate.value.startsWith("data:image/")) {
					continue;
				}
				try {
					const extracted = await extractEmbeddedMaterialTexture(candidate.value, publicDir);
					candidate.setValue?.(extracted);
					extractedTextures.push(extracted);
				} catch (error) {
					errors.push(`${candidate.location || "texture"}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
		await fs.writeJSON(outputPath, materialData, { spaces: "\t" });
	}

	const existsByPath = new Map<string, boolean>();
	const paths = [
		...new Set(
			candidates
				.map((candidate) => classifyMaterialTextureReference(sourceProjectPath, candidate.value))
				.filter((reference) => reference.kind === "project" && reference.resolvedPath !== null)
				.map((reference) => reference.resolvedPath as string)
		),
	];
	await Promise.all(
		paths.map(async (path) => {
			existsByPath.set(path, extractedTextures.includes(path) || (await fs.pathExists(join(projectDir, path))));
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
			? compileNodeMaterial(materialData, `${projectDir}/`, settings.compileNodeMaterial)
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
		outputPath,
		sourceKind,
		settings,
		sourceBytes: (await fs.stat(sourcePath)).size,
		textureReferences: references,
		missingTextures,
		extractedTextures: [...new Set(extractedTextures)],
		compile,
		valid: errors.length === 0,
		errors: [...new Set(errors)],
		warnings: [...new Set(warnings)],
	};
}
