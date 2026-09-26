import { randomUUID } from "crypto";
import { dirname, extname, isAbsolute, join, normalize, relative } from "path/posix";

import { pathExists, realpath } from "fs-extra";
import { Observer, Scene } from "babylonjs";
import { Scene as CoreScene } from "@babylonjs/core/scene";

import {
	CinematicScenePlayer,
	ICinematicDocument,
	TCinematicClip,
	TCinematicKeyLane,
	TCinematicPropertyKey,
	TCinematicTrack,
	createCinematicCapturePlan,
	createCinematicClip,
	createCinematicDocument,
	createCinematicKey,
	createCinematicMarker,
	createCinematicRecorderProfile,
	createCinematicTrack,
	deleteCinematicClip,
	deleteCinematicKey,
	deleteCinematicMarker,
	deleteCinematicRecorderProfile,
	deleteCinematicTrack,
	moveCinematicTrack,
	normalizeCinematicDocument,
	setCinematicSettings,
	updateCinematicClip,
	updateCinematicKey,
	updateCinematicMarker,
	updateCinematicRecorderProfile,
	updateCinematicTrack,
} from "babylonjs-editor-tools";

import {
	createCinematicDocumentFile,
	deleteCinematicDocumentFile,
	forkCinematicDocumentFile,
	ILoadedCinematicDocument,
	loadCinematicDocument,
	saveCinematicDocument,
} from "../../editor/layout/cinematic/serialization/document";
import { CinematicFileCaptureSink, createEditorMp4Transcoder, ensureCinematicCaptureExtension } from "../../editor/layout/cinematic/v2/capture";
import { inspectCinematicAudioCapture, renderCinematicOfflineAudio } from "../../editor/layout/cinematic/v2/audio-capture";
import { CinematicDocumentRecorder } from "../../editor/layout/cinematic/v2/recorder";
import { projectConfiguration } from "../../project/configuration";
import { normalizedGlob } from "../../tools/fs";
import { IMCPActionOptions } from "../action";

const transportFields = ["endpoint", "collaborationToken"];
const leaseFields = ["path", "expectedRevision", "expectedFingerprint"];

/** Tracks one live preview without letting multiple clocks mutate the same scene. */
interface ICinematicPreviewState {
	path: string;
	player: CinematicScenePlayer;
	observer: Observer<Scene> | null;
	error: string | null;
}

/** Reports one background file capture and retains only bounded status data. */
interface ICinematicCaptureState {
	id: string;
	path: string;
	destination: string;
	status: "running" | "cancelling" | "completed" | "cancelled" | "failed";
	progress: number;
	writtenFrames: number;
	totalFrames: number;
	controller: AbortController;
	error: string | null;
	audio: unknown | null;
}

const previews = new WeakMap<Scene, ICinematicPreviewState>();
const captures = new WeakMap<Scene, ICinematicCaptureState>();

/** Rejects surplus fields even when an action is called directly inside the editor. */
function assertExactRecord(value: unknown, allowed: readonly string[], label: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}.`);
	}
}

/** Admits only MCP transport metadata in addition to the public tool schema. */
function assertActionRecord(value: unknown, allowed: readonly string[], label: string): asserts value is Record<string, unknown> {
	assertExactRecord(value, [...allowed, ...transportFields], label);
}

/** Resolves the open project root shared by every asset operation. */
function getProjectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectConfiguration.path);
}

/** Prevents absolute paths, traversal, null bytes, and symlink-parent escapes. */
async function resolveProjectFile(pathValue: unknown, extension: string | null, mustExist: boolean): Promise<string> {
	if (typeof pathValue !== "string" || !pathValue.trim() || pathValue.length > 1024 || pathValue.includes("\0") || pathValue.includes("\\") || isAbsolute(pathValue)) {
		throw new Error("Project file paths must be non-empty relative POSIX paths.");
	}
	const directory = normalize(getProjectDirectory());
	const absolutePath = normalize(join(directory, pathValue));
	if (absolutePath === directory || !absolutePath.startsWith(`${directory}/`)) {
		throw new Error("Project file paths must stay inside the open project directory.");
	}
	if (extension && extname(absolutePath).toLowerCase() !== extension) {
		throw new Error(`Project file path must end in ${extension}.`);
	}
	const canonicalDirectory = normalize(await realpath(directory));
	const canonicalParent = normalize(await realpath(dirname(absolutePath)));
	if (canonicalParent !== canonicalDirectory && !canonicalParent.startsWith(`${canonicalDirectory}/`)) {
		throw new Error("Project file path resolves through a parent outside the open project directory.");
	}
	if (mustExist) {
		const canonicalFile = normalize(await realpath(absolutePath));
		if (canonicalFile !== canonicalDirectory && !canonicalFile.startsWith(`${canonicalDirectory}/`)) {
			throw new Error("Project file resolves outside the open project directory.");
		}
	}
	return absolutePath;
}

/** Uses the project-relative path as deterministic legacy-migration identity. */
function identitySeed(absolutePath: string): string {
	return relative(getProjectDirectory(), absolutePath);
}

/** Refreshes visible assets after an external file mutation. */
function refreshAssets(options: IMCPActionOptions): void {
	options.editor.layout.assets.refresh();
}

/** Reads a canonical document plus exact content lease from a validated project path. */
async function loadFromInput(data: Record<string, unknown>): Promise<{ absolutePath: string; relativePath: string; loaded: ILoadedCinematicDocument }> {
	const absolutePath = await resolveProjectFile(data.path, ".cinematic", true);
	const relativePath = identitySeed(absolutePath);
	return { absolutePath, relativePath, loaded: await loadCinematicDocument(absolutePath, { identitySeed: relativePath }) };
}

/** Rejects stale or incomplete mutation leases before any candidate is built. */
function assertLease(data: Record<string, unknown>, loaded: ILoadedCinematicDocument): void {
	if (!Number.isSafeInteger(data.expectedRevision) || data.expectedRevision !== loaded.document.revision) {
		throw new Error(`Cinematic revision is stale. Reload exact revision ${loaded.document.revision}.`);
	}
	if (typeof data.expectedFingerprint !== "string" || data.expectedFingerprint !== loaded.fingerprint) {
		throw new Error(`Cinematic fingerprint is stale. Reload exact fingerprint ${loaded.fingerprint}.`);
	}
}

/** Persists one granular immutable authoring result under revision and fingerprint leases. */
async function mutateCinematic(
	data: unknown,
	allowed: readonly string[],
	label: string,
	options: IMCPActionOptions,
	mutation: (document: ICinematicDocument, input: Record<string, unknown>) => ICinematicDocument
): Promise<unknown> {
	assertActionRecord(data, [...leaseFields, ...allowed], label);
	const current = await loadFromInput(data);
	assertLease(data, current.loaded);
	const next = mutation(current.loaded.document, data);
	const saved = await saveCinematicDocument(
		current.absolutePath,
		next,
		{ expectedRevision: current.loaded.document.revision, expectedFingerprint: current.loaded.fingerprint },
		{ identitySeed: current.relativePath }
	);
	refreshAssets(options);
	return { path: current.relativePath, document: saved.document, fingerprint: saved.fingerprint };
}

/** Returns all editable cinematic assets without opening or mutating them. */
export async function listCinematics(): Promise<unknown> {
	const directory = getProjectDirectory();
	const matches = await normalizedGlob(join(directory, "/**/*.cinematic"), { nodir: true, ignore: ["**/node_modules/**", "**/.history/**"] });
	return {
		cinematics: (matches as string[]).map((path) => ({
			path: relative(directory, path),
			name: path
				.split("/")
				.pop()
				?.replace(/\.cinematic$/i, ""),
		})),
	};
}

/** Advertises exact authoring, preview, capture, and explicit audio boundaries. */
export function getCinematicCapabilities(): unknown {
	return {
		documentVersion: 2,
		trackTypes: ["group", "property", "animation", "audio", "video", "activation", "camera", "signal", "control", "recorder"],
		clipTypes: ["animation", "audio", "video", "activation", "camera", "control", "recorder"],
		keyTypes: ["key", "cut"],
		interpolation: ["linear", "step", "cubic"],
		extrapolation: ["none", "hold", "loop", "pingPong", "continue"],
		captureFormats: ["webm", "mp4", "png", "jpeg", "webp"],
		exactRevisionAndFingerprintLeases: true,
		transactionalFileWrites: true,
		deterministicVisualCapture: true,
		builtInAudioCapture: true,
		offlineMasterBusAudioCapture: true,
		audioCaptureSampleRate: 48_000,
		audioCaptureChannels: 2,
		audioCaptureContainers: ["webm", "mp4"],
		audioCaptureCodecs: { webm: "opus", mp4: "aac" },
		persistentVideoPlayerBinding: true,
		audioCaptureBoundary:
			"Built-in capture renders authored Timeline SoundNode clips through the current Audio Mixer bus/effect/return-send graph. Image sequences and HTML Video Player audio remain outside the muxed offline master track.",
	};
}

/** Preflights one exact profile/range and reports every audio source, bus route, codec, and blocking issue. */
export async function inspectCinematicAudioCapturePlan(scene: Scene, data: unknown): Promise<unknown> {
	assertActionRecord(data, [...leaseFields, "profileId", "startFrame", "endFrame"], "inspect_cinematic_audio_capture_plan input");
	const current = await loadFromInput(data);
	assertLease(data, current.loaded);
	const range = { startFrame: data.startFrame as number | undefined, endFrame: data.endFrame as number | undefined };
	const plan = createCinematicCapturePlan(current.loaded.document, data.profileId as string, range);
	return {
		path: current.relativePath,
		revision: current.loaded.document.revision,
		fingerprint: current.loaded.fingerprint,
		profileId: data.profileId,
		capture: {
			startFrame: plan.startFrame,
			endFrame: plan.endFrame,
			frameCount: plan.frameCount,
			framesPerSecond: plan.profile.framesPerSecond,
		},
		audio: inspectCinematicAudioCapture(current.loaded.document, scene as unknown as CoreScene, plan),
	};
}

/** Reads and migrates one complete document without rewriting the asset. */
export async function getCinematic(_scene: Scene, data: unknown): Promise<unknown> {
	assertActionRecord(data, ["path"], "get_cinematic input");
	const result = await loadFromInput(data);
	return { path: result.relativePath, document: result.loaded.document, fingerprint: result.loaded.fingerprint, migrated: result.loaded.migrated };
}

/** Creates one empty version-2 asset with optional document settings. */
export async function createCinematic(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<unknown> {
	assertActionRecord(data, ["path", "name", "framesPerSecond", "outputFramesPerSecond", "durationMode", "durationFrames", "wrapMode"], "create_cinematic input");
	const absolutePath = await resolveProjectFile(data.path, ".cinematic", false);
	const path = identitySeed(absolutePath);
	let document = createCinematicDocument((data.name as string | undefined) ?? "New Cinematic", `cinematic-${randomUUID()}`);
	const changes = Object.fromEntries(
		["name", "framesPerSecond", "outputFramesPerSecond", "durationMode", "durationFrames", "wrapMode"].filter((key) => data[key] !== undefined).map((key) => [key, data[key]])
	);
	if (Object.keys(changes).length) {
		document = setCinematicSettings(document, document.revision, changes);
	}
	const created = await createCinematicDocumentFile(absolutePath, document, { identitySeed: path });
	refreshAssets(options);
	return { created: true, path, document: created.document, fingerprint: created.fingerprint };
}

/** Forks an exact source into a new path and new stable document id. */
export async function forkCinematic(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<unknown> {
	assertActionRecord(data, [...leaseFields, "destinationPath"], "fork_cinematic input");
	const source = await loadFromInput(data);
	assertLease(data, source.loaded);
	const destination = await resolveProjectFile(data.destinationPath, ".cinematic", false);
	const path = identitySeed(destination);
	const forked = await forkCinematicDocumentFile(
		source.absolutePath,
		destination,
		{ expectedRevision: source.loaded.document.revision, expectedFingerprint: source.loaded.fingerprint },
		{ identitySeed: path }
	);
	refreshAssets(options);
	return { created: true, path, sourcePath: source.relativePath, document: forked.document, fingerprint: forked.fingerprint };
}

/** Deletes one exact leased asset only after literal confirmation. */
export async function deleteCinematic(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<unknown> {
	assertActionRecord(data, [...leaseFields, "confirm"], "delete_cinematic input");
	if (data.confirm !== true) {
		throw new Error("Deleting a cinematic requires confirm=true.");
	}
	const current = await loadFromInput(data);
	assertLease(data, current.loaded);
	const deleted = await deleteCinematicDocumentFile(
		current.absolutePath,
		{ expectedRevision: current.loaded.document.revision, expectedFingerprint: current.loaded.fingerprint },
		{ identitySeed: current.relativePath }
	);
	refreshAssets(options);
	return { deleted: true, path: current.relativePath, ...deleted };
}

/** Replaces one full canonical document under exact lease and explicit destructive confirmation. */
export async function replaceCinematic(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<unknown> {
	assertActionRecord(data, [...leaseFields, "document", "confirm"], "replace_cinematic input");
	if (data.confirm !== true) {
		throw new Error("Replacing a complete cinematic requires confirm=true.");
	}
	const current = await loadFromInput(data);
	assertLease(data, current.loaded);
	const document = normalizeCinematicDocument(data.document, { identitySeed: current.relativePath });
	if (document.id !== current.loaded.document.id || document.revision !== current.loaded.document.revision) {
		throw new Error("Replacement cinematic id and revision must match the inspected document lease.");
	}
	const saved = await saveCinematicDocument(
		current.absolutePath,
		document,
		{ expectedRevision: current.loaded.document.revision, expectedFingerprint: current.loaded.fingerprint },
		{ identitySeed: current.relativePath }
	);
	refreshAssets(options);
	return { path: current.relativePath, document: saved.document, fingerprint: saved.fingerprint };
}

/** Updates document-level playback and recording settings under an exact lease. */
export async function setCinematicDocumentSettings(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<unknown> {
	return mutateCinematic(data, ["changes"], "set_cinematic_settings input", options, (document, input) => {
		assertExactRecord(input.changes, ["name", "framesPerSecond", "outputFramesPerSecond", "durationMode", "durationFrames", "wrapMode"], "Cinematic settings changes");
		return setCinematicSettings(document, document.revision, input.changes);
	});
}

/** Appends one validated track to an exact cinematic document. */
export async function createCinematicDocumentTrack(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<unknown> {
	return mutateCinematic(data, ["track"], "create_cinematic_track input", options, (document, input) =>
		createCinematicTrack(document, document.revision, input.track as TCinematicTrack)
	);
}

/** Updates one track's common or type-specific authoring properties. */
export async function setCinematicDocumentTrack(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<unknown> {
	return mutateCinematic(data, ["trackId", "changes"], "set_cinematic_track input", options, (document, input) => {
		assertExactRecord(
			input.changes,
			["name", "parentId", "muted", "solo", "locked", "color", "collapsed", "targetType", "targetId", "propertyPath"],
			"Cinematic track changes"
		);
		return updateCinematicTrack(document, document.revision, input.trackId as string, input.changes);
	});
}

/** Moves one track within the ordered hierarchy without replacing its contents. */
export async function moveCinematicDocumentTrack(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<unknown> {
	return mutateCinematic(data, ["trackId", "index", "parentId"], "move_cinematic_track input", options, (document, input) =>
		moveCinematicTrack(document, document.revision, input.trackId as string, input.index as number, input.parentId as string | null)
	);
}

/** Deletes one exact track, with optional confirmed child removal. */
export async function deleteCinematicDocumentTrack(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<unknown> {
	return mutateCinematic(data, ["trackId", "deleteChildren", "confirm"], "delete_cinematic_track input", options, (document, input) => {
		if (input.confirm !== true) {
			throw new Error("Deleting a cinematic track requires confirm=true.");
		}
		return deleteCinematicTrack(document, document.revision, input.trackId as string, input.deleteChildren as boolean | undefined);
	});
}

/** Adds one typed clip to its compatible track. */
export async function createCinematicDocumentClip(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<unknown> {
	return mutateCinematic(data, ["trackId", "clip"], "create_cinematic_clip input", options, (document, input) =>
		createCinematicClip(document, document.revision, input.trackId as string, input.clip as TCinematicClip)
	);
}

/** Updates one clip after validating its track-specific fields and timing. */
export async function setCinematicDocumentClip(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<unknown> {
	return mutateCinematic(data, ["trackId", "clipId", "changes"], "set_cinematic_clip input", options, (document, input) => {
		assertExactRecord(
			input.changes,
			[
				"name",
				"startFrame",
				"durationFrames",
				"clipInFrame",
				"timeScale",
				"enabled",
				"blendInFrames",
				"blendOutFrames",
				"easeIn",
				"easeOut",
				"preExtrapolation",
				"postExtrapolation",
				"animationGroupId",
				"sourceStartFrame",
				"sourceEndFrame",
				"loopCount",
				"soundId",
				"videoPlayerId",
				"volume",
				"loop",
				"muteAudio",
				"nodeId",
				"active",
				"cameraId",
				"blendMode",
				"targetType",
				"targetId",
				"action",
				"profileId",
			],
			"Cinematic clip changes"
		);
		return updateCinematicClip(document, document.revision, input.trackId as string, input.clipId as string, input.changes);
	});
}

/** Deletes one exact clip after explicit confirmation. */
export async function deleteCinematicDocumentClip(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<unknown> {
	return mutateCinematic(data, ["trackId", "clipId", "confirm"], "delete_cinematic_clip input", options, (document, input) => {
		if (input.confirm !== true) {
			throw new Error("Deleting a cinematic clip requires confirm=true.");
		}
		return deleteCinematicClip(document, document.revision, input.trackId as string, input.clipId as string);
	});
}

/** Adds one property key or camera cut to a typed lane. */
export async function createCinematicDocumentKey(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<unknown> {
	return mutateCinematic(data, ["trackId", "lane", "key"], "create_cinematic_key input", options, (document, input) =>
		createCinematicKey(document, document.revision, input.trackId as string, input.lane as TCinematicKeyLane, input.key as TCinematicPropertyKey)
	);
}

/** Replaces one exact property key or camera cut while preserving its lane. */
export async function setCinematicDocumentKey(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<unknown> {
	return mutateCinematic(data, ["trackId", "lane", "keyId", "key"], "set_cinematic_key input", options, (document, input) =>
		updateCinematicKey(document, document.revision, input.trackId as string, input.lane as TCinematicKeyLane, input.keyId as string, input.key as TCinematicPropertyKey)
	);
}

/** Deletes one exact property key or camera cut after confirmation. */
export async function deleteCinematicDocumentKey(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<unknown> {
	return mutateCinematic(data, ["trackId", "lane", "keyId", "confirm"], "delete_cinematic_key input", options, (document, input) => {
		if (input.confirm !== true) {
			throw new Error("Deleting a cinematic key requires confirm=true.");
		}
		return deleteCinematicKey(document, document.revision, input.trackId as string, input.lane as TCinematicKeyLane, input.keyId as string);
	});
}

/** Adds one signal marker to a signal track. */
export async function createCinematicDocumentMarker(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<unknown> {
	return mutateCinematic(data, ["trackId", "marker"], "create_cinematic_marker input", options, (document, input) =>
		createCinematicMarker(document, document.revision, input.trackId as string, input.marker as Parameters<typeof createCinematicMarker>[3])
	);
}

/** Updates one signal marker's frame, signal name, or bounded payload. */
export async function setCinematicDocumentMarker(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<unknown> {
	return mutateCinematic(data, ["trackId", "markerId", "marker"], "set_cinematic_marker input", options, (document, input) =>
		updateCinematicMarker(document, document.revision, input.trackId as string, input.markerId as string, input.marker as Parameters<typeof updateCinematicMarker>[4])
	);
}

/** Deletes one exact signal marker after confirmation. */
export async function deleteCinematicDocumentMarker(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<unknown> {
	return mutateCinematic(data, ["trackId", "markerId", "confirm"], "delete_cinematic_marker input", options, (document, input) => {
		if (input.confirm !== true) {
			throw new Error("Deleting a cinematic marker requires confirm=true.");
		}
		return deleteCinematicMarker(document, document.revision, input.trackId as string, input.markerId as string);
	});
}

/** Adds one deterministic recorder profile to the document. */
export async function createCinematicDocumentRecorderProfile(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<unknown> {
	return mutateCinematic(data, ["profile"], "create_cinematic_recorder_profile input", options, (document, input) =>
		createCinematicRecorderProfile(document, document.revision, input.profile as Parameters<typeof createCinematicRecorderProfile>[2])
	);
}

/** Updates one recorder profile's format, dimensions, rate, quality, or audio request. */
export async function setCinematicDocumentRecorderProfile(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<unknown> {
	return mutateCinematic(data, ["profileId", "changes"], "set_cinematic_recorder_profile input", options, (document, input) => {
		assertExactRecord(input.changes, ["name", "format", "width", "height", "framesPerSecond", "quality", "includeAudio"], "Cinematic recorder profile changes");
		return updateCinematicRecorderProfile(document, document.revision, input.profileId as string, input.changes);
	});
}

/** Deletes one recorder profile after confirmation and reference validation. */
export async function deleteCinematicDocumentRecorderProfile(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<unknown> {
	return mutateCinematic(data, ["profileId", "confirm"], "delete_cinematic_recorder_profile input", options, (document, input) => {
		if (input.confirm !== true) {
			throw new Error("Deleting a cinematic recorder profile requires confirm=true.");
		}
		return deleteCinematicRecorderProfile(document, document.revision, input.profileId as string);
	});
}

/** Validates all persisted types and scene/project references without changing the asset. */
export async function validateCinematic(scene: Scene, data: unknown): Promise<unknown> {
	assertActionRecord(data, ["path"], "validate_cinematic input");
	const current = await loadFromInput(data);
	const errors: { code: string; message: string; trackId?: string; itemId?: string }[] = [];
	const warnings: { code: string; message: string; trackId?: string; itemId?: string }[] = [];
	for (const track of current.loaded.document.tracks) {
		if (track.type === "property" && track.targetType === "node" && !scene.getNodeById(track.targetId!)) {
			errors.push({ code: "MISSING_PROPERTY_TARGET", message: `Node ${track.targetId} was not found.`, trackId: track.id });
		}
		if (track.type === "animation") {
			for (const clip of track.clips) {
				if (!scene.getAnimationGroupByName(clip.animationGroupId)) {
					errors.push({ code: "MISSING_ANIMATION_GROUP", message: `Animation group ${clip.animationGroupId} was not found.`, trackId: track.id, itemId: clip.id });
				}
			}
		}
		if (track.type === "audio") {
			for (const clip of track.clips) {
				const node = scene.getNodeById(clip.soundId) as { sound?: unknown } | null;
				if (!node?.sound) {
					errors.push({ code: "MISSING_SOUND", message: `Loaded SoundNode ${clip.soundId} was not found.`, trackId: track.id, itemId: clip.id });
				}
			}
		}
		if (track.type === "video") {
			const configurations = (scene.metadata?.babylonEditorVideoPlayers ?? []) as { id?: unknown }[];
			const runtimes = (scene as Scene & { videoPlayerRuntimes?: Map<string, unknown> }).videoPlayerRuntimes;
			for (const clip of track.clips) {
				if (!configurations.some((configuration) => configuration.id === clip.videoPlayerId)) {
					errors.push({ code: "MISSING_VIDEO_PLAYER", message: `Persistent Video Player ${clip.videoPlayerId} was not found.`, trackId: track.id, itemId: clip.id });
				} else if (!runtimes?.has(clip.videoPlayerId)) {
					warnings.push({
						code: "VIDEO_PLAYER_PREVIEW_UNAVAILABLE",
						message: `Persistent Video Player ${clip.videoPlayerId} is authored but its live preview runtime is unavailable.`,
						trackId: track.id,
						itemId: clip.id,
					});
				}
			}
		}
		if (track.type === "activation") {
			for (const clip of track.clips) {
				if (!scene.getNodeById(clip.nodeId)) {
					errors.push({ code: "MISSING_ACTIVATION_NODE", message: `Node ${clip.nodeId} was not found.`, trackId: track.id, itemId: clip.id });
				}
			}
		}
		if (track.type === "camera") {
			for (const clip of track.clips) {
				if (!scene.getCameraById(clip.cameraId)) {
					errors.push({ code: "MISSING_CAMERA", message: `Camera ${clip.cameraId} was not found.`, trackId: track.id, itemId: clip.id });
				}
			}
		}
		if (track.type === "control") {
			for (const clip of track.clips) {
				if (clip.targetType === "particleSystem" && !scene.particleSystems.some((system) => system.id === clip.targetId)) {
					errors.push({ code: "MISSING_PARTICLE_SYSTEM", message: `Particle system ${clip.targetId} was not found.`, trackId: track.id, itemId: clip.id });
				}
				if (clip.targetType === "cinematic") {
					try {
						const nestedPath = await resolveProjectFile(clip.targetId, ".cinematic", true);
						if (nestedPath === current.absolutePath) {
							errors.push({ code: "SELF_NESTED_CINEMATIC", message: "A cinematic cannot control itself.", trackId: track.id, itemId: clip.id });
						}
					} catch (exception) {
						errors.push({
							code: "MISSING_NESTED_CINEMATIC",
							message: exception instanceof Error ? exception.message : String(exception),
							trackId: track.id,
							itemId: clip.id,
						});
					}
				}
			}
		}
	}
	for (const profile of current.loaded.document.recorderProfiles.filter((candidate) => candidate.includeAudio)) {
		const plan = createCinematicCapturePlan(current.loaded.document, profile.id);
		for (const issue of inspectCinematicAudioCapture(current.loaded.document, scene as unknown as CoreScene, plan).issues) {
			warnings.push({ code: issue.code, message: `${profile.name}: ${issue.message}`, trackId: issue.trackId, itemId: issue.clipId });
		}
	}
	return { path: current.relativePath, revision: current.loaded.document.revision, fingerprint: current.loaded.fingerprint, valid: errors.length === 0, errors, warnings };
}

/** Removes a live preview and restores every scene mutation owned by it. */
function disposePreview(scene: Scene): void {
	const state = previews.get(scene);
	if (!state) {
		return;
	}
	if (state.observer) {
		scene.onBeforeRenderObservable.remove(state.observer);
	}
	state.player.dispose();
	previews.delete(scene);
}

/** Returns a bounded snapshot of the active preview clock and error state. */
export function getCinematicPreview(scene: Scene, data: unknown = {}): unknown {
	assertActionRecord(data, [], "get_cinematic_preview input");
	const state = previews.get(scene);
	return state
		? {
				path: state.path,
				playing: state.player.clock.playing,
				frame: state.player.clock.frame,
				direction: state.player.clock.direction,
				speed: state.player.clock.speed,
				durationFrames: state.player.clock.document.durationFrames,
				revision: state.player.clock.document.revision,
				error: state.error,
			}
		: null;
}

/** Starts, pauses, seeks, steps, or stops one engine-side cinematic preview. */
export async function controlCinematicPreview(scene: Scene, data: unknown): Promise<unknown> {
	assertActionRecord(data, ["action", "path", "loop", "speed", "frame", "frameCount", "emitRetroactive", "ignoreSounds"], "control_cinematic_preview input");
	if (data.action === "play") {
		const current = await loadFromInput(data);
		disposePreview(scene);
		const document = data.loop === undefined ? current.loaded.document : { ...current.loaded.document, wrapMode: data.loop ? ("loop" as const) : ("once" as const) };
		const player = new CinematicScenePlayer(document, scene as unknown as CoreScene, { ignoreSounds: (data.ignoreSounds as boolean | undefined) ?? false });
		if (data.speed !== undefined) {
			player.clock.setSpeed(data.speed as number);
		}
		player.play();
		const state: ICinematicPreviewState = { path: current.relativePath, player, observer: null, error: null };
		state.observer = scene.onBeforeRenderObservable.add(() => {
			if (!player.clock.playing) {
				return;
			}
			try {
				player.advance(scene.getEngine().getDeltaTime() / 1000);
				state.error = null;
			} catch (exception) {
				state.error = exception instanceof Error ? exception.message : String(exception);
				player.pause();
			}
		});
		previews.set(scene, state);
		return getCinematicPreview(scene);
	}
	const state = previews.get(scene);
	if (!state) {
		throw new Error("No cinematic preview is active.");
	}
	switch (data.action) {
		case "pause":
			state.player.pause();
			break;
		case "seek":
			state.player.pause();
			state.player.seek(data.frame as number, (data.emitRetroactive as boolean | undefined) ?? false);
			break;
		case "step":
			state.player.pause();
			state.player.step((data.frameCount as number | undefined) ?? 1);
			break;
		case "stop":
			disposePreview(scene);
			return null;
		default:
			throw new Error(`Unsupported cinematic preview action: ${String(data.action)}.`);
	}
	return getCinematicPreview(scene);
}

/** Preserves the legacy play endpoint as a strict wrapper around the v2 preview. */
export async function playCinematic(scene: Scene, data: unknown): Promise<unknown> {
	assertActionRecord(data, ["path", "loop", "speedRatio", "ignoreSounds"], "play_cinematic input");
	return controlCinematicPreview(scene, { action: "play", path: data.path, loop: data.loop, speed: data.speedRatio, ignoreSounds: data.ignoreSounds });
}

/** Returns a serializable background capture snapshot without exposing its AbortController. */
function captureSnapshot(state: ICinematicCaptureState): unknown {
	return {
		id: state.id,
		path: state.path,
		destination: state.destination,
		status: state.status,
		progress: state.progress,
		writtenFrames: state.writtenFrames,
		totalFrames: state.totalFrames,
		error: state.error,
		audio: state.audio,
	};
}

/** Starts a non-blocking deterministic editor capture that can be inspected or cancelled by id. */
export async function startCinematicCapture(scene: Scene, data: unknown, options: IMCPActionOptions): Promise<unknown> {
	assertActionRecord(data, [...leaseFields, "profileId", "destination", "startFrame", "endFrame", "overwrite"], "start_cinematic_capture input");
	const active = captures.get(scene);
	if (active?.status === "running" || active?.status === "cancelling") {
		throw new Error(`Cinematic capture ${active.id} is already running.`);
	}
	const current = await loadFromInput(data);
	assertLease(data, current.loaded);
	const profile = current.loaded.document.recorderProfiles.find((candidate) => candidate.id === data.profileId);
	if (!profile) {
		throw new Error(`Cinematic recorder profile "${String(data.profileId)}" was not found.`);
	}
	const range = { startFrame: data.startFrame as number | undefined, endFrame: data.endFrame as number | undefined };
	const capturePlan = createCinematicCapturePlan(current.loaded.document, profile.id, range);
	const audioInspection = profile.includeAudio ? inspectCinematicAudioCapture(current.loaded.document, scene as unknown as CoreScene, capturePlan) : null;
	if (audioInspection && !audioInspection.ready) {
		throw new Error(`Cinematic offline audio preflight failed: ${audioInspection.issues.map((issue) => issue.message).join(" ")}`);
	}
	const destination = await resolveProjectFile(data.destination, null, false);
	if (extname(destination).toLowerCase() !== `.${profile.format}`) {
		throw new Error(`Cinematic capture destination must end in .${profile.format}.`);
	}
	if ((await pathExists(destination)) && data.overwrite !== true) {
		throw new Error(`A capture already exists at ${identitySeed(destination)}. Set overwrite=true to replace it.`);
	}
	disposePreview(scene);
	const state: ICinematicCaptureState = {
		id: randomUUID(),
		path: current.relativePath,
		destination: identitySeed(destination),
		status: "running",
		progress: 0,
		writtenFrames: 0,
		totalFrames: capturePlan.frameCount,
		controller: new AbortController(),
		error: null,
		audio: audioInspection,
	};
	captures.set(scene, state);
	// Defer the recorder until after this HTTP/MCP action can publish its running
	// lease. Without this turn boundary a fast promise chain can monopolize the
	// renderer before clients receive the capture id required for cancellation.
	setTimeout(() => {
		void (async (): Promise<void> => {
			const preview = options.editor.layout.preview;
			const canvas = preview.canvas;
			if (!canvas) {
				throw new Error("The scene preview canvas is unavailable for capture.");
			}
			const previous = {
				renderScene: preview.renderScene,
				renderEvenInBackground: preview.engine.renderEvenInBackground,
				constantDelta: preview.scene.useConstantAnimationDeltaTime,
				width: (preview.engine.getRenderingCanvas() ?? canvas).width,
				height: (preview.engine.getRenderingCanvas() ?? canvas).height,
				axis: preview.axis.enabled,
				icons: preview.icons.enabled,
			};
			try {
				preview.setRenderScene(false);
				preview.engine.renderEvenInBackground = true;
				preview.scene.useConstantAnimationDeltaTime = true;
				preview.axis.stop();
				preview.icons.stop();
				// Render at the profile resolution; engine views and panel resizes must not refit the canvas mid-capture.
				const captureCanvas = preview.beginFixedSizeCapture(profile.width, profile.height);
				const recorder = new CinematicDocumentRecorder(current.loaded.document, scene as unknown as CoreScene);
				const sink = new CinematicFileCaptureSink({
					canvas: captureCanvas,
					destination: ensureCinematicCaptureExtension(destination, profile.format),
					transcodeToMp4: createEditorMp4Transcoder(options.editor),
					renderAudio: (plan) => renderCinematicOfflineAudio(current.loaded.document, scene as unknown as CoreScene, plan),
				});
				const result = await recorder.record(profile.id, sink, {
					range,
					signal: state.controller.signal,
					onRenderFrame: () => preview.scene.render(),
					onProgress: (completed, total) => {
						state.writtenFrames = completed;
						state.totalFrames = total;
						state.progress = (completed / total) * 100;
					},
				});
				state.status = "completed";
				state.progress = 100;
				state.writtenFrames = result.plan.frameCount;
				state.totalFrames = result.plan.frameCount;
				state.destination = identitySeed(result.output.destination);
				state.audio = result.output.audio;
			} catch (exception) {
				state.status = state.controller.signal.aborted ? "cancelled" : "failed";
				state.error = exception instanceof Error ? exception.message : String(exception);
			} finally {
				preview.endFixedSizeCapture();
				preview.engine.setSize(previous.width, previous.height);
				preview.engine.renderEvenInBackground = previous.renderEvenInBackground;
				preview.scene.useConstantAnimationDeltaTime = previous.constantDelta;
				preview.setRenderScene(previous.renderScene);
				if (previous.axis) {
					preview.axis.start();
				}
				if (previous.icons) {
					preview.icons.start();
				}
			}
		})().catch((exception) => {
			state.status = "failed";
			state.error = exception instanceof Error ? exception.message : String(exception);
		});
	}, 250);
	return captureSnapshot(state);
}

/** Reads the most recent background capture without starting work. */
export function getCinematicCapture(scene: Scene, data: unknown = {}): unknown {
	assertActionRecord(data, [], "get_cinematic_capture input");
	const state = captures.get(scene);
	return state ? captureSnapshot(state) : null;
}

/** Cancels one exact running capture and preserves any previously published destination. */
export function cancelCinematicCapture(scene: Scene, data: unknown): unknown {
	assertActionRecord(data, ["captureId"], "cancel_cinematic_capture input");
	const state = captures.get(scene);
	if (!state || state.id !== data.captureId || state.status !== "running") {
		throw new Error(`Running cinematic capture was not found: ${String(data.captureId)}.`);
	}
	state.status = "cancelling";
	state.controller.abort(new Error("Cinematic capture was cancelled through MCP."));
	return captureSnapshot(state);
}
