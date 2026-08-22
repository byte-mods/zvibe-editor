import { basenamePortablePath as basename, extnamePortablePath as extname, joinPortablePath as join } from "./portable-path";

import { normalizeModelMaterialExtractionFolder, portableAssetFilenameStem } from "./model-material-extraction";

const MAX_EXTRACTED_MODEL_TEXTURES = 128;
const MAX_EXTRACTED_MODEL_TEXTURE_BYTES = 32 * 1024 * 1024;
const MAX_EXTRACTED_MODEL_TEXTURE_TOTAL_BYTES = 256 * 1024 * 1024;

export interface IModelTextureExtractionSource {
	contentHash: string;
	suggestedName: string | null;
	extension: ".png" | ".jpg";
	byteLength: number;
	materialPaths: string[];
}

export interface IModelTextureExtractionExistingAsset {
	path: string;
	contentHash: string | null;
}

export interface IModelTextureExtractionItem extends IModelTextureExtractionSource {
	texturePath: string;
	action: "create" | "reuse" | "conflict";
}

export interface IModelTextureExtractionPlan {
	destinationFolder: string;
	items: IModelTextureExtractionItem[];
	createCount: number;
	reuseCount: number;
	conflictCount: number;
	totalBytes: number;
	valid: boolean;
}

/** Returns the Unity-like sibling Textures default for one project-relative model path. */
export function defaultModelTextureExtractionFolder(modelPath: string): string {
	const normalized = modelPath.replace(/\\/g, "/").replace(/^\.\//, "");
	const parts = normalized.split("/");
	parts.pop();
	return normalizeModelMaterialExtractionFolder(join(parts.join("/"), "Textures"));
}

/** Plans bounded, deterministic, non-overwriting extraction of embedded PNG/JPEG model textures. */
export function planModelTextureExtraction(
	sources: IModelTextureExtractionSource[],
	destinationFolder: string,
	existingAssets: IModelTextureExtractionExistingAsset[] = []
): IModelTextureExtractionPlan {
	const folder = normalizeModelMaterialExtractionFolder(destinationFolder);
	if (sources.length > MAX_EXTRACTED_MODEL_TEXTURES) {
		throw new Error(`Model texture extraction supports at most ${MAX_EXTRACTED_MODEL_TEXTURES} unique images.`);
	}
	const totalBytes = sources.reduce((sum, source) => sum + source.byteLength, 0);
	if (totalBytes > MAX_EXTRACTED_MODEL_TEXTURE_TOTAL_BYTES) {
		throw new Error(`Model texture extraction is limited to ${MAX_EXTRACTED_MODEL_TEXTURE_TOTAL_BYTES} total bytes.`);
	}
	const seenHashes = new Set<string>();
	const occupiedNames = new Set<string>();
	const existingByPath = new Map(existingAssets.map((asset) => [asset.path.replace(/\\/g, "/").toLowerCase(), asset]));
	const items = [...sources]
		.sort((left, right) => (left.suggestedName ?? left.contentHash).localeCompare(right.suggestedName ?? right.contentHash))
		.map((source) => {
			if (!/^[a-f0-9]{64}$/.test(source.contentHash) || seenHashes.has(source.contentHash)) {
				throw new Error("Embedded model texture hashes must be unique SHA-256 values.");
			}
			seenHashes.add(source.contentHash);
			if (!Number.isInteger(source.byteLength) || source.byteLength < 1 || source.byteLength > MAX_EXTRACTED_MODEL_TEXTURE_BYTES) {
				throw new Error(`Each embedded model texture is limited to ${MAX_EXTRACTED_MODEL_TEXTURE_BYTES} bytes.`);
			}
			if (source.extension !== ".png" && source.extension !== ".jpg") {
				throw new Error("Embedded model textures must contain PNG or JPEG bytes.");
			}
			const suggested = source.suggestedName ? basename(source.suggestedName, extname(source.suggestedName)) : source.contentHash.slice(0, 16);
			const stem = portableAssetFilenameStem(suggested);
			let filename = `${stem}${source.extension}`;
			let suffix = 2;
			while (occupiedNames.has(filename.toLowerCase())) {
				filename = `${stem}-${suffix++}${source.extension}`;
			}
			occupiedNames.add(filename.toLowerCase());
			const texturePath = join(folder, filename);
			const existing = existingByPath.get(texturePath.toLowerCase());
			return {
				...source,
				materialPaths: [...new Set(source.materialPaths)].sort(),
				texturePath,
				action: existing ? (existing.contentHash === source.contentHash ? "reuse" : "conflict") : "create",
			} satisfies IModelTextureExtractionItem;
		});
	return {
		destinationFolder: folder,
		items,
		createCount: items.filter((item) => item.action === "create").length,
		reuseCount: items.filter((item) => item.action === "reuse").length,
		conflictCount: items.filter((item) => item.action === "conflict").length,
		totalBytes,
		valid: items.length > 0 && items.every((item) => item.action !== "conflict"),
	};
}
