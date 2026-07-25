import { extname, isAbsolute, normalize, relative } from "node:path/posix";

export interface IBuildSceneSettings {
	version: 1;
	scenes: Array<{ path: string; enabled: boolean }>;
}

export function selectBuildSceneFiles(projectDirectory: string, discoveredSceneFiles: string[], settings?: IBuildSceneSettings): string[] {
	if (settings?.version !== 1 || !Array.isArray(settings.scenes)) {
		return discoveredSceneFiles;
	}
	if (settings.scenes.length > 512) {
		throw new Error("Scene build settings support at most 512 scenes.");
	}

	const discovered = new Map(discoveredSceneFiles.map((sceneFile) => [normalize(relative(projectDirectory, sceneFile)), sceneFile]));
	const selected: string[] = [];
	const seen = new Set<string>();
	for (const entry of settings.scenes) {
		if (typeof entry?.enabled !== "boolean") {
			throw new Error(`Scene build enabled state must be boolean: ${entry?.path ?? "<missing>"}`);
		}
		const path = typeof entry?.path === "string" ? normalize(entry.path.replaceAll("\\", "/")) : "";
		if (!path || path.length > 1024 || isAbsolute(path) || path.startsWith("../") || path === ".." || extname(path).toLowerCase() !== ".scene") {
			throw new Error(`Invalid project-relative scene build path: ${entry?.path ?? "<missing>"}`);
		}
		if (seen.has(path)) {
			throw new Error(`Duplicate scene build path: ${path}`);
		}
		seen.add(path);
		if (!entry.enabled) {
			continue;
		}

		const sceneFile = discovered.get(path);
		if (!sceneFile) {
			throw new Error(`Enabled scene build path does not exist: ${path}`);
		}
		selected.push(sceneFile);
	}

	return selected;
}
