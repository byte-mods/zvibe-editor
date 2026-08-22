import { createHash } from "crypto";
import { join } from "path";

const exportLanes = new Map<string, Promise<void>>();
let deletionTail: Promise<void> = Promise.resolve();

function settled(operation: Promise<void>): Promise<void> {
	return operation.catch(() => undefined);
}

/** Derives the private export-evidence path from the portable project path shared by publication and deletion. */
export function getFbxExportManifestPath(projectDirectory: string, projectRelativePath: string): string {
	const portablePath = projectRelativePath.replace(/\\/g, "/");
	const key = createHash("sha256").update(portablePath).digest("hex");
	return join(projectDirectory, ".bjseditor", "fbx-exports", `${key}.json`);
}

/** Preserves cross-destination parallelism while serializing one FBX destination behind any earlier destructive asset deletion. */
export async function withFbxExportLane<T>(path: string, operation: () => Promise<T>): Promise<T> {
	const blockers = Promise.all([settled(exportLanes.get(path) ?? Promise.resolve()), settled(deletionTail)]);
	let release!: () => void;
	const current = new Promise<void>((resolve) => (release = resolve));
	const queued = blockers.then(() => current);
	exportLanes.set(path, queued);
	await blockers;
	try {
		return await operation();
	} finally {
		release();
		if (exportLanes.get(path) === queued) {
			exportLanes.delete(path);
		}
	}
}

/** Fences one asset deletion behind every active export and makes later exports wait until deletion and evidence cleanup finish. */
export async function withFbxAssetDeletion<T>(operation: () => Promise<T>): Promise<T> {
	const blockers = Promise.all([settled(deletionTail), ...[...exportLanes.values()].map(settled)]);
	let release!: () => void;
	const current = new Promise<void>((resolve) => (release = resolve));
	const queued = blockers.then(() => current);
	deletionTail = queued;
	await blockers;
	try {
		return await operation();
	} finally {
		release();
		if (deletionTail === queued) {
			deletionTail = Promise.resolve();
		}
	}
}
