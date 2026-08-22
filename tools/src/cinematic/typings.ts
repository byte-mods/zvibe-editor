import { IAnimationKey } from "@babylonjs/core/Animations/animationKey";

export interface ICinematic {
	name: string;
	framesPerSecond: number;
	tracks: ICinematicTrack[];

	outputFramesPerSecond: number;
}

export interface ICinematicTrack {
	_id?: string;

	animationGroup?: any;
	animationGroups?: ICinematicAnimationGroup[];
	animationGroupWeight?: (ICinematicKey | ICinematicKeyCut)[];

	node?: any;
	defaultRenderingPipeline?: boolean;

	sound?: any;
	sounds?: ICinematicSound[];
	soundVolume?: (ICinematicKey | ICinematicKeyCut)[];

	propertyPath?: string;
	keyFrameAnimations?: (ICinematicKey | ICinematicKeyCut)[];
	keyFrameEvents?: ICinematicKeyEvent[];
}

/** Original editor clip shape, extended with lossless version-2 compatibility metadata. */
export interface ICinematicAnimationGroup {
	id?: string;
	name?: string;
	type: "group";
	frame: number;

	speed: number;
	startFrame: number;
	endFrame: number;

	repeatCount?: number;
	clipInFrame?: number;
	enabled?: boolean;
	blendInFrames?: number;
	blendOutFrames?: number;
	easeIn?: "linear" | "easeIn" | "easeOut" | "easeInOut";
	easeOut?: "linear" | "easeIn" | "easeOut" | "easeInOut";
	preExtrapolation?: "none" | "hold" | "loop" | "pingPong" | "continue";
	postExtrapolation?: "none" | "hold" | "loop" | "pingPong" | "continue";
}

/** Original regular-key shape with optional canonical identity. */
export interface ICinematicKey extends IAnimationKey {
	id?: string;
	type: "key" | "cut";
}

/** Original two-key cut shape with optional canonical identity. */
export interface ICinematicKeyCut {
	id?: string;
	type: "cut";
	key1: IAnimationKey;
	key2: IAnimationKey;
}

/** Original sound clip shape, extended with lossless timing, blend, and playback metadata. */
export interface ICinematicSound {
	id?: string;
	name?: string;
	type: "sound";

	frame: number;

	startFrame: number;
	endFrame: number;
	speed?: number;
	volume?: number;
	loop?: boolean;
	enabled?: boolean;
	blendInFrames?: number;
	blendOutFrames?: number;
	easeIn?: "linear" | "easeIn" | "easeOut" | "easeInOut";
	easeOut?: "linear" | "easeIn" | "easeOut" | "easeInOut";
	preExtrapolation?: "none" | "hold" | "loop" | "pingPong" | "continue";
	postExtrapolation?: "none" | "hold" | "loop" | "pingPong" | "continue";
}

/** Original event shape, extended so signal semantics survive the compatibility panels. */
export interface ICinematicKeyEvent {
	id?: string;
	type: "event";
	frame: number;
	name?: string;
	markerType?: "signal" | "event";
	emitOnce?: boolean;
	retroactive?: boolean;

	data?: any;
}

export type CinematicKeyType = ICinematicKey | ICinematicKeyCut | ICinematicAnimationGroup | ICinematicSound | ICinematicKeyEvent;
