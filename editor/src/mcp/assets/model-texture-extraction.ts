import { createHash } from "crypto";
import { basename, dirname, join, relative, resolve } from "path/posix";
import { pathExists, readFile, readJSON, realpath, stat } from "fs-extra";

import {
	collectBabylonMaterialTextureCandidates,
	defaultModelTextureExtractionFolder,
	IModelTextureExtractionPlan,
	normalizeModelMaterialExtractionFolder,
	normalizeModelImporterSettings,
	planModelTextureExtraction,
} from "babylonjs-editor-tools";

import { projectConfiguration } from "../../project/configuration";
import { readAssetMetadata } from "./registry";
import { getModelImporterSourceFingerprint } from "./model-importer";

const MAX_EMBEDDED_TEXTURE_BYTES = 32 * 1024 * 1024;

export interface IModelTextureExtractionStatus extends IModelTextureExtractionPlan {
	path: string;
	fingerprint: string;
	materialPaths: string[];
}

export interface IPreparedModelTextureExtraction {
	status: IModelTextureExtractionStatus;
	bytesByHash: Record<string, Buffer>;
	materialDocuments: Record<string, Record<string, unknown>>;
}

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectConfiguration.path);
}

function decodeEmbeddedImage(value: string): { bytes: Buffer; extension: ".png" | ".jpg"; contentHash: string } {
	const match = /^data:image\/(png|jpeg|jpg);base64,([A-Za-z0-9+/=]+)$/i.exec(value);
	if (!match) {
		throw new Error("Embedded model textures must be base64 PNG or JPEG data URIs.");
	}
	const bytes = Buffer.from(match[2], "base64");
	if (!bytes.length || bytes.length > MAX_EMBEDDED_TEXTURE_BYTES) {
		throw new Error(`Each embedded model texture must contain 1-${MAX_EMBEDDED_TEXTURE_BYTES} bytes.`);
	}
	const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
	const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	if (!png && !jpeg) {
		throw new Error("Embedded model texture bytes do not match a PNG or JPEG signature.");
	}
	return { bytes, extension: png ? ".png" : ".jpg", contentHash: createHash("sha256").update(bytes).digest("hex") };
}

/** Plans extraction from already editable remapped materials and prepares rewritten material documents without writing files. */
export async function prepareModelTextureExtraction(path: string, destinationFolder?: string): Promise<IPreparedModelTextureExtraction> {
	const root = await realpath(projectDirectory());
	const canonicalSource = await realpath(path);
	const modelPath = relative(root, canonicalSource).replace(/\\/g, "/");
	const metadata = await readAssetMetadata(canonicalSource);
	if (metadata.importer.kind !== "model") {
		throw new Error("Model texture extraction requires a model asset.");
	}
	const settings = normalizeModelImporterSettings(metadata.importer.settings);
	if (!settings.materialRemaps.length) {
		throw new Error("Extract model materials first so embedded texture references can be rewritten in editable .material assets.");
	}
	const folder = destinationFolder ? normalizeModelMaterialExtractionFolder(destinationFolder) : defaultModelTextureExtractionFolder(modelPath);
	const materialPaths = [...new Set(settings.materialRemaps.map((remap) => remap.materialPath))].sort();
	const materialDocuments: Record<string, Record<string, unknown>> = {};
	const bytesByHash: Record<string, Buffer> = {};
	const sourcesByHash = new Map<string, { contentHash: string; suggestedName: string | null; extension: ".png" | ".jpg"; byteLength: number; materialPaths: string[] }>();
	const candidatesByHash: Array<{ hash: string; setValue: (value: string) => void }> = [];
	for (const materialPath of materialPaths) {
		const candidatePath = resolve(root, materialPath);
		if (!(await pathExists(candidatePath)) || (await stat(candidatePath)).isDirectory()) {
			throw new Error(`Extracted model material is missing: ${materialPath}. Extract materials again before extracting textures.`);
		}
		const canonicalMaterial = await realpath(candidatePath);
		const containment = relative(root, canonicalMaterial);
		if (containment === ".." || containment.startsWith("../")) {
			throw new Error(`Extracted model material escapes the project: ${materialPath}.`);
		}
		const document = (await readJSON(canonicalMaterial)) as Record<string, unknown>;
		materialDocuments[materialPath] = document;
		for (const candidate of collectBabylonMaterialTextureCandidates(document).filter((entry) => entry.value.startsWith("data:image/"))) {
			const decoded = decodeEmbeddedImage(candidate.value);
			bytesByHash[decoded.contentHash] = decoded.bytes;
			const current = sourcesByHash.get(decoded.contentHash);
			if (current) {
				if (!current.materialPaths.includes(materialPath)) {
					current.materialPaths.push(materialPath);
				}
			} else {
				sourcesByHash.set(decoded.contentHash, {
					contentHash: decoded.contentHash,
					suggestedName: candidate.suggestedName ? basename(candidate.suggestedName) : null,
					extension: decoded.extension,
					byteLength: decoded.bytes.length,
					materialPaths: [materialPath],
				});
			}
			if (!candidate.setValue) {
				throw new Error(`Embedded texture at ${materialPath}:${candidate.location} cannot be rewritten safely.`);
			}
			candidatesByHash.push({ hash: decoded.contentHash, setValue: candidate.setValue });
		}
	}
	if (!sourcesByHash.size) {
		throw new Error("The extracted model materials contain no embedded PNG/JPEG textures.");
	}
	const initial = planModelTextureExtraction([...sourcesByHash.values()], folder);
	const existingAssets = await Promise.all(
		initial.items.map(async (item) => {
			const absolutePath = join(root, item.texturePath);
			if (!(await pathExists(absolutePath)) || (await stat(absolutePath)).isDirectory()) {
				return null;
			}
			return {
				path: item.texturePath,
				contentHash: createHash("sha256")
					.update(await readFile(absolutePath))
					.digest("hex"),
			};
		})
	);
	const plan = planModelTextureExtraction(
		[...sourcesByHash.values()],
		folder,
		existingAssets.filter((asset) => asset !== null)
	);
	const pathByHash = new Map(plan.items.map((item) => [item.contentHash, item.texturePath]));
	for (const candidate of candidatesByHash) {
		candidate.setValue(pathByHash.get(candidate.hash)!);
	}
	const fingerprint = createHash("sha256")
		.update(await getModelImporterSourceFingerprint(canonicalSource, settings))
		.update("\0")
		.update(JSON.stringify(plan))
		.digest("hex");
	return { status: { ...plan, path: modelPath, fingerprint, materialPaths }, bytesByHash, materialDocuments };
}

/** Inspects exact texture outputs and material rewrites without modifying project files. */
export async function getModelTextureExtractionStatus(path: string, destinationFolder?: string): Promise<IModelTextureExtractionStatus> {
	return (await prepareModelTextureExtraction(path, destinationFolder)).status;
}
