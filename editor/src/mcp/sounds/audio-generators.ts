import { Scene } from "babylonjs";

import {
	createDefaultScriptableAudioGeneratorGraph,
	listScriptableAudioGeneratorTypes,
	SCRIPTABLE_AUDIO_LIMITS,
	validateScriptableAudioGeneratorGraph,
} from "babylonjs-editor-tools";

import { deleteScriptableAudioAsset, readScriptableAudioAsset, writeScriptableAudioAsset } from "../assets/scriptable-audio-assets";
import { queryAssetRegistry } from "../assets/registry";

function publicSnapshot(snapshot: Awaited<ReturnType<typeof readScriptableAudioAsset>>): any {
	return {
		path: snapshot.path,
		graph: snapshot.graph,
		revision: snapshot.revision,
		fingerprint: snapshot.fingerprint,
		runtimeFingerprint: snapshot.runtimeFingerprint,
		dependencies: snapshot.dependencies,
		buildReady: snapshot.runtimeFingerprint !== null,
	};
}

/** Lists indexed Audio Generator assets without reading or executing graph code. */
export async function listAudioGenerators(_scene: Scene, data: any = {}): Promise<any> {
	const result = await queryAssetRegistry({ ...data, type: "audio-generator", folder: data.folder ?? "assets" });
	return {
		generators: result.entries.map((entry: any) => ({
			path: entry.path,
			name: entry.name,
			guid: entry.guid,
			contentHash: entry.contentHash,
			runtimeFingerprint: entry.dependencyFingerprint,
			dependencyScanStatus: entry.dependencyScanStatus,
			dependencyHashDeferred: entry.dependencyHashDeferred,
			dependencies: entry.dependencies,
			missingDependencies: entry.missingDependencies,
		})),
		totalCount: result.totalCount,
		offset: result.offset,
		limit: result.limit,
		hasMore: result.hasMore,
		nextOffset: result.nextOffset,
	};
}

/** Returns built-in/custom node metadata and the exact portable graph bounds. */
export function listAudioGeneratorTypes(): any {
	return { version: 1, limits: SCRIPTABLE_AUDIO_LIMITS, types: listScriptableAudioGeneratorTypes() };
}

/** Reads one canonical graph plus exact source/dependency fingerprints. */
export async function getAudioGenerator(_scene: Scene, data: any): Promise<any> {
	return publicSnapshot(await readScriptableAudioAsset(data.path));
}

/** Creates one graph asset, defaulting to an immediately audible oscillator graph. */
export async function createAudioGenerator(_scene: Scene, data: any): Promise<any> {
	const graph = data.graph ?? createDefaultScriptableAudioGeneratorGraph(data.name ?? "New Audio Generator");
	return publicSnapshot(await writeScriptableAudioAsset(data.path, data.name === undefined ? graph : { ...graph, name: data.name }));
}

/** Exact-fingerprint graph replacement; persisted revision advances once. */
export async function setAudioGenerator(_scene: Scene, data: any): Promise<any> {
	return publicSnapshot(await writeScriptableAudioAsset(data.path, data.graph, data.expectedFingerprint));
}

/** Deletes one graph only when the caller still owns the exact inspected bytes. */
export async function deleteAudioGenerator(_scene: Scene, data: any): Promise<any> {
	return deleteScriptableAudioAsset(data.path, data.expectedFingerprint);
}

/** Validates a candidate graph or an on-disk graph without changing project state. */
export async function validateAudioGenerator(_scene: Scene, data: any): Promise<any> {
	if (data.path !== undefined) {
		try {
			const snapshot = await readScriptableAudioAsset(data.path);
			return { valid: true, errors: [], ...publicSnapshot(snapshot) };
		} catch (error) {
			return { valid: false, errors: [error instanceof Error ? error.message : String(error)] };
		}
	}
	return validateScriptableAudioGeneratorGraph(data.graph);
}
