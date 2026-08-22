import { lstat, readdir } from "fs-extra";
import { extname, isAbsolute, join, relative, resolve } from "path/posix";

import { requiresAssetRoot } from "babylonjs-editor-tools";

export type AssetRootPlacementReason = "inside-assets" | "no-required-assets" | "required-extension" | "scan-limit";

export interface IAssetRootPlacementInspection {
	allowed: boolean;
	reason: AssetRootPlacementReason;
	checkedEntries: number;
	requiredAssetPath: string | null;
}

export interface IAssetRootPlacementInspectionOptions {
	maximumEntries?: number;
	maximumDepth?: number;
}

export function isInsideAssetRoot(path: string, assetsRoot: string): boolean {
	const normalizedRoot = resolve(assetsRoot);
	const normalizedPath = resolve(path);
	const pathFromRoot = relative(normalizedRoot, normalizedPath);
	return pathFromRoot === "" || (pathFromRoot !== ".." && !pathFromRoot.startsWith("../") && !isAbsolute(pathFromRoot));
}

/** Recursively blocks a copied folder when any nested built asset would land outside `/assets`. */
export async function inspectAssetRootPlacement(
	sourcePath: string,
	destinationPath: string,
	assetsRoot: string,
	options: IAssetRootPlacementInspectionOptions = {}
): Promise<IAssetRootPlacementInspection> {
	if (isInsideAssetRoot(destinationPath, assetsRoot)) {
		return { allowed: true, reason: "inside-assets", checkedEntries: 0, requiredAssetPath: null };
	}

	const maximumEntries = options.maximumEntries ?? 10_000;
	const maximumDepth = options.maximumDepth ?? 32;
	if (!Number.isInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > 100_000 || !Number.isInteger(maximumDepth) || maximumDepth < 1 || maximumDepth > 128) {
		throw new Error("Asset-root inspection limits must use 1–100000 entries and 1–128 levels.");
	}

	let checkedEntries = 0;
	const inspect = async (source: string, destination: string, depth: number): Promise<IAssetRootPlacementInspection | null> => {
		checkedEntries++;
		if (checkedEntries > maximumEntries || depth > maximumDepth) {
			return { allowed: false, reason: "scan-limit", checkedEntries, requiredAssetPath: destination };
		}
		const details = await lstat(source);
		if (!details.isDirectory() || details.isSymbolicLink()) {
			return requiresAssetRoot(extname(destination)) ? { allowed: false, reason: "required-extension", checkedEntries, requiredAssetPath: destination } : null;
		}
		const entries = (await readdir(source)).sort();
		for (const entry of entries) {
			const result = await inspect(join(source, entry), join(destination, entry), depth + 1);
			if (result) {
				return result;
			}
		}
		return null;
	};

	return (await inspect(sourcePath, destinationPath, 0)) ?? { allowed: true, reason: "no-required-assets", checkedEntries, requiredAssetPath: null };
}

export function assetRootPlacementError(inspection: IAssetRootPlacementInspection): string {
	if (inspection.reason === "scan-limit") {
		return `The import was not copied because asset-root inspection exceeded its safety limit near ${inspection.requiredAssetPath ?? "the selected folder"}. Import it directly under /assets or choose a smaller folder.`;
	}
	return `Built asset ${inspection.requiredAssetPath ?? "the selected file"} must be imported under the project's /assets folder to prevent broken runtime references.`;
}
