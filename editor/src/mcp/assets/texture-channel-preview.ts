import { normalize, resolve } from "path/posix";

import { Observable } from "babylonjs";

export const TEXTURE_CHANNEL_PREVIEW_CHANNELS = ["rgba", "red", "green", "blue", "alpha"] as const;
export const TEXTURE_CHANNEL_PREVIEW_DISPLAY_MODES = ["grayscale", "colorized"] as const;
export const TEXTURE_CHANNEL_PREVIEW_MAXIMUM_DIMENSION = 1024;

export type TextureChannelPreviewChannel = (typeof TEXTURE_CHANNEL_PREVIEW_CHANNELS)[number];
export type TextureChannelPreviewDisplayMode = (typeof TEXTURE_CHANNEL_PREVIEW_DISPLAY_MODES)[number];

export interface ITextureChannelPreviewState {
	channel: TextureChannelPreviewChannel;
	displayMode: TextureChannelPreviewDisplayMode;
	revision: number;
}

export interface ITextureChannelPreviewStateChange extends ITextureChannelPreviewState {
	path: string;
}

const defaultState: Readonly<ITextureChannelPreviewState> = Object.freeze({ channel: "rgba", displayMode: "grayscale", revision: 0 });
const states = new Map<string, ITextureChannelPreviewState>();

export const onTextureChannelPreviewStateChangedObservable = new Observable<ITextureChannelPreviewStateChange>();

function stateKey(path: string): string {
	return normalize(resolve(path.replaceAll("\\", "/")));
}

function isChannel(value: unknown): value is TextureChannelPreviewChannel {
	return typeof value === "string" && TEXTURE_CHANNEL_PREVIEW_CHANNELS.includes(value as TextureChannelPreviewChannel);
}

function isDisplayMode(value: unknown): value is TextureChannelPreviewDisplayMode {
	return typeof value === "string" && TEXTURE_CHANNEL_PREVIEW_DISPLAY_MODES.includes(value as TextureChannelPreviewDisplayMode);
}

/** Returns the transient, non-destructive preview state for one image asset. */
export function getTextureChannelPreviewState(path: string): ITextureChannelPreviewState {
	const state = states.get(stateKey(path)) ?? defaultState;
	return { ...state };
}

/** Updates one image preview under an exact revision and notifies both Inspector and MCP callers. */
export function setTextureChannelPreviewState(
	path: string,
	patch: { channel?: TextureChannelPreviewChannel; displayMode?: TextureChannelPreviewDisplayMode },
	expectedRevision: number
): { updated: boolean; state: ITextureChannelPreviewState } {
	if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
		throw new Error("expectedRevision must be a non-negative safe integer returned by get_texture_channel_preview.");
	}
	if (patch.channel === undefined && patch.displayMode === undefined) {
		throw new Error("Set at least one of channel or displayMode.");
	}
	if (patch.channel !== undefined && !isChannel(patch.channel)) {
		throw new Error(`channel must be one of: ${TEXTURE_CHANNEL_PREVIEW_CHANNELS.join(", ")}.`);
	}
	if (patch.displayMode !== undefined && !isDisplayMode(patch.displayMode)) {
		throw new Error(`displayMode must be one of: ${TEXTURE_CHANNEL_PREVIEW_DISPLAY_MODES.join(", ")}.`);
	}

	const key = stateKey(path);
	const current = states.get(key) ?? defaultState;
	if (current.revision !== expectedRevision) {
		throw new Error(`Texture channel preview changed. Inspect again and use current revision ${current.revision}.`);
	}
	const nextChannel = patch.channel ?? current.channel;
	const nextDisplayMode = patch.displayMode ?? current.displayMode;
	if (nextChannel === current.channel && nextDisplayMode === current.displayMode) {
		return { updated: false, state: { ...current } };
	}

	const next = { channel: nextChannel, displayMode: nextDisplayMode, revision: current.revision + 1 };
	states.set(key, next);
	onTextureChannelPreviewStateChangedObservable.notifyObservers({ path: key, ...next });
	return { updated: true, state: { ...next } };
}

/** Produces an opaque RGBA8 channel visualization without changing source pixels or importer settings. */
export function transformTextureChannelPreviewPixels(
	pixels: Uint8Array | Uint8ClampedArray,
	channel: TextureChannelPreviewChannel,
	displayMode: TextureChannelPreviewDisplayMode
): Uint8ClampedArray {
	if (pixels.byteLength % 4 !== 0) {
		throw new Error("Texture preview pixels must be tightly packed RGBA8 data.");
	}
	if (!isChannel(channel)) {
		throw new Error(`channel must be one of: ${TEXTURE_CHANNEL_PREVIEW_CHANNELS.join(", ")}.`);
	}
	if (!isDisplayMode(displayMode)) {
		throw new Error(`displayMode must be one of: ${TEXTURE_CHANNEL_PREVIEW_DISPLAY_MODES.join(", ")}.`);
	}

	const output = new Uint8ClampedArray(pixels.byteLength);
	if (channel === "rgba") {
		output.set(pixels);
		return output;
	}

	const channelIndex = channel === "red" ? 0 : channel === "green" ? 1 : channel === "blue" ? 2 : 3;
	for (let index = 0; index < pixels.byteLength; index += 4) {
		const value = pixels[index + channelIndex];
		if (displayMode === "colorized" && channel !== "alpha") {
			output[index] = channel === "red" ? value : 0;
			output[index + 1] = channel === "green" ? value : 0;
			output[index + 2] = channel === "blue" ? value : 0;
		} else {
			output[index] = value;
			output[index + 1] = value;
			output[index + 2] = value;
		}
		output[index + 3] = 255;
	}
	return output;
}

/** Drops exact or recursively nested transient state when assets leave the project. */
export function clearTextureChannelPreviewStates(path: string, recursive = false): number {
	const key = stateKey(path);
	const prefix = `${key}/`;
	const removed = [...states.keys()].filter((candidate) => candidate === key || (recursive && candidate.startsWith(prefix)));
	for (const candidate of removed) {
		states.delete(candidate);
		onTextureChannelPreviewStateChangedObservable.notifyObservers({ path: candidate, ...defaultState });
	}
	return removed.length;
}

/** Preserves asset-identity preview state across one file or directory move. */
export function moveTextureChannelPreviewStates(sourcePath: string, destinationPath: string): number {
	const sourceKey = stateKey(sourcePath);
	const destinationKey = stateKey(destinationPath);
	const sourcePrefix = `${sourceKey}/`;
	const moved = [...states.entries()].filter(([candidate]) => candidate === sourceKey || candidate.startsWith(sourcePrefix));
	for (const [candidate, state] of moved) {
		const suffix = candidate.slice(sourceKey.length);
		const nextPath = `${destinationKey}${suffix}`;
		states.delete(candidate);
		states.set(nextPath, state);
		onTextureChannelPreviewStateChangedObservable.notifyObservers({ path: candidate, ...defaultState });
		onTextureChannelPreviewStateChangedObservable.notifyObservers({ path: nextPath, ...state });
	}
	return moved.length;
}

/** Clears transient state between isolated editor tests. */
export function resetTextureChannelPreviewStatesForTests(): void {
	states.clear();
	onTextureChannelPreviewStateChangedObservable.clear();
}
