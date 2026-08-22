import { lstat, mkdir, realpath } from "fs/promises";
import { isAbsolute, join, relative, sep } from "path";

export function projectPathContains(root: string, target: string): boolean {
	const child = relative(root, target);
	return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function validateSegments(segments: string[]): void {
	if (!segments.length || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\"))) {
		throw new Error("Project store directory segments must be fixed child names.");
	}
}

/** Resolves an existing fixed project metadata directory without creating or following a symbolic link. */
export async function inspectProjectStoreDirectory(root: string, ...segments: string[]): Promise<string | null> {
	validateSegments(segments);
	const realRoot = await realpath(root);
	let current = root;
	for (const segment of segments) {
		current = join(current, segment);
		let currentStat;
		try {
			currentStat = await lstat(current);
		} catch (error: any) {
			if (error?.code === "ENOENT") {
				return null;
			}
			throw error;
		}
		if (currentStat.isSymbolicLink()) {
			throw new Error(`Project metadata directory cannot be a symbolic link: ${segment}`);
		}
		if (!currentStat.isDirectory()) {
			throw new Error(`Project metadata path must be a directory: ${segment}`);
		}
		const realCurrent = await realpath(current);
		if (!projectPathContains(realRoot, realCurrent)) {
			throw new Error("Project metadata directory must resolve inside the active project.");
		}
	}
	return current;
}

/**
 * Creates only fixed internal directory segments and refuses pre-existing symlinks before any project metadata is written.
 */
export async function ensureProjectStoreDirectory(root: string, ...segments: string[]): Promise<string> {
	validateSegments(segments);
	const existing = await inspectProjectStoreDirectory(root, ...segments);
	if (existing) {
		return existing;
	}
	const realRoot = await realpath(root);
	let current = root;
	for (const segment of segments) {
		current = join(current, segment);
		let currentStat;
		try {
			currentStat = await lstat(current);
		} catch (error: any) {
			if (error?.code !== "ENOENT") {
				throw error;
			}
			await mkdir(current).catch((mkdirError: any) => {
				if (mkdirError?.code !== "EEXIST") {
					throw mkdirError;
				}
			});
			currentStat = await lstat(current);
		}
		if (currentStat.isSymbolicLink()) {
			throw new Error(`Project metadata directory cannot be a symbolic link: ${segment}`);
		}
		if (!currentStat.isDirectory()) {
			throw new Error(`Project metadata path must be a directory: ${segment}`);
		}
		const realCurrent = await realpath(current);
		if (!projectPathContains(realRoot, realCurrent)) {
			throw new Error("Project metadata directory must resolve inside the active project.");
		}
	}
	return current;
}
