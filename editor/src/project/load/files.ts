/**
 * Returns whether a directory entry is an editor-owned serialized scene object.
 *
 * Asset metadata sidecars live next to scene objects and also end in `.json`.
 * Loading those sidecars as Babylon objects creates empty nodes, skeletons, and
 * animation groups, so all scene directory enumeration must pass through this
 * boundary.
 */
export function isSerializedSceneObjectFile(file: string): boolean {
	const normalized = file.toLowerCase();

	return !file.startsWith(".") && normalized.endsWith(".json") && !normalized.endsWith(".bjsmeta.json");
}

/**
 * Filters and sorts serialized scene-object filenames deterministically.
 */
export function filterSerializedSceneObjectFiles(files: string[]): string[] {
	return files.filter(isSerializedSceneObjectFile).sort((left, right) => left.localeCompare(right));
}
