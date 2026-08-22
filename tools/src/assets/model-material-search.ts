import {
	basenamePortablePath as basename,
	dirnamePortablePath as dirname,
	extnamePortablePath as extname,
	joinPortablePath as join,
	normalizePortablePath as normalize,
} from "./portable-path";

import { IModelMaterialRemapDefinition } from "./model-material-remaps";

export type ModelMaterialNaming = "sourceMaterial" | "baseTextureName" | "modelAndMaterial";
export type ModelMaterialSearch = "none" | "local" | "recursiveUp" | "projectWide";

export interface IModelMaterialSearchSource {
	sourceMaterial: string;
	baseTextureName: string | null;
}

export interface IModelMaterialSearchMatch {
	sourceMaterial: string;
	candidateName: string;
	materialPath: string | null;
	candidates: string[];
	matched: boolean;
	ambiguous: boolean;
}

export interface IModelMaterialSearchResult {
	naming: ModelMaterialNaming;
	search: ModelMaterialSearch;
	searchedMaterialCount: number;
	matches: IModelMaterialSearchMatch[];
}

function normalizedProjectPath(value: string): string {
	return normalize(value.replace(/\\/g, "/")).replace(/^\.\//, "");
}

function materialName(path: string): string {
	return basename(path, extname(path));
}

function searchFolderRanks(modelPath: string): Map<string, number> {
	const ranks = new Map<string, number>();
	let current = dirname(normalizedProjectPath(modelPath));
	let rank = 0;
	for (;;) {
		ranks.set(join(current, "Materials"), rank++);
		if (current === "." || current === "") {
			break;
		}
		const parent = dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}
	return ranks;
}

function candidateName(modelPath: string, source: IModelMaterialSearchSource, naming: ModelMaterialNaming): string {
	if (naming === "baseTextureName") {
		return source.baseTextureName || source.sourceMaterial;
	}
	if (naming === "modelAndMaterial") {
		return `${basename(modelPath, extname(modelPath))}-${source.sourceMaterial}`;
	}
	return source.sourceMaterial;
}

export function filterModelMaterialSearchPaths(modelPath: string, materialPaths: string[], search: ModelMaterialSearch): string[] {
	const paths = [...new Set(materialPaths.map(normalizedProjectPath).filter((path) => extname(path).toLowerCase() === ".material"))].sort();
	if (paths.length > 10_000) {
		throw new Error("Automatic model-material search is limited to 10000 project material assets.");
	}
	const folderRanks = searchFolderRanks(modelPath);
	return paths.filter((path) => {
		if (search === "none") {
			return false;
		}
		if (search === "projectWide") {
			return true;
		}
		const rank = folderRanks.get(dirname(path));
		return rank !== undefined && (search === "recursiveUp" || rank === 0);
	});
}

/** Produces deterministic Unity-style material search/remap evidence from a bounded project file inventory. */
export function planModelMaterialSearch(
	modelPath: string,
	sources: IModelMaterialSearchSource[],
	materialPaths: string[],
	naming: ModelMaterialNaming,
	search: ModelMaterialSearch
): IModelMaterialSearchResult {
	const scoped = filterModelMaterialSearchPaths(modelPath, materialPaths, search);
	const folderRanks = searchFolderRanks(modelPath);
	const matches = sources.map((source) => {
		const expected = candidateName(modelPath, source, naming);
		const exact = scoped.filter((path) => materialName(path) === expected);
		const named = exact.length ? exact : scoped.filter((path) => materialName(path).toLocaleLowerCase() === expected.toLocaleLowerCase());
		const ranked = named
			.map((path) => ({ path, rank: search === "recursiveUp" ? (folderRanks.get(dirname(path)) ?? Number.MAX_SAFE_INTEGER) : 0 }))
			.sort((left, right) => left.rank - right.rank || left.path.localeCompare(right.path));
		const bestRank = ranked[0]?.rank;
		const best = ranked.filter((entry) => entry.rank === bestRank).map((entry) => entry.path);
		return {
			sourceMaterial: source.sourceMaterial,
			candidateName: expected,
			materialPath: best.length === 1 ? best[0] : null,
			candidates: ranked.map((entry) => entry.path),
			matched: best.length === 1,
			ambiguous: best.length > 1,
		};
	});
	return { naming, search, searchedMaterialCount: scoped.length, matches };
}

export function materialSearchRemaps(result: IModelMaterialSearchResult, explicit: IModelMaterialRemapDefinition[]): IModelMaterialRemapDefinition[] {
	const explicitSources = new Set(explicit.map((entry) => entry.sourceMaterial));
	return result.matches
		.filter((entry) => entry.matched && entry.materialPath && !explicitSources.has(entry.sourceMaterial))
		.map((entry) => ({ sourceMaterial: entry.sourceMaterial, materialPath: entry.materialPath! }));
}
