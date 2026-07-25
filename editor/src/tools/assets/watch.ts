import { join, resolve } from "path/posix";

/** Produces absolute Chokidar roots so emitted change paths remain compatible with the registry's contained-path contract. */
export function getProjectAssetWatchPaths(projectDirectory: string): string[] {
	const root = resolve(projectDirectory);
	return [join(root, "assets"), join(root, "src")];
}
