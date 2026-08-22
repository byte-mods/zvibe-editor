import { Scene } from "@babylonjs/core/scene";
import { Observer } from "@babylonjs/core/Misc/observable";
import { Tools } from "@babylonjs/core/Misc/tools";
import { Database } from "@babylonjs/core/Offline/database";
import { SoundState } from "@babylonjs/core/AudioV2/soundState";
import { AssetContainer } from "@babylonjs/core/assetContainer";
import { _WebAudioEngine } from "@babylonjs/core/AudioV2/webAudio/webAudioEngine";
import { AddParser } from "@babylonjs/core/Loading/Plugins/babylonFileParser.function";
import { _WebAudioStaticSound } from "@babylonjs/core/AudioV2/webAudio/webAudioStaticSound";
import { StaticSoundBuffer } from "@babylonjs/core/AudioV2/abstractAudio/staticSoundBuffer";
import { IStaticSoundOptions, StaticSound } from "@babylonjs/core/AudioV2/abstractAudio/staticSound";
import { StreamingSound } from "@babylonjs/core/AudioV2/abstractAudio/streamingSound";
import { _GetAudioEngine, CreateSoundAsync, CreateSoundBufferAsync, CreateStreamingSoundAsync } from "@babylonjs/core/AudioV2/abstractAudio/audioEngineV2";

import { SoundNode } from "../tools/sound";
import { cloneScriptableAudioSoundAsync, createScriptableAudioSoundFromUrlAsync, isScriptableAudioGeneratorPath, ScriptableAudioStreamingSound } from "./scriptable-audio-playback";

type RuntimeSound = StaticSound | StreamingSound | ScriptableAudioStreamingSound;

let registered = false;
let registeredUpdateObserver: Observer<Scene> | null = null;

const soundInstances: SoundNode[] = [];
const cachedSoundBuffers: Map<string, Promise<StaticSoundBuffer | null>> = new Map();
const cachedRuntimeConfigurations = new Map<string, Promise<{ loadType: "decompressOnLoad" | "compressedInMemory" | "streaming" }>>();

function createSoundInstance(name: string, options: Partial<IStaticSoundOptions>) {
	const audioEngine = _GetAudioEngine(null) as _WebAudioEngine;
	return new _WebAudioStaticSound(name, audioEngine, options);
}

function registerUpdateSoundsObserver(scene: Scene) {
	registeredUpdateObserver?.remove();

	if (!soundInstances.length) {
		return;
	}

	registeredUpdateObserver = scene.onBeforeRenderObservable.add(() => {
		soundInstances.forEach((instance) => {
			if (instance.isEnabled(false) && instance.autoUpdateSpatial && instance.sound?._isSpatial && instance.isPlaying() && scene.activeCamera) {
				instance.sound.spatial.update();
			}
		});
	});
}

function registerSoundNodeEvents(instance: SoundNode) {
	instance.sound?.onDisposeObservable.addOnce(() => {
		const index = soundInstances.indexOf(instance);
		if (index !== -1) {
			soundInstances.splice(index, 1);
		}
	});

	instance.onDisposeObservable.addOnce(() => {
		instance.sound?.dispose();
	});
}

function loadSoundBuffer(scene: Scene, soundAbsolutePath: string) {
	return new Promise<StaticSoundBuffer | null>(async (resolve, reject) => {
		if (!scene.offlineProvider || !Database.IDBStorageEnabled) {
			return CreateSoundBufferAsync(soundAbsolutePath)
				.then((buffer) => resolve(buffer))
				.catch((e) => reject(e));
		}

		scene.offlineProvider.loadFile(
			soundAbsolutePath,
			(data: ArrayBuffer) => {
				CreateSoundBufferAsync(data)
					.then((buffer) => resolve(buffer))
					.catch((e) => reject(e));
			},
			undefined,
			() => {
				reject(null);
			},
			true
		);
	});
}

function configureClonedSound(source: SoundNode, target: SoundNode, sound: RuntimeSound): void {
	sound.volume = source.volume;
	sound._isSpatial = source.sound!._isSpatial;
	if (sound._isSpatial) {
		sound.spatial.attach(target);
		sound.spatial.maxDistance = source.sound!.spatial.maxDistance;
		sound.spatial.panningModel = source.sound!.spatial.panningModel;
		sound.spatial.distanceModel = source.sound!.spatial.distanceModel;
	}
	target.sound = sound;
	target.isSoundNode = true;
	target.soundRelativePath = source.soundRelativePath;
	target.autoUpdateSpatial = source.autoUpdateSpatial;
	soundInstances.push(target);
	registerUpdateSoundsObserver(target.getScene());
	registerSoundNodeEvents(target);
	configureSoundNodePrototype(target, sound);
}

export function configureSourceNodeFrom(source: SoundNode, target: SoundNode): void {
	if (!source.soundRelativePath || !source.sound) {
		return;
	}
	if (isScriptableAudioGeneratorPath(source.soundRelativePath)) {
		void cloneScriptableAudioSoundAsync(source.sound).then((sound) => {
			if (!sound) {
				throw new Error(`Generated sound "${source.soundRelativePath}" has no playback owner.`);
			}
			configureClonedSound(source, target, sound);
		});
		return;
	}
	if (!(source.sound instanceof StaticSound)) {
		void CreateStreamingSoundAsync(source.soundRelativePath, source.soundRelativePath, { spatialAutoUpdate: false }).then((sound) =>
			configureClonedSound(source, target, sound)
		);
		return;
	}

	const sound = createSoundInstance(source.soundRelativePath, {
		spatialAutoUpdate: false,
	});

	sound
		._initAsync(source.sound.buffer!, {
			spatialAutoUpdate: false,
		})
		.then(() => {
			configureClonedSound(source, target, sound);
		});
}

async function loadRuntimeConfiguration(soundAbsolutePath: string): Promise<{ loadType: "decompressOnLoad" | "compressedInMemory" | "streaming" }> {
	if (!cachedRuntimeConfigurations.has(soundAbsolutePath)) {
		cachedRuntimeConfigurations.set(
			soundAbsolutePath,
			fetch(`${soundAbsolutePath}.bjsaudio.json`)
				.then(async (response) => (response.ok ? response.json() : null))
				.then((value) => ({
					loadType: ["decompressOnLoad", "compressedInMemory", "streaming"].includes(value?.loadType) ? value.loadType : "compressedInMemory",
				}))
				.catch(() => ({ loadType: "compressedInMemory" }))
		);
	}
	return cachedRuntimeConfigurations.get(soundAbsolutePath)!;
}

export function configureSoundNodePrototype(instance: SoundNode, sound: RuntimeSound): void {
	Object.defineProperty(instance, "volume", {
		get: () => {
			return sound.volume;
		},
		set: (volume) => {
			sound.volume = volume;
		},
	});

	Object.defineProperty(instance, "playbackRate", {
		get: () => (sound instanceof StaticSound || sound instanceof ScriptableAudioStreamingSound ? sound.playbackRate : 1),
		set: (playbackRate) => {
			if (sound instanceof StaticSound || sound instanceof ScriptableAudioStreamingSound) {
				sound.playbackRate = playbackRate;
			}
		},
	});

	instance.isPaused = () => sound.state === SoundState.Paused;
	instance.isPlaying = () => sound.state === SoundState.Started;
	instance.isStopped = () => sound.state === SoundState.Stopped;

	instance.pause = () => sound.pause();
	instance.resume = () => sound.resume();
	instance.stop = (options) => (sound instanceof StaticSound ? sound.stop(options) : sound.stop());
	instance.play = (options) => sound.play(options as any);

	instance.setVolume = (volume, options) => sound.setVolume(volume, options);

	instance.attachTo = (node, useBoundingBox, attachmentType) => sound.spatial.attach(node, useBoundingBox, attachmentType);
}

async function loadParsedSound(scene: Scene, name: string, soundAbsolutePath: string, rootUrl: string): Promise<RuntimeSound> {
	if (isScriptableAudioGeneratorPath(soundAbsolutePath)) {
		return createScriptableAudioSoundFromUrlAsync(name, soundAbsolutePath, rootUrl, { spatialAutoUpdate: false });
	}
	const configuration = await loadRuntimeConfiguration(soundAbsolutePath);
	if (configuration.loadType === "streaming") {
		return CreateStreamingSoundAsync(name, soundAbsolutePath, { spatialAutoUpdate: false });
	}
	if (!cachedSoundBuffers.has(soundAbsolutePath)) {
		cachedSoundBuffers.set(soundAbsolutePath, loadSoundBuffer(scene, soundAbsolutePath));
	}
	const buffer = await cachedSoundBuffers.get(soundAbsolutePath)!;
	return CreateSoundAsync(name, buffer!, { spatialAutoUpdate: false });
}

export function registerAudioParser() {
	if (registered) {
		return;
	}

	registered = true;

	AddParser("SoundNode", (parsedData: any, scene: Scene, container: AssetContainer, rootUrl: string) => {
		parsedData.transformNodes?.forEach((transformNode: any) => {
			if (!transformNode.isSoundNode) {
				return;
			}

			const instance = container.transformNodes?.find((t) => t.id === transformNode.id) as SoundNode;
			if (!instance) {
				return;
			}

			if (transformNode.soundRelativePath) {
				const soundAbsolutePath = `${rootUrl}${transformNode.soundRelativePath}`;

				scene.addPendingData(soundAbsolutePath);
				void loadParsedSound(scene, transformNode.soundRelativePath, soundAbsolutePath, rootUrl)
					.then((sound) => {
						if (instance.isDisposed()) {
							return sound.dispose();
						}

						sound.volume = transformNode.volume;
						sound._isSpatial = transformNode.isSpatial;

						if (transformNode.isSpatial) {
							sound.spatial.attach(instance);
							sound.spatial.maxDistance = transformNode.maxDistance;
							sound.spatial.panningModel = transformNode.panningModel;
							sound.spatial.distanceModel = transformNode.distanceModel;
						}

						instance.sound = sound;
						instance.isSoundNode = true;
						instance.soundRelativePath = transformNode.soundRelativePath;
						instance.autoUpdateSpatial = transformNode.autoUpdateSpatial;

						soundInstances.push(instance);

						registerSoundNodeEvents(instance);
						configureSoundNodePrototype(instance, sound);
						registerUpdateSoundsObserver(scene);
					})
					.catch((error: unknown) => Tools.Error(`Unable to load sound "${transformNode.soundRelativePath}": ${error instanceof Error ? error.message : String(error)}`))
					.finally(() => scene.removePendingData(soundAbsolutePath));
			}
		});
	});
}
