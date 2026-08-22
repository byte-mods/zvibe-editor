import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from "path/posix";
import { readFile } from "fs-extra";

import { Scene, Tools } from "babylonjs";
import {
	ALEMBIC_CACHE_FORMAT,
	ALEMBIC_CACHE_VERSION,
	ALEMBIC_MAX_CACHE_BYTES,
	ALEMBIC_MAX_OBJECTS,
	ALEMBIC_MAX_SAMPLES,
	ALEMBIC_PLAYER_CONFIGURATION_VERSION,
	AlembicPlayer,
	createAlembicPlayer,
	getAlembicPlayer,
	IAlembicPlayerConfiguration,
	listAlembicPlayers as listRuntimeAlembicPlayers,
	normalizeAlembicPlayerConfiguration,
	ALEMBIC_PLAYER_METADATA_KEY,
} from "babylonjs-editor-tools";

import { projectConfiguration } from "../../project/configuration";
import type { Editor } from "../../editor/main";
import { IMCPActionOptions } from "../action";
import { resolveNode } from "../tools/resolve";
import { applyAlembicImporterArtifact, getAlembicImporterArtifactStatus } from "./alembic-importer";

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return resolve(dirname(projectConfiguration.path));
}

function resolveAlembicPath(path: unknown): { absolutePath: string; projectPath: string } {
	if (typeof path !== "string" || !path.trim() || path.length > 4096 || path.includes("\0")) {
		throw new Error("Alembic path must be a non-empty project path of at most 4,096 characters.");
	}
	const root = projectDirectory();
	const absolutePath = normalize(isAbsolute(path) ? path : join(root, path));
	if (absolutePath !== root && !absolutePath.startsWith(`${root}/`)) {
		throw new Error("Alembic paths must stay inside the open project directory.");
	}
	const projectPath = relative(root, absolutePath).replace(/\\/g, "/");
	if (!projectPath.startsWith("assets/") || extname(projectPath).toLowerCase() !== ".abc") {
		throw new Error("Alembic assets must be .abc files inside the project assets directory.");
	}
	return { absolutePath, projectPath };
}

function refreshEditor(options: IMCPActionOptions, root?: any): void {
	options.editor.layout.assets?.refresh?.();
	void options.editor.layout.graph.refresh().then(() => {
		if (root) {
			options.editor.layout.graph.setSelectedNode(root);
			options.editor.layout.inspector.setEditedObject(root);
		}
	});
	options.editor.layout.inspector.forceUpdate();
}

function boundedPage(value: unknown, fallback: number, maximum: number): number {
	return Number.isSafeInteger(value) ? Math.min(maximum, Math.max(0, value as number)) : fallback;
}

function summary(player: AlembicPlayer, objectOffset = 0, objectLimit = 100): any {
	const manifest = player.document.manifest;
	const offset = boundedPage(objectOffset, 0, manifest.objects.length);
	const limit = boundedPage(objectLimit, 100, 200);
	const objects = manifest.objects.slice(offset, offset + limit);
	return {
		configuration: player.configuration,
		state: player.state,
		rootNodeId: player.root.id,
		rootNodeName: player.root.name,
		cache: {
			format: manifest.format,
			version: manifest.version,
			source: manifest.source,
			settingsSha256: manifest.settingsSha256,
			coordinateSystem: manifest.coordinateSystem,
			fps: manifest.fps,
			sampleCount: manifest.sampleCount,
			startTimeSeconds: manifest.startTimeSeconds,
			endTimeSeconds: manifest.endTimeSeconds,
			durationSeconds: manifest.durationSeconds,
			bounds: manifest.bounds,
			statistics: manifest.statistics,
			objects: objects.map((object, index) => ({ objectIndex: offset + index, ...object })),
			objectPage: {
				total: manifest.objects.length,
				offset,
				count: objects.length,
				nextOffset: offset + objects.length < manifest.objects.length ? offset + objects.length : null,
			},
		},
	};
}

function findPlayer(scene: Scene, data: { id?: unknown; name?: unknown }): AlembicPlayer {
	const players = listRuntimeAlembicPlayers(scene as any);
	const player = players.find((candidate) => candidate.configuration.id === data.id || candidate.configuration.name === data.name);
	if (!player) {
		throw new Error("Alembic player was not found. Provide an exact id or name returned by list_alembic_players.");
	}
	return player;
}

/** Reports the bounded portable Alembic feature contract without mutating project or scene state. */
export function getAlembicCapabilities(): any {
	return {
		format: ALEMBIC_CACHE_FORMAT,
		version: ALEMBIC_CACHE_VERSION,
		authoringAdapter: "Blender Alembic importer",
		runtimeDependency: "none",
		sourceExtensions: [".abc"],
		objectKinds: ["mesh", "points", "curves", "camera"],
		features: ["time-sampled geometry", "stable-topology interpolation", "variable-topology hold", "visibility", "camera optics", "material face-set names"],
		limits: { cacheBytes: ALEMBIC_MAX_CACHE_BYTES, objects: ALEMBIC_MAX_OBJECTS, samples: ALEMBIC_MAX_SAMPLES, residentFrames: 2 },
		clients: ["Codex CLI", "Claude-compatible MCP clients"],
	};
}

/** Returns the exact source/settings fingerprint and current converted-cache evidence for one project `.abc` asset. */
export async function inspectAlembicImport(_scene: Scene, data: any): Promise<any> {
	const { absolutePath, projectPath } = resolveAlembicPath(data.path);
	const status = await getAlembicImporterArtifactStatus(absolutePath);
	const result = status.result;
	return {
		path: projectPath,
		fingerprint: status.fingerprint,
		current: status.current,
		exists: status.exists,
		artifactPath: status.result ? relative(projectDirectory(), status.result.outputPath).replace(/\\/g, "/") : null,
		result: result
			? (() => {
					const objectOffset = boundedPage(data.objectOffset, 0, result.manifest.objects.length);
					const objectLimit = boundedPage(data.objectLimit, 100, 200);
					const frameOffset = boundedPage(data.frameOffset, 0, result.manifest.frames.length);
					const frameLimit = boundedPage(data.frameLimit, 200, 500);
					const objects = result.manifest.objects.slice(objectOffset, objectOffset + objectLimit);
					const frames = result.manifest.frames.slice(frameOffset, frameOffset + frameLimit);
					return {
						sourceBytes: result.sourceBytes,
						outputBytes: result.outputBytes,
						cacheSha256: result.cacheSha256,
						executable: result.executable,
						settings: result.settings,
						manifest: {
							...result.manifest,
							objects,
							frames,
							objectPage: {
								total: result.manifest.objects.length,
								offset: objectOffset,
								count: objects.length,
								nextOffset: objectOffset + objects.length < result.manifest.objects.length ? objectOffset + objects.length : null,
							},
							framePage: {
								total: result.manifest.frames.length,
								offset: frameOffset,
								count: frames.length,
								nextOffset: frameOffset + frames.length < result.manifest.frames.length ? frameOffset + frames.length : null,
							},
						},
					};
				})()
			: null,
	};
}

/** Converts one exact inspected Alembic source/settings lease and atomically publishes its portable cache artifact. */
export async function applyAlembicImport(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const { absolutePath } = resolveAlembicPath(data.path);
	if (typeof data.expectedFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(data.expectedFingerprint)) {
		throw new Error("apply_alembic_import requires the exact 64-character expectedFingerprint returned by inspect_alembic_import.");
	}
	if (data.confirm !== true) {
		throw new Error("apply_alembic_import requires confirm=true because it replaces the generated cache artifact.");
	}
	await applyAlembicImporterArtifact(absolutePath, data.expectedFingerprint);
	refreshEditor(options);
	return inspectAlembicImport(_scene, data);
}

/** Instantiates a current converted Alembic artifact as sampled Babylon scene objects and one persistent player root. */
export async function instantiateAlembicAsset(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const { absolutePath, projectPath } = resolveAlembicPath(data.path);
	const status = await getAlembicImporterArtifactStatus(absolutePath);
	if (!status.current || !status.result) {
		throw new Error("Alembic cache is missing or stale. Inspect and apply the importer before instantiating the asset.");
	}
	const id = data.id ?? Tools.RandomId();
	const name = data.name ?? status.result.manifest.source.name.replace(/\.abc$/i, "");
	const settings = status.result.settings;
	const configuration = normalizeAlembicPlayerConfiguration({
		version: ALEMBIC_PLAYER_CONFIGURATION_VERSION,
		id,
		name,
		assetPath: projectPath,
		revision: 1,
		enabled: data.enabled ?? true,
		playOnAwake: data.playOnAwake ?? settings.playOnAwake,
		loop: data.loop ?? settings.loopByDefault,
		speed: data.speed ?? settings.speed,
		interpolation: data.interpolation ?? settings.interpolation,
		startTimeSeconds: data.startTimeSeconds ?? null,
		endTimeSeconds: data.endTimeSeconds ?? null,
		pointSize: data.pointSize ?? settings.pointSize,
		curveWidth: data.curveWidth ?? settings.curveWidth,
	});
	const player = await createAlembicPlayer(scene as any, new Uint8Array(await readFile(status.result.outputPath)), configuration);
	options.editor.sceneWorkspace?.claimNewObjectsForActiveScene?.([player.root, ...player.nodes.values()]);
	if (data.parentId || data.parentName) {
		player.root.parent = resolveNode({ scene, nodeId: data.parentId, nodeName: data.parentName }) as any;
	}
	if (data.position) {
		if (!Array.isArray(data.position) || data.position.length !== 3 || data.position.some((value: unknown) => typeof value !== "number" || !Number.isFinite(value))) {
			player.dispose(true);
			throw new Error("Alembic position must contain exactly three finite numbers.");
		}
		player.root.position.copyFromFloats(data.position[0], data.position[1], data.position[2]);
	}
	refreshEditor(options, player.root);
	return summary(player);
}

/** Lists every live Alembic player, its exact authored revision, cache evidence, and playback diagnostics. */
export function listAlembicPlayers(scene: Scene, data: any = {}): any {
	const players = listRuntimeAlembicPlayers(scene as any);
	const offset = boundedPage(data.offset, 0, players.length);
	const limit = boundedPage(data.limit, 50, 100);
	const page = players.slice(offset, offset + limit);
	return {
		total: players.length,
		offset,
		count: page.length,
		nextOffset: offset + page.length < players.length ? offset + page.length : null,
		players: page.map((player) => summary(player, 0, 0)),
	};
}

/** Returns one exact live Alembic player and bounded cache/object evidence. */
export function getAlembicPlayerState(scene: Scene, data: any): any {
	return summary(findPlayer(scene, data), data.objectOffset, data.objectLimit);
}

/** Atomically updates one exact-revision Alembic player configuration and reapplies its current sample. */
export async function setAlembicPlayer(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	// Lookup identity is kept separate from the replacement name so name-based callers can rename without ambiguity.
	const player = findPlayer(scene, { id: data.id, name: data.currentName });
	const previous = player.configuration;
	if (!Number.isSafeInteger(data.expectedRevision) || data.expectedRevision !== previous.revision) {
		throw new Error(`Alembic player revision changed. Inspect again and use expectedRevision ${previous.revision}.`);
	}
	const allowed = ["name", "enabled", "playOnAwake", "loop", "speed", "interpolation", "startTimeSeconds", "endTimeSeconds", "pointSize", "curveWidth"] as const;
	const patch = Object.fromEntries(allowed.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]));
	if (!Object.keys(patch).length) {
		throw new Error(`set_alembic_player requires at least one mutable field: ${allowed.join(", ")}.`);
	}
	const next: IAlembicPlayerConfiguration = normalizeAlembicPlayerConfiguration({ ...previous, ...patch, revision: previous.revision + 1 });
	await player.updateConfiguration(next);
	player.root.name = next.name;
	refreshEditor(options, player.root);
	return summary(player);
}

/** Plays, pauses, stops, or seeks one exact live Alembic cache owner. */
export async function controlAlembicPlayer(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const player = findPlayer(scene, data);
	if (data.action === "play") {
		player.play();
	} else if (data.action === "pause") {
		player.pause();
	} else if (data.action === "stop") {
		await player.stop();
	} else if (data.action === "seek") {
		if (typeof data.timeSeconds !== "number" || !Number.isFinite(data.timeSeconds)) {
			throw new Error("Alembic seek requires a finite timeSeconds value.");
		}
		await player.seek(data.timeSeconds);
	} else {
		throw new Error("Alembic action must be play, pause, stop, or seek.");
	}
	refreshEditor(options, player.root);
	return summary(player);
}

/** Deletes one Alembic player root and only the generated scene resources owned by that player. */
export function deleteAlembicPlayer(scene: Scene, data: any, options: IMCPActionOptions): any {
	const player = findPlayer(scene, data);
	if (data.confirm !== true) {
		throw new Error("delete_alembic_player requires confirm=true because the instantiated scene hierarchy is removed.");
	}
	const id = player.configuration.id;
	player.dispose(true);
	refreshEditor(options);
	return { deleted: true, id };
}

/** Rebinds serialized Alembic roots to current editor-side importer artifacts after project scene loading. */
export async function configureEditorAlembicPlayers(scene: Scene, editor?: Editor): Promise<{ configured: number; errors: Array<{ id: string; message: string }> }> {
	let configured = 0;
	const errors: Array<{ id: string; message: string }> = [];
	for (const root of scene.transformNodes) {
		const raw = root.metadata?.[ALEMBIC_PLAYER_METADATA_KEY];
		if (!raw) {
			continue;
		}
		let id = typeof raw.id === "string" ? raw.id : root.id;
		try {
			const configuration = normalizeAlembicPlayerConfiguration(raw);
			id = configuration.id;
			if (getAlembicPlayer(scene as any, configuration.id)) {
				continue;
			}
			const { absolutePath } = resolveAlembicPath(configuration.assetPath);
			const status = await getAlembicImporterArtifactStatus(absolutePath);
			if (!status.current || !status.result) {
				throw new Error(`Alembic importer artifact for "${configuration.assetPath}" is missing or stale.`);
			}
			const player = await createAlembicPlayer(scene as any, new Uint8Array(await readFile(status.result.outputPath)), configuration, {
				root: root as any,
				existingNodes: root.getDescendants(false) as any,
				attachMetadata: true,
			});
			if (editor) {
				const owner = editor.sceneWorkspace.getOwner(root);
				if (owner) {
					editor.sceneWorkspace.claimObjects(owner, [...player.nodes.values()]);
				} else {
					editor.sceneWorkspace.claimNewObjectsForActiveScene([...player.nodes.values()]);
				}
			}
			configured++;
		} catch (error) {
			errors.push({ id, message: error instanceof Error ? error.message : String(error) });
		}
	}
	return { configured, errors };
}
