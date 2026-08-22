import { ICinematicDocument, ICinematicMarker, ICinematicRecorderProfile, TCinematicClip, TCinematicPropertyKey, TCinematicTrack, normalizeCinematicDocument } from "./model";

export type TCinematicKeyLane = "property" | "weight" | "volume";

export interface ICinematicSettingsChanges {
	name?: string;
	framesPerSecond?: number;
	outputFramesPerSecond?: number;
	durationMode?: ICinematicDocument["durationMode"];
	durationFrames?: number;
	wrapMode?: ICinematicDocument["wrapMode"];
}

const trackBaseFields = ["name", "parentId", "muted", "solo", "locked", "color"] as const;
const trackSpecificFields: Record<TCinematicTrack["type"], readonly string[]> = {
	group: ["collapsed"],
	property: ["targetType", "targetId", "propertyPath"],
	animation: [],
	audio: [],
	video: [],
	activation: [],
	camera: [],
	signal: [],
	control: [],
	recorder: [],
};

function assertRevision(document: ICinematicDocument, expectedRevision: number): void {
	if (!Number.isSafeInteger(expectedRevision) || document.revision !== expectedRevision) {
		throw new Error(`Cinematic revision is stale. Expected exact revision ${document.revision}.`);
	}
}

function assertPatch(changes: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const unsupported = Object.keys(changes).find((key) => !allowed.includes(key));
	if (unsupported) {
		throw new Error(`${label} cannot change field "${unsupported}".`);
	}
}

function track(document: ICinematicDocument, trackId: string): TCinematicTrack {
	const result = document.tracks.find((candidate) => candidate.id === trackId);
	if (!result) {
		throw new Error(`Cinematic track "${trackId}" was not found.`);
	}
	return result;
}

function parents(document: ICinematicDocument, value: TCinematicTrack): TCinematicTrack[] {
	const result: TCinematicTrack[] = [];
	let parentId = value.parentId;
	while (parentId !== null) {
		const parent = track(document, parentId);
		result.push(parent);
		parentId = parent.parentId;
	}
	return result;
}

function assertEditable(document: ICinematicDocument, value: TCinematicTrack): void {
	if (value.locked || parents(document, value).some((parent) => parent.locked)) {
		throw new Error(`Cinematic track "${value.id}" is locked by itself or an ancestor.`);
	}
}

function commit(document: ICinematicDocument, expectedRevision: number, mutation: (draft: ICinematicDocument) => void): ICinematicDocument {
	const current = normalizeCinematicDocument(document);
	assertRevision(current, expectedRevision);
	const draft = structuredClone(current);
	mutation(draft);
	draft.revision = current.revision + 1;
	return normalizeCinematicDocument(draft);
}

function clipTrack(document: ICinematicDocument, trackId: string): Exclude<TCinematicTrack, { type: "group" | "property" | "signal" }> {
	const result = track(document, trackId);
	if (result.type === "group" || result.type === "property" || result.type === "signal") {
		throw new Error(`Cinematic track "${trackId}" does not contain clips.`);
	}
	return result;
}

function keyLane(document: ICinematicDocument, trackId: string, lane: TCinematicKeyLane): TCinematicPropertyKey[] {
	const result = track(document, trackId);
	if (lane === "property" && result.type === "property") {
		return result.keys;
	}
	if (lane === "weight" && result.type === "animation") {
		return result.weightKeys;
	}
	if (lane === "volume" && result.type === "audio") {
		return result.volumeKeys;
	}
	throw new Error(`Cinematic track "${trackId}" does not support the ${lane} key lane.`);
}

export function setCinematicSettings(document: ICinematicDocument, expectedRevision: number, changes: ICinematicSettingsChanges): ICinematicDocument {
	return commit(document, expectedRevision, (draft) => Object.assign(draft, changes));
}

export function createCinematicTrack(document: ICinematicDocument, expectedRevision: number, value: TCinematicTrack): ICinematicDocument {
	return commit(document, expectedRevision, (draft) => {
		if (draft.tracks.some((candidate) => candidate.id === value.id)) {
			throw new Error(`Cinematic track id "${value.id}" already exists.`);
		}
		if (value.parentId !== null) {
			const parent = track(draft, value.parentId);
			if (parent.type !== "group" || parent.locked) {
				throw new Error("New cinematic tracks require an unlocked group parent.");
			}
		}
		draft.tracks.push({ ...structuredClone(value), order: draft.tracks.length });
	});
}

export function updateCinematicTrack(document: ICinematicDocument, expectedRevision: number, trackId: string, changes: Record<string, unknown>): ICinematicDocument {
	return commit(document, expectedRevision, (draft) => {
		const value = track(draft, trackId);
		const allowed = [...trackBaseFields, ...trackSpecificFields[value.type]];
		assertPatch(changes, allowed, `Cinematic ${value.type} track`);
		if (value.locked && (Object.keys(changes).length !== 1 || changes.locked !== false)) {
			throw new Error(`Cinematic track "${trackId}" must be unlocked before editing it.`);
		}
		if (!value.locked) {
			assertEditable(draft, value);
		}
		if (changes.parentId !== undefined && changes.parentId !== null) {
			const parent = track(draft, String(changes.parentId));
			if (parent.type !== "group" || parent.locked) {
				throw new Error("Cinematic tracks require an unlocked group parent.");
			}
		}
		Object.assign(value, structuredClone(changes));
	});
}

export function moveCinematicTrack(document: ICinematicDocument, expectedRevision: number, trackId: string, index: number, parentId: string | null): ICinematicDocument {
	return commit(document, expectedRevision, (draft) => {
		const value = track(draft, trackId);
		assertEditable(draft, value);
		if (!Number.isSafeInteger(index) || index < 0 || index >= draft.tracks.length) {
			throw new Error(`Cinematic track index must be within 0..${Math.max(0, draft.tracks.length - 1)}.`);
		}
		if (parentId !== null) {
			const parent = track(draft, parentId);
			if (parent.type !== "group" || parent.locked) {
				throw new Error("Moved cinematic tracks require an unlocked group parent.");
			}
		}
		const oldIndex = draft.tracks.indexOf(value);
		draft.tracks.splice(oldIndex, 1);
		draft.tracks.splice(index, 0, value);
		value.parentId = parentId;
		draft.tracks.forEach((candidate, order) => (candidate.order = order));
	});
}

export function deleteCinematicTrack(document: ICinematicDocument, expectedRevision: number, trackId: string, deleteChildren = false): ICinematicDocument {
	return commit(document, expectedRevision, (draft) => {
		const value = track(draft, trackId);
		assertEditable(draft, value);
		const descendants = new Set<string>();
		let changed = true;
		while (changed) {
			changed = false;
			for (const candidate of draft.tracks) {
				if (candidate.parentId === trackId || (candidate.parentId !== null && descendants.has(candidate.parentId))) {
					if (!descendants.has(candidate.id)) {
						descendants.add(candidate.id);
						changed = true;
					}
				}
			}
		}
		if (descendants.size && !deleteChildren) {
			throw new Error(`Cinematic group "${trackId}" still contains ${descendants.size} descendant tracks.`);
		}
		for (const descendantId of descendants) {
			const descendant = track(draft, descendantId);
			if (descendant.locked) {
				throw new Error(`Cinematic descendant track "${descendant.id}" must be unlocked before recursive deletion.`);
			}
		}
		draft.tracks = draft.tracks.filter((candidate) => candidate.id !== trackId && !descendants.has(candidate.id));
		draft.tracks.forEach((candidate, order) => (candidate.order = order));
	});
}

export function createCinematicClip(document: ICinematicDocument, expectedRevision: number, trackId: string, value: TCinematicClip): ICinematicDocument {
	return commit(document, expectedRevision, (draft) => {
		const lane = clipTrack(draft, trackId);
		assertEditable(draft, lane);
		if (lane.type !== value.type) {
			throw new Error(`Cinematic ${lane.type} tracks require ${lane.type} clips.`);
		}
		if (draft.tracks.some((candidate) => "clips" in candidate && candidate.clips.some((clip) => clip.id === value.id))) {
			throw new Error(`Cinematic clip id "${value.id}" already exists.`);
		}
		lane.clips.push(structuredClone(value) as never);
	});
}

export function updateCinematicClip(document: ICinematicDocument, expectedRevision: number, trackId: string, clipId: string, changes: Record<string, unknown>): ICinematicDocument {
	return commit(document, expectedRevision, (draft) => {
		const lane = clipTrack(draft, trackId);
		assertEditable(draft, lane);
		const value = lane.clips.find((candidate) => candidate.id === clipId);
		if (!value) {
			throw new Error(`Cinematic clip "${clipId}" was not found on track "${trackId}".`);
		}
		assertPatch(
			changes,
			Object.keys(value).filter((key) => key !== "id" && key !== "type"),
			`Cinematic ${value.type} clip`
		);
		Object.assign(value, structuredClone(changes));
	});
}

export function deleteCinematicClip(document: ICinematicDocument, expectedRevision: number, trackId: string, clipId: string): ICinematicDocument {
	return commit(document, expectedRevision, (draft) => {
		const lane = clipTrack(draft, trackId);
		assertEditable(draft, lane);
		const index = lane.clips.findIndex((candidate) => candidate.id === clipId);
		if (index === -1) {
			throw new Error(`Cinematic clip "${clipId}" was not found on track "${trackId}".`);
		}
		lane.clips.splice(index, 1);
	});
}

export function createCinematicKey(
	document: ICinematicDocument,
	expectedRevision: number,
	trackId: string,
	lane: TCinematicKeyLane,
	value: TCinematicPropertyKey
): ICinematicDocument {
	return commit(document, expectedRevision, (draft) => {
		const owner = track(draft, trackId);
		assertEditable(draft, owner);
		if (
			draft.tracks.some((candidate) => {
				if (candidate.type === "property") {
					return candidate.keys.some((key) => key.id === value.id);
				}
				if (candidate.type === "animation") {
					return candidate.weightKeys.some((key) => key.id === value.id);
				}
				if (candidate.type === "audio") {
					return candidate.volumeKeys.some((key) => key.id === value.id);
				}
				return false;
			})
		) {
			throw new Error(`Cinematic key id "${value.id}" already exists.`);
		}
		keyLane(draft, trackId, lane).push(structuredClone(value));
	});
}

export function updateCinematicKey(
	document: ICinematicDocument,
	expectedRevision: number,
	trackId: string,
	lane: TCinematicKeyLane,
	keyId: string,
	value: TCinematicPropertyKey
): ICinematicDocument {
	return commit(document, expectedRevision, (draft) => {
		const owner = track(draft, trackId);
		assertEditable(draft, owner);
		if (value.id !== keyId) {
			throw new Error("Cinematic key identity cannot change during update.");
		}
		const keys = keyLane(draft, trackId, lane);
		const index = keys.findIndex((candidate) => candidate.id === keyId);
		if (index === -1) {
			throw new Error(`Cinematic key "${keyId}" was not found on track "${trackId}".`);
		}
		keys[index] = structuredClone(value);
	});
}

export function deleteCinematicKey(document: ICinematicDocument, expectedRevision: number, trackId: string, lane: TCinematicKeyLane, keyId: string): ICinematicDocument {
	return commit(document, expectedRevision, (draft) => {
		const owner = track(draft, trackId);
		assertEditable(draft, owner);
		const keys = keyLane(draft, trackId, lane);
		const index = keys.findIndex((candidate) => candidate.id === keyId);
		if (index === -1) {
			throw new Error(`Cinematic key "${keyId}" was not found on track "${trackId}".`);
		}
		keys.splice(index, 1);
	});
}

export function createCinematicMarker(document: ICinematicDocument, expectedRevision: number, trackId: string, value: ICinematicMarker): ICinematicDocument {
	return commit(document, expectedRevision, (draft) => {
		const lane = track(draft, trackId);
		assertEditable(draft, lane);
		if (lane.type !== "signal") {
			throw new Error(`Cinematic track "${trackId}" is not a signal track.`);
		}
		if (draft.tracks.some((candidate) => candidate.type === "signal" && candidate.markers.some((marker) => marker.id === value.id))) {
			throw new Error(`Cinematic marker id "${value.id}" already exists.`);
		}
		lane.markers.push(structuredClone(value));
	});
}

export function updateCinematicMarker(document: ICinematicDocument, expectedRevision: number, trackId: string, markerId: string, value: ICinematicMarker): ICinematicDocument {
	return commit(document, expectedRevision, (draft) => {
		const lane = track(draft, trackId);
		assertEditable(draft, lane);
		if (lane.type !== "signal") {
			throw new Error(`Cinematic track "${trackId}" is not a signal track.`);
		}
		if (value.id !== markerId) {
			throw new Error("Cinematic marker identity cannot change during update.");
		}
		const index = lane.markers.findIndex((marker) => marker.id === markerId);
		if (index === -1) {
			throw new Error(`Cinematic marker "${markerId}" was not found on track "${trackId}".`);
		}
		lane.markers[index] = structuredClone(value);
	});
}

export function deleteCinematicMarker(document: ICinematicDocument, expectedRevision: number, trackId: string, markerId: string): ICinematicDocument {
	return commit(document, expectedRevision, (draft) => {
		const lane = track(draft, trackId);
		assertEditable(draft, lane);
		if (lane.type !== "signal") {
			throw new Error(`Cinematic track "${trackId}" is not a signal track.`);
		}
		const index = lane.markers.findIndex((marker) => marker.id === markerId);
		if (index === -1) {
			throw new Error(`Cinematic marker "${markerId}" was not found on track "${trackId}".`);
		}
		lane.markers.splice(index, 1);
	});
}

export function createCinematicRecorderProfile(document: ICinematicDocument, expectedRevision: number, value: ICinematicRecorderProfile): ICinematicDocument {
	return commit(document, expectedRevision, (draft) => {
		if (draft.recorderProfiles.some((profile) => profile.id === value.id)) {
			throw new Error(`Cinematic recorder profile id "${value.id}" already exists.`);
		}
		draft.recorderProfiles.push(structuredClone(value));
	});
}

export function updateCinematicRecorderProfile(
	document: ICinematicDocument,
	expectedRevision: number,
	profileId: string,
	changes: Partial<Omit<ICinematicRecorderProfile, "id">>
): ICinematicDocument {
	return commit(document, expectedRevision, (draft) => {
		const profile = draft.recorderProfiles.find((candidate) => candidate.id === profileId);
		if (!profile) {
			throw new Error(`Cinematic recorder profile "${profileId}" was not found.`);
		}
		assertPatch(changes, ["name", "format", "width", "height", "framesPerSecond", "quality", "includeAudio"], "Cinematic recorder profile");
		Object.assign(profile, structuredClone(changes));
	});
}

export function deleteCinematicRecorderProfile(document: ICinematicDocument, expectedRevision: number, profileId: string): ICinematicDocument {
	return commit(document, expectedRevision, (draft) => {
		if (draft.tracks.some((candidate) => candidate.type === "recorder" && candidate.clips.some((clip) => clip.profileId === profileId))) {
			throw new Error(`Cinematic recorder profile "${profileId}" is still referenced by a recorder clip.`);
		}
		const index = draft.recorderProfiles.findIndex((profile) => profile.id === profileId);
		if (index === -1) {
			throw new Error(`Cinematic recorder profile "${profileId}" was not found.`);
		}
		draft.recorderProfiles.splice(index, 1);
	});
}
