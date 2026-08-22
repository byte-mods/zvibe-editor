import { basenamePortablePath as basename, extnamePortablePath as extname, joinPortablePath as join } from "./portable-path";

const MAX_EXTRACTED_MODEL_MATERIALS = 128;
const MAX_EXTRACTION_PATH_LENGTH = 1024;

export interface IModelMaterialExtractionSource {
	sourceMaterial: string;
	contentHash: string;
}

export interface IModelMaterialExtractionExistingAsset {
	path: string;
	contentHash: string | null;
}

export interface IModelMaterialExtractionItem {
	sourceMaterial: string;
	contentHash: string;
	materialPath: string;
	action: "create" | "reuse" | "conflict";
}

export interface IModelMaterialExtractionPlan {
	destinationFolder: string;
	items: IModelMaterialExtractionItem[];
	createCount: number;
	reuseCount: number;
	conflictCount: number;
	valid: boolean;
}

function normalizeProjectPath(value: string): string {
	return value.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

/** Validates and normalizes a project Assets folder used for editable model-material extraction. */
export function normalizeModelMaterialExtractionFolder(value: unknown): string {
	if (typeof value !== "string") {
		throw new Error("Model material extraction destinationFolder must be a string.");
	}
	const folder = normalizeProjectPath(value);
	if (!folder || folder.length > MAX_EXTRACTION_PATH_LENGTH) {
		throw new Error(`Model material extraction destinationFolder must contain 1-${MAX_EXTRACTION_PATH_LENGTH} characters.`);
	}
	if (folder.startsWith("/") || /^[A-Za-z]:\//.test(folder) || folder.split("/").some((part) => part === ".." || !part)) {
		throw new Error("Model material extraction destinationFolder must stay inside the project.");
	}
	if (folder.toLowerCase() !== "assets" && !folder.toLowerCase().startsWith("assets/")) {
		throw new Error("Model material extraction destinationFolder must be inside the project's assets folder.");
	}
	return folder;
}

/** Returns Unity-like default sibling Materials folder for one project-relative model path. */
export function defaultModelMaterialExtractionFolder(modelPath: string): string {
	const normalized = normalizeProjectPath(modelPath);
	const parts = normalized.split("/");
	parts.pop();
	return normalizeModelMaterialExtractionFolder(join(parts.join("/"), "Materials"));
}

/** Produces a portable, cross-platform filename stem without permitting path characters. */
export function portableAssetFilenameStem(value: string): string {
	const invalidFilenameCharacters = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"]);
	let stem = [...value.normalize("NFKC")]
		.map((character) => (character.charCodeAt(0) < 32 || invalidFilenameCharacters.has(character) ? "-" : character))
		.join("")
		.replace(/\s+/g, " ")
		.replace(/[. ]+$/g, "")
		.trim();
	if (!stem || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) {
		stem = stem ? `${stem}-material` : "Material";
	}
	stem = stem.slice(0, 120).replace(/[. ]+$/g, "") || "Material";
	return stem;
}

/** Produces a portable, cross-platform material filename without permitting path characters. */
export function modelMaterialExtractionFilename(sourceMaterial: string): string {
	return `${portableAssetFilenameStem(sourceMaterial)}.material`;
}

/** Plans bounded, non-overwriting extraction. Byte-equivalent existing assets are reused; other collisions block the apply step. */
export function planModelMaterialExtraction(
	sources: IModelMaterialExtractionSource[],
	destinationFolder: string,
	existingAssets: IModelMaterialExtractionExistingAsset[] = []
): IModelMaterialExtractionPlan {
	const folder = normalizeModelMaterialExtractionFolder(destinationFolder);
	if (sources.length > MAX_EXTRACTED_MODEL_MATERIALS) {
		throw new Error(`Model material extraction supports at most ${MAX_EXTRACTED_MODEL_MATERIALS} source materials.`);
	}
	const seenSources = new Set<string>();
	const occupiedNames = new Set<string>();
	const existingByPath = new Map(existingAssets.map((asset) => [normalizeProjectPath(asset.path).toLowerCase(), asset]));
	const items = [...sources]
		.sort((left, right) => left.sourceMaterial.localeCompare(right.sourceMaterial))
		.map((source) => {
			const sourceMaterial = source.sourceMaterial.trim();
			if (!sourceMaterial || sourceMaterial.length > 512) {
				throw new Error("Extracted model source material names must contain 1-512 characters.");
			}
			const sourceKey = sourceMaterial.toLowerCase();
			if (seenSources.has(sourceKey)) {
				throw new Error(`Model material extraction cannot distinguish duplicate source name "${sourceMaterial}".`);
			}
			seenSources.add(sourceKey);
			if (!/^[a-f0-9]{64}$/.test(source.contentHash)) {
				throw new Error(`Extracted model material "${sourceMaterial}" has an invalid content hash.`);
			}
			const initial = modelMaterialExtractionFilename(sourceMaterial);
			const extension = extname(initial);
			const stem = basename(initial, extension);
			let filename = initial;
			let suffix = 2;
			while (occupiedNames.has(filename.toLowerCase())) {
				filename = `${stem}-${suffix++}${extension}`;
			}
			occupiedNames.add(filename.toLowerCase());
			const materialPath = join(folder, filename);
			const existing = existingByPath.get(materialPath.toLowerCase());
			return {
				sourceMaterial,
				contentHash: source.contentHash,
				materialPath,
				action: existing ? (existing.contentHash === source.contentHash ? "reuse" : "conflict") : "create",
			} satisfies IModelMaterialExtractionItem;
		});
	return {
		destinationFolder: folder,
		items,
		createCount: items.filter((item) => item.action === "create").length,
		reuseCount: items.filter((item) => item.action === "reuse").length,
		conflictCount: items.filter((item) => item.action === "conflict").length,
		valid: items.length > 0 && items.every((item) => item.action !== "conflict"),
	};
}
